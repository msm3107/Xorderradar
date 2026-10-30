import type { OpportunityCandidate } from "../domain/opportunity.js";
import type { GetOptions, HttpResponse } from "../infrastructure/http/safe-http-client.js";
import type { Logger } from "../infrastructure/logger.js";

/**
 * The part of SafeHttpClient an adapter uses. Production code always passes a
 * real SafeHttpClient (the only route to the network, docs/SECURITY.md §2–§6);
 * the narrow interface lets tests pass a scripted fake.
 */
export interface SourceHttpClient {
  /** Rejects with HttpClientError (e.g. `http_status`, `timeout`, `aborted`). */
  get(url: string | URL, options?: GetOptions): Promise<HttpResponse>;
}

/** Everything `fetch` may use; adapters have no other access to the outside world. */
export interface FetchContext {
  readonly http: SourceHttpClient;
  /** Run-level timeout/cancellation; passed to every request. */
  readonly signal: AbortSignal;
  /** Publication day to fetch, `YYYY-MM-DD` (already validated by the caller). */
  readonly publicationDate: string;
  /**
   * Upper bound on records fetched per part of the source (e.g. per notice
   * type), positive integer; each part has its own budget, so one busy part
   * cannot starve the others.
   */
  readonly maxRecords: number;
  /** Clock for `RawDocument.fetchedAt`. */
  readonly now: () => Date;
  readonly logger: Logger;
}

/** One fetched response, kept in memory only (D-008). */
export interface RawDocument {
  readonly sourceId: string;
  /** Final request URL; may contain a query, so it is not logged. */
  readonly url: string;
  readonly fetchedAt: Date;
  readonly contentType: string | null;
  /** Response body decoded as text. */
  readonly body: string;
}

/**
 * Why a listing was not read to its natural end: a run limit was reached or
 * pagination could not continue safely. More records may exist.
 */
export type IncompleteReason = "max_records" | "max_pages" | "invalid_cursor" | "repeated_cursor";

export interface IncompleteFetch {
  /** Which part of the source was cut short (e.g. a notice type). */
  readonly part: string;
  readonly reason: IncompleteReason;
}

export interface FetchResult {
  readonly documents: readonly RawDocument[];
  /** Empty when every part was read to its end; reaching a limit is never silent. */
  readonly incomplete: readonly IncompleteFetch[];
}

export type NormalizeResult =
  | { readonly ok: true; readonly candidate: OpportunityCandidate }
  | {
      readonly ok: false;
      /** Identifier from the source when it could be read, for the log. */
      readonly externalId: string | null;
      /** Fixed text naming fields only, never source values (safe to log and group by). */
      readonly reason: string;
    };

/**
 * One public source (docs/ARCHITECTURE.md §4.1): `fetch → extract → normalize`.
 * `extract` and `normalize` are pure and deterministic, so they are tested on
 * fixtures without the network. `TNotice` is the adapter's extracted record.
 */
export interface SourceAdapter<TNotice = unknown> {
  /** Stable identifier (sourceIdSchema), e.g. `bzp`. */
  readonly sourceId: string;
  /** The only hosts the adapter's SafeHttpClient may connect to. */
  readonly allowedHosts: readonly string[];
  /** Rejects with HttpClientError or SourceFormatError; never returns partial data silently. */
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /** Throws SourceFormatError when the document as a whole is unusable. */
  extract(doc: RawDocument): TNotice[];
  /** A problem with one record is a rejection, never an exception. */
  normalize(notice: TNotice): NormalizeResult;
}

/**
 * A fetched document that cannot be read at all (not UTF-8, not JSON, not the
 * expected structure, too many records). The message names the source and a
 * fixed reason only — never document content.
 */
export class SourceFormatError extends Error {
  override readonly name = "SourceFormatError";

  constructor(
    readonly sourceId: string,
    readonly reason: string,
  ) {
    super(`${sourceId}: unusable source document (${reason})`);
  }
}
