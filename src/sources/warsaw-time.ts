/**
 * Wall-clock time in Poland (Europe/Warsaw) → UTC instant. Polish sources
 * publish local times without an offset; the offset is +01:00 (CET) or +02:00
 * (CEST) depending on the day, so it is never assumed.
 */
export interface WarsawLocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** CET and CEST, the only offsets Europe/Warsaw has used since 1977. */
const CANDIDATE_OFFSETS_MS = [3_600_000, 7_200_000] as const;

const warsawFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

function warsawWallTime(instant: Date): WarsawLocalTime {
  const parts = new Map(warsawFormat.formatToParts(instant).map((part) => [part.type, part.value]));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.get(type));
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function sameWallTime(a: WarsawLocalTime, b: WarsawLocalTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * The UTC instant at which Warsaw clocks show `local`, or null when there is
 * no single such instant: an impossible date or time (2026-02-30, 24:00), a
 * time skipped by the spring DST change (e.g. 2027-03-28 02:30) or one that
 * occurs twice in autumn (e.g. 2026-10-25 02:30) — never a guess. Each
 * candidate offset is kept only when it round-trips through the time zone
 * database (Intl), so DST rules are not re-implemented here.
 */
export function warsawLocalToUtc(local: WarsawLocalTime): Date | null {
  const { year, month, day, hour, minute } = local;
  const values = [year, month, day, hour, minute];
  if (!values.every(Number.isInteger)) return null;
  if (year < 1000 || year > 9999 || hour > 23 || minute > 59 || hour < 0 || minute < 0) {
    return null;
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(wall);
  // Date.UTC rolls an impossible day over (2026-02-30 → 2026-03-02).
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const matches = CANDIDATE_OFFSETS_MS.map((offset) => new Date(wall - offset)).filter(
    (candidate) => sameWallTime(warsawWallTime(candidate), local),
  );
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? only : null;
}
