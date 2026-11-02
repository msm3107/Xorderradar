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
  const value = readCookie(header, SESSION_COOKIE);
  return value !== null && isSecretToken(value) ? value : null;
}

/** The value of the first cookie called `name`, or null. */
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * The one-time notice shown on /profil after a form was saved (PR-06B,
 * D-027). The router ignores the query string, and the page after a 303
 * cannot see the POST, so a short-lived cookie carries which notice to show;
 * /profil clears it when it shows it. It holds one word from a closed list,
 * never data: a forged one can only make the page say "Zapisano".
 */
export const NOTICE_COOKIE = "__Host-radar_komunikat";

export const NOTICES = ["zapisano", "zmieniono_email", "wypisano", "wlaczono"] as const;
export type Notice = (typeof NOTICES)[number];

/** Long enough for the redirect that follows; a notice never shows up later. */
const NOTICE_MAX_AGE_SECONDS = 60;

export function noticeCookie(notice: Notice): string {
  return (
    `${NOTICE_COOKIE}=${notice}; Path=/; Max-Age=${String(NOTICE_MAX_AGE_SECONDS)}; ` +
    "HttpOnly; Secure; SameSite=Lax"
  );
}

export function clearedNoticeCookie(): string {
  return `${NOTICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** The notice of the request's notice cookie; null when absent or not one of NOTICES. */
export function readNoticeCookie(header: string | undefined): Notice | null {
  const value = readCookie(header, NOTICE_COOKIE);
  return NOTICES.find((notice) => notice === value) ?? null;
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

/**
 * The stricter check of the login POST (login CSRF, PR-06B): it needs no
 * session, so there is no CSRF token, and a foreign site could otherwise sign
 * a victim's browser into the attacker's profile. It passes only when
 * `Origin` is PUBLIC_BASE_URL's origin, or when `Origin` is absent and the
 * browser says the request came from our own pages (`Sec-Fetch-Site:
 * same-origin`). A request with neither header is refused.
 */
export function loginRequestAllowed(
  origin: string | undefined,
  secFetchSite: string | readonly string[] | undefined,
  publicBaseUrl: string,
): boolean {
  if (origin !== undefined) return origin === publicBaseUrl;
  return secFetchSite === "same-origin";
}
