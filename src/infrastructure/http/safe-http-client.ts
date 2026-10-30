import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { ConfigError, crawlerContactSchema } from "../config.js";
import type { LogFields, Logger } from "../logger.js";
import { isBlockedAddress, normalizeAllowedHosts, parseRequestUrl } from "./address-policy.js";
import { HttpClientError } from "./errors.js";

export interface HttpLimits {
  /** TCP connect + TLS handshake. */
  readonly connectTimeoutMs: number;
  /** One HTTP exchange: DNS, connect, response headers and the whole body. */
  readonly requestTimeoutMs: number;
  /** Response body size, enforced while reading and again after decompression. */
  readonly maxBytes: number;
}

export const DEFAULT_LIMITS: HttpLimits = {
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxBytes: 5 * 1024 * 1024,
};

export const DEFAULT_MIN_INTERVAL_MS = 2_000;
/** No adapter may poll a host faster than this, whatever it configures. */
export const MIN_INTERVAL_FLOOR_MS = 1_000;
export const DEFAULT_ERROR_BUDGET = 10;
export const MAX_REDIRECTS = 3;
export const MAX_RETRIES = 2;
/**
 * A Retry-After longer than this is not waited for: the request fails instead,
 * and so does every later request to that host until the remaining time is
 * within this cap.
 */
export const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/** Network error codes worth one more try: the connection failed or broke, not the policy. */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

const USER_AGENT_PRODUCT = "RadarZamowien/0.1";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Returns every address of a hostname (all A and AAAA records). */
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface TransportRequest {
  readonly url: URL;
  /** Already validated address the connection must go to (DNS pinning). */
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
}

/** Performs one GET without following redirects or decoding the body. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeHttpClientOptions {
  /** Source identifier, written to every log entry. */
  readonly sourceId: string;
  /** The adapter's static allowlist: exact hostnames, case-insensitive, no wildcards. */
  readonly allowedHosts: readonly string[];
  /** `CRAWLER_CONTACT` (AppConfig.crawlerContact); required, goes into the User-Agent. */
  readonly contact: string | null;
  readonly logger: Logger;
  /** Minimum pause between requests to one host; default 2 s, never below 1 s. */
  readonly minIntervalMs?: number;
  /** Failed attempts after which the client refuses every further request; default 10. */
  readonly errorBudget?: number;
}

/**
 * TEST-ONLY seams. A custom transport or resolver bypasses address pinning and
 * the SSRF check, a custom clock or sleep bypasses rate limiting, so production
 * code must call `new SafeHttpClient(options)` without this argument; an ESLint
 * rule rejects a second constructor argument anywhere under `src/`. `limits`
 * can only tighten DEFAULT_LIMITS, never loosen them.
 */
export interface SafeHttpClientDeps {
  readonly resolveHost?: ResolveHost;
  readonly transport?: Transport;
  /** Monotonic milliseconds; used for rate limiting, backoff, Retry-After deadlines, durations. */
  readonly now?: () => number;
  /** Epoch milliseconds; used only to turn a Retry-After HTTP-date into a delay. */
  readonly wallClock?: () => number;
  /** Must reject when the signal aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Uniform in [0, 1), for backoff jitter. */
  readonly random?: () => number;
  readonly limits?: Partial<HttpLimits>;
}

export interface GetOptions {
  /**
   * Cancels the request, including the wait for its place in the client's queue
   * and retry and rate-limit waits (e.g. a run timeout).
   */
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  /** Final URL after redirects, without fragment. May contain a query: do not log it. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  /** Decompressed body bytes; decoding to text is the adapter's job. */
  readonly body: Buffer;
}

interface OkOutcome {
  readonly kind: "ok";
  readonly response: HttpResponse;
}
interface RedirectOutcome {
  readonly kind: "redirect";
  readonly status: number;
  readonly location: string;
}
/** A non-2xx, non-redirect status: turned into an http_status failure (maybe retried). */
interface StatusOutcome {
  readonly kind: "status";
  readonly status: number;
  readonly retryAfter: string | null;
}
type Outcome = OkOutcome | RedirectOutcome | StatusOutcome;

/** User-Agent sent with every request: project name plus the operator's contact. */
export function buildUserAgent(contact: string): string {
  const reference = contact.startsWith("https:") ? contact : `mailto:${contact}`;
  return `${USER_AGENT_PRODUCT} (+${reference})`;
}

