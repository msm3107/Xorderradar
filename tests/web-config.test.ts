import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  loadPublicBaseUrl,
  loadWebConfig,
} from "../src/infrastructure/config.js";

const BASE = "https://radar.example.invalid";

function errorOf(load: () => unknown): string {
  let caught: unknown;
  try {
    load();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

describe("loadWebConfig", () => {
  it("listens on 127.0.0.1:3000 by default and requires PUBLIC_BASE_URL", () => {
    expect(DEFAULT_WEB_HOST).toBe("127.0.0.1");
    expect(DEFAULT_WEB_PORT).toBe(3000);
    expect(loadWebConfig({ PUBLIC_BASE_URL: BASE })).toEqual({
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: BASE,
    });
    expect(errorOf(() => loadWebConfig({}))).toBe("Invalid web configuration: PUBLIC_BASE_URL");
    expect(errorOf(() => loadWebConfig({ PUBLIC_BASE_URL: "" }))).toBe(
      "Invalid web configuration: PUBLIC_BASE_URL",
    );
  });

  it("reads WEB_HOST and WEB_PORT; empty values count as unset", () => {
    expect(
      loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_HOST: "::1", WEB_PORT: "8080" }),
    ).toMatchObject({ host: "::1", port: 8080 });
    expect(loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_HOST: "localhost" }).host).toBe("localhost");
    expect(loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_HOST: "", WEB_PORT: "" })).toMatchObject({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
    });
    expect(loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_PORT: "65535" }).port).toBe(65_535);
  });

  it.each(["0", "65536", "-1", "08", "80a", " 80", "1e3", "3000.0"])(
    "rejects WEB_PORT=%j naming the variable only",
    (port) => {
      expect(errorOf(() => loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_PORT: port }))).toBe(
        "Invalid web configuration: WEB_PORT",
      );
    },
  );

  it.each(["radar.example.invalid", "127.0.0.1:3000", "http://127.0.0.1", "1.2.3", " ::1"])(
    "rejects WEB_HOST=%j",
    (host) => {
      expect(errorOf(() => loadWebConfig({ PUBLIC_BASE_URL: BASE, WEB_HOST: host }))).toBe(
        "Invalid web configuration: WEB_HOST",
      );
    },
  );
});

describe("PUBLIC_BASE_URL", () => {
  it.each([
    ["https://radar.example.invalid", "https://radar.example.invalid"],
    ["https://radar.example.invalid/", "https://radar.example.invalid"],
    ["https://RADAR.example.invalid:443/", "https://radar.example.invalid"],
    ["https://radar.example.invalid:8443", "https://radar.example.invalid:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("accepts %j as the origin %j", (value, origin) => {
    expect(loadPublicBaseUrl({ PUBLIC_BASE_URL: value })).toBe(origin);
    expect(loadWebConfig({ PUBLIC_BASE_URL: value }).publicBaseUrl).toBe(origin);
  });

  it.each([
    "radar.example.invalid",
    "http://radar.example.invalid",
    "ftp://radar.example.invalid",
    "https://user:secret@radar.example.invalid",
    "https://radar.example.invalid/radar",
    "https://radar.example.invalid/?a=1",
    "https://radar.example.invalid/#x",
    "https://radar.example.invalid\n",
    " https://radar.example.invalid",
    "javascript:alert(1)",
  ])("rejects %j, naming the variable only", (value) => {
    const message = errorOf(() => loadPublicBaseUrl({ PUBLIC_BASE_URL: value }));
    expect(message).toBe("Invalid web configuration: PUBLIC_BASE_URL");
    expect(message).not.toContain("secret");
  });

  it("allows http only on loopback and never in production", () => {
    expect(loadPublicBaseUrl({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000",
    );
    expect(
      errorOf(() =>
        loadPublicBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://localhost:3000" }),
      ),
    ).toBe("Invalid web configuration: PUBLIC_BASE_URL");
    expect(loadPublicBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: BASE })).toBe(BASE);
  });

  it("is optional for the link builders: unset or empty is null", () => {
    expect(loadPublicBaseUrl({})).toBeNull();
    expect(loadPublicBaseUrl({ PUBLIC_BASE_URL: "" })).toBeNull();
  });
});
