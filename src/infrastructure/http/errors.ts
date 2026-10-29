/**
 * Closed set of SafeHttpClient failure classes. Callers (adapters, ingestion)
 * branch on `code`, never on the message.
 */
export const httpClientErrorCodes = [
  "invalid_url", // not parseable, not https:, credentials, non-default port, IP literal
  "host_not_allowed", // hostname not on the client's allowlist
  "blocked_address", // DNS returned a private/loopback/special-purpose address
  "dns_failed",
  "timeout", // connect or total request timeout
  "too_large", // response body above the size limit (after decompression)
  "too_many_redirects",
  "http_status", // non-2xx final status; see `status`
  "network", // connection reset/refused, TLS failure, truncated body, ...
  "unsupported_encoding", // Content-Encoding other than gzip/deflate/br/identity
  "decompression_failed",
  "budget_exhausted", // the client's error budget is used up
  "aborted", // cancelled through the caller's AbortSignal
] as const;

export type HttpClientErrorCode = (typeof httpClientErrorCodes)[number];

const messages: Readonly<Record<HttpClientErrorCode, string>> = {
  invalid_url: "URL rejected by policy",
  host_not_allowed: "host is not on the allowlist",
  blocked_address: "host resolves to a blocked address",
  dns_failed: "DNS resolution failed",
  timeout: "request timed out",
  too_large: "response exceeds the size limit",
  too_many_redirects: "too many redirects",
  http_status: "unexpected HTTP status",
  network: "network error",
  unsupported_encoding: "unsupported Content-Encoding",
  decompression_failed: "response decompression failed",
  budget_exhausted: "error budget exhausted, no further requests",
  aborted: "request aborted",
};

export interface HttpClientErrorDetails {
  /** HTTP status of the response that caused the error, when there was one. */
  readonly status?: number | null;
  /** Hostname of the request (never the full URL: paths/queries may carry tokens). */
  readonly host?: string | null;
  /** System/library error code of the underlying failure (e.g. `ECONNRESET`), for diagnostics. */
  readonly causeCode?: string | null;
  /** Whether the failure is transient; the client uses it to decide on a retry. */
  readonly retryable?: boolean;
}

/**
 * Error thrown by SafeHttpClient. The message is fixed per code (plus the HTTP
 * status), so it never contains a URL, query string, header or response body
 * and is safe to log or show. The underlying error is not attached as `cause`:
 * its message is not under our control.
 */
export class HttpClientError extends Error {
  override readonly name = "HttpClientError";
  readonly code: HttpClientErrorCode;
  readonly status: number | null;
  readonly host: string | null;
  readonly causeCode: string | null;
  readonly retryable: boolean;

  constructor(code: HttpClientErrorCode, details: HttpClientErrorDetails = {}) {
    const status = details.status ?? null;
    super(status === null ? messages[code] : `${messages[code]} (${String(status)})`);
    this.code = code;
    this.status = status;
    this.host = details.host ?? null;
    this.causeCode = details.causeCode ?? null;
    this.retryable = details.retryable ?? false;
  }
}
