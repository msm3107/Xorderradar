import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Kysely } from "kysely";
import { DomainError } from "../domain/errors.js";
import {
  activateProfile,
  consumeLoginToken,
  deactivateProfile,
  deleteExpiredAccess,
  deleteSession,
  findSession,
  getProfileStatus,
  isUsableAccessToken,
  SESSION_TTL_MS,
  unsubscribeTokenProfileName,
  unsubscribeWithToken,
} from "../infrastructure/db/access-repository.js";
import {
  getCompanyProfile,
  getProfileSettings,
  updateProfileSettings,
} from "../infrastructure/db/company-profiles-repository.js";
import { pingDatabase } from "../infrastructure/db/database.js";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import type { Database } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";
import {
  DIGEST_NEW_DAYS,
  matchingItems,
  readDigestCandidates,
} from "../notifications/candidates.js";
import { digestItemView, digestOrder } from "../notifications/digest.js";
import { formatWarsawMinute } from "../sources/normalize/warsaw-time.js";
import { createMatchesSlot, type MatchesSlot } from "./matches-slot.js";
import { multipartBoundary, multipartFieldValues } from "./multipart.js";
import {
  errorPage,
  homePage,
  invalidLinkPage,
  loginConfirmPage,
  loginRequiredPage,
  loginRefusedPage,
  matchesBusyPage,
  matchesTooManyPage,
  matchesPage,
  matchesUnavailablePage,
  type Page,
  profilePage,
  settingsPage,
  STYLESHEET,
  unsubscribeConfirmPage,
  unsubscribedPage,
} from "./pages.js";
import {
  DUPLICATE_EMAIL_ERRORS,
  formValuesFromStored,
  formValuesFromSubmission,
  PROFILE_FORM_MULTIPLE_FIELDS,
  PROFILE_FORM_SINGLE_FIELDS,
  validateProfileForm,
} from "./profile-form.js";
import {
  clearedNoticeCookie,
  clearedSessionCookie,
  csrfMatches,
  csrfTokenFor,
  loginRequestAllowed,
  noticeCookie,
  originAllowed,
  readNoticeCookie,
  readSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
  type Notice,
} from "./session.js";

/**
 * The web access (PR-06A, PR-06B; D-025, D-026, D-027): plain node:http, no framework.
 * Deny by default — a request is served only when its path matches one of
 * the routes below and its method is one the route allows; the profile is
 * taken only from the session, never from the URL or a form. TLS is the
 * reverse proxy's job (docs/SECURITY.md §11); the server listens on
 * WEB_HOST, 127.0.0.1 by default.
 */

/** Largest accepted request body: the forms here carry one or two short fields. */
export const MAX_BODY_BYTES = 8 * 1024;
/**
 * The profile form's own limit (D-027): up to 100 keywords of up to 100
 * characters in two lists, plus counties, urlencoded (a Polish letter takes
 * 6 bytes). Typical Polish text needs about 1.5 bytes per character, so full
 * lists fit; every other route keeps MAX_BODY_BYTES.
 */
export const PROFILE_FORM_MAX_BYTES = 64 * 1024;
/** Most `name=value` pairs in the profile form: 7 fields, 10 categories, 16 voivodeships. */
export const PROFILE_FORM_MAX_FIELDS = 64;
/** Matching offers shown on /dopasowania; the rest are counted (as in the digest). */
export const MATCHES_SHOWN = 50;
/** Retry-After of the 503 when the wait for the /dopasowania slot is refused or runs out. */
export const MATCHES_RETRY_AFTER_SECONDS = 5;
/** Longest wait for the /dopasowania slot before the 503 (D-027). */
export const MATCHES_MAX_WAIT_MS = 3000;
/** Most requests waiting for the /dopasowania slot; one more gets the 503 at once. */
export const MATCHES_MAX_WAITERS = 8;
/**
 * Most /dopasowania requests of one session in progress (waiting or
 * computing) at a time; one more gets 429 at once, so one session cannot
 * fill the whole queue (D-028).
 */
export const MATCHES_MAX_PER_SESSION = 2;
/** HSTS for an https PUBLIC_BASE_URL: one year, this host only (D-028). */
const STRICT_TRANSPORT_SECURITY = "max-age=31536000";
/**
 * Longest wait of GET /zdrowie for the database before the 503 (D-029): a hung
 * database answers 503 quickly instead of a hanging request.
 */
