import { describe, expect, it } from "vitest";
import { ConfigError, loadStatusConfig } from "../src/infrastructure/config.js";

// Pseudonymised values only; `.invalid` never resolves.
const TOKEN = "Kq3-not-a-real-heartbeat-token";
const HEARTBEAT_URL = `https://hc.example.invalid/ping/${TOKEN}`;

function errorMessage(env: Record<string, string>): string {
  let caught: unknown;
  try {
    loadStatusConfig(env);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

describe("loadStatusConfig (status, PR-07B)", () => {
  it("is all null when unset or empty: no backup check, no heartbeat", () => {
    expect(loadStatusConfig({})).toEqual({ backupDir: null, heartbeatUrl: null });
    expect(loadStatusConfig({ BACKUP_DIR: "", HEARTBEAT_URL: "" })).toEqual({
      backupDir: null,
      heartbeatUrl: null,
    });
  });

  it("returns an absolute BACKUP_DIR and an https HEARTBEAT_URL as given", () => {
    expect(
      loadStatusConfig({
        BACKUP_DIR: "/var/backups/radar",
        HEARTBEAT_URL: `${HEARTBEAT_URL}?rid=1`,
      }),
    ).toEqual({ backupDir: "/var/backups/radar", heartbeatUrl: `${HEARTBEAT_URL}?rid=1` });
    expect(loadStatusConfig({ HEARTBEAT_URL: "https://[::1]:8443/p" }).heartbeatUrl).toBe(
      "https://[::1]:8443/p",
    );
  });

  it.each(["backups", "./backups", "~/backups", "/var/backups/\nradar", `/${"a".repeat(500)}`])(
    "refuses BACKUP_DIR %j",
    (value) => {
      expect(errorMessage({ BACKUP_DIR: value })).toBe("Invalid status configuration: BACKUP_DIR");
    },
  );

  it.each([
    `http://hc.example.invalid/ping/${TOKEN}`,
    `hc.example.invalid/ping/${TOKEN}`,
    `https://user:${TOKEN}@hc.example.invalid/ping`,
    `https://hc.example.invalid/ping/${TOKEN}#fragment`,
    `https://hc.example.invalid/ping/${TOKEN} `,
    `https://hc.example.invalid/ping/\t${TOKEN}`,
    `ftp://hc.example.invalid/${TOKEN}`,
    `https://hc.example.invalid/${TOKEN}${"a".repeat(2000)}`,
  ])("refuses HEARTBEAT_URL %j, without echoing it", (value) => {
    const message = errorMessage({ HEARTBEAT_URL: value });
    expect(message).toBe("Invalid status configuration: HEARTBEAT_URL");
    expect(message).not.toContain(TOKEN);
  });

  it("names every invalid variable", () => {
    expect(errorMessage({ BACKUP_DIR: "relative", HEARTBEAT_URL: "http://x.invalid/" })).toBe(
      "Invalid status configuration: BACKUP_DIR, HEARTBEAT_URL",
    );
  });
});
