import { sql, type Kysely } from "kysely";
import { parseDomain } from "../../domain/common.js";
import { ingestionRunSummarySchema, type IngestionRunSummary } from "../../domain/ingestion-run.js";
import { withDomainErrors } from "./errors.js";
import type { Database } from "./schema.js";

/**
 * Stores one source's part of an `ingest` run (one row, insert only) and
 * returns its id. Refusals are DomainErrors: invalid summary
 * (`invalid_input`), unregistered source (`unknown_reference`), a CHECK the
 * schema missed (`constraint_violation`).
 */
export async function recordIngestionRun(
  db: Kysely<Database>,
  input: IngestionRunSummary,
): Promise<string> {
  const run = parseDomain(ingestionRunSummarySchema, input);
  const row = await withDomainErrors(() =>
    db
      .insertInto("ingestion_runs")
      .values({
        source_id: run.sourceId,
        publication_date: run.publicationDate,
        max_records: run.maxRecords,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        status: run.status,
        documents: run.counters.documents,
        extracted: run.counters.extracted,
        inserted: run.counters.inserted,
        updated: run.counters.updated,
        unchanged: run.counters.unchanged,
        rejected: run.counters.rejected,
        skipped: run.counters.skipped,
        incomplete: JSON.stringify(run.incomplete),
        error_code: run.errorCode,
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/**
 * What planning needs to know about `sourceId` (D-021), in one query: its
 * covered days and its attempted days (any run, any status) within `window`
 * (both included, so each at most the window's length), its latest covered
 * day and the earliest day of any of its runs. The result is bounded to the
 * window; the query still scans the source's rows for the min/max. Days are
 * `YYYY-MM-DD` whatever the session's DateStyle.
 * A day is covered by a run that finished `succeeded` or `incomplete` (a
 * limit hit is not retried by catch-up) and started after that day had ended
 * (UTC) — a run of today, or of a day still in progress, may have missed
 * notices published later that day, so it never hides the day from catch-up.
 * Failed runs never cover a day.
 */
export async function catchUpHistory(
  db: Kysely<Database>,
  sourceId: string,
  window: { readonly from: string; readonly to: string },
): Promise<{
  /** Covered days within the window, ascending. */
  covered: string[];
  /** Days within the window with any run of the source (covered or not), ascending. */
  attempted: string[];
  latestCovered: string | null;
  earliestAttempted: string | null;
}> {
  const result = await sql<{
    covered: string[] | null;
    attempted: string[] | null;
    latest_covered: string | null;
    earliest_attempted: string | null;
  }>`
    WITH runs AS (
      SELECT
        publication_date,
        to_char(publication_date, 'YYYY-MM-DD') AS day,
        publication_date BETWEEN ${window.from}::date AND ${window.to}::date AS in_window,
        status IN ('succeeded', 'incomplete')
          AND started_at >= ((publication_date + 1)::timestamp AT TIME ZONE 'UTC') AS covers
      FROM ingestion_runs
      WHERE source_id = ${sourceId}
    )
    SELECT
      array_agg(DISTINCT day ORDER BY day) FILTER (WHERE covers AND in_window) AS covered,
      array_agg(DISTINCT day ORDER BY day) FILTER (WHERE in_window) AS attempted,
      to_char(max(publication_date) FILTER (WHERE covers), 'YYYY-MM-DD') AS latest_covered,
      to_char(min(publication_date), 'YYYY-MM-DD') AS earliest_attempted
    FROM runs
  `.execute(db);
  const row = result.rows[0];
  return {
    covered: row?.covered ?? [],
    attempted: row?.attempted ?? [],
    latestCovered: row?.latest_covered ?? null,
    earliestAttempted: row?.earliest_attempted ?? null,
  };
}
