import { describe, expect, it } from "vitest";
import type {
  DeliveryCounts,
  FailedDay,
  SourceRunState,
  StatusRun,
} from "../src/infrastructure/db/status-repository.js";
import {
  BACKUP_STALE_AFTER_MS,
  evaluateStatus,
  failedStatus,
  formatOperatorAlert,
  STATUS_STALE_AFTER_MS,
  withBackupCheck,
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

describe("withBackupCheck", () => {
  const ok = evaluate([source()]);
  const found = (ageMs: number, files = 2) => ({
    files,
    newestAt: new Date(NOW.getTime() - ageMs),
    unreadableCode: null,
  });

  it("keeps a report ok while the newest backup is at most 26 hours old", () => {
    const report = withBackupCheck(ok, found(BACKUP_STALE_AFTER_MS));
    expect(report.status).toBe("ok");
    expect(report.problems).toEqual([]);
    expect(report.backup).toEqual({
      status: "ok",
      newestAt: new Date(NOW.getTime() - BACKUP_STALE_AFTER_MS),
      files: 2,
      code: null,
    });
    expect(BACKUP_STALE_AFTER_MS).toBe(26 * HOUR);
  });

  it("reports a backup older than that as stale", () => {
    const report = withBackupCheck(ok, found(BACKUP_STALE_AFTER_MS + 1));
    expect(report.status).toBe("problem");
    expect(report.problems).toEqual(["backup_stale"]);
    expect(report.backup?.status).toBe("stale");
  });

  // The schedule of deploy/cron/radar in Polish time: backup 05:30, status
  // 06:30 and 07:45. Times below are UTC: CET = UTC+1, CEST = UTC+2.
  describe("with the cron schedule", () => {
    const at = (checkedAt: string, newestAt: string) =>
      withBackupCheck(
        { ...ok, checkedAt: new Date(checkedAt) },
        { files: 14, newestAt: new Date(newestAt), unreadableCode: null },
      ).backup?.status;

    it("catches one failed night at 07:45, not yet at 06:30", () => {
      // Last backup 2026-11-09 05:30 CET; the one of 2026-11-10 failed.
      const newest = "2026-11-09T04:30:00.000Z";
      expect(at("2026-11-10T05:30:00.000Z", newest)).toBe("ok"); // 06:30, 25 h
      expect(at("2026-11-10T06:45:00.000Z", newest)).toBe("stale"); // 07:45, 26 h 15 min
    });

    it("raises no alarm without a failure, also just before the next backup", () => {
      // Manual status at 05:29, and at 05:40 while today's dump is still running.
      expect(at("2026-11-10T04:29:00.000Z", "2026-11-09T04:30:00.000Z")).toBe("ok");
      expect(at("2026-11-10T04:40:00.000Z", "2026-11-09T04:30:00.000Z")).toBe("ok");
      // After today's backup.
      expect(at("2026-11-10T06:45:00.000Z", "2026-11-10T04:30:00.000Z")).toBe("ok");
      // Autumn DST day (2026-10-25, 25 h): the 05:30 CEST backup of the day
      // before, seen at 05:29 CET.
      expect(at("2026-10-25T04:29:00.000Z", "2026-10-24T03:30:00.000Z")).toBe("ok");
    });

    it("catches two failed nights at 06:30", () => {
      expect(at("2026-11-11T05:30:00.000Z", "2026-11-09T04:30:00.000Z")).toBe("stale"); // 49 h
    });

    it("has a known gap on the spring DST day: a single failed night is never reported, a second one in a row is caught at 06:30 the next day", () => {
      // Last backup 2026-03-28 05:30 CET; the one of 2026-03-29 (23 h day) failed.
      const newest = "2026-03-28T04:30:00.000Z";
      expect(at("2026-03-29T05:45:00.000Z", newest)).toBe("ok"); // 07:45 CEST, 25 h 15 min
      // The next backup (2026-03-30 05:30 CEST) succeeds: never reported.
      expect(at("2026-03-30T04:30:00.000Z", "2026-03-30T03:30:00.000Z")).toBe("ok"); // 06:30
      expect(at("2026-03-30T05:45:00.000Z", "2026-03-30T03:30:00.000Z")).toBe("ok"); // 07:45
      // It fails too: caught at 06:30 the next day.
      expect(at("2026-03-30T04:30:00.000Z", newest)).toBe("stale"); // 06:30 CEST, 48 h
    });
  });

  it("reports a directory without a backup, and one it cannot read", () => {
    expect(withBackupCheck(ok, { files: 0, newestAt: null, unreadableCode: null })).toMatchObject({
      status: "problem",
      problems: ["backup_missing"],
      backup: { status: "missing", newestAt: null, files: 0, code: null },
    });
    expect(
      withBackupCheck(ok, { files: null, newestAt: null, unreadableCode: "EACCES" }),
    ).toMatchObject({
      status: "problem",
      problems: ["backup_dir_unreadable"],
      backup: { status: "unreadable", newestAt: null, files: null, code: "EACCES" },
    });
  });

  it("adds its problem after the others, also to a database failure", () => {
    const report = withBackupCheck(
      evaluate([source({ lastRun: run({ status: "failed" }) })], { pending: 1 }),
      found(3 * 24 * HOUR),
    );
    expect(report.problems).toEqual(["source_failed", "deliveries_pending", "backup_stale"]);
    const failed = withBackupCheck(
      failedStatus(NOW, "database_unavailable", { reason: "unreachable", code: "ECONNREFUSED" }),
      { files: 0, newestAt: null, unreadableCode: null },
    );
    expect(failed.problems).toEqual(["database_unavailable", "backup_missing"]);
  });

  it("is in the alert with its status, newest time and count, never a path", () => {
    const stale = formatOperatorAlert(withBackupCheck(ok, found(40 * HOUR, 14)));
    expect(stale.subject).toBe("Radar Zamówień: problem (backup_stale)");
    expect(stale.text).toContain(
      `Kopia zapasowa: stale, najnowsza ${new Date(NOW.getTime() - 40 * HOUR).toISOString()}, plików 14\n`,
    );
    const missing = formatOperatorAlert(
      withBackupCheck(ok, { files: 0, newestAt: null, unreadableCode: null }),
    );
    expect(missing.text).toContain("Kopia zapasowa: missing, najnowsza brak, plików 0\n");
    const unreadable = formatOperatorAlert(
      withBackupCheck(ok, { files: null, newestAt: null, unreadableCode: "ENOENT" }),
    );
    expect(unreadable.text).toContain("Kopia zapasowa: unreadable, katalog nieczytelny (ENOENT)\n");
    for (const { text } of [stale, missing, unreadable]) {
      const runbook = "Co zrobić: docs/RUNBOOK.md, sekcja „Alert statusu”.\n";
      expect(text.endsWith(runbook)).toBe(true);
      // No address, markup or path besides the runbook's.
      expect(text.slice(0, -runbook.length)).not.toMatch(/@|<|>|\//u);
    }
  });

  it("leaves the alert without a backup line when there was no check", () => {
    expect(formatOperatorAlert(failedStatus(NOW, "schema_not_ready", null)).text).not.toContain(
      "Kopia zapasowa",
    );
  });
});
