import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../../src/domain/errors.js";
import type { IngestionRunSummary } from "../../src/domain/ingestion-run.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { recordIngestionRun } from "../../src/infrastructure/db/ingestion-runs-repository.js";
import { migrations } from "../../src/infrastructure/db/migrations.js";
import {
  ingestOpportunity,
  upsertOpportunity,
} from "../../src/infrastructure/db/opportunities-repository.js";
import { getSource, upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { HttpClientError } from "../../src/infrastructure/http/errors.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { fingerprint } from "../../src/ingestion/fingerprint.js";
import { IngestLockLostError } from "../../src/ingestion/lock.js";
import {
  IngestionRequestError,
  runIngestion,
  SchemaNotReadyError,
  type IngestionDeps,
  type IngestionRequest,
} from "../../src/ingestion/run.js";
import {
  SourceFormatError,
  type SourceAdapter,
  type SourceHttpClient,
} from "../../src/sources/types.js";
import { fakeNotice, fakeSource } from "./fake-source.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

const DAY = "2026-10-29";
const T0 = new Date("2026-10-30T05:00:00.000Z");

const noHttp: SourceHttpClient = {
  get: () => Promise.reject(new Error("fake sources never use HTTP")),
};

const logLineSchema = z.looseObject({ level: z.string(), message: z.string() });

async function registerSource(schema: TestSchema, id: string, enabled = true): Promise<void> {
  await upsertSource(schema.db, {
    id,
    name: `Źródło ${id}`,
    baseUrl: "https://zamowienia.example.invalid/",
    enabled,
  });
}

/** Runs ingestion with the given fake adapters; returns the results and parsed log lines. */
async function ingest(
  schema: TestSchema,
  adapters: readonly SourceAdapter[],
  request: Partial<IngestionRequest> & { readonly allEnabled?: boolean } = {},
  overrides: Partial<IngestionDeps> = {},
) {
  const lines: string[] = [];
  let clock = T0.getTime();
  const deps: IngestionDeps = {
    db: schema.db,
    adapters: new Map(adapters.map((adapter) => [adapter.sourceId, adapter])),
    createHttpClient: () => noHttp,
    now: () => new Date((clock += 1000)),
    logger: createLogger("debug", (line) => lines.push(line)),
    sourceTimeoutMs: 60_000,
    ...overrides,
  };
  const { allEnabled = false, ...rest } = request;
  const outcome = await runIngestion(deps, {
    days: { mode: "range", from: DAY, to: DAY },
    maxRecords: 100,
    // Without sourceIds runIngestion takes every enabled source (the default).
    ...(allEnabled ? {} : { sourceIds: adapters.map((adapter) => adapter.sourceId) }),
    ...rest,
  });
  const logs = lines.map((line) => logLineSchema.parse(JSON.parse(line)));
  return { results: outcome.runs, outcome, logs };
}

const storedRowSchema = z.object({
  id: z.string(),
  external_id: z.string().nullable(),
  title: z.string(),
  deadline: z.date().nullable(),
  first_seen_at: z.date(),
  updated_at: z.date(),
  fetched_at: z.date(),
  content_hash: z.string(),
});

async function storedRows(schema: TestSchema, sourceId: string) {
  const rows = await schema.db
    .selectFrom("opportunities")
    .select([
      "id",
      "external_id",
      "title",
      "deadline",
      "first_seen_at",
      "updated_at",
      "fetched_at",
      "content_hash",
    ])
    .where("source_id", "=", sourceId)
    .orderBy("external_id")
    .execute();
  return z.array(storedRowSchema).parse(rows);
}

const runRowSchema = z.object({
  source_id: z.string(),
  publication_date: z.string(),
  max_records: z.number(),
  status: z.string(),
  documents: z.number(),
  extracted: z.number(),
  inserted: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  rejected: z.number(),
  incomplete: z.unknown(),
  error_code: z.string().nullable(),
  started_at: z.date(),
  finished_at: z.date(),
});

async function runRows(schema: TestSchema, sourceId: string) {
  const { rows } = await sql`
    SELECT source_id, publication_date::text AS publication_date, max_records, status,
           documents, extracted, inserted, updated, unchanged, rejected, incomplete, error_code,
           started_at, finished_at
    FROM ingestion_runs WHERE source_id = ${sourceId} ORDER BY started_at
  `.execute(schema.db);
  return z.array(runRowSchema).parse(rows);
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error("no item");
  return item;
}

/** Applies only the named migrations, as a database deployed by an earlier release. */
async function migrateOnly(schema: TestSchema, names: readonly string[]): Promise<void> {
  const selected = Object.fromEntries(
    names.map((name) => {
      const migration = migrations[name];
      if (migration === undefined) throw new Error(`migration ${name} missing`);
      return [name, migration];
    }),
  );
  const { rows } = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(schema.db);
  const migrator = new Migrator({
    db: schema.db,
    provider: { getMigrations: () => Promise.resolve(selected) },
    migrationTableSchema: only(rows).name,
  });
  const { error } = await migrator.migrateToLatest();
  expect(error).toBeUndefined();
}

describe.skipIf(skipWithoutDatabase)("runIngestion (PostgreSQL, fake sources)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("two runs on the same data store each notice once; the second run changes nothing", async () => {
    await registerSource(schema, "zrodlo-a");
    const source = fakeSource("zrodlo-a", [
      [fakeNotice(1), fakeNotice(2)],
      [fakeNotice(3), fakeNotice(4, { externalId: null })],
    ]);

    const first = only((await ingest(schema, [source])).results);
    expect(first).toMatchObject({
      sourceId: "zrodlo-a",
      status: "succeeded",
      errorCode: null,
      counters: { documents: 2, extracted: 4, inserted: 4, updated: 0, unchanged: 0, rejected: 0 },
    });
    const before = await storedRows(schema, "zrodlo-a");
    expect(before).toHaveLength(4);

    const second = only((await ingest(schema, [source])).results);
    expect(second.counters).toEqual({
      documents: 2,
      extracted: 4,
      inserted: 0,
      updated: 0,
      unchanged: 4,
      rejected: 0,
      skipped: 0,
    });
    // Unchanged means not written at all: fetched_at/updated_at stay (D-017).
    expect(await storedRows(schema, "zrodlo-a")).toEqual(before);
    expect(await runRows(schema, "zrodlo-a")).toHaveLength(2);
  });

  it("detects a changed deadline or title as updated, keeping id and first_seen_at", async () => {
    await registerSource(schema, "zrodlo-b");
    const source = fakeSource("zrodlo-b", [[fakeNotice(1), fakeNotice(2), fakeNotice(3)]]);
    await ingest(schema, [source]);
    const before = await storedRows(schema, "zrodlo-b");

    source.script = [
      [
        fakeNotice(1, { deadline: "2026-11-27T09:00:00.000Z" }),
        fakeNotice(2, { title: "Dostawa materiałów biurowych (zmiana)" }),
        fakeNotice(3),
      ],
    ];
    const result = only((await ingest(schema, [source])).results);
    expect(result.counters).toMatchObject({ inserted: 0, updated: 2, unchanged: 1, rejected: 0 });

    const after = await storedRows(schema, "zrodlo-b");
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.first_seen_at)).toEqual(before.map((row) => row.first_seen_at));
    const [one, two, three] = after;
    expect(one?.deadline).toEqual(new Date("2026-11-27T09:00:00.000Z"));
    expect(one?.content_hash).not.toBe(before[0]?.content_hash);
    expect(two?.title).toBe("Dostawa materiałów biurowych (zmiana)");
    expect(three).toEqual(before[2]);
  });

  it("stores the procedure id (tender_id); a changed one is detected as updated", async () => {
    await registerSource(schema, "zrodlo-t");
    const tenderId = "ocds-148610-00000000-0000-4000-8000-000000000001";
    const source = fakeSource("zrodlo-t", [[fakeNotice(1, { tenderId }), fakeNotice(2)]]);
    await ingest(schema, [source]);
    const tenderIds = () =>
      schema.db
        .selectFrom("opportunities")
        .select(["external_id", "tender_id"])
        .where("source_id", "=", "zrodlo-t")
        .orderBy("external_id")
        .execute();
    expect(await tenderIds()).toEqual([
      { external_id: "FAKE/0001", tender_id: tenderId },
      { external_id: "FAKE/0002", tender_id: null },
    ]);

    const other = "ocds-148610-00000000-0000-4000-8000-000000000002";
    source.script = [[fakeNotice(1, { tenderId: other }), fakeNotice(2)]];
    const result = only((await ingest(schema, [source])).results);
    expect(result.counters).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect(await tenderIds()).toEqual([
      { external_id: "FAKE/0001", tender_id: other },
      { external_id: "FAKE/0002", tender_id: null },
    ]);
  });

  it("isolates a failing source: the others still run and every run is recorded", async () => {
    await registerSource(schema, "zrodlo-c1");
    await registerSource(schema, "zrodlo-c2");
    const failing = fakeSource("zrodlo-c1", [new HttpClientError("http_status", { status: 503 })]);
    const healthy = fakeSource("zrodlo-c2", [[fakeNotice(1)]]);

    const { results, logs } = await ingest(schema, [failing, healthy]);
    expect(results.map((run) => [run.sourceId, run.status, run.errorCode])).toEqual([
      ["zrodlo-c1", "failed", "http_status"],
      ["zrodlo-c2", "succeeded", null],
    ]);
    expect(results.every((run) => run.runId !== null)).toBe(true);
    expect(only(await runRows(schema, "zrodlo-c1"))).toMatchObject({
      status: "failed",
      error_code: "http_status",
    });
    expect(only(await runRows(schema, "zrodlo-c2"))).toMatchObject({
      status: "succeeded",
      inserted: 1,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "source ingestion failed",
        sourceId: "zrodlo-c1",
        errorCode: "http_status",
        httpStatus: 503,
      }),
    );
  });

  it("stores the run summary and logs one line per source", async () => {
    await registerSource(schema, "zrodlo-e");
    const source = fakeSource("zrodlo-e", [
      [fakeNotice(1), fakeNotice(2, { invalid: true })],
      [fakeNotice(3)],
    ]);
    const { results, logs } = await ingest(schema, [source], { maxRecords: 7 });
    const result = only(results);

    const row = only(await runRows(schema, "zrodlo-e"));
    expect(row).toEqual({
      source_id: "zrodlo-e",
      publication_date: DAY,
      max_records: 7,
      status: "succeeded",
      documents: 2,
      extracted: 3,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      rejected: 1,
      incomplete: [],
      error_code: null,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
    });
    const finished = logs.filter((line) => line.message === "source ingestion finished");
    expect(only(finished)).toMatchObject({
      level: "info",
      sourceId: "zrodlo-e",
      runId: result.runId,
      status: "succeeded",
      documents: 2,
      extracted: 3,
      inserted: 2,
      rejected: 1,
      errorCode: null,
    });
    expect(only(finished)).toHaveProperty("durationMs");
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "source record rejected",
        sourceId: "zrodlo-e",
        externalId: "FAKE/0002",
        reason: "invalid value: title",
      }),
    );
    // Logs carry ids and codes only: no contact data, titles or document bodies.
    const text = JSON.stringify(logs);
    expect(text).not.toContain("kontakt@example.invalid");
    expect(text).not.toContain("Jan Kowalski");
    expect(text).not.toContain("Dostawa materiałów");
  });

  it("rejects a record refused by a domain rule on write and continues with the rest", async () => {
    await registerSource(schema, "zrodlo-f");
    // A row stored earlier under another key for the same notice number (e.g.
    // an older fingerprint scheme): the unique (source_id, external_id) refuses it.
    const legacy: OpportunityDraft = {
      sourceId: "zrodlo-f",
      sourceUrl: "https://zamowienia.example.invalid/ogloszenie/stare",
      externalId: "FAKE/0002",
      tenderId: null,
      issuerName: "Gmina Przykładowa",
      title: "Stary wpis",
      description: null,
      location: null,
      publishedAt: null,
      deadline: null,
      estimatedValue: null,
      currency: null,
      categories: [],
      contact: null,
      fetchedAt: T0,
      fingerprint: "legacy-fingerprint",
      contentHash: "legacy-hash",
      status: "unknown",
    };
    await upsertOpportunity(schema.db, legacy);
    const source = fakeSource("zrodlo-f", [
      [
        fakeNotice(1),
        fakeNotice(2),
        // PostgreSQL text cannot hold NUL: a data exception, i.e. invalid_input.
        fakeNotice(3, { title: "Dostawa\u0000papieru" }),
        fakeNotice(4),
      ],
    ]);

    const { results, logs } = await ingest(schema, [source]);
    expect(only(results)).toMatchObject({
      status: "succeeded",
      counters: { extracted: 4, inserted: 2, rejected: 2 },
    });
    const rejected = logs.filter((line) => line.message === "opportunity rejected");
    expect(rejected).toEqual([
      expect.objectContaining({
        level: "warn",
        sourceId: "zrodlo-f",
        externalId: "FAKE/0002",
        errorCode: "duplicate",
        constraint: "opportunities_source_external_id_key",
      }),
      expect.objectContaining({ externalId: "FAKE/0003", errorCode: "invalid_input" }),
    ]);
    expect((await storedRows(schema, "zrodlo-f")).map((row) => row.external_id)).toEqual([
      "FAKE/0001",
      "FAKE/0002",
      "FAKE/0004",
    ]);
  });

  it("keeps records stored before a fetch error and marks the run failed", async () => {
    await registerSource(schema, "zrodlo-g");
    const source = fakeSource("zrodlo-g", [
      [fakeNotice(1), fakeNotice(2)],
      new HttpClientError("timeout"),
      [fakeNotice(3)],
    ]);
    const result = only((await ingest(schema, [source])).results);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      counters: { documents: 1, extracted: 2, inserted: 2 },
    });
    expect(await storedRows(schema, "zrodlo-g")).toHaveLength(2);
    expect(only(await runRows(schema, "zrodlo-g"))).toMatchObject({
      status: "failed",
      error_code: "timeout",
      inserted: 2,
    });
  });

  it("fails a source on its timeout, keeping what was stored, and runs the next one", async () => {
    await registerSource(schema, "zrodlo-t1");
    await registerSource(schema, "zrodlo-t2");
    const slow = fakeSource("zrodlo-t1", [
      [fakeNotice(1)],
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new HttpClientError("aborted"));
          });
        }),
    ]);
    const next = fakeSource("zrodlo-t2", [[fakeNotice(1)]]);
    const { results } = await ingest(schema, [slow, next], {}, { sourceTimeoutMs: 200 });
    expect(results.map((run) => [run.sourceId, run.status, run.errorCode])).toEqual([
      ["zrodlo-t1", "failed", "source_timeout"],
      ["zrodlo-t2", "succeeded", null],
    ]);
    expect(await storedRows(schema, "zrodlo-t1")).toHaveLength(1);
  });

  it("stops at once when the run is aborted for a lost lock: lock_lost, no further source", async () => {
    await registerSource(schema, "zrodlo-l1");
    await registerSource(schema, "zrodlo-l2");
    const controller = new AbortController();
    const first = fakeSource("zrodlo-l1", [
      [fakeNotice(1)],
      // The lock is lost after the first document, while the second one is
      // being stored: its record is not written.
      () => {
        controller.abort(new IngestLockLostError());
        return Promise.resolve();
      },
      [fakeNotice(2)],
    ]);
    const second = fakeSource("zrodlo-l2", [[fakeNotice(1)]]);
    const { results, logs } = await ingest(
      schema,
      [first, second],
      {},
      { signal: controller.signal },
    );
    expect(results.map((run) => [run.sourceId, run.status, run.errorCode])).toEqual([
      ["zrodlo-l1", "failed", "lock_lost"],
    ]);
    expect(results[0]?.counters).toMatchObject({ documents: 2, extracted: 2, inserted: 1 });
    expect(second.fetches).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "ingestion aborted, sources not run",
        sourceIds: ["zrodlo-l2"],
      }),
    );
    expect(only(await runRows(schema, "zrodlo-l1"))).toMatchObject({
      status: "failed",
      error_code: "lock_lost",
    });
    expect(await runRows(schema, "zrodlo-l2")).toEqual([]);
    expect(await storedRows(schema, "zrodlo-l1")).toHaveLength(1);
  });

  it("fails a source when a document cannot be read (invalid_document)", async () => {
    await registerSource(schema, "zrodlo-d");
    const source = fakeSource("zrodlo-d", [new SourceFormatError("zrodlo-d", "body is not JSON")]);
    const result = only((await ingest(schema, [source])).results);
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_document" });
  });

  it("reports an adapter's incomplete listing as an incomplete run", async () => {
    await registerSource(schema, "zrodlo-i");
    const source = fakeSource("zrodlo-i", [[fakeNotice(1)]]);
    const limited: SourceAdapter = {
      ...source,
      fetch: async (ctx) => {
        await source.fetch(ctx);
        return { documents: [], incomplete: [{ part: "lista", reason: "max_records" }] };
      },
    };
    const result = only((await ingest(schema, [limited])).results);
    expect(result).toMatchObject({
      status: "incomplete",
      errorCode: null,
      incomplete: [{ part: "lista", reason: "max_records" }],
      counters: { inserted: 1 },
    });
    expect(only(await runRows(schema, "zrodlo-i"))).toMatchObject({
      status: "incomplete",
      incomplete: [{ part: "lista", reason: "max_records" }],
    });
  });

  it("also stores documents an adapter returns instead of streaming them", async () => {
    await registerSource(schema, "zrodlo-r");
    const source = fakeSource("zrodlo-r", [[fakeNotice(1), fakeNotice(2)]]);
    const collecting: SourceAdapter = {
      ...source,
      fetch: (ctx) => {
        const { http, signal, publicationDate, maxRecords, now, logger } = ctx;
        return source.fetch({ http, signal, publicationDate, maxRecords, now, logger });
      },
    };
    const result = only((await ingest(schema, [collecting])).results);
    expect(result.counters).toMatchObject({ documents: 1, inserted: 2 });
  });
});

