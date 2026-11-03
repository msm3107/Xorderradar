import { sql, type Kysely } from "kysely";
import type { IngestionRunStatus } from "../../domain/ingestion-run.js";
import type { Database } from "./schema.js";

/**
 * Read-only queries of `status` (PR-07A, D-028): what the operator must know
 * about the last ingestion runs and the deliveries. Ids, statuses, codes,
 * timestamps and counts only — never addresses, titles or profile content.
 * No lock is taken; every result is bounded.
 */

/** Enabled sources read by one `status` run (there are a handful). */
export const STATUS_MAX_SOURCES = 100;
/** Unresolved failed days listed per run (each is one row of the report). */
export const STATUS_MAX_FAILED_DAYS = 50;

export interface StatusRun {
  readonly runId: string;
  readonly status: IngestionRunStatus;
  /** `YYYY-MM-DD`. */
  readonly publicationDate: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly errorCode: string | null;
}

export interface SourceRunState {
  readonly sourceId: string;
  /** The run started last, any status; null when the source never ran. */
  readonly lastRun: StatusRun | null;
  /** When the last `succeeded` or `incomplete` run finished; null when none did. */
  readonly lastSuccessAt: Date | null;
}

/** A failed run of a day that no later succeeded/incomplete run of the source covered. */
export interface FailedDay {
  readonly sourceId: string;
  readonly runId: string;
  /** `YYYY-MM-DD`. */
  readonly publicationDate: string;
  readonly startedAt: Date;
  readonly errorCode: string | null;
}

/** Per enabled source, by id: its last run and its last successful run. */
export async function listSourceRunStates(db: Kysely<Database>): Promise<SourceRunState[]> {
  const { rows } = await sql<{
    source_id: string;
    run_id: string | null;
    status: IngestionRunStatus | null;
    publication_date: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    error_code: string | null;
    last_success_at: Date | null;
  }>`
    SELECT
      s.id AS source_id,
      last.id AS run_id,
      last.status,
      to_char(last.publication_date, 'YYYY-MM-DD') AS publication_date,
      last.started_at,
      last.finished_at,
      last.error_code,
      (
        SELECT max(ok.finished_at)
        FROM ingestion_runs ok
        WHERE ok.source_id = s.id AND ok.status IN ('succeeded', 'incomplete')
      ) AS last_success_at
    FROM sources s
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.publication_date, r.started_at, r.finished_at, r.error_code
      FROM ingestion_runs r
      WHERE r.source_id = s.id
      ORDER BY r.started_at DESC, r.finished_at DESC, r.id DESC
      LIMIT 1
    ) last ON true
    WHERE s.enabled
    ORDER BY s.id
    LIMIT ${STATUS_MAX_SOURCES}
  `.execute(db);
  return rows.map((row) => ({
    sourceId: row.source_id,
    lastRun:
      row.run_id === null ||
      row.status === null ||
      row.publication_date === null ||
      row.started_at === null ||
      row.finished_at === null
        ? null
        : {
            runId: row.run_id,
            status: row.status,
            publicationDate: row.publication_date,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            errorCode: row.error_code,
          },
    lastSuccessAt: row.last_success_at,
  }));
}

/**
 * Failed runs of enabled sources started at or after `since` whose day was
 * not covered by a later `succeeded` or `incomplete` run of the same source
 * (catch-up retries a failed day, D-021): the newest failed run per source
 * and day, by source then day.
 */
