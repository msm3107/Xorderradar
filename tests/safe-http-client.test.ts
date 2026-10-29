import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/infrastructure/config.js";
import { HttpClientError, type HttpClientErrorCode } from "../src/infrastructure/http/errors.js";
import {
  buildUserAgent,
  DEFAULT_LIMITS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  SafeHttpClient,
  type ResolvedAddress,
  type SafeHttpClientDeps,
  type SafeHttpClientOptions,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../src/infrastructure/logger.js";

const CONTACT = "https://radar.example.com/bot";
const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
const MAX = DEFAULT_LIMITS.maxBytes;

interface FakeReply {
  readonly status: number;
  readonly headers?: IncomingHttpHeaders;
  readonly body?: Buffer | readonly Buffer[] | Readable;
}

type Step = FakeReply | Error | ((request: TransportRequest) => Promise<TransportResponse>);

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function toBody(body: FakeReply["body"]): Readable {
  if (body === undefined) return Readable.from([]);
  if (body instanceof Readable) return body;
  return Readable.from(Buffer.isBuffer(body) ? [body] : [...body]);
}

/** Transport that replays scripted steps and records what it was asked. */
function scriptedTransport(steps: Step[]) {
  const requests: TransportRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const transport: Transport = async (request) => {
    requests.push(request);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await Promise.resolve();
      const step = steps.shift();
      if (step === undefined) throw new Error("unexpected extra request");
      if (step instanceof Error) throw step;
      if (typeof step === "function") return await step(request);
      return { status: step.status, headers: step.headers ?? {}, body: toBody(step.body) };
    } finally {
      active--;
    }
  };
  return { transport, requests, maxActive: () => maxActive };
}

/** Never answers; rejects only when the request signal aborts (like a hanging server). */
const hangingStep = (request: TransportRequest): Promise<TransportResponse> =>
  new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => {
      reject(new Error("aborted by signal"));
    });
  });

function setup(
  steps: Step[],
  options: Partial<SafeHttpClientOptions> = {},
  deps: SafeHttpClientDeps = {},
) {
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const resolved: string[] = [];
  const logLines: string[] = [];
  const scripted = scriptedTransport(steps);
  const resolveHost = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    resolved.push(hostname);
    await Promise.resolve();
    return [{ address: PUBLIC_V4, family: 4 }];
  };
  const client = new SafeHttpClient(
    {
      sourceId: "test-source",
      allowedHosts: ["example.org", "files.example.org"],
      contact: CONTACT,
      logger: createLogger("debug", (line) => logLines.push(line)),
      ...options,
    },
    {
      transport: scripted.transport,
      resolveHost,
      now: () => clock,
      wallClock: () => clock,
      sleep: async (ms, signal) => {
        if (signal?.aborted === true) throw new Error("aborted");
        sleeps.push(ms);
        clock += ms;
        await Promise.resolve();
      },
      random: () => 0,
      ...deps,
    },
  );
  return {
    client,
    sleeps,
    resolved,
    requests: scripted.requests,
    maxActive: scripted.maxActive,
    logs: () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    rawLogs: () => logLines.join(""),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<HttpClientError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpClientError);
    return error as HttpClientError;
  }
  throw new Error("expected the request to fail");
}

async function codeOf(promise: Promise<unknown>): Promise<HttpClientErrorCode> {
  return (await failureOf(promise)).code;
}

