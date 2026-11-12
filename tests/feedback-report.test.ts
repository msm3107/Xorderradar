import { describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliDatabase } from "../src/cli.js";
import type { FeedbackCounts } from "../src/infrastructure/db/feedback-repository.js";
import { buildFeedbackReport, coverage, precision } from "../src/operations/feedback-report.js";

/**
 * `feedback:report` (PR-12, D-032): the pure report and the command with a
 * database stub; the SQL is covered by tests/integration/web-feedback.test.ts.
 * Pseudonymised values only.
 */

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const PROFILE_A = "00000000-0000-4000-8000-0000000000aa";
const PROFILE_B = "00000000-0000-4000-8000-0000000000bb";
// Sorts before PROFILE_A ("9" < "a"): the report lists profiles by id.
const PROFILE_C = "00000000-0000-4000-8000-000000000099";

const COUNTS: FeedbackCounts = {
  profiles: [
    { profileId: PROFILE_A, relevant: 2, notRelevant: 1 },
    { profileId: PROFILE_B, relevant: 0, notRelevant: 3 },
  ],
  offers: [
    // 4531… is elektryka; 50232… is elektryka and serwis (an offer counts in both).
    { cpvCodes: ["45310000-3"], relevant: 2, notRelevant: 0 },
    { cpvCodes: ["50232000-0"], relevant: 0, notRelevant: 1 },
    // No MVP category: counted under null.
    { cpvCodes: ["03000000-1"], relevant: 0, notRelevant: 2 },
    { cpvCodes: [], relevant: 0, notRelevant: 1 },
  ],
  // PROFILE_B rated only on /dopasowania: nothing sent to it.
  deliveries: [{ profileId: PROFILE_A, delivered: 3, ratedDelivered: 2 }],
};

const NO_COUNTS: FeedbackCounts = { profiles: [], offers: [], deliveries: [] };

describe("precision", () => {
  it("is the relevant share rounded to 3 decimals", () => {
    expect(precision(2, 3)).toBe(0.667);
    expect(precision(1, 3)).toBe(0.333);
    expect(precision(3, 3)).toBe(1);
  });

  it("is 0 only when every rating is „Nietrafne”, and null without any rating (never 0)", () => {
    expect(precision(0, 4)).toBe(0);
    expect(precision(0, 0)).toBeNull();
  });
});

describe("coverage", () => {
  it("is the rated share of the offers sent, rounded to 3 decimals", () => {
    expect(coverage(2, 3)).toBe(0.667);
    expect(coverage(1, 3)).toBe(0.333);
    expect(coverage(1, 8)).toBe(0.125);
    expect(coverage(5, 5)).toBe(1);
  });

  it("is 0 when nothing sent was rated, and null when nothing was sent (never 0)", () => {
    expect(coverage(0, 7)).toBe(0);
    expect(coverage(0, 0)).toBeNull();
  });
});

describe("buildFeedbackReport", () => {
  it("counts in total, per profile and per category, with the precision of each", () => {
    expect(buildFeedbackReport(COUNTS, "2026-11-01")).toEqual({
      since: "2026-11-01",
      total: {
        ratings: 6,
        relevant: 2,
        notRelevant: 4,
        precision: 0.333,
        delivered: 3,
        ratedDelivered: 2,
        coverage: 0.667,
      },
      profiles: [
        {
          profileId: PROFILE_A,
          ratings: 3,
          relevant: 2,
          notRelevant: 1,
          precision: 0.667,
          delivered: 3,
          ratedDelivered: 2,
          coverage: 0.667,
        },
        {
          profileId: PROFILE_B,
          ratings: 3,
          relevant: 0,
          notRelevant: 3,
          precision: 0,
          delivered: 0,
          ratedDelivered: 0,
          coverage: null,
        },
      ],
      categories: [
        { category: "elektryka", ratings: 3, relevant: 2, notRelevant: 1, precision: 0.667 },
        { category: "serwis", ratings: 1, relevant: 0, notRelevant: 1, precision: 0 },
        { category: null, ratings: 3, relevant: 0, notRelevant: 3, precision: 0 },
      ],
    });
  });

  it("reports no rating as zero counts and a null precision", () => {
    expect(buildFeedbackReport(NO_COUNTS, null)).toEqual({
      since: null,
      total: {
        ratings: 0,
        relevant: 0,
        notRelevant: 0,
        precision: null,
        delivered: 0,
        ratedDelivered: 0,
        coverage: null,
      },
      profiles: [],
      categories: [],
    });
  });

  it("lists a profile with offers sent but no rating: ratings 0, precision null, coverage 0", () => {
    const report = buildFeedbackReport(
      {
        ...COUNTS,
        deliveries: [
          { profileId: PROFILE_A, delivered: 3, ratedDelivered: 2 },
          { profileId: PROFILE_C, delivered: 7, ratedDelivered: 0 },
        ],
      },
      null,
    );
    expect(report.profiles.map((profile) => profile.profileId)).toEqual([
      PROFILE_C,
      PROFILE_A,
      PROFILE_B,
    ]);
    expect(report.profiles[0]).toEqual({
      profileId: PROFILE_C,
      ratings: 0,
      relevant: 0,
      notRelevant: 0,
      precision: null,
      delivered: 7,
      ratedDelivered: 0,
      coverage: 0,
    });
    // Its offers count in the total coverage; its (absent) ratings change no precision.
    expect(report.total).toEqual({
      ratings: 6,
      relevant: 2,
      notRelevant: 4,
      precision: 0.333,
      delivered: 10,
      ratedDelivered: 2,
      coverage: 0.2,
    });
  });

  it("gives a profile with ratings but nothing sent delivered 0 and a null coverage", () => {
    const report = buildFeedbackReport({ ...COUNTS, deliveries: [] }, null);
    expect(report.profiles).toHaveLength(2);
    for (const profile of report.profiles) {
      expect(profile).toMatchObject({ delivered: 0, ratedDelivered: 0, coverage: null });
    }
    expect(report.total).toMatchObject({ delivered: 0, ratedDelivered: 0, coverage: null });
  });

  it("sums the profiles into the total", () => {
    const report = buildFeedbackReport(
      {
        profiles: [
          { profileId: PROFILE_A, relevant: 1, notRelevant: 2 },
          { profileId: PROFILE_C, relevant: 4, notRelevant: 0 },
        ],
        offers: [],
        deliveries: [
          { profileId: PROFILE_A, delivered: 5, ratedDelivered: 3 },
          { profileId: PROFILE_B, delivered: 2, ratedDelivered: 0 },
          { profileId: PROFILE_C, delivered: 6, ratedDelivered: 4 },
        ],
      },
      null,
    );
    const sum = (key: "ratings" | "relevant" | "notRelevant" | "delivered" | "ratedDelivered") =>
      report.profiles.reduce((total, profile) => total + profile[key], 0);
    expect(report.total).toEqual({
      ratings: sum("ratings"),
      relevant: sum("relevant"),
      notRelevant: sum("notRelevant"),
      precision: precision(sum("relevant"), sum("ratings")),
      delivered: sum("delivered"),
      ratedDelivered: sum("ratedDelivered"),
      coverage: coverage(sum("ratedDelivered"), sum("delivered")),
    });
    expect(report.total).toMatchObject({ ratings: 7, delivered: 13, ratedDelivered: 7 });
    expect(report.total.coverage).toBe(0.538);
  });
});

