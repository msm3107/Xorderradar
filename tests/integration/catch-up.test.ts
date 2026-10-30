import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import {
  catchUpHistory,
  recordIngestionRun,
} from "../../src/infrastructure/db/ingestion-runs-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { HttpClientError } from "../../src/infrastructure/http/errors.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { INGEST_MAX_CONSECUTIVE_FAILED_DAYS } from "../../src/ingestion/catch-up.js";
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
 * Which days `ingest` runs (D-021): automatic catch-up of the uncovered days
 * of the last 31, explicit ranges, and stopping a source after consecutive
 * failed days. Each test uses its own sources, so the recorded runs never
 * interfere.
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

/** The latest day `sourceId` has covered, or null. */
async function latestCovered(schema: TestSchema, sourceId: string): Promise<string | null> {
  const history = await catchUpHistory(schema.db, sourceId, {
    from: "2026-09-29",
    to: "2026-10-29",
  });
  return history.latestCovered;
}

/** Records a run of `sourceId` for `day`, started at `startedAt`, as `ingest` would. */
async function seedRun(
  schema: TestSchema,
  sourceId: string,
  day: string,
  status: "succeeded" | "failed",
  startedAt: string,
): Promise<void> {
  await recordIngestionRun(schema.db, {
    sourceId,
    publicationDate: day,
    maxRecords: 100,
    status,
    startedAt: new Date(startedAt),
    finishedAt: new Date(startedAt),
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
    errorCode: status === "failed" ? "http_status" : null,
  });
}

