import { describe, expect, it } from "vitest";
import {
  ExitCode,
  INGEST_DEFAULT_LIMIT,
  INTERNAL_ERROR_MESSAGE,
  runCli,
  type CliDatabase,
  type CliSourceDeps,
} from "../src/cli.js";
import {
  overallStatus,
  type IngestionOutcome,
  type IngestionRunResult,
} from "../src/ingestion/run.js";
import { sourceAdapters } from "../src/sources/registry.js";

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const NOW = new Date("2026-10-30T05:00:00.000Z");

/**
 * Runs the CLI with a database stub that records whether it was opened and
 * whether ingest was attempted, and an HTTP client factory that must never be
 * used (no test here reaches a fetch).
 */
async function run(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    database?: Partial<CliDatabase>;
    /** A database object as the stubs of other commands build it. */
    withoutIngestSupport?: boolean;
  } = {},
) {
  const calls = { opened: 0, closed: 0, lockAttempts: 0, httpClients: 0 };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    withIngestLock: () => {
      calls.lockAttempts++;
      return Promise.resolve({ acquired: false });
    },
    ...options.database,
  };
  if (options.withoutIngestSupport === true) delete database.withIngestLock;
  const sources: CliSourceDeps = {
    adapters: sourceAdapters,
    createHttpClient: () => {
      calls.httpClients++;
      throw new Error("no network in unit tests");
    },
    now: () => NOW,
    runTimeoutMs: 60_000,
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL, CRAWLER_CONTACT: "ops@example.com", ...options.env },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    {
      openDatabase: () => {
        calls.opened++;
        return database;
      },
      sources,
    },
  );
  return { code, stdout, stderr, calls };
}

describe("ingest arguments", () => {
  it.each([
    [["ingest", "--verbose"], 'Unexpected argument: "--verbose"'],
    [["ingest", "-x"], 'Unexpected argument: "-x"'],
    [["ingest", "--date"], "Option --date needs a value."],
    [["ingest", "--date", "2026-02-30"], "--date must be a calendar date YYYY-MM-DD."],
    [["ingest", "--date", "29.10.2026"], "--date must be a calendar date YYYY-MM-DD."],
    [["ingest", "--date", "2026-10-28", "--date", "2026-10-29"], "Option --date given twice."],
    [["ingest", "--limit", "0"], "--limit must be an integer from 1 to 1000."],
    [["ingest", "--limit", "1001"], "--limit must be an integer from 1 to 1000."],
    [["ingest", "--limit", "10.5"], "--limit must be an integer from 1 to 1000."],
    [["ingest", "--limit", "-5"], "--limit must be an integer from 1 to 1000."],
    [["ingest", "--limit", "5", "--limit", "6"], "Option --limit given twice."],
    [["ingest", "bzp", "bzp"], 'Source "bzp" given twice.'],
    [["ingest", "nieznane-zrodlo"], 'Unknown source: "nieznane-zrodlo"'],
    [["ingest", "--from"], "Option --from needs a value."],
    [["ingest", "--to", "--limit", "5"], "--to must be a calendar date YYYY-MM-DD."],
    [["ingest", "--from", "2026-10-01"], "Options --from and --to must be given together."],
    [["ingest", "--to", "2026-10-01"], "Options --from and --to must be given together."],
    [
      ["ingest", "--from", "2026-10-01", "--to", "2026-10-02", "--from", "2026-10-01"],
      "Option --from given twice.",
    ],
    [["ingest", "--from", "2026-02-29", "--to", "2026-03-01"], "--from must be a calendar date"],
    [["ingest", "--from", "2026-10-01", "--to", "1.10.2026"], "--to must be a calendar date"],
    [["ingest", "--from", "2026-10-02", "--to", "2026-10-01"], "--from must not be after --to."],
    [
      ["ingest", "--from", "2026-09-01", "--to", "2026-10-02"],
      "--from/--to may cover at most 31 days.",
    ],
    [
      ["ingest", "--date", "2026-10-01", "--from", "2026-10-01", "--to", "2026-10-01"],
      "Option --date cannot be combined with --from/--to.",
    ],
    // Days outside 2000–2999 are refused before any list of days is built.
    [["ingest", "--date", "9999-12-31"], "--date must be a day from 2000-01-01 to 2999-12-31."],
    [["ingest", "--date", "1999-12-31"], "--date must be a day from 2000-01-01 to 2999-12-31."],
    [["ingest", "--date", "3000-01-01"], "--date must be a day from 2000-01-01 to 2999-12-31."],
    [
      ["ingest", "--from", "9999-12-01", "--to", "9999-12-31"],
      "--from must be a day from 2000-01-01 to 2999-12-31.",
    ],
    [
      ["ingest", "--from", "0100-01-01", "--to", "2026-10-01"],
      "--from must be a day from 2000-01-01 to 2999-12-31.",
    ],
    [
      ["ingest", "--from", "2000-01-01", "--to", "2999-12-31"],
      "--from/--to may cover at most 31 days.",
    ],
  ])("%j is a usage error (exit 2) before config or database", async (args, message) => {
    const result = await run(args, { env: { DATABASE_URL: undefined } });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage: radar-zamowien");
    expect(result.calls.opened).toBe(0);
    expect(result.calls.httpClients).toBe(0);
  });

  it("lists ingest in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(
      "ingest [sourceId...] [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--limit N]",
    );
    expect(result.stdout).toContain(`default ${String(INGEST_DEFAULT_LIMIT)}`);
  });

  it("accepts sources and options in any order (then needs the lock)", async () => {
    const result = await run(["ingest", "--limit", "5", "bzp", "--date", "2026-10-29"]);
    expect(result.calls.lockAttempts).toBe(1);
    // The stub's lock is busy: skipped (exit 0), with the parsed date and limit.
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "skipped",
      mode: "date",
      from: "2026-10-29",
      to: "2026-10-29",
      limit: 5,
    });
  });
});

