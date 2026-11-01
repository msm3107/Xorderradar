import { describe, expect, it } from "vitest";
import {
  ExitCode,
  INTERNAL_ERROR_MESSAGE,
  runCli,
  type CliDatabase,
  type CliDigestDeps,
} from "../src/cli.js";
import type { LockResult } from "../src/ingestion/lock.js";
import type { DigestSummary, ProfileDigestSummary } from "../src/notifications/run.js";
import type { EmailSender } from "../src/notifications/sender.js";

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const SMTP_PASSWORD = "not-a-real-smtp-password";
const PROFILE_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-01T06:00:00.000Z");

function profileSummary(overrides: Partial<ProfileDigestSummary> = {}): ProfileDigestSummary {
  return {
    profileId: PROFILE_ID,
    status: "sent",
    matched: 3,
    claimed: 3,
    sent: 3,
    failed: 0,
    uncertain: 0,
    overflow: 0,
    ...overrides,
  };
}

function summary(
  profiles: ProfileDigestSummary[],
  errorCode: DigestSummary["errorCode"] = null,
): DigestSummary {
  return {
    digestDate: "2026-11-01",
    transport: "test",
    dryRun: false,
    candidates: 10,
    candidatesTruncated: false,
    skippedInvalidRows: 0,
    errorCode,
    profiles,
  };
}

/**
 * Runs the CLI with a database stub (the lock returns a canned result; the
 * real run is covered by tests/integration/digest.test.ts) and a sender
 * factory that counts its calls and must never send.
 */
async function run(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    lock?: LockResult<DigestSummary>;
    pending?: string[];
    withoutDigestSupport?: boolean;
  } = {},
) {
  const calls = { opened: 0, closed: 0, lockAttempts: 0, senders: 0, senderClosed: 0 };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    pendingMigrations: () => Promise.resolve(options.pending ?? []),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    withDigestLock: <T>() => {
      calls.lockAttempts++;
      return Promise.resolve((options.lock ?? { acquired: false }) as LockResult<T>);
    },
  };
  if (options.withoutDigestSupport === true) delete database.withDigestLock;
  const digest: CliDigestDeps = {
    createSender: (): EmailSender => {
      calls.senders++;
      return {
        transport: "test",
        send: () => Promise.reject(new Error("no sending in unit tests")),
        close: () => {
          calls.senderClosed++;
        },
      };
    },
    now: () => NOW,
    sleep: () => Promise.resolve(),
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
    {
      openDatabase: () => {
        calls.opened++;
        return database;
      },
      digest,
    },
  );
  return { code, stdout, stderr, calls };
}

describe("digest arguments", () => {
  it.each([
    [["digest", "--verbose"], 'Unexpected argument: "--verbose"'],
    [["digest", "now"], 'Unexpected argument: "now"'],
    [["digest", "--profile"], "Option --profile needs a profile id (uuid)."],
    [
      ["digest", "--profile", "kontakt@example.invalid"],
      "Option --profile needs a profile id (uuid).",
    ],
    [["digest", "--profile", "--dry-run"], "Option --profile needs a profile id (uuid)."],
    [["digest", "--dry-run", "--dry-run"], "Option --dry-run given twice."],
    [["digest", "--profile", PROFILE_ID, "--profile", PROFILE_ID], "Option --profile given twice."],
  ])("%j is a usage error before anything is opened", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr.startsWith(`${message}\n`)).toBe(true);
    expect(result.calls).toMatchObject({ opened: 0, senders: 0 });
  });

  it("is listed in the help text", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toContain("digest [--dry-run] [--profile <profileId>]");
  });
});

