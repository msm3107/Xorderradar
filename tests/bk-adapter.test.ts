import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpportunityCandidate } from "../src/domain/opportunity.js";
import { HttpClientError } from "../src/infrastructure/http/errors.js";
import type { GetOptions, HttpResponse } from "../src/infrastructure/http/safe-http-client.js";
import { createLogger } from "../src/infrastructure/logger.js";
import {
  BK_HOST,
  BK_MAX_DETAILS_PER_DAY,
  BK_MAX_PAGES_PER_ORDER,
  BK_MAX_SKIPPED_DETAILS_PER_DAY,
  bkAdapter,
} from "../src/sources/bk/adapter.js";
import { previewSource } from "../src/sources/preview.js";
import {
  SourceFormatError,
  type FetchContext,
  type NormalizeResult,
  type RawDocument,
  type SourceHttpClient,
} from "../src/sources/types.js";

/*
 * Baza Konkurencyjności (D-030) on pseudonymised captures of 2026-11-04
 * (tests/fixtures/bk/README.md). Edge cases are built by mutating parsed
 * copies of the captured details, never by hand-crafting whole announcements.
 */

const FETCHED_AT = new Date("2026-11-04T09:00:00.000Z");
const PAGE_URL = `https://${BK_HOST}/ogloszenia/`;
const DETAIL_API_URL = `https://${BK_HOST}/api/announcements/`;
const DAY = "2026-11-03";

const LIST = "list-2026-11-03.json";
const EMPTY = "list-empty-2026-06-30.json";
/** Second version, one order with a value, 13 distinct CPV codes, phone "-". */
const WSB = "detail-296036.json";
/** Place type "cała Polska", no value. */
const GNIEZNO = "detail-296132.json";
/** Two orders (parts), neither with a value; phone "". */
const FLIS = "detail-296622.json";
/** Places in two voivodeships, two contact persons. */
const ENERGY = "detail-296667.json";
/** Two places in one voivodeship and county, in two localities. */
const SADOWIE = "detail-296920.json";
const DETAILS = [WSB, GNIEZNO, FLIS, ENERGY, SADOWIE] as const;
/** The announcements of LIST, in its order. */
const LISTED: Readonly<Record<number, string>> = {
  296132: GNIEZNO,
  296920: SADOWIE,
  296667: ENERGY,
  296622: FLIS,
};