describe.skipIf(skipWithoutDatabase)("runIngestion source selection (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });
  beforeEach(async () => {
    await sql`DELETE FROM ingestion_runs`.execute(schema.db);
  });

  it("runs every enabled source by default; one without an adapter fails as no_adapter", async () => {
    // Seeded by migration 0002 and enabled; this test has no BZP adapter.
    expect(await getSource(schema.db, "bzp")).toMatchObject({ enabled: true });
    await registerSource(schema, "zrodlo-s1");
    await registerSource(schema, "zrodlo-wylaczone", false);
    const enabled = fakeSource("zrodlo-s1", [[fakeNotice(1)]]);
    const disabled = fakeSource("zrodlo-wylaczone", [[fakeNotice(1)]]);

    const { results } = await ingest(schema, [enabled, disabled], { allEnabled: true });
    expect(results.map((run) => [run.sourceId, run.status, run.errorCode])).toEqual([
      ["bzp", "failed", "no_adapter"],
      ["zrodlo-s1", "succeeded", null],
    ]);
    expect(disabled.fetches).toBe(0);
    expect(only(await runRows(schema, "bzp"))).toMatchObject({
      status: "failed",
      error_code: "no_adapter",
      documents: 0,
    });
  });

  it("refuses an explicit source that is disabled or unknown, before fetching anything", async () => {
    await registerSource(schema, "zrodlo-s2");
    await registerSource(schema, "zrodlo-off", false);
    const ok = fakeSource("zrodlo-s2", [[fakeNotice(1)]]);
    const off = fakeSource("zrodlo-off", [[fakeNotice(1)]]);
    const deps = (adapters: readonly SourceAdapter[]): IngestionDeps => ({
      db: schema.db,
      adapters: new Map(adapters.map((adapter) => [adapter.sourceId, adapter])),
      createHttpClient: () => noHttp,
      now: () => T0,
      logger: createLogger("error", () => undefined),
      sourceTimeoutMs: 60_000,
    });
    const request = (sourceIds: string[]): IngestionRequest => ({
      sourceIds,
      days: { mode: "range", from: DAY, to: DAY },
      maxRecords: 10,
    });

    await expect(
      runIngestion(deps([ok, off]), request(["zrodlo-s2", "zrodlo-off"])),
    ).rejects.toThrow(
      new IngestionRequestError('Source not enabled in the database: "zrodlo-off"'),
    );
    // Enabled in the database, but this build has no adapter for it.
    await expect(runIngestion(deps([ok]), request(["zrodlo-s2", "bzp"]))).rejects.toThrow(
      new IngestionRequestError('Unknown source: "bzp"'),
    );
    expect(ok.fetches).toBe(0);
    expect(off.fetches).toBe(0);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM ingestion_runs`.execute(schema.db);
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses an invalid date or limit", async () => {
    const source = fakeSource("zrodlo-s2", []);
    await expect(
      ingest(schema, [source], { days: { mode: "range", from: "2026-02-30", to: "2026-02-30" } }),
    ).rejects.toThrow(IngestionRequestError);
    await expect(ingest(schema, [source], { maxRecords: 0 })).rejects.toThrow(
      IngestionRequestError,
    );
    expect(source.fetches).toBe(0);
  });
});

describe.skipIf(skipWithoutDatabase)("runIngestion with pending migrations (PostgreSQL)", () => {
  // Before 0002 there is no ingestion_runs table; before 0003 no tender_id
  // column, so every write would fail. Both must be refused up front.
  it.each([[["0001_core_schema"]], [["0001_core_schema", "0002_ingestion_runs"]]])(
    "fails clearly before fetching anything with only %j applied (ingest never migrates by itself)",
    async (applied) => {
      const schema = await createTestSchema();
      try {
        await migrateOnly(schema, applied);
        await registerSource(schema, "zrodlo-m");
        const source = fakeSource("zrodlo-m", [[fakeNotice(1)]]);
        await expect(ingest(schema, [source])).rejects.toThrow(SchemaNotReadyError);
        expect(source.fetches).toBe(0);
        const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(
          schema.db,
        );
        expect(rows.map((row) => row.name).sort()).toEqual(applied);
      } finally {
        await schema.close();
      }
    },
  );
});

describe.skipIf(skipWithoutDatabase)("ingestOpportunity (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    await registerSource(schema, "repo-a");
    await registerSource(schema, "repo-b");
  });
  afterAll(async () => {
    await schema.close();
  });

  function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
    const base = {
      sourceId: "repo-a",
      sourceUrl: "https://zamowienia.example.invalid/ogloszenie/1",
      externalId: "REPO/1",
    };
    return {
      ...base,
      tenderId: null,
      issuerName: "Gmina Przykładowa",
      title: "Koszenie trawy",
      description: null,
      location: null,
      publishedAt: null,
      deadline: null,
      estimatedValue: null,
      currency: null,
      categories: [],
      contact: null,
      fetchedAt: T0,
      fingerprint: fingerprint(base),
      contentHash: "hash-1",
      status: "unknown",
      ...overrides,
    };
  }

  it("inserts, then reports the same content as unchanged without writing", async () => {
    const inserted = await ingestOpportunity(schema.db, draft());
    expect(inserted.outcome).toBe("inserted");
    const before = await schema.db.selectFrom("opportunities").selectAll().executeTakeFirst();

    const again = await ingestOpportunity(
      schema.db,
      draft({ fetchedAt: new Date(T0.getTime() + 86_400_000) }),
    );
    expect(again).toEqual({ outcome: "unchanged", id: inserted.id });
    const after = await schema.db.selectFrom("opportunities").selectAll().executeTakeFirst();
    expect(after).toEqual(before);
  });

  it("updates when the content hash differs, keeping id and first_seen_at", async () => {
    const before = await schema.db.selectFrom("opportunities").selectAll().executeTakeFirst();
    const later = new Date(T0.getTime() + 2 * 86_400_000);
    const updated = await ingestOpportunity(
      schema.db,
      draft({ title: "Koszenie trawy i żywopłotu", contentHash: "hash-2", fetchedAt: later }),
    );
    expect(updated).toEqual({ outcome: "updated", id: before?.id });
    const after = await schema.db.selectFrom("opportunities").selectAll().executeTakeFirst();
    expect(after).toMatchObject({
      id: before?.id,
      first_seen_at: before?.first_seen_at,
      title: "Koszenie trawy i żywopłotu",
      content_hash: "hash-2",
      fetched_at: later,
    });
  });

  it("refuses a fingerprint stored for another source as a duplicate", async () => {
    const error: unknown = await ingestOpportunity(
      schema.db,
      draft({ sourceId: "repo-b", contentHash: "hash-3" }),
    ).catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "duplicate",
      constraint: "opportunities_fingerprint_key",
    });
    // The same content from another source is refused too, not reported unchanged.
    const sameContent: unknown = await ingestOpportunity(
      schema.db,
      draft({ sourceId: "repo-b", contentHash: "hash-2" }),
    ).catch((rejection: unknown) => rejection);
    expect(sameContent).toMatchObject({ code: "duplicate" });
  });

  /*
   * Concurrent writes of one fingerprint (AC3, the unique-constraint half):
   * Promise.all runs both statements on separate pooled connections, so the
   * second INSERT waits for the first to commit and then takes the conflict
   * path. Several keys make an actual overlap very likely in every run.
   */
  async function concurrentPairs(hashes: readonly [string, string]) {
    const pairs = [];
    for (let i = 1; i <= 8; i++) {
      const key = { sourceUrl: `https://zamowienia.example.invalid/rownolegle/${String(i)}` };
      const base = { sourceId: "repo-a", ...key, externalId: `PAR/${hashes[1]}/${String(i)}` };
      const fp = fingerprint(base);
      const results = await Promise.all(
        hashes.map((hash) =>
          ingestOpportunity(schema.db, draft({ ...base, fingerprint: fp, contentHash: hash })),
        ),
      );
      const rows = await schema.db
        .selectFrom("opportunities")
        .select(["id", "content_hash"])
        .where("fingerprint", "=", fp)
        .execute();
      pairs.push({ results, rows });
    }
    return pairs;
  }

  it("stores one row when the same draft is written concurrently: inserted + unchanged", async () => {
    for (const { results, rows } of await concurrentPairs(["hash-same", "hash-same"])) {
      expect(rows).toHaveLength(1);
      expect(results.map((result) => result.outcome).sort()).toEqual(["inserted", "unchanged"]);
      expect(results.map((result) => result.id)).toEqual([rows[0]?.id, rows[0]?.id]);
    }
  });

  it("stores one row when two versions are written concurrently: inserted + updated", async () => {
    for (const { results, rows } of await concurrentPairs(["hash-a", "hash-b"])) {
      expect(rows).toHaveLength(1);
      const outcomes = results.map((result) => result.outcome);
      expect([...outcomes].sort()).toEqual(["inserted", "updated"]);
      expect(results.map((result) => result.id)).toEqual([rows[0]?.id, rows[0]?.id]);
      // The row holds the version written last, i.e. the one reported as updated.
      expect(rows[0]?.content_hash).toBe(outcomes[0] === "updated" ? "hash-a" : "hash-b");
    }
  });

  /*
   * Deterministic check of the retry in ingestOpportunity. The race it handles
   * (the (source_id, external_id) index reporting the conflict instead of the
   * fingerprint arbiter) cannot be forced with an open transaction: the arbiter
   * precheck waits for it and then takes the conflict path. So a test-only
   * BEFORE INSERT trigger raises that exact error once — on the first attempt
   * only (a sequence is not rolled back with the failed statement).
   */
  it("retries once when the write fails on opportunities_source_external_id_key", async () => {
    const base = {
      sourceId: "repo-a",
      sourceUrl: "https://zamowienia.example.invalid/ponowienie/1",
      externalId: "RETRY/1",
    };
    const retryDraft = (contentHash: string) =>
      draft({ ...base, fingerprint: fingerprint(base), contentHash });
    const first = await ingestOpportunity(schema.db, retryDraft("hash-r1"));
    expect(first.outcome).toBe("inserted");

    await sql`CREATE SEQUENCE retry_probe`.execute(schema.db);
    await sql`
      CREATE FUNCTION retry_probe_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('retry_probe') = 1 THEN
          RAISE EXCEPTION 'simulated concurrent insert' USING
            ERRCODE = 'unique_violation', CONSTRAINT = 'opportunities_source_external_id_key';
        END IF;
        RETURN NEW;
      END $$`.execute(schema.db);
    await sql`
      CREATE TRIGGER retry_probe BEFORE INSERT ON opportunities
      FOR EACH ROW WHEN (NEW.external_id = 'RETRY/1') EXECUTE FUNCTION retry_probe_fail_once()`.execute(
      schema.db,
    );
    try {
      const second = await ingestOpportunity(schema.db, retryDraft("hash-r2"));
      expect(second).toEqual({ outcome: "updated", id: first.id });
      // Two attempts: the first failed in the trigger, the retry went through.
      const probe = await sql<{
        last_value: string;
      }>`SELECT last_value::text AS last_value FROM retry_probe`.execute(schema.db);
      expect(probe.rows[0]?.last_value).toBe("2");
      const rows = await schema.db
        .selectFrom("opportunities")
        .select(["id", "content_hash"])
        .where("fingerprint", "=", fingerprint(base))
        .execute();
      expect(rows).toEqual([{ id: first.id, content_hash: "hash-r2" }]);
    } finally {
      await sql`DROP TRIGGER retry_probe ON opportunities`.execute(schema.db);
      await sql`DROP FUNCTION retry_probe_fail_once()`.execute(schema.db);
      await sql`DROP SEQUENCE retry_probe`.execute(schema.db);
    }
  });

  it("validates the draft (invalid_input) and the source (unknown_reference)", async () => {
    await expect(ingestOpportunity(schema.db, draft({ title: " " }))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      ingestOpportunity(
        schema.db,
        draft({ sourceId: "brak-zrodla", fingerprint: "fp-x", externalId: "X" }),
      ),
    ).rejects.toMatchObject({ code: "unknown_reference" });
  });
});