export const HEALTH_TIMEOUT_MS = 2000;
/** How often `serve` deletes expired tokens and sessions (bounded batches). */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** How long `close()` waits for open requests before cutting the connections. */
const SHUTDOWN_GRACE_MS = 10_000;

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'";

type Method = "GET" | "HEAD" | "POST";

type RouteName =
  | "home"
  | "health"
  | "stylesheet"
  | "login_link"
  | "login"
  | "profile"
  | "profile_settings"
  | "profile_unsubscribe"
  | "profile_resubscribe"
  | "matches"
  | "logout"
  | "unsubscribe";

interface RouteMatch {
  readonly name: RouteName;
  readonly allow: readonly Method[];
  /** The path segment after /dostep/ or /wypis/ (validated by the repository). */
  readonly token?: string;
}

const PAGE: readonly Method[] = ["GET", "HEAD"];
const FORM: readonly Method[] = ["POST"];

/** Matches the path (query ignored) to a route; null is a 404. */
function matchRoute(path: string): RouteMatch | null {
  switch (path) {
    case "/":
      return { name: "home", allow: PAGE };
    case "/styl.css":
      return { name: "stylesheet", allow: PAGE };
    case "/zdrowie":
      return { name: "health", allow: PAGE };
    case "/dostep":
      return { name: "login", allow: FORM };
    case "/profil":
      return { name: "profile", allow: PAGE };
    case "/profil/ustawienia":
      return { name: "profile_settings", allow: [...PAGE, "POST"] };
    case "/profil/wypisz":
      return { name: "profile_unsubscribe", allow: FORM };
    case "/profil/wlacz":
      return { name: "profile_resubscribe", allow: FORM };
    case "/dopasowania":
      return { name: "matches", allow: PAGE };
    case "/wyloguj":
      return { name: "logout", allow: FORM };
  }
  const link = /^\/(dostep|wypis)\/([^/]+)$/.exec(path);
  if (link?.[2] === undefined) return null;
  return link[1] === "dostep"
    ? { name: "login_link", allow: PAGE, token: link[2] }
    : { name: "unsubscribe", allow: [...PAGE, "POST"], token: link[2] };
}

/** Methods named in the log; anything else is logged as OTHER. */
const LOGGED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Closes the connection after the reply (a request body left unread). */
  readonly close?: boolean;
  /** A cacheable public asset (the stylesheet); everything else is no-store. */
  readonly cacheable?: boolean;
}

function pageReply(page: Page, headers?: Readonly<Record<string, string>>): Reply {
  return { status: page.status, body: page.html, ...(headers === undefined ? {} : { headers }) };
}

/** `https`: the replies also carry Strict-Transport-Security (PUBLIC_BASE_URL is https). */
function send(res: ServerResponse, reply: Reply, https: boolean): void {
  const body = Buffer.from(reply.body, "utf8");
  res.statusCode = reply.status;
  res.setHeader("Content-Type", reply.contentType ?? "text/html; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // strict-origin: our own form POSTs keep a real `Origin` (no-referrer would
  // make browsers send `Origin: null`), and a Referer is the origin only —
  // never a path with a token in it, not even to our own proxy's logs.
  res.setHeader("Referrer-Policy", "strict-origin");
  // Pages may hold a token or a session's data: no cache may keep them.
  res.setHeader("Cache-Control", reply.cacheable === true ? "public, max-age=3600" : "no-store");
  // Not on http (local development): a browser ignores it there, and
  // includeSubDomains/preload would bind hosts this service does not run.
  if (https) res.setHeader("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  if (reply.close === true) res.setHeader("Connection", "close");
  res.end(body);
}

/**
 * The client went away (or Node cut a slow request off) before the body was
 * read: nothing to answer and not a server failure, so it is logged apart
 * from database errors.
 */
export class RequestAbortedError extends Error {
  constructor() {
    super("request aborted");
    this.name = "RequestAbortedError";
  }
}

/**
 * Reads the body up to `limit` bytes; null when it is longer (the rest stays
 * unread). Rejects with RequestAbortedError when the request ends early.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (): void => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const onClose = (): void => {
      cleanup();
      reject(new RequestAbortedError());
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/** Only `application/x-www-form-urlencoded`, optionally with `charset=utf-8`. */
function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type, ...params] = header.split(";").map((part) => part.trim().toLowerCase());
  if (type !== "application/x-www-form-urlencoded") return false;
  return params.every((param) => param === "charset=utf-8" || param === 'charset="utf-8"');
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses a urlencoded body strictly: valid UTF-8, exactly the expected
 * fields, each once. null for anything else (a 400).
 */
export function parseForm(
  body: Buffer,
  fields: readonly string[],
): Readonly<Record<string, string>> | null {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(text)) {
    if (!fields.includes(name) || values.has(name)) return null;
    values.set(name, value);
  }
  if (values.size !== fields.length) return null;
  return Object.fromEntries(values);
}

