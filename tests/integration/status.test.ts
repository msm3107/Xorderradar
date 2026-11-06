import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCliDeps, defaultDigestDeps, ExitCode, runCli } from "../../src/cli.js";
import type { IngestionRunSummary } from "../../src/domain/ingestion-run.js";
import { createCompanyProfile } from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { recordIngestionRun } from "../../src/infrastructure/db/ingestion-runs-repository.js";
import { upsertOpportunity } from "../../src/infrastructure/db/opportunities-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { countDeliveries } from "../../src/infrastructure/db/status-repository.js";
import { backupFileName } from "../../src/operations/backup.js";
import { sendHeartbeat } from "../../src/operations/heartbeat.js";
import { collectStatus } from "../../src/operations/status.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * PR-07A with PostgreSQL: what `status` reads, and `status --notify` end to
 * end into the test outbox. Pseudonymised data only; nothing is sent.
 */

const HOUR = 60 * 60_000;
/** 08:00 in Poland: "yesterday" (failed deliveries count from it) is 2026-11-01. */
const NOW = new Date("2026-11-02T07:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR);
const EMAIL = "kontakt@example.invalid";
const PROFILE_NAME = "Jan Kowalski Elektryka";
const TITLE = "Modernizacja oświetlenia ulicznego";
/** Not the digest's key: digest.test.ts takes that one in parallel. */
const LOCK_KEY = 7_206_120_309_777;

function runSummary(
  sourceId: string,
  publicationDate: string,
  status: IngestionRunSummary["status"],
  startedHoursAgo: number,
): IngestionRunSummary {
  return {
    sourceId,
    publicationDate,
    maxRecords: 1000,
    status,
    startedAt: at(startedHoursAgo),
    finishedAt: new Date(at(startedHoursAgo).getTime() + 60_000),
    counters: {
      documents: 1,
      extracted: 1,
      inserted: 0,
      updated: 0,
      unchanged: 1,
      rejected: 0,
      skipped: 0,
    },
    incomplete: [],
    errorCode: status === "failed" ? "source_unavailable" : null,
  };
}

describe.skipIf(skipWithoutDatabase)("status (PostgreSQL)", () => {
  let schema: TestSchema;
  let dir = "";
  const runIds: Record<string, string> = {};

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    dir = await mkdtemp(join(tmpdir(), "radar-status-it-"));
    for (const id of ["ok", "failing", "catchup", "resolved", "stale", "off"]) {
      await upsertSource(schema.db, {
        id,
        name: `Źródło ${id}`,
        baseUrl: "https://zamowienia.example.gov.pl",
        enabled: id !== "off",
      });
    }
    // `bzp` (seeded by the migrations) never ran.
    const record = async (key: string, ...args: Parameters<typeof runSummary>) => {
      runIds[key] = await recordIngestionRun(schema.db, runSummary(...args));
    };
    await record("ok", "ok", "2026-11-01", "succeeded", 2);
    await record("failing-old", "failing", "2026-10-31", "succeeded", 26);
    await record("failing", "failing", "2026-11-01", "failed", 2);
    // A failed day, then a success of the next day: the failed day is still open.
    await record("catchup-failed", "catchup", "2026-10-31", "failed", 20);
    await record("catchup-ok", "catchup", "2026-11-01", "incomplete", 2);
    // A failed day retried with success: resolved.
    await record("resolved-failed", "resolved", "2026-11-01", "failed", 4);
    await record("resolved-ok", "resolved", "2026-11-01", "succeeded", 2);
    // A failed day before the window is not listed again (its source is fine now).
    await record("resolved-ancient", "resolved", "2026-10-20", "failed", 300);
    await record("stale", "stale", "2026-10-30", "succeeded", 40);
    await record("off", "off", "2026-11-01", "failed", 2);

    const profile = await createCompanyProfile(schema.db, {
      email: EMAIL,
      name: PROFILE_NAME,
      categories: ["elektryka"],
      includeKeywords: ["oświetlenie"],
      excludeKeywords: [],
      voivodeships: ["mazowieckie"],
      counties: [],
      active: true,
    });
    const opportunityIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await upsertOpportunity(schema.db, {
        sourceId: "ok",
        sourceUrl: `https://zamowienia.example.gov.pl/ogloszenie/${String(index)}`,
        externalId: null,
        tenderId: null,
        issuerName: "Gmina Przykładowa",
        title: `${TITLE} ${String(index)}`,
        description: null,
        location: { voivodeship: "mazowieckie" },
        publishedAt: at(30),
        deadline: null,
        estimatedValue: null,
        currency: null,
        categories: ["45310000-3"],
        contact: { name: "Anna Nowak", email: EMAIL },
        fetchedAt: at(3),
        fingerprint: `status-fp-${String(index)}`,
        contentHash: "hash-1",
        status: "open",
      });
      opportunityIds.push(result.opportunity.id);
    }
    const delivery = (
      index: number,
      status: "pending" | "sent" | "failed",
      digestDate: string,
      attempts: number,
      errorCode: string | null,
    ) => ({
      profile_id: profile.id,
      opportunity_id: opportunityIds[index] ?? "",
      transport: "test" as const,
      digest_date: digestDate,
      status,
      attempts,
      error_code: errorCode,
      sent_at: status === "sent" ? at(1) : null,
    });
    await schema.db
      .insertInto("deliveries")
      .values([
        delivery(0, "pending", "2026-11-02", 1, null),
        delivery(1, "failed", "2026-11-01", 1, "smtp_transient"),
        delivery(2, "failed", "2026-11-02", 3, "smtp_rejected"),
        // Before yesterday: no longer reported.
        delivery(3, "failed", "2026-10-30", 1, "smtp_old_failure"),
        delivery(4, "sent", "2026-11-02", 1, null),
      ])
      .execute();
  });

  afterAll(async () => {
    await schema.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("evaluates every enabled source and the recent deliveries", async () => {
    const report = await collectStatus(schema.db, NOW);
    expect(report.status).toBe("problem");
    expect(report.problems).toEqual([
      "source_failed",
      "source_never_run",
      "source_stale",
      "deliveries_pending",
      "deliveries_failed",
    ]);
    const byId = Object.fromEntries(
      (report.sources ?? []).map((source) => [source.sourceId, source]),
    );
    expect(Object.keys(byId)).toEqual(["bzp", "catchup", "failing", "ok", "resolved", "stale"]);
    expect(byId.bzp).toMatchObject({
      problems: ["source_never_run"],
      lastRun: null,
      lastSuccessAt: null,
    });
    expect(byId.ok).toMatchObject({ problems: [], failedDays: [] });
    expect(byId.ok?.lastRun).toMatchObject({ runId: runIds.ok, status: "succeeded" });
    expect(byId.failing).toMatchObject({
      problems: ["source_failed"],
      lastRun: { runId: runIds.failing, status: "failed", errorCode: "source_unavailable" },
      lastSuccessAt: new Date(at(26).getTime() + 60_000),
    });
    expect(byId.catchup).toMatchObject({
      problems: ["source_failed"],
      lastRun: { runId: runIds["catchup-ok"], status: "incomplete" },
      failedDays: [
        {
          runId: runIds["catchup-failed"],
          publicationDate: "2026-10-31",
          startedAt: at(20),
          errorCode: "source_unavailable",
        },
      ],
    });
    expect(byId.resolved).toMatchObject({ problems: [], failedDays: [] });
    expect(byId.stale).toMatchObject({ problems: ["source_stale"] });
    expect(report.deliveries).toEqual({
      pending: 1,
      failed: 1,
      failedExhausted: 1,
      failedErrorCodes: ["smtp_rejected", "smtp_transient"],
      digestRunning: false,
      failedSince: "2026-11-01",
    });
  });

  it("sees a digest run by its advisory lock, held by another session", async () => {
    const options = { since: "2026-11-01", maxAttempts: 3, digestLockKey: LOCK_KEY };
    expect((await countDeliveries(schema.db, options)).digestRunning).toBe(false);
    await schema.db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`.execute(connection);
      try {
        // A different pooled connection: another backend.
        expect((await countDeliveries(schema.db, options)).digestRunning).toBe(true);
        // The holder itself does not count (that would be the digest asking).
        expect((await countDeliveries(connection, options)).digestRunning).toBe(false);
      } finally {
        await sql`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`.execute(connection);
      }
    });
    expect((await countDeliveries(schema.db, options)).digestRunning).toBe(false);
  });

  it("status --notify writes one plain-text alert without personal data to the outbox", async () => {
    const outboxDir = join(dir, "outbox");
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      ["status", "--notify"],
      {
        env: {
          DATABASE_URL: schema.url,
          LOG_LEVEL: "error",
          EMAIL_MODE: "test",
          EMAIL_OUTBOX_DIR: outboxDir,
          OPERATOR_EMAIL: "operator@example.invalid",
        },
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      },
      { ...defaultCliDeps, digest: { ...defaultDigestDeps, now: () => NOW } },
    );
    expect(code).toBe(ExitCode.Failure);
    expect(JSON.parse(stdout)).toMatchObject({ status: "problem", notification: "sent" });
    expect(stderr).toContain("Status: problem (source_failed,");
    const files = (await readdir(outboxDir)).sort();
    expect(files).toHaveLength(2);
    const eml = files.find((file) => file.endsWith(".eml"));
    if (eml === undefined) throw new Error("no .eml");
    const message = await readFile(join(outboxDir, eml), "utf8");
    expect(message).toContain("To: operator@example.invalid");
    expect(message).not.toMatch(/^List-Unsubscribe/im);
    expect(message).not.toContain("text/html");
    const json = files.find((file) => file.endsWith(".json"));
    if (json === undefined) throw new Error("no .json");
    const alert = JSON.parse(await readFile(join(outboxDir, json), "utf8")) as {
      subject: string;
      text: string;
      html: null;
    };
    expect(alert.html).toBeNull();
    expect(alert.text).toContain(`${String(runIds.failing)} failed`);
    expect(alert.text).toContain("pending 1");
    // No customer address, profile name, offer title or contact in the alert.
    for (const secret of [EMAIL, PROFILE_NAME, TITLE, "Anna Nowak", schema.url]) {
      expect(message).not.toContain(secret);
      expect(stdout + stderr).not.toContain(secret);
    }
  });
});

/*
 * PR-09 with PostgreSQL: `source_incomplete` from the two newest non-failed
 * runs of two days per source, and its alert. Its own schema, so the report
 * above keeps its sources.
 */
describe.skipIf(skipWithoutDatabase)("status: repeated incomplete runs (PostgreSQL)", () => {
  let schema: TestSchema;
  let dir = "";
  const runIds: Record<string, string> = {};
  const CUT = [{ part: "ContractNotice", reason: "max_pages" as const }];

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    dir = await mkdtemp(join(tmpdir(), "radar-status-incomplete-it-"));
    await sql`UPDATE sources SET enabled = false`.execute(schema.db);
    for (const id of ["twice", "once", "rerun", "same-day", "then-failed", "unreadable", "off"]) {
      await upsertSource(schema.db, {
        id,
        name: `Źródło ${id}`,
        baseUrl: "https://zamowienia.example.gov.pl",
        enabled: id !== "off",
      });
    }
    const record = async (
      key: string,
      sourceId: string,
      day: string,
      status: IngestionRunSummary["status"],
      startedHoursAgo: number,
      incomplete: IngestionRunSummary["incomplete"] = status === "incomplete" ? CUT : [],
    ) => {
      runIds[key] = await recordIngestionRun(schema.db, {
        ...runSummary(sourceId, day, status, startedHoursAgo),
        incomplete,
      });
    };
    // Two days in a row cut short: the alarm.
    await record("twice-old", "twice", "2026-10-31", "incomplete", 26, [
      { part: "SmallContractNotice", reason: "max_records" },
    ]);
    await record("twice-new", "twice", "2026-11-01", "incomplete", 2);
    // An incomplete day after a complete one: no alarm.
    await record("once-old", "once", "2026-10-31", "succeeded", 26);
    await record("once-new", "once", "2026-11-01", "incomplete", 2);
    // A day re-run complete: it counts once, by its newest run.
    await record("rerun-old", "rerun", "2026-10-31", "incomplete", 26);
    await record("rerun-first", "rerun", "2026-11-01", "incomplete", 3);
    await record("rerun-again", "rerun", "2026-11-01", "succeeded", 2);
    // The same day incomplete twice is one day.
    await record("same-1", "same-day", "2026-11-01", "incomplete", 3);
    await record("same-2", "same-day", "2026-11-01", "incomplete", 2);
    // A failed run is skipped: the two days before it were both incomplete.
    await record("failed-a", "then-failed", "2026-10-30", "incomplete", 50);
    await record("failed-b", "then-failed", "2026-10-31", "incomplete", 26);
    await record("failed-c", "then-failed", "2026-11-01", "failed", 2);
    // A stored reason list that no longer reads: shown as unreadable.
    await record("unreadable-old", "unreadable", "2026-10-31", "incomplete", 26);
    await record("unreadable-new", "unreadable", "2026-11-01", "incomplete", 2);
    await sql`
      UPDATE ingestion_runs SET incomplete = '[{"part": "", "reason": "unknown"}]'::jsonb
      WHERE id = ${runIds["unreadable-new"] ?? ""}
    `.execute(schema.db);
    await record("off-old", "off", "2026-10-31", "incomplete", 26);
    await record("off-new", "off", "2026-11-01", "incomplete", 2);
  });

  afterAll(async () => {
    await schema.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a source whose two newest days were both incomplete, not one", async () => {
    const report = await collectStatus(schema.db, NOW);
    const byId = Object.fromEntries(
      (report.sources ?? []).map((source) => [source.sourceId, source]),
    );
    expect(Object.keys(byId)).toEqual([
      "once",
      "rerun",
      "same-day",
      "then-failed",
      "twice",
      "unreadable",
    ]);
    expect(byId.twice).toMatchObject({
      problems: ["source_incomplete"],
      incompleteRuns: [
        {
          runId: runIds["twice-new"],
          publicationDate: "2026-11-01",
          startedAt: at(2),
          incomplete: CUT,
        },
        {
          runId: runIds["twice-old"],
          publicationDate: "2026-10-31",
          startedAt: at(26),
          incomplete: [{ part: "SmallContractNotice", reason: "max_records" }],
        },
      ],
    });
    for (const id of ["once", "rerun", "same-day"]) {
      expect(byId[id]).toMatchObject({ problems: [], incompleteRuns: [] });
    }
    expect(byId["then-failed"]).toMatchObject({
      problems: ["source_failed", "source_incomplete"],
      incompleteRuns: [{ runId: runIds["failed-b"] }, { runId: runIds["failed-a"] }],
    });
    expect(byId.unreadable).toMatchObject({
      problems: ["source_incomplete"],
      incompleteRuns: [{ runId: runIds["unreadable-new"], incomplete: null }, { incomplete: CUT }],
    });
    expect(report.problems).toEqual(["source_failed", "source_incomplete"]);
  });

  it("status --notify alerts with the reason codes only", async () => {
    const outboxDir = join(dir, "outbox");
    let stdout = "";
    const code = await runCli(
      ["status", "--notify"],
      {
        env: {
          DATABASE_URL: schema.url,
          LOG_LEVEL: "error",
          EMAIL_MODE: "test",
          EMAIL_OUTBOX_DIR: outboxDir,
          OPERATOR_EMAIL: "operator@example.invalid",
        },
        stdout: (text) => (stdout += text),
        stderr: () => undefined,
      },
      { ...defaultCliDeps, digest: { ...defaultDigestDeps, now: () => NOW } },
    );
    expect(code).toBe(ExitCode.Failure);
    expect(JSON.parse(stdout)).toMatchObject({
      problems: ["source_failed", "source_incomplete"],
      notification: "sent",
    });
    const json = (await readdir(outboxDir)).find((file) => file.endsWith(".json"));
    if (json === undefined) throw new Error("no .json");
    const alert = JSON.parse(await readFile(join(outboxDir, json), "utf8")) as {
      subject: string;
      text: string;
    };
    expect(alert.subject).toBe("Radar Zamówień: problem (source_failed, source_incomplete)");
    expect(alert.text).toContain("Źródło twice: source_incomplete");
    expect(alert.text).toContain(
      `  niepełny dzień 2026-11-01: ${String(runIds["twice-new"])}, start ${at(2).toISOString()}, ` +
        "powody ContractNotice: max_pages\n",
    );
    expect(alert.text).toContain("powody SmallContractNotice: max_records\n");
    expect(alert.text).toContain("powody nieczytelne\n");
    expect(alert.text).not.toContain("Źródło once");
  });
});

/*
 * PR-07B with PostgreSQL: a healthy schema, a recent backup in BACKUP_DIR and
 * the heartbeat to a local HTTP server (the URL says https; the injected
 * request speaks plain HTTP to 127.0.0.1 only).
 */
describe.skipIf(skipWithoutDatabase)(
  "status with BACKUP_DIR and HEARTBEAT_URL (PostgreSQL)",
  () => {
    let schema: TestSchema;
    let dir = "";

    beforeAll(async () => {
      schema = await createTestSchema();
      await migrateToLatest(schema.db);
      // `bzp`, seeded by the migrations, is the only enabled source.
      await recordIngestionRun(schema.db, runSummary("bzp", "2026-11-01", "succeeded", 2));
      dir = await mkdtemp(join(tmpdir(), "radar-status-backup-it-"));
    });

    afterAll(async () => {
      await schema.close();
      await rm(dir, { recursive: true, force: true });
    });

    async function status(): Promise<{
      code: number;
      stdout: string;
      stderr: string;
      seen: string[];
    }> {
      const seen: string[] = [];
      const server = createServer((request, response) => {
        seen.push(request.url ?? "");
        response.writeHead(200).end("OK");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      let stdout = "";
      let stderr = "";
      try {
        const code = await runCli(
          ["status"],
          {
            env: {
              DATABASE_URL: schema.url,
              LOG_LEVEL: "error",
              BACKUP_DIR: dir,
              HEARTBEAT_URL: `https://127.0.0.1:${String(port)}/ping/not-a-real-token`,
            },
            stdout: (text) => (stdout += text),
            stderr: (text) => (stderr += text),
          },
          {
            ...defaultCliDeps,
            digest: { ...defaultDigestDeps, now: () => NOW },
            status: { ping: (url) => sendHeartbeat(url, { request: httpRequest }) },
          },
        );
        return { code, stdout, stderr, seen };
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    }

    it("skips the ping while there is no backup, then pings once a recent backup is there", async () => {
      const missing = await status();
      expect(missing.code).toBe(ExitCode.Failure);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        status: "problem",
        problems: ["backup_missing"],
        heartbeat: "skipped",
      });
      expect(missing.seen).toEqual([]);

      await writeFile(join(dir, backupFileName(at(2))), "");
      const ok = await status();
      expect(ok.code).toBe(ExitCode.Ok);
      expect(JSON.parse(ok.stdout)).toMatchObject({
        status: "ok",
        problems: [],
        backup: { status: "ok", newestAt: at(2).toISOString(), files: 1, code: null },
        heartbeat: "sent",
      });
      expect(ok.seen).toEqual(["/ping/not-a-real-token"]);
      expect(ok.stdout + ok.stderr).not.toContain("not-a-real-token");
      expect(ok.stdout + ok.stderr).not.toContain(dir);
    });
  },
);
