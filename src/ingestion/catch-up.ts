/**
 * Which publication days one `ingest` run covers (D-021). Pure functions over
 * calendar days `YYYY-MM-DD` (UTC, as the default day of `ingest` has been
 * since PR-03A).
 */

/**
 * The most days one run covers, explicit range or catch-up: a month of
 * missed cron runs. Worst case one run takes this many days × the
 * per-source timeout per source (31 × 10 min for BZP).
 */
export const INGEST_MAX_DAYS = 31;

/**
 * Publication days `ingest` accepts: years 2000–2999. Far outside any real
 * publication day, and keeps every day a plain 4-digit `YYYY-MM-DD` (past
 * 9999 `toISOString` switches to `+010000-…`, which no longer orders as text).
 */
export const INGEST_MIN_DAY = "2000-01-01";
export const INGEST_MAX_DAY = "2999-12-31";

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * A real calendar day `YYYY-MM-DD` (2026-02-30 is refused, not rolled over)
 * within INGEST_MIN_DAY…INGEST_MAX_DAY.
 */
export function isIngestDay(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    value >= INGEST_MIN_DAY &&
    value <= INGEST_MAX_DAY
  );
}

/**
 * How many days `from`…`to` covers, both included, computed without listing
 * them (0 or negative when from > to). For valid days only.
 */
export function daySpan(from: string, to: string): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
}

/** `day` plus `count` calendar days (count may be negative). */
export function addDays(day: string, count: number): string {
  return dayOf(dayStart(day) + count * DAY_MS);
}

/** The previous calendar day in UTC. */
export function yesterdayUtc(now: Date): string {
  return dayOf(now.getTime() - DAY_MS);
}

/**
 * Every day from `from` to `to`, both included, ascending; empty when
 * from > to. Never builds a long list: RangeError for more than
 * INGEST_MAX_DAYS days or an unparseable day (callers validate first:
 * isIngestDay, daySpan).
 */
export function daysBetween(from: string, to: string): string[] {
  const start = dayStart(from);
  const end = dayStart(to);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new RangeError("invalid day");
  if (start > end) return [];
  if ((end - start) / DAY_MS + 1 > INGEST_MAX_DAYS) {
    throw new RangeError(`more than ${String(INGEST_MAX_DAYS)} days`);
  }
  const days: string[] = [];
  for (let time = start; time <= end; time += DAY_MS) days.push(dayOf(time));
  return days;
}

/**
 * How many consecutive failed first attempts stop a source's remaining days in
 * one run (every mode; failureStreak). One failed day can be a passing source
 * or network error, so the later days still run; two in a row most likely
 * mean the source (or the network) is down, and each further day could cost
 * the full per-source timeout (31 × 10 min for BZP in the worst case). The
 * days not run stay uncovered, so the next catch-up plans them again while
 * they are in its window.
 */
export const INGEST_MAX_CONSECUTIVE_FAILED_DAYS = 2;

/**
 * The count of consecutive failed first attempts after one more day of a
 * source has run (compared with INGEST_MAX_CONSECUTIVE_FAILED_DAYS):
 * - a day that did not fail (covered) resets it to 0;
 * - a failed first attempt (no earlier run of the source for that day; a run
 *   that could not be recorded counts as failed) adds 1;
 * - a failed retry (the day had an earlier run) leaves it unchanged — a day
 *   that keeps failing (e.g. a page over the response limit) must not block
 *   the newer days, while an outage still fails the new days and stops the source.
 */
export function failureStreak(
  streak: number,
  day: { readonly failed: boolean; readonly firstAttempt: boolean },
): number {
  if (!day.failed) return 0;
  return day.firstAttempt ? streak + 1 : streak;
}

/** The days catch-up considers: the `maxDays` days ending `yesterday`, both included. */
export function catchUpWindow(
  yesterday: string,
  maxDays: number = INGEST_MAX_DAYS,
): { readonly from: string; readonly to: string } {
  return { from: addDays(yesterday, -(maxDays - 1)), to: yesterday };
}

/**
 * What `ingestion_runs` says about one source, as catch-up needs it. A day is
 * covered by a `succeeded` or `incomplete` run that started after the day had
 * ended (UTC); `failed` never covers.
 */
export interface CatchUpHistory {
  /** Covered days within the catch-up window (others are ignored), any order. */
  readonly covered: readonly string[];
  /** The latest covered day of the source, inside the window or not; null when none. */
  readonly latestCovered: string | null;
  /** The earliest day of any run of the source, whatever its status; null when none. */
  readonly earliestAttempted: string | null;
}

export interface CatchUpPlan {
  /** Ascending; empty when nothing is missing. */
  readonly days: readonly string[];
  /** Missing days older than the window, reported and never run (oldest first), or null. */
  readonly clipped: { readonly from: string; readonly to: string } | null;
}

/** Negative, zero or positive as `a` is before, the same as or after `b` (counted, not text). */
function compareDays(a: string, b: string): number {
  return daySpan(b, a) - 1;
}

/**
 * The days a source is missing (D-021): every day of the window — the
 * `maxDays` days ending `yesterday` — that is not covered, from the
 * earliest day the source ever ran (any status) on, ascending. A source that
 * has never run gets `yesterday` only (no implicit backfill of history; a
 * manual `--from/--to` backfill moves the start earlier, never past the
 * window), and yesterday is always planned while it is not covered. So a
 * failed day, or one left before a later manual `--date`, is retried by every
 * catch-up while it is in the window.
 *
 * Uncovered days older than the window are never run automatically. Those
 * after the latest covered day (or, without one, from the earliest run on)
 * are reported as `clipped`; older holes before a covered day are not.
 * `maxDays` must not exceed INGEST_MAX_DAYS (daysBetween's bound).
 */
export function planCatchUp(
  history: CatchUpHistory,
  yesterday: string,
  maxDays: number = INGEST_MAX_DAYS,
): CatchUpPlan {
  const window = catchUpWindow(yesterday, maxDays);
  const { earliestAttempted, latestCovered } = history;
  let first = yesterday;
  if (earliestAttempted !== null && compareDays(earliestAttempted, yesterday) < 0) {
    first = compareDays(earliestAttempted, window.from) > 0 ? earliestAttempted : window.from;
  }
  const covered = new Set(history.covered);
  const days = daysBetween(first, yesterday).filter((day) => !covered.has(day));

  const beforeWindow = addDays(window.from, -1);
  let clipped: CatchUpPlan["clipped"] = null;
  if (latestCovered !== null) {
    if (compareDays(latestCovered, beforeWindow) < 0) {
      clipped = { from: addDays(latestCovered, 1), to: beforeWindow };
    }
  } else if (earliestAttempted !== null && compareDays(earliestAttempted, window.from) < 0) {
    clipped = { from: earliestAttempted, to: beforeWindow };
  }
  return { days, clipped };
}
