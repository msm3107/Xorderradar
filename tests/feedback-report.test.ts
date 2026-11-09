import { describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliDatabase } from "../src/cli.js";
import type { FeedbackCounts } from "../src/infrastructure/db/feedback-repository.js";
import { buildFeedbackReport, precision } from "../src/operations/feedback-report.js";

/**
 * `feedback:report` (PR-12, D-032): the pure report and the command with a
 * database stub; the SQL is covered by tests/integration/web-feedback.test.ts.
 * Pseudonymised values only.
 */

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const PROFILE_A = "00000000-0000-4000-8000-0000000000aa";
const PROFILE_B = "00000000-0000-4000-8000-0000000000bb";

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
};

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

describe("buildFeedbackReport", () => {
  it("counts in total, per profile and per category, with the precision of each", () => {
    expect(buildFeedbackReport(COUNTS, "2026-11-01")).toEqual({
      since: "2026-11-01",
      total: { ratings: 6, relevant: 2, notRelevant: 4, precision: 0.333 },
      profiles: [
        { profileId: PROFILE_A, ratings: 3, relevant: 2, notRelevant: 1, precision: 0.667 },
        { profileId: PROFILE_B, ratings: 3, relevant: 0, notRelevant: 3, precision: 0 },
      ],
      categories: [
        { category: "elektryka", ratings: 3, relevant: 2, notRelevant: 1, precision: 0.667 },
        { category: "serwis", ratings: 1, relevant: 0, notRelevant: 1, precision: 0 },
        { category: null, ratings: 3, relevant: 0, notRelevant: 3, precision: 0 },
      ],
    });
  });

  it("reports no rating as zero counts and a null precision", () => {
    expect(buildFeedbackReport({ profiles: [], offers: [] }, null)).toEqual({
      since: null,
      total: { ratings: 0, relevant: 0, notRelevant: 0, precision: null },
      profiles: [],
      categories: [],
    });
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
    const result = await run(["feedback:report"], { counts: { profiles: [], offers: [] } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      since: null,
      total: { ratings: 0, relevant: 0, notRelevant: 0, precision: null },
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