export interface MultiValueForm<S extends string, M extends string> {
  readonly single: Readonly<Record<S, string>>;
  readonly multiple: Readonly<Record<M, readonly string[]>>;
}

/**
 * Parses a urlencoded body with checkbox groups strictly: valid UTF-8, at
 * most `maxFields` pairs, only the named fields; each `single` field exactly
 * once, each `multiple` field any number of times (also none). null for
 * anything else (a 400).
 */
export function parseMultiValueForm<S extends string, M extends string>(
  body: Buffer,
  single: readonly S[],
  multiple: readonly M[],
  maxFields: number,
): MultiValueForm<S, M> | null {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>(multiple.map((name) => [name, []]));
  let count = 0;
  for (const [name, value] of new URLSearchParams(text)) {
    count++;
    if (count > maxFields) return null;
    const list = lists.get(name);
    if (list !== undefined) {
      list.push(value);
      continue;
    }
    if (!(single as readonly string[]).includes(name) || values.has(name)) return null;
    values.set(name, value);
  }
  if (values.size !== single.length) return null;
  return {
    single: Object.fromEntries(values) as Record<S, string>,
    multiple: Object.fromEntries(lists) as Record<M, string[]>,
  };
}

/**
 * The value of `name` when it occurs exactly once in a urlencoded body of at
 * most `maxFields` pairs; "" otherwise (repeated, absent, too many pairs or
 * not UTF-8).
 */
function singleFieldValue(body: Buffer, name: string, maxFields: number): string {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return "";
  }
  const values: string[] = [];
  let count = 0;
  for (const [field, value] of new URLSearchParams(text)) {
    count++;
    if (count > maxFields) return "";
    if (field === name) values.push(value);
  }
  return values.length === 1 ? (values[0] ?? "") : "";
}

export interface WebServerOptions {
  readonly db: Kysely<Database>;
  /** PUBLIC_BASE_URL's origin: the only `Origin` a form POST may carry. */
  readonly publicBaseUrl: string;
  readonly logger: Logger;
  readonly host: string;
  /** 0 picks a free port (tests). */
  readonly port: number;
  /** Interval of the expired-row cleanup; null turns it off (tests). Default: hourly. */
  readonly cleanupIntervalMs?: number | null;
  /** Longest wait for the /dopasowania slot (tests). Default: MATCHES_MAX_WAIT_MS. */
  readonly matchesMaxWaitMs?: number;
  /** Most requests waiting for the /dopasowania slot (tests). Default: MATCHES_MAX_WAITERS. */
  readonly matchesMaxWaiters?: number;
  /** Longest wait of /zdrowie for the database (tests). Default: HEALTH_TIMEOUT_MS. */
  readonly healthTimeoutMs?: number;
  /** The database check of /zdrowie (tests). Default: `select 1` over `db`. */
  readonly healthProbe?: () => Promise<void>;
}

export interface WebServer {
  readonly host: string;
  readonly port: number;
  /** Requests waiting for the /dopasowania slot now (tests). */
  readonly matchesWaiting: number;
  /** Sessions with a /dopasowania request in progress now (tests). */
  readonly matchesSessions: number;
  /** Stops accepting connections, lets open requests finish (bounded), then resolves. */
  close(): Promise<void>;
}

/** State one server shares between its requests. */
interface ServerState {
  /**
   * Matching is CPU work in this one process (D-027): one /dopasowania list
   * at a time keeps the other requests answered; a concurrent one waits
   * briefly in FIFO order, or gets 503.
   */
  readonly matches: MatchesSlot;
  /**
   * /dopasowania requests in progress per session (by the session row's id,
   * never the cookie value); an entry is removed when its count drops to 0.
   */
  readonly matchesPerSession: Map<string, number>;
  /** GET /zdrowie: true when the database answered in time (createHealthCheck). */
  readonly health: () => Promise<boolean>;
}

