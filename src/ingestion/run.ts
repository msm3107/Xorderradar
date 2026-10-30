import type { Kysely } from "kysely";
import { DomainError } from "../domain/errors.js";
import {
  type IngestionRunCounters,
  type IngestionRunStatus,
  type IngestionRunSummary,
} from "../domain/ingestion-run.js";
import { noticeUpdateSchema, type NoticeUpdate } from "../domain/notice-update.js";
import { opportunityCandidateSchema } from "../domain/opportunity.js";
import { pendingMigrations } from "../infrastructure/db/database.js";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import {
  lastCoveredDay,
  recordIngestionRun,
} from "../infrastructure/db/ingestion-runs-repository.js";
import {
  applyDeadlineUpdate,
  ingestOpportunity,
} from "../infrastructure/db/opportunities-repository.js";
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
import {
  catchUpDays,
  daySpan,
  daysBetween,
  INGEST_MAX_DAY,
  INGEST_MAX_DAYS,
  INGEST_MIN_DAY,
  isIngestDay,
  yesterdayUtc,
} from "./catch-up.js";
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
  /** Upper bound on one source's run for one day; combined with `signal`. */
  readonly sourceTimeoutMs: number;
  /**
   * Cancellation of the whole run (the ingest lock's signal): the source in
   * progress stops before its next request or write and fails (`lock_lost`
   * when the reason is IngestLockLostError, else `source_timeout`), and no
   * further source starts.
   */
  readonly signal?: AbortSignal;
}

/**
 * The publication days to fetch (D-021): an explicit range (`YYYY-MM-DD`,
 * both included, at most INGEST_MAX_DAYS days; one day is from = to), or
 * catch-up — per source, the days since the last day it covered up to
 * yesterday (UTC), computed from `ingestion_runs` once the run holds the lock.
 */
export type IngestionDays =
  | { readonly mode: "range"; readonly from: string; readonly to: string }
  | { readonly mode: "catch_up" };

export interface IngestionRequest {
  /** Explicit sources, each enabled in the database and supported; all enabled when absent. */
  readonly sourceIds?: readonly string[];
  readonly days: IngestionDays;
  /** Per part of a source (e.g. notice type) and day, as in FetchContext. */
  readonly maxRecords: number;
}

/** One source's run for one day; `runId` is null when it could not be recorded. */
export interface IngestionRunResult extends IngestionRunSummary {
  readonly runId: string | null;
}

/**
 * A planned day of a source that did not run (nothing fetched, no
 * `ingestion_runs` row): an earlier day of the same source failed (days run
 * in order, so catch-up resumes from the failed day next time), or the run
 * was aborted (lost lock).
 */
export interface NotRunDay {
  readonly sourceId: string;
  readonly publicationDate: string;
  readonly reason: "previous_day_failed" | "aborted";
}

/**
 * Missing days catch-up left out for a source (more than INGEST_MAX_DAYS):
 * `from`…`to`, both included.
 */
export interface ClippedDays {
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
}

export interface IngestionOutcome {
  /** In run order: source by source, days ascending. */
  readonly runs: readonly IngestionRunResult[];
  readonly notRun: readonly NotRunDay[];
  readonly clipped: readonly ClippedDays[];
  /** The first and last planned day over all sources; null when no day was planned. */
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * The request names a source that is not enabled in the database or has no
 * adapter. Raised before anything is fetched; the message lists source ids.
 */
export class IngestionRequestError extends Error {
  override readonly name = "IngestionRequestError";
}

/** The database has pending migrations (pendingMigrations): `migrate` has not been run. */
export class SchemaNotReadyError extends Error {
  override readonly name = "SchemaNotReadyError";

