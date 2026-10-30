import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { migrations } from "../../src/infrastructure/db/migrations.js";
import {
  applyDeadlineUpdate,
  upsertOpportunity,
} from "../../src/infrastructure/db/opportunities-repository.js";
import type { HttpResponse } from "../../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { runIngestion, type IngestionDeps } from "../../src/ingestion/run.js";
import { bzpAdapter } from "../../src/sources/bzp/adapter.js";
import type { SourceHttpClient } from "../../src/sources/types.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/**
 * Notice updates end to end (PR-03B, D-015): the real BZP adapter over a fake
 * HTTP client that serves records per notice type and publication day, the
 * captured update notices (tests/fixtures/bzp/notice-update-notice-2026-10-29.json)
 * and synthetic, pseudonymised contract notices as their originals.
 */

const NOW = new Date("2026-10-30T10:00:00.000Z");
const ORIGINALS_DAY = "2026-10-20";
const UPDATES_DAY = "2026-10-29";

type JsonRecord = Record<string, unknown>;
const recordListSchema = z.array(z.record(z.string(), z.unknown()));

function updateFixture(): JsonRecord[] {
  const text = readFileSync(
    new URL("../fixtures/bzp/notice-update-notice-2026-10-29.json", import.meta.url),
    "utf8",
  );
  return recordListSchema.parse(JSON.parse(text));
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${String(index)}`);
  return item;
}

const UPDATES = updateFixture();
const tenderIds = UPDATES.map((record) => z.string().parse(record.tenderId));
/** Update 0 changes the deadline to 2026-11-03 10:00 Warsaw time. */
const UPDATE_0_LOCAL_DEADLINE = "2026-11-03 10:00";

/** The captured update 0, with another number, publication time and/or new deadline. */
function variantOfUpdate0(fields: {
  readonly noticeNumber: string;
  readonly publicationDate: string;
  readonly localDeadline?: string;
  readonly tenderId?: string | null;
}): JsonRecord {
  const base = at(UPDATES, 0);
  const html = z.string().parse(base.htmlBody);
  return {
    ...base,
    noticeNumber: fields.noticeNumber,
    publicationDate: fields.publicationDate,
    ...(fields.tenderId === undefined ? {} : { tenderId: fields.tenderId }),
    htmlBody: html.replace(
      UPDATE_0_LOCAL_DEADLINE,
      fields.localDeadline ?? UPDATE_0_LOCAL_DEADLINE,
    ),
  };
}

/** A synthetic contract notice of the procedure `tenderId`; deadline already passed at NOW. */
function contractNotice(
  n: number,
  tenderId: string | null,
  overrides: JsonRecord = {},
): JsonRecord {
  const suffix = String(n).padStart(4, "0");
  return {
    noticeType: "ContractNotice",
    noticeNumber: `2026/BZP 0048${suffix}/01`,
    objectId: `00000000-0000-4000-8000-00000000${suffix}`,
    publicationDate: "2026-10-20T08:00:00.0000000Z",
    orderObject: `Dostawa materiałów biurowych nr ${String(n)}`,
    organizationName: "Gmina Przykładowa",
    organizationCity: "Przykładowo",
    organizationProvince: "PL14",
    cpvCode: "30192000-1 (Artykuły biurowe)",
    submittingOffersDate: "2026-10-29T07:00:00.0000000Z",
    tenderId,
    ...overrides,
  };
}

const ORIGINALS = tenderIds.map((tenderId, index) => contractNotice(index + 1, tenderId));

/** Serves a JSON page per (NoticeType, publication day); anything not set is an empty list. */
class PagesHttpClient implements SourceHttpClient {
  readonly #pages = new Map<string, readonly JsonRecord[]>();

  serve(noticeType: string, day: string, records: readonly JsonRecord[]): this {
    // At most one page per type: a full page would make the adapter ask for the next.
    expect(records.length).toBeLessThan(25);
    this.#pages.set(`${noticeType} ${day}`, records);
    return this;
  }

  get(url: string | URL): Promise<HttpResponse> {
    const href = url.toString();
    const params = new URL(href).searchParams;
    const key = `${params.get("NoticeType") ?? ""} ${params.get("PublicationDateFrom") ?? ""}`;
    return Promise.resolve({
      url: href,
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(JSON.stringify(this.#pages.get(key) ?? []), "utf8"),
    });
  }
}

const logLineSchema = z.looseObject({ level: z.string(), message: z.string() });

async function ingest(schema: TestSchema, http: SourceHttpClient, day: string, now = NOW) {
  const lines: string[] = [];
  const deps: IngestionDeps = {
    db: schema.db,
    adapters: new Map([[bzpAdapter.sourceId, bzpAdapter]]),
    createHttpClient: () => http,
    now: () => now,
    logger: createLogger("debug", (line) => lines.push(line)),
    sourceTimeoutMs: 60_000,
  };
  const outcome = await runIngestion(deps, {
    sourceIds: ["bzp"],
    days: { mode: "range", from: day, to: day },
    maxRecords: 100,
  });
  expect(outcome.runs).toHaveLength(1);
  const run = at(outcome.runs, 0);
  return {
    run,
    lines,
    logs: lines.map((line) => logLineSchema.parse(JSON.parse(line))),
  };
}

/** The total of a run's `skippedReasons`. */
function sumOf(counts: Readonly<Record<string, number | undefined>>): number {
  return Object.values(counts).reduce<number>((total, n) => total + (n ?? 0), 0);
}

const rowSchema = z.object({
  id: z.string(),
  external_id: z.string().nullable(),
  tender_id: z.string().nullable(),
  title: z.string(),
  deadline: z.date().nullable(),
  status: z.string(),
  deadline_update_notice: z.string().nullable(),
  deadline_update_published_at: z.date().nullable(),
  fetched_at: z.date(),
  content_hash: z.string(),
  updated_at: z.date(),
});
type Row = z.output<typeof rowSchema>;

async function rows(schema: TestSchema): Promise<Row[]> {
  const result = await schema.db
    .selectFrom("opportunities")
    .select([
      "id",
      "external_id",
      "tender_id",
      "title",
      "deadline",
      "status",
      "deadline_update_notice",
      "deadline_update_published_at",
      "fetched_at",
      "content_hash",
      "updated_at",
    ])
    .orderBy("external_id")
    .execute();
  return z.array(rowSchema).parse(result);
}

function rowOf(all: readonly Row[], tenderId: string): Row {
  const matching = all.filter((row) => row.tender_id === tenderId);
  expect(matching).toHaveLength(1);
  return at(matching, 0);
}

function skipReasons(logs: readonly z.output<typeof logLineSchema>[]): unknown[] {
  return logs.filter((line) => line.message === "notice update skipped").map((line) => line.reason);
}

describe.skipIf(skipWithoutDatabase)("notice updates (PostgreSQL, BZP adapter)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });
  beforeEach(async () => {
    await sql`DELETE FROM opportunities`.execute(schema.db);
    await sql`DELETE FROM ingestion_runs`.execute(schema.db);
  });

  it("applies the new deadlines to the originals and skips updates without one (AC1, AC6)", async () => {
    const http = new PagesHttpClient()
      .serve("ContractNotice", ORIGINALS_DAY, ORIGINALS)
      .serve("NoticeUpdateNotice", UPDATES_DAY, UPDATES);
    expect((await ingest(schema, http, ORIGINALS_DAY)).run.counters).toMatchObject({
      inserted: 5,
    });
    const before = await rows(schema);
    expect(before.every((row) => row.status === "closed")).toBe(true);

    const { run, lines, logs } = await ingest(schema, http, UPDATES_DAY);
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(run.counters).toEqual({
      documents: 3,
      extracted: 5,
      inserted: 0,
      updated: 3,
      unchanged: 0,
      rejected: 0,
      skipped: 2,
    });
    expect(run.skippedReasons).toEqual({ no_deadline_change: 1, not_contract_notice_change: 1 });
    expect(sumOf(run.skippedReasons)).toBe(run.counters.skipped);

    const after = await rows(schema);
    expect(after).toHaveLength(5);
    const expected: [number, string | null][] = [
      [0, "2026-11-03T09:00:00.000Z"],
      [1, null],
      [2, "2026-11-04T09:00:00.000Z"],
      [3, null],
      [4, "2026-11-05T09:00:00.000Z"],
    ];
    for (const [index, deadline] of expected) {
      const tenderId = at(tenderIds, index);
      const old = rowOf(before, tenderId);
      const row = rowOf(after, tenderId);
      // Only the deadline, status, provenance and updated_at ever change.
      expect(row.fetched_at).toEqual(old.fetched_at);
      expect(row.content_hash).toBe(old.content_hash);
      expect(row.title).toBe(old.title);
      if (deadline === null) {
        expect(row).toEqual(old);
        continue;
      }
      const update = at(UPDATES, index);
      expect(row.deadline).toEqual(new Date(deadline));
      expect(row.status).toBe("open");
      expect(row.deadline_update_notice).toBe(update.noticeNumber);
      expect(row.deadline_update_published_at).toEqual(
        new Date(z.string().parse(update.publicationDate).slice(0, 23) + "Z"),
      );
      expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(old.updated_at.getTime());
    }

    expect(skipReasons(logs)).toEqual(["no_deadline_change", "not_contract_notice_change"]);
    expect(logs.find((line) => line.message === "notice update skipped")).toMatchObject({
      level: "info",
      sourceId: "bzp",
      externalId: "2026/BZP 00507129/01",
      tenderId: at(tenderIds, 1),
    });
    // No markup and no text from the bodies ever reaches the log.
    const logText = lines.join("\n");
    expect(logText).not.toContain("<");
    expect(logText).not.toContain("Po zmianie");
    expect(logText).not.toContain("htmlBody");

    const runRow = await schema.db
      .selectFrom("ingestion_runs")
      .select(["extracted", "inserted", "updated", "unchanged", "rejected", "skipped"])
      .where(sql<string>`publication_date::text`, "=", UPDATES_DAY)
      .executeTakeFirstOrThrow();
    expect(runRow).toEqual({
      extracted: 5,
      inserted: 0,
      updated: 3,
      unchanged: 0,
      rejected: 0,
      skipped: 2,
    });
    expect(
      runRow.inserted + runRow.updated + runRow.unchanged + runRow.rejected + runRow.skipped,
    ).toBe(runRow.extracted);

    // The same updates again: already applied.
    const again = await ingest(schema, http, UPDATES_DAY);
    expect(again.run.counters).toMatchObject({ updated: 0, unchanged: 3, skipped: 2 });
    expect(again.run.skippedReasons).toEqual({
      no_deadline_change: 1,
      not_contract_notice_change: 1,
    });
    expect(await rows(schema)).toEqual(after);
  });

  it("skips updates without an original or a tenderId and rejects unreadable ones (AC2)", async () => {
    const http = new PagesHttpClient().serve("NoticeUpdateNotice", UPDATES_DAY, [
      { ...at(UPDATES, 0), tenderId: null },
      variantOfUpdate0({
        noticeNumber: "2026/BZP 00507126/02",
        publicationDate: "2026-10-29T06:00:00Z",
        localDeadline: "2026-11-31 10:00",
      }),
      at(UPDATES, 2),
      at(UPDATES, 4),
    ]);
    const { run, logs, lines } = await ingest(schema, http, UPDATES_DAY);
    expect(run.counters).toEqual({
      documents: 3,
      extracted: 4,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      rejected: 1,
      skipped: 3,
    });
    expect(skipReasons(logs)).toEqual(["no_tender_id", "no_original", "no_original"]);
    expect(run.skippedReasons).toEqual({ no_tender_id: 1, no_original: 2 });
    expect(sumOf(run.skippedReasons)).toBe(run.counters.skipped);
    expect(logs.filter((line) => line.message === "source record rejected")).toEqual([
      expect.objectContaining({
        level: "warn",
        externalId: "2026/BZP 00507126/02",
        reason: "invalid value: deadline",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("2026-11-31");
    // Never stored as opportunities of their own.
    expect(await rows(schema)).toEqual([]);
  });

  it("keeps an applied deadline when the original is fetched again (AC4)", async () => {
    const http = new PagesHttpClient()
      .serve("ContractNotice", ORIGINALS_DAY, ORIGINALS)
      .serve("NoticeUpdateNotice", UPDATES_DAY, UPDATES);
    await ingest(schema, http, ORIGINALS_DAY);
    await ingest(schema, http, UPDATES_DAY);
    const updated = await rows(schema);

    // Unchanged content: nothing is written.
    const same = await ingest(schema, http, ORIGINALS_DAY);
    expect(same.run.counters).toMatchObject({ unchanged: 5, updated: 0 });
    expect(await rows(schema)).toEqual(updated);

    // Changed content: the row is updated, the applied deadline and its
    // provenance stay, the status follows that deadline at the new fetch.
    const changed = ORIGINALS.map((record, index) =>
      index === 0 || index === 1
        ? { ...record, orderObject: `${String(record.orderObject)} (zmiana)` }
        : record,
    );
    http.serve("ContractNotice", ORIGINALS_DAY, changed);
    const refetch = await ingest(schema, http, ORIGINALS_DAY);
    expect(refetch.run.counters).toMatchObject({ updated: 2, unchanged: 3 });
    const after = await rows(schema);
    const first = rowOf(after, at(tenderIds, 0));
    expect(first).toMatchObject({
      title: "Dostawa materiałów biurowych nr 1 (zmiana)",
      deadline: new Date("2026-11-03T09:00:00.000Z"),
      // The fetched notice's own deadline has passed; the applied one has not.
      status: "open",
      deadline_update_notice: "2026/BZP 00507126/01",
    });
    expect(first.content_hash).not.toBe(rowOf(updated, at(tenderIds, 0)).content_hash);
    // Without an applied update, the fetched values are taken as before.
    expect(rowOf(after, at(tenderIds, 1))).toMatchObject({
      title: "Dostawa materiałów biurowych nr 2 (zmiana)",
      deadline: new Date("2026-10-29T07:00:00.000Z"),
      status: "closed",
      deadline_update_notice: null,
    });

    // After the applied deadline, a changed fetch marks the row closed.
    http.serve(
      "ContractNotice",
      ORIGINALS_DAY,
      changed.map((record, index) =>
        index === 0
          ? { ...record, orderObject: "Dostawa materiałów biurowych nr 1 (druga zmiana)" }
          : record,
      ),
    );
    await ingest(schema, http, ORIGINALS_DAY, new Date("2026-11-10T10:00:00.000Z"));
    expect(rowOf(await rows(schema), at(tenderIds, 0))).toMatchObject({
      deadline: new Date("2026-11-03T09:00:00.000Z"),
      status: "closed",
      deadline_update_notice: "2026/BZP 00507126/01",
    });
  });

  it("keeps the latest published update whatever the reading order (AC5)", async () => {
    const tenderId = at(tenderIds, 0);
    const older = variantOfUpdate0({
      noticeNumber: "2026/BZP 00500001/01",
      publicationDate: "2026-10-28T06:00:00Z",
      localDeadline: "2026-11-05 10:00",
    });
    const newer = variantOfUpdate0({
      noticeNumber: "2026/BZP 00500002/01",
      publicationDate: "2026-10-29T06:00:00Z",
      localDeadline: "2026-11-10 12:00",
    });
    const http = new PagesHttpClient()
      .serve("ContractNotice", ORIGINALS_DAY, [at(ORIGINALS, 0)])
      .serve("NoticeUpdateNotice", "2026-10-29", [newer])
      .serve("NoticeUpdateNotice", "2026-10-28", [older]);
    await ingest(schema, http, ORIGINALS_DAY);

    expect((await ingest(schema, http, "2026-10-29")).run.counters).toMatchObject({ updated: 1 });
    const late = await ingest(schema, http, "2026-10-28");
    expect(late.run.counters).toMatchObject({ updated: 0, unchanged: 0, skipped: 1 });
    expect(skipReasons(late.logs)).toEqual(["superseded"]);
    expect(late.run.skippedReasons).toEqual({ superseded: 1 });
    expect(rowOf(await rows(schema), tenderId)).toMatchObject({
      deadline: new Date("2026-11-10T11:00:00.000Z"),
      deadline_update_notice: "2026/BZP 00500002/01",
      deadline_update_published_at: new Date("2026-10-29T06:00:00.000Z"),
    });
    expect((await ingest(schema, http, "2026-10-29")).run.counters).toMatchObject({
      unchanged: 1,
      skipped: 0,
    });

    // Same publication time: the higher notice number wins, in any order.
    const tieA = variantOfUpdate0({
      noticeNumber: "2026/BZP 00500003/01",
      publicationDate: "2026-10-30T06:00:00Z",
      localDeadline: "2026-11-12 10:00",
    });
    const tieB = variantOfUpdate0({
      noticeNumber: "2026/BZP 00500004/01",
      publicationDate: "2026-10-30T06:00:00Z",
      localDeadline: "2026-11-13 10:00",
    });
    http.serve("NoticeUpdateNotice", "2026-10-30", [tieB, tieA]);
    const tie = await ingest(schema, http, "2026-10-30");
    expect(tie.run.counters).toMatchObject({ updated: 1, skipped: 1 });
    expect(skipReasons(tie.logs)).toEqual(["superseded"]);
    expect(rowOf(await rows(schema), tenderId)).toMatchObject({
      deadline: new Date("2026-11-13T09:00:00.000Z"),
      deadline_update_notice: "2026/BZP 00500004/01",
    });
  });

  it("sets the status from the new deadline at the update's fetch time", async () => {
    const http = new PagesHttpClient()
      .serve("ContractNotice", ORIGINALS_DAY, [at(ORIGINALS, 0)])
      .serve("NoticeUpdateNotice", UPDATES_DAY, [
        variantOfUpdate0({
          noticeNumber: "2026/BZP 00500005/01",
          publicationDate: "2026-10-29T06:00:00Z",
          localDeadline: "2026-10-29 12:00",
        }),
      ]);
    await ingest(schema, http, ORIGINALS_DAY);
    await ingest(schema, http, UPDATES_DAY);
    expect(rowOf(await rows(schema), at(tenderIds, 0))).toMatchObject({
      deadline: new Date("2026-10-29T11:00:00.000Z"),
      status: "closed",
    });
  });

  it("applies an update to the original notice of a procedure with several rows", async () => {
    const tenderId = at(tenderIds, 0);
    // A later notice of the same procedure, published later but stored first.
    const later = contractNotice(10, tenderId, { publicationDate: "2026-10-25T08:00:00Z" });
    const original = contractNotice(11, tenderId, { publicationDate: "2026-10-21T08:00:00Z" });
    const http = new PagesHttpClient()
      .serve("ContractNotice", "2026-10-25", [later])
      .serve("ContractNotice", "2026-10-21", [original])
      .serve("NoticeUpdateNotice", UPDATES_DAY, [at(UPDATES, 0)]);
    await ingest(schema, http, "2026-10-25");
    await ingest(schema, http, "2026-10-21");
    await ingest(schema, http, UPDATES_DAY);
    const stored = await rows(schema);
    expect(stored.map((row) => [row.external_id, row.deadline_update_notice])).toEqual([
      ["2026/BZP 00480010/01", null],
      ["2026/BZP 00480011/01", "2026/BZP 00507126/01"],
    ]);
  });

  it("orders rows of one procedure by publication (unknown last), then first seen, then id", async () => {
    const tenderId = "ocds-148610-00000000-0000-4000-8000-000000000001";
    const draft = (n: number, publishedAt: Date | null): OpportunityDraft => ({
      sourceId: "bzp",
      sourceUrl: `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${String(n)}`,
      externalId: `2026/BZP 0049000${String(n)}/01`,
      tenderId,
      issuerName: "Gmina Przykładowa",
      title: `Dostawa nr ${String(n)}`,
      description: null,
      location: null,
      publishedAt,
      deadline: null,
      estimatedValue: null,
      currency: null,
      categories: [],
      contact: null,
      fetchedAt: NOW,
      fingerprint: `order-test-${String(n)}`,
      contentHash: `hash-${String(n)}`,
      status: "unknown",
    });
    const apply = (notice: string, publishedAt: string) =>
      applyDeadlineUpdate(schema.db, {
        sourceId: "bzp",
        tenderId,
        updateNotice: notice,
        updatePublishedAt: new Date(publishedAt),
        deadline: new Date("2026-11-20T09:00:00.000Z"),
        status: "open",
      });

    const store = async (n: number, publishedAt: Date | null) =>
      (await upsertOpportunity(schema.db, draft(n, publishedAt))).opportunity.id;

    const unknownFirst = await store(1, null);
    const unknownSecond = await store(2, null);
    // Both unpublished: the first stored is the original.
    expect(await apply("2026/BZP 00499001/01", "2026-10-29T06:00:00Z")).toEqual({
      outcome: "updated",
      id: unknownFirst,
    });
    expect(unknownSecond).not.toBe(unknownFirst);

    // A row with a publication time comes before rows without one.
    const published = await store(3, new Date("2026-10-27T08:00:00.000Z"));
    expect(await apply("2026/BZP 00499002/01", "2026-10-29T06:00:00Z")).toEqual({
      outcome: "updated",
      id: published,
    });
    const earlier = await store(4, new Date("2026-10-26T08:00:00.000Z"));
    expect(await apply("2026/BZP 00499003/01", "2026-10-29T06:00:00Z")).toEqual({
      outcome: "updated",
      id: earlier,
    });
    // Another source's rows are never touched.
    expect(
      await applyDeadlineUpdate(schema.db, {
        sourceId: "zrodlo-bez-wierszy",
        tenderId,
        updateNotice: "2026/BZP 00499004/01",
        updatePublishedAt: new Date("2026-10-29T06:00:00Z"),
        deadline: new Date("2026-11-20T09:00:00.000Z"),
        status: "open",
      }),
    ).toEqual({ outcome: "skipped", reason: "no_original" });
  });

  it("refuses an invalid deadline update before touching the database", async () => {
    await expect(
      applyDeadlineUpdate(schema.db, {
        sourceId: "bzp",
        tenderId: "",
        updateNotice: "2026/BZP 00499001/01",
        updatePublishedAt: NOW,
        deadline: NOW,
        status: "open",
      }),
    ).rejects.toMatchObject({ name: "DomainError", code: "invalid_input" });
  });
});

/** Applies only the named migrations, as a database deployed by an earlier release. */
async function migrateOnly(schema: TestSchema, names: readonly string[]): Promise<void> {
  const selected = Object.fromEntries(
    names.map((name) => {
      const migration = migrations[name];
      if (migration === undefined) throw new Error(`migration ${name} missing`);
      return [name, migration];
    }),
  );
  const { rows: current } = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(
    schema.db,
  );
  const migrator = new Migrator({
    db: schema.db,
    provider: { getMigrations: () => Promise.resolve(selected) },
    migrationTableSchema: at(current, 0).name,
  });
  const { error } = await migrator.migrateToLatest();
  expect(error).toBeUndefined();
}

describe.skipIf(skipWithoutDatabase)("migration 0004_notice_updates (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  it("keeps existing rows (no provenance, skipped 0) and enforces the new constraints", async () => {
    await migrateOnly(schema, [
      "0001_core_schema",
      "0002_ingestion_runs",
      "0003_opportunities_tender_id",
    ]);
    await sql`
      INSERT INTO opportunities (source_id, source_url, issuer_name, title, fetched_at,
                                 fingerprint, content_hash, status)
      VALUES ('bzp', 'https://ezamowienia.gov.pl/x', 'Gmina Przykładowa', 'Stary wpis',
              now(), 'fp-0003', 'hash-0003', 'unknown')
    `.execute(schema.db);
    await sql`
      INSERT INTO ingestion_runs (source_id, publication_date, max_records, started_at,
                                  finished_at, status, documents, extracted, inserted,
                                  updated, unchanged, rejected)
      VALUES ('bzp', '2026-10-28', 100, now(), now(), 'succeeded', 1, 1, 1, 0, 0, 0)
    `.execute(schema.db);

    await migrateToLatest(schema.db);

    const opportunity = await schema.db
      .selectFrom("opportunities")
      .select(["deadline_update_notice", "deadline_update_published_at"])
      .executeTakeFirstOrThrow();
    expect(opportunity).toEqual({
      deadline_update_notice: null,
      deadline_update_published_at: null,
    });
    const run = await schema.db
      .selectFrom("ingestion_runs")
      .select("skipped")
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ skipped: 0 });

    const constraintOf = async (statement: Promise<unknown>) => {
      const error: unknown = await statement.then(
        () => null,
        (failure: unknown) => failure,
      );
      return z.object({ constraint: z.string() }).parse(error).constraint;
    };
    await expect(
      constraintOf(
        sql`UPDATE opportunities SET deadline_update_notice = '2026/BZP 1/01'`.execute(schema.db),
      ),
    ).resolves.toBe("opportunities_deadline_update_check");
    await expect(
      constraintOf(
        sql`UPDATE opportunities SET deadline_update_published_at = now()`.execute(schema.db),
      ),
    ).resolves.toBe("opportunities_deadline_update_check");
    await expect(
      constraintOf(
        sql`UPDATE opportunities SET deadline_update_notice = '',
                                     deadline_update_published_at = now()`.execute(schema.db),
      ),
    ).resolves.toBe("opportunities_deadline_update_notice_check");
    await expect(
      constraintOf(sql`UPDATE ingestion_runs SET skipped = -1`.execute(schema.db)),
    ).resolves.toBe("ingestion_runs_skipped_check");
  });
});