/**
 * Milliseconds to wait according to a Retry-After value (delay-seconds or an
 * HTTP-date), or null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP-date formats (IMF-fixdate, RFC 850, asctime) all start with a day name;
  // the shape check keeps V8's lenient Date.parse from accepting e.g. "-5".
  if (trimmed.length > 64 || !/^[A-Za-z]{3,9},? [\w :-]+$/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * A `lookup` that ignores the hostname and returns the address validated
 * beforehand, so the socket connects exactly there even if DNS now answers
 * differently (DNS rebinding). TLS still uses the hostname for SNI and
 * certificate verification, and the Host header keeps the hostname.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Default resolver: the system resolver (as the OS would use), all addresses. */
export const systemResolveHost: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Default transport: node:https with a fresh connection per request (no
 * keep-alive pool that could reuse a socket), the pinned address, a connect
 * timeout covering TCP + TLS, and the request signal for the total timeout.
 * Environment proxy variables are not used.
 */
export const httpsTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const { url } = request;
    const req = https.request({
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: request.headers,
      agent: false,
      lookup: pinnedLookup(request.address, request.family),
      signal: request.signal,
    });
    let connectTimer: NodeJS.Timeout | undefined;
    const clearConnectTimer = () => {
      clearTimeout(connectTimer);
    };
    req.once("socket", (socket) => {
      connectTimer = setTimeout(() => {
        req.destroy(new HttpClientError("timeout", { host: url.hostname, retryable: true }));
      }, request.connectTimeoutMs);
      socket.once("secureConnect", clearConnectTimer);
    });
    req.once("close", clearConnectTimer);
    req.once("response", (response) => {
      clearConnectTimer();
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    // `on`, not `once`: a second error without a listener would crash the process.
    req.on("error", (error) => {
      clearConnectTimer();
      reject(error);
    });
    req.end();
  });

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** A function, not an inline check, so TypeScript does not narrow `aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Resolves with the promise, or rejects with the signal's reason when it aborts first. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("rejected"));
      },
    );
  });
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return delay(ms, undefined, signal === undefined ? {} : { signal });
}

function resolveLimits(overrides: Partial<HttpLimits> = {}): HttpLimits {
  const pick = (key: keyof HttpLimits): number => {
    const value = overrides[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Invalid limit: ${key}`);
    return Math.min(value, DEFAULT_LIMITS[key]);
  };
  return {
    connectTimeoutMs: pick("connectTimeoutMs"),
    requestTimeoutMs: pick("requestTimeoutMs"),
    maxBytes: pick("maxBytes"),
  };
}

/**
 * The only route to the network for source adapters (docs/SECURITY.md §2–§6).
 *
 * Every request — the first one and every redirect hop — is checked the same
 * way: WHATWG URL, `https:` only, no credentials/port/IP literal, host on the
 * allowlist, all DNS answers outside blocked ranges, connection pinned to the
 * validated address. Requests of one client run strictly one after another, with
 * at least `minIntervalMs` between the end of one request and the start of the
 * next to the same host. Transient failures (timeouts, connection errors, 429,
 * 502–504) are retried at most twice with jittered exponential backoff,
 * honouring Retry-After up to MAX_RETRY_AFTER_MS. A Retry-After also becomes a
 * per-host deadline: later requests to that host wait for it, or fail without
 * traffic while it is more than MAX_RETRY_AFTER_MS away. Every failed attempt
 * consumes the error budget, after which the client refuses all requests.
 *
 * Create one client per source run: the error budget and rate-limit state are
 * per instance. Production code passes only `options` (see SafeHttpClientDeps).
 */
