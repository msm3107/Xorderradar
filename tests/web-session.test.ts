import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashSecretToken,
  isSecretToken,
  LOGIN_TOKEN_TTL_MS,
  newSecretToken,
  SESSION_TTL_MS,
  UNSUBSCRIBE_TOKEN_TTL_MS,
} from "../src/infrastructure/db/access-repository.js";
import { loginUrl, unsubscribeUrl } from "../src/web/links.js";
import {
  clearedSessionCookie,
  csrfMatches,
  csrfTokenFor,
  originAllowed,
  readSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
} from "../src/web/session.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("secret tokens", () => {
  it("are 256 random bits as base64url, different every time", () => {
    const tokens = Array.from({ length: 50 }, () => newSecretToken());
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isSecretToken(token)).toBe(true);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it.each([
    ["", false],
    ["a".repeat(42), false],
    ["a".repeat(44), false],
    [`${"a".repeat(42)}=`, false],
    [`${"a".repeat(42)}+`, false],
    [`${"a".repeat(42)}/`, false],
    [`${"a".repeat(42)}\n`, false],
    [`${"a".repeat(21)}%2F${"a".repeat(19)}`, false],
    ["a".repeat(43), true],
    [`${"A-_9".repeat(10)}abc`, true],
  ])("isSecretToken(%j) is %s", (value, expected) => {
    expect(isSecretToken(value)).toBe(expected);
  });

  it("are stored as their SHA-256 in hex only", () => {
    const token = newSecretToken();
    const hash = hashSecretToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token);
  });

  it("expire after 7 days (login), 60 days (unsubscribe); sessions after 30 days", () => {
    expect(LOGIN_TOKEN_TTL_MS).toBe(7 * DAY_MS);
    expect(UNSUBSCRIBE_TOKEN_TTL_MS).toBe(60 * DAY_MS);
    expect(SESSION_TTL_MS).toBe(30 * DAY_MS);
  });
});

describe("links", () => {
  it("put the token into the path under the public origin", () => {
    const token = "a".repeat(43);
    expect(loginUrl("https://radar.example.invalid", token)).toBe(
      `https://radar.example.invalid/dostep/${token}`,
    );
    expect(unsubscribeUrl("https://radar.example.invalid", token)).toBe(
      `https://radar.example.invalid/wypis/${token}`,
    );
  });
});

describe("session cookie", () => {
  const token = newSecretToken();

  it("is __Host- prefixed, HttpOnly, Secure, SameSite=Lax, Path=/, with an absolute Max-Age", () => {
    const cookie = sessionCookie(token, SESSION_TTL_MS / 1000);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    const [pair, ...attributes] = cookie.split("; ");
    expect(pair).toBe(`${SESSION_COOKIE}=${token}`);
    expect(attributes.sort()).toEqual(
      ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
    // __Host- forbids Domain.
    expect(cookie).not.toMatch(/domain/i);
  });

  it("is cleared with Max-Age=0 and the same attributes", () => {
    const [pair, ...attributes] = clearedSessionCookie().split("; ");
    expect(pair).toBe(`${SESSION_COOKIE}=`);
    expect(attributes.sort()).toEqual(
      ["HttpOnly", "Max-Age=0", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
  });

  it.each([
    [undefined, null],
    ["", null],
    [`${SESSION_COOKIE}=${token}`, token],
    [`other=1; ${SESSION_COOKIE}=${token}; more=2`, token],
    [`  ${SESSION_COOKIE} = ${token} `, token],
    // Only the first cookie of the name counts, and only a token-shaped value.
    [`${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${"b".repeat(43)}`, token],
    [`${SESSION_COOKIE}=nie-token; ${SESSION_COOKIE}=${token}`, null],
    [`${SESSION_COOKIE}=${token}x`, null],
    [`radar_sesja=${token}`, null],
    [`x${SESSION_COOKIE}=${token}`, null],
    ["garbage", null],
  ])("readSessionCookie(%j)", (header, expected) => {
    expect(readSessionCookie(header)).toBe(expected);
  });
});

describe("CSRF token", () => {
  const session = newSecretToken();
  const other = newSecretToken();

  it("is bound to the session and reveals nothing of it", () => {
    const csrf = csrfTokenFor(session);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(session)).toBe(csrf);
    expect(csrfTokenFor(other)).not.toBe(csrf);
    expect(csrf).not.toContain(session);
  });

  it("matches only the session's own token", () => {
    const csrf = csrfTokenFor(session);
    expect(csrfMatches(session, csrf)).toBe(true);
    expect(csrfMatches(session, csrfTokenFor(other))).toBe(false);
    expect(csrfMatches(session, "")).toBe(false);
    expect(csrfMatches(session, csrf.slice(1))).toBe(false);
    expect(csrfMatches(session, `${csrf}a`)).toBe(false);
    expect(csrfMatches(session, csrf.toUpperCase())).toBe(csrf === csrf.toUpperCase());
    expect(csrfMatches(session, session)).toBe(false);
  });
});

describe("Origin check", () => {
  const base = "https://radar.example.invalid";

  it.each([
    [undefined, true],
    [base, true],
    ["null", false],
    ["", false],
    [`${base}/`, false],
    ["http://radar.example.invalid", false],
    ["https://radar.example.invalid:8443", false],
    ["https://evil.example.invalid", false],
    ["https://radar.example.invalid.evil.example.invalid", false],
  ])("Origin %j → %s", (origin, allowed) => {
    expect(originAllowed(origin, base)).toBe(allowed);
  });
});
