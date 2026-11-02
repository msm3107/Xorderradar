import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCliDeps,
  defaultDigestDeps,
  ExitCode,
  openCliDatabase,
  runCli,
  type CliDigestDeps,
} from "../../src/cli.js";
import type { CompanyProfile, CompanyProfileInput } from "../../src/domain/company-profile.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import {
  consumeLoginToken,
  hashSecretToken,
} from "../../src/infrastructure/db/access-repository.js";
import { createCompanyProfile } from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { upsertOpportunity } from "../../src/infrastructure/db/opportunities-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import {
  DIGEST_LOCK_KEY,
  DIGEST_MAX_ATTEMPTS,
  DIGEST_MAX_ITEMS,
  withDigestLock,
  type DigestSummary,
  type ProfileDigestSummary,
} from "../../src/notifications/run.js";
import {
  EmailSendError,
  type EmailSender,
  type OutgoingEmail,
  type SendFailureKind,
} from "../../src/notifications/sender.js";
import {
  createTestSchema,
  pausedTransaction,
  skipWithoutDatabase,
  waitUntilBlockedBy,
  type TestSchema,
} from "./test-database.js";

/*
 * PR-05 with PostgreSQL: `digest` end to end. The digest lock is a
 * database-wide advisory lock: this is the only test file that takes it.
 * Nothing is sent: the sender is a fake (or the real outbox sender writing to
 * a temporary directory). Pseudonymised data only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The run's clock; 07:00 in Poland. Offers are stored as first seen an hour before. */
const NOW = new Date("2026-11-01T06:00:00.000Z");
const NEXT_DAY = new Date(NOW.getTime() + DAY_MS);
const EMAIL = "kontakt@example.invalid";

