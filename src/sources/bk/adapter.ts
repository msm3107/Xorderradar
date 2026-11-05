import { z } from "zod";
import { emailSchema, text } from "../../domain/common.js";
import {
  contactSchema,
  decimalAmountSchema,
  opportunityCandidateSchema,
  type OpportunityContact,
  type OpportunityLocation,
  type OpportunityStatus,
} from "../../domain/opportunity.js";
import { HttpClientError } from "../../infrastructure/http/errors.js";
import { normalizeVoivodeship } from "../normalize/regions.js";
import { warsawLocalToUtc } from "../normalize/warsaw-time.js";
import { cleanText } from "../normalize/whitespace.js";
import { BK_SOURCE_ID } from "./attribution.js";
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

/**
 * Baza Konkurencyjności (Ministerstwo Funduszy i Polityki Regionalnej) through
 * the JSON API its public web application uses — basis of use, API facts,
 * risks and the mapping rules: D-030.
 */
export { BK_SOURCE_ID };
export const BK_HOST = "bazakonkurencyjnosci.funduszeeuropejskie.gov.pl";
const SEARCH_URL = `https://${BK_HOST}/api/announcements/search`;
/** Announcement detail (the current version); followed by the announcement id. */
const DETAIL_API_URL = `https://${BK_HOST}/api/announcements/`;
/** Public announcement page, the offer's link; followed by the announcement id. */
const PAGE_URL = `https://${BK_HOST}/ogloszenia/`;

/** Largest page the web application itself asks for; a page is ~73 KB (2026-11-03). */
export const BK_PAGE_SIZE = 100;
/**
 * Details read per publication day, whatever the run's record limit: each is
 * one request (>= 2 s apart, ~2.9 s measured), so 250 fit the per-source
 * ingest timeout of 15 min with room (INGEST_SOURCE_TIMEOUT_MS). A busy day
 * had 180 (2026-11-03). More → `incomplete` (`max_records`), never silent.
 */
export const BK_MAX_DETAILS_PER_DAY = 250;
/** Pages per listing order and run: 500 positions, twice BK_MAX_DETAILS_PER_DAY. */
export const BK_MAX_PAGES_PER_ORDER = 5;
/**
 * Listing orders, read one after another until the distinct ids reach the
 * listing's total. Equal publication dates are not ordered stably between
 * pages: with `publicationDate` alone, pages 1 and 2 of 2026-11-03 (total 180)
 * overlapped by 14 announcements and missed 14 others; the `default` order
 * missed a different 14, and both together gave all 180 (D-030).
 */
export const BK_LIST_ORDERS = ["publicationDate", "default"] as const;
/**
 * Unusable details (404, or not the detail envelope) skipped per day, each
 * reported in `incomplete`; the next one fails the day with its own error, so
 * a changed format or a moved endpoint stays a failed day (D-030).
 */
export const BK_MAX_SKIPPED_DETAILS_PER_DAY = 2;
/** The `incomplete` part name: the source has one listing. */
const PART = "announcements";

/** Bound on every string read from a document, before any regular expression runs on it. */
const MAX_FIELD_LENGTH = 20_000;
/** Bound on one order item's description as published (the stored one is 10 000). */
const MAX_SOURCE_DESCRIPTION_LENGTH = 200_000;
/** Bounds on the lists of one announcement (orders = parts, items, places, CPV codes). */
const MAX_LIST_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 1_000;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_CATEGORIES = 100;
const MAX_LOCATION_RAW_LENGTH = 500;
const MAX_PHONE_LENGTH = 50;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** e.g. `2026-11-03`; the day of publication, in Poland. */
const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** e.g. `2026-11-17 23:59:59`; Warsaw wall-clock time without an offset. */
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/**
 * The amount as the application's form accepts it: digits, a comma and
 * exactly two decimals (`50000,00`). Anything else is not read (D-030).
 */
const AMOUNT = /^(\d{1,24}),(\d{2})$/;
const CPV_CODE = /^\d{8}-\d$/;
/**
 * A phone number: digits and the usual separators only. A value with letters
 * may hold a name or a comment and is not kept (D-022, D-030).
 */
const PHONE = /^[\d\s+()\-./,;]+$/;

