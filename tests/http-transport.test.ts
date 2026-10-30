import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import {
  createServer as createTlsServer,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpClientError } from "../src/infrastructure/http/errors.js";
import {
  httpsTransport,
  pinnedLookup,
  SafeHttpClient,
  type Transport,
  systemResolveHost,
  type TransportRequest,
} from "../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../src/infrastructure/logger.js";

// These tests use the real node:https transport and the system resolver, but
// only on the loopback interface — no outside network. `.invalid` hostnames
// (RFC 2606) can never resolve, so a connection that arrives anyway proves the
// pinned address was used instead of DNS.

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => sockets.push(socket));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

function request(port: number, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: new URL(`https://pinned-host.invalid:${String(port)}/path?q=1`),
    address: "127.0.0.1",
    family: 4,
    headers: { "user-agent": "test" },
    signal: new AbortController().signal,
    connectTimeoutMs: 2_000,
    ...overrides,
  };
}

describe("pinnedLookup", () => {
  it("answers every lookup with the validated address, whatever the hostname", () => {
    const lookup = pinnedLookup("93.184.215.14", 4);
    const single: unknown[] = [];
    lookup("attacker-rebinds.example", {}, (...args: unknown[]) => single.push(...args));
    expect(single).toEqual([null, "93.184.215.14", 4]);
    const all: unknown[] = [];
    lookup("attacker-rebinds.example", { all: true }, (...args: unknown[]) => all.push(...args));
    expect(all).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
  });
});

describe("httpsTransport (real node:https)", () => {
  it("connects to the pinned address and keeps the hostname for TLS SNI", async () => {
    const seen: { servername: string; remote: string | undefined }[] = [];
    const server = createTlsServer({
      SNICallback: (servername, callback) => {
        seen.push({ servername, remote: undefined });
        // No certificate: ends the handshake once the ClientHello is observed.
        callback(new Error("test server has no certificate"), undefined);
      },
    });
    server.on("connection", (socket: Socket) => {
      seen.push({ servername: "", remote: socket.remoteAddress });
    });
    const port = await listen(server);

    await expect(httpsTransport(request(port))).rejects.toThrow();

    expect(seen).toContainEqual({ servername: "", remote: "127.0.0.1" });
    expect(seen).toContainEqual({ servername: "pinned-host.invalid", remote: undefined });
  });

  it("enforces the connect timeout when the TLS handshake never completes", async () => {
    // Accepts TCP but never answers the ClientHello.
    const port = await listen(createTcpServer(() => undefined));
    const started = Date.now();
    const error: unknown = await httpsTransport(request(port, { connectTimeoutMs: 100 })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops when the request signal aborts", async () => {
    const port = await listen(createTcpServer(() => undefined));
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(
      httpsTransport(request(port, { signal: controller.signal, connectTimeoutMs: 5_000 })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("SafeHttpClient with the default resolver and transport", () => {
  it("resolves localhost through the system resolver", async () => {
    const records = await systemResolveHost("localhost");
    expect(records.length).toBeGreaterThan(0);
  });

  it("blocks a loopback target after real DNS resolution, even when allowlisted", async () => {
    const logLines: string[] = [];
    const client = new SafeHttpClient({
      sourceId: "loopback-test",
      allowedHosts: ["localhost"],
      contact: "ops@radar.example.com",
      logger: createLogger("debug", (line) => logLines.push(line)),
    });
    const error: unknown = await client.get("https://localhost/admin").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as HttpClientError).code).toBe("blocked_address");
    expect(logLines.join("")).toContain('"errorCode":"blocked_address"');
  });
});

// A server the client really trusts: a throwaway self-signed certificate for
// `pinned-host.invalid`, generated with the openssl CLI into a temp directory
// for this run and added to this test worker's default CA list. Nothing is
// committed; the key never leaves the temp directory.
describe("httpsTransport against a trusted local TLS server", () => {
  const originalCAs = getCACertificates("default");
  let tls: { key: string; cert: string };

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "radar-tls-test-"));
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
          "/CN=pinned-host.invalid",
          "-addext",
          "subjectAltName=DNS:pinned-host.invalid",
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
    setDefaultCACertificates([...originalCAs, tls.cert]);
  });

  afterAll(() => {
    setDefaultCACertificates(originalCAs);
  });

  async function readAll(body: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8");
  }

  it("clears the connect timer after the handshake, so a slow response still succeeds", async () => {
    const seen: { host: string | undefined; userAgent: string | undefined; path: string }[] = [];
    const port = await listen(
      createHttpsServer(tls, (req, res) => {
        seen.push({
          host: req.headers.host,
          userAgent: req.headers["user-agent"],
          path: req.url ?? "",
        });
        // Headers arrive well after the 150 ms connect timeout.
        setTimeout(() => res.end("slow but fine"), 600);
      }),
    );
    const response = await httpsTransport(request(port, { connectTimeoutMs: 150 }));
    expect(response.status).toBe(200);
    expect(await readAll(response.body)).toBe("slow but fine");
    expect(seen).toEqual([
      { host: `pinned-host.invalid:${String(port)}`, userAgent: "test", path: "/path?q=1" },
    ]);
  });

  it("reports a connection reset in the middle of the body as network/ECONNRESET", async () => {
    let requests = 0;
    const port = await listen(
      createHttpsServer(tls, (_req, res) => {
        requests++;
        res.writeHead(200, { "content-length": "100000" });
        res.write("partial body", () => {
          res.socket?.destroy();
        });
      }),
    );
    // Test-only rerouting: the URL keeps the default port and a public DNS
    // answer, as the policy demands; the transport then goes to the local server.
    const toLocalServer: Transport = (transportRequest) => {
      const url = new URL(transportRequest.url);
      url.port = String(port);
      return httpsTransport({ ...transportRequest, url, address: "127.0.0.1", family: 4 });
    };
    const client = new SafeHttpClient(
      {
        sourceId: "tls-test",
        allowedHosts: ["pinned-host.invalid"],
        contact: "ops@radar.example.com",
        logger: createLogger("error", () => undefined),
      },
      {
        transport: toLocalServer,
        resolveHost: () => Promise.resolve([{ address: "93.184.215.14", family: 4 }]),
        sleep: () => Promise.resolve(),
      },
    );
    const error: unknown = await client
      .get("https://pinned-host.invalid/document")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpClientError);
    expect(error).toMatchObject({ code: "network", causeCode: "ECONNRESET", retryable: true });
    // Transient: the first attempt and both retries reached the server.
    expect(requests).toBe(3);
  });
});