describe("ingest day ranges", () => {
  it.each([
    [["ingest", "--from", "2026-10-01", "--to", "2026-10-31"], "2026-10-01", "2026-10-31"],
    [["ingest", "--to", "2026-10-29", "--from", "2026-10-29"], "2026-10-29", "2026-10-29"],
    [["ingest", "--from", "2028-02-28", "--to", "2028-03-01"], "2028-02-28", "2028-03-01"],
  ])("%j is a range (then needs the lock)", async (args, from, to) => {
    const result = await run(args);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.lockAttempts).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "skipped", mode: "range", from, to });
  });
});

describe("ingest command (stub database)", () => {
  it("requires CRAWLER_CONTACT before taking the lock", async () => {
    const result = await run(["ingest"], { env: { CRAWLER_CONTACT: undefined } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("CRAWLER_CONTACT is required");
    expect(result.calls.lockAttempts).toBe(0);
    expect(result.calls.closed).toBe(1);
  });

  it("reports skipped and exits 0 without fetching when another run holds the lock", async () => {
    const result = await run(["ingest"]);
    expect(result.code).toBe(ExitCode.Ok);
    // Without a date option: catch-up, whose days are only known under the lock.
    expect(JSON.parse(result.stdout)).toEqual({
      status: "skipped",
      reason: "lock_busy",
      mode: "catch_up",
      from: null,
      to: null,
      limit: INGEST_DEFAULT_LIMIT,
      runs: [],
      notRun: [],
      clipped: [],
    });
    expect(result.stderr).toContain(
      "Ingest skipped: another ingest run holds the lock; nothing was fetched.\n",
    );
    expect(result.stderr).toContain('"message":"ingest lock busy"');
    expect(result.stderr).not.toMatch(/fail|error/i);
    expect(result.calls.httpClients).toBe(0);
    expect(result.calls.closed).toBe(1);
  });

  it("reports a lock lost late in the run as failed even when every source finished", async () => {
    const finished: IngestionOutcome = {
      runs: [runResult()],
      notRun: [],
      clipped: [],
      from: "2026-10-29",
      to: "2026-10-29",
    };
    const result = await run(["ingest"], {
      database: {
        // The stub stands in for the task, whose result type T the generic
        // signature cannot name.
        withIngestLock: () =>
          Promise.resolve({ acquired: true, value: finished as never, lockLost: true }),
      },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
    expect(result.stderr).toBe(
      "Ingest aborted: the ingest lock was lost during the run (lock_lost).\n",
    );
  });

  it("reports the skipped counter of every run by reason, next to the counters", async () => {
    const counters = {
      documents: 3,
      extracted: 9,
      inserted: 2,
      updated: 1,
      unchanged: 1,
      rejected: 1,
      skipped: 4,
    };
    const outcome: IngestionOutcome = {
      runs: [
        runResult({
          publicationDate: "2026-10-28",
          counters,
          skippedReasons: { no_original: 3, superseded: 1 },
        }),
        runResult(),
      ],
      notRun: [],
      clipped: [],
      from: "2026-10-28",
      to: "2026-10-29",
    };
    const result = await run(["ingest"], {
      database: {
        withIngestLock: () =>
          Promise.resolve({ acquired: true, value: outcome as never, lockLost: false }),
      },
    });
    expect(result.code).toBe(ExitCode.Ok);
    const report = JSON.parse(result.stdout) as { runs: Record<string, unknown>[] };
    expect(report.runs).toEqual([
      {
        sourceId: "bzp",
        publicationDate: "2026-10-28",
        runId: "00000000-0000-4000-8000-000000000001",
        status: "succeeded",
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        durationMs: 0,
        ...counters,
        skippedReasons: { no_original: 3, superseded: 1 },
        incomplete: [],
        errorCode: null,
      },
      expect.objectContaining({ skipped: 0, skippedReasons: {} }),
    ]);
  });

  it("treats a database without ingest support as an internal error", async () => {
    const result = await run(["ingest"], { withoutIngestSupport: true });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it("reports an unreachable database with a fixed reason, without the URL", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const result = await run(["ingest"], {
      database: { withIngestLock: () => Promise.reject(refused) },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Ingest failed: database unreachable (ECONNREFUSED)\n");
    expect(result.stderr).not.toContain("not-a-real-password");
  });
});

function runResult(overrides: Partial<IngestionRunResult> = {}): IngestionRunResult {
  return {
    sourceId: "bzp",
    publicationDate: "2026-10-29",
    maxRecords: 1000,
    status: "succeeded",
    startedAt: NOW,
    finishedAt: NOW,
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
    runId: "00000000-0000-4000-8000-000000000001",
    skippedReasons: {},
    ...overrides,
  };
}

describe("overallStatus", () => {
  it("is succeeded when there is nothing to run or every source succeeded", () => {
    expect(overallStatus([])).toBe("succeeded");
    expect(overallStatus([runResult(), runResult({ sourceId: "inne" })])).toBe("succeeded");
  });

  it("is incomplete when a source hit a limit and none failed", () => {
    expect(
      overallStatus([
        runResult(),
        runResult({
          status: "incomplete",
          incomplete: [{ part: "ContractNotice", reason: "max_records" }],
        }),
      ]),
    ).toBe("incomplete");
  });

  it("is failed when any source failed, whatever the others did", () => {
    expect(
      overallStatus([
        runResult({ status: "incomplete" }),
        runResult({ status: "failed", errorCode: "http_status" }),
        runResult(),
      ]),
    ).toBe("failed");
  });

  it("is failed when a source's run could not be recorded", () => {
    expect(overallStatus([runResult({ runId: null })])).toBe("failed");
  });
});