  constructor() {
    super("Database schema is not up to date (pending migrations); run `migrate` first.");
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
  return {
    documents: 0,
    extracted: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    skipped: 0,
  };
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
 * Applies one notice update (D-015): its new offer deadline goes to the
 * original notice of its tenderId. An update with nothing to apply — no
 * tenderId, no deadline change, no original stored, a later update already
 * applied — is counted as `skipped` and logged at info with a fixed reason;
 * the same update applied again is `unchanged`.
 */
async function storeNoticeUpdate(
  deps: IngestionDeps,
  sourceId: string,
  input: NoticeUpdate,
  counters: MutableCounters,
  signal: AbortSignal,
): Promise<void> {
  const { logger } = deps;
  // Re-validated as candidates are; an update must also belong to the source
  // being run, as it changes that source's rows.
  const parsed = noticeUpdateSchema.safeParse(input);
  if (!parsed.success || parsed.data.sourceId !== sourceId) {
    counters.rejected++;
    logger.warn("source record rejected", {
      sourceId,
      externalId: null,
      reason: "invalid notice update",
    });
    return;
  }
  const update = parsed.data;
  const skip = (reason: string) => {
    counters.skipped++;
    logger.info("notice update skipped", {
      sourceId,
      externalId: update.externalId,
      tenderId: update.tenderId,
      reason,
    });
  };
  if (update.tenderId === null) {
    skip("no_tender_id");
    return;
  }
  if (update.change.kind === "none") {
    skip(update.change.reason);
    return;
  }
  const { deadline } = update.change;
  signal.throwIfAborted();
  try {
    const result = await applyDeadlineUpdate(deps.db, {
      sourceId,
      tenderId: update.tenderId,
      updateNotice: update.externalId,
      updatePublishedAt: update.publishedAt,
      deadline,
      // The rule adapters apply to a fetched notice's deadline.
      status: deadline.getTime() > update.fetchedAt.getTime() ? "open" : "closed",
    });
    if (result.outcome === "skipped") {
      skip(result.reason);
      return;
    }
    counters[result.outcome]++;
  } catch (error: unknown) {
    if (!(error instanceof DomainError)) throw new StoreError({ cause: error });
    counters.rejected++;
    logger.warn("notice update rejected", {
      sourceId,
      externalId: update.externalId,
      errorCode: error.code,
      constraint: error.constraint,
    });
  }
}

/**
 * Normalizes and stores the records of one document: opportunities with
 * change detection, notice updates applied to their original. Every
 * extracted record ends up in exactly one counter (extracted = inserted +
 * updated + unchanged + rejected + skipped). Rejections (normalize or a
 * domain rule on write) are counted and logged with codes only; any other
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
    switch (normalized.kind) {
      case "notice_update":
        await storeNoticeUpdate(deps, sourceId, normalized.update, counters, signal);
        break;
      case "opportunity":
        await storeOpportunity(deps, sourceId, normalized.candidate, counters, signal);
        break;
    }
  }
}

async function storeOpportunity(
  deps: IngestionDeps,
  sourceId: string,
  input: unknown,
  counters: MutableCounters,
  signal: AbortSignal,
): Promise<void> {
  const { logger } = deps;
  // Re-validated so the keys are always computed from canonical values,
  // whatever the adapter did (parsing a parsed candidate is idempotent).
  const parsed = opportunityCandidateSchema.safeParse(input);
  if (!parsed.success) {
    counters.rejected++;
    logger.warn("source record rejected", {
      sourceId,
      externalId: null,
      reason: "invalid candidate",
    });
    return;
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

/**
 * One source and one publication day: fetch → extract → normalize →
 * fingerprint/hash → store, one document at a time (FetchContext.onDocument),
 * so memory holds one page (D-008). Never rejects: every failure becomes a
 * `failed` summary with a code; records stored before the failure stay stored.
 */
async function ingestSource(
  deps: IngestionDeps,
  sourceId: string,
  publicationDate: string,
  maxRecords: number,
): Promise<IngestionRunSummary> {
  const startedAt = deps.now();
  const counters = emptyCounters();
  let incomplete: readonly IncompleteFetch[] = [];
  let errorCode: IngestionErrorCode | null = null;

  const adapter = deps.adapters.get(sourceId);
  if (adapter === undefined) {
    errorCode = "no_adapter";
    deps.logger.error("source ingestion failed", {
      sourceId,
      publicationDate,
      errorCode,
      httpStatus: null,
    });
  } else {
    const timeout = AbortSignal.timeout(deps.sourceTimeoutMs);
    const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
    try {
      const result = await adapter.fetch({
        http: deps.createHttpClient(adapter),
        signal,
        publicationDate,
        maxRecords,
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
        publicationDate,
        errorCode,
        httpStatus: error instanceof HttpClientError ? error.status : null,
      });
    }
  }

  const finishedAt = deps.now();
  return {
    sourceId,
    publicationDate,
    maxRecords,
    status: statusOf(errorCode, incomplete),
    startedAt,
    // A clock step backwards must not make the record invalid.
    finishedAt: finishedAt < startedAt ? startedAt : finishedAt,
    counters: { ...counters },
    incomplete: [...incomplete],
    errorCode,
  };
}

interface SourcePlan {
  readonly sourceId: string;
  readonly days: readonly string[];
}

/** Checks an explicit range; IngestionRequestError when it is not a valid one. */
function validateDays(days: IngestionDays): void {
  if (days.mode === "catch_up") return;
  if (!isIngestDay(days.from) || !isIngestDay(days.to)) {
    throw new IngestionRequestError(
      `from and to must be calendar dates YYYY-MM-DD from ${INGEST_MIN_DAY} to ${INGEST_MAX_DAY}`,
    );
  }
  if (days.from > days.to) throw new IngestionRequestError("from must not be after to");
  // Counted, never listed: a wide range is refused without building it.
  if (daySpan(days.from, days.to) > INGEST_MAX_DAYS) {
    throw new IngestionRequestError(`a range covers at most ${String(INGEST_MAX_DAYS)} days`);
  }
}

/**
 * The days each source runs. Catch-up reads `ingestion_runs`, so it must run
 * under the ingest lock (no other run can record a day meanwhile); clipped
 * days are logged and returned.
 */
async function planDays(
  deps: IngestionDeps,
  days: IngestionDays,
  sourceIds: readonly string[],
): Promise<{ plans: SourcePlan[]; clipped: ClippedDays[] }> {
  if (days.mode === "range") {
    const range = daysBetween(days.from, days.to);
    return { plans: sourceIds.map((sourceId) => ({ sourceId, days: range })), clipped: [] };
  }
  const yesterday = yesterdayUtc(deps.now());
  const plans: SourcePlan[] = [];
  const clipped: ClippedDays[] = [];
  for (const sourceId of sourceIds) {
    const lastCovered = await lastCoveredDay(deps.db, sourceId);
    const plan = catchUpDays(lastCovered, yesterday, INGEST_MAX_DAYS);
    if (plan.clipped !== null) {
      clipped.push({ sourceId, ...plan.clipped });
      deps.logger.warn("catch-up clipped, older missing days not run", {
        sourceId,
        lastCovered,
        ...plan.clipped,
        maxDays: INGEST_MAX_DAYS,
      });
    }
    if (plan.days.length === 0) {
      deps.logger.info("nothing to catch up", { sourceId, lastCovered });
    }
    plans.push({ sourceId, days: plan.days });
  }
  return { plans, clipped };
}

/**
 * `ingest` (docs/ARCHITECTURE.md §6): runs the selected sources one after the
 * other, each over its publication days in ascending order, stores their
 * records with change detection and records one `ingestion_runs` row per
 * source and day. A failing source never stops the others; a failing day
 * stops the later days of its source (they are returned as `notRun`, so
 * catch-up retries from the failed day).
 *
 * Rejects only before anything is fetched: IngestionRequestError (bad
 * request), SchemaNotReadyError, or a database error while selecting sources
 * or planning days. The caller must hold the ingest lock
 * (src/ingestion/lock.ts).
 */
export async function runIngestion(
  deps: IngestionDeps,
  request: IngestionRequest,
): Promise<IngestionOutcome> {
  validateDays(request.days);
  if (!Number.isInteger(request.maxRecords) || request.maxRecords < 1) {
    throw new IngestionRequestError("maxRecords must be a positive integer");
  }
  // Checked before anything is fetched: without it every write (or run record)
  // would fail only after the source had been read. The same check as
  // `health`; `ingest` never migrates by itself.
  if ((await pendingMigrations(deps.db)).length > 0) throw new SchemaNotReadyError();
  const sourceIds = await selectSources(deps, request);
  if (sourceIds.length === 0) deps.logger.warn("no enabled sources to ingest");
  const { plans, clipped } = await planDays(deps, request.days, sourceIds);
  const planned = plans.flatMap((plan) => plan.days).sort();

  const runs: IngestionRunResult[] = [];
  const notRun: NotRunDay[] = [];
  for (const { sourceId, days } of plans) {
    let blocked: NotRunDay["reason"] | null = null;
    for (const publicationDate of days) {
      if (blocked === null && deps.signal?.aborted === true) blocked = "aborted";
      if (blocked !== null) {
        notRun.push({ sourceId, publicationDate, reason: blocked });
        continue;
      }
      const run = await runDay(deps, sourceId, publicationDate, request.maxRecords);
      runs.push(run);
      if (run.status === "failed" || run.runId === null) blocked = "previous_day_failed";
    }
  }

  const aborted = notRun.filter((day) => day.reason === "aborted");
  if (aborted.length > 0) {
    // Not started, so nothing to record; the caller reports the abort.
    deps.logger.warn("ingestion aborted, sources not run", {
      sourceIds: [...new Set(aborted.map((day) => day.sourceId))],
      days: aborted.length,
    });
  }
  const afterFailure = notRun.filter((day) => day.reason === "previous_day_failed");
  if (afterFailure.length > 0) {
    deps.logger.warn("days not run after a failed day", {
      sourceIds: [...new Set(afterFailure.map((day) => day.sourceId))],
      days: afterFailure.length,
    });
  }
  return {
    runs,
    notRun,
    clipped,
    from: planned[0] ?? null,
    to: planned.at(-1) ?? null,
  };
}

/** Runs and records one source's day. */
async function runDay(
  deps: IngestionDeps,
  sourceId: string,
  publicationDate: string,
  maxRecords: number,
): Promise<IngestionRunResult> {
  const summary = await ingestSource(deps, sourceId, publicationDate, maxRecords);
  let runId: string | null = null;
  try {
    runId = await recordIngestionRun(deps.db, summary);
  } catch (error: unknown) {
    // The source's records are stored; only the run record is missing. The
    // caller reports the run as failed (exit 1). Code only, no error text:
    // it may quote values.
    deps.logger.error("ingestion run not recorded", {
      sourceId,
      publicationDate,
      errorCode: describeDatabaseFailure(error).code,
    });
  }
  deps.logger.info("source ingestion finished", {
    sourceId,
    publicationDate,
    runId,
    status: summary.status,
    durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
    ...summary.counters,
    incomplete: summary.incomplete,
    errorCode: summary.errorCode,
  });
  return { ...summary, runId };
}

/**
 * The run as a whole: `failed` when any source failed or its run could not be
 * recorded, else `incomplete` when any source hit a limit, else `succeeded`.
 */
export function overallStatus(results: readonly IngestionRunResult[]): IngestionRunStatus {
  if (results.some((run) => run.status === "failed" || run.runId === null)) return "failed";
  return results.some((run) => run.status === "incomplete") ? "incomplete" : "succeeded";
}