function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/bk/${name}`, import.meta.url));
}

function fixtureText(name: string): string {
  return fixtureBytes(name).toString("utf8");
}

type JsonRecord = Record<string, unknown>;
const jsonRecord = z.record(z.string(), z.unknown());
const jsonRecords = z.array(jsonRecord);

function only<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  const [value] = values;
  if (value === undefined) throw new Error("no value");
  return value;
}

function rawDocument(body: string, fetchedAt = FETCHED_AT): RawDocument {
  return {
    sourceId: "bk",
    url: `${DETAIL_API_URL}296036`,
    fetchedAt,
    contentType: "text/html; charset=UTF-8",
    body,
  };
}

function normalizeBody(body: string, fetchedAt = FETCHED_AT): NormalizeResult {
  return bkAdapter.normalize(only(bkAdapter.extract(rawDocument(body, fetchedAt))));
}

function expectCandidate(result: NormalizeResult): OpportunityCandidate {
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  if (result.kind !== "opportunity") throw new Error("unexpected notice update");
  return result.candidate;
}

function candidateOf(name: string): OpportunityCandidate {
  return expectCandidate(normalizeBody(fixtureText(name)));
}

/** A parsed copy of a captured detail: the envelope and the version inside it. */
function parsedDetail(name: string) {
  const root = jsonRecord.parse(JSON.parse(fixtureText(name)));
  const data = jsonRecord.parse(root.data);
  const version = jsonRecord.parse(data.advertisement);
  const body = () => JSON.stringify({ ...root, data: { ...data, advertisement: version } });
  return { root, data, version, body };
}

/** The version's orders, changed by `change` and written back. */
function changeOrders(version: JsonRecord, change: (orders: JsonRecord[]) => void): void {
  const orders = jsonRecords.parse(version.orders);
  change(orders);
  version.orders = orders;
}

/** Every order item of the version, changed by `change` and written back. */
function changeItems(version: JsonRecord, change: (item: JsonRecord) => void): void {
  changeOrders(version, (orders) => {
    for (const order of orders) {
      const items = jsonRecords.parse(order.order_items);
      items.forEach(change);
      order.order_items = items;
    }
  });
}

/** The nested announcement of the version, changed by `change` and written back. */
function changeAnnouncement(version: JsonRecord, change: (announcement: JsonRecord) => void) {
  const announcement = jsonRecord.parse(version.advertisement);
  change(announcement);
  version.advertisement = announcement;
}

/** A captured detail with its version changed, normalized on its own. */
function normalizeMutated(
  name: string,
  mutate: (version: JsonRecord) => void,
  fetchedAt = FETCHED_AT,
): NormalizeResult {
  const detail = parsedDetail(name);
  mutate(detail.version);
  return normalizeBody(detail.body(), fetchedAt);
}

function mutatedCandidate(name: string, mutate: (version: JsonRecord) => void) {
  return expectCandidate(normalizeMutated(name, mutate));
}

/** A second order: a copy of the first with its own value. */
function withSecondOrder(version: JsonRecord, first: unknown, second: unknown): void {
  changeOrders(version, (orders) => {
    const [order] = orders;
    if (order === undefined) throw new Error("no order");
    orders.splice(0, orders.length, { ...order, estimated_value: first });
    orders.push({ ...order, id: 1, estimated_value: second });
  });
}

describe("bkAdapter.extract + normalize on captured details", () => {
  it("maps an announcement with one valued order exactly", () => {
    const candidate = candidateOf(WSB);
    expect(candidate).toEqual({
      sourceId: "bk",
      sourceUrl: `${PAGE_URL}296036`,
      // The announcement id, not the version id (393920): stable across versions.
      externalId: "296036",
      tenderId: null,
      issuerName: "Uniwersytet WSB Merito w Poznaniu",
      title:
        "Dostawa wyposażenia Laboratorium Sieci Komputerowych wraz symulacją okablowania w Uniwersytecie WSB Merito Szczecin",
      description: expect.any(String) as string,
      // The place of performance, not the buyer's seat (Poznań).
      location: { voivodeship: "zachodniopomorskie", county: "Szczecin", city: "Szczecin" },
      // First publication 2026-10-26 (this second version is of 2026-11-04), Warsaw midnight.
      publishedAt: new Date("2026-10-25T23:00:00.000Z"),
      // "2026-11-06 23:59:59" Warsaw (CET).
      deadline: new Date("2026-11-06T22:59:59.000Z"),
      estimatedValue: "50000.00",
      currency: "PLN",
      categories: [
        "31224400-6",
        "31224800-0",
        "32420000-3",
        "32421000-0",
        "32424000-1",
        "32562000-0",
        "32562100-1",
        "38300000-8",
        "38500000-0",
        "38540000-2",
        "38900000-4",
        "44322000-3",
        "45314300-4",
      ],
      // Phone "-" carries no number; never the contact person's name.
      contact: { email: "kontakt@example.invalid" },
      fetchedAt: FETCHED_AT,
      status: "open",
    });
    expect(candidate.description).toMatch(/^UWAGA! w kolumnie "Parametr oferowany"/u);
    expect(candidate.description).toHaveLength(3748);
  });

  it("maps two orders without values: no value, no currency, one voivodeship", () => {
    const candidate = candidateOf(FLIS);
    expect(candidate).toMatchObject({
      externalId: "296622",
      issuerName: "FLIS SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
      // The published title has a line break between the parts.
      title:
        "CZĘŚĆ I- DOSTAWA MEBLI LABORATORYJNYCH CZĘŚĆ II- DOSTAWA ZMYWARKI LABORATORYJNEJ – 1 SZTUKA",
      location: { voivodeship: "mazowieckie", county: "żyrardowski", city: "Kuranów" },
      publishedAt: new Date("2026-10-29T23:00:00.000Z"),
      deadline: new Date("2026-11-10T22:59:59.000Z"),
      estimatedValue: null,
      currency: null,
      categories: ["39180000-7", "39713100-4"],
      // Phone "" → not published.
      contact: { email: "kontakt@example.invalid" },
      status: "open",
    });
    // Both orders' item descriptions, a blank line between them, lines kept.
    const description = candidate.description ?? "";
    expect(description.split("\n\n").length).toBeGreaterThanOrEqual(2);
    expect(description).toMatch(/^CZĘŚĆ I- DOSTAWA MEBLI LABORATORYJNYCH\nMinimalne parametry:\n/u);
    expect(description).not.toMatch(/^\s|\s$|\n\n\n| \n|\n /u);
  });

  it("keeps a place without a voivodeship ('cała Polska') as raw text only", () => {
    expect(candidateOf(GNIEZNO)).toMatchObject({
      externalId: "296132",
      issuerName: "Urząd Miejski w Gnieźnie",
      location: { raw: "cała Polska" },
      deadline: new Date("2026-11-05T14:00:00.000Z"),
      estimatedValue: null,
      currency: null,
      categories: ["72212000-4", "72263000-6"],
      contact: { email: "kontakt@example.invalid", phone: "000 000 000" },
    });
  });

  it("names no voivodeship for places in several, and takes the first contact person", () => {
    const candidate = candidateOf(ENERGY);
    expect(candidate.location).toEqual({ raw: "mazowieckie, śląskie" });
    expect(candidate.contact).toEqual({ email: "kontakt@example.invalid", phone: "000 000 000" });
    expect(candidate.deadline).toEqual(new Date("2026-11-12T09:00:00.000Z"));
    expect(candidate.categories).toEqual(["79212000-3"]);
  });

  it("keeps the county shared by all places, but no city when they differ", () => {
    expect(candidateOf(SADOWIE)).toMatchObject({
      externalId: "296920",
      issuerName: "Gmina Sadowie",
      location: { voivodeship: "świętokrzyskie", county: "opatowski" },
      publishedAt: new Date("2026-11-02T23:00:00.000Z"),
      deadline: new Date("2026-11-17T22:59:59.000Z"),
      categories: ["45111200-0", "45112710-5", "45211320-8", "45233260-9"],
    });
  });

  it("never keeps a contact person's name (AC4)", () => {
    for (const name of DETAILS) {
      const candidate = candidateOf(name);
      expect(candidate.contact === null || !("name" in candidate.contact)).toBe(true);
      expect(JSON.stringify(candidate)).not.toMatch(/Kowalski|Nowak|Zieliński/u);
    }
  });
});

describe("bkAdapter.normalize: estimated value and currency (D-030)", () => {
  const valueOf = (mutate: (version: JsonRecord) => void) => {
    const { estimatedValue, currency } = mutatedCandidate(WSB, mutate);
    return { estimatedValue, currency };
  };

  it("sums the orders when every one has a value", () => {
    expect(
      valueOf((v) => {
        withSecondOrder(v, "50000,00", "1234,56");
      }),
    ).toEqual({
      estimatedValue: "51234.56",
      currency: "PLN",
    });
  });

  it("gives no value when any order has none — never a partial sum or 0", () => {
    for (const second of [null, "", "0,00", "abc"]) {
      expect(
        valueOf((v) => {
          withSecondOrder(v, "50000,00", second);
        }),
      ).toEqual({
        estimatedValue: null,
        currency: null,
      });
    }
  });

  it("reads only the form's format: digits, a comma, two decimals, above zero", () => {
    const single = (value: unknown) =>
      valueOf((v) => {
        changeOrders(v, (orders) => {
          for (const order of orders) order.estimated_value = value;
        });
      });
    expect(single("0,01")).toEqual({ estimatedValue: "0.01", currency: "PLN" });
    expect(single(" 120000,50 ")).toEqual({ estimatedValue: "120000.50", currency: "PLN" });
    expect(single("007,00")).toEqual({ estimatedValue: "7.00", currency: "PLN" });
    for (const value of ["0,00", "50000", "50000.00", "50 000,00", "50000,0", "-5,00", "1,5e3"]) {
      expect(single(value)).toEqual({ estimatedValue: null, currency: null });
    }
    // Beyond the stored numeric range (15 integer digits) → null, not cut.
    expect(single("1000000000000000,00")).toEqual({ estimatedValue: null, currency: null });
    expect(single("999999999999999,99")).toEqual({
      estimatedValue: "999999999999999.99",
      currency: "PLN",
    });
  });

  it("gives no value for an announcement without orders", () => {
    expect(valueOf((v) => (v.orders = []))).toEqual({ estimatedValue: null, currency: null });
  });

  it("rejects a value in another shape (a format change, not a missing value)", () => {
    const result = normalizeMutated(WSB, (v) => {
      changeOrders(v, (orders) => {
        for (const order of orders) order.estimated_value = 50000;
      });
    });
    expect(result).toEqual({
      ok: false,
      externalId: "296036",
      reason: "invalid source fields: orders.0.estimated_value",
    });
  });
});

describe("bkAdapter.normalize on mutated details", () => {
  it("gives no categories without CPV codes, and drops malformed ones", () => {
    expect(
      mutatedCandidate(WSB, (v) => {
        changeItems(v, (item) => (item.cpv_items = []));
      }),
    ).toMatchObject({ categories: [] });
    expect(
      mutatedCandidate(WSB, (v) => {
        changeItems(v, (item) => (item.cpv_items = null));
      }),
    ).toMatchObject({ categories: [] });
    const mixed = mutatedCandidate(WSB, (v) => {
      changeItems(v, (item) => {
        item.cpv_items = [{ code: " 45314300-4 " }, { code: "4531430" }, { code: 7 }, {}];
      });
    });
    expect(mixed.categories).toEqual(["45314300-4"]);
  });

  it("keeps a missing deadline or publication date null; a malformed one rejects", () => {
    const noDeadline = mutatedCandidate(WSB, (v) => (v.submission_deadline = null));
    expect(noDeadline).toMatchObject({ deadline: null, status: "unknown" });
    const noPublication = mutatedCandidate(WSB, (v) => {
      changeAnnouncement(v, (a) => Reflect.deleteProperty(a, "publication_date"));
    });
    expect(noPublication.publishedAt).toBeNull();
    for (const deadline of ["2026-11-06", "2026-11-06T23:59:59Z", "2026-02-30 10:00:00"]) {
      expect(normalizeMutated(WSB, (v) => (v.submission_deadline = deadline))).toEqual({
        ok: false,
        externalId: "296036",
        reason: "invalid value: deadline",
      });
    }
    expect(
      normalizeMutated(WSB, (v) => {
        changeAnnouncement(v, (a) => (a.publication_date = "26.10.2026"));
      }),
    ).toEqual({ ok: false, externalId: "296036", reason: "invalid value: publishedAt" });
  });

  it("maps the announcement status, open/closed by the deadline when published", () => {
    const withStatus = (label: unknown, fetchedAt = FETCHED_AT) =>
      expectCandidate(
        normalizeMutated(
          WSB,
          (v) => {
            changeAnnouncement(v, (a) => (a.status = { id: 9, label, name: "x" }));
          },
          fetchedAt,
        ),
      ).status;
    expect(withStatus("PUBLISHED")).toBe("open");
    expect(withStatus("PUBLISHED", new Date("2026-11-07T00:00:00.000Z"))).toBe("closed");
    expect(withStatus("CANCELLED")).toBe("cancelled");
    expect(withStatus("CLOSED")).toBe("closed");
    expect(withStatus("RESOLVED")).toBe("closed");
    expect(withStatus("DRAFT")).toBe("unknown");
    expect(withStatus(null)).toBe("unknown");
    expect(withStatus(42)).toBe("unknown");
  });

  it("cuts a long title and description at a word boundary with '…'", () => {
    const long = mutatedCandidate(WSB, (v) => {
      v.title = "słowo ".repeat(400);
      changeItems(v, (item) => (item.description = "akapit tekstu\n".repeat(2000)));
    });
    expect(long.title.length).toBeLessThanOrEqual(1000);
    expect(long.title).toMatch(/^słowo słowo .*słowo…$/u);
    expect(long.description?.length).toBeLessThanOrEqual(10_000);
    expect(long.description).toMatch(/tekstu…$/u);
  });

  it("gives a null description when no item has one; rejects an empty title", () => {
    const noDescription = mutatedCandidate(WSB, (v) => {
      changeItems(v, (item) => (item.description = null));
    });
    expect(noDescription.description).toBeNull();
    const blank = mutatedCandidate(WSB, (v) => {
      changeItems(v, (item) => (item.description = " \n "));
    });
    expect(blank.description).toBeNull();
    expect(normalizeMutated(WSB, (v) => (v.title = "  "))).toEqual({
      ok: false,
      externalId: "296036",
      reason: "invalid value: title",
    });
  });

  it("maps places: none → null, abroad → the country, an unknown voivodeship → no voivodeship", () => {
    const withPlaces = (places: unknown) =>
      mutatedCandidate(WSB, (v) => {
        changeItems(v, (item) => (item.fulfillment_places = places));
      }).location;
    expect(withPlaces([])).toBeNull();
    expect(withPlaces(null)).toBeNull();
    expect(
      withPlaces([
        { country: "Niemcy", voivodeship: null, locality: "Berlin", type: { name: "adres" } },
      ]),
    ).toEqual({ raw: "Niemcy" });
    expect(
      withPlaces([
        { country: "Polska", voivodeship: "Mazowsze", locality: "Radom", type: { name: "adres" } },
      ]),
    ).toEqual({ raw: "Radom" });
    expect(
      withPlaces([
        { country: "Polska", voivodeship: "Mazowieckie", poviat: "radomski", locality: "Radom" },
        { country: "Polska", voivodeship: "mazowieckie", poviat: "radomski", locality: "Radom" },
      ]),
    ).toEqual({ voivodeship: "mazowieckie", county: "radomski", city: "Radom" });
    expect(
      withPlaces([
        { country: "Polska", voivodeship: "mazowieckie", type: { name: "adres" } },
        { country: "Polska", voivodeship: null, type: { name: "cała Polska" } },
      ]),
    ).toEqual({ raw: "mazowieckie, cała Polska" });
    expect(withPlaces([{ country: null, voivodeship: null, type: { name: "adres" } }])).toBeNull();
  });

  it("keeps only an e-mail and a phone of digits; a name-like value is dropped", () => {
    const withPersons = (persons: unknown) =>
      mutatedCandidate(WSB, (v) => (v.contact_persons = persons)).contact;
    expect(withPersons([])).toBeNull();
    expect(withPersons(null)).toBeNull();
    expect(
      withPersons([
        { forename: "Jan", surname: "Kowalski", email: "Jan Kowalski", phone_number: "Jan" },
      ]),
    ).toBeNull();
    expect(
      withPersons([
        { forename: "Jan", surname: "Kowalski", email: null, phone_number: "-" },
        {
          forename: "Anna",
          surname: "Nowak",
          email: " KONTAKT2@Example.Invalid ",
          phone_number: "+48 (00) 000-00-01",
        },
      ]),
    ).toEqual({ email: "kontakt2@example.invalid", phone: "+48 (00) 000-00-01" });
    expect(
      withPersons([{ email: "nie-email", phone_number: "000 000 000 Jan Kowalski" }]),
    ).toBeNull();
    expect(withPersons([{ email: 5, phone_number: "000 000 000" }])).toEqual({
      phone: "000 000 000",
    });
    expect(withPersons([{ email: null, phone_number: "0".repeat(51) }])).toBeNull();
  });

  it("rejects a version without the buyer, with the field names only", () => {
    expect(
      normalizeMutated(WSB, (v) => Reflect.deleteProperty(v, "advertiser_address_details")),
    ).toEqual({
      ok: false,
      externalId: "296036",
      reason: "invalid source fields: advertiser_address_details",
    });
    expect(normalizeMutated(WSB, (v) => (v.title = 7))).toEqual({
      ok: false,
      externalId: "296036",
      reason: "invalid source fields: title",
    });
  });
});

describe("bkAdapter.extract on unusable documents (AC2)", () => {
  const extractError = (body: string) => {
    try {
      bkAdapter.extract(rawDocument(body));
      return "no error";
    } catch (error) {
      return error;
    }
  };
  const formatError = (reason: string) => new SourceFormatError("bk", reason);

  it("refuses broken JSON", () => {
    expect(extractError(fixtureText(WSB).slice(0, 500))).toEqual(
      formatError("body is not valid JSON"),
    );
  });

  it("refuses the API's error envelope", () => {
    const notFound =
      '{"status":"Error","error_id":"0","data":{"ErrorCode":0},"message":"errors.not_found_generic"}';
    expect(extractError(notFound)).toEqual(formatError("response status is not OK"));
  });

  it("refuses a changed structure instead of returning nothing", () => {
    const changed = (mutate: (detail: ReturnType<typeof parsedDetail>) => string) =>
      extractError(mutate(parsedDetail(WSB)));
    const expected = formatError("detail does not have the expected structure");
    expect(changed((d) => JSON.stringify({ ...d.root, data: {} }))).toEqual(expected);
    expect(changed((d) => JSON.stringify({ ...d.root, data: { advertisements: [] } }))).toEqual(
      expected,
    );
    expect(
      changed((d) => {
        d.version.orders = { order: 1 };
        return d.body();
      }),
    ).toEqual(expected);
    expect(
      changed((d) => {
        Reflect.deleteProperty(d.version, "advertisement");
        return d.body();
      }),
    ).toEqual(expected);
    expect(
      changed((d) => {
        changeAnnouncement(d.version, (a) => (a.id = "296036"));
        return d.body();
      }),
    ).toEqual(expected);
    expect(extractError("[]")).toEqual(formatError("response status is not OK"));
  });

  it("names no content in the error", () => {
    const error = extractError(fixtureText(WSB).slice(0, 500));
    expect(error).toBeInstanceOf(SourceFormatError);
    expect(String(error)).toBe(
      "SourceFormatError: bk: unusable source document (body is not valid JSON)",
    );
  });
});

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
    // The API serves its JSON as text/html (D-030); the adapter never relies on it.
    return Promise.resolve({
      url: href,
      status: 200,
      contentType: "text/html; charset=UTF-8",
      body: outcome,
    });
  }
}

function listUrl(page: number, limit: number, sort = "publicationDate", day = DAY): string {
  return (
    `https://${BK_HOST}/api/announcements/search?page=${String(page)}&limit=${String(limit)}` +
    `&sort=${sort}&status%5B%5D=PUBLISHED` +
    `&publicationDateRange%5Bfrom%5D=${day}&publicationDateRange%5Bto%5D=${day}`
  );
}