const field = z.string().max(MAX_FIELD_LENGTH);
const optionalField = field.nullish();
/** An optional extra: an unusable value (not a string, too long) is treated as not published. */
const lenientField = optionalField.catch(null);
const id = z.int().positive();
const boundedList = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_LIST_LENGTH);

const listPageSchema = z.object({
  status: z.literal("OK"),
  data: z.object({
    // Only the id is used, each announcement is read from its detail; the
    // day is checked against the request (an ignored date filter).
    advertisements: z.array(z.object({ id, publication_date: field })),
    meta: z.object({ total: z.int().min(0) }),
  }),
});

/**
 * The document-level contract of a detail: the envelope, the version and the
 * announcement it belongs to. Missing → the source changed its format; the
 * document is unusable (SourceFormatError, `invalid_document`), never an empty
 * result. Loose objects: the version is validated again, field by field, below.
 */
const detailEnvelopeSchema = z.object({
  status: z.literal("OK"),
  data: z.object({
    advertisement: z.looseObject({
      id,
      advertisement: z.looseObject({ id }),
      orders: z.array(z.unknown()),
    }),
  }),
});

const fulfillmentPlaceSchema = z.object({
  country: lenientField,
  voivodeship: lenientField,
  poviat: lenientField,
  locality: lenientField,
  type: z.object({ name: lenientField }).nullish().catch(null),
});

const orderItemSchema = z.object({
  description: z.string().max(MAX_SOURCE_DESCRIPTION_LENGTH).nullish().catch(null),
  cpv_items: boundedList(z.object({ code: lenientField })).nullish(),
  fulfillment_places: boundedList(fulfillmentPlaceSchema).nullish(),
});

const orderSchema = z.object({
  // Strict: a value in another shape is a format change, not a missing value.
  estimated_value: optionalField,
  order_items: boundedList(orderItemSchema),
});

/**
 * Only the e-mail and the phone; `forename`, `surname` and every other field
 * of a contact person are dropped here and never retained (D-022).
 */
const contactPersonSchema = z.object({ email: lenientField, phone_number: lenientField });

const statusSchema = z.object({ label: lenientField }).nullish().catch(null);

/**
 * Only the fields the mapping uses (not strict: the source may add fields).
 * Attachments, addresses, conditions and the projects of the announcement are
 * not part of the record.
 */
const bkRecordSchema = z.object({
  id,
  title: field,
  submission_deadline: optionalField,
  advertiser_address_details: z.object({ name: field }),
  contact_persons: boundedList(contactPersonSchema).nullish(),
  orders: boundedList(orderSchema),
  advertisement: z.object({ id, publication_date: optionalField, status: statusSchema }),
});

export type BkRecord = z.output<typeof bkRecordSchema>;

/**
 * An extracted announcement: the validated record, or the field paths that did
 * not match (turned into a rejection by `normalize`).
 */
export type BkNotice =
  | { readonly valid: true; readonly fetchedAt: Date; readonly record: BkRecord }
  | {
      readonly valid: false;
      readonly fetchedAt: Date;
      readonly externalId: string;
      readonly invalidFields: readonly string[];
    };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeBody(body: Buffer): string {
  try {
    return utf8.decode(body);
  } catch {
    throw new SourceFormatError(BK_SOURCE_ID, "body is not valid UTF-8");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceFormatError(BK_SOURCE_ID, "body is not valid JSON");
  }
}

const statusOkSchema = z.object({ status: z.literal("OK") });

/** The API answers errors (e.g. not found) with an envelope of `status: "Error"`. */
function hasStatusOk(parsed: unknown): boolean {
  return statusOkSchema.safeParse(parsed).success;
}

/**
 * One listing page. The response is served as `text/html` even though it is
 * JSON, so the content type is never checked — the structure is.
 */
