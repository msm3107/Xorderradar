import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  requireTestDatabaseUrl,
  skipWithoutDatabase,
  unreachableDatabaseUrl,
} from "./integration/test-database.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// The child is killed after CHILD_TIMEOUT_MS; each test gets a little more so a
// hang surfaces as the child's timeout error rather than a generic test timeout.
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000;

interface EntryPointRun {
  readonly nodeFlags?: readonly string[];
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Runs `node [flags] --import tsx src/main.ts <args>` with an explicit, minimal
 * environment (PATH + the given variables). Never passes the project's .env, so
 * results do not depend on a developer's local configuration.
 */
function runEntryPoint({ nodeFlags = [], args, env }: EntryPointRun) {
  return execFileAsync(
    process.execPath,
    [...nodeFlags, "--import", "tsx", "src/main.ts", ...args],
    { cwd: projectRoot, env: { PATH: process.env.PATH, ...env }, timeout: CHILD_TIMEOUT_MS },
  );
}

/** Resolves with the child's error (exit code, stdout, stderr) when it fails. */
async function expectFailure(run: ReturnType<typeof runEntryPoint>) {
  const outcome: unknown = await run.then(
    () => "unexpected success",
    (error: unknown) => error,
  );
  expect(outcome).not.toBe("unexpected success");
  return outcome as { code: unknown; stdout: string; stderr: string };
}

/**
 * End-to-end smoke test: starts the real entry point in a separate Node process,
 * exactly as cron/operators will, and checks the health command's contract.
 * Runs that need a reachable database use TEST_DATABASE_URL and are skipped
 * (with a notice) without it.
 */
describe("smoke: application entry point", { timeout: TEST_TIMEOUT_MS }, () => {
  it.skipIf(skipWithoutDatabase)("`health` exits 0 and prints status ok", async () => {
    const { stdout } = await runEntryPoint({
      args: ["health"],
      env: { NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl() },
    });
    expect(JSON.parse(stdout)).toMatchObject({ status: "ok", service: "radar-zamowien" });
  });

  it("`health` exits 1 when the database is unreachable, without revealing the password", async () => {
    const password = "Sm0ke-Passw0rd-must-not-leak";
    const failure = await expectFailure(
      runEntryPoint({
        args: ["health"],
        env: { NODE_ENV: "test", DATABASE_URL: unreachableDatabaseUrl(password) },
      }),
    );
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      status: "error",
      database: { status: "error", reason: "unreachable" },
    });
    expect(failure.stderr).toContain("Database check failed: unreachable");
    expect(failure.stdout).not.toContain(password);
    expect(failure.stderr).not.toContain(password);
  });

  it("an unknown command exits with code 2", async () => {
    await expect(
      runEntryPoint({ args: ["nope"], env: { NODE_ENV: "test" } }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("invalid configuration exits with code 1 without echoing the value", async () => {
    const secretLookingValue = "s3cr3t-value-should-not-leak";
    const failure = await expectFailure(
      runEntryPoint({ args: ["health"], env: { LOG_LEVEL: secretLookingValue } }),
    );
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("LOG_LEVEL");
    expect(failure.stderr).not.toContain(secretLookingValue);
  });
});

/**
 * The pnpm scripts dev/health/start load `.env` with Node's built-in
 * `--env-file-if-exists`. These runs use the same flag with a temporary file
 * (never the project's .env) to pin down the behaviour the docs describe.
 */
describe("smoke: env file loading", { timeout: TEST_TIMEOUT_MS }, () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-env-"));
  const envFile = join(dir, "test.env");
  writeFileSync(envFile, "NODE_ENV=test\nLOG_LEVEL=bogus\n");
  const nodeFlags = [`--env-file-if-exists=${envFile}`];
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies values from the env file", async () => {
    const failure = await expectFailure(runEntryPoint({ nodeFlags, args: ["health"], env: {} }));
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("LOG_LEVEL");
  });

  /*
   * The next two runs need no database: an unreachable DATABASE_URL makes
   * `health` exit 1, but only after the configuration (env file + environment)
   * loaded successfully, which is what they check. A configuration error
   * would print no JSON report at all.
   */
  it("lets real environment variables take precedence over the env file", async () => {
    const failure = await expectFailure(
      runEntryPoint({
        nodeFlags,
        args: ["health"],
        env: { LOG_LEVEL: "warn", DATABASE_URL: unreachableDatabaseUrl("pw") },
      }),
    );
    expect(failure.code).toBe(1);
    // NODE_ENV still comes from the file; LOG_LEVEL=bogus was overridden.
    expect(JSON.parse(failure.stdout)).toMatchObject({
      environment: "test",
      database: { status: "error", reason: "unreachable" },
    });
    expect(failure.stderr).not.toContain("Invalid environment configuration");
  });

  it("starts normally when the env file does not exist", async () => {
    const failure = await expectFailure(
      runEntryPoint({
        nodeFlags: [`--env-file-if-exists=${join(dir, "missing.env")}`],
        args: ["health"],
        env: { DATABASE_URL: unreachableDatabaseUrl("pw") },
      }),
    );
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      environment: "development",
      database: { status: "error", reason: "unreachable" },
    });
    expect(failure.stderr).not.toContain("Invalid environment configuration");
  });
});