const detailUrl = (id: number) => `${DETAIL_API_URL}${String(id)}`;

/** A listing page of the given ids, each a copy of a captured list item (with `item` merged in). */
function listPage(ids: readonly number[], total: number, item: JsonRecord = {}): Buffer {
  const root = jsonRecord.parse(JSON.parse(fixtureText(LIST)));
  const data = jsonRecord.parse(root.data);
  const template = jsonRecords.parse(data.advertisements)[0];
  const advertisements = ids.map((id) => ({ ...template, ...item, id }));
  return Buffer.from(
    JSON.stringify({ ...root, data: { ...data, advertisements, meta: { total } } }),
  );
}

/** A captured detail, served for a synthetic listing's ids (a valid record; fetch extracts it). */
const anyDetail = () => fixtureBytes(GNIEZNO);

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Serves the captured listing and the captured detail of each listed id. */
function capturedSource(url: URL): Buffer | Error {
  if (url.pathname === "/api/announcements/search") return fixtureBytes(LIST);
  const id = Number(url.pathname.split("/").at(-1));
  const name = LISTED[id];
  return name === undefined ? new Error(`unexpected ${url.pathname}`) : fixtureBytes(name);
}

function fetchContext(
  http: SourceHttpClient,
  overrides: Partial<FetchContext> = {},
  logLines: string[] = [],
): FetchContext {
  return {
    http,
    signal: new AbortController().signal,
    publicationDate: DAY,
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

describe("bkAdapter.fetch", () => {
  it("reads the day's listing, then each announcement's detail", async () => {
    const http = new FakeHttpClient(capturedSource);
    const logLines: string[] = [];
    const ctx = fetchContext(http, {}, logLines);
    const result = await bkAdapter.fetch(ctx);
    expect(http.urls).toEqual([
      listUrl(1, 250),
      detailUrl(296132),
      detailUrl(296920),
      detailUrl(296667),
      detailUrl(296622),
    ]);
    expect(http.signals.every((signal) => signal === ctx.signal)).toBe(true);
    expect(result.incomplete).toEqual([]);
    // Only details are documents; the listing is validated and dropped.
    expect(result.documents.map((doc) => doc.url)).toEqual(http.urls.slice(1));
    expect(result.documents[0]).toEqual({
      sourceId: "bk",
      url: detailUrl(296132),
      fetchedAt: FETCHED_AT,
      contentType: "text/html; charset=UTF-8",
      body: fixtureText(GNIEZNO),
    });
    const logs = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    expect(logs).toEqual([
      expect.objectContaining({
        level: "info",
        message: "source listing fetched",
        sourceId: "bk",
        part: "announcements",
        pages: 1,
        records: 4,
        total: 4,
      }),
    ]);

    const preview = await previewSource(
      bkAdapter,
      fetchContext(new FakeHttpClient(capturedSource)),
    );
    expect(preview.candidates.map((candidate) => candidate.externalId)).toEqual([
      "296132",
      "296920",
      "296667",
      "296622",
    ]);
    expect(preview.rejections).toEqual([]);
  });

  it("makes one request for an empty day", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(EMPTY));
    const result = await bkAdapter.fetch(fetchContext(http, { publicationDate: "2026-06-30" }));
    expect(http.urls).toEqual([listUrl(1, 250, "publicationDate", "2026-06-30")]);
    expect(result).toEqual({ documents: [], incomplete: [] });
  });

  it("pages through both orders only for a listing longer than one page (D-030)", async () => {
    // total 400 > 250: page 1 of the first order repeats 50 of its own ids and
    // page 2 only repeats (200 distinct after the page limit); the second order
    // brings the rest of the budget.
    const repeating = [...range(1, 200), ...range(1, 50)];
    const http = new FakeHttpClient((url) => {
      if (url.pathname !== "/api/announcements/search") return anyDetail();
      const sort = url.searchParams.get("sort");
      const page = url.searchParams.get("page");
      if (sort === "publicationDate") {
        return page === "1" ? listPage(repeating, 400) : listPage(range(1, 150), 400);
      }
      return page === "1" ? listPage(range(201, 450), 400) : new Error("not needed");
    });
    const result = await bkAdapter.fetch(fetchContext(http, { maxRecords: 1000 }));
    expect(BK_MAX_PAGES_PER_ORDER).toBe(2);
    expect(http.urls.slice(0, 3)).toEqual([
      listUrl(1, 250),
      listUrl(2, 250),
      listUrl(1, 250, "default"),
    ]);
    expect(http.urls.slice(3)).toEqual(range(1, BK_MAX_DETAILS_PER_DAY).map(detailUrl));
    expect(result.documents).toHaveLength(BK_MAX_DETAILS_PER_DAY);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "max_records" }]);
  });

  it("fails the day on one page with fewer distinct records than its total (2026-11-04)", async () => {
    // As measured: 130 positions, 111 distinct announcements.
    const http = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search"
        ? listPage([...range(1, 111), ...range(1, 19)], 130)
        : anyDetail(),
    );
    const logLines: string[] = [];
    expect(
      await fetchError(bkAdapter.fetch(fetchContext(http, { maxRecords: 1000 }, logLines))),
    ).toEqual(new SourceFormatError("bk", "listing has fewer distinct records than its total"));
    // One request, no second order (it cannot add to a whole-day page), no detail.
    expect(http.urls).toEqual([listUrl(1, 250)]);
    const logs = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "source listing short",
        sourceId: "bk",
        pages: 1,
        records: 111,
        total: 130,
      }),
    );
  });

  it("checks a one-page listing against its whole total, even under a smaller budget", async () => {
    // 5 positions, 4 distinct: the budget of 2 is reachable, the total is not.
    const shortList = (url: URL) =>
      url.pathname === "/api/announcements/search" ? listPage([1, 2, 3, 4, 1], 5) : anyDetail();
    const http = new FakeHttpClient(shortList);
    expect(await fetchError(bkAdapter.fetch(fetchContext(http, { maxRecords: 2 })))).toEqual(
      new SourceFormatError("bk", "listing has fewer distinct records than its total"),
    );
    expect(http.urls).toEqual([listUrl(1, 250)]);

    // Preview (`source:preview bk --limit 2`): the same check, the same one request.
    const previewHttp = new FakeHttpClient(shortList);
    expect(
      await fetchError(previewSource(bkAdapter, fetchContext(previewHttp, { maxRecords: 2 }))),
    ).toEqual(new SourceFormatError("bk", "listing has fewer distinct records than its total"));
    expect(previewHttp.urls).toEqual([listUrl(1, 250)]);
  });

  it("fails the day when both orders stay short of the budget at their page limit", async () => {
    // Every page repeats the same 200 ids: the listing never advances.
    const http = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search"
        ? listPage([...range(1, 200), ...range(1, 50)], 1000)
        : anyDetail(),
    );
    expect(await fetchError(bkAdapter.fetch(fetchContext(http, { maxRecords: 1000 })))).toEqual(
      new SourceFormatError("bk", "listing has fewer distinct records than its total"),
    );
    expect(http.urls).toEqual([
      listUrl(1, 250),
      listUrl(2, 250),
      listUrl(1, 250, "default"),
      listUrl(2, 250, "default"),
    ]);
  });

  it("stops at the record budget and reports max_records, the listing still one page", async () => {
    const http = new FakeHttpClient(capturedSource);
    const result = await bkAdapter.fetch(fetchContext(http, { maxRecords: 2 }));
    expect(http.urls).toEqual([listUrl(1, 250), detailUrl(296132), detailUrl(296920)]);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "max_records" }]);

    // Preview with a small limit: the same single listing request.
    const previewHttp = new FakeHttpClient(capturedSource);
    const preview = await previewSource(bkAdapter, fetchContext(previewHttp, { maxRecords: 2 }));
    expect(previewHttp.urls).toEqual([listUrl(1, 250), detailUrl(296132), detailUrl(296920)]);
    expect(preview.incomplete).toEqual([{ part: "announcements", reason: "max_records" }]);
  });

  it("reads at most BK_MAX_DETAILS_PER_DAY details, whatever the record limit", async () => {
    const http = new FakeHttpClient((url) => {
      if (url.pathname !== "/api/announcements/search") return anyDetail();
      const page = Number(url.searchParams.get("page"));
      return listPage(range((page - 1) * 250 + 1, page * 250), 400);
    });
    const result = await bkAdapter.fetch(fetchContext(http, { maxRecords: 1000 }));
    expect(http.urls.slice(0, 1)).toEqual([listUrl(1, 250)]);
    expect(http.urls.slice(1)).toEqual(range(1, BK_MAX_DETAILS_PER_DAY).map(detailUrl));
    expect(result.documents).toHaveLength(BK_MAX_DETAILS_PER_DAY);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "max_records" }]);
  });

  it("refuses an unusable listing page (AC2)", async () => {
    const cases: [Buffer, string][] = [
      [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), "body is not valid UTF-8"],
      [Buffer.from("<!doctype html><html></html>"), "body is not valid JSON"],
      [Buffer.from('{"status":"Error","data":{"ErrorCode":0}}'), "response status is not OK"],
      [
        Buffer.from('{"status":"OK","data":{"items":[]}}'),
        "listing does not have the expected structure",
      ],
      [
        Buffer.from('{"status":"OK","data":{"advertisements":[{"id":"1"}],"meta":{"total":1}}}'),
        "listing does not have the expected structure",
      ],
      [
        Buffer.from('{"status":"OK","data":{"advertisements":[],"meta":{"total":-1}}}'),
        "listing does not have the expected structure",
      ],
      [listPage(range(1, 251), 251), "page has more records than requested"],
    ];
    for (const [body, reason] of cases) {
      const http = new FakeHttpClient(() => body);
      expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toEqual(
        new SourceFormatError("bk", reason),
      );
      expect(http.urls).toHaveLength(1);
    }
  });

  it("refuses a page shorter than requested before the listing's end (AC2)", async () => {
    // A page of 100 where 250 were asked, total 180: the order would end early, silently.
    const http = new FakeHttpClient(() => listPage(range(1, 100), 180));
    expect(await fetchError(bkAdapter.fetch(fetchContext(http, { maxRecords: 1000 })))).toEqual(
      new SourceFormatError("bk", "page shorter than requested before the listing's end"),
    );
    expect(http.urls).toEqual([listUrl(1, 250)]);
  });

  it("refuses a listing of another publication day (an ignored date filter)", async () => {
    for (const [item, reason] of [
      [{ publication_date: "2026-11-02" }, "listing has a record of another publication day"],
      [
        { publication_date: "2026-11-03 00:00:00" },
        "listing has a record of another publication day",
      ],
      [{ publication_date: null }, "listing does not have the expected structure"],
    ] as const) {
      const http = new FakeHttpClient(() => listPage([296132], 1, item));
      expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toEqual(
        new SourceFormatError("bk", reason),
      );
      expect(http.urls).toHaveLength(1);
    }
  });

  it("skips a detail answered 404, reads the rest and reports detail_missing", async () => {
    const http = new FakeHttpClient((url) =>
      url.pathname.endsWith("/296920")
        ? new HttpClientError("http_status", { status: 404, host: BK_HOST })
        : capturedSource(url),
    );
    const logLines: string[] = [];
    const result = await bkAdapter.fetch(fetchContext(http, {}, logLines));
    expect(http.urls).toHaveLength(5);
    expect(result.documents.map((doc) => doc.url)).toEqual([
      detailUrl(296132),
      detailUrl(296667),
      detailUrl(296622),
    ]);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "detail_missing" }]);
    const logs = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    expect(logs).toContainEqual({
      time: expect.any(String) as unknown,
      level: "warn",
      message: "source detail skipped",
      sourceId: "bk",
      announcementId: 296920,
      reason: "detail_missing",
      skipped: 1,
    });
  });

  it("skips a detail that is not the detail envelope and reports detail_invalid", async () => {
    const http = new FakeHttpClient((url) => {
      if (url.pathname.endsWith("/296667")) {
        return Buffer.from(fixtureText(ENERGY).replace('"orders":[', '"orders_v2":['));
      }
      if (url.pathname.endsWith("/296622")) {
        return new HttpClientError("http_status", { status: 404, host: BK_HOST });
      }
      return capturedSource(url);
    });
    const result = await bkAdapter.fetch(fetchContext(http));
    expect(result.documents.map((doc) => doc.url)).toEqual([detailUrl(296132), detailUrl(296920)]);
    expect(result.incomplete).toEqual([
      { part: "announcements", reason: "detail_invalid" },
      { part: "announcements", reason: "detail_missing" },
    ]);
  });

  it("fails the day on one unusable detail more than the skip limit (a format change, AC2)", async () => {
    const changed = (url: URL) => {
      const body = capturedSource(url);
      return body instanceof Error || url.pathname === "/api/announcements/search"
        ? body
        : Buffer.from(body.toString("utf8").replace('"orders":[', '"orders_v2":['));
    };
    const http = new FakeHttpClient(changed);
    expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toEqual(
      new SourceFormatError("bk", "detail does not have the expected structure"),
    );
    // The listing, then the details up to the first one past the limit.
    expect(http.urls).toHaveLength(1 + BK_MAX_SKIPPED_DETAILS_PER_DAY + 1);

    const missing = new HttpClientError("http_status", { status: 404, host: BK_HOST });
    const gone = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search" ? capturedSource(url) : missing,
    );
    expect(await fetchError(bkAdapter.fetch(fetchContext(gone)))).toBe(missing);
    expect(gone.urls).toHaveLength(1 + BK_MAX_SKIPPED_DETAILS_PER_DAY + 1);
  });

  it("fails a day whose every detail was unusable, even within the skip limit", async () => {
    const missing = new HttpClientError("http_status", { status: 404, host: BK_HOST });
    const gone = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search" ? listPage([296132], 1) : missing,
    );
    expect(await fetchError(bkAdapter.fetch(fetchContext(gone)))).toBe(missing);

    const changed = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search"
        ? listPage([296132, 296920], 2)
        : Buffer.from(fixtureText(GNIEZNO).replace('"orders":[', '"orders_v2":[')),
    );
    expect(await fetchError(bkAdapter.fetch(fetchContext(changed)))).toEqual(
      new SourceFormatError("bk", "detail does not have the expected structure"),
    );
    expect(changed.urls).toHaveLength(3);
  });

  /** Serves the captured source with each detail's version changed by `mutate` (ids → which). */
  function mutatedSource(
    mutate: (version: JsonRecord) => void,
    which: (id: number) => boolean = () => true,
  ) {
    return (url: URL): Buffer | Error => {
      const id = Number(url.pathname.split("/").at(-1));
      const name = LISTED[id];
      if (url.pathname === "/api/announcements/search" || name === undefined || !which(id)) {
        return capturedSource(url);
      }
      const detail = parsedDetail(name);
      mutate(detail.version);
      return Buffer.from(detail.body());
    };
  }

  const renameTitle = (version: JsonRecord) => {
    version.name = version.title;
    delete version.title;
  };

  it("fails the day when every detail lost a required field (a renamed title, AC2)", async () => {
    const http = new FakeHttpClient(mutatedSource(renameTitle));
    const logLines: string[] = [];
    expect(await fetchError(bkAdapter.fetch(fetchContext(http, {}, logLines)))).toEqual(
      new SourceFormatError("bk", "detail does not have the expected fields"),
    );
    // The listing, then the details up to the first one past the skip limit.
    expect(http.urls).toHaveLength(1 + BK_MAX_SKIPPED_DETAILS_PER_DAY + 1);
    const logs = logLines.map((line) => logEntrySchema.parse(JSON.parse(line)));
    // Field paths only, never values.
    expect(logs).toContainEqual({
      time: expect.any(String) as unknown,
      level: "warn",
      message: "source detail fields invalid",
      sourceId: "bk",
      announcementId: 296132,
      invalidFields: ["title"],
    });
  });

  it("skips one detail without the advertiser's name and reports detail_invalid", async () => {
    const http = new FakeHttpClient(
      mutatedSource(
        (version) => {
          version.advertiser_address_details = { full_name: "x" };
        },
        (id) => id === 296920,
      ),
    );
    const result = await bkAdapter.fetch(fetchContext(http));
    expect(result.documents.map((doc) => doc.url)).toEqual([
      detailUrl(296132),
      detailUrl(296667),
      detailUrl(296622),
    ]);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "detail_invalid" }]);
  });

  it("fails a day whose every read record is rejected (a new deadline format, AC2)", async () => {
    const otherFormat = (version: JsonRecord) => {
      version.submission_deadline = "05.11.2026 15:00";
    };
    const http = new FakeHttpClient(mutatedSource(otherFormat));
    expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toEqual(
      new SourceFormatError("bk", "every record of the day was rejected"),
    );
    expect(http.urls).toHaveLength(5);

    // One such record is an ordinary rejection: handed over, the day goes on.
    const one = new FakeHttpClient(mutatedSource(otherFormat, (id) => id === 296667));
    const result = await bkAdapter.fetch(fetchContext(one));
    expect(result.documents).toHaveLength(4);
    expect(result.incomplete).toEqual([]);
  });

  it("does not fail a small day whose records are all rejected, up to the skip limit", async () => {
    const detail = parsedDetail(GNIEZNO);
    detail.version.submission_deadline = "05.11.2026 15:00";
    const rejectedBody = Buffer.from(detail.body());
    for (const ids of [[296132], range(1, BK_MAX_SKIPPED_DETAILS_PER_DAY)]) {
      const http = new FakeHttpClient((url) =>
        url.pathname === "/api/announcements/search" ? listPage(ids, ids.length) : rejectedBody,
      );
      const result = await bkAdapter.fetch(fetchContext(http));
      // Handed over (ingest counts the rejection), the day not failed.
      expect(result.documents).toHaveLength(ids.length);
      expect(result.incomplete).toEqual([]);
      for (const document of result.documents) {
        expect(normalizeBody(document.body)).toEqual({
          ok: false,
          externalId: "296132",
          reason: "invalid value: deadline",
        });
      }
    }
    // One record more than the limit, all rejected: a format change.
    const ids = range(1, BK_MAX_SKIPPED_DETAILS_PER_DAY + 1);
    const http = new FakeHttpClient((url) =>
      url.pathname === "/api/announcements/search" ? listPage(ids, ids.length) : rejectedBody,
    );
    expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toEqual(
      new SourceFormatError("bk", "every record of the day was rejected"),
    );
  });

  it("counts an all-rejected day past the skips: read records, not listed ones (L-R4-2)", async () => {
    const detail = parsedDetail(GNIEZNO);
    detail.version.submission_deadline = "05.11.2026 15:00";
    const rejectedBody = Buffer.from(detail.body());
    const missing = new HttpClientError("http_status", { status: 404, host: BK_HOST });
    const day = (ids: readonly number[]) =>
      new FakeHttpClient((url) => {
        if (url.pathname === "/api/announcements/search") return listPage(ids, ids.length);
        // The first two listed details are gone, the rest are rejected records.
        return url.pathname.endsWith("/1") || url.pathname.endsWith("/2") ? missing : rejectedBody;
      });
    // 2 skipped + 3 read, all rejected: past the limit, the day fails.
    expect(await fetchError(bkAdapter.fetch(fetchContext(day(range(1, 5)))))).toEqual(
      new SourceFormatError("bk", "every record of the day was rejected"),
    );
    // 2 skipped + 2 read, all rejected: within the limit, incomplete, not failed.
    const result = await bkAdapter.fetch(fetchContext(day(range(1, 4))));
    expect(result.documents).toHaveLength(2);
    expect(result.incomplete).toEqual([{ part: "announcements", reason: "detail_missing" }]);
  });

  it("propagates HTTP client errors unchanged", async () => {
    // A 404 of a detail is skipped (tested below); any other HTTP failure fails the day.
    const failure = new HttpClientError("http_status", { status: 503, host: BK_HOST });
    const http = new FakeHttpClient((url, call) => (call === 3 ? failure : capturedSource(url)));
    expect(await fetchError(bkAdapter.fetch(fetchContext(http)))).toBe(failure);
    expect(http.urls).toHaveLength(3);
  });

  it("stops when the run is aborted between requests", async () => {
    const controller = new AbortController();
    const http = new FakeHttpClient((url) => {
      if (url.pathname !== "/api/announcements/search") controller.abort();
      return capturedSource(url);
    });
    const error = await fetchError(
      bkAdapter.fetch(fetchContext(http, { signal: controller.signal })),
    );
    expect(error).toMatchObject({ name: "HttpClientError", code: "aborted" });
    expect(http.urls).toHaveLength(2);
  });

  it("rejects an invalid publication date or record limit before any request", async () => {
    const http = new FakeHttpClient(() => fixtureBytes(EMPTY));
    for (const overrides of [
      { publicationDate: "2026-11-03&limit=1000" },
      { maxRecords: 0 },
      { maxRecords: 1.5 },
    ]) {
      expect(await fetchError(bkAdapter.fetch(fetchContext(http, overrides)))).toBeInstanceOf(
        TypeError,
      );
    }
    expect(http.urls).toEqual([]);
  });
});

describe("bkAdapter.fetch with onDocument (streaming, used by ingest)", () => {
  it("hands over each detail before the next request and keeps none", async () => {
    const http = new FakeHttpClient(capturedSource);
    const seen: { url: string; requests: number }[] = [];
    const result = await bkAdapter.fetch(
      fetchContext(http, {
        onDocument: (doc) => {
          seen.push({ url: doc.url, requests: http.urls.length });
          return Promise.resolve();
        },
      }),
    );
    expect(result.documents).toEqual([]);
    expect(seen).toEqual([
      { url: detailUrl(296132), requests: 2 },
      { url: detailUrl(296920), requests: 3 },
      { url: detailUrl(296667), requests: 4 },
      { url: detailUrl(296622), requests: 5 },
    ]);
  });

  it("stops on the callback's rejection", async () => {
    const http = new FakeHttpClient(capturedSource);
    const failure = new Error("store failed");
    const error = await fetchError(
      bkAdapter.fetch(fetchContext(http, { onDocument: () => Promise.reject(failure) })),
    );
    expect(error).toBe(failure);
    expect(http.urls).toHaveLength(2);
  });
});
