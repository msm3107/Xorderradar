import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_EMAIL_OUTBOX_DIR,
  loadContactEmail,
  loadEmailConfig,
  loadOperatorEmail,
  TEST_EMAIL_FROM,
} from "../src/infrastructure/config.js";

// Pseudonymised values only; `.invalid` never resolves.
const FROM = "kontakt@example.invalid";
const SECRET = "not-a-real-password";

function errorMessage(env: Record<string, string>): string {
  let caught: unknown;
  try {
    loadEmailConfig(env);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

describe("loadEmailConfig", () => {
  it("defaults to the test mode: an outbox and a never-deliverable sender", () => {
    expect(loadEmailConfig({})).toEqual({
      mode: "test",
      from: TEST_EMAIL_FROM,
      outboxDir: DEFAULT_EMAIL_OUTBOX_DIR,
    });
    expect(TEST_EMAIL_FROM.address.endsWith(".invalid")).toBe(true);
  });

  it("treats empty values as unset", () => {
    expect(loadEmailConfig({ EMAIL_MODE: "", EMAIL_FROM: "", EMAIL_OUTBOX_DIR: "" })).toEqual(
      loadEmailConfig({}),
    );
  });

  it("does not need SMTP variables in the test mode, and ignores SMTP_URL's absence", () => {
    expect(
      loadEmailConfig({ EMAIL_MODE: "test", EMAIL_FROM: FROM, EMAIL_OUTBOX_DIR: "/tmp/outbox" }),
    ).toEqual({
      mode: "test",
      from: { name: "", address: FROM },
      outboxDir: "/tmp/outbox",
    });
  });

  it("reads an smtps URL with credentials (implicit TLS)", () => {
    expect(
      loadEmailConfig({
        EMAIL_MODE: "smtp",
        EMAIL_FROM: `Radar Zamówień <${FROM}>`,
        SMTP_URL: `smtps://radar%40example.invalid:${SECRET}@smtp.example.invalid:2465`,
      }),
    ).toEqual({
      mode: "smtp",
      from: { name: "Radar Zamówień", address: FROM },
      smtp: {
        host: "smtp.example.invalid",
        port: 2465,
        implicitTls: true,
        user: "radar@example.invalid",
        password: SECRET,
      },
    });
  });

  it("reads an smtp URL as STARTTLS, with the default port and no credentials", () => {
    expect(
      loadEmailConfig({
        EMAIL_MODE: "smtp",
        EMAIL_FROM: FROM,
        SMTP_URL: "smtp://smtp.example.invalid/",
      }),
    ).toEqual({
      mode: "smtp",
      from: { name: "", address: FROM },
      smtp: {
        host: "smtp.example.invalid",
        port: null,
        implicitTls: false,
        user: null,
        password: null,
      },
    });
  });

  it("strips the brackets of an IPv6 literal", () => {
    const config = loadEmailConfig({
      EMAIL_MODE: "smtp",
      EMAIL_FROM: FROM,
      SMTP_URL: "smtps://[::1]:465",
    });
    expect(config.mode === "smtp" ? config.smtp.host : null).toBe("::1");
  });

  it("requires EMAIL_FROM and SMTP_URL in the smtp mode", () => {
    expect(errorMessage({ EMAIL_MODE: "smtp" })).toBe(
      "Invalid e-mail configuration: EMAIL_FROM, SMTP_URL",
    );
    expect(errorMessage({ EMAIL_MODE: "smtp", EMAIL_FROM: FROM })).toBe(
      "Invalid e-mail configuration: SMTP_URL",
    );
  });

  it.each([
    ["an http URL", "http://smtp.example.invalid"],
    ["no host", "smtps://"],
    ["a path", "smtps://smtp.example.invalid/x"],
    // nodemailer would read options (e.g. tls.rejectUnauthorized) from the query.
    ["a query", "smtps://smtp.example.invalid/?tls.rejectUnauthorized=false"],
    ["a fragment", "smtps://smtp.example.invalid/#x"],
    ["a user without a password", "smtps://radar@smtp.example.invalid"],
    ["a broken percent-encoding", `smtps://radar:%E0%A4%A@smtp.example.invalid`],
    ["not a URL", "smtp.example.invalid:465"],
  ])("refuses SMTP_URL with %s, naming the variable only", (_case, url) => {
    const message = errorMessage({ EMAIL_MODE: "smtp", EMAIL_FROM: FROM, SMTP_URL: url });
    expect(message).toBe("Invalid e-mail configuration: SMTP_URL");
  });

  it("never echoes the SMTP password", () => {
    const message = errorMessage({
      EMAIL_MODE: "smtp",
      EMAIL_FROM: "not an address",
      SMTP_URL: `smtps://user:${SECRET}@smtp.example.invalid/?x=1`,
    });
    expect(message).toBe("Invalid e-mail configuration: EMAIL_FROM, SMTP_URL");
    expect(message).not.toContain(SECRET);
  });

  it.each([
    ["not an address", "Jan Kowalski"],
    ["a quote in the name", `"Jan" <${FROM}>`],
    ["a line break in the name", `Jan\r\nBcc: x@example.invalid <${FROM}>`],
    ["two addresses", `${FROM}, other@example.invalid`],
    ["nested brackets", `Jan <<${FROM}>>`],
  ])("refuses EMAIL_FROM with %s", (_case, from) => {
    expect(errorMessage({ EMAIL_FROM: from })).toBe("Invalid e-mail configuration: EMAIL_FROM");
  });

  it("refuses an unknown mode and a control character in the outbox path", () => {
    expect(errorMessage({ EMAIL_MODE: "sendmail" })).toBe(
      "Invalid e-mail configuration: EMAIL_MODE",
    );
    expect(errorMessage({ EMAIL_OUTBOX_DIR: "out\0box" })).toBe(
      "Invalid e-mail configuration: EMAIL_OUTBOX_DIR",
    );
  });
});

describe("loadOperatorEmail (status --notify, PR-07A)", () => {
  it("is null when unset or empty", () => {
    expect(loadOperatorEmail({})).toBeNull();
    expect(loadOperatorEmail({ OPERATOR_EMAIL: "" })).toBeNull();
  });

  it("returns a valid address", () => {
    expect(loadOperatorEmail({ OPERATOR_EMAIL: "operator@example.invalid" })).toBe(
      "operator@example.invalid",
    );
  });

  it.each([
    "operator",
    "operator@example.invalid\r\nBcc: x@example.invalid",
    `${"a".repeat(250)}@example.invalid`,
  ])("refuses %j, naming only the variable", (value) => {
    let caught: unknown;
    try {
      loadOperatorEmail({ OPERATOR_EMAIL: value });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toBe("Invalid e-mail configuration: OPERATOR_EMAIL");
  });
});

describe("loadContactEmail (the home page's contact, PR-10)", () => {
  it("is null when unset or empty: the page then names no address", () => {
    expect(loadContactEmail({})).toBeNull();
    expect(loadContactEmail({ CONTACT_EMAIL: "" })).toBeNull();
  });

  it("returns a valid address", () => {
    expect(loadContactEmail({ CONTACT_EMAIL: "kontakt@example.invalid" })).toBe(
      "kontakt@example.invalid",
    );
  });

  it.each([
    "kontakt",
    "kontakt@example.invalid\r\nBcc: x@example.invalid",
    `${"a".repeat(250)}@example.invalid`,
  ])("refuses %j, naming only the variable", (value) => {
    let caught: unknown;
    try {
      loadContactEmail({ CONTACT_EMAIL: value });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toBe("Invalid e-mail configuration: CONTACT_EMAIL");
  });
});