export class SafeHttpClient {
  readonly #sourceId: string;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #userAgent: string;
  readonly #logger: Logger;
  readonly #minIntervalMs: number;
  readonly #errorBudget: number;
  readonly #limits: HttpLimits;
  readonly #resolveHost: ResolveHost;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #wallClock: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly #random: () => number;
  readonly #lastRequestEnd = new Map<string, number>();
  /** Per-host deadline from a Retry-After, with the status that set it. */
  readonly #notBefore = new Map<string, { readonly until: number; readonly status: number }>();
  #failures = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SafeHttpClientOptions, deps: SafeHttpClientDeps = {}) {
    if (options.contact === null || !crawlerContactSchema.safeParse(options.contact).success) {
      throw new ConfigError(
        "CRAWLER_CONTACT is required for fetching sources (an e-mail address or https URL)",
      );
    }
    if (options.sourceId.trim() === "") throw new TypeError("sourceId must not be empty");
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < MIN_INTERVAL_FLOOR_MS) {
      throw new TypeError(`minIntervalMs must be an integer >= ${String(MIN_INTERVAL_FLOOR_MS)}`);
    }
    const errorBudget = options.errorBudget ?? DEFAULT_ERROR_BUDGET;
    if (!Number.isInteger(errorBudget) || errorBudget < 1) {
      throw new TypeError("errorBudget must be a positive integer");
    }
    this.#sourceId = options.sourceId;
    this.#allowedHosts = normalizeAllowedHosts(options.allowedHosts);
    this.#userAgent = buildUserAgent(options.contact);
    this.#logger = options.logger;
    this.#minIntervalMs = minIntervalMs;
    this.#errorBudget = errorBudget;
    this.#limits = resolveLimits(deps.limits);
    this.#resolveHost = deps.resolveHost ?? systemResolveHost;
    this.#transport = deps.transport ?? httpsTransport;
    this.#now = deps.now ?? (() => performance.now());
    this.#wallClock = deps.wallClock ?? Date.now;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
  }

  /** Fails with HttpClientError; never with another error type for request problems. */
  get(url: string | URL, options: GetOptions = {}): Promise<HttpResponse> {
    const { signal } = options;
    // `previous` settles when every earlier call has finished; it never rejects.
    const previous = this.#queue;
    // The caller's signal also cancels the wait for its place in the queue. Like
    // an aborted rate-limit wait, this sends no traffic and does not consume the
    // error budget. raceSignal removes its abort listener once either side settles.
    const turn = signal === undefined ? previous : raceSignal(previous, signal);
    const result = turn.then(
      () => this.#get(url, signal),
      () => {
        throw new HttpClientError("aborted");
      },
    );
    // An aborted queued call settles `result` early, so the next call must still
    // wait for `previous` (the request that may still be in flight) as well as
    // this one: an abort gives up only its own place and never lets a later
    // request overtake a running one.
    const settled = result.catch(() => undefined);
    this.#queue = previous.then(() => settled);
    return result;
  }

  async #get(input: string | URL, signal: AbortSignal | undefined): Promise<HttpResponse> {
    let url = this.#checkUrl(() => parseRequestUrl(input, this.#allowedHosts));
    for (let redirects = 0; ; redirects++) {
      const outcome = await this.#requestWithRetries(url, signal);
      if (outcome.kind === "ok") return outcome.response;
      if (redirects >= MAX_REDIRECTS) {
        throw this.#policyFailure(
          new HttpClientError("too_many_redirects", { host: url.hostname }),
        );
      }
      const from = url;
      url = this.#checkUrl(() => parseRequestUrl(outcome.location, this.#allowedHosts, from));
    }
  }

  /** URL policy failures happen before any traffic but still count against the budget. */
  #checkUrl(parse: () => URL): URL {
    this.#ensureBudget(null);
    try {
      return parse();
    } catch (error: unknown) {
      if (error instanceof HttpClientError) throw this.#policyFailure(error);
      throw error;
    }
  }

  #policyFailure(error: HttpClientError, fields: LogFields = {}): HttpClientError {
    this.#failures++;
    this.#logger.warn("http request rejected", {
      sourceId: this.#sourceId,
      host: error.host,
      method: "GET",
      errorCode: error.code,
      ...fields,
    });
    return error;
  }

  #ensureBudget(host: string | null): void {
    if (this.#failures < this.#errorBudget) return;
    this.#logger.warn("http request refused", {
      sourceId: this.#sourceId,
      host,
      method: "GET",
      errorCode: "budget_exhausted",
      failures: this.#failures,
    });
    throw new HttpClientError("budget_exhausted", { host });
  }

  async #requestWithRetries(
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<OkOutcome | RedirectOutcome> {
    const host = url.hostname;
    for (let attempt = 1; ; attempt++) {
      this.#ensureBudget(host);
      await this.#waitForTurn(host, signal);
      const started = this.#now();
      let outcome: Outcome;
      try {
        outcome = await this.#attempt(url, signal);
      } catch (error: unknown) {
        const failure =
          error instanceof HttpClientError ? error : new HttpClientError("network", { host });
        if (!this.#onFailure(host, attempt, started, failure)) throw failure;
        await this.#backoff(host, attempt, null, signal);
        continue;
      }
      if (outcome.kind !== "status") {
        this.#logger.info("http request", {
          sourceId: this.#sourceId,
          host,
          method: "GET",
          status: outcome.kind === "ok" ? outcome.response.status : outcome.status,
          durationMs: Math.round(this.#now() - started),
          attempt,
          bytes: outcome.kind === "ok" ? outcome.response.body.length : 0,
        });
        return outcome;
      }
      const transient = TRANSIENT_STATUSES.has(outcome.status);
      const failure = new HttpClientError("http_status", {
        status: outcome.status,
        host,
        retryable: transient,
      });
      const retryAfterMs = transient
        ? parseRetryAfter(outcome.retryAfter, this.#wallClock())
        : null;
      // Remembered for the host, whatever its length and whether or not this
      // call retries: later calls wait for it or fail without traffic.
      if (retryAfterMs !== null) this.#deferHost(host, retryAfterMs, outcome.status);
      const waitTooLong = retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS;
      if (!this.#onFailure(host, attempt, started, failure, waitTooLong)) throw failure;
      await this.#backoff(host, attempt, retryAfterMs, signal);
    }
  }

  /** Counts and logs a failed attempt; returns whether it will be retried. */
  #onFailure(
    host: string,
    attempt: number,
    started: number,
    failure: HttpClientError,
    retryAfterTooLong = false,
  ): boolean {
    this.#failures++;
    // A retry the budget would refuse anyway is not attempted: the caller gets
    // the real failure instead of budget_exhausted, without the backoff wait.
    const willRetry =
      failure.retryable &&
      attempt <= MAX_RETRIES &&
      !retryAfterTooLong &&
      this.#failures < this.#errorBudget;
    this.#logger.warn("http request failed", {
      sourceId: this.#sourceId,
      host,
      method: "GET",
      status: failure.status,
      durationMs: Math.round(this.#now() - started),
      attempt,
      errorCode: failure.code,
      causeCode: failure.causeCode,
      retryAfterTooLong,
      willRetry,
    });
    return willRetry;
  }

  async #backoff(
    host: string,
    attempt: number,
    retryAfterMs: number | null,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const backoffMs = Math.round(BACKOFF_BASE_MS * 2 ** (attempt - 1) * (1 + this.#random()));
    try {
      await this.#sleep(Math.max(backoffMs, retryAfterMs ?? 0), signal);
    } catch {
      throw new HttpClientError("aborted", { host });
    }
  }

  /** One HTTP exchange with its own total timeout. Rejects with HttpClientError only. */
  async #attempt(url: URL, callerSignal: AbortSignal | undefined): Promise<Outcome> {
    const host = url.hostname;
    if (isAborted(callerSignal)) throw new HttpClientError("aborted", { host });
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new HttpClientError("timeout", { host, retryable: true }));
    }, this.#limits.requestTimeoutMs);
    const signal =
      callerSignal === undefined ? timeout.signal : AbortSignal.any([callerSignal, timeout.signal]);
    try {
      const { address, family } = await this.#resolve(host, signal);
      const response = await this.#transport({
        url,
        address,
        family,
        headers: {
          "user-agent": this.#userAgent,
          accept: "*/*",
          "accept-encoding": "gzip, deflate, br",
        },
        signal,
        connectTimeoutMs: this.#limits.connectTimeoutMs,
      });
      return await this.#handleResponse(url, response, signal);
    } catch (error: unknown) {
      if (isAborted(callerSignal)) throw new HttpClientError("aborted", { host });
      if (timeout.signal.aborted) throw new HttpClientError("timeout", { host, retryable: true });
      if (error instanceof HttpClientError) throw error;
      const code = errorCode(error);
      throw new HttpClientError("network", {
        host,
        causeCode: code,
        retryable: code !== null && TRANSIENT_NETWORK_CODES.has(code),
      });
    } finally {
      clearTimeout(timer);
      this.#lastRequestEnd.set(host, this.#now());
    }
  }

  #deferHost(host: string, retryAfterMs: number, status: number): void {
    const until = this.#now() + retryAfterMs;
    const current = this.#notBefore.get(host);
    if (current === undefined || until > current.until)
      this.#notBefore.set(host, { until, status });
  }

  /**
   * Per-host spacing: waits until minIntervalMs after the previous request to
   * the host ended and until the host's Retry-After deadline has passed. A
   * deadline more than MAX_RETRY_AFTER_MS away fails the request without traffic.
   */
  async #waitForTurn(host: string, signal: AbortSignal | undefined): Promise<void> {
    const now = this.#now();
    let readyAt = now;
    const deferred = this.#notBefore.get(host);
    if (deferred !== undefined) {
      const remainingMs = deferred.until - now;
      if (remainingMs <= 0) {
        this.#notBefore.delete(host);
      } else if (remainingMs > MAX_RETRY_AFTER_MS) {
        throw this.#policyFailure(
          new HttpClientError("http_status", { status: deferred.status, host }),
          { status: deferred.status, retryAfterMs: Math.ceil(remainingMs) },
        );
      } else {
        readyAt = deferred.until;
      }
    }
    const last = this.#lastRequestEnd.get(host);
    if (last !== undefined) readyAt = Math.max(readyAt, last + this.#minIntervalMs);
    const waitMs = Math.ceil(readyAt - now);
    if (waitMs <= 0) return;
    try {
      await this.#sleep(waitMs, signal);
    } catch {
      throw new HttpClientError("aborted", { host });
    }
  }

  /** Resolves all addresses; any blocked one rejects the host. Prefers IPv4 to connect. */
  async #resolve(host: string, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
    let records: readonly ResolvedAddress[];
    try {
      records = await raceSignal(this.#resolveHost(host), signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      const code = errorCode(error);
      throw new HttpClientError("dns_failed", {
        host,
        causeCode: code,
        retryable: code === "EAI_AGAIN" || code === "ETIMEOUT",
      });
    }
    if (records.length === 0) throw new HttpClientError("dns_failed", { host });
    if (records.some((record) => isBlockedAddress(record.address))) {
      throw new HttpClientError("blocked_address", { host });
    }
    const chosen = records.find((record) => isIP(record.address) === 4) ?? records[0];
    if (chosen === undefined) throw new HttpClientError("dns_failed", { host });
    return { address: chosen.address, family: isIP(chosen.address) === 6 ? 6 : 4 };
  }

  async #handleResponse(
    url: URL,
    response: TransportResponse,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const { status, headers, body } = response;
    if (status >= 200 && status < 300) {
      const bytes = await readBody(body, headers, this.#limits.maxBytes, signal, url.hostname);
      return {
        kind: "ok",
        response: {
          url: url.href,
          status,
          contentType: headerValue(headers["content-type"]),
          body: bytes,
        },
      };
    }
    // The body of a redirect or error response is never read.
    body.destroy();
    const location = headerValue(headers.location);
    if (REDIRECT_STATUSES.has(status) && location !== null) {
      return { kind: "redirect", status, location };
    }
    return { kind: "status", status, retryAfter: headerValue(headers["retry-after"]) };
  }
}

