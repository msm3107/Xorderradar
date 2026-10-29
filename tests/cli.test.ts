import { describe, expect, it } from "vitest";
import { ExitCode, runCli } from "../src/cli.js";

function run(args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, {
    env,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

describe("runCli", () => {
  it("health prints a JSON report and exits 0", () => {
    const result = run(["health"], { NODE_ENV: "test" });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      service: "radar-zamowien",
      environment: "test",
    });
    expect(result.stderr).toBe("");
  });

  it("health rejects extra arguments", () => {
    const result = run(["health", "--verbose"]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Command "health" takes no arguments.');
    expect(result.stderr).toContain("Usage:");
  });

  it("prints usage and exits 2 without a command", () => {
    const result = run([]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stdout).toContain("Usage:");
  });

  it("prints usage and exits 0 for --help", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain("health");
  });

  it("rejects unknown commands with exit 2", () => {
    const result = run(["crawl-everything"]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Unknown command: "crawl-everything"');
  });

  it("exits 1 with a readable message on invalid configuration", () => {
    const result = run(["health"], { LOG_LEVEL: "verbose" });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("LOG_LEVEL");
    expect(result.stdout).toBe("");
  });

  it("does not echo an invalid configuration value", () => {
    const secretLookingValue = "s3cr3t-value-should-not-leak";
    const result = run(["health"], { NODE_ENV: secretLookingValue });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("NODE_ENV");
    expect(result.stderr).not.toContain(secretLookingValue);
    expect(result.stdout).not.toContain(secretLookingValue);
  });

  it("reports an unknown command as a usage error even when configuration is invalid", () => {
    const result = run(["nope"], { NODE_ENV: "staging" });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Unknown command: "nope"');
    expect(result.stderr).not.toContain("Invalid environment configuration");
  });

  it("reports extra health arguments as a usage error even when configuration is invalid", () => {
    const result = run(["health", "extra"], { LOG_LEVEL: "bogus" });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Command "health" takes no arguments.');
    expect(result.stderr).not.toContain("Invalid environment configuration");
  });

  it("treats empty configuration values as unset and uses defaults", () => {
    const result = run(["health"], { NODE_ENV: "", LOG_LEVEL: "" });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ environment: "development" });
    expect(result.stderr).toBe("");
  });
});