/** `count` consecutive days from `first`. */
function daysOf(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${first}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );
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
    expect(await latestCovered(schema, "cu-a")).toBe("2026-10-29");

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

  it("runs the days after a failed day and retries the failed day on the next run", async () => {
    await register(schema, "cu-b", "cu-c");
    // 10-28 always fails at the source.
    const failing = daySource("cu-b", { failOn: ["2026-10-28"] });
    const healthy = daySource("cu-c");
    for (const id of ["cu-b", "cu-c"]) {
      await seedRun(schema, id, "2026-10-26", "succeeded", "2026-10-27T05:00:00.000Z");
    }

    const { outcome, logs } = await ingest(schema, [failing, healthy], "2026-10-30T05:00:00.000Z");
    expect(failing.days).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(healthy.days).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(outcome.runs.map((run) => [run.sourceId, run.publicationDate, run.status])).toEqual([
      ["cu-b", "2026-10-27", "succeeded"],
      ["cu-b", "2026-10-28", "failed"],
      ["cu-b", "2026-10-29", "succeeded"],
      ["cu-c", "2026-10-27", "succeeded"],
      ["cu-c", "2026-10-28", "succeeded"],
      ["cu-c", "2026-10-29", "succeeded"],
    ]);
    expect(outcome.notRun).toEqual([]);
    expect(outcome).toMatchObject({ from: "2026-10-27", to: "2026-10-29" });
    expect(logs.map((line) => line.message)).not.toContain(
      "days not run after consecutive failed days",
    );
    // A failed run never covers its day; the later day is covered all the same.
    expect(await latestCovered(schema, "cu-b")).toBe("2026-10-29");

    // Next day: the failed day is retried (it still fails), the new day runs anyway.
    const again = await ingest(schema, [failing], "2026-10-31T05:00:00.000Z");
    expect(failing.days.slice(3)).toEqual(["2026-10-28", "2026-10-30"]);
    expect(again.outcome.runs.map((run) => [run.publicationDate, run.status])).toEqual([
      ["2026-10-28", "failed"],
      ["2026-10-30", "succeeded"],
    ]);
    expect(again.outcome.notRun).toEqual([]);

    // Once the source serves the day, it is covered and not run again.
    const retry = daySource("cu-b");
    await ingest(schema, [retry], "2026-10-31T06:00:00.000Z");
    expect(retry.days).toEqual(["2026-10-28"]);
    await ingest(schema, [retry], "2026-10-31T07:00:00.000Z");
    expect(retry.days).toEqual(["2026-10-28"]);
  });

  it("stops a source after consecutive failed days, a success resets the count", async () => {
    expect(INGEST_MAX_CONSECUTIVE_FAILED_DAYS).toBe(2);
    await register(schema, "cu-k", "cu-l");
    const failing = daySource("cu-k", { failOn: ["2026-10-21", "2026-10-23", "2026-10-24"] });
    const healthy = daySource("cu-l");
    const { outcome, logs } = await ingest(schema, [failing, healthy], "2026-10-30T05:00:00.000Z", {
      mode: "range",
      from: "2026-10-20",
      to: "2026-10-27",
    });
    // 10-22 succeeds between two failures, so 10-23 runs; 10-23 and 10-24 fail in a row.
    expect(failing.days).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
    ]);
    expect(healthy.days).toEqual(daysOf("2026-10-20", 8));
    expect(outcome.runs.filter((run) => run.sourceId === "cu-k").map((run) => run.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
      "failed",
      "failed",
    ]);
    expect(outcome.notRun).toEqual([
      { sourceId: "cu-k", publicationDate: "2026-10-25", reason: "consecutive_failures" },
      { sourceId: "cu-k", publicationDate: "2026-10-26", reason: "consecutive_failures" },
      { sourceId: "cu-k", publicationDate: "2026-10-27", reason: "consecutive_failures" },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "days not run after consecutive failed days",
        sourceIds: ["cu-k"],
        days: 3,
        maxConsecutiveFailedDays: 2,
      }),
    );

    // The failed and not-run days stay uncovered: the next catch-up plans them
    // (from the earliest run of the source on), with yesterday's days.
    const recovered = daySource("cu-k");
    const next = await ingest(schema, [recovered], "2026-10-30T06:00:00.000Z");
    expect(recovered.days).toEqual([
      "2026-10-21",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
    expect(next.outcome.notRun).toEqual([]);
  });

  it("does not let days that keep failing block the newer days", async () => {
    await register(schema, "cu-q");
    // 10-20 and 10-21 failed before and still fail; the days up to 10-28 are covered.
    const failing = daySource("cu-q", { failOn: ["2026-10-20", "2026-10-21"] });
    await seedRun(schema, "cu-q", "2026-10-20", "failed", "2026-10-21T05:00:00.000Z");
    await seedRun(schema, "cu-q", "2026-10-21", "failed", "2026-10-22T05:00:00.000Z");
    for (const day of daysOf("2026-10-22", 7)) {
      await seedRun(schema, "cu-q", day, "succeeded", "2026-10-29T05:00:00.000Z");
    }

    const { outcome, logs } = await ingest(schema, [failing], "2026-10-30T05:00:00.000Z");
    expect(failing.days).toEqual(["2026-10-20", "2026-10-21", "2026-10-29"]);
    expect(outcome.runs.map((run) => [run.publicationDate, run.status])).toEqual([
      ["2026-10-20", "failed"],
      ["2026-10-21", "failed"],
      ["2026-10-29", "succeeded"],
    ]);
    expect(outcome.notRun).toEqual([]);
    expect(logs.map((line) => line.message)).not.toContain(
      "days not run after consecutive failed days",
    );
    expect(await latestCovered(schema, "cu-q")).toBe("2026-10-29");
  });

  it("stops after two failed first attempts, a failed retry between them neither counts nor resets", async () => {
    await register(schema, "cu-r");
    // An outage: every day fails. 10-27 was attempted before, 10-26 and 10-28 never.
    const down = daySource("cu-r", { failOn: daysOf("2026-10-20", 10) });
    for (const day of daysOf("2026-10-20", 6)) {
      await seedRun(schema, "cu-r", day, "succeeded", "2026-10-26T05:00:00.000Z");
    }
    await seedRun(schema, "cu-r", "2026-10-27", "failed", "2026-10-28T05:00:00.000Z");

    const { outcome, logs } = await ingest(schema, [down], "2026-10-30T05:00:00.000Z");
    expect(down.days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"]);
    expect(outcome.runs.map((run) => run.status)).toEqual(["failed", "failed", "failed"]);
    expect(outcome.notRun).toEqual([
      { sourceId: "cu-r", publicationDate: "2026-10-29", reason: "consecutive_failures" },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "days not run after consecutive failed days",
        sourceIds: ["cu-r"],
        days: 1,
      }),
    );
  });

  it("does not count a failed retry in an explicit range either", async () => {
    await register(schema, "cu-s");
    const failing = daySource("cu-s", { failOn: ["2026-10-20", "2026-10-21"] });
    await seedRun(schema, "cu-s", "2026-10-20", "failed", "2026-10-21T05:00:00.000Z");
    await seedRun(schema, "cu-s", "2026-10-21", "failed", "2026-10-22T05:00:00.000Z");
    const { outcome } = await ingest(schema, [failing], "2026-10-30T05:00:00.000Z", {
      mode: "range",
      from: "2026-10-20",
      to: "2026-10-23",
    });
    expect(failing.days).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(outcome.runs.map((run) => run.status)).toEqual([
      "failed",
      "failed",
      "succeeded",
      "succeeded",
    ]);
    expect(outcome.notRun).toEqual([]);
  });

  it("counts a day whose run could not be recorded as a failed first attempt", async () => {
    await register(schema, "cu-t");
    // Every run record of this source fails (a server-side error).
    await sql`
      CREATE FUNCTION refuse_cu_t_run() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused by the test'; END $$
    `.execute(schema.db);
    await sql`
      CREATE TRIGGER refuse_cu_t_run BEFORE INSERT ON ingestion_runs FOR EACH ROW
      WHEN (NEW.source_id = 'cu-t') EXECUTE FUNCTION refuse_cu_t_run()
    `.execute(schema.db);
    try {
      const source = daySource("cu-t");
      const { outcome } = await ingest(schema, [source], "2026-10-30T05:00:00.000Z", {
        mode: "range",
        from: "2026-10-26",
        to: "2026-10-29",
      });
      // The source served both days; only their run records are missing.
      expect(source.days).toEqual(["2026-10-26", "2026-10-27"]);
      expect(outcome.runs.map((run) => [run.status, run.runId])).toEqual([
        ["succeeded", null],
        ["succeeded", null],
      ]);
      expect(outcome.notRun).toEqual([
        { sourceId: "cu-t", publicationDate: "2026-10-28", reason: "consecutive_failures" },
        { sourceId: "cu-t", publicationDate: "2026-10-29", reason: "consecutive_failures" },
      ]);
    } finally {
      await sql`DROP TRIGGER refuse_cu_t_run ON ingestion_runs`.execute(schema.db);
      await sql`DROP FUNCTION refuse_cu_t_run()`.execute(schema.db);
    }
  });

  it("runs a gap left behind by a later manual --date", async () => {
    await register(schema, "cu-m");
    const source = daySource("cu-m");
    const at = "2026-10-30T05:00:00.000Z";
    await ingest(schema, [source], at, { mode: "range", from: "2026-10-24", to: "2026-10-25" });
    await ingest(schema, [source], at, { mode: "range", from: "2026-10-28", to: "2026-10-28" });
    const { outcome } = await ingest(schema, [source], "2026-10-30T06:00:00.000Z");
    expect(source.days.slice(3)).toEqual(["2026-10-26", "2026-10-27", "2026-10-29"]);
    expect(outcome).toMatchObject({ from: "2026-10-26", to: "2026-10-29", clipped: [] });
  });

  it("starts catch-up at a backfilled day, never before the window", async () => {
    await register(schema, "cu-n", "cu-o");
    const backfilled = daySource("cu-n", { failOn: ["2026-10-11"] });
    await ingest(schema, [backfilled], "2026-10-30T05:00:00.000Z", {
      mode: "range",
      from: "2026-10-10",
      to: "2026-10-12",
    });
    const fresh = daySource("cu-n");
    await ingest(schema, [fresh], "2026-10-30T06:00:00.000Z");
    expect(fresh.days).toEqual(["2026-10-11", ...daysOf("2026-10-13", 17)]);

    // A backfill older than the window: catch-up starts at the window.
    const old = daySource("cu-o");
    await ingest(schema, [old], "2026-10-30T05:00:00.000Z", {
      mode: "range",
      from: "2026-09-01",
      to: "2026-09-03",
    });
    const { outcome } = await ingest(schema, [old], "2026-10-30T06:00:00.000Z");
    expect(old.days.slice(3)).toEqual(daysOf("2026-09-29", 31));
    // The days between the backfill and the window are reported, not run.
    expect(outcome.clipped).toEqual([{ sourceId: "cu-o", from: "2026-09-04", to: "2026-09-28" }]);
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
    expect(await latestCovered(schema, "cu-d")).toBe("2026-10-29");

    await ingest(schema, [source], "2026-10-31T05:00:00.000Z");
    expect(source.days).toEqual(["2026-10-29", "2026-10-30", "2026-10-30"]);
    expect(
      (await catchUpHistory(schema.db, "cu-d", { from: "2026-10-01", to: "2026-10-31" })).covered,
    ).toEqual(["2026-10-29", "2026-10-30"]);
  });

  it("clips a long gap to the newest 31 days and reports the older ones", async () => {
    await register(schema, "cu-e", "cu-f");
    await seedRun(schema, "cu-e", "2026-09-01", "succeeded", "2026-09-02T05:00:00.000Z");
    const gap = daySource("cu-e");
    const fresh = daySource("cu-f");
    const { outcome, logs } = await ingest(schema, [gap, fresh], "2026-10-30T05:00:00.000Z");
    expect(gap.days).toHaveLength(31);
    expect(gap.days[0]).toBe("2026-09-29");
    expect(gap.days.at(-1)).toBe("2026-10-29");
    expect(fresh.days).toEqual(["2026-10-29"]);
    expect(outcome.clipped).toEqual([{ sourceId: "cu-e", from: "2026-09-02", to: "2026-09-28" }]);
    // The history read for planning is bounded to the window, the bounds are not.
    expect(
      await catchUpHistory(schema.db, "cu-e", { from: "2026-10-28", to: "2026-10-29" }),
    ).toEqual({
      covered: ["2026-10-28", "2026-10-29"],
      attempted: ["2026-10-28", "2026-10-29"],
      latestCovered: "2026-10-29",
      earliestAttempted: "2026-09-01",
    });
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

  it("reports the days from the first run on when a source never covered a day", async () => {
    await register(schema, "cu-p");
    await seedRun(schema, "cu-p", "2026-09-10", "failed", "2026-09-11T05:00:00.000Z");
    await seedRun(schema, "cu-p", "2026-10-01", "failed", "2026-10-02T05:00:00.000Z");
    const source = daySource("cu-p");
    const { outcome, logs } = await ingest(schema, [source], "2026-10-30T05:00:00.000Z");
    expect(source.days).toEqual(daysOf("2026-09-29", 31));
    expect(outcome.clipped).toEqual([{ sourceId: "cu-p", from: "2026-09-10", to: "2026-09-28" }]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "catch-up clipped, older missing days not run",
        sourceId: "cu-p",
        lastCovered: null,
        earliestAttempted: "2026-09-10",
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