function parseListPage(
  body: string,
  pageSize: number,
  publicationDate: string,
): z.output<typeof listPageSchema>["data"] {
  const parsed = parseJson(body);
  if (!hasStatusOk(parsed)) throw new SourceFormatError(BK_SOURCE_ID, "response status is not OK");
  const page = listPageSchema.safeParse(parsed);
  if (!page.success) {
    throw new SourceFormatError(BK_SOURCE_ID, "listing does not have the expected structure");
  }
  if (page.data.data.advertisements.length > pageSize) {
    throw new SourceFormatError(BK_SOURCE_ID, "page has more records than requested");
  }
  // The list gives the current version's day as `YYYY-MM-DD` (fixtures,
  // 2026-11-03); another value means the filter was not applied as asked.
  if (page.data.data.advertisements.some((item) => item.publication_date !== publicationDate)) {
    throw new SourceFormatError(BK_SOURCE_ID, "listing has a record of another publication day");
  }
  return page.data.data;
}

function listUrl(
  publicationDate: string,
  order: (typeof BK_LIST_ORDERS)[number],
  page: number,
  pageSize: number,
): URL {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("sort", order);
  url.searchParams.append("status[]", "PUBLISHED");
  url.searchParams.set("publicationDateRange[from]", publicationDate);
  url.searchParams.set("publicationDateRange[to]", publicationDate);
  return url;
}

interface Listing {
  /** Distinct announcement ids, in listing order. */
  readonly ids: readonly number[];
  /** The listing's own count (the largest seen; it may grow while being read). */
  readonly total: number;
  readonly pages: number;
  readonly stop: IncompleteReason | null;
}

/**
 * The ids of the announcements published on `ctx.publicationDate` (their
 * current version), page by page in each of BK_LIST_ORDERS until the distinct
 * ids reach the listing's total — or `budget`. A short last page or the
 * total ends one order; a page shorter than requested before the listing's
 * end is a format error (it would end the order early with no alert). Not
 * reaching the target is never silent:
 * `max_pages` when an order hit its page limit, else `listing_mismatch`;
 * reaching only the budget is `max_records`.
 */
async function listAnnouncements(ctx: FetchContext, budget: number): Promise<Listing> {
  const pageSize = Math.min(BK_PAGE_SIZE, budget);
  const ids = new Set<number>();
  let total: number | null = null;
  let pages = 0;
  let pageLimitHit = false;
  const reachedTarget = () => total !== null && ids.size >= Math.min(total, budget);
  for (const order of BK_LIST_ORDERS) {
    for (let page = 1; !reachedTarget(); page++) {
      if (total !== null && (page - 1) * pageSize >= total) break;
      if (page > BK_MAX_PAGES_PER_ORDER) {
        pageLimitHit = true;
        break;
      }
      // SafeHttpClient also refuses an aborted signal; checked here so the loop
      // never depends on the client for it.
      if (ctx.signal.aborted) throw new HttpClientError("aborted", { host: BK_HOST });
      const url = listUrl(ctx.publicationDate, order, page, pageSize);
      const response = await ctx.http.get(url, { signal: ctx.signal });
      pages++;
      const data = parseListPage(decodeBody(response.body), pageSize, ctx.publicationDate);
      total = Math.max(total ?? 0, data.meta.total);
      for (const item of data.advertisements) ids.add(item.id);
      if (data.advertisements.length < pageSize) {
        // Measured: positions are full up to the total even when the records
        // in them repeat (page 2 of 2026-11-03: 80, 100 + 80 = 180 = total).
        if ((page - 1) * pageSize + data.advertisements.length < data.meta.total) {
          throw new SourceFormatError(
            BK_SOURCE_ID,
            "page shorter than requested before the listing's end",
          );
        }
        break;
      }
    }
    if (reachedTarget()) break;
  }
  const listed = total ?? 0;
  let stop: IncompleteReason | null = null;
  if (!reachedTarget()) stop = pageLimitHit ? "max_pages" : "listing_mismatch";
  else if (listed > budget) stop = "max_records";
  return { ids: [...ids], total: listed, pages, stop };
}

type DetailSkip = Extract<IncompleteReason, "detail_missing" | "detail_invalid">;
type SkippableError = HttpClientError | SourceFormatError;

/** Why one detail may be skipped instead of failing the day; null: the error fails it. */
function detailSkip(error: unknown): { reason: DetailSkip; error: SkippableError } | null {
  if (error instanceof HttpClientError && error.code === "http_status" && error.status === 404) {
    return { reason: "detail_missing", error };
  }
  return error instanceof SourceFormatError ? { reason: "detail_invalid", error } : null;
}