export async function listUnresolvedFailedDays(
  db: Kysely<Database>,
  since: Date,
): Promise<FailedDay[]> {
  const { rows } = await sql<{
    source_id: string;
    run_id: string;
    publication_date: string;
    started_at: Date;
    error_code: string | null;
  }>`
    SELECT source_id, run_id, publication_date, started_at, error_code
    FROM (
      SELECT DISTINCT ON (f.source_id, f.publication_date)
        f.source_id,
        f.id AS run_id,
        to_char(f.publication_date, 'YYYY-MM-DD') AS publication_date,
        f.started_at,
        f.error_code
      FROM ingestion_runs f
      JOIN sources s ON s.id = f.source_id AND s.enabled
      WHERE f.status = 'failed'
        AND f.started_at >= ${since}
        AND NOT EXISTS (
          SELECT 1
          FROM ingestion_runs ok
          WHERE ok.source_id = f.source_id
            AND ok.publication_date = f.publication_date
            AND ok.status IN ('succeeded', 'incomplete')
            AND ok.started_at > f.started_at
        )
      ORDER BY f.source_id, f.publication_date, f.started_at DESC, f.id DESC
    ) failed
    ORDER BY source_id, publication_date
    LIMIT ${STATUS_MAX_FAILED_DAYS}
  `.execute(db);
  return rows.map((row) => ({
    sourceId: row.source_id,
    runId: row.run_id,
    publicationDate: row.publication_date,
    startedAt: row.started_at,
    errorCode: row.error_code,
  }));
}

export interface DeliveryCounts {
  /** Every `pending` row: claimed, outcome unknown (D-024). */
  readonly pending: number;
  /** `failed` rows of a digest day >= `since` that later runs still retry. */
  readonly failed: number;
  /** `failed` rows of a digest day >= `since` with every attempt spent. */
  readonly failedExhausted: number;
  /** The distinct error codes of those failed rows, sorted. */
  readonly failedErrorCodes: string[];
  /**
   * Whether a `digest` run holds its advisory lock right now (another
   * session; read from pg_locks, nothing is locked): its claimed rows are
   * `pending` until it records the outcome.
   */
  readonly digestRunning: boolean;
}

/** The bigint advisory-lock key as pg_locks shows it (classid: high, objid: low 32 bits). */
function lockParts(key: number): { readonly high: string; readonly low: string } {
  const value = BigInt(key);
  return { high: String(value >> 32n), low: String(value & 0xffff_ffffn) };
}

/**
 * Delivery counts for `status`. A failed row's digest_date is the day of its
 * last attempt (a retry claim moves it), so `since` keeps the alert to recent
 * failures: an offer no longer qualifying stays failed forever (D-024).
 */
export async function countDeliveries(
  db: Kysely<Database>,
  options: { readonly since: string; readonly maxAttempts: number; readonly digestLockKey: number },
): Promise<DeliveryCounts> {
  const { since, maxAttempts } = options;
  const lock = lockParts(options.digestLockKey);
  const { rows } = await sql<{
    pending: string;
    failed: string;
    failed_exhausted: string;
    failed_error_codes: string[] | null;
    digest_running: boolean;
  }>`
    SELECT
      count(*) FILTER (WHERE status = 'pending') AS pending,
      count(*) FILTER (
        WHERE status = 'failed' AND digest_date >= ${since}::date AND attempts < ${maxAttempts}
      ) AS failed,
      count(*) FILTER (
        WHERE status = 'failed' AND digest_date >= ${since}::date AND attempts >= ${maxAttempts}
      ) AS failed_exhausted,
      array_agg(DISTINCT error_code ORDER BY error_code) FILTER (
        WHERE status = 'failed' AND digest_date >= ${since}::date AND error_code IS NOT NULL
      ) AS failed_error_codes,
      EXISTS (
        SELECT 1
        FROM pg_locks l
        WHERE l.locktype = 'advisory'
          AND l.granted
          AND l.objsubid = 1
          AND l.classid = ${lock.high}::bigint::oid
          AND l.objid = ${lock.low}::bigint::oid
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.pid <> pg_backend_pid()
      ) AS digest_running
    FROM deliveries
  `.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error("count query returned no row");
  return {
    // count(*) is bigint, which `pg` returns as text.
    pending: Number(row.pending),
    failed: Number(row.failed),
    failedExhausted: Number(row.failed_exhausted),
    failedErrorCodes: row.failed_error_codes ?? [],
    digestRunning: row.digest_running,
  };
}
