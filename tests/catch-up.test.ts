import { describe, expect, it } from "vitest";
import {
  addDays,
  catchUpWindow,
  daySpan,
  daysBetween,
  failureStreak,
  INGEST_MAX_CONSECUTIVE_FAILED_DAYS,
  INGEST_MAX_DAYS,
  isIngestDay,
  planCatchUp,
  yesterdayUtc,
  type CatchUpHistory,
} from "../src/ingestion/catch-up.js";

describe("calendar day helpers", () => {
  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });

  it("takes yesterday in UTC, whatever the local time zone", () => {
    expect(yesterdayUtc(new Date("2026-10-30T00:00:00.000Z"))).toBe("2026-10-29");
    expect(yesterdayUtc(new Date("2026-10-30T23:59:59.999Z"))).toBe("2026-10-29");
    expect(yesterdayUtc(new Date("2027-01-01T05:00:00.000Z"))).toBe("2026-12-31");
  });

  it("lists the days of a range, both included", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(daysBetween("2026-10-30", "2026-10-30")).toEqual(["2026-10-30"]);
    expect(daysBetween("2026-10-30", "2026-10-29")).toEqual([]);
  });
});

/**
 * A source's history: `covered` days in the window; by default the earliest
 * run and the latest covered day are the first and last of them.
 */
function history(
  covered: readonly string[],
  earliestAttempted: string | null = [...covered].sort()[0] ?? null,
  latestCovered: string | null = [...covered].sort().at(-1) ?? null,
): CatchUpHistory {
  return { covered, earliestAttempted, latestCovered };
}

const YESTERDAY = "2026-10-29";

