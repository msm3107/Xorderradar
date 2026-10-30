import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpportunityCandidate } from "../src/domain/opportunity.js";
import { HttpClientError } from "../src/infrastructure/http/errors.js";
import type { GetOptions, HttpResponse } from "../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../src/infrastructure/logger.js";
import { BZP_MAX_PAGES_PER_TYPE, BZP_PAGE_SIZE, bzpAdapter } from "../src/sources/bzp/adapter.js";
import { bzpProvinces } from "../src/sources/bzp/provinces.js";
import { previewSource } from "../src/sources/preview.js";
import {
  SourceFormatError,
  type FetchContext,
  type NormalizeResult,
  type RawDocument,
  type SourceHttpClient,
} from "../src/sources/types.js";

const FETCHED_AT = new Date("2026-10-30T10:00:00.000Z");
const LIST_URL = "https://ezamowienia.gov.pl/mo-board/api/v1/notice";
const DETAIL_URL = "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/";

const PAGE1 = "contract-notice-2026-10-29-page1.json";
const PAGE2 = "contract-notice-2026-10-29-page2.json";
const SMALL = "small-contract-notice-2026-10-29.json";
const EMPTY = "empty-2026-11-20.json";

function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/bzp/${name}`, import.meta.url));
}

const recordListSchema = z.array(z.record(z.string(), z.unknown()));
type JsonRecord = Record<string, unknown>;

/** A parsed copy of a captured page; tests mutate copies, never the fixture. */
function fixtureRecords(name: string): JsonRecord[] {
  const parsed: unknown = JSON.parse(fixtureBytes(name).toString("utf8"));
  return recordListSchema.parse(parsed);
}

function rawDocument(body: string, fetchedAt = FETCHED_AT): RawDocument {
  return {
    sourceId: "bzp",
    url: `${LIST_URL}?NoticeType=ContractNotice`,
    fetchedAt,
    contentType: "application/json; charset=utf-8",
    body,
  };
}

function fixtureDocument(name: string): RawDocument {
  return rawDocument(fixtureBytes(name).toString("utf8"));
}

function normalizeAll(doc: RawDocument): NormalizeResult[] {
  return bzpAdapter.extract(doc).map((notice) => bzpAdapter.normalize(notice));
}

function candidatesOf(doc: RawDocument): OpportunityCandidate[] {
  return normalizeAll(doc).map((result) => {
    if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
    return result.candidate;
  });
}

/**
 * The first record of page 1 with the given fields replaced (`undefined`
 * removes a field), normalized on its own.
 */
function normalizeMutated(changes: JsonRecord, fetchedAt = FETCHED_AT): NormalizeResult {
  const [first] = fixtureRecords(PAGE1);
  const record: JsonRecord = { ...first };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(record, key);
    else record[key] = value;
  }
  const results = normalizeAll(rawDocument(JSON.stringify([record]), fetchedAt));
  expect(results).toHaveLength(1);
  const [result] = results;
  if (result === undefined) throw new Error("no result");
  return result;
}

function expectCandidate(result: NormalizeResult): OpportunityCandidate {
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  return result.candidate;
}

describe("bzpAdapter.extract + normalize on captured responses", () => {
  it("maps the first contract notice exactly", () => {
    const [first] = candidatesOf(fixtureDocument(PAGE1));
    expect(first).toEqual({
      sourceId: "bzp",
      sourceUrl: `${DETAIL_URL}08df3574-2846-e200-cfcf-e60001c05bd0`,
      externalId: "2026/BZP 00507107/01",
      issuerName: "Zespół Żłobków m.st W-wy",
      title:
        "Dostawa zabawek dla dzieci od pierwszego dnia życia, w formie miękkiej przytulanki do Zespołu Żłobków m.st Warszawy - II procedura",
      description: null,
      location: { city: "Warszawa", voivodeship: "mazowieckie" },
      publishedAt: new Date("2026-10-29T04:21:51.790Z"),
      deadline: new Date("2026-11-06T08:00:00.000Z"),
      estimatedValue: null,
      currency: null,
      categories: ["37520000-9", "39294100-0"],
      contact: null,
      fetchedAt: FETCHED_AT,
      status: "open",
    });
  });

  it("collapses whitespace in titles and maps every record of page 1", () => {
    const candidates = candidatesOf(fixtureDocument(PAGE1));
    expect(candidates.map((c) => c.externalId)).toEqual([
      "2026/BZP 00507107/01",
      "2026/BZP 00507109/01",
      "2026/BZP 00507112/01",
    ]);
    const second = candidates[1];
    expect(second?.title).toBe(
      "„Wykonanie remontu wiaty magazynowej na terenie Bazy II w Koszalinie przy ulicy Gnieźnieńskiej 6”.",
    );
    expect(second?.issuerName).toBe("Przedsiębiorstwo Gospodarki Komunalnej Spółka z o.o.");
    expect(second?.categories).toEqual(["45453000-7"]);
    expect(second?.deadline).toEqual(new Date("2026-11-13T07:30:00.000Z"));
    expect(second?.location).toEqual({ city: "Koszalin", voivodeship: "zachodniopomorskie" });
    expect(second?.sourceUrl).toBe(`${DETAIL_URL}08df3577-092a-ee7a-cfcf-e60001c05bd2`);
    const third = candidates[2];
    expect(third?.categories).toEqual(["42415110-2"]);
    expect(third?.deadline).toEqual(new Date("2026-11-06T11:30:00.000Z"));
    expect(third?.sourceUrl).toBe(`${DETAIL_URL}08df3579-8fb4-7d97-cfcf-e60001c05bd7`);
  });

  it("maps page 2 (keyset continuation) with all CPV codes in published order", () => {
    const candidates = candidatesOf(fixtureDocument(PAGE2));
    expect(candidates.map((c) => c.externalId)).toEqual([
      "2026/BZP 00507113/01",
      "2026/BZP 00507114/01",
      "2026/BZP 00507115/01",
    ]);
    const [serock, gliwice, jastrzebie] = candidates;
    expect(serock?.categories).toEqual([
      "15000000-8",
      "15112100-7",
      "03100000-2",
      "03212100-1",
      "03221000-6",
      "15300000-1",
    ]);
    expect(serock?.location).toEqual({ city: "Serock", voivodeship: "mazowieckie" });
    expect(serock?.publishedAt).toEqual(new Date("2026-10-29T05:03:45.715Z"));
    expect(serock?.deadline).toEqual(new Date("2026-11-06T08:00:00.000Z"));
    expect(gliwice?.issuerName).toBe("OŚRODEK POMOCY SPOŁECZNEJ W GLIWICACH");
    expect(gliwice?.location).toEqual({ city: "Gliwice", voivodeship: "śląskie" });
    expect(gliwice?.categories).toEqual(["85311000-2"]);
    expect(gliwice?.deadline).toEqual(new Date("2026-11-05T08:00:00.000Z"));
    expect(jastrzebie?.issuerName).toBe("Miasto Jastrzębie-Zdrój");
    expect(jastrzebie?.location).toEqual({ city: "Jastrzębie-Zdrój", voivodeship: "śląskie" });
    expect(jastrzebie?.categories).toHaveLength(6);
    expect(jastrzebie?.deadline).toEqual(new Date("2026-11-13T08:00:00.000Z"));
  });

  it("maps small contracts: empty cpvCode gives no categories, a missing deadline stays null", () => {
    const [first, second] = candidatesOf(fixtureDocument(SMALL));
    expect(first).toEqual({
      sourceId: "bzp",
      sourceUrl: `${DETAIL_URL}08df3592-115f-9078-cfcf-e60001c05eab`,
      externalId: "2026/BZP 00507754/01",
      issuerName: "Rudzki Zakład Aktywności Zawodowej",
      title: "dostawa środków piorących i dezynfekujących",
      description: null,
      location: { city: "Ruda Śląska", voivodeship: "śląskie" },
      publishedAt: new Date("2026-10-29T07:55:58.274Z"),
      deadline: new Date("2026-11-04T11:00:00.000Z"),
      estimatedValue: null,
      currency: null,
      categories: [],
      contact: null,
      fetchedAt: FETCHED_AT,
      status: "open",
    });
    expect(second?.externalId).toBe("2026/BZP 00507787/01");
    expect(second?.issuerName).toBe("METRO WARSZAWSKIE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ");
    expect(second?.title).toBe("Dostawa elektromechanicznego sprzętu warsztatowego");
    expect(second?.publishedAt).toEqual(new Date("2026-10-29T08:17:02.629Z"));
    expect(second?.deadline).toBeNull();
    expect(second?.status).toBe("unknown");
    expect(second?.categories).toEqual([]);
  });

  it("normalizes every captured record without a rejection", () => {
    const results = [PAGE1, PAGE2, SMALL].flatMap((name) => normalizeAll(fixtureDocument(name)));
    expect(results).toHaveLength(8);
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });

  it("extracts nothing from the captured empty day", () => {
    expect(bzpAdapter.extract(fixtureDocument(EMPTY))).toEqual([]);
  });

  it("does not retain htmlBody or any other unmapped field", () => {
    const notices = [PAGE1, PAGE2, SMALL].flatMap((name) =>
      bzpAdapter.extract(fixtureDocument(name)),
    );
    for (const notice of notices) {
      expect(notice.valid).toBe(true);
      if (notice.valid) {
        expect(Object.keys(notice.record).sort()).toEqual(
          [
            "cpvCode",
            "noticeNumber",
            "objectId",
            "orderObject",
            "organizationCity",
            "organizationName",
            "organizationProvince",
            "publicationDate",
            "submittingOffersDate",
          ].sort(),
        );
      }
    }
    const candidates = candidatesOf(fixtureDocument(PAGE1));
    expect(JSON.stringify(candidates)).not.toContain("<");
  });

  it("uses the document's fetchedAt for every notice and for the status", () => {
    const fetchedAt = new Date("2026-11-10T00:00:00.000Z");
    const candidates = candidatesOf(rawDocument(fixtureBytes(PAGE1).toString("utf8"), fetchedAt));
    expect(candidates.map((c) => c.fetchedAt)).toEqual([fetchedAt, fetchedAt, fetchedAt]);
    // Deadlines 2026-11-06 (closed by then) and 2026-11-13 (still open).
    expect(candidates.map((c) => c.status)).toEqual(["closed", "open", "closed"]);
  });
});

describe("bzpProvinces", () => {
  it("equals the captured official province glossary", () => {
    const glossary = z
      .array(z.strictObject({ key: z.string(), value: z.string() }))
      .parse(JSON.parse(fixtureBytes("province-glossary.json").toString("utf8")));
    const fromGlossary = glossary.map(({ key, value }) => [key, value]).sort();
    expect([...bzpProvinces.entries()].sort()).toEqual(fromGlossary);
    expect(bzpProvinces.size).toBe(16);
  });
});

describe("bzpAdapter.normalize on mutated records", () => {
  const FIRST_ID = "2026/BZP 00507107/01";

  it("rejects a record without organizationName, naming the field", () => {
    expect(normalizeMutated({ organizationName: undefined })).toEqual({
      ok: false,
      externalId: FIRST_ID,
      reason: "invalid source fields: organizationName",
    });
  });

  it("rejects a field of the wrong type", () => {
    expect(normalizeMutated({ organizationName: 42, cpvCode: 7 })).toEqual({
      ok: false,
      externalId: FIRST_ID,
      reason: "invalid source fields: organizationName, cpvCode",
    });
  });

  it("rejects an empty or whitespace-only title instead of storing it", () => {
    for (const orderObject of ["", "  \n\t "]) {
      expect(normalizeMutated({ orderObject })).toEqual({
        ok: false,
        externalId: FIRST_ID,
        reason: "invalid value: title",
      });
    }
  });

  it("rejects an overlong title instead of truncating it", () => {
    expect(normalizeMutated({ orderObject: "x".repeat(1001) })).toEqual({
      ok: false,
      externalId: FIRST_ID,
      reason: "invalid value: title",
    });
    expect(expectCandidate(normalizeMutated({ orderObject: "x".repeat(1000) })).title).toHaveLength(
      1000,
    );
  });

  it("rejects a source field above the extraction bound before any parsing", () => {
    expect(normalizeMutated({ orderObject: "x".repeat(20_001) })).toEqual({
      ok: false,
      externalId: FIRST_ID,
      reason: "invalid source fields: orderObject",
    });
  });

  it("rejects publication dates that are not strict UTC timestamps or not real dates", () => {
    for (const publicationDate of [
      "2026-02-30T10:00:00Z",
      "2026-10-29T24:00:00Z",
      "2026-10-29",
      "2026-10-29T04:21:51+01:00",
      "29.10.2026",
      "",
    ]) {
      expect(normalizeMutated({ publicationDate })).toEqual({
        ok: false,
        externalId: FIRST_ID,
        reason: "invalid value: publishedAt",
      });
    }
  });

  it("trims surrounding whitespace of both timestamps but stays strict inside", () => {
    const candidate = expectCandidate(
      normalizeMutated({
        publicationDate: " 2026-10-29T04:21:51.7907299Z\n",
        submittingOffersDate: "\t2026-11-06T08:00:00Z ",
      }),
    );
    expect(candidate.publishedAt).toEqual(new Date("2026-10-29T04:21:51.790Z"));
    expect(candidate.deadline).toEqual(new Date("2026-11-06T08:00:00.000Z"));
    expect(normalizeMutated({ publicationDate: "2026-10-29 T04:21:51Z" })).toMatchObject({
      reason: "invalid value: publishedAt",
    });
    expect(normalizeMutated({ submittingOffersDate: "2026-11-06T08:00: 00Z" })).toMatchObject({
      reason: "invalid value: deadline",
    });
  });

  it("accepts a timestamp without a fraction", () => {
    const candidate = expectCandidate(
      normalizeMutated({ publicationDate: "2026-10-29T04:21:51Z" }),
    );
    expect(candidate.publishedAt).toEqual(new Date("2026-10-29T04:21:51.000Z"));
  });

  it("rejects an unreadable deadline rather than dropping it", () => {
    expect(normalizeMutated({ submittingOffersDate: "next Friday" })).toEqual({
      ok: false,
      externalId: FIRST_ID,
      reason: "invalid value: deadline",
    });
  });

  it("keeps a missing or blank deadline null with status unknown", () => {
    for (const submittingOffersDate of [null, undefined, "", "  "]) {
      const candidate = expectCandidate(normalizeMutated({ submittingOffersDate }));
      expect(candidate.deadline).toBeNull();
      expect(candidate.status).toBe("unknown");
    }
  });

  it("marks a notice closed when the deadline is not after fetchedAt", () => {
    const atFetch = expectCandidate(
      normalizeMutated({ submittingOffersDate: "2026-10-30T10:00:00Z" }),
    );
    expect(atFetch.status).toBe("closed");
    const justAfter = expectCandidate(
      normalizeMutated({ submittingOffersDate: "2026-10-30T10:00:01Z" }),
    );
    expect(justAfter.status).toBe("open");
  });

  it("extracts CPV codes from descriptions with commas, without duplicates", () => {
    const candidate = expectCandidate(
      normalizeMutated({
        cpvCode:
          "45000000-7 (Roboty budowlane, instalacyjne),09310000-5 (Elektryczność),45000000-7 (Roboty budowlane)",
      }),
    );
    expect(candidate.categories).toEqual(["45000000-7", "09310000-5"]);
    for (const cpvCode of [null, undefined, "", "brak"]) {
      expect(expectCandidate(normalizeMutated({ cpvCode })).categories).toEqual([]);
    }
  });

  it("never guesses a voivodeship for an unknown province code", () => {
    expect(expectCandidate(normalizeMutated({ organizationProvince: "PL99" })).location).toEqual({
      city: "Warszawa",
    });
    expect(
      expectCandidate(normalizeMutated({ organizationProvince: "__proto__" })).location,
    ).toEqual({ city: "Warszawa" });
    expect(
      expectCandidate(normalizeMutated({ organizationCity: null, organizationProvince: "PL14" }))
        .location,
    ).toEqual({ voivodeship: "mazowieckie" });
    expect(
      expectCandidate(normalizeMutated({ organizationCity: " ", organizationProvince: null }))
        .location,
    ).toBeNull();
  });

  it("rejects an objectId that is not a lower-case GUID (it becomes part of a URL)", () => {
    for (const objectId of [
      "../../admin",
      "08DF3574-2846-E200-CFCF-E60001C05BD0",
      "08df3574-2846-e200-cfcf-e60001c05bd0?x=1",
      null,
    ]) {
      expect(normalizeMutated({ objectId })).toEqual({
        ok: false,
        externalId: FIRST_ID,
        reason: "invalid source fields: objectId",
      });
    }
  });

  it("ignores unknown extra fields", () => {
    const candidate = expectCandidate(normalizeMutated({ newField: { nested: true } }));
    expect(candidate).not.toHaveProperty("newField");
    expect(candidate.externalId).toBe(FIRST_ID);
  });

  it("rejects an unreadable notice number with a null externalId", () => {
    expect(normalizeMutated({ noticeNumber: undefined })).toEqual({
      ok: false,
      externalId: null,
      reason: "invalid source fields: noticeNumber",
    });
  });

  it("rejects a list item that is not an object, keeping the rest of the page", () => {
    const records: unknown[] = [...fixtureRecords(PAGE1), 42, null];
    const results = normalizeAll(rawDocument(JSON.stringify(records)));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.slice(3)).toEqual([
      { ok: false, externalId: null, reason: "invalid source fields: (root)" },
      { ok: false, externalId: null, reason: "invalid source fields: (root)" },
    ]);
  });
});

describe("bzpAdapter.extract on unusable documents", () => {
  function extractError(body: string): unknown {
    try {
      bzpAdapter.extract(rawDocument(body));
    } catch (error: unknown) {
      return error;
    }
    return "no error";
  }

  it("throws SourceFormatError for corrupted JSON", () => {
    const body = fixtureBytes(PAGE1).toString("utf8");
    const error = extractError(body.slice(0, body.length / 2));
    expect(error).toBeInstanceOf(SourceFormatError);
    expect(error).toMatchObject({ sourceId: "bzp", reason: "body is not valid JSON" });
  });

  it("throws SourceFormatError for an object instead of an array", () => {
    const [first] = fixtureRecords(PAGE1);
    expect(extractError(JSON.stringify(first))).toMatchObject({
      name: "SourceFormatError",
      reason: "body is not a JSON array",
    });
    expect(extractError("null")).toMatchObject({ reason: "body is not a JSON array" });
  });

  it("throws SourceFormatError for more records than a page can hold", () => {
    const [first] = fixtureRecords(PAGE1);
    expect(extractError(JSON.stringify(Array.from({ length: 501 }, () => first)))).toMatchObject({
      reason: "too many records in one document",
    });
  });

  it("does not put document content into the error message", () => {
    const error = extractError('{"secret-looking": "value"');
    expect(error).toBeInstanceOf(SourceFormatError);
    expect(String(error)).not.toContain("secret-looking");
  });
});

/** Scripted stand-in for SafeHttpClient; records every request. */
class FakeHttpClient implements SourceHttpClient {
  readonly urls: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(private readonly respond: (url: URL, call: number) => Buffer | Error) {}

  get(url: string | URL, options?: GetOptions): Promise<HttpResponse> {
    const href = url.toString();
    this.urls.push(href);
    this.signals.push(options?.signal);
    const outcome = this.respond(new URL(href), this.urls.length);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve({
      url: href,
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: outcome,
    });
  }
}

function objectIdFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** `count` copies of a real record, each with its own objectId (from `firstId` on). */
function pageBytes(count: number, firstId: number): Buffer {
  const [template] = fixtureRecords(PAGE1);
  const records = Array.from({ length: count }, (_, i) => ({
    ...template,
    objectId: objectIdFor(firstId + i),
  }));
  return Buffer.from(JSON.stringify(records));
}

function listUrl(type: string, pageSize: number, searchAfter?: string): string {
  const query = `NoticeType=${type}&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=${String(pageSize)}`;
  return `${LIST_URL}?${query}${searchAfter === undefined ? "" : `&SearchAfter=${searchAfter}`}`;
}

function fetchContext(
  http: SourceHttpClient,
  overrides: Partial<FetchContext> = {},
  logLines: string[] = [],
): FetchContext {
  return {
    http,
    signal: new AbortController().signal,
    publicationDate: "2026-10-29",
    maxRecords: 100,
    now: () => FETCHED_AT,
    logger: createLogger("debug", (line) => logLines.push(line)),
    ...overrides,
  };
}

const logEntrySchema = z.looseObject({ level: z.string(), message: z.string() });

async function fetchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "no error",
    (error: unknown) => error,
  );
}

describe("bzpAdapter.fetch", () => {
  it("pages with SearchAfter until a short page, then reads the next notice type", async () => {
    const http = new FakeHttpClient((url) => {
      if (url.searchParams.get("NoticeType") === "SmallContractNotice") {
        return fixtureBytes(SMALL);
      }
      return url.searchParams.has("SearchAfter") ? fixtureBytes(PAGE2) : pageBytes(25, 1);
    });
    const ctx = fetchContext(http);
    const result = await bzpAdapter.fetch(ctx);
    expect(http.urls).toEqual([
      listUrl("ContractNotice", BZP_PAGE_SIZE),
      listUrl("ContractNotice", BZP_PAGE_SIZE, objectIdFor(25)),
      listUrl("SmallContractNotice", BZP_PAGE_SIZE),
    ]);
    expect(http.signals.every((signal) => signal === ctx.signal)).toBe(true);
    expect(result.incomplete).toEqual([]);
    expect(result.documents).toHaveLength(3);
    expect(result.documents[1]).toEqual({
      sourceId: "bzp",
      url: listUrl("ContractNotice", BZP_PAGE_SIZE, objectIdFor(25)),
      fetchedAt: FETCHED_AT,
      contentType: "application/json; charset=utf-8",
      body: fixtureBytes(PAGE2).toString("utf8"),
    });
    const preview = await previewSource(bzpAdapter, fetchContext(http));
    expect(preview.candidates).toHaveLength(25 + 3 + 2);
  });

  it("stops on an empty page", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(EMPTY));
    const result = await bzpAdapter.fetch(fetchContext(http));
    expect(http.urls).toEqual([
      listUrl("ContractNotice", BZP_PAGE_SIZE),
      listUrl("SmallContractNotice", BZP_PAGE_SIZE),
    ]);
    expect(result).toEqual({
      documents: [expect.objectContaining({ body: "[]" }), expect.objectContaining({ body: "[]" })],
      incomplete: [],
    });
  });

  it("stops after the maximum number of pages per notice type and reports it", async () => {
    const logLines: string[] = [];
    const http = new FakeHttpClient((url, call) =>
      url.searchParams.get("NoticeType") === "ContractNotice"
        ? pageBytes(25, call * 100)
        : fixtureBytes(EMPTY),
    );
    const result = await bzpAdapter.fetch(fetchContext(http, { maxRecords: 5000 }, logLines));
    expect(http.urls).toHaveLength(BZP_MAX_PAGES_PER_TYPE + 1);
    expect(http.urls.at(-1)).toBe(listUrl("SmallContractNotice", BZP_PAGE_SIZE));
    expect(result.incomplete).toEqual([{ part: "ContractNotice", reason: "max_pages" }]);
    const entries = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    expect(entries.find((entry) => entry.level === "warn")).toMatchObject({
      message: "source listing incomplete",
      sourceId: "bzp",
      part: "ContractNotice",
      pages: BZP_MAX_PAGES_PER_TYPE,
      records: BZP_MAX_PAGES_PER_TYPE * 25,
      reason: "max_pages",
    });
  });

  it("applies the record limit per notice type and never requests past it", async () => {
    const http = new FakeHttpClient((url) =>
      url.searchParams.has("SearchAfter") ? pageBytes(5, 100) : pageBytes(25, 1),
    );
    const result = await bzpAdapter.fetch(fetchContext(http, { maxRecords: 30 }));
    expect(http.urls).toEqual([
      listUrl("ContractNotice", 25),
      listUrl("ContractNotice", 5, objectIdFor(25)),
      listUrl("SmallContractNotice", 25),
      listUrl("SmallContractNotice", 5, objectIdFor(25)),
    ]);
    expect(result.documents.map((doc) => bzpAdapter.extract(doc).length)).toEqual([25, 5, 25, 5]);
    expect(result.incomplete).toEqual([
      { part: "ContractNotice", reason: "max_records" },
      { part: "SmallContractNotice", reason: "max_records" },
    ]);
  });

  it("fetches small contracts even when contract notices use up their limit", async () => {
    const http = new FakeHttpClient((url) =>
      url.searchParams.get("NoticeType") === "ContractNotice"
        ? pageBytes(5, 1)
        : fixtureBytes(SMALL),
    );
    const ctx = fetchContext(http, { maxRecords: 5 });
    const result = await bzpAdapter.fetch(ctx);
    expect(http.urls).toEqual([listUrl("ContractNotice", 5), listUrl("SmallContractNotice", 5)]);
    expect(result.incomplete).toEqual([{ part: "ContractNotice", reason: "max_records" }]);
    const preview = await previewSource(bzpAdapter, fetchContext(http, { maxRecords: 5 }));
    expect(preview.candidates).toHaveLength(5 + 2);
    expect(preview.candidates.slice(5).map((c) => c.externalId)).toEqual([
      "2026/BZP 00507754/01",
      "2026/BZP 00507787/01",
    ]);
  });

  it("stops when the last record has no usable cursor", async () => {
    const [template] = fixtureRecords(PAGE1);
    const records: unknown[] = recordListSchema.parse(
      JSON.parse(pageBytes(24, 1).toString("utf8")),
    );
    records.push({ ...template, objectId: "not-a-guid" });
    const http = new FakeHttpClient((url) =>
      url.searchParams.get("NoticeType") === "ContractNotice"
        ? Buffer.from(JSON.stringify(records))
        : fixtureBytes(EMPTY),
    );
    const result = await bzpAdapter.fetch(fetchContext(http));
    expect(http.urls).toHaveLength(2);
    expect(result.incomplete).toEqual([{ part: "ContractNotice", reason: "invalid_cursor" }]);
    expect(result.documents.map((doc) => bzpAdapter.extract(doc).length)).toEqual([25, 0]);
    // The page is kept: its valid records are still normalized, the bad one rejected.
    const preview = await previewSource(bzpAdapter, fetchContext(http));
    expect(preview.candidates).toHaveLength(24);
    expect(preview.rejections).toEqual([
      { externalId: "2026/BZP 00507107/01", reason: "invalid source fields: objectId" },
    ]);
  });

  it("stops when the source repeats a cursor instead of advancing", async () => {
    const http = new FakeHttpClient((url) =>
      url.searchParams.get("NoticeType") === "ContractNotice"
        ? pageBytes(25, 1)
        : fixtureBytes(EMPTY),
    );
    const result = await bzpAdapter.fetch(fetchContext(http));
    expect(http.urls).toEqual([
      listUrl("ContractNotice", 25),
      listUrl("ContractNotice", 25, objectIdFor(25)),
      listUrl("SmallContractNotice", 25),
    ]);
    expect(result.incomplete).toEqual([{ part: "ContractNotice", reason: "repeated_cursor" }]);
    // The repeated page duplicates page 1 and is dropped: every record appears once.
    expect(result.documents.map((doc) => bzpAdapter.extract(doc).length)).toEqual([25, 0]);
    const preview = await previewSource(bzpAdapter, fetchContext(http));
    expect(preview.candidates).toHaveLength(25);
  });

  it("drops a repeated page without counting it towards the record budget", async () => {
    const logLines: string[] = [];
    // Page 1 ends at id 25; page 2 fills the remaining 3 of the 28-record limit
    // but ends on that used cursor again. Counted, it would read as max_records.
    const http = new FakeHttpClient((url) => {
      if (url.searchParams.get("NoticeType") !== "ContractNotice") return fixtureBytes(EMPTY);
      return url.searchParams.has("SearchAfter") ? pageBytes(3, 23) : pageBytes(25, 1);
    });
    const result = await bzpAdapter.fetch(fetchContext(http, { maxRecords: 28 }, logLines));
    expect(http.urls).toEqual([
      listUrl("ContractNotice", 25),
      listUrl("ContractNotice", 3, objectIdFor(25)),
      listUrl("SmallContractNotice", 25),
    ]);
    expect(result.documents.map((doc) => bzpAdapter.extract(doc).length)).toEqual([25, 0]);
    expect(result.incomplete).toEqual([{ part: "ContractNotice", reason: "repeated_cursor" }]);
    const entries = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    expect(entries.find((entry) => entry.level === "warn")).toMatchObject({
      part: "ContractNotice",
      pages: 2,
      records: 25,
      reason: "repeated_cursor",
    });
  });

  it("makes no request when the run is already aborted", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(EMPTY));
    const controller = new AbortController();
    controller.abort();
    const error = await fetchError(
      bzpAdapter.fetch(fetchContext(http, { signal: controller.signal })),
    );
    expect(error).toBeInstanceOf(HttpClientError);
    expect(error).toMatchObject({ code: "aborted" });
    expect(http.urls).toEqual([]);
  });

  it("stops paging when the run is aborted between pages", async () => {
    const controller = new AbortController();
    const http = new FakeHttpClient(() => {
      controller.abort();
      return pageBytes(25, 1);
    });
    const error = await fetchError(
      bzpAdapter.fetch(fetchContext(http, { signal: controller.signal })),
    );
    expect(error).toMatchObject({ name: "HttpClientError", code: "aborted" });
    expect(http.urls).toHaveLength(1);
  });

  it("propagates HTTP client errors unchanged", async () => {
    const failure = new HttpClientError("http_status", { status: 503, host: "ezamowienia.gov.pl" });
    const http = new FakeHttpClient((_url, call) => (call === 1 ? pageBytes(25, 1) : failure));
    expect(await fetchError(bzpAdapter.fetch(fetchContext(http)))).toBe(failure);
    expect(http.urls).toHaveLength(2);
  });

  it("rejects a body that is not UTF-8", async () => {
    const http = new FakeHttpClient(() => Buffer.from([0x5b, 0xff, 0xfe, 0x5d]));
    expect(await fetchError(bzpAdapter.fetch(fetchContext(http)))).toMatchObject({
      name: "SourceFormatError",
      reason: "body is not valid UTF-8",
    });
  });

  it("rejects a page with more records than requested", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(PAGE1));
    expect(await fetchError(bzpAdapter.fetch(fetchContext(http, { maxRecords: 2 })))).toMatchObject(
      { name: "SourceFormatError", reason: "page has more records than requested" },
    );
  });

  it("rejects an invalid publication date or record limit before any request", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(EMPTY));
    for (const overrides of [
      { publicationDate: "2026-10-29&PageSize=500" },
      { maxRecords: 0 },
      { maxRecords: 1.5 },
    ]) {
      expect(await fetchError(bzpAdapter.fetch(fetchContext(http, overrides)))).toBeInstanceOf(
        TypeError,
      );
    }
    expect(http.urls).toEqual([]);
  });
});

describe("bzpAdapter.fetch with onDocument (streaming, used by ingest)", () => {
  const serve = (url: URL) => {
    if (url.searchParams.get("NoticeType") === "SmallContractNotice") return fixtureBytes(SMALL);
    return url.searchParams.has("SearchAfter") ? fixtureBytes(PAGE2) : pageBytes(25, 1);
  };

  it("hands over each page before the next request and returns no documents", async () => {
    const events: string[] = [];
    const http = new FakeHttpClient((url) => {
      events.push(`get ${String(http.urls.length)}`);
      return serve(url);
    });
    const streamed: RawDocument[] = [];
    const result = await bzpAdapter.fetch(
      fetchContext(http, {
        onDocument: async (doc) => {
          await Promise.resolve();
          events.push(`doc ${String(streamed.length + 1)}`);
          streamed.push(doc);
        },
      }),
    );
    expect(events).toEqual(["get 1", "doc 1", "get 2", "doc 2", "get 3", "doc 3"]);
    expect(result).toEqual({ documents: [], incomplete: [] });

    // Same documents, in the same order, as the collecting (preview) mode.
    const collected = await bzpAdapter.fetch(fetchContext(new FakeHttpClient(serve)));
    expect(streamed).toEqual(collected.documents);
  });

  it("stops fetching when onDocument rejects and propagates the error unchanged", async () => {
    const http = new FakeHttpClient(serve);
    const failure = new Error("store failed");
    const error = await fetchError(
      bzpAdapter.fetch(fetchContext(http, { onDocument: () => Promise.reject(failure) })),
    );
    expect(error).toBe(failure);
    expect(http.urls).toHaveLength(1);
  });

  it("still reports limits as incomplete in streaming mode", async () => {
    const http = new FakeHttpClient((url, call) =>
      url.searchParams.get("NoticeType") === "ContractNotice"
        ? pageBytes(25, call * 100)
        : fixtureBytes(EMPTY),
    );
    let documents = 0;
    const result = await bzpAdapter.fetch(
      fetchContext(http, {
        maxRecords: 50,
        onDocument: () => {
          documents++;
          return Promise.resolve();
        },
      }),
    );
    expect(documents).toBe(3);
    expect(result).toEqual({
      documents: [],
      incomplete: [{ part: "ContractNotice", reason: "max_records" }],
    });
  });
});
