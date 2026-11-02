import { describe, expect, it } from "vitest";
import type {
  DeliveryCounts,
  FailedDay,
  SourceRunState,
  StatusRun,
} from "../src/infrastructure/db/status-repository.js";
import {
  evaluateStatus,
  failedStatus,
  formatOperatorAlert,
  STATUS_STALE_AFTER_MS,
} from "../src/operations/status.js";

const NOW = new Date("2026-11-02T07:00:00.000Z");
const HOUR = 60 * 60_000;
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function run(overrides: Partial<StatusRun> = {}): StatusRun {
  return {
    runId: RUN_ID,
    status: "succeeded",
    publicationDate: "2026-11-01",
    startedAt: new Date(NOW.getTime() - 2 * HOUR),
    finishedAt: new Date(NOW.getTime() - 2 * HOUR + 60_000),
    errorCode: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceRunState> = {}): SourceRunState {
  return {
    sourceId: "bzp",
    lastRun: run(),
    lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR + 60_000),
    ...overrides,
  };
}

const QUIET: DeliveryCounts = {
  pending: 0,
  failed: 0,
  failedExhausted: 0,
  failedErrorCodes: [],
  digestRunning: false,
};

function evaluate(
  sources: SourceRunState[],
  deliveries: Partial<DeliveryCounts> = {},
  failedDays: FailedDay[] = [],
) {
  return evaluateStatus({
    now: NOW,
    sources,
    failedDays,
    deliveries: { ...QUIET, ...deliveries },
    failedSince: "2026-11-01",
  });
}

describe("evaluateStatus", () => {
  it("is ok for a source that succeeded recently and quiet deliveries", () => {
    const report = evaluate([source()]);
    expect(report.status).toBe("ok");
    expect(report.problems).toEqual([]);
    expect(report.sources?.[0]?.problems).toEqual([]);
    expect(report.deliveries).toEqual({ ...QUIET, failedSince: "2026-11-01" });
    expect(report.database).toBeNull();
  });

  it("counts an incomplete run as a success (it is not a failure of the source)", () => {
    expect(evaluate([source({ lastRun: run({ status: "incomplete" }) })]).status).toBe("ok");
  });

  it("reports a source whose last run failed", () => {
    const report = evaluate([
      source({ lastRun: run({ status: "failed", errorCode: "source_unavailable" }) }),
    ]);
    expect(report.status).toBe("problem");
    expect(report.problems).toEqual(["source_failed"]);
  });

  it("reports a failed day not covered yet even when a later run succeeded", () => {
    const report = evaluate([source()], {}, [
      {
        sourceId: "bzp",
        runId: RUN_ID,
        publicationDate: "2026-10-31",
        startedAt: new Date(NOW.getTime() - 3 * HOUR),
        errorCode: "timeout",
      },
      // Another source's day is not this source's problem.
      {
        sourceId: "other",
        runId: RUN_ID,
        publicationDate: "2026-10-31",
        startedAt: NOW,
        errorCode: null,
      },
    ]);
    expect(report.problems).toEqual(["source_failed"]);
    expect(report.sources?.[0]?.failedDays).toEqual([
      {
        runId: RUN_ID,
        publicationDate: "2026-10-31",
        startedAt: new Date(NOW.getTime() - 3 * HOUR),
        errorCode: "timeout",
      },
    ]);
  });

  it("is stale after 36 hours without a success, and not a moment before", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(evaluate([source({ lastSuccessAt: at(STATUS_STALE_AFTER_MS) })]).status).toBe("ok");
    expect(evaluate([source({ lastSuccessAt: at(STATUS_STALE_AFTER_MS + 1) })]).problems).toEqual([
      "source_stale",
    ]);
    expect(STATUS_STALE_AFTER_MS).toBe(36 * HOUR);
  });

  it("reports runs without any success as failed and stale", () => {
    const report = evaluate([source({ lastRun: run({ status: "failed" }), lastSuccessAt: null })]);
    expect(report.problems).toEqual(["source_failed", "source_stale"]);
  });

  it("reports a source that never ran, and no enabled source at all", () => {
    expect(evaluate([source({ lastRun: null, lastSuccessAt: null })]).problems).toEqual([
      "source_never_run",
    ]);
    expect(evaluate([]).problems).toEqual(["no_enabled_sources"]);
  });

  it("reports pending deliveries unless a digest run holds its lock", () => {
    expect(evaluate([source()], { pending: 2 }).problems).toEqual(["deliveries_pending"]);
    expect(evaluate([source()], { pending: 2, digestRunning: true }).status).toBe("ok");
  });

  it("reports failed deliveries, retried or exhausted", () => {
    expect(evaluate([source()], { failed: 1 }).problems).toEqual(["deliveries_failed"]);
    expect(evaluate([source()], { failedExhausted: 1 }).problems).toEqual(["deliveries_failed"]);
  });

  it("lists every problem once, in a fixed order", () => {
    const report = evaluate(
      [
        source({ sourceId: "a", lastRun: run({ status: "failed" }), lastSuccessAt: null }),
        source({ sourceId: "b", lastRun: run({ status: "failed" }) }),
        source({ sourceId: "c", lastRun: null, lastSuccessAt: null }),
      ],
      { pending: 1, failed: 1 },
    );
    expect(report.problems).toEqual([
      "source_failed",
      "source_never_run",
      "source_stale",
      "deliveries_pending",
      "deliveries_failed",
    ]);
  });
});

