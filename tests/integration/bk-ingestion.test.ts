import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { getSource, upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import type { HttpResponse } from "../../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { runIngestion } from "../../src/ingestion/run.js";
import { collectStatus } from "../../src/operations/status.js";
import { bkAdapter } from "../../src/sources/bk/adapter.js";
import type { SourceHttpClient } from "../../src/sources/types.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * The bk adapter end to end on the captured fixtures (tests/fixtures/bk):
 * migration 0007, ingest with dedup and a new version, and a format change
 * that `status` sees in the same cycle (PR-08 AC2, AC3).
 */

const DAY = "2026-11-03";
const T0 = new Date("2026-11-04T05:00:00.000Z");
const LISTED: Readonly<Record<string, string>> = {
  "296132": "detail-296132.json",
  "296920": "detail-296920.json",
  "296667": "detail-296667.json",
  "296622": "detail-296622.json",
};

const fixtureText = (name: string) =>
  readFileSync(new URL(`../fixtures/bk/${name}`, import.meta.url), "utf8");

/** Serves the captured listing and details; `detail` may replace a detail's body. */
function bkHttp(detail: (id: string, body: string) => string = (_id, body) => body) {
  const client: SourceHttpClient = {
    get(url) {
      const href = url.toString();
      const { pathname } = new URL(href);
      let body: string;
      if (pathname === "/api/announcements/search") {
        body = fixtureText("list-2026-11-03.json");
      } else {
        const id = pathname.split("/").at(-1) ?? "";
        const name = LISTED[id];
        if (name === undefined) return Promise.reject(new Error(`unexpected ${pathname}`));
        body = detail(id, fixtureText(name));
      }
      const response: HttpResponse = {
        url: href,
        status: 200,
        contentType: "text/html; charset=UTF-8",
        body: Buffer.from(body),
      };
      return Promise.resolve(response);
    },
  };
  return client;
}

const detailSchema = z.looseObject({
  data: z.looseObject({ advertisement: z.record(z.string(), z.unknown()) }),
});

/** A detail body with its version changed by `change`. */
function changedVersion(body: string, change: (version: Record<string, unknown>) => void) {
  const root = detailSchema.parse(JSON.parse(body));
  change(root.data.advertisement);
  return JSON.stringify(root);
}

async function ingestBk(schema: TestSchema, http: SourceHttpClient, at: Date) {
  let clock = at.getTime();
  const outcome = await runIngestion(
    {
      db: schema.db,
      adapters: new Map([[bkAdapter.sourceId, bkAdapter]]),
      createHttpClient: () => http,
      now: () => new Date((clock += 1000)),
      logger: createLogger("error", () => undefined),
      sourceTimeoutMs: 60_000,
    },
    { days: { mode: "range", from: DAY, to: DAY }, maxRecords: 100, sourceIds: ["bk"] },
  );
  const [run] = outcome.runs;
  expect(outcome.runs).toHaveLength(1);
  if (run === undefined) throw new Error("no run");
  return run;
}

const rowSchema = z.object({
  external_id: z.string(),
  source_url: z.string(),
  deadline: z.date().nullable(),
  estimated_value: z.string().nullable(),
  currency: z.string().nullable(),
  contact: z.unknown(),
  first_seen_at: z.date(),
});

async function bkRows(schema: TestSchema) {
  const rows = await schema.db
    .selectFrom("opportunities")
    .select([
      "external_id",
      "source_url",
      "deadline",
      "estimated_value",
      "currency",
      "contact",
      "first_seen_at",
    ])
    .where("source_id", "=", "bk")
    .orderBy("external_id")
    .execute();
  return z.array(rowSchema).parse(rows);
}

describe.skipIf(skipWithoutDatabase)("bk source (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("seeds the bk source disabled, and keeps an existing row", async () => {
    expect(await getSource(schema.db, "bk")).toMatchObject({
      name: "Baza Konkurencyjności",
      baseUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/",
      enabled: false,
    });
    // Re-running 0007 on an enabled row leaves it as the operator set it.
    await upsertSource(schema.db, {
      id: "bk",
      name: "Baza Konkurencyjności",
      baseUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/",
      enabled: true,
    });
    await sql`DELETE FROM kysely_migration WHERE name = '0007_bk_source'`.execute(schema.db);
    expect(await migrateToLatest(schema.db)).toEqual(["0007_bk_source"]);
    expect(await getSource(schema.db, "bk")).toMatchObject({ enabled: true });
  });

  it("stores each announcement once and a new version as updated (AC3)", async () => {
    const first = await ingestBk(schema, bkHttp(), T0);
    expect(first).toMatchObject({ sourceId: "bk", status: "succeeded", errorCode: null });
    expect(first.counters).toMatchObject({ documents: 4, extracted: 4, inserted: 4, rejected: 0 });
    const before = await bkRows(schema);
    expect(before.map((row) => [row.external_id, row.source_url])).toEqual([
      ["296132", "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296132"],
      ["296622", "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296622"],
      ["296667", "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296667"],
      ["296920", "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920"],
    ]);
    // None of these publishes a value: stored as null, never 0 (AC4).
    expect(before.every((row) => row.estimated_value === null && row.currency === null)).toBe(true);

    const same = await ingestBk(schema, bkHttp(), new Date(T0.getTime() + 3_600_000));
    expect(same.counters).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });

    // A later version of 296920 moves the deadline; the announcement id stays.
    const moved = bkHttp((id, body) =>
      id === "296920"
        ? body.replace(
            '"submission_deadline":"2026-11-17 23:59:59"',
            '"submission_deadline":"2026-11-24 23:59:59"',
          )
        : body,
    );
    const next = await ingestBk(schema, moved, new Date(T0.getTime() + 7_200_000));
    expect(next.counters).toMatchObject({ inserted: 0, updated: 1, unchanged: 3 });
    const after = await bkRows(schema);
    expect(after).toHaveLength(4);
    const updated = after.find((row) => row.external_id === "296920");
    expect(updated?.deadline).toEqual(new Date("2026-11-24T22:59:59.000Z"));
    expect(updated?.first_seen_at).toEqual(
      before.find((row) => row.external_id === "296920")?.first_seen_at,
    );
  });

  it("skips one unusable detail: the day is incomplete, the rest is read (D-030)", async () => {
    const oneChanged = bkHttp((id, body) =>
      id === "296667" ? body.replace('"orders":[', '"orders_v2":[') : body,
    );
    const run = await ingestBk(schema, oneChanged, new Date(T0.getTime() + 9_000_000));
    expect(run).toMatchObject({
      status: "incomplete",
      errorCode: null,
      incomplete: [{ part: "announcements", reason: "detail_invalid" }],
    });
    expect(run.counters).toMatchObject({ documents: 3, extracted: 3, inserted: 0, rejected: 0 });
    expect(await bkRows(schema)).toHaveLength(4);
  });

  it("fails the day on a changed format, and status shows it in the same cycle (AC2)", async () => {
    // Every detail in another shape: past the skip limit the day fails.
    const changed = bkHttp((_id, body) => body.replace('"orders":[', '"orders_v2":['));
    const failed = await ingestBk(schema, changed, new Date(T0.getTime() + 10_800_000));
    expect(failed).toMatchObject({ status: "failed", errorCode: "invalid_document" });

    const report = await collectStatus(schema.db, new Date(T0.getTime() + 10_900_000));
    const bk = (report.sources ?? []).find((source) => source.sourceId === "bk");
    expect(bk).toMatchObject({
      problems: ["source_failed"],
      lastRun: { status: "failed", errorCode: "invalid_document" },
      failedDays: [{ publicationDate: DAY, errorCode: "invalid_document" }],
    });
    expect(report.problems).toContain("source_failed");
  });

  it("fails the day when every detail lost a required field (a renamed title, AC2)", async () => {
    const renamed = bkHttp((_id, body) =>
      changedVersion(body, (version) => {
        version.name = version.title;
        delete version.title;
      }),
    );
    const failed = await ingestBk(schema, renamed, new Date(T0.getTime() + 11_000_000));
    expect(failed).toMatchObject({ status: "failed", errorCode: "invalid_document" });
    expect(failed.counters).toMatchObject({ documents: 0, rejected: 0 });

    const report = await collectStatus(schema.db, new Date(T0.getTime() + 11_100_000));
    const bk = (report.sources ?? []).find((source) => source.sourceId === "bk");
    expect(bk).toMatchObject({
      problems: ["source_failed"],
      lastRun: { status: "failed", errorCode: "invalid_document" },
    });
  });

  it("fails a day whose every record is rejected (a new deadline format, AC2)", async () => {
    const otherFormat = bkHttp((_id, body) =>
      changedVersion(body, (version) => {
        version.submission_deadline = "05.11.2026 15:00";
      }),
    );
    const failed = await ingestBk(schema, otherFormat, new Date(T0.getTime() + 11_200_000));
    expect(failed).toMatchObject({ status: "failed", errorCode: "invalid_document" });
    expect(failed.counters).toMatchObject({ documents: 4, rejected: 4, inserted: 0, updated: 0 });

    const report = await collectStatus(schema.db, new Date(T0.getTime() + 11_300_000));
    const bk = (report.sources ?? []).find((source) => source.sourceId === "bk");
    expect(bk).toMatchObject({ problems: ["source_failed"] });
  });
});
