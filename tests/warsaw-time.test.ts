import { describe, expect, it } from "vitest";
import { warsawLocalToUtc, type WarsawLocalTime } from "../src/sources/normalize/warsaw-time.js";

function local(value: string): WarsawLocalTime {
  const match = /^(\d+)-(\d+)-(\d+) (\d+):(\d+)$/.exec(value);
  if (match === null) throw new Error(`bad test value ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

describe("warsawLocalToUtc", () => {
  it("converts winter time (CET, +01:00)", () => {
    expect(warsawLocalToUtc(local("2026-11-03 10:00"))).toEqual(
      new Date("2026-11-03T09:00:00.000Z"),
    );
    expect(warsawLocalToUtc(local("2027-01-01 00:00"))).toEqual(
      new Date("2026-12-31T23:00:00.000Z"),
    );
  });

  it("converts summer time (CEST, +02:00)", () => {
    expect(warsawLocalToUtc(local("2026-07-15 12:30"))).toEqual(
      new Date("2026-07-15T10:30:00.000Z"),
    );
  });

  it("converts the last minute before and the first minute after each DST change", () => {
    // Spring 2027: 02:00 CET becomes 03:00 CEST on 28 March.
    expect(warsawLocalToUtc(local("2027-03-28 01:59"))).toEqual(
      new Date("2027-03-28T00:59:00.000Z"),
    );
    expect(warsawLocalToUtc(local("2027-03-28 03:00"))).toEqual(
      new Date("2027-03-28T01:00:00.000Z"),
    );
    // Autumn 2026: 03:00 CEST becomes 02:00 CET on 25 October.
    expect(warsawLocalToUtc(local("2026-10-25 01:59"))).toEqual(
      new Date("2026-10-24T23:59:00.000Z"),
    );
    expect(warsawLocalToUtc(local("2026-10-25 03:00"))).toEqual(
      new Date("2026-10-25T02:00:00.000Z"),
    );
  });

  it("returns null for a time skipped by the spring change (never a guess)", () => {
    expect(warsawLocalToUtc(local("2027-03-28 02:30"))).toBeNull();
    expect(warsawLocalToUtc(local("2027-03-28 02:00"))).toBeNull();
  });

  it("returns null for a time that occurs twice in autumn (ambiguous)", () => {
    expect(warsawLocalToUtc(local("2026-10-25 02:30"))).toBeNull();
    expect(warsawLocalToUtc(local("2026-10-25 02:00"))).toBeNull();
  });

  it.each([
    ["an impossible day", local("2026-02-30 10:00")],
    ["29 February of a common year", local("2026-02-29 10:00")],
    ["month 13", local("2026-13-01 10:00")],
    ["month 0", local("2026-00-10 10:00")],
    ["hour 24", local("2026-11-03 24:00")],
    ["minute 60", local("2026-11-03 10:60")],
    ["a year out of range", local("0999-11-03 10:00")],
    ["a negative hour", { year: 2026, month: 11, day: 3, hour: -1, minute: 0 }],
    ["a fractional minute", { year: 2026, month: 11, day: 3, hour: 10, minute: 0.5 }],
    ["NaN", { year: Number.NaN, month: 11, day: 3, hour: 10, minute: 0 }],
  ])("returns null for %s", (_case, value) => {
    expect(warsawLocalToUtc(value)).toBeNull();
  });

  it("accepts 29 February of a leap year", () => {
    expect(warsawLocalToUtc(local("2028-02-29 09:15"))).toEqual(
      new Date("2028-02-29T08:15:00.000Z"),
    );
  });
});
