import { sql, type Kysely } from "kysely";
import { DomainError } from "../domain/errors.js";
import {
  calendarDateSchema,
  type IngestionRunCounters,
  type IngestionRunStatus,
  type IngestionRunSummary,
} from "../domain/ingestion-run.js";
import { opportunityCandidateSchema } from "../domain/opportunity.js";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import { recordIngestionRun } from "../infrastructure/db/ingestion-runs-repository.js";
import { ingestOpportunity } from "../infrastructure/db/opportunities-repository.js";
import type { Database } from "../infrastructure/db/schema.js";
import { listEnabledSources, MAX_LIST_LIMIT } from "../infrastructure/db/sources-repository.js";
import { HttpClientError } from "../infrastructure/http/errors.js";
import type { Logger } from "../infrastructure/logger.js";
import {
  SourceFormatError,
  type IncompleteFetch,
  type RawDocument,
  type SourceAdapter,
  type SourceHttpClient,
} from "../sources/types.js";
import { contentHash, fingerprint } from "./fingerprint.js";
import { IngestLockLostError } from "./lock.js";

export interface IngestionDeps {
  readonly db: Kysely<Database>;
  readonly adapters: ReadonlyMap<string, SourceAdapter>;
  /** A fresh client per source run (its error budget and rate limit are per instance). */
  readonly createHttpClient: (adapter: SourceAdapter) => SourceHttpClient;
  /** Clock for `fetchedAt` and the run timestamps. */
  readonly now: () => Date;
  readonly logger: Logger;
  /** Upper bound on one source's run; combined with `signal`. */
  readonly sourceTimeoutMs: number;
  /**
   * Cancellation of the whole run (the ingest lock's signal): the source in
   * progress stops before its next request or write and fails (`lock_lost`
   * when the reason is IngestLockLostError, else `source_timeout`), and no
   * further source starts.
   */
  readonly signal?: AbortSignal;
}

export interface IngestionRequest {
  /** Explicit sources, each enabled in the database and supported; all enabled when absent. */
  readonly sourceIds?: readonly string[];
  /** Publication day to fetch, `YYYY-MM-DD`. */
  readonly publicationDate: string;
  /** Per part of a source (e.g. notice type), as in FetchContext. */
  readonly maxRecords: number;
}

/** One source's run as returned to the caller; `runId` is null when it could not be recorded. */
export interface IngestionRunResult extends IngestionRunSummary {
  readonly runId: string | null;
}

/**
 * The request names a source that is not enabled in the database or has no
 * adapter. Raised before anything is fetched; the message lists source ids.
 */
export class IngestionRequestError extends Error {
  override readonly name = "IngestionRequestError";
}

/** `ingestion_runs` does not exist yet: `migrate` has not been run since 0002. */
export class SchemaNotReadyError extends Error {
  override readonly name = "SchemaNotReadyError";

  constructor() {
    super("Database schema is not up to date (no ingestion_runs table); run `migrate` first.");
  }
}

/**
 * Failure codes stored in `ingestion_runs.error_code` besides the
 * HttpClientError codes: `invalid_document` (SourceFormatError),
 * `source_timeout` (per-source timeout or run cancellation), `lock_lost` (the
 * ingest lock's connection broke, src/ingestion/lock.ts), `database_error`
 * (a write failed for a reason other than a domain rule), `no_adapter`
 * (enabled in the database, unknown to this build) and `internal_error`.
 */
type IngestionErrorCode =
  | HttpClientError["code"]
  | "invalid_document"
  | "source_timeout"
  | "lock_lost"
  | "database_error"
  | "no_adapter"
  | "internal_error";

/** A write failed for a non-domain reason (connection, timeout, bug): the source run fails. */
class StoreError extends Error {
  override readonly name = "StoreError";

  constructor(options: { cause: unknown }) {
    super("Storing a record failed", options);
  }
}

type MutableCounters = { -readonly [K in keyof IngestionRunCounters]: number };

function emptyCounters(): MutableCounters {
  return { documents: 0, extracted: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0 };
}

function statusOf(
  errorCode: string | null,
  incomplete: readonly IncompleteFetch[],
): IngestionRunStatus {
  if (errorCode !== null) return "failed";
  return incomplete.length > 0 ? "incomplete" : "succeeded";
}