describe.skipIf(skipWithoutDatabase)("recordIngestionRun and migration 0002 (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  function summary(overrides: Partial<IngestionRunSummary> = {}): IngestionRunSummary {
    return {
      sourceId: "bzp",
      publicationDate: DAY,
      maxRecords: 1000,
      status: "succeeded",
      startedAt: T0,
      finishedAt: new Date(T0.getTime() + 5000),
      counters: {
        documents: 2,
        extracted: 30,
        inserted: 28,
        updated: 1,
        unchanged: 0,
        rejected: 1,
        skipped: 0,
      },
      incomplete: [],
      errorCode: null,
      ...overrides,
    };
  }

  it("seeds bzp without overwriting an existing row, and is idempotent", async () => {
    // Bring the schema to 0001 only, as a database deployed before PR-03.
    await migrateOnly(schema, ["0001_core_schema"]);
    await upsertSource(schema.db, {
      id: "bzp",
      name: "BZP (wyłączone przez operatora)",
      baseUrl: "https://ezamowienia.gov.pl/inny/",
      enabled: false,
    });

    expect(await migrateToLatest(schema.db)).toEqual([
      "0002_ingestion_runs",
      "0003_opportunities_tender_id",
      "0004_notice_updates",
    ]);
    expect(await getSource(schema.db, "bzp")).toMatchObject({
      name: "BZP (wyłączone przez operatora)",
      baseUrl: "https://ezamowienia.gov.pl/inny/",
      enabled: false,
    });
    expect(await migrateToLatest(schema.db)).toEqual([]);
  });

  it("creates the named constraints and the index", async () => {
    const { rows } = await sql<{ name: string }>`
      SELECT conname AS name FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace
      UNION
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
    `.execute(schema.db);
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "ingestion_runs_pkey",
        "ingestion_runs_source_id_fkey",
        "ingestion_runs_max_records_check",
        "ingestion_runs_finished_at_check",
        "ingestion_runs_status_check",
        "ingestion_runs_counters_check",
        "ingestion_runs_incomplete_check",
        "ingestion_runs_error_code_check",
        "ingestion_runs_error_code_status_check",
        "ingestion_runs_source_started_idx",
      ]),
    );
  });

  it("stores a summary row", async () => {
    const id = await recordIngestionRun(
      schema.db,
      summary({
        status: "failed",
        errorCode: "http_status",
        incomplete: [{ part: "ContractNotice", reason: "max_pages" }],
      }),
    );
    const row = await schema.db
      .selectFrom("ingestion_runs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source_id: "bzp",
      max_records: 1000,
      status: "failed",
      inserted: 28,
      updated: 1,
      rejected: 1,
      incomplete: [{ part: "ContractNotice", reason: "max_pages" }],
      error_code: "http_status",
      started_at: T0,
    });
  });

  it.each([
    ["an unknown status", { status: "partial" as never }],
    ["a negative counter", { counters: { ...summary().counters, inserted: -1 } }],
    ["finishedAt before startedAt", { finishedAt: new Date(T0.getTime() - 1) }],
    ["an error message instead of a code", { status: "failed" as const, errorCode: "HTTP 503!" }],
    ["an error code on a successful run", { errorCode: "http_status" }],
    ["a failed run without a code", { status: "failed" as const }],
    ["an impossible date", { publicationDate: "2026-02-30" }],
    ["a zero limit", { maxRecords: 0 }],
  ])("refuses %s as invalid_input", async (_case, overrides) => {
    await expect(recordIngestionRun(schema.db, summary(overrides))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses an unregistered source as unknown_reference", async () => {
    await expect(
      recordIngestionRun(schema.db, summary({ sourceId: "brak-zrodla" })),
    ).rejects.toMatchObject({
      code: "unknown_reference",
      constraint: "ingestion_runs_source_id_fkey",
    });
  });

  it.each([
    ["ingestion_runs_status_check", { status: "partial" }],
    ["ingestion_runs_max_records_check", { max_records: 0 }],
    ["ingestion_runs_counters_check", { unchanged: -1 }],
    ["ingestion_runs_finished_at_check", { finished_at: new Date(T0.getTime() - 1) }],
    ["ingestion_runs_incomplete_check", { incomplete: JSON.stringify({ part: "x" }) }],
    [
      "ingestion_runs_error_code_check",
      { status: "failed", error_code: "Connection refused at 10.0.0.1" },
    ],
    ["ingestion_runs_error_code_status_check", { error_code: "http_status" }],
    ["ingestion_runs_error_code_status_check", { status: "failed" }],
  ])("the database itself enforces %s", async (constraint, overrides) => {
    const values = {
      source_id: "bzp",
      publication_date: DAY,
      max_records: 10,
      started_at: T0,
      finished_at: T0,
      status: "succeeded",
      documents: 0,
      extracted: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      incomplete: "[]",
      error_code: null,
      ...overrides,
    };
    await expect(
      sql`
        INSERT INTO ingestion_runs (source_id, publication_date, max_records, started_at,
          finished_at, status, documents, extracted, inserted, updated, unchanged, rejected,
          incomplete, error_code)
        VALUES (${values.source_id}, ${values.publication_date}, ${values.max_records},
          ${values.started_at}, ${values.finished_at}, ${values.status}, ${values.documents},
          ${values.extracted}, ${values.inserted}, ${values.updated}, ${values.unchanged},
          ${values.rejected}, ${values.incomplete}::jsonb, ${values.error_code})
      `.execute(schema.db),
    ).rejects.toMatchObject({ code: "23514", constraint });
  });
});
