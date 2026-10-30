import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCliDeps, ExitCode, runCli } from "../../src/cli.js";
import {
  createTestSchema,
  requireTestDatabaseUrl,
  skipWithoutDatabase,
  type TestSchema,
  unreachableDatabaseUrl,
} from "./test-database.js";

/** Runs the CLI in-process with the production database wiring. */
async function run(args: string[], databaseUrl: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { NODE_ENV: "test", DATABASE_URL: databaseUrl },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    defaultCliDeps,
  );
  return { code, stdout, stderr };
}

describe.skipIf(skipWithoutDatabase)("CLI with a real database (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  it("health reports the database as ok", async () => {
    const result = await run(["health"], requireTestDatabaseUrl());
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      service: "radar-zamowien",
      environment: "test",
      database: { status: "ok" },
    });
    expect(result.stderr).toBe("");
  });

  it("migrate applies pending migrations, then reports nothing to apply", async () => {
    const first = await run(["migrate"], schema.url);
    expect(first.code).toBe(ExitCode.Ok);
    expect(JSON.parse(first.stdout)).toEqual({
      status: "ok",
      applied: ["0001_core_schema", "0002_ingestion_runs"],
    });

    const second = await run(["migrate"], schema.url);
    expect(second.code).toBe(ExitCode.Ok);
    expect(JSON.parse(second.stdout)).toEqual({ status: "ok", applied: [] });
  });

  it("migrate explains a search_path that names no existing schema", async () => {
    const url = new URL(requireTestDatabaseUrl());
    url.searchParams.set("options", "-c search_path=schema_that_does_not_exist");
    const result = await run(["migrate"], url.toString());
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Migration failed: no_current_schema\n");
  });

  it("health exits 1 on wrong credentials without revealing the password", async () => {
    const url = new URL(requireTestDatabaseUrl());
    url.password = "wr0ng-Passw0rd-must-not-leak";
    const result = await run(["health"], url.toString());
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      database: { status: "error", reason: "authentication_failed", code: "28P01" },
    });
    expect(result.stdout + result.stderr).not.toContain("wr0ng-Passw0rd-must-not-leak");
  });
});

// No database needed: the address refuses connections.
describe("CLI with an unreachable database", () => {
  it("health exits 1 without revealing the password", async () => {
    const password = "Unr3achable-Passw0rd-must-not-leak";
    const result = await run(["health"], unreachableDatabaseUrl(password));
    expect(result.code).toBe(ExitCode.Failure);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      database: { status: "error", reason: "unreachable", code: "ECONNREFUSED" },
    });
    expect(result.stderr).toBe("Database check failed: unreachable (ECONNREFUSED)\n");
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it("migrate exits 1 without revealing the password", async () => {
    const password = "Unr3achable-Passw0rd-must-not-leak";
    const result = await run(["migrate"], unreachableDatabaseUrl(password));
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Migration failed: unreachable (ECONNREFUSED)\n");
    expect(result.stderr).not.toContain(password);
  });
});
