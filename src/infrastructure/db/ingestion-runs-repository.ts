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
 * The latest publication day `sourceId` has covered (`YYYY-MM-DD`), or null
 * when it has none: the day of a run that finished `succeeded` or
 * `incomplete` (a limit hit is not retried by catch-up, D-021) and started
 * after that day had ended (UTC) — a run of today, or of a day still in
 * progress, may have missed notices published later that day, so it never
 * hides the day from catch-up. Failed runs never count.
 */
export async function lastCoveredDay(
  db: Kysely<Database>,
  sourceId: string,
): Promise<string | null> {
  const result = await sql<{ day: string | null }>`
    SELECT max(publication_date)::text AS day
    FROM ingestion_runs
    WHERE source_id = ${sourceId}
      AND status IN ('succeeded', 'incomplete')
      AND started_at >= ((publication_date + 1)::timestamp AT TIME ZONE 'UTC')
  `.execute(db);
  return result.rows[0]?.day ?? null;
}