/**
 * The database check of GET /zdrowie (D-029). One probe at a time, shared by
 * all concurrent requests: a flood of checks holds at most one pooled
 * connection. A probe still running when a request's wait runs out (a hung
 * database) stays shared until it settles — the pool's query timeout ends it —
 * so a hung database never gets a second one. Failures are logged once per
 * probe, as fixed codes only.
 */
function createHealthCheck(
  probe: () => Promise<void>,
  timeoutMs: number,
  logger: Logger,
): () => Promise<boolean> {
  let inFlight: { readonly done: Promise<boolean>; timeoutLogged: boolean } | null = null;
  return async () => {
    if (inFlight === null) {
      const current = {
        done: probe().then(
          () => true,
          (error: unknown) => {
            logger.warn("health check failed", {
              errorCode: "health_check_failed",
              ...describeDatabaseFailure(error),
            });
            return false;
          },
        ),
        timeoutLogged: false,
      };
      inFlight = current;
      void current.done.finally(() => {
        if (inFlight === current) inFlight = null;
      });
    }
    const check = inFlight;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([check.done, timedOut]);
      if (result !== "timeout") return result;
      if (!check.timeoutLogged) {
        check.timeoutLogged = true;
        logger.warn("health check failed", { errorCode: "health_check_failed", reason: "timeout" });
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The handling of one request: a reply, decided without writing anything yet
 * (`res` is only watched for the client hanging up, never written here).
 */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteMatch,
  method: Method,
  options: WebServerOptions,
  state: ServerState,
): Promise<Reply> {
  const { db } = options;

  if (method !== "POST") {
    switch (route.name) {
      case "home":
        return pageReply(homePage());
      case "health": {
        // Plain text without any detail: only whether this process reaches the database.
        const healthy = await state.health();
        return {
          status: healthy ? 200 : 503,
          body: healthy ? "ok\n" : "niedostępne\n",
          contentType: "text/plain; charset=utf-8",
        };
      }
      case "stylesheet":
        return {
          status: 200,
          body: STYLESHEET,
          contentType: "text/css; charset=utf-8",
          cacheable: true,
        };
      case "login_link": {
        const token = route.token ?? "";
        // Read-only: a link scanner fetching the page does not use the link up.
        const usable = await isUsableAccessToken(db, token, "login");
        return pageReply(usable ? loginConfirmPage(token) : invalidLinkPage());
      }
      case "unsubscribe": {
        const token = route.token ?? "";
        const name = await unsubscribeTokenProfileName(db, token);
        return pageReply(name === null ? invalidLinkPage() : unsubscribeConfirmPage(token, name));
      }
      case "profile": {
        const session = await currentSession(req, db);
        if (session === null) return unauthenticated(req);
        const profile = await getProfileStatus(db, session.profileId);
        if (profile === null) return unauthenticated(req);
        // The notice of the form just saved is shown once, then cleared.
        const notice = readNoticeCookie(req.headers.cookie);
        return pageReply(
          profilePage(profile, csrfTokenFor(session.token), notice),
          notice === null ? undefined : { "Set-Cookie": clearedNoticeCookie() },
        );
      }
      case "profile_settings": {
        const session = await currentSession(req, db);
        if (session === null) return unauthenticated(req);
        const stored = await getProfileSettings(db, session.profileId);
        if (stored === null) return unauthenticated(req);
        return pageReply(settingsPage(formValuesFromStored(stored), csrfTokenFor(session.token)));
      }
      case "matches": {
        const session = await currentSession(req, db);
        if (session === null) return unauthenticated(req);
        const counts = state.matchesPerSession;
        const inProgress = counts.get(session.sessionId) ?? 0;
        if (inProgress >= MATCHES_MAX_PER_SESSION) {
          return pageReply(matchesTooManyPage(), {
            "Retry-After": String(MATCHES_RETRY_AFTER_SECONDS),
          });
        }
        counts.set(session.sessionId, inProgress + 1);
        try {
          const slot = await state.matches.acquire(res);
          // A client already gone or gone while waiting: nothing computed, nothing to release.
          if (slot === "gone") throw new RequestAbortedError();
          if (slot !== "acquired") {
            return pageReply(matchesBusyPage(), {
              "Retry-After": String(MATCHES_RETRY_AFTER_SECONDS),
            });
          }
          try {
            return await matchesReply(db, session.profileId, new Date(), () =>
              unauthenticated(req),
            );
          } finally {
            // Also after an error; a client gone meanwhile does not stop the work.
            state.matches.release();
          }
        } finally {
          // On every path: refused, timed out, gone, failed or answered.
          const left = (counts.get(session.sessionId) ?? 1) - 1;
          if (left <= 0) counts.delete(session.sessionId);
          else counts.set(session.sessionId, left);
        }
      }
      case "login":
      case "profile_unsubscribe":
      case "profile_resubscribe":
      case "logout":
        // Unreachable: these routes allow POST only (checked by the caller).
        return pageReply(errorPage(405));
    }
  }

  // RFC 8058: a mail provider POSTs the one-click body from its own servers,
  // with no cookie and possibly a foreign Origin; the unguessable token in the
  // path is the authorization. Every other form must come from our own pages.
  if (route.name !== "unsubscribe" && !originAllowed(req.headers.origin, options.publicBaseUrl)) {
    return {
      ...pageReply(route.name === "login" ? loginRefusedPage() : errorPage(403)),
      close: true,
    };
  }
  // Forms are urlencoded. Only the one-click unsubscribe also takes
  // multipart/form-data: RFC 8058 §3.2 says a provider SHOULD send that.
  const contentType = req.headers["content-type"];
  const multipart = route.name === "unsubscribe" ? multipartBoundary(contentType) : null;
  if (multipart === null && !isFormContentType(contentType)) {
    return { ...pageReply(errorPage(415)), close: true };
  }
  const limit = route.name === "profile_settings" ? PROFILE_FORM_MAX_BYTES : MAX_BODY_BYTES;
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) {
    return { ...pageReply(errorPage(413)), close: true };
  }
  const body = await readBody(req, limit);
  if (body === null) return { ...pageReply(errorPage(413)), close: true };

  switch (route.name) {
    case "login": {
      // Login CSRF: there is no session yet, so no CSRF token; the request
      // must provably come from our own confirmation page (session.ts).
      if (
        !loginRequestAllowed(
          req.headers.origin,
          req.headers["sec-fetch-site"],
          options.publicBaseUrl,
        )
      ) {
        return pageReply(loginRefusedPage());
      }
      const form = parseForm(body, ["token"]);
      if (form === null) return pageReply(errorPage(400));
      const opened = await consumeLoginToken(db, form.token ?? "");
      if (opened === null) return pageReply(invalidLinkPage());
      // A browser that had another session keeps no stale row behind.
      const previous = readSessionCookie(req.headers.cookie);
      if (previous !== null) await deleteSession(db, previous);
      return {
        status: 303,
        body: "",
        headers: {
          Location: "/profil",
          "Set-Cookie": sessionCookie(opened.sessionToken, SESSION_TTL_MS / 1000),
        },
      };
    }
    case "unsubscribe": {
      if (!isOneClickBody(body, multipart)) return pageReply(errorPage(400));
      const done = await unsubscribeWithToken(db, route.token ?? "");
      // 200 with a page, never a redirect: RFC 8058 §3.2 forbids one here.
      return pageReply(done ? unsubscribedPage() : invalidLinkPage());
    }
    case "profile_settings":
      return saveProfileSettings(req, body, db);
    case "profile_unsubscribe":
    case "profile_resubscribe":
    case "logout": {
      // A form without exactly one csrf field counts as a missing token: 403.
      const submitted = parseForm(body, ["csrf"])?.csrf ?? "";
      const session = await currentSession(req, db);
      if (session === null) return unauthenticated(req);
      if (!csrfMatches(session.token, submitted)) return pageReply(errorPage(403));
      if (route.name === "logout") {
        await deleteSession(db, session.token);
        return {
          status: 303,
          body: "",
          headers: { Location: "/", "Set-Cookie": clearedSessionCookie() },
        };
      }
      // Both idempotent: a repeated click changes nothing.
      const unsubscribe = route.name === "profile_unsubscribe";
      if (unsubscribe) await deactivateProfile(db, session.profileId);
      else await activateProfile(db, session.profileId);
      return redirectToProfile(unsubscribe ? "wypisano" : "wlaczono");
    }
    case "home":
    case "health":
    case "stylesheet":
    case "login_link":
    case "profile":
    case "matches":
      // Unreachable: these routes do not allow POST (checked by the caller).
      return pageReply(errorPage(405));
  }
}

/**
 * The RFC 8058 body: exactly `List-Unsubscribe=One-Click` (urlencoded), or
 * a well-formed multipart body with exactly one `List-Unsubscribe` part whose
 * content is `One-Click` (other parts are ignored).
 */
function isOneClickBody(body: Buffer, multipart: { readonly boundary: string | null } | null) {
  if (multipart === null) {
    return parseForm(body, ["List-Unsubscribe"])?.["List-Unsubscribe"] === "One-Click";
  }
  if (multipart.boundary === null) return false;
  const values = multipartFieldValues(body, multipart.boundary, "List-Unsubscribe");
  return values?.length === 1 && values[0] === "One-Click";
}

/** 303 to /profil, which then shows `notice` once. */
function redirectToProfile(notice: Notice): Reply {
  return {
    status: 303,
    body: "",
    headers: { Location: "/profil", "Set-Cookie": noticeCookie(notice) },
  };
}

/**
 * POST /profil/ustawienia (D-027): CSRF first, then the domain schema. An
 * invalid form is shown again with the submitted values (400); a valid one
 * is saved — with the revocation of other access when the e-mail changes —
 * and answered with 303 to /profil. Concurrent saves: the last one wins.
 */
async function saveProfileSettings(
  req: IncomingMessage,
  body: Buffer,
  db: Kysely<Database>,
): Promise<Reply> {
  const form = parseMultiValueForm(
    body,
    PROFILE_FORM_SINGLE_FIELDS,
    PROFILE_FORM_MULTIPLE_FIELDS,
    PROFILE_FORM_MAX_FIELDS,
  );
  const session = await currentSession(req, db);
  if (session === null) return unauthenticated(req);
  // CSRF before the form's own rules, as on the other forms: a body without
  // exactly one csrf field is a missing token (403); a valid token with
  // fields that are not this form's is a 400.
  const submitted = form?.single.csrf ?? singleFieldValue(body, "csrf", PROFILE_FORM_MAX_FIELDS);
  if (!csrfMatches(session.token, submitted)) return pageReply(errorPage(403));
  if (form === null) return pageReply(errorPage(400));
  const csrf = csrfTokenFor(session.token);
  const stored = await getProfileSettings(db, session.profileId);
  if (stored === null) return unauthenticated(req);
  const values = formValuesFromSubmission(form.single, form.multiple);
  const result = validateProfileForm(values, stored.email);
  if (!result.ok) return pageReply(settingsPage(values, csrf, result.errors));
  try {
    const saved = await updateProfileSettings(
      db,
      session.profileId,
      result.settings,
      session.token,
    );
    if (saved === null) return unauthenticated(req);
    return redirectToProfile(saved.emailChanged ? "zmieniono_email" : "zapisano");
  } catch (error: unknown) {
    if (
      error instanceof DomainError &&
      error.code === "duplicate" &&
      error.constraint === "company_profiles_email_key"
    ) {
      return pageReply(settingsPage(values, csrf, DUPLICATE_EMAIL_ERRORS));
    }
    throw error;
  }
}

/** GET /dopasowania: the digest's candidates and rules for this one profile (D-027). */
async function matchesReply(
  db: Kysely<Database>,
  profileId: string,
  now: Date,
  missing: () => Reply,
): Promise<Reply> {
  // A stored row the schema refuses cannot be matched; the form can correct it.
  const profile = await getCompanyProfile(db, profileId).catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "invalid_stored_row")
      return "invalid" as const;
    throw error;
  });
  if (profile === "invalid") return pageReply(matchesUnavailablePage());
  if (profile === null) return missing();
  const candidates = await readDigestCandidates(db, now);
  const items = (await matchingItems(profile, candidates.offers)).sort(digestOrder);
  return pageReply(
    matchesPage({
      active: profile.active,
      hasVoivodeships: profile.voivodeships.length > 0,
      hasCounties: profile.counties.length > 0,
      stateAt: formatWarsawMinute(now),
      windowDays: DIGEST_NEW_DAYS,
      items: items.slice(0, MATCHES_SHOWN).map(digestItemView),
      more: Math.max(0, items.length - MATCHES_SHOWN),
      truncated: candidates.truncated,
    }),
  );
}