/**
 * One announcement's detail, checked before it is handed over with the same
 * pure `extract` and `normalize` that ingest runs on it: not the detail
 * envelope, or a record without the fields the mapping needs (e.g. a renamed
 * `title`) → SourceFormatError, so a renamed field is a skipped detail and,
 * past the limit, a failed day, never a day of rejections that `status` does
 * not see (D-030). `rejected`: the record is valid but `normalize` refuses a
 * value (e.g. a deadline in another format); it is still handed over and
 * counted as a rejection by ingest.
 */
async function readDetail(
  ctx: FetchContext,
  announcementId: number,
): Promise<{ document: RawDocument; rejected: boolean }> {
  const response = await ctx.http.get(`${DETAIL_API_URL}${String(announcementId)}`, {
    signal: ctx.signal,
  });
  const document: RawDocument = {
    sourceId: BK_SOURCE_ID,
    url: response.url,
    fetchedAt: ctx.now(),
    contentType: response.contentType,
    body: decodeBody(response.body),
  };
  for (const notice of extractAnnouncement(document)) {
    if (!notice.valid) {
      // Field paths of our schema only, never values.
      ctx.logger.warn("source detail fields invalid", {
        sourceId: BK_SOURCE_ID,
        announcementId,
        invalidFields: notice.invalidFields,
      });
      throw new SourceFormatError(BK_SOURCE_ID, "detail does not have the expected fields");
    }
    return { document, rejected: !normalizeAnnouncement(notice).ok };
  }
  throw new SourceFormatError(BK_SOURCE_ID, "detail has no announcement");
}

/**
 * Reads the listing of `ctx.publicationDate`, then the detail of each listed
 * announcement (at most `ctx.maxRecords` and BK_MAX_DETAILS_PER_DAY),
 * sequentially. Only details are documents; listing pages are validated and
 * dropped. A detail answered 404 (`detail_missing`, e.g. withdrawn after the
 * listing) or not a usable record (`detail_invalid`, readDetail) is skipped,
 * logged with its id and reported in `incomplete` — up to
 * BK_MAX_SKIPPED_DETAILS_PER_DAY; one more, or a day whose every detail was
 * skipped, rejects the fetch with that detail's error. A day of more than
 * BK_MAX_SKIPPED_DETAILS_PER_DAY read records that `normalize` all rejects is a
 * format change too (SourceFormatError, after the records were handed over and
 * counted as rejections). Other HTTP failures
 * (HttpClientError) and unusable listing pages (SourceFormatError) reject the
 * whole fetch. With `ctx.onDocument`, details are streamed to it instead of
 * being returned (details handed over before a failure stay handed over).
 */
async function fetchAnnouncements(ctx: FetchContext): Promise<FetchResult> {
  if (!CALENDAR_DATE.test(ctx.publicationDate)) {
    throw new TypeError("publicationDate must be YYYY-MM-DD");
  }
  if (!Number.isInteger(ctx.maxRecords) || ctx.maxRecords < 1) {
    throw new TypeError("maxRecords must be a positive integer");
  }
  const budget = Math.min(ctx.maxRecords, BK_MAX_DETAILS_PER_DAY);
  const listing = await listAnnouncements(ctx, budget);
  const fields = { sourceId: BK_SOURCE_ID, part: PART, pages: listing.pages };
  const records = { records: listing.ids.length, total: listing.total };
  if (listing.stop === null) ctx.logger.info("source listing fetched", { ...fields, ...records });
  else
    ctx.logger.warn("source listing incomplete", { ...fields, ...records, reason: listing.stop });

  const documents: RawDocument[] = [];
  const skips = new Set<DetailSkip>();
  let skipped = 0;
  let lastSkipError: SkippableError | null = null;
  let read = 0;
  let rejected = 0;
  for (const announcementId of listing.ids.slice(0, budget)) {
    if (ctx.signal.aborted) throw new HttpClientError("aborted", { host: BK_HOST });
    let detail: { document: RawDocument; rejected: boolean };
    try {
      detail = await readDetail(ctx, announcementId);
    } catch (error: unknown) {
      const skip = detailSkip(error);
      if (skip === null) throw error;
      skipped++;
      ctx.logger.warn("source detail skipped", {
        sourceId: BK_SOURCE_ID,
        announcementId,
        reason: skip.reason,
        skipped,
      });
      if (skipped > BK_MAX_SKIPPED_DETAILS_PER_DAY) throw skip.error;
      skips.add(skip.reason);
      lastSkipError = skip.error;
      continue;
    }
    read++;
    if (detail.rejected) rejected++;
    // Streaming (ingest): the detail is processed before the next request and
    // not kept, so memory stays bounded by one document (D-008).
    if (ctx.onDocument === undefined) documents.push(detail.document);
    else await ctx.onDocument(detail.document);
  }
  // Nothing usable at all is not a partial day: e.g. a format change on a day
  // with fewer announcements than the skip limit.
  if (read === 0 && lastSkipError !== null) throw lastSkipError;
  // Every record refused (e.g. every deadline in a new format) would otherwise
  // be a `succeeded` day with nothing stored (D-030). Up to the skip limit it
  // is tolerated like skips: a small day with genuine rejections would else
  // fail, and be retried, every morning of the catch-up window.
  if (read > BK_MAX_SKIPPED_DETAILS_PER_DAY && rejected === read) {
    throw new SourceFormatError(BK_SOURCE_ID, "every record of the day was rejected");
  }
  const incomplete: IncompleteFetch[] = [
    ...(listing.stop === null ? [] : [{ part: PART, reason: listing.stop }]),
    ...[...skips].map((reason) => ({ part: PART, reason })),
  ];
  return { documents, incomplete };
}

