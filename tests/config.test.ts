import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/infrastructure/config.js";

describe("loadConfig", () => {
  it("applies defaults when variables are absent", () => {
    expect(loadConfig({})).toEqual({ environment: "development", logLevel: "info" });
  });

  it("reads explicit values", () => {
    expect(loadConfig({ NODE_ENV: "production", LOG_LEVEL: "warn" })).toEqual({
      environment: "production",
      logLevel: "warn",
    });
  });

  it("treats empty values as unset so defaults apply", () => {
    expect(loadConfig({ NODE_ENV: "", LOG_LEVEL: "" })).toEqual({
      environment: "development",
      logLevel: "info",
    });
  });

  it("still rejects whitespace-only values", () => {
    expect(() => loadConfig({ LOG_LEVEL: " " })).toThrow(ConfigError);
  });

  it("ignores unrelated environment variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", HOME: "/root" }).environment).toBe("development");
  });

  it("rejects invalid values naming the variable but not echoing its value", () => {
    const secretLookingValue = "s3cr3t-value-should-not-leak";
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: secretLookingValue });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain("NODE_ENV");
    expect(message).not.toContain(secretLookingValue);
  });
});
