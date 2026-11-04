import type { Kysely } from "kysely";
import type { BackupDirectoryState } from "./backup.js";
import type { Database } from "../infrastructure/db/schema.js";
import {
  countDeliveries,
  listSourceRunStates,
  listUnresolvedFailedDays,
  type DeliveryCounts,
  type FailedDay,
  type SourceRunState,
  type StatusRun,
} from "../infrastructure/db/status-repository.js";
import { addDays } from "../ingestion/catch-up.js";
import { DIGEST_LOCK_KEY, DIGEST_MAX_ATTEMPTS } from "../notifications/run.js";
import { warsawDay } from "../sources/normalize/warsaw-time.js";

/**
 * The operator's view of the system (`status`, PR-07A, D-028): evaluated from
 * the last ingestion runs and the delivery counts. Pure: the CLI reads the
 * database and sends the alert.
 */

/**
 * A source with no succeeded/incomplete run finished in this window is
 * stale: ingest runs daily, so one missed cycle plus slack (a late or slow
 * run) is still fine, two are not.
 */
export const STATUS_STALE_AFTER_MS = 36 * 60 * 60_000;

/**
 * The newest backup (BACKUP_DIR, PR-07B, D-029) may be this old. Tied to the
 * schedule of deploy/cron/radar (Polish time): `backup` at 05:30, `status` at
 * 06:30 and 07:45; the age is taken from the time in the file name (the start
 * of the dump).
 *
 * - One failed night is caught by the 07:45 `status`: the newest backup is then
 *   the previous day's 05:30, 26 h 15 min old. At 06:30 it is 25 h old, still
 *   ok — the first alert comes at 07:45.
 * - Without a failure no `status` sees more than about 24-25 h (a manual one
 *   just before the next 05:30, a slow or late dump; 25 h on the autumn DST
 *   day), so there is no false alarm.
 * - Known gap: on the spring DST day (a 23 h day) the 07:45 `status` sees only
 *   25 h 15 min. If only that night's backup fails and the next one succeeds,
 *   the failure is never reported; a second failed night in a row is caught
 *   at 06:30 the next day (48 h).
 * - Two failed nights in a row are caught already at 06:30 (49 h).
 *
 * Not the sources' 36 h (STATUS_STALE_AFTER_MS): 36 h would let one failed
 * night pass without an alert.
 */
export const BACKUP_STALE_AFTER_MS = 26 * 60 * 60_000;

export type StatusProblem =
  /** The source's last run failed, or a recent failed day is still not covered. */
  | "source_failed"
  /** Runs exist, but none succeeded within STATUS_STALE_AFTER_MS. */
  | "source_stale"
  /** An enabled source without any run. */
  | "source_never_run"
  /** No source is enabled: nothing is ingested. */
  | "no_enabled_sources"
  /** Deliveries with an unknown outcome wait for an operator decision (D-024). */
  | "deliveries_pending"
  /** Recent deliveries failed (retried by later runs, or with every attempt spent). */
  | "deliveries_failed"
  /** `status` itself could not read the database. */
  | "database_unavailable"
  /** Migrations are pending: the commands refuse to run until `migrate`. */
  | "schema_not_ready"
  /**
   * `status` failed unexpectedly (a bug); alerted with `--notify` with this
   * code only, never the error's text (it may carry configuration).
   */
  | "status_internal_error"
  /** BACKUP_DIR could not be read (missing, not a directory, no permission). */
  | "backup_dir_unreadable"
  /** BACKUP_DIR holds no backup file. */
  | "backup_missing"
  /** The newest backup file is older than BACKUP_STALE_AFTER_MS. */
  | "backup_stale";

/**
 * The backup check: never the directory's path (it is the operator's
 * configuration), only the outcome, the newest file's time and the count.
 */
export interface BackupStatus {
  readonly status: "ok" | "missing" | "stale" | "unreadable";
  readonly newestAt: Date | null;
  /** Null when the directory could not be read. */
  readonly files: number | null;
  /** The errno code of an unreadable directory. */
  readonly code: string | null;
}

export interface SourceStatus {
  readonly sourceId: string;
  readonly problems: readonly StatusProblem[];
  readonly lastRun: StatusRun | null;
  readonly lastSuccessAt: Date | null;
  readonly failedDays: readonly Omit<FailedDay, "sourceId">[];
}