/** A detail's envelope; SourceFormatError when the document is not one. */
function parseDetailEnvelope(body: string): z.output<typeof detailEnvelopeSchema> {
  const parsed = parseJson(body);
  if (!hasStatusOk(parsed)) throw new SourceFormatError(BK_SOURCE_ID, "response status is not OK");
  const envelope = detailEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new SourceFormatError(BK_SOURCE_ID, "detail does not have the expected structure");
  }
  return envelope.data;
}

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"))];
}

/**
 * Pure. One detail document → one announcement. Throws SourceFormatError when
 * the document is not the expected envelope; the version's fields are
 * validated on their own (a bad field is a rejection here; fetch already
 * skips such a detail, readDetail).
 */
function extractAnnouncement(doc: RawDocument): BkNotice[] {
  const version = parseDetailEnvelope(doc.body).data.advertisement;
  const externalId = String(version.advertisement.id);
  const record = bkRecordSchema.safeParse(version);
  if (!record.success) {
    return [
      {
        valid: false,
        fetchedAt: doc.fetchedAt,
        externalId,
        invalidFields: issuePaths(record.error),
      },
    ];
  }
  return [{ valid: true, fetchedAt: doc.fetchedAt, record: record.data }];
}

/** Absent, blank or unusable → null; otherwise the text cleaned for storage. */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = cleanText(value);
  return cleaned === "" ? null : cleaned;
}

/** Cut at the last whitespace before `max`, never inside a surrogate pair, then "…". */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  const lastSpace = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  else if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** `YYYY-MM-DD` → the start of that day in Poland; null when malformed or impossible. */
function parseLocalDay(value: string): Date | null {
  const match = LOCAL_DAY.exec(value);
  if (match === null) return null;
  const [year, month, day] = [1, 2, 3].map((index) => Number(match[index]));
  if (year === undefined || month === undefined || day === undefined) return null;
  return warsawLocalToUtc({ year, month, day, hour: 0, minute: 0 });
}

/**
 * `YYYY-MM-DD HH:MM:SS` in Warsaw time → UTC; null when malformed, impossible
 * or ambiguous (a DST change), never a guess.
 */
function parseLocalTimestamp(value: string): Date | null {
  const match = LOCAL_TIMESTAMP.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) =>
    Number(match[index]),
  );
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    second > 59
  ) {
    return null;
  }
  const instant = warsawLocalToUtc({ year, month, day, hour, minute });
  return instant === null ? null : new Date(instant.getTime() + second * 1000);
}

/** One order's amount in grosze; null when not published, malformed or not above zero. */
function groszeOf(value: string | null | undefined): bigint | null {
  const match = AMOUNT.exec(value?.trim() ?? "");
  if (match === null) return null;
  const [, whole = "", fraction = ""] = match;
  const grosze = BigInt(whole) * 100n + BigInt(fraction);
  return grosze > 0n ? grosze : null;
}