interface Session {
  readonly token: string;
  /** The session row's id (not secret, unlike the token). */
  readonly sessionId: string;
  readonly profileId: string;
}

/** The request's unexpired session, or null. */
async function currentSession(req: IncomingMessage, db: Kysely<Database>): Promise<Session | null> {
  const token = readSessionCookie(req.headers.cookie);
  if (token === null) return null;
  const session = await findSession(db, token);
  return session === null ? null : { token, ...session };
}

/** 401; a stale or unknown session cookie is cleared on the way. */
function unauthenticated(req: IncomingMessage): Reply {
  const hadCookie = req.headers.cookie?.includes(`${SESSION_COOKIE}=`) ?? false;
  return pageReply(
    loginRequiredPage(),
    hadCookie ? { "Set-Cookie": clearedSessionCookie() } : undefined,
  );
}

/**
 * Starts the web server and the hourly cleanup of expired tokens and
 * sessions. Resolves once listening; rejects when the port cannot be bound.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const { logger } = options;
  const state: ServerState = {
    matches: createMatchesSlot({
      maxWaitMs: options.matchesMaxWaitMs ?? MATCHES_MAX_WAIT_MS,
      maxWaiters: options.matchesMaxWaiters ?? MATCHES_MAX_WAITERS,
    }),
    matchesPerSession: new Map(),
    health: createHealthCheck(
      options.healthProbe ?? (() => pingDatabase(options.db)),
      options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
      logger,
    ),
  };
  const https = options.publicBaseUrl.startsWith("https:");

  const server = createServer(
    {
      // Slow or oversized requests are cut off by Node before any handler runs.
      headersTimeout: 10_000,
      requestTimeout: 15_000,
      // Node checks the two timeouts above only this often (default 30 s).
      connectionsCheckingInterval: 1_000,
      maxHeaderSize: 8 * 1024,
      requireHostHeader: true,
    },
    (req, res) => {
      const started = performance.now();
      const rawMethod = req.method ?? "";
      const method = LOGGED_METHODS.has(rawMethod) ? rawMethod : "OTHER";
      // Only the path is routed; the query is ignored and nothing of the URL is logged.
      const path = (req.url ?? "").split("?", 1)[0] ?? "";
      const route = matchRoute(path);
      const finish = (reply: Reply): void => {
        send(res, reply, https);
        logger.info("http request", {
          method,
          route: route?.name ?? "not_found",
          status: reply.status,
          durationMs: Math.round(performance.now() - started),
        });
      };

      if (route === null) {
        finish({ ...pageReply(errorPage(404)), close: rawMethod === "POST" });
        return;
      }
      if (!(route.allow as readonly string[]).includes(rawMethod)) {
        finish({
          ...pageReply(errorPage(405)),
          headers: { Allow: route.allow.join(", ") },
          close: true,
        });
        return;
      }
      handle(req, res, route, rawMethod as Method, options, state).then(
        finish,
        (error: unknown) => {
          if (error instanceof RequestAbortedError) {
            // No reply can reach the client; no access line with a made-up status.
            logger.info("http request aborted", { route: route.name, reason: "aborted" });
            res.destroy();
            return;
          }
          logger.error("http request failed", {
            route: route.name,
            ...describeDatabaseFailure(error),
          });
          if (res.headersSent) {
            res.destroy();
            return;
          }
          finish({ ...pageReply(errorPage(500)), close: true });
        },
      );
    },
  );
  server.keepAliveTimeout = 5_000;
  server.timeout = 30_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  let cleanupRun: Promise<void> | null = null;
  const cleanup = (): void => {
    if (cleanupRun !== null) return; // the previous run is still going
    cleanupRun = deleteExpiredAccess(options.db)
      .then(
        (deleted) => {
          logger.debug("access cleanup", deleted);
        },
        (error: unknown) => {
          logger.warn("access cleanup failed", { ...describeDatabaseFailure(error) });
        },
      )
      .finally(() => {
        cleanupRun = null;
      });
  };
  const intervalMs =
    options.cleanupIntervalMs === undefined ? CLEANUP_INTERVAL_MS : options.cleanupIntervalMs;
  const timer = intervalMs === null ? null : setInterval(cleanup, intervalMs);
  timer?.unref();
  if (intervalMs !== null) cleanup();

  return {
    host: address.address,
    port: address.port,
    get matchesWaiting() {
      return state.matches.waiting;
    },
    get matchesSessions() {
      return state.matchesPerSession.size;
    },
    close: async () => {
      if (timer !== null) clearInterval(timer);
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          server.closeAllConnections();
        }, SHUTDOWN_GRACE_MS);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      // The cleanup must not outlive the database the caller closes next.
      if (cleanupRun !== null) await cleanupRun;
    },
  };
}
