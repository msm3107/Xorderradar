import { z } from "zod";
import { sourceIdSchema } from "./source.js";

/**
 * Why a source listing was not read to its natural end: a run limit was
 * reached or pagination could not continue safely. More records may exist.
 */
export const incompleteReasons = [
  "max_records",
  "max_pages",
  "invalid_cursor",
  "repeated_cursor",
] as const;
export type IncompleteReason = (typeof incompleteReasons)[number];

export const ingestionRunStatuses = ["succeeded", "incomplete", "failed"] as const;
export type IngestionRunStatus = (typeof ingestionRunStatuses)[number];

/** `YYYY-MM-DD` naming a real calendar day (2026-02-30 is refused). */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "must be a real calendar day");

/**
 * A short machine-readable failure code (e.g. `http_status`,
 * `invalid_document`) — never a message, so nothing from a response or the
 * environment can end up in storage. Mirrors `ingestion_runs_error_code_check`.
 */
export const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const counter = z.int().min(0);

export const ingestionRunCountersSchema = z.strictObject({
  /** Documents (pages) fetched and processed. */
  documents: counter,
  /** Records extracted from those documents. */
  extracted: counter,
  inserted: counter,
  updated: counter,
  unchanged: counter,
  /** Refused by normalize or by a domain rule on write. */
  rejected: counter,
  /**
   * Read and valid but deliberately not applied, e.g. a notice update with
   * nothing to apply or without a stored original (logged with a reason code).
   */
  skipped: counter,
});

export type IngestionRunCounters = z.output<typeof ingestionRunCountersSchema>;

/** One source's part of an `ingest` run, as stored in `ingestion_runs`. */
export const ingestionRunSummarySchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    publicationDate: calendarDateSchema,
    maxRecords: z.int().min(1),
    status: z.enum(ingestionRunStatuses),
    startedAt: z.date(),
    finishedAt: z.date(),
    counters: ingestionRunCountersSchema,
    incomplete: z
      .array(
        z.strictObject({ part: z.string().min(1).max(100), reason: z.enum(incompleteReasons) }),
      )
      .max(100),
    errorCode: errorCodeSchema.nullable(),
  })
  .refine((run) => run.finishedAt.getTime() >= run.startedAt.getTime(), {
    message: "finishedAt must not be before startedAt",
    path: ["finishedAt"],
  })
  .refine((run) => (run.status === "failed") === (run.errorCode !== null), {
    message: "errorCode is set exactly when the run failed",
    path: ["errorCode"],
  });

export type IngestionRunSummary = z.output<typeof ingestionRunSummarySchema>;
