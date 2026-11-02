import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExitCode,
  INTERNAL_ERROR_MESSAGE,
  runCli,
  type CliDatabase,
  type CliDigestDeps,
} from "../src/cli.js";
import { BackupError, type BackupResult, type RestoreResult } from "../src/operations/backup.js";
import { evaluateStatus, type StatusReport } from "../src/operations/status.js";
import {
  createEmailSender,
  EmailSendError,
  type OutgoingEmail,
} from "../src/notifications/sender.js";

// Pseudonymised values only; `.invalid` never resolves.
const DB_PASSWORD = "not-a-real-db-password";
const DATABASE_URL = `postgres://radar:${DB_PASSWORD}@db.example.invalid:5432/radar`;
const OPERATOR = "operator@example.invalid";
const NOW = new Date("2026-11-02T07:00:00.000Z");

const OK_REPORT: StatusReport = evaluateStatus({
  now: NOW,
  sources: [
    {
      sourceId: "bzp",
      lastRun: {
        runId: "00000000-0000-4000-8000-000000000001",
        status: "succeeded",
        publicationDate: "2026-11-01",
        startedAt: new Date("2026-11-02T05:00:00.000Z"),
        finishedAt: new Date("2026-11-02T05:01:00.000Z"),
        errorCode: null,
      },
      lastSuccessAt: new Date("2026-11-02T05:01:00.000Z"),
    },
  ],
  failedDays: [],
  deliveries: {
    pending: 0,
    failed: 0,
    failedExhausted: 0,
    failedErrorCodes: [],
    digestRunning: false,
  },
  failedSince: "2026-11-01",
});
const PROBLEM_REPORT: StatusReport = {
  ...OK_REPORT,
  status: "problem",
  problems: ["deliveries_failed"],
};

interface Options {
  env?: Record<string, string | undefined>;
  report?: StatusReport;
  /** Thrown by collectStatus. */
  collectError?: Error;
  pending?: string[];
  /** Results of the sender's send calls, in order (default: success). */
  sends?: (Error | null)[];
  backup?: BackupResult | Error;
  restore?: RestoreResult | Error;
  /** The real sender (EMAIL_MODE=test: the outbox) instead of the fake one. */
  realSender?: boolean;
}

/**
 * Runs the CLI with a database stub and a fake sender (nothing is sent, not
 * even to the outbox): records what was opened, sent and passed on.
 */
