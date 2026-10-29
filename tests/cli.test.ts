import { describe, expect, it } from "vitest";
import { ExitCode, INTERNAL_ERROR_MESSAGE, runCli, type CliDatabase } from "../src/cli.js";
import { MigrationError } from "../src/infrastructure/db/database.js";

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";

/** In-memory stand-in for the database; records what the CLI did with it. */
function stubDatabase(overrides: Partial<CliDatabase> = {}) {
  const calls = { opened: [] as string[], closed: 0 };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  const deps = {
    openDatabase: (url: string) => {
      calls.opened.push(url);
      return database;
    },
  };
  return { calls, deps };
}

/**
 * Runs the CLI with a stub database. DATABASE_URL is provided unless the test
 * sets it explicitly, so tests about other variables stay focused on them.
 */
async function run(
  args: string[],
  env: Record<string, string> = {},
  stub: ReturnType<typeof stubDatabase> = stubDatabase(),
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL, ...env },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    stub.deps,
  );
  return { code, stdout, stderr, calls: stub.calls };
}

describe("runCli", () => {
  it("health prints a JSON report and exits 0", async () => {
    const result = await run(["health"], { NODE_ENV: "test" });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      service: "radar-zamowien",
      environment: "test",
      database: { status: "ok" },
    });
    expect(result.stderr).toBe("");
  });

  it("health rejects extra arguments", async () => {
    const result = await run(["health", "--verbose"]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Command "health" takes no arguments.');
    expect(result.stderr).toContain("Usage:");
  });

  it("prints usage and exits 2 without a command", async () => {
    const result = await run([]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stdout).toContain("Usage:");
  });

  it("prints usage and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain("health");
  });

  it("rejects unknown commands with exit 2", async () => {
    const result = await run(["crawl-everything"]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Unknown command: "crawl-everything"');
  });

  it("exits 1 with a readable message on invalid configuration", async () => {
    const result = await run(["health"], { LOG_LEVEL: "verbose" });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("LOG_LEVEL");
    expect(result.stdout).toBe("");
  });

  it("does not echo an invalid configuration value", async () => {
    const secretLookingValue = "s3cr3t-value-should-not-leak";
    const result = await run(["health"], { NODE_ENV: secretLookingValue });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("NODE_ENV");
    expect(result.stderr).not.toContain(secretLookingValue);
    expect(result.stdout).not.toContain(secretLookingValue);
  });

  it("reports an unknown command as a usage error even when configuration is invalid", async () => {
    const result = await run(["nope"], { NODE_ENV: "staging" });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Unknown command: "nope"');
    expect(result.stderr).not.toContain("Invalid environment configuration");
  });

  it("reports extra health arguments as a usage error even when configuration is invalid", async () => {
    const result = await run(["health", "extra"], { LOG_LEVEL: "bogus" });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Command "health" takes no arguments.');
    expect(result.stderr).not.toContain("Invalid environment configuration");
  });

  it("treats empty configuration values as unset and uses defaults", async () => {
    const result = await run(["health"], { NODE_ENV: "", LOG_LEVEL: "" });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ environment: "development" });
    expect(result.stderr).toBe("");
  });

  it("health opens the database from DATABASE_URL and closes it", async () => {
    const result = await run(["health"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.opened).toEqual([DATABASE_URL]);
    expect(result.calls.closed).toBe(1);
  });

  it("health exits 1 with an error report when the database check fails", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const stub = stubDatabase({ ping: () => Promise.reject(refused) });
    const result = await run(["health"], { NODE_ENV: "test" }, stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "error",
      service: "radar-zamowien",
      environment: "test",
      database: { status: "error", reason: "unreachable", code: "ECONNREFUSED" },
    });
    expect(result.stderr).toBe("Database check failed: unreachable (ECONNREFUSED)\n");
    expect(result.calls.closed).toBe(1);
  });

  it("never prints the raw database error message (it may contain secrets)", async () => {
    const leakyMessage = `cannot connect to ${DATABASE_URL}`;
    const stub = stubDatabase({ ping: () => Promise.reject(new Error(leakyMessage)) });
    const result = await run(["health"], {}, stub);
    expect(result.code).toBe(ExitCode.Failure);
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("not-a-real-password");
      expect(output).not.toContain(leakyMessage);
    }
  });

  it("does not open the database for usage or configuration errors", async () => {
    for (const [args, env] of [
      [["nope"], {}],
      [["health", "extra"], {}],
      [["--help"], {}],
      [["health"], { LOG_LEVEL: "bogus" }],
    ] as const) {
      const result = await run([...args], env);
      expect(result.calls.opened).toEqual([]);
    }
  });

  it("exits 1 naming DATABASE_URL when it is missing", async () => {
    const result = await run(["health"], { DATABASE_URL: "" });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.calls.opened).toEqual([]);
  });

  it("rejects a non-PostgreSQL DATABASE_URL without echoing it", async () => {
    const value = "mysql://radar:s3cr3t-value-should-not-leak@localhost/radar";
    const result = await run(["migrate"], { DATABASE_URL: value });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).not.toContain("s3cr3t-value-should-not-leak");
    expect(result.stdout).toBe("");
  });

  describe("migrate", () => {
    it("prints the applied migrations and exits 0", async () => {
      const stub = stubDatabase({ migrate: () => Promise.resolve(["0001_core_schema"]) });
      const result = await run(["migrate"], {}, stub);
      expect(result.code).toBe(ExitCode.Ok);
      expect(JSON.parse(result.stdout)).toEqual({ status: "ok", applied: ["0001_core_schema"] });
      expect(result.stderr).toBe("");
      expect(result.calls.closed).toBe(1);
    });

    it("reports nothing applied when the schema is up to date", async () => {
      const result = await run(["migrate"]);
      expect(result.code).toBe(ExitCode.Ok);
      expect(JSON.parse(result.stdout)).toEqual({ status: "ok", applied: [] });
    });

    it("rejects extra arguments", async () => {
      const result = await run(["migrate", "down"]);
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.stderr).toContain('Command "migrate" takes no arguments.');
    });

    it("exits 1 naming the failed migration, without the raw error", async () => {
      const cause = Object.assign(new Error(`relation exists; url=${DATABASE_URL}`), {
        code: "42P07",
      });
      const stub = stubDatabase({
        migrate: () => Promise.reject(new MigrationError("0001_core_schema", cause)),
      });
      const result = await run(["migrate"], {}, stub);
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('Migration failed in "0001_core_schema"');
      expect(result.stderr).not.toContain("not-a-real-password");
      expect(result.stderr).not.toContain("relation exists");
      expect(result.calls.closed).toBe(1);
    });

    it("closes the database when the run fails before any migration", async () => {
      const stub = stubDatabase({ migrate: () => Promise.reject(new Error("boom")) });
      const result = await run(["migrate"], {}, stub);
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toBe("Migration failed: unknown\n");
      expect(result.calls.closed).toBe(1);
    });
  });

  describe("unexpected errors", () => {
    it("become exit 1 with a fixed message, never the error itself", async () => {
      const deps = {
        openDatabase: () => {
          throw new Error(`bug while opening ${DATABASE_URL}`);
        },
      };
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        ["health"],
        { env: { DATABASE_URL }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
        deps,
      );
      expect(code).toBe(ExitCode.Failure);
      expect(stderr).toBe(INTERNAL_ERROR_MESSAGE);
      expect(stdout).toBe("");
      expect(stderr).not.toContain("not-a-real-password");
    });

    it("a failing close is reported the same way", async () => {
      const stub = stubDatabase({
        close: () => Promise.reject(new Error(`close failed for ${DATABASE_URL}`)),
      });
      const result = await run(["migrate"], {}, stub);
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
      expect(result.stderr).not.toContain("not-a-real-password");
    });
  });
});
