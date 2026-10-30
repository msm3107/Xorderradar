import type { Kysely } from "kysely";
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
        incomplete: JSON.stringify(run.incomplete),
        error_code: run.errorCode,
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}
