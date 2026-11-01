import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Kysely } from "kysely";
import {
  consumeLoginToken,
  deactivateProfile,
  deleteExpiredAccess,
  deleteSession,
  findSessionProfile,
  getProfileStatus,
  isUsableAccessToken,
  SESSION_TTL_MS,
  unsubscribeWithToken,
} from "../infrastructure/db/access-repository.js";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import type { Database } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";
import { multipartBoundary, multipartFieldValues } from "./multipart.js";
import {
  errorPage,
  homePage,
  invalidLinkPage,
  loginConfirmPage,
  loginRequiredPage,
  type Page,
  profilePage,
  STYLESHEET,
  unsubscribeConfirmPage,
  unsubscribedPage,
} from "./pages.js";
import {
  clearedSessionCookie,
  csrfMatches,
  csrfTokenFor,
  originAllowed,
  readSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
} from "./session.js";

/**
 * The web access (PR-06A, D-025, D-026): plain node:http, no framework.
 * Deny by default — a request is served only when its path matches one of
 * the routes below and its method is one the route allows; the profile is
 * taken only from the session, never from the URL or a form. TLS is the
 * reverse proxy's job (docs/SECURITY.md §11); the server listens on
 * WEB_HOST, 127.0.0.1 by default.
 */

/** Largest accepted request body: the forms here carry one or two short fields. */
export const MAX_BODY_BYTES = 8 * 1024;
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
  | "stylesheet"
  | "login_link"
  | "login"
  | "profile"
  | "profile_unsubscribe"
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
    case "/dostep":
      return { name: "login", allow: FORM };
    case "/profil":
      return { name: "profile", allow: PAGE };
    case "/profil/wypisz":
      return { name: "profile_unsubscribe", allow: FORM };
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

function send(res: ServerResponse, reply: Reply): void {
  const body = Buffer.from(reply.body, "utf8");
  res.statusCode = reply.status;
  res.setHeader("Content-Type", reply.contentType ?? "text/html; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Pages may hold a token or a session's data: no cache may keep them.
  res.setHeader("Cache-Control", reply.cacheable === true ? "public, max-age=3600" : "no-store");
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
}

export interface WebServer {
  readonly host: string;
  readonly port: number;
  /** Stops accepting connections, lets open requests finish (bounded), then resolves. */
  close(): Promise<void>;
}

/** The handling of one request: a reply, decided without writing anything yet. */
async function handle(
  req: IncomingMessage,
  route: RouteMatch,
  method: Method,
  options: WebServerOptions,
): Promise<Reply> {
  const { db } = options;

  if (method !== "POST") {
    switch (route.name) {
      case "home":
        return pageReply(homePage());
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
        const usable = await isUsableAccessToken(db, token, "unsubscribe");
        return pageReply(usable ? unsubscribeConfirmPage(token) : invalidLinkPage());
      }
      case "profile": {
        const session = await currentSession(req, db);
        if (session === null) return unauthenticated(req);
        const profile = await getProfileStatus(db, session.profileId);
        if (profile === null) return unauthenticated(req);
        return pageReply(profilePage(profile, csrfTokenFor(session.token)));
      }
      case "login":
      case "profile_unsubscribe":
      case "logout":
        // Unreachable: these routes allow POST only (checked by the caller).
        return pageReply(errorPage(405));
    }
  }

  // RFC 8058: a mail provider POSTs the one-click body from its own servers,
  // with no cookie and possibly a foreign Origin; the unguessable token in the
  // path is the authorization. Every other form must come from our own pages.
  if (route.name !== "unsubscribe" && !originAllowed(req.headers.origin, options.publicBaseUrl)) {
    return { ...pageReply(errorPage(403)), close: true };
  }
  // Forms are urlencoded. Only the one-click unsubscribe also takes
  // multipart/form-data: RFC 8058 §3.2 says a provider SHOULD send that.
  const contentType = req.headers["content-type"];
  const multipart = route.name === "unsubscribe" ? multipartBoundary(contentType) : null;
  if (multipart === null && !isFormContentType(contentType)) {
    return { ...pageReply(errorPage(415)), close: true };
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    return { ...pageReply(errorPage(413)), close: true };
  }
  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) return { ...pageReply(errorPage(413)), close: true };

  switch (route.name) {
    case "login": {
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
    case "profile_unsubscribe":
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
      await deactivateProfile(db, session.profileId);
      return { status: 303, body: "", headers: { Location: "/profil" } };
    }
    case "home":
    case "stylesheet":
    case "login_link":
    case "profile":
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

interface Session {
  readonly token: string;
  readonly profileId: string;
}

/** The request's unexpired session, or null. */
async function currentSession(req: IncomingMessage, db: Kysely<Database>): Promise<Session | null> {
  const token = readSessionCookie(req.headers.cookie);
  if (token === null) return null;
  const profileId = await findSessionProfile(db, token);
  return profileId === null ? null : { token, profileId };
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
        send(res, reply);
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
      handle(req, route, rawMethod as Method, options).then(finish, (error: unknown) => {
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
      });
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