async function run(
  args: string[],
  options: { pending?: string[]; counts?: FeedbackCounts | Error } = {},
) {
  const calls = { closed: 0, since: [] as (string | null)[] };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    pendingMigrations: () => Promise.resolve(options.pending ?? []),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    countFeedback: (since) => {
      calls.since.push(since);
      const counts = options.counts ?? COUNTS;
      return counts instanceof Error ? Promise.reject(counts) : Promise.resolve(counts);
    },
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    { openDatabase: () => database },
  );
  expect(stdout + stderr).not.toContain("not-a-real-password");
  return { code, stdout, stderr, calls };
}

const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
  code: "ECONNREFUSED",
});

describe("feedback:report", () => {
  it("prints the report as one JSON line: ids, categories and counts", async () => {
    const result = await run(["feedback:report"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      ...buildFeedbackReport(COUNTS, null),
    });
    expect(result.stderr).toBe("");
    expect(result.calls).toEqual({ closed: 1, since: [null] });
  });

  it("passes --since on", async () => {
    const result = await run(["feedback:report", "--since", "2026-11-01"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", since: "2026-11-01" });
    expect(result.calls.since).toEqual(["2026-11-01"]);
  });

  it("prints a null precision (never 0) when there are no ratings", async () => {
    const result = await run(["feedback:report"], { counts: NO_COUNTS });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      since: null,
      total: {
        ratings: 0,
        relevant: 0,
        notRelevant: 0,
        precision: null,
        delivered: 0,
        ratedDelivered: 0,
        coverage: null,
      },
      profiles: [],
      categories: [],
    });
  });

  it.each([
    [["--since"], "Option --since needs a value."],
    [["--since", "2026-02-30"], "--since must be a calendar date YYYY-MM-DD."],
    [["--since", "01.11.2026"], "--since must be a calendar date YYYY-MM-DD."],
    [["--since", "2026-11-1"], "--since must be a calendar date YYYY-MM-DD."],
    [["--since", "2026-11-01", "--since", "2026-11-02"], "Option --since given twice."],
    [["--until", "2026-11-01"], 'Unexpected argument: "--until"'],
    [[PROFILE_A], `Unexpected argument: "${PROFILE_A}"`],
  ])("refuses %j as a usage error (exit 2) without opening the database", async (args, message) => {
    const result = await run(["feedback:report", ...args]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual({ closed: 0, since: [] });
  });

  it("exits 1 on an outdated schema without reading", async () => {
    const result = await run(["feedback:report"], { pending: ["0009_match_feedback"] });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Cannot report feedback: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls.since).toEqual([]);
    expect(result.calls.closed).toBe(1);
  });

  it("exits 1 naming only the reason and code when the database is unreachable", async () => {
    const result = await run(["feedback:report"], { counts: refused });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot report feedback: database unreachable (ECONNREFUSED)\n");
    expect(result.calls.closed).toBe(1);
  });

  it("is listed in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain("feedback:report [--since YYYY-MM-DD]");
  });
});
