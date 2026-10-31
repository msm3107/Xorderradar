import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExitCode, runCli, type CliDatabase, type CliSourceDeps } from "../src/cli.js";
import { HttpClientError } from "../src/infrastructure/http/errors.js";
import type {
  GetOptions,
  HttpResponse,
  SafeHttpClientOptions,
} from "../src/infrastructure/http/safe-http-client.js";
import { sourceAdapters } from "../src/sources/registry.js";
import type { SourceHttpClient } from "../src/sources/types.js";

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const CONTACT = "ops@example.com";
const NOW = new Date("2026-10-30T09:15:00.000Z");
const LIST_URL = "https://ezamowienia.gov.pl/mo-board/api/v1/notice";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/bzp/${name}`, import.meta.url));
}

type Respond = (url: URL, options: GetOptions | undefined) => Promise<Buffer>;

const FIXTURE_BY_NOTICE_TYPE: Readonly<Record<string, string>> = {
  ContractNotice: "contract-notice-2026-10-29-page1.json",
  SmallContractNotice: "small-contract-notice-2026-10-29.json",
};

/**
 * Serves captured BZP responses: page 1 of contract notices, then the small
 * contracts, then no notice updates (an empty day).
 */
const servesFixtures: Respond = (url) =>
  Promise.resolve(
    fixture(
      FIXTURE_BY_NOTICE_TYPE[url.searchParams.get("NoticeType") ?? ""] ?? "empty-2026-11-20.json",
    ),
  );

class FakeHttpClient implements SourceHttpClient {
  readonly urls: string[] = [];

  constructor(private readonly respond: Respond) {}

  async get(url: string | URL, options?: GetOptions): Promise<HttpResponse> {
    const href = url.toString();
    this.urls.push(href);
    const body = await this.respond(new URL(href), options);
    return { url: href, status: 200, contentType: "application/json; charset=utf-8", body };
  }
}

interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly respond?: Respond;
  readonly now?: Date;
  readonly runTimeoutMs?: number;
}

/** Runs the CLI with a fake HTTP client and a database that must never be opened. */
async function run(args: string[], options: RunOptions = {}) {
  const opened: string[] = [];
  const clientOptions: SafeHttpClientOptions[] = [];
  const http = new FakeHttpClient(options.respond ?? servesFixtures);
  const sources: CliSourceDeps = {
    adapters: sourceAdapters,
    createHttpClient: (clientOpts) => {
      clientOptions.push(clientOpts);
      return http;
    },
    now: () => options.now ?? NOW,
    runTimeoutMs: options.runTimeoutMs ?? 60_000,
  };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  let stdout = "";
  let stderr = "";
  const env: Record<string, string | undefined> = {
    DATABASE_URL,
    CRAWLER_CONTACT: CONTACT,
    ...options.env,
  };
  const code = await runCli(
    args,
    {
      env,
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    {
      openDatabase: (url) => {
        opened.push(url);
        return database;
      },
      sources,
    },
  );
  return { code, stdout, stderr, opened, clientOptions, urls: http.urls };
}

const logLineSchema = z.looseObject({ level: z.string(), message: z.string() });

/** JSON log lines written to stderr. */
function logLines(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => logLineSchema.parse(JSON.parse(line)));
}

const reportSchema = z.looseObject({
  records: z.array(z.looseObject({ externalId: z.string().nullable() })),
});

function listUrl(type: string, date: string, pageSize: number): string {
  return `${LIST_URL}?NoticeType=${type}&PublicationDateFrom=${date}&PublicationDateTo=${date}&PageSize=${String(pageSize)}`;
}

describe("source:preview", () => {
  it("prints the normalized records as JSON without storing anything", async () => {
    const result = await run(["source:preview", "bzp", "--date", "2026-10-29", "--limit", "10"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.opened).toEqual([]);
    expect(result.clientOptions).toEqual([
      expect.objectContaining({
        sourceId: "bzp",
        allowedHosts: ["ezamowienia.gov.pl"],
        contact: CONTACT,
      }),
    ]);
    // The limit applies per notice type: each is asked for up to 10 records.
    expect(result.urls).toEqual([
      listUrl("ContractNotice", "2026-10-29", 10),
      listUrl("SmallContractNotice", "2026-10-29", 10),
      listUrl("NoticeUpdateNotice", "2026-10-29", 10),
    ]);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: "ok",
      sourceId: "bzp",
      publicationDate: "2026-10-29",
      limit: 10,
      documents: 3,
      extracted: 5,
      normalized: 5,
      noticeUpdates: 0,
      rejected: 0,
      rejectionReasons: {},
      incomplete: [],
      rejections: [],
    });
    expect(reportSchema.parse(report).records.map((record) => record.externalId)).toEqual([
      "2026/BZP 00507107/01",
      "2026/BZP 00507109/01",
      "2026/BZP 00507112/01",
      "2026/BZP 00507754/01",
      "2026/BZP 00507787/01",
    ]);
    expect(report).toHaveProperty("records.0", {
      sourceId: "bzp",
      sourceUrl:
        "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/08df3574-2846-e200-cfcf-e60001c05bd0",
      externalId: "2026/BZP 00507107/01",
      tenderId: "ocds-148610-28a28ecf-bf58-4c1b-b2ba-e2adefdc2140",
      issuerName: "Zespół Żłobków m.st W-wy",
      title:
        "Dostawa zabawek dla dzieci od pierwszego dnia życia, w formie miękkiej przytulanki do Zespołu Żłobków m.st Warszawy - II procedura",
      // Read from htmlBody (D-022); the exact text is pinned in bzp-adapter.test.ts.
      description: expect.stringMatching(
        /^1\. Przedmiotem zamówienia jest dostawa zabawek dla dzieci[^<]*rodzaju wyrobów\.$/u,
      ) as string,
      location: { city: "Warszawa", voivodeship: "mazowieckie" },
      publishedAt: "2026-10-29T04:21:51.790Z",
      deadline: "2026-11-06T08:00:00.000Z",
      estimatedValue: "181300",
      currency: "PLN",
      categories: ["37520000-9", "39294100-0"],
      contact: { email: "kontakt@example.invalid" },
      fetchedAt: NOW.toISOString(),
      status: "open",
    });
    expect(result.stdout).not.toContain("htmlBody");
    expect(result.stdout).not.toContain("<");
  });

  it("lists notice updates with their new deadline or skip reason, never their body", async () => {
    const respond: Respond = (url) =>
      Promise.resolve(
        fixture(
          url.searchParams.get("NoticeType") === "NoticeUpdateNotice"
            ? "notice-update-notice-2026-10-29.json"
            : "empty-2026-11-20.json",
        ),
      );
    const result = await run(["source:preview", "bzp", "--date", "2026-10-29"], { respond });
    expect(result.code).toBe(ExitCode.Ok);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      documents: 3,
      extracted: 5,
      normalized: 0,
      noticeUpdates: 5,
      rejected: 0,
      records: [],
    });
    expect(report).toHaveProperty("updates", [
      {
        externalId: "2026/BZP 00507126/01",
        tenderId: "ocds-148610-7679f479-52e9-4912-8b9c-3c435343fc20",
        publishedAt: expect.stringMatching(/^2026-10-29T/) as string,
        deadline: "2026-11-03T09:00:00.000Z",
        skipReason: null,
      },
      {
        externalId: "2026/BZP 00507129/01",
        tenderId: "ocds-148610-37dbc6dd-004a-400b-99ae-d297d097507a",
        publishedAt: expect.stringMatching(/^2026-10-29T/) as string,
        deadline: null,
        skipReason: "no_deadline_change",
      },
      {
        externalId: "2026/BZP 00507130/01",
        tenderId: "ocds-148610-a6197287-8e1e-47ca-a60b-0fa2549c3d3a",
        publishedAt: expect.stringMatching(/^2026-10-29T/) as string,
        deadline: "2026-11-04T09:00:00.000Z",
        skipReason: null,
      },
      {
        externalId: "2026/BZP 00507136/01",
        tenderId: "ocds-148610-404b6813-d918-4bc6-b851-5b7da77ceabb",
        publishedAt: expect.stringMatching(/^2026-10-29T/) as string,
        deadline: null,
        skipReason: "not_contract_notice_change",
      },
      {
        externalId: "2026/BZP 00507141/01",
        tenderId: "ocds-148610-d20bb599-c9fa-4634-afe2-3eec1ad2d843",
        publishedAt: expect.stringMatching(/^2026-10-29T/) as string,
        deadline: "2026-11-05T09:00:00.000Z",
        skipReason: null,
      },
    ]);
    expect(result.stdout).not.toContain("<");
    expect(result.stdout).not.toContain("htmlBody");
    expect(result.stderr).not.toContain("<");
    expect(
      logLines(result.stderr).find((line) => line.message === "source preview finished"),
    ).toMatchObject({ noticeUpdates: 5, normalized: 0 });
  });

  it("logs the run with sourceId, status, duration and counts, but no URLs or content", async () => {
    const result = await run(["source:preview", "bzp", "--date", "2026-10-29", "--limit", "10"]);
    const finished = logLines(result.stderr).find(
      (line) => line.message === "source preview finished",
    );
    expect(finished).toMatchObject({
      level: "info",
      sourceId: "bzp",
      status: "ok",
      documents: 3,
      extracted: 5,
      normalized: 5,
      rejected: 0,
      incomplete: [],
    });
    expect(finished?.durationMs).toEqual(expect.any(Number));
    expect(result.stderr).not.toContain("https://");
    expect(result.stderr).not.toContain("Zespół Żłobków");
  });

  it("defaults to yesterday (UTC) and 20 records", async () => {
    const result = await run(["source:preview", "bzp"], {
      now: new Date("2026-01-01T00:30:00.000Z"),
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.urls[0]).toBe(listUrl("ContractNotice", "2025-12-31", 20));
    expect(JSON.parse(result.stdout)).toMatchObject({ publicationDate: "2025-12-31", limit: 20 });
  });

  it("accepts options in any order and the maximum limit", async () => {
    const result = await run(["source:preview", "bzp", "--limit", "500", "--date", "2024-02-29"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.urls[0]).toBe(listUrl("ContractNotice", "2024-02-29", 25));
  });

  it("counts rejected records by reason and still exits 0", async () => {
    const respond: Respond = (url) => {
      if (url.searchParams.get("NoticeType") !== "ContractNotice") {
        return Promise.resolve(Buffer.from("[]"));
      }
      const records = z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(fixture("contract-notice-2026-10-29-page1.json").toString("utf8")));
      const [first, ...rest] = records;
      const broken: Record<string, unknown> = { ...first };
      Reflect.deleteProperty(broken, "organizationName");
      return Promise.resolve(Buffer.from(JSON.stringify([broken, ...rest])));
    };
    const result = await run(["source:preview", "bzp", "--date", "2026-10-29"], { respond });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      extracted: 3,
      normalized: 2,
      rejected: 1,
      rejectionReasons: { "invalid source fields: organizationName": 1 },
      rejections: [
        { externalId: "2026/BZP 00507107/01", reason: "invalid source fields: organizationName" },
      ],
    });
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "source record rejected",
        sourceId: "bzp",
        externalId: "2026/BZP 00507107/01",
      }),
    );
  });

  it.each([
    [["source:preview"], "needs a source id"],
    [["source:preview", "--date", "2026-10-29"], "needs a source id"],
    [["source:preview", "nope"], 'Unknown source: "nope"'],
    [["source:preview", "bzp", "extra"], 'Unexpected argument: "extra"'],
    [["source:preview", "bzp", "--since", "2026-10-29"], 'Unexpected argument: "--since"'],
    [["source:preview", "bzp", "--date"], "Option --date needs a value."],
    [["source:preview", "bzp", "--date", "2026-02-30"], "--date must be a calendar date"],
    [["source:preview", "bzp", "--date", "2026-10-29T00:00:00Z"], "--date must be a calendar date"],
    [["source:preview", "bzp", "--date", "29.10.2026"], "--date must be a calendar date"],
    [["source:preview", "bzp", "--date", "2026-10-29", "--date", "2026-10-28"], "given twice"],
    [["source:preview", "bzp", "--limit", "0"], "--limit must be an integer from 1 to 500."],
    [["source:preview", "bzp", "--limit", "501"], "--limit must be an integer from 1 to 500."],
    [["source:preview", "bzp", "--limit", "1.5"], "--limit must be an integer from 1 to 500."],
    [["source:preview", "bzp", "--limit", "-1"], "--limit must be an integer from 1 to 500."],
    [["source:preview", "bzp", "--limit", "010"], "--limit must be an integer from 1 to 500."],
    [["source:preview", "bzp", "--limit", "5", "--limit", "6"], "given twice"],
  ])("rejects %j with exit code 2", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
    expect(result.clientOptions).toEqual([]);
    expect(result.opened).toEqual([]);
  });

  it("requires CRAWLER_CONTACT and makes no request without it", async () => {
    const result = await run(["source:preview", "bzp"], { env: { CRAWLER_CONTACT: undefined } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("CRAWLER_CONTACT is required");
    expect(result.stdout).toBe("");
    expect(result.clientOptions).toEqual([]);
    expect(result.urls).toEqual([]);
    expect(result.opened).toEqual([]);
  });

  it("still validates DATABASE_URL like every command, without opening the database", async () => {
    const result = await run(["source:preview", "bzp"], { env: { DATABASE_URL: undefined } });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.urls).toEqual([]);
  });

  it("exits 1 with a short message when the source answers with an error", async () => {
    const respond: Respond = () =>
      Promise.reject(
        new HttpClientError("http_status", { status: 503, host: "ezamowienia.gov.pl" }),
      );
    const result = await run(["source:preview", "bzp", "--date", "2026-10-29"], { respond });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Source preview failed: ");
    expect(result.stderr).toContain("(503)");
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "source preview failed",
        sourceId: "bzp",
        status: "error",
        errorCode: "http_status",
        httpStatus: 503,
        timedOut: false,
      }),
    );
  });

  it("exits 1 when a fetched document is unusable", async () => {
    const respond: Respond = () => Promise.resolve(Buffer.from("<html>maintenance</html>"));
    const result = await run(["source:preview", "bzp"], { respond });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Source preview failed: bzp: unusable source document (body is not valid JSON)",
    );
    expect(result.stderr).not.toContain("maintenance");
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({ errorCode: "invalid_document", httpStatus: null }),
    );
  });

  it("aborts the run when the run timeout expires", async () => {
    // Like SafeHttpClient: an aborted signal rejects the pending request.
    const respond: Respond = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new HttpClientError("aborted", { host: "ezamowienia.gov.pl" }));
        });
      });
    const result = await run(["source:preview", "bzp"], { respond, runTimeoutMs: 20 });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("Source preview failed: run timeout exceeded");
    expect(logLines(result.stderr)).toContainEqual(
      expect.objectContaining({ errorCode: "aborted", timedOut: true }),
    );
  });

  it("lists the command in the usage text", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain("source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]");
    expect(result.stdout).toContain("Sources: bzp.");
  });
});
