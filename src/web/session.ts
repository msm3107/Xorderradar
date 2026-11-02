import { createHmac, timingSafeEqual } from "node:crypto";
import { isSecretToken } from "../infrastructure/db/access-repository.js";

/**
 * Session cookie and CSRF helpers (D-026). Pure: no I/O.
 *
 * The cookie name has the `__Host-` prefix, so browsers accept it only with
 * `Secure`, `Path=/` and no `Domain`: it cannot be set or shadowed by another
 * subdomain. Browsers treat http://localhost as a secure context, so the
 * cookie works in local development too.
 */
export const SESSION_COOKIE = "__Host-radar_sesja";

/** `Set-Cookie` value opening a session; Max-Age is the session's absolute expiry. */
export function sessionCookie(sessionToken: string, maxAgeSeconds: number): string {
  return (
    `${SESSION_COOKIE}=${sessionToken}; Path=/; Max-Age=${String(Math.floor(maxAgeSeconds))}; ` +
    "HttpOnly; Secure; SameSite=Lax"
  );
}

/** `Set-Cookie` value removing the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The session token from a `Cookie` header, or null. Only the first cookie
 * of that name counts, and only when it is shaped like a token, so nothing
 * malformed ever reaches the database.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return isSecretToken(value) ? value : null;
  }
  return null;
}

/**
 * The CSRF synchronizer token of a session: an HMAC keyed by the session's
 * secret, so it needs no storage, differs per session and cannot be derived
 * without the HttpOnly cookie. It is put into every form of a session page.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("radar-csrf-v1").digest("base64url");
}

/** Constant-time check of a submitted CSRF token against the session's. */
export function csrfMatches(sessionToken: string, submitted: string): boolean {
  const expected = Buffer.from(csrfTokenFor(sessionToken), "utf8");
  const actual = Buffer.from(submitted, "utf8");
  // The length of the expected token is public (always 43), so an early
  // length check leaks nothing; timingSafeEqual needs equal lengths.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The `Origin` check of POST requests: a request without the header passes
 * (older clients, the CSRF token still applies); one with it must come from
 * PUBLIC_BASE_URL's origin exactly — `null` and any other origin fail.
 */
export function originAllowed(origin: string | undefined, publicBaseUrl: string): boolean {
  return origin === undefined || origin === publicBaseUrl;
}