describe("SafeHttpClient construction", () => {
  const base: SafeHttpClientOptions = {
    sourceId: "s",
    allowedHosts: ["example.org"],
    contact: CONTACT,
    logger: createLogger("error", () => undefined),
  };

  it("requires CRAWLER_CONTACT, naming the variable but not the value", () => {
    expect(() => new SafeHttpClient({ ...base, contact: null })).toThrow(ConfigError);
    const invalid = "not a contact s3cr3t";
    let message = "";
    try {
      new SafeHttpClient({ ...base, contact: invalid });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("CRAWLER_CONTACT");
    expect(message).not.toContain("s3cr3t");
  });

  it("never allows polling a host faster than once per second", () => {
    expect(() => new SafeHttpClient({ ...base, minIntervalMs: 999 })).toThrow(TypeError);
    expect(() => new SafeHttpClient({ ...base, minIntervalMs: 0 })).toThrow(TypeError);
    expect(() => new SafeHttpClient({ ...base, minIntervalMs: 1000 })).not.toThrow();
  });

  it("rejects an invalid allowlist or error budget", () => {
    expect(() => new SafeHttpClient({ ...base, allowedHosts: [] })).toThrow(TypeError);
    expect(() => new SafeHttpClient({ ...base, allowedHosts: ["*.example.org"] })).toThrow(
      TypeError,
    );
    expect(() => new SafeHttpClient({ ...base, errorBudget: 0 })).toThrow(TypeError);
    expect(() => new SafeHttpClient({ ...base, sourceId: " " })).toThrow(TypeError);
  });

  it("only lets limits be tightened, never loosened", async () => {
    const big = Buffer.alloc(MAX + 1);
    const { client } = setup([{ status: 200, body: big }], {}, { limits: { maxBytes: MAX * 10 } });
    expect(await codeOf(client.get("https://example.org/"))).toBe("too_large");
  });
});

describe("buildUserAgent", () => {
  it("identifies the project and the operator contact", () => {
    expect(buildUserAgent("https://radar.example.com/bot")).toBe(
      "RadarZamowien/0.1 (+https://radar.example.com/bot)",
    );
    expect(buildUserAgent("ops@radar.example.com")).toBe(
      "RadarZamowien/0.1 (+mailto:ops@radar.example.com)",
    );
  });
});

describe("SafeHttpClient success path", () => {
  it("returns final URL, status, content type and body bytes", async () => {
    const { client } = setup([
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: [Buffer.from('{"a":'), Buffer.from("1}")],
      },
    ]);
    const response = await client.get("https://Example.org/api?page=1#top");
    expect(response.url).toBe("https://example.org/api?page=1");
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json; charset=utf-8");
    expect(response.body.toString("utf8")).toBe('{"a":1}');
  });

  it("returns a null content type when the source sends none", async () => {
    const { client } = setup([{ status: 200, body: Buffer.from("x") }]);
    expect((await client.get("https://example.org/")).contentType).toBeNull();
  });

  it("sends the fixed User-Agent and connects to the validated address", async () => {
    const { client, requests } = setup([{ status: 200 }]);
    await client.get("https://example.org/x");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.headers["user-agent"]).toBe(buildUserAgent(CONTACT));
    expect(request?.headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(request?.url.hostname).toBe("example.org");
    expect(request?.address).toBe(PUBLIC_V4);
    expect(request?.family).toBe(4);
    expect(request?.connectTimeoutMs).toBe(10_000);
  });

  it("prefers an IPv4 address but accepts IPv6-only hosts", async () => {
    const dual = setup(
      [{ status: 200 }],
      {},
      {
        resolveHost: async () => {
          await Promise.resolve();
          return [
            { address: PUBLIC_V6, family: 6 },
            { address: PUBLIC_V4, family: 4 },
          ];
        },
      },
    );
    await dual.client.get("https://example.org/");
    expect(dual.requests[0]?.address).toBe(PUBLIC_V4);

    const v6only = setup(
      [{ status: 200 }],
      {},
      {
        resolveHost: async () => {
          await Promise.resolve();
          return [{ address: PUBLIC_V6, family: 6 }];
        },
      },
    );
    await v6only.client.get("https://example.org/");
    expect(v6only.requests[0]).toMatchObject({ address: PUBLIC_V6, family: 6 });
  });
});