describe("planCatchUp", () => {
  it("considers the 31 days ending yesterday", () => {
    expect(catchUpWindow(YESTERDAY)).toEqual({ from: "2026-09-29", to: YESTERDAY });
    expect(daySpan(catchUpWindow(YESTERDAY).from, YESTERDAY)).toBe(INGEST_MAX_DAYS);
  });

  it("runs yesterday only for a source that has never run (no history backfill)", () => {
    expect(planCatchUp(history([]), YESTERDAY)).toEqual({ days: [YESTERDAY], clipped: null });
  });

  it("runs yesterday when the source's only runs are of today or later", () => {
    // E.g. a manual --date of today: yesterday was never attempted, but is still due.
    expect(planCatchUp(history([], "2026-10-30"), YESTERDAY)).toEqual({
      days: [YESTERDAY],
      clipped: null,
    });
  });

  it("runs nothing when every day since the earliest run is covered", () => {
    expect(planCatchUp(history(["2026-10-28", YESTERDAY]), YESTERDAY)).toEqual({
      days: [],
      clipped: null,
    });
    // A covered day after yesterday (clock moved back) changes nothing.
    expect(planCatchUp(history([YESTERDAY, "2026-11-05"]), YESTERDAY)).toEqual({
      days: [],
      clipped: null,
    });
  });

  it("runs every missing day after the last covered one, ascending", () => {
    expect(planCatchUp(history(["2026-10-26"]), YESTERDAY)).toEqual({
      days: ["2026-10-27", "2026-10-28", YESTERDAY],
      clipped: null,
    });
  });

  it("runs a gap in the middle, left behind by a later manual --date", () => {
    // 10-27 failed (or was skipped), then 10-28 was run by hand: catch-up
    // does not jump over 10-27.
    expect(planCatchUp(history(["2026-10-25", "2026-10-26", "2026-10-28"]), YESTERDAY)).toEqual({
      days: ["2026-10-27", YESTERDAY],
      clipped: null,
    });
  });

  it("retries a failed day (attempted, never covered) on every run while it is in the window", () => {
    // 10-20 always fails; the newer days are covered.
    const covered = daysBetween("2026-10-21", "2026-10-28");
    expect(planCatchUp(history(covered, "2026-10-20"), YESTERDAY)).toEqual({
      days: ["2026-10-20", YESTERDAY],
      clipped: null,
    });
  });

  it("starts at the earliest attempted day, moved earlier by a backfill", () => {
    // A backfill --from 10-10 --to 10-12 where 10-11 failed.
    expect(
      planCatchUp(history(["2026-10-10", "2026-10-12", YESTERDAY], "2026-10-10"), YESTERDAY).days,
    ).toEqual(["2026-10-11", ...daysBetween("2026-10-13", "2026-10-28")]);
  });

  it("never plans a day older than the window, whatever the earliest run", () => {
    // Earliest run 2026-08-01, covered from the window start on except 10-01.
    const covered = daysBetween("2026-09-29", YESTERDAY).filter((day) => day !== "2026-10-01");
    expect(planCatchUp(history(covered, "2026-08-01", YESTERDAY), YESTERDAY)).toEqual({
      days: ["2026-10-01"],
      clipped: null,
    });
    // Holes before the window are neither run nor reported while a later day is covered.
    expect(planCatchUp(history([YESTERDAY], "2026-08-01", YESTERDAY), YESTERDAY)).toEqual({
      days: daysBetween("2026-09-29", "2026-10-28"),
      clipped: null,
    });
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(planCatchUp(history(["2026-12-30"]), "2027-01-02").days).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(planCatchUp(history(["2028-02-27"]), "2028-03-01").days).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("runs exactly the window without clipping when the day before it is covered", () => {
    const plan = planCatchUp(history([], "2026-09-28", "2026-09-28"), YESTERDAY);
    expect(plan.days).toHaveLength(31);
    expect(plan.days[0]).toBe("2026-09-29");
    expect(plan.clipped).toBeNull();
  });

  it("reports the days after the latest covered day that are older than the window", () => {
    const plan = planCatchUp(history([], "2026-09-01", "2026-09-01"), YESTERDAY);
    expect(plan.days).toHaveLength(INGEST_MAX_DAYS);
    expect(plan.days[0]).toBe("2026-09-29");
    expect(plan.days.at(-1)).toBe(YESTERDAY);
    expect(plan.clipped).toEqual({ from: "2026-09-02", to: "2026-09-28" });
  });

  it("reports the days from the earliest run on when no day was ever covered", () => {
    // Every run so far failed, the first one before the window.
    const plan = planCatchUp(history([], "2026-09-10", null), YESTERDAY);
    expect(plan.days).toEqual(daysBetween("2026-09-29", YESTERDAY));
    expect(plan.clipped).toEqual({ from: "2026-09-10", to: "2026-09-28" });
    // A first run inside the window: nothing older to report.
    expect(planCatchUp(history([], "2026-10-27", null), YESTERDAY)).toEqual({
      days: ["2026-10-27", "2026-10-28", YESTERDAY],
      clipped: null,
    });
  });

  it("plans by the given window length", () => {
    expect(planCatchUp(history([], "2026-10-20", "2026-10-20"), YESTERDAY, 3)).toEqual({
      days: ["2026-10-27", "2026-10-28", YESTERDAY],
      clipped: { from: "2026-10-21", to: "2026-10-26" },
    });
  });
});

describe("failureStreak", () => {
  /** The streak after each day in turn, from 0. */
  function streaks(days: readonly { failed: boolean; firstAttempt: boolean }[]): number[] {
    const result: number[] = [];
    let streak = 0;
    for (const day of days) {
      streak = failureStreak(streak, day);
      result.push(streak);
    }
    return result;
  }
  const firstFailed = { failed: true, firstAttempt: true };
  const retryFailed = { failed: true, firstAttempt: false };
  const firstOk = { failed: false, firstAttempt: true };
  const retryOk = { failed: false, firstAttempt: false };

  it("counts consecutive failed first attempts up to the stop", () => {
    expect(INGEST_MAX_CONSECUTIVE_FAILED_DAYS).toBe(2);
    expect(streaks([firstFailed, firstFailed])).toEqual([1, INGEST_MAX_CONSECUTIVE_FAILED_DAYS]);
  });

  it("neither counts nor resets a failed retry", () => {
    // Two days that keep failing never stop the source by themselves.
    expect(streaks([retryFailed, retryFailed, retryFailed])).toEqual([0, 0, 0]);
    // A failed retry between two failed first attempts: they are still consecutive.
    expect(streaks([firstFailed, retryFailed, firstFailed])).toEqual([1, 1, 2]);
  });

  it("resets on any day that did not fail, first attempt or retry", () => {
    expect(streaks([firstFailed, firstOk, firstFailed])).toEqual([1, 0, 1]);
    expect(streaks([firstFailed, retryOk, firstFailed])).toEqual([1, 0, 1]);
  });
});

describe("bounded days", () => {
  it("accepts only real calendar days from 2000 to 2999", () => {
    for (const day of ["2000-01-01", "2026-10-29", "2028-02-29", "2999-12-31"]) {
      expect(isIngestDay(day)).toBe(true);
    }
    for (const day of [
      "1999-12-31",
      "3000-01-01",
      "9999-12-31",
      "0100-01-01",
      "2026-02-29",
      "2026-13-01",
      "+010000-01-01",
      "2026-10-29T00:00:00Z",
      "",
    ]) {
      expect(isIngestDay(day)).toBe(false);
    }
  });

  it("counts the days of a range without listing them", () => {
    expect(daySpan("2026-10-29", "2026-10-29")).toBe(1);
    expect(daySpan("2026-09-29", "2026-10-29")).toBe(31);
    expect(daySpan("2026-10-29", "2026-10-28")).toBe(0);
    expect(daySpan("2000-01-01", "2999-12-31")).toBe(365_243);
    // Across the DST change in Europe (the count is in UTC days).
    expect(daySpan("2026-03-28", "2026-03-30")).toBe(3);
  });

  it("refuses to list more than INGEST_MAX_DAYS days, at once", () => {
    expect(daysBetween("2026-09-29", "2026-10-29")).toHaveLength(INGEST_MAX_DAYS);
    expect(() => daysBetween("2026-09-28", "2026-10-29")).toThrow(RangeError);
    const started = performance.now();
    expect(() => daysBetween("0100-01-01", "2026-10-01")).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(100);
    expect(() => daysBetween("29.10.2026", "2026-10-29")).toThrow(RangeError);
  });

  it("ends at year 9999 instead of running on past it", () => {
    // Before the fix the text comparison never stopped ("+010000-…" < "9999-…").
    expect(daysBetween("9999-12-30", "9999-12-31")).toEqual(["9999-12-30", "9999-12-31"]);
    expect(daysBetween("9999-12-31", "9999-12-31")).toEqual(["9999-12-31"]);
  });

  it("plans catch-up by counting days, whatever the stored day", () => {
    expect(planCatchUp(history([], "9999-12-31", "9999-12-31"), YESTERDAY)).toEqual({
      days: [YESTERDAY],
      clipped: null,
    });
    const plan = planCatchUp(history([], "0100-01-01", "0100-01-01"), YESTERDAY);
    expect(plan.days).toHaveLength(INGEST_MAX_DAYS);
    expect(plan.clipped).toEqual({ from: "0100-01-02", to: "2026-09-28" });
  });
});