export interface StatusReport {
  readonly status: "ok" | "problem";
  readonly checkedAt: Date;
  /** Distinct, in a fixed order. */
  readonly problems: readonly StatusProblem[];
  /** Null when the database could not be read. */
  readonly sources: readonly SourceStatus[] | null;
  readonly deliveries: (DeliveryCounts & { readonly failedSince: string }) | null;
  /** Of the database failure: a fixed reason and the SQLSTATE/errno code. */
  readonly database: { readonly reason: string; readonly code: string | null } | null;
  /** Absent when BACKUP_DIR is not set (no backup check). */
  readonly backup?: BackupStatus;
}

const PROBLEM_ORDER: readonly StatusProblem[] = [
  "status_internal_error",
  "database_unavailable",
  "schema_not_ready",
  "no_enabled_sources",
  "source_failed",
  "source_never_run",
  "source_stale",
  "deliveries_pending",
  "deliveries_failed",
  "backup_dir_unreadable",
  "backup_missing",
  "backup_stale",
];

function ordered(problems: Iterable<StatusProblem>): StatusProblem[] {
  const set = new Set(problems);
  return PROBLEM_ORDER.filter((problem) => set.has(problem));
}

/** The problems of one source. */
function sourceProblems(
  state: SourceRunState,
  failedDays: readonly FailedDay[],
  now: Date,
): StatusProblem[] {
  if (state.lastRun === null) return ["source_never_run"];
  const problems: StatusProblem[] = [];
  if (state.lastRun.status === "failed" || failedDays.length > 0) problems.push("source_failed");
  if (
    state.lastSuccessAt === null ||
    now.getTime() - state.lastSuccessAt.getTime() > STATUS_STALE_AFTER_MS
  ) {
    problems.push("source_stale");
  }
  return problems;
}

/** The report from what the database says. */
export function evaluateStatus(input: {
  readonly now: Date;
  readonly sources: readonly SourceRunState[];
  readonly failedDays: readonly FailedDay[];
  readonly deliveries: DeliveryCounts;
  readonly failedSince: string;
}): StatusReport {
  const sources = input.sources.map((state): SourceStatus => {
    const failedDays = input.failedDays.filter((day) => day.sourceId === state.sourceId);
    return {
      sourceId: state.sourceId,
      problems: sourceProblems(state, failedDays, input.now),
      lastRun: state.lastRun,
      lastSuccessAt: state.lastSuccessAt,
      failedDays: failedDays.map((day) => ({
        runId: day.runId,
        publicationDate: day.publicationDate,
        startedAt: day.startedAt,
        errorCode: day.errorCode,
      })),
    };
  });
  const problems: StatusProblem[] = sources.flatMap((source) => source.problems);
  if (sources.length === 0) problems.push("no_enabled_sources");
  const { deliveries } = input;
  // While a digest runs its claimed rows are pending until it records them.
  if (deliveries.pending > 0 && !deliveries.digestRunning) problems.push("deliveries_pending");
  if (deliveries.failed + deliveries.failedExhausted > 0) problems.push("deliveries_failed");
  const all = ordered(problems);
  return {
    status: all.length === 0 ? "ok" : "problem",
    checkedAt: input.now,
    problems: all,
    sources,
    deliveries: { ...deliveries, failedSince: input.failedSince },
    database: null,
  };
}

/**
 * Reads what `status` evaluates. Failed deliveries count from yesterday's
 * digest day on (Poland's calendar): the last two runs.
 */
export async function collectStatus(db: Kysely<Database>, now: Date): Promise<StatusReport> {
  const failedSince = addDays(warsawDay(now), -1);
  const sources = await listSourceRunStates(db);
  const failedDays = await listUnresolvedFailedDays(
    db,
    new Date(now.getTime() - STATUS_STALE_AFTER_MS),
  );
  const deliveries = await countDeliveries(db, {
    since: failedSince,
    maxAttempts: DIGEST_MAX_ATTEMPTS,
    digestLockKey: DIGEST_LOCK_KEY,
  });
  return evaluateStatus({ now, sources, failedDays, deliveries, failedSince });
}

/**
 * The report when the database could not be read, its schema is not
 * migrated, or `status` itself failed unexpectedly.
 */
export function failedStatus(
  now: Date,
  problem: "database_unavailable" | "schema_not_ready" | "status_internal_error",
  database: { readonly reason: string; readonly code: string | null } | null,
): StatusReport {
  return {
    status: "problem",
    checkedAt: now,
    problems: [problem],
    sources: null,
    deliveries: null,
    database,
  };
}