/**
 * The announcement's estimated value (D-030): one order → its value; several
 * orders (parts) → their sum, only when every order has one. Any order
 * without a usable value, or a sum outside the stored range → null, never a
 * partial sum or 0. Exact: integer grosze, no floating point.
 */
function estimatedValueOf(orders: BkRecord["orders"]): string | null {
  if (orders.length === 0) return null;
  let sum = 0n;
  for (const order of orders) {
    const grosze = groszeOf(order.estimated_value);
    if (grosze === null) return null;
    sum += grosze;
  }
  const value = `${(sum / 100n).toString()}.${(sum % 100n).toString().padStart(2, "0")}`;
  return decimalAmountSchema.safeParse(value).success ? value : null;
}

type OrderItem = BkRecord["orders"][number]["order_items"][number];

function orderItems(record: BkRecord): OrderItem[] {
  return record.orders.flatMap((order) => order.order_items);
}

/**
 * Every item's description in order, a blank line between items; inside one
 * each published line is cleaned and empty lines dropped. Longer than the
 * stored bound → cut at a word boundary with "…". None → null.
 */
function descriptionOf(items: readonly OrderItem[]): string | null {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    if (length > MAX_DESCRIPTION_LENGTH) break;
    const lines = (item.description ?? "")
      .split(/\r\n|\r|\n/u)
      .map(cleanText)
      .filter((line) => line !== "");
    if (lines.length === 0) continue;
    const part = lines.join("\n");
    parts.push(part);
    length += part.length + 2;
  }
  if (parts.length === 0) return null;
  return truncate(parts.join("\n\n"), MAX_DESCRIPTION_LENGTH);
}

/** CPV codes of all items, in published order, without duplicates; names are not kept. */
function cpvCodesOf(items: readonly OrderItem[]): string[] {
  const codes = new Set<string>();
  for (const item of items) {
    for (const cpv of item.cpv_items ?? []) {
      const code = cpv.code?.trim() ?? "";
      if (CPV_CODE.test(code)) codes.add(code);
    }
  }
  return [...codes].slice(0, MAX_CATEGORIES);
}

/** The value every place has, when it is the same non-empty one for all; else null. */
function shared(values: readonly (string | null)[], max: number): string | null {
  const [first] = values;
  if (first === undefined || first === null || first.length > max) return null;
  return values.every((value) => value === first) ? first : null;
}

/**
 * The places of performance (D-030). All in one voivodeship → that
 * voivodeship (canonical name), with the county and the locality when every
 * place has the same one. Several voivodeships, "cała Polska" or abroad → no
 * voivodeship (choosing one would hide the offer from profiles in the
 * others): `raw` lists the distinct places instead. None → null.
 */
function locationOf(items: readonly OrderItem[]): OpportunityLocation | null {
  const places = items.flatMap((item) => item.fulfillment_places ?? []);
  if (places.length === 0) return null;
  const voivodeships = places.map((place) => {
    const name = present(place.voivodeship);
    return name === null ? null : normalizeVoivodeship(name);
  });
  const voivodeship = shared(voivodeships, 100);
  if (voivodeship !== null) {
    const county = shared(
      places.map((place) => present(place.poviat)),
      100,
    );
    const city = shared(
      places.map((place) => present(place.locality)),
      200,
    );
    return {
      voivodeship,
      ...(county === null ? {} : { county }),
      ...(city === null ? {} : { city }),
    };
  }
  // Per place: its voivodeship; else a country other than Poland; else the
  // place type unless it is a plain address ("cała Polska"); else the locality.
  const labels = new Set<string>();
  places.forEach((place, index) => {
    const country = present(place.country);
    const type = present(place.type?.name);
    const label =
      voivodeships[index] ??
      (country === null || country.toLowerCase() === "polska" ? null : country) ??
      (type === null || type.toLowerCase() === "adres" ? null : type) ??
      present(place.locality);
    if (label !== null) labels.add(label);
  });
  let raw = "";
  for (const label of labels) {
    const next = raw === "" ? label : `${raw}, ${label}`;
    if (next.length <= MAX_LOCATION_RAW_LENGTH) raw = next;
  }
  return raw === "" ? null : { raw };
}

