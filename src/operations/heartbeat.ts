import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * The heartbeat of `status` (PR-07B, D-029): one GET of HEARTBEAT_URL after a
 * `status` without a problem, so a dead man's switch (healthchecks.io or the
 * like) alerts when the pings stop — when the host, cron or `status` itself
 * is down, which `status --notify` cannot report.
 *
 * Not the SafeHttpClient (D-014): that client is for the sources' public
 * pages, with their host allowlist and rate limits. This is one request to
 * one URL the operator configured; it is bounded here instead: a hard time
 * limit, no redirect followed, no body read, no retry.
 *
 * The URL is a secret (the services put the check's token in it): it is
 * never logged or printed, and the failure reasons below never contain it.
 */

/** Upper bound of the whole ping: connect, TLS, request and response head. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export type HeartbeatResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `timeout`, `http_<status>` (a 3xx too: not followed) or `network[_<errno>]`. */
      readonly reason: string;
    };

export interface HeartbeatOptions {
  readonly timeoutMs?: number;
  /** node:https's request; tests pass node:http's or a TLS one with their own CA. */
  readonly request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

/** Sends one ping; never throws and never retries. */
export function sendHeartbeat(
  url: string,
  options: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const send = options.request ?? httpsRequest;
  return new Promise((resolve) => {
    let settled = false;
    let request: ClientRequest | null = null;
    const finish = (result: HeartbeatResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(result);
    };
    // The limit bounds the result, not the process's lifetime: destroying the
    // request does not cancel a DNS lookup already in libuv's thread pool
    // (getaddrinfo cannot be interrupted), so the process may stay alive until
    // the resolver's own timeout. The exit code and the logs are already
    // decided by then and do not change.
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    try {
      const target = new URL(url);
      request = send(
        {
          method: "GET",
          // URL keeps an IPv6 literal's brackets; the request wants the address.
          hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
          ...(target.port === "" ? {} : { port: Number(target.port) }),
          path: `${target.pathname}${target.search}`,
          headers: { "user-agent": "radar-zamowien-status" },
          // A fresh connection, closed after the ping: nothing keeps the process alive.
          agent: false,
        },
        (response) => {
          // The body is never read: only the status matters, and destroying
          // the request discards it.
          response.on("error", () => undefined);
          const code = response.statusCode ?? 0;
          finish(
            code >= 200 && code < 300
              ? { ok: true }
              : { ok: false, reason: `http_${String(code)}` },
          );
        },
      );
      request.on("error", (error: unknown) => {
        finish({ ok: false, reason: networkReason(error) });
      });
      request.end();
    } catch (error) {
      finish({ ok: false, reason: networkReason(error) });
    }
  });
}

/** `network`, or `network_<errno>` for a plain errno code — never an error's message. */
function networkReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)
    ? `network_${code.toLowerCase()}`
    : "network";
}
