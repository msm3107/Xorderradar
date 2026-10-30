import { z } from "zod";
import {
  opportunityCandidateSchema,
  type OpportunityLocation,
  type OpportunityStatus,
} from "../../domain/opportunity.js";
import { HttpClientError } from "../../infrastructure/http/errors.js";
import {
  SourceFormatError,
  type FetchContext,
  type FetchResult,
  type IncompleteFetch,
  type IncompleteReason,
  type NormalizeResult,
  type RawDocument,
  type SourceAdapter,
} from "../types.js";
import { bzpProvinces } from "./provinces.js";

/**
 * Biuletyn Zamówień Publicznych through the official "API BZP (WebService)" of
 * the e-Zamówienia platform — basis of use, API facts and mapping: D-015.
 */
export const BZP_SOURCE_ID = "bzp";
export const BZP_HOST = "ezamowienia.gov.pl";
const LIST_URL = `https://${BZP_HOST}/mo-board/api/v1/notice`;
/** Public notice page; `objectId` is the notice id. */
const DETAIL_URL = `https://${BZP_HOST}/mo-client-board/bzp/notice-details/id/`;

/** National below-EU contract notices, then small contracts published voluntarily (Pzp does not apply). */
export const BZP_NOTICE_TYPES = ["ContractNotice", "SmallContractNotice"] as const;
export type BzpNoticeType = (typeof BZP_NOTICE_TYPES)[number];

/**
 * Records per request: a record is typically ~31 KB (median) and up to ~100 KB (max 95.6 KB
 * measured on 2026-10-28), so a typical page is < 1 MB and the worst case ~2.4 MB — about 2x
 * under the 5 MB response limit. Re-check this margin before raising the page size.
 */
export const BZP_PAGE_SIZE = 25;
/** Per notice type and run; ~1000 records, above the few hundred published per day. */
export const BZP_MAX_PAGES_PER_TYPE = 40;
/** The API refuses PageSize above 500, so a longer document is not a page we asked for. */
const MAX_RECORDS_PER_DOCUMENT = 500;
/** Bound on every string read from a record, before any regular expression runs on it. */
const MAX_FIELD_LENGTH = 20_000;

/** Lower-case hex GUID; anything else is never put into a URL. */
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** e.g. `2026-10-29T04:21:51.7907299Z`; UTC only, fraction optional (7 digits in practice). */
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** CPV code with check digit, e.g. `45453000-7`; descriptions may contain commas. */
const CPV_CODE = /\b\d{8}-\d\b/g;

const field = z.string().max(MAX_FIELD_LENGTH);
const optionalField = field.nullish();

/**
 * Only the fields the mapping uses. Not strict: the source may add fields
 * without breaking us; `htmlBody`, `contractors` and every other field are
 * dropped here and never retained.
 */
const bzpRecordSchema = z.object({
  noticeNumber: field,
  objectId: z.string().regex(OBJECT_ID),
  publicationDate: field,
  orderObject: field,
  organizationName: field,
  organizationCity: optionalField,
  organizationProvince: optionalField,
  cpvCode: optionalField,
  submittingOffersDate: optionalField,
});

export type BzpRecord = z.output<typeof bzpRecordSchema>;

/**
 * An extracted list item: either the validated record, or the field paths that
 * did not match (turned into a rejection by `normalize`, so one bad record
 * never fails the whole page).
 */
export type BzpNotice =
  | { readonly valid: true; readonly fetchedAt: Date; readonly record: BzpRecord }
  | {
      readonly valid: false;
      readonly fetchedAt: Date;
      readonly externalId: string | null;
      readonly invalidFields: readonly string[];
    };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeBody(body: Buffer): string {
  try {
    return utf8.decode(body);
  } catch {
    throw new SourceFormatError(BZP_SOURCE_ID, "body is not valid UTF-8");
  }
}

/** The document-level contract: a JSON array of at most MAX_RECORDS_PER_DOCUMENT items. */
function parseRecords(body: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SourceFormatError(BZP_SOURCE_ID, "body is not valid JSON");
  }
  if (!Array.isArray(parsed))
    throw new SourceFormatError(BZP_SOURCE_ID, "body is not a JSON array");
  const records: readonly unknown[] = parsed;
  if (records.length > MAX_RECORDS_PER_DOCUMENT) {
    throw new SourceFormatError(BZP_SOURCE_ID, "too many records in one document");
  }
  return records;
}