/** The report with the backup check of BACKUP_DIR added. */
export function withBackupCheck(
  report: StatusReport,
  directory: BackupDirectoryState,
): StatusReport {
  const backup: BackupStatus =
    directory.unreadableCode !== null
      ? { status: "unreadable", newestAt: null, files: null, code: directory.unreadableCode }
      : directory.newestAt === null
        ? { status: "missing", newestAt: null, files: directory.files, code: null }
        : {
            status:
              report.checkedAt.getTime() - directory.newestAt.getTime() > BACKUP_STALE_AFTER_MS
                ? "stale"
                : "ok",
            newestAt: directory.newestAt,
            files: directory.files,
            code: null,
          };
  const problem: StatusProblem | null =
    backup.status === "unreadable"
      ? "backup_dir_unreadable"
      : backup.status === "missing"
        ? "backup_missing"
        : backup.status === "stale"
          ? "backup_stale"
          : null;
  const problems = ordered(problem === null ? report.problems : [...report.problems, problem]);
  return {
    ...report,
    status: problems.length === 0 ? "ok" : "problem",
    problems,
    backup,
  };
}

function iso(value: Date | null): string {
  return value === null ? "brak" : value.toISOString();
}

/**
 * The operator alert: plain text in Polish with ids, statuses, error codes,
 * timestamps and counts only — never addresses, offer titles or profile
 * content (D-028). The subject carries the problem codes only.
 */
export function formatOperatorAlert(report: StatusReport): {
  readonly subject: string;
  readonly text: string;
} {
  const lines = [
    `Radar Zamówień — status: ${report.status}`,
    `Sprawdzono: ${report.checkedAt.toISOString()}`,
    // Every timestamp below is ISO 8601 in UTC, not Polish time.
    "Czasy w UTC.",
    `Problemy: ${report.problems.join(", ")}`,
    "",
  ];
  if (report.database !== null) {
    lines.push(
      `Baza danych: ${report.database.reason}${report.database.code === null ? "" : ` (${report.database.code})`}`,
      "",
    );
  }
  for (const source of report.sources ?? []) {
    if (source.problems.length === 0) continue;
    const run = source.lastRun;
    lines.push(`Źródło ${source.sourceId}: ${source.problems.join(", ")}`);
    lines.push(
      run === null
        ? "  ostatnie uruchomienie: brak"
        : `  ostatnie uruchomienie: ${run.runId} ${run.status} dzień ${run.publicationDate}, ` +
            `start ${run.startedAt.toISOString()}, koniec ${run.finishedAt.toISOString()}, ` +
            `kod błędu ${run.errorCode ?? "brak"}`,
    );
    lines.push(`  ostatni sukces: ${iso(source.lastSuccessAt)}`);
    for (const day of source.failedDays) {
      lines.push(
        `  nieudany dzień ${day.publicationDate}: ${day.runId}, start ${day.startedAt.toISOString()}, ` +
          `kod błędu ${day.errorCode ?? "brak"}`,
      );
    }
    lines.push("");
  }
  const { deliveries } = report;
  if (deliveries !== null) {
    lines.push(
      `Wysyłki: pending ${String(deliveries.pending)}` +
        (deliveries.digestRunning ? " (digest w toku)" : "") +
        `, failed od ${deliveries.failedSince}: ${String(deliveries.failed)} do ponowienia, ` +
        `${String(deliveries.failedExhausted)} bez dalszych prób` +
        (deliveries.failedErrorCodes.length === 0
          ? ""
          : `, kody: ${deliveries.failedErrorCodes.join(", ")}`),
      "",
    );
  }
  const { backup } = report;
  if (backup !== undefined) {
    lines.push(
      backup.status === "unreadable"
        ? `Kopia zapasowa: unreadable, katalog nieczytelny (${backup.code ?? "brak"})`
        : `Kopia zapasowa: ${backup.status}, najnowsza ${iso(backup.newestAt)}, ` +
            `plików ${String(backup.files ?? 0)}`,
      "",
    );
  }
  lines.push("Co zrobić: docs/RUNBOOK.md, sekcja „Alert statusu”.");
  return {
    subject: `Radar Zamówień: problem (${report.problems.join(", ")})`,
    text: `${lines.join("\n")}\n`,
  };
}