async function run(args: string[], options: Options = {}) {
  const calls = {
    opened: 0,
    closed: 0,
    collected: 0,
    senders: 0,
    senderClosed: 0,
    sent: [] as OutgoingEmail[],
    toolEnv: null as Readonly<Record<string, string | undefined>> | null,
    backupDir: null as string | null,
    restoreFile: null as string | null,
  };
  const sends = [...(options.sends ?? [])];
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    pendingMigrations: () => Promise.resolve(options.pending ?? []),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    collectStatus: (now) => {
      calls.collected++;
      expect(now).toEqual(NOW);
      if (options.collectError !== undefined) return Promise.reject(options.collectError);
      return Promise.resolve(options.report ?? OK_REPORT);
    },
    backup: (dir, now, toolOptions) => {
      calls.backupDir = dir;
      calls.toolEnv = toolOptions.env;
      expect(now).toEqual(NOW);
      const result = options.backup ?? new Error("backup not expected");
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    restore: (file, toolOptions) => {
      calls.restoreFile = file;
      calls.toolEnv = toolOptions.env;
      const result = options.restore ?? new Error("restore not expected");
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  const digest: CliDigestDeps = {
    createSender: (config) => {
      calls.senders++;
      if (options.realSender === true) return createEmailSender(config);
      return {
        transport: "test",
        send: (email) => {
          calls.sent.push(email);
          const outcome = sends.shift() ?? null;
          return outcome === null ? Promise.resolve() : Promise.reject(outcome);
        },
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
      env: { DATABASE_URL, LOG_LEVEL: "error", ...options.env },
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

function json(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("status, backup and restore arguments", () => {
  it.each([
    [["status", "--verbose"], 'Unexpected argument: "--verbose"'],
    [["status", "--notify", "--notify"], 'Unexpected argument: "--notify"'],
    [["status", "now"], 'Unexpected argument: "now"'],
    [["backup"], 'Command "backup" needs a directory.'],
    [["backup", ""], 'Command "backup" needs a directory.'],
    [["backup", "--schema=public"], 'Command "backup" needs a directory.'],
    [["backup", "/var/backups", "extra"], 'Unexpected argument: "extra"'],
    [["restore"], 'Command "restore" needs a backup file.'],
    [["restore", "-f"], 'Command "restore" needs a backup file.'],
    [["restore", "a.dump", "b.dump"], 'Unexpected argument: "b.dump"'],
  ])("%j is a usage error before anything is opened", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr.startsWith(`${message}\n`)).toBe(true);
    expect(result.calls.opened).toBe(0);
  });

  it("is listed in the help text", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toContain("status [--notify]");
    expect(result.stdout).toContain("backup <dir>");
    expect(result.stdout).toContain("restore <file>");
  });
});

describe("status", () => {
  it("prints the report as one JSON line and exits 0 when there is no problem", async () => {
    const result = await run(["status"]);
    expect(result.code).toBe(ExitCode.Ok);
    const report = json(result.stdout);
    expect(report).toMatchObject({ status: "ok", problems: [], notification: null });
    expect(report.checkedAt).toBe(NOW.toISOString());
    expect(result.stderr).toBe("");
    expect(result.calls).toMatchObject({ opened: 1, closed: 1, collected: 1, senders: 0 });
  });

  it("exits 1 with the problem codes on stderr when there is a problem", async () => {
    const result = await run(["status"], { report: PROBLEM_REPORT });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({
      status: "problem",
      problems: ["deliveries_failed"],
    });
    expect(result.stderr).toBe("Status: problem (deliveries_failed); see docs/RUNBOOK.md.\n");
    expect(result.calls.senders).toBe(0);
  });

  it("reports a schema that is not migrated without reading it", async () => {
    const result = await run(["status"], { pending: ["0001_init"] });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({
      status: "problem",
      problems: ["schema_not_ready"],
      sources: null,
      deliveries: null,
    });
    expect(result.calls.collected).toBe(0);
  });

  it("reports a database that cannot be read, without its URL", async () => {
    const result = await run(["status"], {
      collectError: Object.assign(new Error(`connect ECONNREFUSED ${DATABASE_URL}`), {
        code: "ECONNREFUSED",
      }),
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({
      status: "problem",
      problems: ["database_unavailable"],
      database: { reason: "unreachable", code: "ECONNREFUSED" },
    });
    expect(result.stdout + result.stderr).not.toContain(DB_PASSWORD);
    expect(result.calls.closed).toBe(1);
  });

  it("fails with the fixed internal message on an unexpected error", async () => {
    const result = await run(["status"], { collectError: new Error(DATABASE_URL) });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
    expect(result.stdout).toBe("");
    // Without --notify nothing is sent.
    expect(result.calls.senders).toBe(0);
  });
});

describe("status --notify", () => {
  const env = { OPERATOR_EMAIL: OPERATOR };

  it("needs OPERATOR_EMAIL, before the database is opened", async () => {
    const result = await run(["status", "--notify"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("OPERATOR_EMAIL is required for status --notify.\n");
    expect(result.calls.opened).toBe(0);
  });

  it("refuses an invalid OPERATOR_EMAIL naming the variable only", async () => {
    const value = "operator@example.invalid\r\nBcc: x@example.invalid";
    const result = await run(["status", "--notify"], { env: { OPERATOR_EMAIL: value } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid e-mail configuration: OPERATOR_EMAIL\n");
    expect(result.calls.opened).toBe(0);
  });

  it("validates the e-mail configuration too", async () => {
    const result = await run(["status", "--notify"], { env: { ...env, EMAIL_MODE: "smtp" } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid e-mail configuration: EMAIL_FROM, SMTP_URL\n");
    expect(result.calls.opened).toBe(0);
  });

  it("does not read OPERATOR_EMAIL or the e-mail variables without --notify", async () => {
    const result = await run(["status"], {
      env: { OPERATOR_EMAIL: "not-an-address", EMAIL_MODE: "smtp" },
    });
    expect(result.code).toBe(ExitCode.Ok);
  });

  it("sends nothing when there is no problem", async () => {
    const result = await run(["status", "--notify"], { env });
    expect(result.code).toBe(ExitCode.Ok);
    expect(json(result.stdout)).toMatchObject({ status: "ok", notification: "not_needed" });
    expect(result.calls.senders).toBe(0);
  });

  it("sends one plain-text alert without List-Unsubscribe when there is a problem", async () => {
    const result = await run(["status", "--notify"], { env, report: PROBLEM_REPORT });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({ status: "problem", notification: "sent" });
    expect(result.calls).toMatchObject({ senders: 1, senderClosed: 1 });
    expect(result.calls.sent).toHaveLength(1);
    const [email] = result.calls.sent;
    expect(email).toMatchObject({
      to: OPERATOR,
      subject: "Radar Zamówień: problem (deliveries_failed)",
      listUnsubscribe: false,
    });
    expect(email).not.toHaveProperty("html");
    expect(email).not.toHaveProperty("unsubscribeUrl");
    expect(email?.text).toContain("docs/RUNBOOK.md");
  });

  it("alerts on a database that cannot be read", async () => {
    const result = await run(["status", "--notify"], {
      env,
      collectError: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.calls.sent[0]?.subject).toBe("Radar Zamówień: problem (database_unavailable)");
  });

  it("alerts an unexpected error by its fixed code only, into the outbox", async () => {
    const outbox = await mkdtemp(join(tmpdir(), "radar-status-outbox-"));
    try {
      const detail = "Qx7-internal-failure-detail";
      const result = await run(["status", "--notify"], {
        env: { ...env, EMAIL_MODE: "test", EMAIL_OUTBOX_DIR: outbox },
        collectError: new Error(`${detail} ${DATABASE_URL}`),
        realSender: true,
      });
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
      expect(result.stdout).toBe("");
      const files = (await readdir(outbox)).sort();
      expect(files).toHaveLength(2);
      const jsonFile = files.find((name) => name.endsWith(".json"));
      expect(jsonFile).toBeDefined();
      const sent = JSON.parse(await readFile(join(outbox, String(jsonFile)), "utf8")) as Record<
        string,
        unknown
      >;
      expect(sent).toMatchObject({
        to: OPERATOR,
        subject: "Radar Zamówień: problem (status_internal_error)",
        html: null,
      });
      expect(sent.text).toContain("Problemy: status_internal_error\n");
      for (const name of files) {
        const content = await readFile(join(outbox, name), "utf8");
        for (const secret of [detail, DB_PASSWORD, DATABASE_URL]) {
          expect(content).not.toContain(secret);
        }
      }
    } finally {
      await rm(outbox, { recursive: true, force: true });
    }
  });

  it("still exits 1 with the internal message when that alert cannot be sent", async () => {
    const result = await run(["status", "--notify"], {
      env,
      collectError: new Error(DATABASE_URL),
      sends: [new EmailSendError("smtp_rejected", "permanent")],
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      `Operator alert not sent (smtp_rejected).\n${INTERNAL_ERROR_MESSAGE}`,
    );
    expect(result.calls.sent[0]?.subject).toBe("Radar Zamówień: problem (status_internal_error)");
    expect(result.calls.senderClosed).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("retries a transient failure, like digest", async () => {
    const result = await run(["status", "--notify"], {
      env,
      report: PROBLEM_REPORT,
      sends: [new EmailSendError("smtp_transient", "transient"), null],
    });
    expect(json(result.stdout)).toMatchObject({ notification: "sent" });
    expect(result.calls.sent).toHaveLength(2);
  });

  it("exits 1 with a fixed reason when the alert cannot be sent, still printing the report", async () => {
    const result = await run(["status", "--notify"], {
      env,
      report: PROBLEM_REPORT,
      sends: [new EmailSendError("smtp_rejected", "permanent")],
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({ status: "problem", notification: "failed" });
    expect(result.stderr).toContain("Operator alert not sent (smtp_rejected).\n");
    expect(result.calls.senderClosed).toBe(1);
  });
});

describe("backup", () => {
  it("prints the file as one JSON line, warns about personal data, and gets the environment", async () => {
    const result = await run(["backup", "/var/backups/radar"], {
      env: { PATH: "/usr/bin" },
      backup: {
        file: "/var/backups/radar/radar-20261102T070000Z.dump",
        bytes: 1234,
        schema: "public",
        tables: 7,
      },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(json(result.stdout)).toMatchObject({
      status: "ok",
      file: "/var/backups/radar/radar-20261102T070000Z.dump",
      bytes: 1234,
      schema: "public",
      tables: 7,
    });
    expect(result.stderr).toContain("personal data");
    expect(result.calls.backupDir).toBe("/var/backups/radar");
    expect(result.calls.toolEnv?.PATH).toBe("/usr/bin");
  });

  it("reports a failure with its fixed reason only", async () => {
    const result = await run(["backup", "/var/backups/radar"], {
      backup: new BackupError("authentication_failed", "exit 1"),
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Backup failed: the database refused the login (authentication_failed, exit 1).\n",
    );
  });

  it("reports a database failure by its reason and code", async () => {
    const result = await run(["backup", "/var/backups/radar"], {
      backup: Object.assign(new Error(DATABASE_URL), { code: "ECONNREFUSED" }),
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Backup failed: database unreachable (ECONNREFUSED).\n");
  });
});

describe("restore", () => {
  it("prints the row counts as one JSON line", async () => {
    const result = await run(["restore", "radar.dump"], {
      restore: { schema: "public", tables: { sources: 1, deliveries: 0 }, pendingMigrations: [] },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(json(result.stdout)).toMatchObject({
      status: "ok",
      schema: "public",
      tables: { sources: 1, deliveries: 0 },
      pendingMigrations: [],
    });
    expect(result.calls.restoreFile).toBe("radar.dump");
  });

  it("exits 1 when the restored schema still lacks migrations", async () => {
    const result = await run(["restore", "radar.dump"], {
      restore: { schema: "public", tables: { sources: 1 }, pendingMigrations: ["0009_x"] },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(json(result.stdout)).toMatchObject({ status: "not_migrated" });
    expect(result.stderr).toContain("run `migrate`");
  });

  it("refuses a target that is not empty", async () => {
    const result = await run(["restore", "radar.dump"], {
      restore: new BackupError("target_not_empty"),
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Restore failed: the target schema is not empty; restore only into an empty schema (target_not_empty).\n",
    );
  });
});