describe("failedStatus", () => {
  it("is a problem report without sources or deliveries", () => {
    expect(
      failedStatus(NOW, "database_unavailable", { reason: "unreachable", code: "ECONNREFUSED" }),
    ).toEqual({
      status: "problem",
      checkedAt: NOW,
      problems: ["database_unavailable"],
      sources: null,
      deliveries: null,
      database: { reason: "unreachable", code: "ECONNREFUSED" },
    });
  });
});

describe("formatOperatorAlert", () => {
  const report = evaluate(
    [
      source({
        sourceId: "bzp",
        lastRun: run({ status: "failed", errorCode: "source_unavailable" }),
        lastSuccessAt: null,
      }),
      source({ sourceId: "ok-source" }),
    ],
    { pending: 1, failed: 2, failedExhausted: 1, failedErrorCodes: ["smtp_rejected"] },
  );

  it("names the problems in the subject only by their codes", () => {
    expect(formatOperatorAlert(report).subject).toBe(
      "Radar Zamówień: problem (source_failed, source_stale, deliveries_pending, deliveries_failed)",
    );
  });

  it("holds ids, statuses, codes, timestamps and counts, and points to the runbook", () => {
    const { text } = formatOperatorAlert(report);
    expect(text).toContain(`Sprawdzono: ${NOW.toISOString()}\nCzasy w UTC.\n`);
    expect(text).toContain("Źródło bzp: source_failed, source_stale");
    expect(text).toContain(`${RUN_ID} failed dzień 2026-11-01`);
    expect(text).toContain("kod błędu source_unavailable");
    expect(text).toContain("ostatni sukces: brak");
    expect(text).toContain(
      "Wysyłki: pending 1, failed od 2026-11-01: 2 do ponowienia, 1 bez dalszych prób, kody: smtp_rejected",
    );
    expect(text).toContain("docs/RUNBOOK.md, sekcja „Alert statusu”");
    // A source without a problem is not listed.
    expect(text).not.toContain("ok-source");
    // Nothing but those: no e-mail address and no markup.
    expect(text).not.toMatch(/@|<|>/);
  });

  it("explains a database failure with its fixed reason and code", () => {
    const { subject, text } = formatOperatorAlert(
      failedStatus(NOW, "database_unavailable", { reason: "unreachable", code: "ECONNREFUSED" }),
    );
    expect(subject).toBe("Radar Zamówień: problem (database_unavailable)");
    expect(text).toContain("Baza danych: unreachable (ECONNREFUSED)");
    expect(text).not.toContain("Wysyłki");
  });
});