/**
 * Picks the sources to run, refusing an explicit request that names a source
 * which is not enabled in the database or has no adapter. By default every
 * enabled source runs; one without an adapter is reported as a failed run
 * (`no_adapter`), so the misconfiguration is visible but does not stop others.
 */
async function selectSources(
  deps: IngestionDeps,
  request: IngestionRequest,
): Promise<readonly string[]> {
  const enabled = (await listEnabledSources(deps.db, MAX_LIST_LIMIT)).map((source) => source.id);
  if (request.sourceIds === undefined) return enabled;
  const notEnabled = request.sourceIds.filter((id) => !enabled.includes(id));
  if (notEnabled.length > 0) {
    throw new IngestionRequestError(
      `Source not enabled in the database: ${notEnabled.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }
  const unsupported = request.sourceIds.filter((id) => !deps.adapters.has(id));
  if (unsupported.length > 0) {
    throw new IngestionRequestError(
      `Unknown source: ${unsupported.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }
  return request.sourceIds;
}

function classifyFailure(error: unknown, signal: AbortSignal): IngestionErrorCode {
  if (signal.aborted) {
    return signal.reason instanceof IngestLockLostError ? "lock_lost" : "source_timeout";
  }
  if (error instanceof HttpClientError) return error.code;
  if (error instanceof SourceFormatError) return "invalid_document";
  if (error instanceof StoreError) return "database_error";
  return "internal_error";
}

/**
 * Normalizes and stores the records of one document. Rejections (normalize or
 * a domain rule on write) are counted and logged with codes only; any other
 * write failure is a StoreError that fails the source run. Stops before the
 * next write once `signal` is aborted (timeout or lost lock): a write already
 * in flight is bounded by the statement/query timeouts, not by the signal.
 */
async function storeDocument(
  deps: IngestionDeps,
  adapter: SourceAdapter,
  doc: RawDocument,
  counters: MutableCounters,
  signal: AbortSignal,
): Promise<void> {
  const { logger } = deps;
  const sourceId = adapter.sourceId;
  counters.documents++;
  for (const notice of adapter.extract(doc)) {
    counters.extracted++;
    const normalized = adapter.normalize(notice);
    if (!normalized.ok) {
      counters.rejected++;
      logger.warn("source record rejected", {
        sourceId,
        externalId: normalized.externalId,
        reason: normalized.reason,
      });
      continue;
    }
    // Re-validated so the keys are always computed from canonical values,
    // whatever the adapter did (parsing a parsed candidate is idempotent).
    const parsed = opportunityCandidateSchema.safeParse(normalized.candidate);
    if (!parsed.success) {
      counters.rejected++;
      logger.warn("source record rejected", {
        sourceId,
        externalId: null,
        reason: "invalid candidate",
      });
      continue;
    }
    const candidate = parsed.data;
    signal.throwIfAborted();
    try {
      const { outcome } = await ingestOpportunity(deps.db, {
        ...candidate,
        fingerprint: fingerprint(candidate),
        contentHash: contentHash(candidate),
      });
      counters[outcome]++;
    } catch (error: unknown) {
      if (!(error instanceof DomainError)) throw new StoreError({ cause: error });
      counters.rejected++;
      // Code and constraint name only, never values.
      logger.warn("opportunity rejected", {
        sourceId,
        externalId: candidate.externalId,
        errorCode: error.code,
        constraint: error.constraint,
      });
    }
  }
}

/**
 * One source: fetch → extract → normalize → fingerprint/hash → store, one
 * document at a time (FetchContext.onDocument), so memory holds one page
 * (D-008). Never rejects: every failure becomes a `failed` summary with a
 * code; records stored before the failure stay stored.
 */
async function ingestSource(
  deps: IngestionDeps,
  request: IngestionRequest,
  sourceId: string,
): Promise<IngestionRunSummary> {
  const startedAt = deps.now();
  const counters = emptyCounters();
  let incomplete: readonly IncompleteFetch[] = [];
  let errorCode: IngestionErrorCode | null = null;

  const adapter = deps.adapters.get(sourceId);
  if (adapter === undefined) {
    errorCode = "no_adapter";
    deps.logger.error("source ingestion failed", { sourceId, errorCode, httpStatus: null });
  } else {
    const timeout = AbortSignal.timeout(deps.sourceTimeoutMs);
    const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
    try {
      const result = await adapter.fetch({
        http: deps.createHttpClient(adapter),
        signal,
        publicationDate: request.publicationDate,
        maxRecords: request.maxRecords,
        now: deps.now,
        logger: deps.logger,
        onDocument: (doc) => storeDocument(deps, adapter, doc, counters, signal),
      });
      // A streaming adapter returns no documents; any returned are stored too.
      for (const doc of result.documents) {
        await storeDocument(deps, adapter, doc, counters, signal);
      }
      incomplete = result.incomplete;
    } catch (error: unknown) {
      errorCode = classifyFailure(error, signal);
      deps.logger.error("source ingestion failed", {
        sourceId,
        errorCode,
        httpStatus: error instanceof HttpClientError ? error.status : null,
      });
    }
  }

  const finishedAt = deps.now();
  return {
    sourceId,
    publicationDate: request.publicationDate,
    maxRecords: request.maxRecords,
    status: statusOf(errorCode, incomplete),
    startedAt,
    // A clock step backwards must not make the record invalid.
    finishedAt: finishedAt < startedAt ? startedAt : finishedAt,
    counters: { ...counters },
    incomplete: [...incomplete],
    errorCode,
  };
}

/**
 * `ingest` (docs/ARCHITECTURE.md §6): runs the selected sources one after the
 * other, stores their records with change detection and records one
 * `ingestion_runs` row per source. A failing source never stops the others.
 *
 * Rejects only before anything is fetched: IngestionRequestError (bad
 * request), SchemaNotReadyError, or a database error while selecting sources. The caller must
 * hold the ingest lock (src/ingestion/lock.ts).
 */
export async function runIngestion(
  deps: IngestionDeps,
  request: IngestionRequest,
): Promise<IngestionRunResult[]> {
  if (!calendarDateSchema.safeParse(request.publicationDate).success) {
    throw new IngestionRequestError("publicationDate must be a calendar date YYYY-MM-DD");
  }
  if (!Number.isInteger(request.maxRecords) || request.maxRecords < 1) {
    throw new IngestionRequestError("maxRecords must be a positive integer");
  }
  // Checked before anything is fetched: without it every run record would
  // fail only after the source had been read. `ingest` never migrates by itself.
  const { rows } = await sql<{
    relation: string | null;
  }>`SELECT to_regclass('ingestion_runs')::text AS relation`.execute(deps.db);
  if ((rows[0]?.relation ?? null) === null) throw new SchemaNotReadyError();
  const sourceIds = await selectSources(deps, request);
  if (sourceIds.length === 0) deps.logger.warn("no enabled sources to ingest");

  const results: IngestionRunResult[] = [];
  for (const [index, sourceId] of sourceIds.entries()) {
    if (deps.signal?.aborted === true) {
      // Not started, so nothing to record; the caller reports the abort.
      deps.logger.warn("ingestion aborted, sources not run", {
        sourceIds: sourceIds.slice(index),
      });
      break;
    }
    const summary = await ingestSource(deps, request, sourceId);
    let runId: string | null = null;
    try {
      runId = await recordIngestionRun(deps.db, summary);
    } catch (error: unknown) {
      // The source's records are stored; only the run record is missing. The
      // caller reports the run as failed (exit 1). Code only, no error text:
      // it may quote values.
      deps.logger.error("ingestion run not recorded", {
        sourceId,
        errorCode: describeDatabaseFailure(error).code,
      });
    }
    deps.logger.info("source ingestion finished", {
      sourceId,
      runId,
      status: summary.status,
      durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
      ...summary.counters,
      incomplete: summary.incomplete,
      errorCode: summary.errorCode,
    });
    results.push({ ...summary, runId });
  }
  return results;
}

/**
 * The run as a whole: `failed` when any source failed or its run could not be
 * recorded, else `incomplete` when any source hit a limit, else `succeeded`.
 */
export function overallStatus(results: readonly IngestionRunResult[]): IngestionRunStatus {
  if (results.some((run) => run.status === "failed" || run.runId === null)) return "failed";
  return results.some((run) => run.status === "incomplete") ? "incomplete" : "succeeded";
}