let counter = 0;
function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  counter += 1;
  return {
    sourceId: "test-source",
    sourceUrl: `https://zamowienia.example.gov.pl/ogloszenie/${String(counter)}`,
    externalId: null,
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: `Modernizacja oświetlenia ulicznego nr ${String(counter)}`,
    description: "Wymiana opraw oświetleniowych.",
    location: { voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-30T08:00:00.000Z"),
    deadline: new Date("2026-11-20T11:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: { name: "Jan Kowalski", email: EMAIL, phone: "000 000 000" },
    fetchedAt: new Date("2026-10-31T09:00:00.000Z"),
    fingerprint: `digest-fp-${String(counter)}`,
    contentHash: "hash-1",
    status: "open",
    ...overrides,
  };
}

const profileInput = {
  email: EMAIL,
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: ["paliwo"],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
} satisfies CompanyProfileInput;

interface Sent {
  readonly email: OutgoingEmail;
}

/**
 * A sender that records every e-mail and fails as scripted: each call takes
 * the next outcome (null: accepted); an empty script accepts everything.
 */
function fakeSender(script: (SendFailureKind | null)[] = [], onSend?: () => Promise<void>) {
  const sent: Sent[] = [];
  let attempts = 0;
  const sender: EmailSender = {
    transport: "test",
    async send(email) {
      attempts++;
      await onSend?.();
      const outcome = script.shift() ?? null;
      if (outcome !== null) throw new EmailSendError(`smtp_${outcome}`, outcome);
      sent.push({ email });
    },
    close() {},
  };
  return { sender, sent, attempts: () => attempts };
}

describe.skipIf(skipWithoutDatabase)("digest (PostgreSQL)", () => {
  let schema: TestSchema;
  let dir = "";
  let profile: CompanyProfile;

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    await upsertSource(schema.db, {
      id: "test-source",
      name: "Test source",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: true,
    });
    dir = await mkdtemp(join(tmpdir(), "radar-digest-it-"));
  });
  afterAll(async () => {
    await schema.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await sql`DELETE FROM deliveries`.execute(schema.db);
    await sql`DELETE FROM opportunities`.execute(schema.db);
    await sql`DELETE FROM company_profiles`.execute(schema.db);
    profile = await createCompanyProfile(schema.db, profileInput);
  });

  /** Stores an offer as first seen `firstSeenAt` (default an hour before NOW). */
  async function store(overrides: Partial<OpportunityDraft> = {}, firstSeenAt?: Date) {
    const { opportunity } = await upsertOpportunity(schema.db, draft(overrides));
    const seen = firstSeenAt ?? new Date(NOW.getTime() - 60 * 60 * 1000);
    await sql`UPDATE opportunities SET first_seen_at = ${seen} WHERE id = ${opportunity.id}`.execute(
      schema.db,
    );
    return opportunity;
  }

  async function run(
    args: string[],
    options: {
      digest?: Partial<CliDigestDeps>;
      env?: Record<string, string>;
      heartbeatMs?: number;
    } = {},
  ) {
    let stdout = "";
    let stderr = "";
    const digest: CliDigestDeps = {
      createSender: () => fakeSender().sender,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      ...options.digest,
    };
    const { heartbeatMs } = options;
    const code = await runCli(
      ["digest", ...args],
      {
        env: { NODE_ENV: "test", DATABASE_URL: schema.url, ...options.env },
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      },
      {
        ...defaultCliDeps,
        ...(heartbeatMs === undefined
          ? {}
          : { openDatabase: (url) => openCliDatabase(url, { lockHeartbeatMs: heartbeatMs }) }),
        digest,
      },
    );
    // Logs and the summary carry ids and counts only.
    expect(stdout + stderr).not.toContain(EMAIL);
    expect(stdout + stderr).not.toContain("Modernizacja");
    const report = JSON.parse(stdout) as { status: string } & DigestSummary;
    return { code, report, stderr };
  }

  function only(report: DigestSummary): ProfileDigestSummary {
    expect(report.profiles).toHaveLength(1);
    const [first] = report.profiles;
    if (first === undefined) throw new Error("no profile");
    return first;
  }

  async function deliveries() {
    return schema.db
      .selectFrom("deliveries")
      .select(["opportunity_id", "status", "attempts", "error_code", "transport"])
      .select(sql<string>`digest_date::text`.as("digest_date"))
      .select(sql<boolean>`sent_at IS NOT NULL`.as("has_sent_at"))
      .orderBy("opportunity_id")
      .execute();
  }

  it("sends the new matching offers once, soonest deadline first, and nothing again that day", async () => {
    const later = await store({ deadline: new Date("2026-11-25T11:00:00.000Z") });
    const sooner = await store({ deadline: new Date("2026-11-03T11:00:00.000Z") });
    const noDeadline = await store({ deadline: null });
    await store({ status: "closed" });
    await store({ status: "cancelled" });
    await store({ deadline: new Date(NOW.getTime() - 60_000) });
    await store({ title: "Dostawa paliwa do kotłowni" });
    await store({}, new Date(NOW.getTime() - 8 * DAY_MS));

    const first = fakeSender();
    const result = await run([], { digest: { createSender: () => first.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.report).toMatchObject({
      status: "ok",
      digestDate: "2026-11-01",
      transport: "test",
      dryRun: false,
      skippedInvalidRows: 0,
    });
    expect(only(result.report)).toEqual({
      profileId: profile.id,
      status: "sent",
      matched: 3,
      claimed: 3,
      sent: 3,
      failed: 0,
      uncertain: 0,
      overflow: 0,
    });
    expect(first.sent).toHaveLength(1);
    const email = first.sent[0]?.email;
    expect(email?.to).toBe(EMAIL);
    expect(email?.subject).toBe("Radar Zamówień: 3 nowe zamówienia — Jan Kowalski Elektryka");
    const titles = email?.text.match(/^\d+\. .*$/gmu);
    expect(titles).toEqual([`1. ${sooner.title}`, `2. ${later.title}`, `3. ${noDeadline.title}`]);
    expect(email?.text).toContain("Termin składania ofert: nie podano");

    const rows = await deliveries();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "sent",
        attempts: 1,
        error_code: null,
        transport: "test",
      });
      expect(row).toMatchObject({ digest_date: "2026-11-01", has_sent_at: true });
    }

    // AC1: a second run the same day sends nothing, even with a new offer.
    await store();
    const second = fakeSender();
    const again = await run([], { digest: { createSender: () => second.sender } });
    expect(again.code).toBe(ExitCode.Ok);
    expect(only(again.report)).toMatchObject({ status: "already_sent_today", sent: 0, claimed: 0 });
    expect(second.attempts()).toBe(0);

    // The next day only the offer not sent yet goes out.
    const nextDay = fakeSender();
    const tomorrow = await run([], {
      digest: { createSender: () => nextDay.sender, now: () => NEXT_DAY },
    });
    expect(only(tomorrow.report)).toMatchObject({
      status: "sent",
      matched: 4,
      claimed: 1,
      sent: 1,
    });
    expect(nextDay.sent[0]?.email.subject).toContain("1 nowe zamówienie");
    expect(await deliveries()).toHaveLength(4);
  });

  it("sends nothing when there is nothing new", async () => {
    await store({ title: "Dostawa paliwa" });
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(only(result.report)).toMatchObject({ status: "nothing_new", matched: 0 });
    expect(sender.attempts()).toBe(0);
    expect(await deliveries()).toEqual([]);
  });

  it("retries a failed send in later runs and gives up at the attempt limit", async () => {
    await store();
    await store();
    for (let attempt = 1; attempt <= DIGEST_MAX_ATTEMPTS; attempt++) {
      const sender = fakeSender(["permanent"]);
      const result = await run([], { digest: { createSender: () => sender.sender } });
      expect(result.code).toBe(ExitCode.Failure);
      expect(only(result.report)).toMatchObject({
        status: "failed",
        claimed: 2,
        failed: 2,
        sent: 0,
        errorCode: "smtp_permanent",
      });
      expect(result.stderr).toContain(`Digest failed for: ${profile.id} (smtp_permanent)`);
      const rows = await deliveries();
      expect(rows.map((row) => [row.status, row.attempts, row.error_code])).toEqual([
        ["failed", attempt, "smtp_permanent"],
        ["failed", attempt, "smtp_permanent"],
      ]);
    }
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(only(result.report)).toMatchObject({ status: "nothing_new", matched: 2, claimed: 0 });
    expect(sender.attempts()).toBe(0);
  });

  it("sends a failed offer in the next run once the server takes it", async () => {
    await store();
    const failing = fakeSender(["permanent"]);
    await run([], { digest: { createSender: () => failing.sender } });
    const ok = fakeSender();
    const result = await run([], { digest: { createSender: () => ok.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(only(result.report)).toMatchObject({ status: "sent", claimed: 1, sent: 1 });
    expect(await deliveries()).toMatchObject([{ status: "sent", attempts: 2, error_code: null }]);
  });

  it("retries a transient failure within the run, after pauses", async () => {
    await store();
    const sender = fakeSender(["transient", "transient"]);
    const pauses: number[] = [];
    const result = await run([], {
      digest: {
        createSender: () => sender.sender,
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(only(result.report)).toMatchObject({ status: "sent", sent: 1 });
    expect(sender.attempts()).toBe(3);
    expect(pauses).toEqual([2_000, 10_000]);
    expect(await deliveries()).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("never resends an offer whose send outcome is unknown, and reports it", async () => {
    const offer = await store();
    const sender = fakeSender(["uncertain"]);
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(only(result.report)).toMatchObject({
      status: "uncertain",
      claimed: 1,
      sent: 0,
      failed: 0,
      uncertain: 1,
      errorCode: "smtp_uncertain",
    });
    expect(sender.attempts()).toBe(1);
    expect(await deliveries()).toMatchObject([
      { opportunity_id: offer.id, status: "pending", attempts: 0, error_code: null },
    ]);

    // Same day: the profile is skipped (its digest may have gone out).
    const sameDay = fakeSender();
    const again = await run([], { digest: { createSender: () => sameDay.sender } });
    expect(again.code).toBe(ExitCode.Ok);
    expect(only(again.report)).toMatchObject({ status: "pending_today", uncertain: 1 });
    expect(again.stderr).toContain(
      "Digest: 1 delivery is pending and needs an operator decision (README „Wynik niepewny”).",
    );
    expect(sameDay.attempts()).toBe(0);

    // Next day: a new offer is sent, the pending one is not.
    const fresh = await store();
    const nextDay = fakeSender();
    const tomorrow = await run([], {
      digest: { createSender: () => nextDay.sender, now: () => NEXT_DAY },
    });
    expect(only(tomorrow.report)).toMatchObject({ status: "sent", claimed: 1, uncertain: 1 });
    expect(nextDay.sent[0]?.email.text).toContain(fresh.title);
    expect(nextDay.sent[0]?.email.text).not.toContain(offer.title);
  });

  /** Two more active profiles after `profile`, in creation (= run) order. */
  async function moreProfiles() {
    const second = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "kontakt2@example.invalid",
    });
    const third = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "kontakt3@example.invalid",
    });
    return [second, third];
  }

  async function deliveriesByProfile() {
    return schema.db
      .selectFrom("deliveries")
      .select(["profile_id", "status", "attempts", "error_code"])
      .orderBy("profile_id")
      .orderBy("opportunity_id")
      .execute();
  }

  it("stops the run at a setup failure without retrying or spending attempts", async () => {
    const [second, third] = await moreProfiles();
    await store();
    await store();
    const broken = fakeSender(["setup", "setup", "setup"]);
    const pauses: number[] = [];
    const result = await run([], {
      digest: {
        createSender: () => broken.sender,
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report).toMatchObject({ status: "failed", errorCode: "send_setup_failed" });
    expect(result.report.profiles.map((p) => [p.profileId, p.status, p.errorCode])).toEqual([
      [profile.id, "failed", "smtp_setup"],
      [second?.id, "not_run", undefined],
      [third?.id, "not_run", undefined],
    ]);
    expect(result.report.profiles[0]).toMatchObject({ claimed: 2, failed: 2, sent: 0 });
    expect(broken.attempts()).toBe(1);
    expect(pauses).toEqual([]);
    expect(result.stderr).toContain("Digest stopped (send_setup_failed)");
    // Only the first profile's rows exist: failed, no attempt spent.
    expect(await deliveriesByProfile()).toEqual([
      { profile_id: profile.id, status: "failed", attempts: 0, error_code: "smtp_setup" },
      { profile_id: profile.id, status: "failed", attempts: 0, error_code: "smtp_setup" },
    ]);

    // Repeated broken runs never use up the offers.
    for (let index = 0; index < DIGEST_MAX_ATTEMPTS; index++) {
      const again = fakeSender(["setup"]);
      await run([], { digest: { createSender: () => again.sender } });
      expect(again.attempts()).toBe(1);
    }
    expect((await deliveriesByProfile()).map((row) => row.attempts)).toEqual([0, 0]);

    // Once the configuration is fixed, the same day: everything goes out.
    const fixed = fakeSender();
    const later = await run([], { digest: { createSender: () => fixed.sender } });
    expect(later.code).toBe(ExitCode.Ok);
    expect(later.report.errorCode).toBeNull();
    expect(later.report.profiles.map((p) => [p.status, p.sent])).toEqual([
      ["sent", 2],
      ["sent", 2],
      ["sent", 2],
    ]);
    expect(fixed.sent).toHaveLength(3);
    const rows = await deliveriesByProfile();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === "sent" && row.error_code === null)).toBe(true);
    expect(rows.map((row) => row.attempts)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("stops the run when the server stays unreachable, after the in-run retries", async () => {
    await moreProfiles();
    await store();
    const down = fakeSender(["unreachable", "unreachable", "unreachable"]);
    const pauses: number[] = [];
    const result = await run([], {
      digest: {
        createSender: () => down.sender,
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report.errorCode).toBe("send_server_unreachable");
    expect(result.report.profiles.map((p) => p.status)).toEqual(["failed", "not_run", "not_run"]);
    expect(down.attempts()).toBe(3);
    expect(pauses).toEqual([2_000, 10_000]);
    expect(await deliveriesByProfile()).toEqual([
      { profile_id: profile.id, status: "failed", attempts: 0, error_code: "smtp_unreachable" },
    ]);
  });

  it("stops the run after an uncertain send, so no further outcome is left unknown", async () => {
    await moreProfiles();
    await store();
    const sender = fakeSender(["uncertain"]);
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report.errorCode).toBe("send_outcome_unknown");
    expect(result.report.profiles.map((p) => p.status)).toEqual([
      "uncertain",
      "not_run",
      "not_run",
    ]);
    expect(sender.attempts()).toBe(1);
    expect(await deliveriesByProfile()).toEqual([
      { profile_id: profile.id, status: "pending", attempts: 0, error_code: null },
    ]);
  });

  it("keeps serving the other profiles after a failure about one message", async () => {
    await moreProfiles();
    await store();
    const sender = fakeSender(["permanent"]);
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report.errorCode).toBeNull();
    expect(result.report.profiles.map((p) => p.status)).toEqual(["failed", "sent", "sent"]);
    expect(sender.attempts()).toBe(3);
  });

  it("treats rows left pending by a crashed run as uncertain, never resending them", async () => {
    const offer = await store();
    await sql`
      INSERT INTO deliveries (profile_id, opportunity_id, transport, digest_date, status)
      VALUES (${profile.id}, ${offer.id}, 'test', '2026-10-31', 'pending')
    `.execute(schema.db);
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(only(result.report)).toMatchObject({ status: "nothing_new", matched: 1, uncertain: 1 });
    expect(result.stderr).toContain("Digest: 1 delivery is pending and needs an operator decision");
    expect(sender.attempts()).toBe(0);
  });

  it("caps an e-mail and leaves the overflow for the next digest", async () => {
    const total = DIGEST_MAX_ITEMS + 3;
    for (let index = 0; index < total; index++) {
      await store({ deadline: new Date(Date.UTC(2026, 10, 10, 11, index)) });
    }
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(only(result.report)).toMatchObject({
      status: "sent",
      matched: total,
      claimed: DIGEST_MAX_ITEMS,
      sent: DIGEST_MAX_ITEMS,
      overflow: 3,
    });
    const text = sender.sent[0]?.email.text ?? "";
    expect(text).toContain(
      "3 kolejne pasujące zamówienia wyślemy w następnych dniach, jeśli będą wtedy aktualne.",
    );
    // The soonest deadlines were taken.
    expect(text).toContain("Termin składania ofert: 2026-11-10 12:00");
    expect(text).not.toContain("Termin składania ofert: 2026-11-10 12:52");

    const nextDay = fakeSender();
    const tomorrow = await run([], {
      digest: { createSender: () => nextDay.sender, now: () => NEXT_DAY },
    });
    expect(only(tomorrow.report)).toMatchObject({ status: "sent", claimed: 3, overflow: 0 });
  });

  it("skips an invalid stored offer, logging its id and field paths only", async () => {
    await store();
    const broken = await store();
    await sql`UPDATE opportunities SET location = '{"bogus": 1}' WHERE id = ${broken.id}`.execute(
      schema.db,
    );
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.report.skippedInvalidRows).toBe(1);
    expect(only(result.report)).toMatchObject({ status: "sent", sent: 1 });
    const warning = result.stderr
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.message === "invalid stored opportunity skipped");
    expect(warning?.opportunityId).toBe(broken.id);
    expect(Array.isArray(warning?.fields)).toBe(true);
    expect(JSON.stringify(warning)).not.toContain('bogus":1');
  });

  it("reports an invalid stored profile and still serves the others", async () => {
    const other = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "kontakt2@example.invalid",
    });
    await sql`UPDATE company_profiles SET categories = '{nieznana}' WHERE id = ${other.id}`.execute(
      schema.db,
    );
    await store();
    const sender = fakeSender();
    const result = await run([], { digest: { createSender: () => sender.sender } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: other.id, status: "invalid_profile" }),
        expect.objectContaining({ profileId: profile.id, status: "sent" }),
      ]),
    );
    expect(sender.sent).toHaveLength(1);
  });

  it("skips inactive profiles, and serves one profile with --profile", async () => {
    const inactive = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "kontakt2@example.invalid",
      active: false,
    });
    const other = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "kontakt3@example.invalid",
    });
    await store();

    const one = fakeSender();
    const single = await run(["--profile", other.id], {
      digest: { createSender: () => one.sender },
    });
    expect(single.report.profiles.map((p) => [p.profileId, p.status])).toEqual([
      [other.id, "sent"],
    ]);

    const inactiveRun = await run(["--profile", inactive.id]);
    expect(inactiveRun.code).toBe(ExitCode.Ok);
    expect(only(inactiveRun.report)).toMatchObject({ status: "inactive" });

    const missing = await run(["--profile", "00000000-0000-4000-8000-00000000dead"]);
    expect(missing.code).toBe(ExitCode.Failure);
    expect(only(missing.report)).toMatchObject({ status: "not_found" });

    const all = fakeSender();
    const result = await run([], { digest: { createSender: () => all.sender } });
    expect(result.report.profiles.map((p) => [p.profileId, p.status])).toEqual([
      [profile.id, "sent"],
      [other.id, "already_sent_today"],
    ]);
  });

  it("writes nothing and sends nothing in a dry run", async () => {
    await store();
    await store();
    let senders = 0;
    const result = await run(["--dry-run"], {
      digest: {
        createSender: () => {
          senders++;
          return fakeSender().sender;
        },
      },
      env: { EMAIL_OUTBOX_DIR: join(dir, "dry-run-outbox") },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.report.dryRun).toBe(true);
    expect(only(result.report)).toMatchObject({
      status: "dry_run",
      matched: 2,
      claimed: 2,
      sent: 0,
    });
    expect(senders).toBe(0);
    expect(await deliveries()).toEqual([]);
    await expect(readdir(join(dir, "dry-run-outbox"))).rejects.toThrow();
  });

  it("writes the e-mail to the outbox in the test mode", async () => {
    await store();
    const outbox = join(dir, "outbox");
    const result = await run([], {
      digest: { createSender: defaultDigestDeps.createSender },
      env: { EMAIL_MODE: "test", EMAIL_OUTBOX_DIR: outbox },
    });
    expect(result.code).toBe(ExitCode.Ok);
    const files = (await readdir(outbox)).sort();
    expect(files.map((file) => extname(file)).sort()).toEqual([".eml", ".json"]);
    const json = files.find((file) => file.endsWith(".json"));
    const content = JSON.parse(await readFile(join(outbox, json ?? ""), "utf8")) as OutgoingEmail;
    expect(content.to).toBe(EMAIL);
    expect(content.text).toContain("Aby zrezygnować z powiadomień");
  });

  it("keeps the deliveries of the two transports apart", async () => {
    await store();
    await run([]);
    const smtp = fakeSender();
    const result = await run([], {
      digest: { createSender: () => smtp.sender },
      env: {
        EMAIL_MODE: "smtp",
        EMAIL_FROM: "radar@example.invalid",
        SMTP_URL: "smtps://smtp.example.invalid",
      },
    });
    expect(result.report.transport).toBe("smtp");
    expect(only(result.report)).toMatchObject({ status: "sent", sent: 1 });
    expect((await deliveries()).map((row) => row.transport).sort()).toEqual(["smtp", "test"]);
  });

  it("skips with exit 0 while another digest holds the lock", async () => {
    await store();
    const logger = createLogger("error", () => {});
    const sender = fakeSender();
    const locked = await withDigestLock(
      schema.db,
      () => run([], { digest: { createSender: () => sender.sender } }),
      { logger },
    );
    if (!locked.acquired) throw new Error("lock not acquired");
    expect(locked.value.code).toBe(ExitCode.Ok);
    expect(locked.value.report).toMatchObject({ status: "skipped", reason: "lock_busy" });
    expect(sender.attempts()).toBe(0);
    expect(await deliveries()).toEqual([]);
  });

  it("stops before the next profile when the lock is lost", async () => {
    await createCompanyProfile(schema.db, { ...profileInput, email: "kontakt2@example.invalid" });
    await store();
    const sender = fakeSender([], async () => {
      await sql`
        SELECT pg_terminate_backend(pid, 5000) FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 1 AND granted
          AND ((classid::bigint << 32) | objid::bigint) = ${DIGEST_LOCK_KEY}::bigint
      `.execute(schema.db);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const result = await run([], {
      digest: { createSender: () => sender.sender },
      heartbeatMs: 20,
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.report.status).toBe("failed");
    expect(result.report.profiles.map((p) => p.status)).toEqual(["sent", "not_run"]);
    expect(result.stderr).toContain("digest lock lost");
    expect(result.stderr).toContain("(lock_lost)");
  });

  it("enforces the delivery constraints", async () => {
    const offer = await store();
    const insert = (status: string, errorCode: string | null) =>
      sql`
        INSERT INTO deliveries (profile_id, opportunity_id, transport, digest_date, status, error_code)
        VALUES (${profile.id}, ${offer.id}, 'test', '2026-11-01', ${status}, ${errorCode})
      `.execute(schema.db);
    await expect(insert("failed", null)).rejects.toThrow(/deliveries_error_code_status_check/);
    await expect(insert("failed", "Not A Code")).rejects.toThrow(/deliveries_error_code_check/);
    await expect(insert("sent", null)).rejects.toThrow(/deliveries_sent_at_check/);
    await expect(insert("queued", null)).rejects.toThrow(/deliveries_status_check/);
    await insert("pending", null);
    await expect(insert("pending", null)).rejects.toThrow(
      /deliveries_profile_opportunity_transport_key/,
    );
    // Deleting a profile deletes its delivery history.
    await sql`DELETE FROM company_profiles WHERE id = ${profile.id}`.execute(schema.db);
    expect(await deliveries()).toEqual([]);
  });

  describe("web links (PR-06A)", () => {
    const BASE = "https://radar.example.invalid";

    async function tokens() {
      return schema.db
        .selectFrom("access_tokens")
        .select(["purpose", "profile_id", "token_hash", "used_at"])
        .select(sql<number>`extract(epoch FROM expires_at - created_at)::int`.as("ttl"))
        .orderBy("purpose")
        .execute();
    }

    it("puts a login link and a one-click unsubscribe link into each e-mail with PUBLIC_BASE_URL", async () => {
      await store();
      const sender = fakeSender();
      const result = await run([], {
        digest: { createSender: () => sender.sender },
        env: { PUBLIC_BASE_URL: BASE },
      });
      expect(result.code).toBe(ExitCode.Ok);
      const email = sender.sent[0]?.email;
      if (email === undefined) throw new Error("no e-mail");
      const login = new RegExp(`${BASE}/dostep/([A-Za-z0-9_-]{43})`).exec(email.text)?.[1];
      const unsubscribe = new RegExp(`${BASE}/wypis/([A-Za-z0-9_-]{43})`).exec(email.text)?.[1];
      if (login === undefined || unsubscribe === undefined) throw new Error("links missing");
      expect(email.unsubscribeUrl).toBe(`${BASE}/wypis/${unsubscribe}`);
      expect(email.text).toContain("Twój profil");
      expect(email.html).toContain(`<a href="${BASE}/dostep/${login}">`);
      expect(email.html).toContain(`<a href="${BASE}/wypis/${unsubscribe}">`);
      // Stored as hashes only, for the profile, with their lifetimes; never printed.
      expect(await tokens()).toEqual([
        {
          purpose: "login",
          profile_id: profile.id,
          token_hash: hashSecretToken(login),
          used_at: null,
          ttl: 7 * 24 * 3600,
        },
        {
          purpose: "unsubscribe",
          profile_id: profile.id,
          token_hash: hashSecretToken(unsubscribe),
          used_at: null,
          ttl: 60 * 24 * 3600,
        },
      ]);
      expect(result.stderr).not.toContain(login);
      expect(result.stderr).not.toContain(unsubscribe);
      expect(await consumeLoginToken(schema.db, login)).toMatchObject({ profileId: profile.id });
    });

    it("sends nothing to an address changed on the web during the run (next run: the new one)", async () => {
      const offer = await store();
      const newEmail = "nowy@example.invalid";
      // An e-mail change committing while the run is about to issue the links.
      const change = pausedTransaction(
        schema.db,
        async (trx) => {
          await trx
            .updateTable("company_profiles")
            .set({ email: newEmail })
            .where("id", "=", profile.id)
            .execute();
        },
        () => Promise.resolve(),
      );
      const changePid = await change.pid;
      const sender = fakeSender();
      const running = run([], {
        digest: { createSender: () => sender.sender },
        env: { PUBLIC_BASE_URL: BASE },
      });
      await waitUntilBlockedBy(schema.db, changePid);
      change.resume();
      await change.done;
      const result = await running;
      expect(result.code).toBe(ExitCode.Ok);
      expect(only(result.report)).toMatchObject({ status: "address_changed", sent: 0 });
      expect(sender.attempts()).toBe(0);
      expect(await tokens()).toEqual([]);
      expect(await deliveries()).toEqual([]);

      const next = fakeSender();
      const again = await run([], {
        digest: { createSender: () => next.sender },
        env: { PUBLIC_BASE_URL: BASE },
      });
      expect(only(again.report)).toMatchObject({ status: "sent", sent: 1 });
      expect(next.sent.map((sent) => sent.email.to)).toEqual([newEmail]);
      expect((await deliveries()).map((row) => row.opportunity_id)).toEqual([offer.id]);
    });

    it("writes both List-Unsubscribe headers to the outbox copy", async () => {
      await store();
      const outbox = join(dir, "outbox-links");
      const result = await run([], {
        digest: { createSender: defaultDigestDeps.createSender },
        env: {
          EMAIL_MODE: "test",
          EMAIL_OUTBOX_DIR: outbox,
          EMAIL_FROM: "radar@example.invalid",
          PUBLIC_BASE_URL: BASE,
        },
      });
      expect(result.code).toBe(ExitCode.Ok);
      const eml = (await readdir(outbox)).find((file) => file.endsWith(".eml"));
      const message = await readFile(join(outbox, eml ?? ""), "utf8");
      const head = (message.split("\n\n")[0] ?? "").replace(/\n[ \t]+/g, " ");
      expect(head).toMatch(
        new RegExp(
          `^List-Unsubscribe: <${BASE}/wypis/[A-Za-z0-9_-]{43}>, ` +
            "<mailto:radar@example\\.invalid\\?subject=wypis> \\(Wypisz\\)$",
          "m",
        ),
      );
      expect(head).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    });

    it("keeps the reply-only e-mail and issues no token without PUBLIC_BASE_URL", async () => {
      await store();
      const sender = fakeSender();
      const result = await run([], { digest: { createSender: () => sender.sender } });
      expect(result.code).toBe(ExitCode.Ok);
      const email = sender.sent[0]?.email;
      expect(email?.unsubscribeUrl).toBeUndefined();
      expect(email?.text).not.toContain("Twój profil");
      expect(email?.text).toContain("odpowiedz na tę wiadomość lub napisz do operatora serwisu");
      expect(await tokens()).toEqual([]);
    });

    it("issues no token in a dry run or when there is nothing to send", async () => {
      expect((await run([], { env: { PUBLIC_BASE_URL: BASE } })).code).toBe(ExitCode.Ok);
      await store();
      expect((await run(["--dry-run"], { env: { PUBLIC_BASE_URL: BASE } })).code).toBe(ExitCode.Ok);
      expect(await tokens()).toEqual([]);
    });

    it("refuses an invalid PUBLIC_BASE_URL before sending anything", async () => {
      await store();
      let stderr = "";
      const code = await runCli(
        ["digest"],
        {
          env: {
            NODE_ENV: "test",
            DATABASE_URL: schema.url,
            PUBLIC_BASE_URL: "http://radar.example.invalid",
          },
          stdout: () => undefined,
          stderr: (text) => (stderr += text),
        },
        defaultCliDeps,
      );
      expect(code).toBe(ExitCode.Failure);
      expect(stderr).toBe("Invalid web configuration: PUBLIC_BASE_URL\n");
      expect(await deliveries()).toEqual([]);
    });
  });
});
