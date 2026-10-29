import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/infrastructure/config.js";

// DATABASE_URL is required; tests about the other variables pass this one.
const DATABASE_URL = "postgres://radar:radar@localhost:5432/radar_dev";

function configErrorMessage(env: Record<string, string>): string {
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

describe("loadConfig", () => {
  it("applies defaults when variables are absent", () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      environment: "development",
      logLevel: "info",
      databaseUrl: DATABASE_URL,
    });
  });

  it("reads explicit values", () => {
    expect(loadConfig({ NODE_ENV: "production", LOG_LEVEL: "warn", DATABASE_URL })).toEqual({
      environment: "production",
      logLevel: "warn",
      databaseUrl: DATABASE_URL,
    });
  });

  it("treats empty values as unset so defaults apply", () => {
    expect(loadConfig({ NODE_ENV: "", LOG_LEVEL: "", DATABASE_URL })).toEqual({
      environment: "development",
      logLevel: "info",
      databaseUrl: DATABASE_URL,
    });
  });

  it("still rejects whitespace-only values", () => {
    expect(() => loadConfig({ LOG_LEVEL: " ", DATABASE_URL })).toThrow(ConfigError);
  });

  it("ignores unrelated environment variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", HOME: "/root", DATABASE_URL }).environment).toBe(
      "development",
    );
  });

  it("rejects invalid values naming the variable but not echoing its value", () => {
    const secretLookingValue = "s3cr3t-value-should-not-leak";
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: secretLookingValue, DATABASE_URL });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain("NODE_ENV");
    expect(message).not.toContain(secretLookingValue);
  });

  describe("DATABASE_URL", () => {
    it("is required (absent or empty)", () => {
      expect(configErrorMessage({})).toContain("DATABASE_URL");
      expect(configErrorMessage({ DATABASE_URL: "" })).toContain("DATABASE_URL");
    });

    it("accepts both postgres: and postgresql: schemes", () => {
      const url = "postgresql://radar:pw@db.example.com:6543/radar?sslmode=require";
      expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
    });

    it.each([
      "mysql://radar:s3cr3t-value-should-not-leak@localhost/radar",
      "radar:s3cr3t-value-should-not-leak@localhost/radar",
      "s3cr3t-value-should-not-leak",
    ])("rejects %s naming the variable without echoing the value", (value) => {
      const message = configErrorMessage({ DATABASE_URL: value });
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain("s3cr3t-value-should-not-leak");
    });
  });
});