describe("digest configuration", () => {
  it("needs EMAIL_FROM and SMTP_URL for smtp, before the database is opened", async () => {
    const result = await run(["digest"], { env: { EMAIL_MODE: "smtp" } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid e-mail configuration: EMAIL_FROM, SMTP_URL\n");
    expect(result.calls).toMatchObject({ opened: 0, senders: 0 });
  });

  it("refuses a plaintext-only or malformed SMTP_URL without echoing it", async () => {
    const result = await run(["digest"], {
      env: {
        EMAIL_MODE: "smtp",
        EMAIL_FROM: "kontakt@example.invalid",
        SMTP_URL: `http://user:${SMTP_PASSWORD}@smtp.example.invalid`,
      },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid e-mail configuration: SMTP_URL\n");
    expect(result.stderr).not.toContain(SMTP_PASSWORD);
    expect(result.calls.opened).toBe(0);
  });

  it("validates the e-mail configuration in a dry run too", async () => {
    const result = await run(["digest", "--dry-run"], { env: { EMAIL_MODE: "smtp" } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.calls.opened).toBe(0);
  });

  it("does not read the e-mail variables for other commands", async () => {
    const result = await run(["migrate"], { env: { EMAIL_MODE: "smtp" } });
    expect(result.code).toBe(ExitCode.Ok);
  });
});

describe("digest run", () => {
  it("refuses an outdated schema before taking the lock", async () => {
    const result = await run(["digest"], { pending: ["0005_deliveries"] });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Digest failed: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls).toMatchObject({ lockAttempts: 0, closed: 1, senderClosed: 1 });
  });

  it("skips with exit 0 while another run holds the lock", async () => {
    const result = await run(["digest"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "skipped",
      reason: "lock_busy",
      dryRun: false,
      profiles: [],
    });
    expect(result.stderr).toContain("Digest skipped: another digest run holds the lock");
    expect(result.calls).toMatchObject({ lockAttempts: 1, closed: 1, senders: 1, senderClosed: 1 });
  });

  it("prints one JSON summary and exits 0 when every e-mail went out", async () => {
    const value = summary([profileSummary(), profileSummary({ status: "nothing_new", sent: 0 })]);
    const result = await run(["digest"], { lock: { acquired: true, value, lockLost: false } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", ...value });
  });

  it.each(["failed", "uncertain", "not_found", "invalid_profile", "not_run"] as const)(
    "exits 1 when a profile is %s, naming its id and code",
    async (status) => {
      const value = summary([
        profileSummary(),
        profileSummary({ status, sent: 0, errorCode: "smtp_550" }),
      ]);
      const result = await run(["digest"], { lock: { acquired: true, value, lockLost: false } });
      expect(result.code).toBe(ExitCode.Failure);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
      expect(result.stderr).toBe(`Digest failed for: ${PROFILE_ID} (smtp_550)\n`);
    },
  );

  it("exits 1 with the stop code when the run stopped at a setup failure", async () => {
    const value = summary(
      [
        profileSummary({ status: "failed", sent: 0, failed: 3, errorCode: "smtp_535" }),
        profileSummary({ profileId: "00000000-0000-4000-8000-0000000000bb", status: "not_run" }),
      ],
      "send_setup_failed",
    );
    const result = await run(["digest"], { lock: { acquired: true, value, lockLost: false } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      errorCode: "send_setup_failed",
    });
    expect(result.stderr).toContain("Digest stopped (send_setup_failed)");
    expect(result.stderr).toContain(
      `Digest failed for: ${PROFILE_ID} (smtp_535), 00000000-0000-4000-8000-0000000000bb (not_run)`,
    );
  });

  it("names the number of pending deliveries on stderr, keeping the exit code and the JSON", async () => {
    const value = summary([
      profileSummary({ uncertain: 2 }),
      profileSummary({
        profileId: "00000000-0000-4000-8000-0000000000bb",
        status: "pending_today",
        sent: 0,
        uncertain: 1,
      }),
    ]);
    const result = await run(["digest"], { lock: { acquired: true, value, lockLost: false } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", ...value });
    expect(result.stderr).toBe(
      "Digest: 3 deliveries are pending and need an operator decision (README „Wynik niepewny”).\n",
    );
  });

  it("says nothing about pending deliveries when there are none", async () => {
    const value = summary([profileSummary()]);
    const result = await run(["digest"], { lock: { acquired: true, value, lockLost: false } });
    expect(result.stderr).toBe("");
  });

  it("exits 1 when the lock was lost", async () => {
    const value = summary([profileSummary()]);
    const result = await run(["digest"], { lock: { acquired: true, value, lockLost: true } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
    expect(result.stderr).toContain("(lock_lost)");
  });

  it("creates no sender in a dry run", async () => {
    const value = { ...summary([profileSummary({ status: "dry_run", sent: 0 })]), dryRun: true };
    const result = await run(["digest", "--dry-run"], {
      lock: { acquired: true, value, lockLost: false },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.senders).toBe(0);
  });

  it("fails safely when the database cannot run digest", async () => {
    const result = await run(["digest"], { withoutDigestSupport: true });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
    expect(result.calls.closed).toBe(1);
  });
});
