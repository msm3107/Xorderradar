import { describe, expect, it } from "vitest";
import {
  addDays,
  catchUpDays,
  daySpan,
  daysBetween,
  INGEST_MAX_DAYS,
  isIngestDay,
  yesterdayUtc,
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

describe("catchUpDays", () => {
  it("runs yesterday only for a source that has never covered a day (no history backfill)", () => {
    expect(catchUpDays(null, "2026-10-29", INGEST_MAX_DAYS)).toEqual({
      days: ["2026-10-29"],
      clipped: null,
    });
  });

  it("runs nothing when yesterday (or a later day) is already covered", () => {
    expect(catchUpDays("2026-10-29", "2026-10-29", INGEST_MAX_DAYS)).toEqual({
      days: [],
      clipped: null,
    });
    expect(catchUpDays("2026-11-05", "2026-10-29", INGEST_MAX_DAYS)).toEqual({
      days: [],
      clipped: null,
    });
  });

  it("runs every missing day after the last covered one, ascending", () => {
    expect(catchUpDays("2026-10-26", "2026-10-29", INGEST_MAX_DAYS)).toEqual({
      days: ["2026-10-27", "2026-10-28", "2026-10-29"],
      clipped: null,
    });
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(catchUpDays("2026-12-30", "2027-01-02", INGEST_MAX_DAYS).days).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(catchUpDays("2028-02-27", "2028-03-01", INGEST_MAX_DAYS).days).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("runs exactly the maximum without clipping", () => {
    const plan = catchUpDays("2026-09-28", "2026-10-29", INGEST_MAX_DAYS);
    expect(plan.days).toHaveLength(31);
    expect(plan.days[0]).toBe("2026-09-29");
    expect(plan.clipped).toBeNull();
  });

  it("clips a longer gap to the maximum ending yesterday and reports the older days", () => {
    const plan = catchUpDays("2026-09-01", "2026-10-29", INGEST_MAX_DAYS);
    expect(plan.days).toHaveLength(INGEST_MAX_DAYS);
    expect(plan.days[0]).toBe("2026-09-29");
    expect(plan.days.at(-1)).toBe("2026-10-29");
    expect(plan.clipped).toEqual({ from: "2026-09-02", to: "2026-09-28" });
  });

  it("clips by the given maximum", () => {
    expect(catchUpDays("2026-10-20", "2026-10-29", 3)).toEqual({
      days: ["2026-10-27", "2026-10-28", "2026-10-29"],
      clipped: { from: "2026-10-21", to: "2026-10-26" },
    });
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
    expect(catchUpDays("9999-12-31", "2026-10-29", INGEST_MAX_DAYS)).toEqual({
      days: [],
      clipped: null,
    });
    const plan = catchUpDays("0100-01-01", "2026-10-29", INGEST_MAX_DAYS);
    expect(plan.days).toHaveLength(INGEST_MAX_DAYS);
    expect(plan.clipped).toEqual({ from: "0100-01-02", to: "2026-09-28" });
  });
});
