import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import {
  lastCoveredDay,
  recordIngestionRun,
} from "../../src/infrastructure/db/ingestion-runs-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { HttpClientError } from "../../src/infrastructure/http/errors.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import {
  IngestionRequestError,
  runIngestion,
  type IngestionDays,
  type IngestionDeps,
} from "../../src/ingestion/run.js";
import type { IncompleteFetch, SourceAdapter, SourceHttpClient } from "../../src/sources/types.js";
import { fakeNotice, fakeSource } from "./fake-source.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/**
 * Which days `ingest` runs (D-021): automatic catch-up since the last covered
 * day, explicit ranges, and stopping a source at its first failed day. Each
 * test uses its own sources, so the recorded runs never interfere.
 */

const noHttp: SourceHttpClient = {
  get: () => Promise.reject(new Error("fake sources never use HTTP")),
};

const logLineSchema = z.looseObject({ level: z.string(), message: z.string() });

interface DaySource {
  readonly adapter: SourceAdapter;
  /** Publication days fetched, in order. */
  readonly days: string[];
}

/**
 * A fake source that records the day of every fetch; `failOn` days fail with
 * an HTTP error, `incompleteOn` days hit the record limit.
 */
function daySource(
  sourceId: string,
  options: { failOn?: readonly string[]; incompleteOn?: readonly string[] } = {},
): DaySource {
  const days: string[] = [];
  const base = fakeSource(sourceId, [[fakeNotice(1)]]);
  const adapter: typeof base = {
    ...base,
    async fetch(ctx) {
      days.push(ctx.publicationDate);
      if (options.failOn?.includes(ctx.publicationDate) === true) {
        throw new HttpClientError("http_status", {
          host: "zamowienia.example.invalid",
          status: 503,
        });
      }
      const result = await base.fetch(ctx);
      const incomplete: IncompleteFetch[] =
        options.incompleteOn?.includes(ctx.publicationDate) === true
          ? [{ part: "lista", reason: "max_records" }]
          : [];
      return { ...result, incomplete };
    },
  };
  return { adapter, days };
}

async function register(schema: TestSchema, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await upsertSource(schema.db, {
      id,
      name: `Źródło ${id}`,
      baseUrl: "https://zamowienia.example.invalid/",
      enabled: true,
    });
  }
}

async function ingest(
  schema: TestSchema,
  sources: readonly DaySource[],
  now: string,
  days: IngestionDays = { mode: "catch_up" },
) {
  const lines: string[] = [];
  const deps: IngestionDeps = {
    db: schema.db,
    adapters: new Map(sources.map(({ adapter }) => [adapter.sourceId, adapter])),
    createHttpClient: () => noHttp,
    now: () => new Date(now),
    logger: createLogger("debug", (line) => lines.push(line)),
    sourceTimeoutMs: 60_000,
  };
  const outcome = await runIngestion(deps, {
    sourceIds: sources.map(({ adapter }) => adapter.sourceId),
    days,
    maxRecords: 100,
  });
  const logs = lines.map((line) => logLineSchema.parse(JSON.parse(line)));
  return { outcome, logs };
}