type Decoder = (input: Buffer, options: { maxOutputLength: number }) => Buffer;

/**
 * `deflate` should be zlib-wrapped (RFC 9110), but some servers send raw
 * DEFLATE; the two-byte zlib header (CM = 8, header checksum) tells them apart.
 */
const inflateDeflate: Decoder = (input, options) => {
  const [first, second] = input;
  const zlibWrapped =
    first !== undefined &&
    second !== undefined &&
    (first & 0x0f) === 8 &&
    ((first << 8) | second) % 31 === 0;
  return zlibWrapped ? inflateSync(input, options) : inflateRawSync(input, options);
};

function selectDecoder(header: string | null, host: string): Decoder | null {
  const coding = (header ?? "").trim().toLowerCase();
  switch (coding) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return gunzipSync;
    case "deflate":
      return inflateDeflate;
    case "br":
      return brotliDecompressSync;
    default:
      // Includes stacked codings ("gzip, br"): never requested, so not supported.
      throw new HttpClientError("unsupported_encoding", { host });
  }
}

/**
 * Reads the body with the size limit enforced while streaming (Content-Length is
 * only used to reject early, never trusted), then decompresses with the same
 * limit on the output (`maxOutputLength` stops a zip bomb without inflating it).
 */
async function readBody(
  body: Readable,
  headers: IncomingHttpHeaders,
  maxBytes: number,
  signal: AbortSignal,
  host: string,
): Promise<Buffer> {
  let decoder: Decoder | null;
  try {
    decoder = selectDecoder(headerValue(headers["content-encoding"]), host);
    const declared = headerValue(headers["content-length"]);
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
      throw new HttpClientError("too_large", { host });
    }
  } catch (error: unknown) {
    body.destroy();
    throw error;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  await pipeline(
    body,
    async (source: AsyncIterable<Buffer | string>) => {
      for await (const chunk of source) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > maxBytes) throw new HttpClientError("too_large", { host });
        chunks.push(buffer);
      }
    },
    { signal },
  );
  const raw = Buffer.concat(chunks, size);
  // Some servers send Content-Encoding on an empty body (empty list, 204); there
  // is nothing to decode, and zlib would reject it as truncated (Z_BUF_ERROR).
  if (decoder === null || raw.length === 0) return raw;
  try {
    return decoder(raw, { maxOutputLength: maxBytes });
  } catch (error: unknown) {
    if (errorCode(error) === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpClientError("too_large", { host });
    }
    throw new HttpClientError("decompression_failed", { host, causeCode: errorCode(error) });
  }
}
