import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ExitCode, openCliDatabase, runCli, type CliSourceDeps } from "../../src/cli.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { HttpClientError } from "../../src/infrastructure/http/errors.js";
import type { GetOptions, HttpResponse } from "../../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { INGEST_LOCK_KEY, withIngestLock } from "../../src/ingestion/lock.js";
import { bzpAdapter } from "../../src/sources/bzp/adapter.js";
import type { SourceAdapter, SourceHttpClient } from "../../src/sources/types.js";
import { fakeNotice, fakeSource } from "./fake-source.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * The ingest lock is a database-wide advisory lock, not a per-schema one: this
 * is the only test file that takes it, so parallel test files never see it
 * busy. Tests within a file run one after another.
 */

const NOW = new Date("2026-10-30T05:00:00.000Z");

function fixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/bzp/${name}`, import.meta.url));
}

/**
 * Serves captured BZP responses: page 1 of contract notices (3), then small
 * contracts (2). Each request first waits for `gate` (or the request's abort,
 * like SafeHttpClient); `started` resolves when the first request arrives.
 */
class FixtureHttpClient implements SourceHttpClient {
  readonly urls: string[] = [];
  readonly started: Promise<void>;
  #onStarted: () => void = () => undefined;

  constructor(private readonly gate: Promise<void> = Promise.resolve()) {
    this.started = new Promise((resolve) => {
      this.#onStarted = resolve;
    });
  }

  async get(url: string | URL, options: GetOptions = {}): Promise<HttpResponse> {
    const href = url.toString();
    this.urls.push(href);
    this.#onStarted();
    const { signal } = options;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(new HttpClientError("aborted"));
      };
      if (signal?.aborted === true) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.gate.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    const name =
      new URL(href).searchParams.get("NoticeType") === "ContractNotice"
        ? "contract-notice-2026-10-29-page1.json"
        : "small-contract-notice-2026-10-29.json";
    return {
      url: href,
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: fixture(name),
    };
  }
}

/** Runs the CLI in-process with the production database wiring and a fake network. */
async function run(
  args: string[],
  schema: TestSchema,
  options: {
    http?: SourceHttpClient;
    extraAdapters?: readonly SourceAdapter[];
    lockHeartbeatMs?: number;
  } = {},
) {
  const http = options.http ?? new FixtureHttpClient();
  const sources: CliSourceDeps = {
    adapters: new Map<string, SourceAdapter>([
      [bzpAdapter.sourceId, bzpAdapter],
      ...(options.extraAdapters ?? []).map((adapter): [string, SourceAdapter] => [
        adapter.sourceId,
        adapter,
      ]),
    ]),
    createHttpClient: () => http,
    now: () => NOW,
    runTimeoutMs: 60_000,
    ingestTimeoutMs: 60_000,
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL: schema.url, CRAWLER_CONTACT: "ops@example.com" },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    {
      openDatabase: (url) =>
        openCliDatabase(
          url,
          options.lockHeartbeatMs === undefined ? {} : { lockHeartbeatMs: options.lockHeartbeatMs },
        ),
      sources,
    },
  );
  return { code, stdout, stderr };
}

const logLineSchema = z.looseObject({ level: z.string(), message: z.string() });

function logLines(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => logLineSchema.parse(JSON.parse(line)));
}

const reportSchema = z.object({
  status: z.string(),
  publicationDate: z.string(),
  limit: z.number(),
  runs: z.array(
    z.looseObject({
      sourceId: z.string(),
      runId: z.string().nullable(),
      status: z.string(),
      errorCode: z.string().nullable(),
    }),
  ),
});

async function count(schema: TestSchema, table: "opportunities" | "ingestion_runs") {
  const row = await schema.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe.skipIf(skipWithoutDatabase)("ingest command (PostgreSQL, fake network)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("ingests BZP end to end, then finds everything unchanged on the next run", async () => {
    const http = new FixtureHttpClient();
    const first = await run(["ingest", "bzp"], schema, { http });
    expect(first.code).toBe(ExitCode.Ok);
    // Default date: yesterday (UTC); one page per notice type (the fixtures are short).
    expect(http.urls).toHaveLength(2);
    expect(http.urls[0]).toContain("PublicationDateFrom=2026-10-29");
    const report = reportSchema.parse(JSON.parse(first.stdout));
    expect(report).toMatchObject({
      status: "succeeded",
      publicationDate: "2026-10-29",
      limit: 1000,
    });
    expect(report.runs).toEqual([
      expect.objectContaining({
        sourceId: "bzp",
        status: "succeeded",
        documents: 2,
        extracted: 5,
        inserted: 5,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        errorCode: null,
      }),
    ]);
    expect(await count(schema, "opportunities")).toBe(5);
    // The procedure id is stored for contract notices; small contracts carry none (null).
    const tenderIds = await schema.db
      .selectFrom("opportunities")
      .select(["external_id", "tender_id"])
      .where("source_id", "=", "bzp")
      .orderBy("external_id")
      .execute();
    expect(tenderIds).toEqual([
      {
        external_id: "2026/BZP 00507107/01",
        tender_id: "ocds-148610-28a28ecf-bf58-4c1b-b2ba-e2adefdc2140",
      },
      {
        external_id: "2026/BZP 00507109/01",
        tender_id: "ocds-148610-9cec87d4-1681-41f4-804b-fdbf3064de08",
      },
      {
        external_id: "2026/BZP 00507112/01",
        tender_id: "ocds-148610-447a9c97-a3df-42ae-b8d1-c396e629ee81",
      },
      { external_id: "2026/BZP 00507754/01", tender_id: null },
      { external_id: "2026/BZP 00507787/01", tender_id: null },
    ]);

    const second = await run(["ingest", "bzp", "--date", "2026-10-29"], schema);
    expect(second.code).toBe(ExitCode.Ok);
    expect(reportSchema.parse(JSON.parse(second.stdout)).runs).toEqual([
      expect.objectContaining({ inserted: 0, updated: 0, unchanged: 5 }),
    ]);
    expect(await count(schema, "opportunities")).toBe(5);

    const runs = await schema.db
      .selectFrom("ingestion_runs")
      .select(["id", "status", "inserted", "unchanged"])
      .orderBy("started_at")
      .orderBy("inserted", "desc")
      .execute();
    expect(runs.map((row) => [row.status, row.inserted, row.unchanged])).toEqual([
      ["succeeded", 5, 0],
      ["succeeded", 0, 5],
    ]);
    expect(runs[0]?.id).toBe(report.runs[0]?.runId);
  });

  it("logs one summary line per source, with ids and counts but no content", async () => {
    const result = await run(["ingest", "bzp", "--date", "2026-10-29", "--limit", "3"], schema);
    expect(result.code).toBe(ExitCode.Ok);
    const finished = logLines(result.stderr).filter(
      (line) => line.message === "source ingestion finished",
    );
    expect(finished).toEqual([
      expect.objectContaining({
        level: "info",
        sourceId: "bzp",
        status: "incomplete",
        // The contract notice page is full at 3; the small contracts end at 2.
        incomplete: [{ part: "ContractNotice", reason: "max_records" }],
        errorCode: null,
      }),
    ]);
    expect(finished[0]?.durationMs).toEqual(expect.any(Number));
    expect(reportSchema.parse(JSON.parse(result.stdout)).status).toBe("incomplete");
    expect(result.stderr).not.toContain("https://");
    expect(result.stderr).not.toContain("Zespół Żłobków");
  });

  it("runs the other sources when one fails, records both and exits 1", async () => {
    await upsertSource(schema.db, {
      id: "zrodlo-awaria",
      name: "Źródło z awarią",
      baseUrl: "https://zamowienia.example.invalid/",
      enabled: true,
    });
    const before = await count(schema, "ingestion_runs");
    const failing = fakeSource("zrodlo-awaria", [
      [fakeNotice(1)],
      new HttpClientError("http_status", { status: 503 }),
    ]);
    // No source ids: every enabled source (bzp seeded by migration 0002 and this one).
    const result = await run(["ingest", "--date", "2026-10-29"], schema, {
      extraAdapters: [failing],
    });
    expect(result.code).toBe(ExitCode.Failure);
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.status).toBe("failed");
    expect(report.runs.map((r) => [r.sourceId, r.status, r.errorCode])).toEqual([
      ["bzp", "succeeded", null],
      ["zrodlo-awaria", "failed", "http_status"],
    ]);
    expect(result.stderr).toContain("Ingest failed for: zrodlo-awaria (http_status)\n");
    expect(await count(schema, "ingestion_runs")).toBe(before + 2);
    // The record stored before the failure stays.
    const stored = await schema.db
      .selectFrom("opportunities")
      .select("external_id")
      .where("source_id", "=", "zrodlo-awaria")
      .execute();
    expect(stored).toEqual([{ external_id: "FAKE/0001" }]);
    await upsertSource(schema.db, {
      id: "zrodlo-awaria",
      name: "Źródło z awarią",
      baseUrl: "https://zamowienia.example.invalid/",
      enabled: false,
    });
  });

  it("refuses a source not enabled in the database as a usage error (exit 2)", async () => {
    const before = await count(schema, "ingestion_runs");
    const disabled = fakeSource("zrodlo-awaria", [[fakeNotice(1)]]);
    const result = await run(["ingest", "zrodlo-awaria"], schema, { extraAdapters: [disabled] });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Source not enabled in the database: "zrodlo-awaria"');
    expect(disabled.fetches).toBe(0);
    expect(await count(schema, "ingestion_runs")).toBe(before);
  });

  it("reports skipped and exits 0 without fetching or writing anything while another run holds the lock", async () => {
    const opportunities = await count(schema, "opportunities");
    const runs = await count(schema, "ingestion_runs");
    const http = new FixtureHttpClient();
    const result = await schema.db.connection().execute(async (connection) => {
      const { rows } = await sql<{ acquired: boolean }>`
        SELECT pg_try_advisory_lock(${INGEST_LOCK_KEY}::bigint) AS acquired
      `.execute(connection);
      expect(rows[0]?.acquired).toBe(true);
      try {
        return await run(["ingest", "bzp", "--date", "2026-10-28"], schema, { http });
      } finally {
        await sql`SELECT pg_advisory_unlock(${INGEST_LOCK_KEY}::bigint)`.execute(connection);
      }
    });
    // Busy is the expected outcome of an overlapping cron run, not a failure (D-019).
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "skipped",
      reason: "lock_busy",
      publicationDate: "2026-10-28",
      limit: 1000,
      runs: [],
    });
    expect(result.stderr).toContain(
      "Ingest skipped: another ingest run holds the lock; nothing was fetched.\n",
    );
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({ level: "warn", message: "ingest lock busy" }),
    );
    expect(http.urls).toEqual([]);
    expect(await count(schema, "opportunities")).toBe(opportunities);
    expect(await count(schema, "ingestion_runs")).toBe(runs);
  });

  it("lets only one of two concurrent runs ingest", async () => {
    const runs = await count(schema, "ingestion_runs");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new FixtureHttpClient(gate);
    const firstRun = run(["ingest", "bzp", "--date", "2026-10-27"], schema, { http: gated });
    try {
      // The first run holds the lock and is fetching.
      await gated.started;
      expect(gated.urls).toHaveLength(1);

      const idle = new FixtureHttpClient();
      const second = await run(["ingest", "bzp", "--date", "2026-10-27"], schema, { http: idle });
      expect(second.code).toBe(ExitCode.Ok);
      expect(JSON.parse(second.stdout)).toMatchObject({ status: "skipped", reason: "lock_busy" });
      expect(second.stderr).toContain(
        "Ingest skipped: another ingest run holds the lock; nothing was fetched.\n",
      );
      expect(idle.urls).toEqual([]);
    } finally {
      // Never leave the database-wide lock held by a failed assertion.
      release();
    }
    const first = await firstRun;
    expect(first.code).toBe(ExitCode.Ok);
    expect(await count(schema, "ingestion_runs")).toBe(runs + 1);

    // The lock was released: the next run proceeds.
    const third = await run(["ingest", "bzp", "--date", "2026-10-27"], schema);
    expect(third.code).toBe(ExitCode.Ok);
  });

  it("aborts the run with lock_lost and exits 1 when the lock connection is terminated", async () => {
    const runs = await count(schema, "ingestion_runs");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new FixtureHttpClient(gate);
    const running = run(["ingest", "bzp", "--date", "2026-10-26"], schema, {
      http: gated,
      lockHeartbeatMs: 50,
    });
    let result: Awaited<typeof running>;
    try {
      await gated.started;
      // The session holding the ingest lock (bigint key = classid << 32 | objid).
      const { rows } = await sql<{ terminated: boolean }>`
        SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 1 AND granted
          AND ((classid::bigint << 32) | objid::bigint) = ${INGEST_LOCK_KEY}::bigint
      `.execute(schema.db);
      expect(rows).toEqual([{ terminated: true }]);
      // The request is never answered: only the lost lock can end the run.
      result = await running;
    } finally {
      release();
    }

    // A controlled failure, not a crash: summary on stdout, clear message, exit 1.
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain(
      "Ingest aborted: the ingest lock was lost during the run (lock_lost).\n",
    );
    expect(result.stderr).toContain("Ingest failed for: bzp (lock_lost)\n");
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({ level: "error", message: "ingest lock lost" }),
    );
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.status).toBe("failed");
    expect(report.runs.map((r) => [r.sourceId, r.status, r.errorCode])).toEqual([
      ["bzp", "failed", "lock_lost"],
    ]);
    expect(await count(schema, "ingestion_runs")).toBe(runs + 1);
    const stored = await schema.db
      .selectFrom("ingestion_runs")
      .select(["status", "error_code", "inserted"])
      .where("id", "=", report.runs[0]?.runId ?? "")
      .executeTakeFirst();
    expect(stored).toEqual({ status: "failed", error_code: "lock_lost", inserted: 0 });

    // The server released the lock with the session: the next run proceeds.
    const next = await run(["ingest", "bzp", "--date", "2026-10-26"], schema);
    expect(next.code).toBe(ExitCode.Ok);
  });

  it("keeps the task's result when releasing the lock fails", async () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    // No check during the task: the connection breaks after the last check,
    // so only the unlock notices.
    const result = await withIngestLock(
      schema.db,
      async () => {
        await sql`
          SELECT pg_terminate_backend(pid, 5000) FROM pg_locks
          WHERE locktype = 'advisory' AND objsubid = 1 AND granted
            AND ((classid::bigint << 32) | objid::bigint) = ${INGEST_LOCK_KEY}::bigint
        `.execute(schema.db);
        return "stored";
      },
      { logger, heartbeatMs: 60_000 },
    );
    expect(result).toEqual({ acquired: true, value: "stored", lockLost: false });
    expect(logLines(lines.join("\n"))).toEqual([
      expect.objectContaining({ level: "error", message: "ingest lock release failed" }),
    ]);
    // The session ended, so the lock is free again.
    const again = await withIngestLock(schema.db, () => Promise.resolve(1), { logger });
    expect(again).toEqual({ acquired: true, value: 1, lockLost: false });
  });

  it("exits 1 with run_not_recorded when a run summary cannot be stored", async () => {
    await upsertSource(schema.db, {
      id: "zrodlo-bez-zapisu",
      name: "Źródło bez zapisu przebiegu",
      baseUrl: "https://zamowienia.example.invalid/",
      enabled: true,
    });
    // Only this source's run records fail (a server-side error, SQLSTATE P0001).
    await sql`
      CREATE FUNCTION refuse_ingestion_run() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused by the test'; END $$
    `.execute(schema.db);
    await sql`
      CREATE TRIGGER refuse_ingestion_run BEFORE INSERT ON ingestion_runs FOR EACH ROW
      WHEN (NEW.source_id = 'zrodlo-bez-zapisu') EXECUTE FUNCTION refuse_ingestion_run()
    `.execute(schema.db);
    try {
      const source = fakeSource("zrodlo-bez-zapisu", [[fakeNotice(1)]]);
      const result = await run(["ingest", "zrodlo-bez-zapisu", "--date", "2026-10-29"], schema, {
        extraAdapters: [source],
      });
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toContain("Ingest failed for: zrodlo-bez-zapisu (run_not_recorded)\n");
      expect(logLines(result.stderr)).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "ingestion run not recorded",
          sourceId: "zrodlo-bez-zapisu",
          errorCode: "P0001",
        }),
      );
      expect(result.stderr).not.toContain("refused by the test");
      const report = reportSchema.parse(JSON.parse(result.stdout));
      expect(report.status).toBe("failed");
      expect(report.runs).toEqual([
        expect.objectContaining({ runId: null, status: "succeeded", inserted: 1, errorCode: null }),
      ]);
    } finally {
      await sql`DROP TRIGGER refuse_ingestion_run ON ingestion_runs`.execute(schema.db);
      await upsertSource(schema.db, {
        id: "zrodlo-bez-zapisu",
        name: "Źródło bez zapisu przebiegu",
        baseUrl: "https://zamowienia.example.invalid/",
        enabled: false,
      });
    }
  });
});

describe.skipIf(skipWithoutDatabase)("ingest command without migrations (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  it("fails clearly and does not migrate by itself", async () => {
    const http = new FixtureHttpClient();
    const result = await run(["ingest"], schema, { http });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("Ingest failed: Database schema is not up to date");
    expect(result.stderr).toContain("run `migrate` first");
    expect(http.urls).toEqual([]);
    const { rows } = await sql<{ relation: string | null }>`
      SELECT to_regclass('kysely_migration')::text AS relation
    `.execute(schema.db);
    expect(rows[0]?.relation).toBeNull();
  });
});