describe.skipIf(skipWithoutDatabase)("ingest days and catch-up (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("runs yesterday for a new source, then only the days missed since", async () => {
    await register(schema, "cu-a");
    const source = daySource("cu-a");

    const first = await ingest(schema, [source], "2026-10-30T05:00:00.000Z");
    expect(source.days).toEqual(["2026-10-29"]);
    expect(first.outcome).toMatchObject({
      from: "2026-10-29",
      to: "2026-10-29",
      notRun: [],
      clipped: [],
    });
    expect(first.outcome.runs.map((run) => [run.publicationDate, run.status])).toEqual([
      ["2026-10-29", "succeeded"],
    ]);
    expect(await lastCoveredDay(schema.db, "cu-a")).toBe("2026-10-29");

    // Three cron runs missed.
    await ingest(schema, [source], "2026-11-02T05:00:00.000Z");
    expect(source.days).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);

    // Nothing missing: nothing fetched, nothing recorded.
    const idle = await ingest(schema, [source], "2026-11-02T23:00:00.000Z");
    expect(source.days).toHaveLength(4);
    expect(idle.outcome).toEqual({ runs: [], notRun: [], clipped: [], from: null, to: null });
    expect(idle.logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "nothing to catch up",
        sourceId: "cu-a",
        lastCovered: "2026-11-01",
      }),
    );
  });

  it("stops a source at its first failed day and retries from it next time", async () => {
    await register(schema, "cu-b", "cu-c");
    const failing = daySource("cu-b", { failOn: ["2026-10-28"] });
    const healthy = daySource("cu-c");
    for (const id of ["cu-b", "cu-c"]) {
      await recordIngestionRun(schema.db, {
        sourceId: id,
        publicationDate: "2026-10-26",
        maxRecords: 100,
        status: "succeeded",
        startedAt: new Date("2026-10-27T05:00:00.000Z"),
        finishedAt: new Date("2026-10-27T05:01:00.000Z"),
        counters: {
          documents: 0,
          extracted: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          rejected: 0,
          skipped: 0,
        },
        incomplete: [],
        errorCode: null,
      });
    }

    const { outcome, logs } = await ingest(schema, [failing, healthy], "2026-10-30T05:00:00.000Z");
    expect(failing.days).toEqual(["2026-10-27", "2026-10-28"]);
    expect(healthy.days).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(outcome.runs.map((run) => [run.sourceId, run.publicationDate, run.status])).toEqual([
      ["cu-b", "2026-10-27", "succeeded"],
      ["cu-b", "2026-10-28", "failed"],
      ["cu-c", "2026-10-27", "succeeded"],
      ["cu-c", "2026-10-28", "succeeded"],
      ["cu-c", "2026-10-29", "succeeded"],
    ]);
    expect(outcome.notRun).toEqual([
      { sourceId: "cu-b", publicationDate: "2026-10-29", reason: "previous_day_failed" },
    ]);
    expect(outcome).toMatchObject({ from: "2026-10-27", to: "2026-10-29" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "days not run after a failed day",
        sourceIds: ["cu-b"],
        days: 1,
      }),
    );
    // A failed run never counts as covered.
    expect(await lastCoveredDay(schema.db, "cu-b")).toBe("2026-10-27");

    const retry = daySource("cu-b");
    await ingest(schema, [retry], "2026-10-30T06:00:00.000Z");
    expect(retry.days).toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("counts an incomplete day as covered, but not a day run before it ended", async () => {
    await register(schema, "cu-d");
    const source = daySource("cu-d", { incompleteOn: ["2026-10-29"] });
    const first = await ingest(schema, [source], "2026-10-30T05:00:00.000Z");
    expect(first.outcome.runs.map((run) => run.status)).toEqual(["incomplete"]);

    // An explicit run of today, while it is still being published.
    await ingest(schema, [source], "2026-10-30T12:00:00.000Z", {
      mode: "range",
      from: "2026-10-30",
      to: "2026-10-30",
    });
    expect(await lastCoveredDay(schema.db, "cu-d")).toBe("2026-10-29");

    await ingest(schema, [source], "2026-10-31T05:00:00.000Z");
    expect(source.days).toEqual(["2026-10-29", "2026-10-30", "2026-10-30"]);
    expect(await lastCoveredDay(schema.db, "cu-d")).toBe("2026-10-30");
  });

  it("clips a long gap to the newest 31 days and reports the older ones", async () => {
    await register(schema, "cu-e", "cu-f");
    await recordIngestionRun(schema.db, {
      sourceId: "cu-e",
      publicationDate: "2026-09-01",
      maxRecords: 100,
      status: "succeeded",
      startedAt: new Date("2026-09-02T05:00:00.000Z"),
      finishedAt: new Date("2026-09-02T05:01:00.000Z"),
      counters: {
        documents: 0,
        extracted: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        skipped: 0,
      },
      incomplete: [],
      errorCode: null,
    });
    const gap = daySource("cu-e");
    const fresh = daySource("cu-f");
    const { outcome, logs } = await ingest(schema, [gap, fresh], "2026-10-30T05:00:00.000Z");
    expect(gap.days).toHaveLength(31);
    expect(gap.days[0]).toBe("2026-09-29");
    expect(gap.days.at(-1)).toBe("2026-10-29");
    expect(fresh.days).toEqual(["2026-10-29"]);
    expect(outcome.clipped).toEqual([{ sourceId: "cu-e", from: "2026-09-02", to: "2026-09-28" }]);
    expect(outcome).toMatchObject({ from: "2026-09-29", to: "2026-10-29" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "catch-up clipped, older missing days not run",
        sourceId: "cu-e",
        from: "2026-09-02",
        to: "2026-09-28",
      }),
    );
  });

  it("runs an explicit range day by day, whatever was covered before", async () => {
    await register(schema, "cu-g");
    const source = daySource("cu-g");
    await ingest(schema, [source], "2026-10-30T05:00:00.000Z");
    const { outcome } = await ingest(schema, [source], "2026-10-30T06:00:00.000Z", {
      mode: "range",
      from: "2026-10-27",
      to: "2026-10-29",
    });
    expect(source.days).toEqual(["2026-10-29", "2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(outcome).toMatchObject({ from: "2026-10-27", to: "2026-10-29", notRun: [] });
    expect(outcome.runs.map((run) => [run.publicationDate, run.status])).toEqual([
      ["2026-10-27", "succeeded"],
      ["2026-10-28", "succeeded"],
      ["2026-10-29", "succeeded"],
    ]);
    // The fake serves the same notice every day: stored once, then unchanged.
    expect(outcome.runs.map((run) => run.counters.unchanged)).toEqual([1, 1, 1]);
  });

  it.each([
    [{ mode: "range", from: "2026-10-29", to: "2026-10-28" }, "from must not be after to"],
    [{ mode: "range", from: "2026-09-28", to: "2026-10-29" }, "a range covers at most 31 days"],
    [{ mode: "range", from: "2026-02-29", to: "2026-03-01" }, "calendar dates"],
    // Outside 2000–2999, including the last days before year 10000 (never listed).
    [{ mode: "range", from: "9999-12-31", to: "9999-12-31" }, "from 2000-01-01 to 2999-12-31"],
    [{ mode: "range", from: "9999-12-01", to: "9999-12-31" }, "from 2000-01-01 to 2999-12-31"],
    [{ mode: "range", from: "1999-12-31", to: "2000-01-01" }, "from 2000-01-01 to 2999-12-31"],
    // A huge range is counted, not built, so it is refused at once.
    [{ mode: "range", from: "2000-01-01", to: "2999-12-31" }, "a range covers at most 31 days"],
  ] as const)("refuses the range %o before fetching anything", async (days, message) => {
    await register(schema, "cu-h");
    const source = daySource("cu-h");
    await expect(ingest(schema, [source], "2026-10-30T05:00:00.000Z", days)).rejects.toThrow(
      IngestionRequestError,
    );
    await expect(ingest(schema, [source], "2026-10-30T05:00:00.000Z", days)).rejects.toThrow(
      message,
    );
    expect(source.days).toEqual([]);
  });

  it("accepts a range of exactly 31 days", async () => {
    await register(schema, "cu-i");
    const source = daySource("cu-i");
    const { outcome } = await ingest(schema, [source], "2026-10-30T05:00:00.000Z", {
      mode: "range",
      from: "2026-09-29",
      to: "2026-10-29",
    });
    expect(outcome.runs).toHaveLength(31);
  });

  it("marks the remaining days as not run when the run is aborted", async () => {
    await register(schema, "cu-j");
    const controller = new AbortController();
    const source = daySource("cu-j");
    const aborting: DaySource = {
      days: source.days,
      adapter: {
        ...source.adapter,
        async fetch(ctx) {
          const result = await source.adapter.fetch(ctx);
          controller.abort();
          return result;
        },
      },
    };
    const lines: string[] = [];
    const outcome = await runIngestion(
      {
        db: schema.db,
        adapters: new Map([["cu-j", aborting.adapter]]),
        createHttpClient: () => noHttp,
        now: () => new Date("2026-10-30T05:00:00.000Z"),
        logger: createLogger("debug", (line) => lines.push(line)),
        sourceTimeoutMs: 60_000,
        signal: controller.signal,
      },
      {
        sourceIds: ["cu-j"],
        days: { mode: "range", from: "2026-10-27", to: "2026-10-29" },
        maxRecords: 100,
      },
    );
    expect(source.days).toEqual(["2026-10-27"]);
    expect(outcome.notRun).toEqual([
      { sourceId: "cu-j", publicationDate: "2026-10-28", reason: "aborted" },
      { sourceId: "cu-j", publicationDate: "2026-10-29", reason: "aborted" },
    ]);
  });
});