function stringProperty(item: unknown, key: string): string | null {
  if (typeof item !== "object" || item === null || !Object.hasOwn(item, key)) return null;
  // Indexing an object with an own property checked above; the value stays unknown.
  const value: unknown = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** The pagination cursor: only a well-formed objectId is ever sent back to the API. */
function cursorOf(item: unknown): string | null {
  const objectId = stringProperty(item, "objectId");
  return objectId !== null && OBJECT_ID.test(objectId) ? objectId : null;
}

/** Notice number of a record, if readable — for rejection logs only. */
function externalIdOf(item: unknown): string | null {
  const value = stringProperty(item, "noticeNumber")?.trim() ?? "";
  return value.length > 0 && value.length <= 200 ? value : null;
}

function listUrl(
  noticeType: BzpNoticeType,
  publicationDate: string,
  pageSize: number,
  searchAfter: string | null,
): URL {
  const url = new URL(LIST_URL);
  url.searchParams.set("NoticeType", noticeType);
  url.searchParams.set("PublicationDateFrom", publicationDate);
  url.searchParams.set("PublicationDateTo", publicationDate);
  url.searchParams.set("PageSize", String(pageSize));
  if (searchAfter !== null) url.searchParams.set("SearchAfter", searchAfter);
  return url;
}

interface TypeFetch {
  readonly pages: number;
  readonly records: number;
  /** Null when the listing ended naturally (empty or short page). */
  readonly stop: IncompleteReason | null;
}

/**
 * Pages through one notice type with keyset pagination (`SearchAfter` = the
 * objectId of the last record). Ends on an empty or short page; stops early on
 * the record budget, the page limit, a missing/invalid cursor or a cursor seen
 * before (a source that does not advance would otherwise loop forever). A page
 * ending on a cursor already used repeats records collected before, so it is
 * dropped; every other page is kept and counted towards the budget.
 */
async function fetchNoticeType(
  ctx: FetchContext,
  noticeType: BzpNoticeType,
  budget: number,
  documents: RawDocument[],
): Promise<TypeFetch> {
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let records = 0;
  for (let page = 1; ; page++) {
    if (page > BZP_MAX_PAGES_PER_TYPE) return { pages: page - 1, records, stop: "max_pages" };
    // SafeHttpClient also refuses an aborted signal; checked here so the loop
    // never depends on the client for it.
    if (ctx.signal.aborted) throw new HttpClientError("aborted", { host: BZP_HOST });
    const pageSize = Math.min(BZP_PAGE_SIZE, budget - records);
    const url = listUrl(noticeType, ctx.publicationDate, pageSize, cursor);
    const response = await ctx.http.get(url, { signal: ctx.signal });
    const body = decodeBody(response.body);
    const items = parseRecords(body);
    if (items.length > pageSize) {
      throw new SourceFormatError(BZP_SOURCE_ID, "page has more records than requested");
    }
    const next = cursorOf(items.at(-1));
    if (next !== null && seenCursors.has(next)) {
      return { pages: page, records, stop: "repeated_cursor" };
    }
    const document: RawDocument = {
      sourceId: BZP_SOURCE_ID,
      url: response.url,
      fetchedAt: ctx.now(),
      contentType: response.contentType,
      body,
    };
    // Streaming (ingest): the page is processed before the next request and
    // not kept, so memory stays bounded by one page (D-008).
    if (ctx.onDocument === undefined) documents.push(document);
    else await ctx.onDocument(document);
    records += items.length;
    if (items.length < pageSize) return { pages: page, records, stop: null };
    if (records >= budget) return { pages: page, records, stop: "max_records" };
    // The page's records are new and kept; only paging cannot continue safely.
    if (next === null) return { pages: page, records, stop: "invalid_cursor" };
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * Fetches every configured notice type published on `ctx.publicationDate`,
 * sequentially, each within its own `ctx.maxRecords` records and page limit:
 * a busy type never starves the next one (small contracts come second), so a
 * run returns at most `BZP_NOTICE_TYPES.length × maxRecords` records. HTTP
 * failures (HttpClientError) and unusable documents (SourceFormatError) reject
 * the whole fetch. With `ctx.onDocument`, documents are streamed to it instead
 * of being returned (pages handed over before a failure stay handed over).
 */
async function fetchNotices(ctx: FetchContext): Promise<FetchResult> {
  if (!CALENDAR_DATE.test(ctx.publicationDate)) {
    throw new TypeError("publicationDate must be YYYY-MM-DD");
  }
  if (!Number.isInteger(ctx.maxRecords) || ctx.maxRecords < 1) {
    throw new TypeError("maxRecords must be a positive integer");
  }
  const documents: RawDocument[] = [];
  const incomplete: IncompleteFetch[] = [];
  for (const noticeType of BZP_NOTICE_TYPES) {
    const result = await fetchNoticeType(ctx, noticeType, ctx.maxRecords, documents);
    const fields = { sourceId: BZP_SOURCE_ID, part: noticeType, pages: result.pages };
    if (result.stop === null) {
      ctx.logger.info("source listing fetched", { ...fields, records: result.records });
    } else {
      incomplete.push({ part: noticeType, reason: result.stop });
      ctx.logger.warn("source listing incomplete", {
        ...fields,
        records: result.records,
        reason: result.stop,
      });
    }
  }
  return { documents, incomplete };
}

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"))];
}

/**
 * Pure. Throws SourceFormatError when the document is not a JSON array (or is
 * too long); each item is validated on its own.
 */
function extractNotices(doc: RawDocument): BzpNotice[] {
  return parseRecords(doc.body).map((item): BzpNotice => {
    const result = bzpRecordSchema.safeParse(item);
    if (result.success) return { valid: true, fetchedAt: doc.fetchedAt, record: result.data };
    return {
      valid: false,
      fetchedAt: doc.fetchedAt,
      externalId: externalIdOf(item),
      invalidFields: issuePaths(result.error),
    };
  });
}

/**
 * Strict UTC timestamp → Date, or null. The fraction is truncated to
 * milliseconds (Date's precision). Impossible dates (2026-02-30, 24:00:00) are
 * rejected instead of being rolled over.
 */
function parseUtcTimestamp(value: string): Date | null {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return null;
  // A missing group gives NaN, which fails the round-trip check below.
  const part = (index: number) => Number(match[index]);
  const [y, mo, d, h, mi, s] = [part(1), part(2), part(3), part(4), part(5), part(6)];
  const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const roundTrip =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  return roundTrip ? date : null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Blank counts as absent: the source uses `null`, but `""` carries no more information. */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = collapseWhitespace(value);
  return collapsed === "" ? null : collapsed;
}

/** CPV codes in published order, without duplicates; descriptions are not kept. */
function cpvCodes(value: string | null | undefined): string[] {
  return [...new Set(value?.match(CPV_CODE) ?? [])];
}

/**
 * The buyer's seat (city + voivodeship from the province code), not the place
 * of performance, which the list API does not give (D-015).
 */
function buyerLocation(record: BzpRecord): OpportunityLocation | null {
  const city = present(record.organizationCity);
  const province = present(record.organizationProvince);
  const voivodeship = province === null ? undefined : bzpProvinces.get(province);
  if (city === null && voivodeship === undefined) return null;
  return {
    ...(city === null ? {} : { city }),
    ...(voivodeship === undefined ? {} : { voivodeship }),
  };
}

function statusOf(deadline: Date | null, fetchedAt: Date): OpportunityStatus {
  if (deadline === null) return "unknown";
  return deadline.getTime() > fetchedAt.getTime() ? "open" : "closed";
}

function reject(externalId: string | null, reason: string): NormalizeResult {
  return { ok: false, externalId, reason };
}

/**
 * Pure mapping (D-015). Values the list API does not provide (description,
 * contact, estimated value) stay null; nothing is guessed or truncated — a
 * record that does not fit the domain rules is rejected with the field names.
 */
function normalizeNotice(notice: BzpNotice): NormalizeResult {
  if (!notice.valid) {
    return reject(notice.externalId, `invalid source fields: ${notice.invalidFields.join(", ")}`);
  }
  const { record, fetchedAt } = notice;
  const externalId = externalIdOf(record);
  // Both timestamps: surrounding whitespace trimmed, then the strict format;
  // a blank deadline means none was published.
  const publishedAt = parseUtcTimestamp(record.publicationDate.trim());
  if (publishedAt === null) return reject(externalId, "invalid value: publishedAt");
  const deadlineText = record.submittingOffersDate?.trim() ?? "";
  const deadline = deadlineText === "" ? null : parseUtcTimestamp(deadlineText);
  if (deadlineText !== "" && deadline === null) {
    return reject(externalId, "invalid value: deadline");
  }
  const result = opportunityCandidateSchema.safeParse({
    sourceId: BZP_SOURCE_ID,
    sourceUrl: `${DETAIL_URL}${record.objectId}`,
    externalId: record.noticeNumber,
    issuerName: collapseWhitespace(record.organizationName),
    title: collapseWhitespace(record.orderObject),
    description: null,
    location: buyerLocation(record),
    publishedAt,
    deadline,
    estimatedValue: null,
    currency: null,
    categories: cpvCodes(record.cpvCode),
    contact: null,
    fetchedAt,
    status: statusOf(deadline, fetchedAt),
  });
  if (!result.success) {
    return reject(externalId, `invalid value: ${issuePaths(result.error).join(", ")}`);
  }
  return { ok: true, candidate: result.data };
}

export const bzpAdapter: SourceAdapter<BzpNotice> = {
  sourceId: BZP_SOURCE_ID,
  allowedHosts: [BZP_HOST],
  fetch: fetchNotices,
  extract: extractNotices,
  normalize: normalizeNotice,
};
