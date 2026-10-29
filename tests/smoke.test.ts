import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

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
 */
describe("smoke: application entry point", { timeout: TEST_TIMEOUT_MS }, () => {
  it("`health` exits 0 and prints status ok", async () => {
    const { stdout } = await runEntryPoint({ args: ["health"], env: { NODE_ENV: "test" } });
    expect(JSON.parse(stdout)).toMatchObject({ status: "ok", service: "radar-zamowien" });
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

  it("lets real environment variables take precedence over the env file", async () => {
    const { stdout } = await runEntryPoint({
      nodeFlags,
      args: ["health"],
      env: { LOG_LEVEL: "warn" },
    });
    // NODE_ENV still comes from the file; LOG_LEVEL=bogus was overridden.
    expect(JSON.parse(stdout)).toMatchObject({ status: "ok", environment: "test" });
  });

  it("starts normally when the env file does not exist", async () => {
    const { stdout } = await runEntryPoint({
      nodeFlags: [`--env-file-if-exists=${join(dir, "missing.env")}`],
      args: ["health"],
      env: {},
    });
    expect(JSON.parse(stdout)).toMatchObject({ status: "ok", environment: "development" });
  });
});
