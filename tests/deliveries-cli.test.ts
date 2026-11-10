import { describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliDatabase } from "../src/cli.js";
import type {
  PendingDeliveries,
  ResolveRequest,
  ResolveResult,
} from "../src/infrastructure/db/deliveries-repository.js";

/**
 * `deliveries:pending` and `deliveries:resolve` (PR-09, D-024) with a
 * database stub; the SQL, the transaction and the digest lock are covered by
 * tests/integration/digest.test.ts. Pseudonymised values only.
 */

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const PROFILE_ID = "00000000-0000-4000-8000-0000000000aa";

const PENDING: PendingDeliveries = {
  groups: [
    {
      profileId: PROFILE_ID,
      transport: "smtp",
      digestDate: "2026-11-02",
      offers: 3,
      oldestCreatedAt: new Date("2026-11-02T06:00:01.000Z"),
    },
  ],
  truncated: false,
};

async function run(
  args: string[],
  options: {
    pending?: string[];
    list?: PendingDeliveries | Error;
    resolve?: ResolveResult | Error;
    env?: Record<string, string>;
  } = {},
) {
  const calls = { closed: 0, listed: 0, resolved: [] as Omit<ResolveRequest, "digestLockKey">[] };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    pendingMigrations: () => Promise.resolve(options.pending ?? []),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    listPendingDeliveries: () => {
      calls.listed++;
      const list = options.list ?? PENDING;
      return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
    },
    resolvePendingDeliveries: (request) => {
      calls.resolved.push(request);
      const result = options.resolve ?? { status: "resolved", changed: 3 };
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL, ...options.env },
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

describe("deliveries:pending", () => {
  it("prints the pending groups as one JSON line: ids, dates and counts", async () => {
    const result = await run(["deliveries:pending"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      pending: [
        {
          profileId: PROFILE_ID,
          transport: "smtp",
          digestDate: "2026-11-02",
          offers: 3,
          oldestCreatedAt: "2026-11-02T06:00:01.000Z",
        },
      ],
      truncated: false,
    });
    expect(result.stderr).toBe("");
    expect(result.calls.closed).toBe(1);
  });

  it("prints an empty list when nothing is pending", async () => {
    const result = await run(["deliveries:pending"], { list: { groups: [], truncated: false } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", pending: [], truncated: false });
  });

  it("exits 1 on an outdated schema without reading", async () => {
    const result = await run(["deliveries:pending"], { pending: ["0009_next"] });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Cannot list pending deliveries: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls.listed).toBe(0);
  });

  it("exits 1 naming only the reason and code when the database is unreachable", async () => {
    const result = await run(["deliveries:pending"], { list: refused });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Cannot list pending deliveries: database unreachable (ECONNREFUSED)\n",
    );
    expect(result.calls.closed).toBe(1);
  });

  it("takes no arguments (exit 2)", async () => {
    const result = await run(["deliveries:pending", PROFILE_ID]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Command "deliveries:pending" takes no arguments.');
    expect(result.calls.listed).toBe(0);
  });
});

describe("deliveries:resolve", () => {
  it.each([
    [["--sent"], { profileId: PROFILE_ID, transport: "test", outcome: "sent", digestDate: null }],
    [
      ["--failed"],
      { profileId: PROFILE_ID, transport: "test", outcome: "failed", digestDate: null },
    ],
    [
      ["--sent", "--date", "2026-11-02"],
      { profileId: PROFILE_ID, transport: "test", outcome: "sent", digestDate: "2026-11-02" },
    ],
    [
      ["--date", "2026-11-02", "--failed"],
      { profileId: PROFILE_ID, transport: "test", outcome: "failed", digestDate: "2026-11-02" },
    ],
    [
      ["--failed", "--transport", "smtp", "--date", "2026-11-02"],
      { profileId: PROFILE_ID, transport: "smtp", outcome: "failed", digestDate: "2026-11-02" },
    ],
  ])("passes %j on and prints the rows changed", async (options, request) => {
    const result = await run(["deliveries:resolve", PROFILE_ID, ...options]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.resolved).toEqual([request]);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      outcome: request.outcome,
      transport: request.transport,
      digestDate: request.digestDate,
      changed: 3,
    });
    expect(result.stderr).toBe("");
    expect(result.calls.closed).toBe(1);
  });

  it.each([
    // Without --transport: EMAIL_MODE's transport, like digest; SMTP_URL and
    // EMAIL_FROM are not needed (not set here) and an empty value counts as unset.
    [{}, [], "test"],
    [{ EMAIL_MODE: "" }, [], "test"],
    [{ EMAIL_MODE: "test" }, [], "test"],
    [{ EMAIL_MODE: "smtp" }, [], "smtp"],
    // --transport wins; EMAIL_MODE is then not read.
    [{ EMAIL_MODE: "smtp" }, ["--transport", "test"], "test"],
    [{ EMAIL_MODE: "test" }, ["--transport", "smtp"], "smtp"],
    [{ EMAIL_MODE: "imap" }, ["--transport", "smtp"], "smtp"],
  ])("with env %j and %j resolves the %s transport", async (env, options, transport) => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent", ...options], { env });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.resolved).toEqual([
      { profileId: PROFILE_ID, transport, outcome: "sent", digestDate: null },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", transport, changed: 3 });
    expect(result.stderr).toBe("");
  });

  it("with EMAIL_MODE=smtp ignores a malformed SMTP_URL and never prints it", async () => {
    // SMTP_URL is not read by deliveries:resolve: neither its validity nor its
    // password matters, and it must not reach the output.
    const smtpUrl = "smtp://user:sekret@:not a port/%%";
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent"], {
      env: { EMAIL_MODE: "smtp", SMTP_URL: smtpUrl },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.resolved).toEqual([
      { profileId: PROFILE_ID, transport: "smtp", outcome: "sent", digestDate: null },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", transport: "smtp" });
    expect(result.stderr).toBe("");
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(smtpUrl);
      expect(output).not.toContain("sekret");
    }
  });

  it("exits 1 on an invalid EMAIL_MODE without --transport, before opening the database", async () => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent"], {
      env: { EMAIL_MODE: "imap" },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid e-mail configuration: EMAIL_MODE\n");
    expect(result.calls.resolved).toEqual([]);
    expect(result.calls.closed).toBe(0);
  });

  it("exits 1 without a change while a digest run (or another resolve) holds the lock", async () => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent"], {
      resolve: { status: "lock_busy" },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Deliveries not resolved: a digest run or another deliveries:resolve holds the lock " +
        "(a digest's claimed rows are pending until it ends); nothing was changed. " +
        "Try again when it has finished.\n",
    );
  });

  it.each([
    [
      [],
      'Deliveries not resolved: the profile has no pending deliveries over transport "test"; ' +
        "nothing was changed.\n",
    ],
    [
      ["--date", "2026-11-02"],
      "Deliveries not resolved: the profile has no pending deliveries of that day over " +
        'transport "test"; nothing was changed.\n',
    ],
    [
      ["--transport", "smtp"],
      'Deliveries not resolved: the profile has no pending deliveries over transport "smtp"; ' +
        "nothing was changed.\n",
    ],
  ])("exits 1 when no pending row matches (%j)", async (options, message) => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--failed", ...options], {
      resolve: { status: "resolved", changed: 0 },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(message);
  });

  it("does not resolve on an outdated schema", async () => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent"], {
      pending: ["0009_next"],
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Deliveries not resolved: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls.resolved).toEqual([]);
  });

  it("exits 1 naming only the reason and code when the database is unreachable", async () => {
    const result = await run(["deliveries:resolve", PROFILE_ID, "--sent"], { resolve: refused });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Deliveries not resolved: database unreachable (ECONNREFUSED)\n");
    expect(result.stderr).not.toContain("127.0.0.1");
    expect(result.calls.closed).toBe(1);
  });

  it.each([
    [[], 'Command "deliveries:resolve" needs a profile id (uuid).'],
    [["nie-uuid", "--sent"], 'Command "deliveries:resolve" needs a profile id (uuid).'],
    [["--sent", PROFILE_ID], 'Command "deliveries:resolve" needs a profile id (uuid).'],
    [[PROFILE_ID], "Give exactly one of --sent and --failed."],
    [[PROFILE_ID, "--sent", "--failed"], "Give exactly one of --sent and --failed."],
    [[PROFILE_ID, "--sent", "--sent"], "Give exactly one of --sent and --failed."],
    [[PROFILE_ID, "--date", "2026-11-02"], "Give exactly one of --sent and --failed."],
    [[PROFILE_ID, "--sent", "--date"], "Option --date needs a value."],
    [[PROFILE_ID, "--sent", "--date", "2026-02-30"], "--date must be a calendar date YYYY-MM-DD."],
    [[PROFILE_ID, "--sent", "--date", "02.11.2026"], "--date must be a calendar date YYYY-MM-DD."],
    [
      [PROFILE_ID, "--sent", "--date", "2026-11-01", "--date", "2026-11-02"],
      "Option --date given twice.",
    ],
    [[PROFILE_ID, "--sent", "--transport"], "Option --transport needs a value."],
    [[PROFILE_ID, "--sent", "--transport", "imap"], "--transport must be test or smtp."],
    [[PROFILE_ID, "--sent", "--transport", "SMTP"], "--transport must be test or smtp."],
    [
      [PROFILE_ID, "--sent", "--transport", "test", "--transport", "smtp"],
      "Option --transport given twice.",
    ],
    [[PROFILE_ID, "--sent", "--all"], 'Unexpected argument: "--all"'],
  ])("refuses %j as a usage error (exit 2) without opening the database", async (rest, message) => {
    const result = await run(["deliveries:resolve", ...rest]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage:");
    expect(result.calls.resolved).toEqual([]);
    expect(result.calls.closed).toBe(0);
  });
});