const phoneSchema = text(MAX_PHONE_LENGTH);

/**
 * The first contact person with a usable e-mail or phone (D-022): a valid
 * e-mail → `email` (lower case); a phone of digits and separators with at
 * least one digit → `phone`. Anything else ("-", "", text with letters, an
 * invalid e-mail) is dropped, not kept in `raw`, as it may hold a name. Never
 * a name. None → null.
 */
function contactOf(record: BkRecord): OpportunityContact | null {
  for (const person of record.contact_persons ?? []) {
    const contact: { email?: string; phone?: string } = {};
    const email = emailSchema.safeParse(present(person.email));
    if (email.success) contact.email = email.data;
    const phoneText = present(person.phone_number);
    if (phoneText !== null && PHONE.test(phoneText) && /\d/u.test(phoneText)) {
      const phone = phoneSchema.safeParse(phoneText);
      if (phone.success) contact.phone = phone.data;
    }
    const result = contactSchema.safeParse(contact);
    if (result.success) return result.data;
  }
  return null;
}

/**
 * The announcement's status label: published → open until the deadline;
 * cancelled; closed or resolved → closed; anything else → unknown.
 */
function statusOf(label: string | null, deadline: Date | null, fetchedAt: Date): OpportunityStatus {
  switch (label) {
    case "PUBLISHED":
      if (deadline === null) return "unknown";
      return deadline.getTime() > fetchedAt.getTime() ? "open" : "closed";
    case "CANCELLED":
      return "cancelled";
    case "CLOSED":
    case "RESOLVED":
      return "closed";
    case null:
    default:
      return "unknown";
  }
}

function reject(externalId: string | null, reason: string): NormalizeResult {
  return { ok: false, externalId, reason };
}

/**
 * Pure mapping (D-030). Title and description cleaned and cut to the stored
 * bounds; value, currency, location and contact only as published, else null.
 * A date that is published but unreadable rejects the announcement with the
 * field name.
 */
function normalizeAnnouncement(notice: BkNotice): NormalizeResult {
  if (!notice.valid) {
    return reject(notice.externalId, `invalid source fields: ${notice.invalidFields.join(", ")}`);
  }
  const { record, fetchedAt } = notice;
  const externalId = String(record.advertisement.id);
  const publishedText = present(record.advertisement.publication_date);
  const publishedAt = publishedText === null ? null : parseLocalDay(publishedText);
  if (publishedText !== null && publishedAt === null) {
    return reject(externalId, "invalid value: publishedAt");
  }
  const deadlineText = present(record.submission_deadline);
  const deadline = deadlineText === null ? null : parseLocalTimestamp(deadlineText);
  if (deadlineText !== null && deadline === null) {
    return reject(externalId, "invalid value: deadline");
  }
  const items = orderItems(record);
  const estimatedValue = estimatedValueOf(record.orders);
  const status = present(record.advertisement.status?.label);
  const result = opportunityCandidateSchema.safeParse({
    sourceId: BK_SOURCE_ID,
    sourceUrl: `${PAGE_URL}${externalId}`,
    externalId,
    tenderId: null,
    issuerName: cleanText(record.advertiser_address_details.name),
    title: truncate(cleanText(record.title), MAX_TITLE_LENGTH),
    description: descriptionOf(items),
    location: locationOf(items),
    publishedAt,
    deadline,
    estimatedValue,
    // The application publishes amounts in złoty only: its form has no
    // currency field and shows every amount with "PLN" (D-030).
    currency: estimatedValue === null ? null : "PLN",
    categories: cpvCodesOf(items),
    contact: contactOf(record),
    fetchedAt,
    status: statusOf(status, deadline, fetchedAt),
  });
  if (!result.success) {
    return reject(externalId, `invalid value: ${issuePaths(result.error).join(", ")}`);
  }
  return { ok: true, kind: "opportunity", candidate: result.data };
}

export const bkAdapter: SourceAdapter<BkNotice> = {
  sourceId: BK_SOURCE_ID,
  allowedHosts: [BK_HOST],
  fetch: fetchAnnouncements,
  extract: extractAnnouncement,
  normalize: normalizeAnnouncement,
};
