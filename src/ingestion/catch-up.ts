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

export interface CatchUpPlan {
  /** Ascending; empty when nothing is missing. */
  readonly days: readonly string[];
  /** Missing days left out because of `maxDays` (oldest first), or null. */
  readonly clipped: { readonly from: string; readonly to: string } | null;
}

/**
 * The days a source is missing: the day after `lastCovered` up to
 * `yesterday`. A source that has never covered a day starts with
 * `yesterday` only (no backfill of history). More than `maxDays` missing days
 * are clipped to the `maxDays` ending yesterday; the older ones are reported,
 * never fetched silently later (catch-up continues from the newest day run).
 * `maxDays` must not exceed INGEST_MAX_DAYS (daysBetween's bound).
 */
export function catchUpDays(
  lastCovered: string | null,
  yesterday: string,
  maxDays: number,
): CatchUpPlan {
  if (lastCovered === null) return { days: [yesterday], clipped: null };
  // Compared as numbers of days, not as text (any stored day, whatever its year).
  const missing = daySpan(lastCovered, yesterday) - 1;
  if (missing <= 0) return { days: [], clipped: null };
  const first = addDays(lastCovered, 1);
  if (missing <= maxDays) return { days: daysBetween(first, yesterday), clipped: null };
  const earliestAllowed = addDays(yesterday, -(maxDays - 1));
  return {
    days: daysBetween(earliestAllowed, yesterday),
    clipped: { from: first, to: addDays(earliestAllowed, -1) },
  };
}
