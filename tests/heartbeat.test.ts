import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HEARTBEAT_TIMEOUT_MS, sendHeartbeat } from "../src/operations/heartbeat.js";

// Only local servers on 127.0.0.1: the URLs say https, the injected request
// speaks plain HTTP to the test server (or TLS with a throwaway CA below).
const TOKEN = "Kq3-not-a-real-heartbeat-token";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  userAgent: string | undefined;
}

let server: Server | null = null;

afterEach(async () => {
  const current = server;
  server = null;
  if (current !== null) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => {
      current.close(() => {
        resolve();
      });
    });
  }
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      userAgent: request.headers["user-agent"],
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

describe("sendHeartbeat", () => {
  it("sends one GET with the path and query, and is ok on 2xx", async () => {
    const { port, seen } = await listen((_request, response) => {
      response.writeHead(200).end("OK");
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/ping/${TOKEN}?rid=1`, {
        request: httpRequest,
      }),
    ).toEqual({ ok: true });
    expect(seen).toEqual([
      { method: "GET", url: `/ping/${TOKEN}?rid=1`, userAgent: "radar-zamowien-status" },
    ]);
  });

  it("accepts any 2xx", async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(204).end();
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/`, { request: httpRequest }),
    ).toEqual({ ok: true });
  });

  it("does not wait for a large or endless body", async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      // Never ends: only the response head matters.
      response.write("x".repeat(64 * 1024));
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/`, {
        request: httpRequest,
        timeoutMs: 2_000,
      }),
    ).toEqual({ ok: true });
  });

  it("fails on a non-2xx status, once, without a retry", async () => {
    const { port, seen } = await listen((_request, response) => {
      response.writeHead(503).end();
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/ping/${TOKEN}`, {
        request: httpRequest,
      }),
    ).toEqual({ ok: false, reason: "http_503" });
    expect(seen).toHaveLength(1);
  });

  it("does not follow a redirect", async () => {
    const { port, seen } = await listen((request, response) => {
      if (request.url === "/moved") {
        response.writeHead(200).end();
        return;
      }
      response.writeHead(302, { location: "/moved" }).end();
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/ping/${TOKEN}`, {
        request: httpRequest,
      }),
    ).toEqual({ ok: false, reason: "http_302" });
    expect(seen.map((request) => request.url)).toEqual([`/ping/${TOKEN}`]);
  });

  it("times out when the server does not answer", async () => {
    const { port } = await listen(() => {
      // Never answers.
    });
    const started = Date.now();
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/`, {
        request: httpRequest,
        timeoutMs: 200,
      }),
    ).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(10_000);
  });

  it("reports a refused connection by its errno code only", async () => {
    const { port } = await listen(() => undefined);
    const current = server;
    server = null;
    await new Promise<void>((resolve) => {
      current?.close(() => {
        resolve();
      });
    });
    expect(
      await sendHeartbeat(`https://127.0.0.1:${String(port)}/ping/${TOKEN}`, {
        request: httpRequest,
      }),
    ).toEqual({ ok: false, reason: "network_econnrefused" });
  });

  it("reports a request that cannot even be built as a network failure", async () => {
    expect(
      await sendHeartbeat("https://127.0.0.1/", {
        request: () => {
          throw new Error(`cannot build ${TOKEN}`);
        },
      }),
    ).toEqual({ ok: false, reason: "network" });
  });
});

// The default transport really is TLS: a throwaway self-signed certificate
// for 127.0.0.1, generated with the openssl CLI into a temp directory for
// this run; only the injected request adds it as the CA.
//
// Without the openssl CLI the test is skipped locally, with a notice; in CI
// (CI set, as for the database tests: 0/false/empty mean unset) it never is —
// a missing openssl then fails the run instead of silently losing coverage.
const IN_CI = !["", "0", "false"].includes((process.env.CI ?? "").trim().toLowerCase());
const HAS_OPENSSL = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const SKIP_TLS = !HAS_OPENSSL && !IN_CI;
if (SKIP_TLS) {
  process.stderr.write(
    "\nNOTICE: the openssl CLI is not available — the heartbeat TLS test is SKIPPED " +
      "(it always runs in CI).\n\n",
  );
}

describe.skipIf(SKIP_TLS)("sendHeartbeat over TLS (needs the openssl CLI)", () => {
  let tls: { key: string; cert: string };

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "radar-heartbeat-tls-"));
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      tls = {
        key: readFileSync(join(dir, "key.pem"), "utf8"),
        cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let tlsServer: ReturnType<typeof createTlsServer> | null = null;

  afterAll(async () => {
    const current = tlsServer;
    if (current !== null) {
      current.closeAllConnections();
      await new Promise<void>((resolve) => {
        current.close(() => {
          resolve();
        });
      });
    }
  });

  it("pings an https server it trusts, and refuses one it does not", async () => {
    const seen: string[] = [];
    tlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, (request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) => tlsServer?.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${String((tlsServer.address() as AddressInfo).port)}/ping/${TOKEN}`;

    expect(
      await sendHeartbeat(url, {
        request: (options, callback) => httpsRequest({ ...options, ca: tls.cert }, callback),
      }),
    ).toEqual({ ok: true });
    // Without the CA the certificate is not trusted: no ping counts.
    const untrusted = await sendHeartbeat(url);
    expect(untrusted.ok).toBe(false);
    expect(untrusted).toMatchObject({ reason: expect.stringMatching(/^network_/u) as unknown });
    expect(seen).toEqual([`/ping/${TOKEN}`]);
  });
});