describe("SafeHttpClient request policy (no traffic)", () => {
  it.each([
    ["host outside the allowlist", "https://evil.example/", "host_not_allowed"],
    ["http scheme", "http://example.org/", "invalid_url"],
    ["credentials", "https://u:p@example.org/", "invalid_url"],
    ["non-default port", "https://example.org:8443/", "invalid_url"],
    ["IP literal", "https://127.0.0.1/", "invalid_url"],
    ["IPv6 literal", "https://[::1]/", "invalid_url"],
  ] as const)("rejects %s before DNS", async (_label, url, code) => {
    const { client, resolved, requests } = setup([]);
    expect(await codeOf(client.get(url))).toBe(code);
    expect(resolved).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["private behind a public address", [PUBLIC_V4, "10.1.2.3"]],
    ["cloud metadata", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv4-mapped IPv6 loopback", ["::ffff:127.0.0.1"]],
    ["unique local IPv6", ["fd00::1"]],
  ])("rejects a host resolving to %s (blocked_address, no retry)", async (_label, addresses) => {
    const { client, requests } = setup(
      [],
      {},
      {
        resolveHost: async () => {
          await Promise.resolve();
          return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
        },
      },
    );
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("blocked_address");
    expect(failure.retryable).toBe(false);
    expect(requests).toEqual([]);
  });

  it("fails with dns_failed on NXDOMAIN without retrying", async () => {
    let calls = 0;
    const { client, sleeps } = setup(
      [],
      {},
      {
        resolveHost: async () => {
          calls++;
          await Promise.resolve();
          throw errorWithCode("ENOTFOUND");
        },
      },
    );
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("dns_failed");
    expect(failure.causeCode).toBe("ENOTFOUND");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a temporary DNS failure", async () => {
    let calls = 0;
    const { client } = setup(
      [{ status: 200 }],
      {},
      {
        resolveHost: async () => {
          calls++;
          await Promise.resolve();
          if (calls === 1) throw errorWithCode("EAI_AGAIN");
          return [{ address: PUBLIC_V4, family: 4 }];
        },
      },
    );
    expect((await client.get("https://example.org/")).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("fails with dns_failed when DNS returns no address", async () => {
    const { client } = setup(
      [],
      {},
      {
        resolveHost: async () => {
          await Promise.resolve();
          return [];
        },
      },
    );
    expect(await codeOf(client.get("https://example.org/"))).toBe("dns_failed");
  });
});

describe("SafeHttpClient redirects", () => {
  it("follows a relative redirect, resolved against the current URL, revalidated", async () => {
    const { client, requests, resolved } = setup([
      { status: 301, headers: { location: "../other/page?id=2" } },
      { status: 302, headers: { location: "https://files.example.org/doc" } },
      { status: 200, body: Buffer.from("done") },
    ]);
    const response = await client.get("https://example.org/list/start");
    expect(requests.map((request) => request.url.href)).toEqual([
      "https://example.org/list/start",
      "https://example.org/other/page?id=2",
      "https://files.example.org/doc",
    ]);
    expect(resolved).toEqual(["example.org", "example.org", "files.example.org"]);
    expect(response.url).toBe("https://files.example.org/doc");
    expect(response.body.toString()).toBe("done");
  });

  it.each([303, 307, 308])("follows %i", async (status) => {
    const { client } = setup([
      { status, headers: { location: "/next" } },
      { status: 200, body: Buffer.from("ok") },
    ]);
    expect((await client.get("https://example.org/")).url).toBe("https://example.org/next");
  });

  it("rejects a redirect to a host outside the allowlist", async () => {
    const { client, requests } = setup([
      { status: 302, headers: { location: "https://evil.example/steal" } },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("host_not_allowed");
    expect(requests).toHaveLength(1);
  });

  it("rejects a redirect downgrading to http", async () => {
    const { client } = setup([{ status: 301, headers: { location: "http://example.org/" } }]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("invalid_url");
  });

  it("rejects a redirect to an IP literal", async () => {
    const { client } = setup([{ status: 301, headers: { location: "https://169.254.169.254/" } }]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("invalid_url");
  });

  it("rejects a redirect to an allowlisted host that resolves to a private address", async () => {
    const { client, requests } = setup(
      [{ status: 302, headers: { location: "https://files.example.org/" } }],
      {},
      {
        resolveHost: async (hostname) => {
          await Promise.resolve();
          return [
            { address: hostname === "files.example.org" ? "192.168.0.10" : PUBLIC_V4, family: 4 },
          ];
        },
      },
    );
    expect(await codeOf(client.get("https://example.org/"))).toBe("blocked_address");
    expect(requests).toHaveLength(1);
  });

  it("follows at most 3 redirects", async () => {
    const redirect = { status: 302, headers: { location: "/again" } };
    const { client, requests } = setup([redirect, redirect, redirect, redirect]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("too_many_redirects");
    expect(requests).toHaveLength(4);
  });

  it("treats a redirect without Location as a failed status", async () => {
    const failure = await failureOf(setup([{ status: 302 }]).client.get("https://example.org/"));
    expect(failure.code).toBe("http_status");
    expect(failure.status).toBe(302);
  });
});

describe("SafeHttpClient timeouts and cancellation", () => {
  it("times out a request that never answers and retries it at most twice", async () => {
    const { client, requests } = setup(
      [hangingStep, hangingStep, hangingStep],
      {},
      {
        limits: { requestTimeoutMs: 30 },
      },
    );
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("timeout");
    expect(requests).toHaveLength(3);
  });

  it("times out while the body is still streaming", async () => {
    let sent = false;
    const neverEnding = new Readable({
      read() {
        // Sends one chunk, then stalls forever.
        if (sent) return;
        sent = true;
        this.push(Buffer.from("partial"));
      },
    });
    const { client } = setup(
      [{ status: 200, body: neverEnding }, hangingStep, hangingStep],
      {},
      {
        limits: { requestTimeoutMs: 30 },
      },
    );
    expect(await codeOf(client.get("https://example.org/"))).toBe("timeout");
  });

  it("succeeds when a retry after a timeout answers", async () => {
    const { client } = setup(
      [hangingStep, { status: 200, body: Buffer.from("ok") }],
      {},
      {
        limits: { requestTimeoutMs: 30 },
      },
    );
    expect((await client.get("https://example.org/")).body.toString()).toBe("ok");
  });

  it("stops on the caller's signal without retrying", async () => {
    const controller = new AbortController();
    const { client, requests } = setup([
      (request) => {
        setTimeout(() => {
          controller.abort();
        }, 5);
        return hangingStep(request);
      },
    ]);
    const failure = await failureOf(
      client.get("https://example.org/", { signal: controller.signal }),
    );
    expect(failure.code).toBe("aborted");
    expect(requests).toHaveLength(1);
  });

  it("does not start a request when the caller's signal is already aborted", async () => {
    const { client, requests } = setup([{ status: 200 }]);
    const failure = await failureOf(
      client.get("https://example.org/", { signal: AbortSignal.abort() }),
    );
    expect(failure.code).toBe("aborted");
    expect(requests).toEqual([]);
  });

  it("aborts during a retry wait", async () => {
    const controller = new AbortController();
    const { client, requests } = setup(
      [{ status: 503 }, { status: 200 }],
      {},
      {
        sleep: async () => {
          controller.abort();
          await Promise.resolve();
          throw new Error("aborted");
        },
      },
    );
    expect(await codeOf(client.get("https://example.org/", { signal: controller.signal }))).toBe(
      "aborted",
    );
    expect(requests).toHaveLength(1);
  });
});

describe("SafeHttpClient size limit", () => {
  const chunked = (total: number) => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks: Buffer[] = [];
    for (let left = total; left > 0; left -= chunk.length) {
      chunks.push(left >= chunk.length ? chunk : chunk.subarray(0, left));
    }
    return chunks;
  };

  it("accepts a body of exactly the limit", async () => {
    const { client } = setup([{ status: 200, body: chunked(MAX) }]);
    expect((await client.get("https://example.org/")).body.length).toBe(MAX);
  });

  it("aborts a streamed body above the limit without Content-Length", async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const { client } = setup([{ status: 200, body: endless }]);
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("too_large");
    expect(failure.retryable).toBe(false);
    expect(produced).toBeLessThan(MAX + 1024 * 1024);
    expect(endless.destroyed).toBe(true);
  });

  it("does not trust a Content-Length that understates the body", async () => {
    const { client } = setup([
      { status: 200, headers: { "content-length": "10" }, body: chunked(MAX + 1) },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("too_large");
  });

  it("rejects early when Content-Length exceeds the limit, without reading the body", async () => {
    let reads = 0;
    const body = new Readable({
      read() {
        reads++;
        this.push(null);
      },
    });
    const { client } = setup([
      { status: 200, headers: { "content-length": String(MAX + 1) }, body },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("too_large");
    expect(reads).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it.each([
    ["gzip", gzipSync],
    ["x-gzip", gzipSync],
    ["deflate", deflateSync],
    ["deflate", deflateRawSync],
    ["br", brotliCompressSync],
  ] as const)("decompresses %s (%o)", async (encoding, compress) => {
    const text = "zamówienie ".repeat(1000);
    const { client } = setup([
      { status: 200, headers: { "content-encoding": encoding }, body: compress(Buffer.from(text)) },
    ]);
    expect((await client.get("https://example.org/")).body.toString("utf8")).toBe(text);
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["deflate", deflateRawSync],
    ["br", brotliCompressSync],
  ] as const)("applies the limit after decompression (%s bomb, %o)", async (encoding, compress) => {
    const bomb = compress(Buffer.alloc(MAX + 1));
    expect(bomb.length).toBeLessThan(MAX / 100);
    const { client } = setup([
      { status: 200, headers: { "content-encoding": encoding }, body: bomb },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("too_large");
  });

  it("rejects an unknown or stacked Content-Encoding", async () => {
    for (const encoding of ["compress", "zstd", "gzip, br"]) {
      const { client } = setup([
        { status: 200, headers: { "content-encoding": encoding }, body: Buffer.from("x") },
      ]);
      expect(await codeOf(client.get("https://example.org/"))).toBe("unsupported_encoding");
    }
  });

  it("reports a corrupt compressed body as decompression_failed", async () => {
    const { client } = setup([
      { status: 200, headers: { "content-encoding": "gzip" }, body: Buffer.from("not gzip") },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("decompression_failed");
  });
});

describe("SafeHttpClient retries", () => {
  it.each([429, 502, 503, 504])("retries %i and then succeeds", async (status) => {
    const { client, requests } = setup([{ status }, { status: 200, body: Buffer.from("ok") }]);
    expect((await client.get("https://example.org/")).status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  it("gives up after 2 retries (3 attempts) and reports the status", async () => {
    const { client, requests, sleeps } = setup([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("http_status");
    expect(failure.status).toBe(503);
    expect(requests).toHaveLength(3);
    // Exponential backoff (random() = 0 → base × 2^(n-1)); the per-host interval
    // tops each pause up to 2 s since the end of the previous request.
    expect(sleeps).toEqual([1000, 1000, 2000]);
  });

  it("adds jitter to the backoff", async () => {
    const { client, sleeps } = setup([{ status: 503 }, { status: 200 }], {}, { random: () => 0.5 });
    await client.get("https://example.org/");
    expect(sleeps[0]).toBe(1500);
  });

  it("waits as long as Retry-After asks (seconds)", async () => {
    const { client, sleeps } = setup([
      { status: 429, headers: { "retry-after": "7" } },
      { status: 200 },
    ]);
    await client.get("https://example.org/");
    expect(sleeps).toEqual([7000]);
  });

  it("waits as long as Retry-After asks (HTTP-date)", async () => {
    const steps: Step[] = [{ status: 200 }];
    const context = setup(steps);
    const retryAt = new Date(1_700_000_000_000 + 12_000).toUTCString();
    steps.unshift({ status: 503, headers: { "retry-after": retryAt } });
    await context.client.get("https://example.org/");
    expect(context.sleeps).toEqual([12_000]);
  });

  it("fails instead of waiting when Retry-After exceeds the cap", async () => {
    const seconds = String(MAX_RETRY_AFTER_MS / 1000 + 1);
    const { client, requests, sleeps } = setup([
      { status: 429, headers: { "retry-after": seconds } },
      { status: 200 },
    ]);
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.status).toBe(429);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([400, 401, 403, 404, 410, 500, 501, 304])("does not retry %i", async (status) => {
    const { client, requests } = setup([{ status }, { status: 200 }]);
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("http_status");
    expect(failure.status).toBe(status);
    expect(failure.retryable).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"])(
    "retries the network error %s",
    async (code) => {
      const { client, requests } = setup([errorWithCode(code), { status: 200 }]);
      expect((await client.get("https://example.org/")).status).toBe(200);
      expect(requests).toHaveLength(2);
    },
  );

  it("does not retry a non-transient network error (e.g. TLS certificate)", async () => {
    const { client, requests } = setup([errorWithCode("CERT_HAS_EXPIRED"), { status: 200 }]);
    const failure = await failureOf(client.get("https://example.org/"));
    expect(failure.code).toBe("network");
    expect(failure.causeCode).toBe("CERT_HAS_EXPIRED");
    expect(requests).toHaveLength(1);
  });

  it("does not retry policy errors", async () => {
    const { client, requests } = setup([
      { status: 302, headers: { location: "https://evil.example/" } },
      { status: 200 },
    ]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("host_not_allowed");
    expect(requests).toHaveLength(1);
  });
});

describe("SafeHttpClient Retry-After deadline per host", () => {
  const overCap = String(MAX_RETRY_AFTER_MS / 1000 + 60);

  it("fails later requests to the host without traffic while the deadline exceeds the cap", async () => {
    const { client, requests, sleeps, logs } = setup([
      { status: 429, headers: { "retry-after": overCap } },
      { status: 200 },
    ]);
    expect((await failureOf(client.get("https://example.org/a"))).status).toBe(429);
    const failure = await failureOf(client.get("https://example.org/b"));
    expect(failure.code).toBe("http_status");
    expect(failure.status).toBe(429);
    expect(failure.retryable).toBe(false);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(logs().at(-1)).toMatchObject({
      message: "http request rejected",
      host: "example.org",
      errorCode: "http_status",
      status: 429,
      retryAfterMs: MAX_RETRY_AFTER_MS + 60_000,
    });
  });

  it("waits for the deadline once the remaining time is within the cap", async () => {
    const { client, requests, sleeps, advance } = setup([
      { status: 503, headers: { "retry-after": overCap } },
      { status: 200 },
    ]);
    await failureOf(client.get("https://example.org/a"));
    advance(61_000);
    expect((await client.get("https://example.org/b")).status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([MAX_RETRY_AFTER_MS + 60_000 - 61_000]);
  });

  it("keeps a short Retry-After for later calls after the retries are exhausted", async () => {
    const tooBusy = { status: 503, headers: { "retry-after": "5" } };
    const { client, requests, sleeps } = setup([tooBusy, tooBusy, tooBusy, { status: 200 }]);
    expect((await failureOf(client.get("https://example.org/a"))).status).toBe(503);
    expect(sleeps).toEqual([5000, 5000]);
    expect((await client.get("https://example.org/b")).status).toBe(200);
    // Longer than the 2 s minimum interval: the host's deadline wins.
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(requests).toHaveLength(4);
  });

  it("applies the deadline only to the host that sent it", async () => {
    const { client, requests } = setup([
      { status: 429, headers: { "retry-after": overCap } },
      { status: 200 },
    ]);
    await failureOf(client.get("https://example.org/a"));
    expect((await client.get("https://files.example.org/b")).status).toBe(200);
    expect(requests.map((request) => request.url.hostname)).toEqual([
      "example.org",
      "files.example.org",
    ]);
  });

  it("counts a refused request against the error budget", async () => {
    const { client } = setup([{ status: 429, headers: { "retry-after": overCap } }], {
      errorBudget: 2,
    });
    expect(await codeOf(client.get("https://example.org/a"))).toBe("http_status");
    expect(await codeOf(client.get("https://example.org/b"))).toBe("http_status");
    expect(await codeOf(client.get("https://example.org/c"))).toBe("budget_exhausted");
  });

  it("can be cancelled while waiting for the deadline", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const { client, requests, advance } = setup(
      [{ status: 429, headers: { "retry-after": overCap } }, { status: 200 }],
      {},
      {
        sleep: async (ms, signal) => {
          waits.push(ms);
          controller.abort();
          await Promise.resolve();
          if (signal?.aborted === true) throw new Error("aborted");
        },
      },
    );
    await failureOf(client.get("https://example.org/a"));
    advance(61_000);
    expect(await codeOf(client.get("https://example.org/b", { signal: controller.signal }))).toBe(
      "aborted",
    );
    expect(waits).toEqual([MAX_RETRY_AFTER_MS + 60_000 - 61_000]);
    expect(requests).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");

  it("parses delay-seconds and HTTP-dates", () => {
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 120 ", now)).toBe(120_000);
    expect(parseRetryAfter("Thu, 29 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 29 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("returns null for absent or invalid values", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
    expect(parseRetryAfter("1.5", now)).toBeNull();
    expect(parseRetryAfter("x".repeat(100), now)).toBeNull();
  });
});

describe("SafeHttpClient error budget", () => {
  it("refuses every request after the budget of failed attempts is used", async () => {
    const { client, requests } = setup([{ status: 404 }, { status: 404 }, { status: 200 }], {
      errorBudget: 2,
    });
    expect(await codeOf(client.get("https://example.org/a"))).toBe("http_status");
    expect(await codeOf(client.get("https://example.org/b"))).toBe("http_status");
    expect(await codeOf(client.get("https://example.org/c"))).toBe("budget_exhausted");
    expect(requests).toHaveLength(2);
  });

  it("counts every failed attempt, so retries cannot storm", async () => {
    const { client, requests, sleeps } = setup(
      [{ status: 503 }, { status: 503 }, { status: 503 }],
      { errorBudget: 2 },
    );
    const failure = await failureOf(client.get("https://example.org/"));
    // The second failure exhausts the budget: no third attempt, no pointless wait.
    expect(failure.status).toBe(503);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1000, 1000]);
    expect(await codeOf(client.get("https://example.org/"))).toBe("budget_exhausted");
  });

  it("counts policy rejections too", async () => {
    const { client } = setup([], { errorBudget: 1 });
    expect(await codeOf(client.get("https://evil.example/"))).toBe("host_not_allowed");
    expect(await codeOf(client.get("https://example.org/"))).toBe("budget_exhausted");
  });
});

describe("SafeHttpClient rate limiting", () => {
  it("waits the minimum interval between requests to the same host", async () => {
    const { client, sleeps } = setup([{ status: 200 }, { status: 200 }, { status: 200 }]);
    await client.get("https://example.org/1");
    await client.get("https://example.org/2");
    await client.get("https://files.example.org/3");
    expect(sleeps).toEqual([2000]);
  });

  it("does not count the rate-limit wait as request duration", async () => {
    const { client, logs } = setup([{ status: 200 }, { status: 200 }]);
    await client.get("https://example.org/1");
    await client.get("https://example.org/2");
    expect(logs().map((entry) => entry.durationMs)).toEqual([0, 0]);
  });

  it("only waits for the remainder of the interval", async () => {
    const { client, sleeps, advance } = setup([{ status: 200 }, { status: 200 }]);
    await client.get("https://example.org/1");
    advance(1500);
    await client.get("https://example.org/2");
    expect(sleeps).toEqual([500]);
  });

  it("uses a configured interval", async () => {
    const { client, sleeps } = setup([{ status: 200 }, { status: 200 }], { minIntervalMs: 5000 });
    await client.get("https://example.org/1");
    await client.get("https://example.org/2");
    expect(sleeps).toEqual([5000]);
  });

  it("spaces redirect hops to the same host", async () => {
    const { client, sleeps } = setup([
      { status: 302, headers: { location: "/next" } },
      { status: 200 },
    ]);
    await client.get("https://example.org/");
    expect(sleeps).toEqual([2000]);
  });

  it("runs concurrent calls strictly one after another", async () => {
    const { client, maxActive, sleeps } = setup([
      { status: 200 },
      { status: 200 },
      { status: 200 },
    ]);
    await Promise.all([
      client.get("https://example.org/1"),
      client.get("https://example.org/2"),
      client.get("https://example.org/3"),
    ]);
    expect(maxActive()).toBe(1);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("keeps serving queued calls after one of them fails", async () => {
    const { client } = setup([{ status: 404 }, { status: 200 }]);
    const results = await Promise.allSettled([
      client.get("https://example.org/missing"),
      client.get("https://example.org/ok"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });
});

describe("SafeHttpClient logging", () => {
  it("logs source, host, status, duration, attempt and bytes — never the path or query", async () => {
    const { client, logs, rawLogs } = setup([
      { status: 503 },
      { status: 302, headers: { location: "/next?token=s3cr3t-redirect" } },
      { status: 200, body: Buffer.from("body-content-s3cr3t") },
    ]);
    await client.get("https://example.org/private/path?token=s3cr3t-query");
    const entries = logs();
    expect(entries.map((entry) => [entry.message, entry.status, entry.attempt])).toEqual([
      ["http request failed", 503, 1],
      ["http request", 302, 2],
      ["http request", 200, 1],
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ sourceId: "test-source", host: "example.org", method: "GET" });
      expect(typeof entry.durationMs).toBe("number");
    }
    expect(entries[0]).toMatchObject({ errorCode: "http_status", willRetry: true });
    expect(entries[2]).toMatchObject({ bytes: 19 });
    const text = rawLogs();
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("/private/path");
    expect(text).not.toContain("user-agent");
  });

  it("keeps URLs, queries and bodies out of error messages", async () => {
    const { client } = setup([{ status: 500, body: Buffer.from("server-body-s3cr3t") }]);
    const failure = await failureOf(client.get("https://example.org/p?token=s3cr3t"));
    expect(failure.message).toBe("unexpected HTTP status (500)");
    expect(failure.host).toBe("example.org");
  });
});
