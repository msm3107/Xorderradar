import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bzpAdapter } from "../src/sources/bzp/adapter.js";
import {
  extractDeadlineChange,
  MAX_NORMALIZED_SEGMENT_LENGTH,
  textSegments,
} from "../src/sources/bzp/notice-update.js";
import type { NormalizeResult, RawDocument } from "../src/sources/types.js";

const FETCHED_AT = new Date("2026-10-30T10:00:00.000Z");
const FIXTURE = "notice-update-notice-2026-10-29.json";
const LIST_URL = "https://ezamowienia.gov.pl/mo-board/api/v1/notice";

const recordListSchema = z.array(z.record(z.string(), z.unknown()));
type JsonRecord = Record<string, unknown>;

/** A parsed copy of the captured page; tests mutate copies, never the fixture. */
function fixtureRecords(): JsonRecord[] {
  const text = readFileSync(new URL(`./fixtures/bzp/${FIXTURE}`, import.meta.url), "utf8");
  return recordListSchema.parse(JSON.parse(text));
}

function htmlBodyOf(record: JsonRecord | undefined): string {
  return z.string().parse(record?.htmlBody);
}

function normalizeAll(records: unknown[]): NormalizeResult[] {
  const doc: RawDocument = {
    sourceId: "bzp",
    url: `${LIST_URL}?NoticeType=NoticeUpdateNotice`,
    fetchedAt: FETCHED_AT,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(records),
  };
  return bzpAdapter.extract(doc).map((notice) => bzpAdapter.normalize(notice));
}

function normalizeOne(record: unknown): NormalizeResult {
  const [result] = normalizeAll([record]);
  if (result === undefined) throw new Error("expected one result");
  return result;
}

// --- synthetic bodies, shaped like the captured ones (labels, whitespace, <br/>)

const KIND_LABEL = "3.1.) Nazwa zmienianego ogłoszenia:";
const HEADING = "3.4.1.) Opis zmiany, w tym tekst, który należy dodać lub zmienić:";

function change(field: string, before: string, after: string): string {
  return (
    `<h3 class="mb-0">${HEADING} </h3>   ${field}   <p>   Przed zmianą: <br/>   ${before}   </p>` +
    `   <p>   Po zmianie: <br/>   ${after}   </p>`
  );
}

const DEADLINE_CHANGE = change(
  "8.1.  Termin składania ofert",
  "2026-10-29 08:00",
  "2026-11-03 10:00",
);
const OTHER_CHANGE = change("8.2.  Termin otwarcia ofert", "2026-10-29 08:30", "2026-11-03 10:30");

function body(options: { kind?: string; changes?: string[]; before?: string } = {}): string {
  const kind = options.kind ?? "Ogłoszenie o zamówieniu";
  const changes = options.changes ?? [DEADLINE_CHANGE];
  return (
    `<h2 class="bg-light">SEKCJA III ZMIANA OGŁOSZENIA</h2>${options.before ?? ""}` +
    `<h3 class="mb-0">${KIND_LABEL} </h3>${kind}    ` +
    `<h3 class="mb-0">3.2.) Numer zmienianego ogłoszenia w BZP: <span class="normal">2026/BZP 00000001</span></h3>` +
    changes.join("")
  );
}

const NEW_DEADLINE = new Date("2026-11-03T09:00:00.000Z");

describe("textSegments", () => {
  it("splits at tags, drops comments and script/style content, decodes entities, collapses whitespace", () => {
    expect(
      textSegments(
        "<p> a &amp;  b </p><!-- hidden --><script>x<y</script ><style>p{}</style>c&#243;&#xF3;&nbsp;d<br/>e",
      ),
    ).toEqual({ segments: ["a & b", "cóó d", "e"], complete: true });
  });

  it("stops at an unclosed tag, comment, script or style and reports it", () => {
    for (const html of ["a<p b", "a<!-- b", "a<script>b", "a<style>b", "a<script>b</script"]) {
      expect(textSegments(html)).toEqual({ segments: ["a"], complete: false });
    }
    expect(textSegments("a<").complete).toBe(false);
    expect(textSegments("a > b")).toEqual({ segments: ["a > b"], complete: true });
  });

  it("decodes invalid numeric entities to the replacement character, never to a control", () => {
    expect(textSegments("a&#0;b&#xD800;c&#1114112;d").segments).toEqual(["a�b�c�d"]);
  });

  it("NFC-normalizes segments up to MAX_NORMALIZED_SEGMENT_LENGTH, keeps longer ones as they are", () => {
    const decomposed = "Ogłoszenie o zamówieniu".normalize("NFD");
    expect(decomposed).not.toBe("Ogłoszenie o zamówieniu");
    expect(textSegments(`<p>${decomposed}</p>`).segments).toEqual(["Ogłoszenie o zamówieniu"]);

    // "o" + combining acute: NFC composes each pair into one "ó".
    const atBound = "o\u0301".repeat(MAX_NORMALIZED_SEGMENT_LENGTH / 2);
    expect(atBound).toHaveLength(MAX_NORMALIZED_SEGMENT_LENGTH);
    expect(textSegments(`<p>${atBound}</p>`).segments).toEqual([
      "ó".repeat(MAX_NORMALIZED_SEGMENT_LENGTH / 2),
    ]);
    const overBound = `${atBound}o`;
    expect(textSegments(`<p>${overBound}</p><p>x</p>`)).toEqual({
      segments: [overBound, "x"],
      complete: true,
    });
  });
});

describe("extractDeadlineChange on the captured update notices", () => {
  it("reads the new deadline (Warsaw local time → UTC) or the reason there is none", () => {
    const outcomes = fixtureRecords().map((record) => extractDeadlineChange(htmlBodyOf(record)));
    expect(outcomes).toEqual([
      {
        ok: true,
        change: { kind: "deadline", deadline: new Date("2026-11-03T09:00:00.000Z") },
      },
      { ok: true, change: { kind: "none", reason: "no_deadline_change" } },
      {
        ok: true,
        change: { kind: "deadline", deadline: new Date("2026-11-04T09:00:00.000Z") },
      },
      { ok: true, change: { kind: "none", reason: "not_contract_notice_change" } },
      {
        ok: true,
        change: { kind: "deadline", deadline: new Date("2026-11-05T09:00:00.000Z") },
      },
    ]);
  });

  it("takes the value of the deadline change only, not of the other changes in the notice", () => {
    // Record 0 has three changes, each with its own "Po zmianie:".
    const html = htmlBodyOf(fixtureRecords()[0]);
    expect(html.split("Po zmianie:")).toHaveLength(4);
    expect(extractDeadlineChange(html)).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: new Date("2026-11-03T09:00:00.000Z") },
    });
  });

  it("rejects a captured body whose new deadline is not a valid date", () => {
    const html = htmlBodyOf(fixtureRecords()[0]).replace("2026-11-03 10:00", "2026-11-31 10:00");
    expect(extractDeadlineChange(html)).toEqual({ ok: false, reason: "invalid value: deadline" });
  });
});

describe("extractDeadlineChange on hostile or unexpected bodies", () => {
  it("reads a well-formed synthetic body", () => {
    expect(extractDeadlineChange(body())).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: NEW_DEADLINE },
    });
  });

  it("finds the deadline change among others, in any position", () => {
    expect(extractDeadlineChange(body({ changes: [OTHER_CHANGE, DEADLINE_CHANGE] }))).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: NEW_DEADLINE },
    });
    expect(extractDeadlineChange(body({ changes: [DEADLINE_CHANGE, OTHER_CHANGE] }))).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: NEW_DEADLINE },
    });
  });

  it("reads labels and values written with entities", () => {
    const html = body({
      kind: "Og&#322;oszenie o zam&#xF3;wieniu",
      changes: [
        change(
          "8.1.&nbsp;Termin sk&#322;adania ofert",
          "2026-10-29 08:00",
          "2026-11-03&nbsp;10:00",
        ),
      ],
    });
    expect(extractDeadlineChange(html)).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: NEW_DEADLINE },
    });
  });

  it("ignores labels inside script, style, comments and attributes", () => {
    const decoys =
      `<script>document.write("<h3>${KIND_LABEL}</h3>Ogłoszenie o wykonaniu umowy")</script>` +
      `<style>/* ${KIND_LABEL} */</style>` +
      `<!-- <h3>${HEADING}</h3> 8.1. Termin składania ofert Po zmianie: 2030-01-01 00:00 -->` +
      `<span title="${KIND_LABEL}" data-x="8.1. Termin składania ofert"></span>`;
    expect(extractDeadlineChange(body({ before: decoys }))).toEqual({
      ok: true,
      change: { kind: "deadline", deadline: NEW_DEADLINE },
    });
    const scriptedChange = `<script>"${DEADLINE_CHANGE}"</script>`;
    expect(extractDeadlineChange(body({ changes: [OTHER_CHANGE, scriptedChange] }))).toEqual({
      ok: true,
      change: { kind: "none", reason: "no_deadline_change" },
    });
  });

  it("applies only changes of a contract notice", () => {
    for (const kind of [
      "Ogłoszenie o wykonaniu umowy",
      "Ogłoszenie o zamówieniu - zmiana",
      "ogłoszenie o zamówieniu",
    ]) {
      expect(extractDeadlineChange(body({ kind }))).toEqual({
        ok: true,
        change: { kind: "none", reason: "not_contract_notice_change" },
      });
    }
  });

  it("rejects a body without exactly one readable section 3.1", () => {
    const rejected = { ok: false, reason: "invalid source fields: htmlBody" };
    expect(extractDeadlineChange("")).toEqual(rejected);
    expect(extractDeadlineChange(DEADLINE_CHANGE)).toEqual(rejected);
    expect(extractDeadlineChange(`<h3>${KIND_LABEL}</h3>`)).toEqual(rejected);
    expect(extractDeadlineChange(`<h3>${KIND_LABEL}</h3>${body()}`)).toEqual(rejected);
  });

  it("rejects a body cut by an unclosed tag, comment, script or style, wherever it is", () => {
    const rejected = { ok: false, reason: "invalid source fields: htmlBody" };
    for (const unclosed of ["<!-- ", "<script>", "<style>"]) {
      // Before section 3.1, after it (before the deadline change), and after every change.
      expect(extractDeadlineChange(body({ before: unclosed }))).toEqual(rejected);
      expect(extractDeadlineChange(body({ changes: [unclosed, DEADLINE_CHANGE] }))).toEqual(
        rejected,
      );
      expect(extractDeadlineChange(body({ changes: [OTHER_CHANGE, unclosed] }))).toEqual(rejected);
      expect(extractDeadlineChange(body() + unclosed)).toEqual(rejected);
    }
    // An unclosed tag is closed by any later ">", so it can only be cut at the end.
    expect(extractDeadlineChange(body() + '<p class="x')).toEqual(rejected);
    // Never a "no change" or "not a contract notice" skip: those must come from a whole body.
    expect(extractDeadlineChange(body({ kind: "Ogłoszenie o wykonaniu umowy" }) + "<!--")).toEqual(
      rejected,
    );
  });

  it("returns no change when the notice does not change the offer deadline", () => {
    expect(extractDeadlineChange(body({ changes: [] }))).toEqual({
      ok: true,
      change: { kind: "none", reason: "no_deadline_change" },
    });
    expect(extractDeadlineChange(body({ changes: [OTHER_CHANGE] }))).toEqual({
      ok: true,
      change: { kind: "none", reason: "no_deadline_change" },
    });
  });

  it("rejects two deadline changes as ambiguous, even with the same value", () => {
    expect(extractDeadlineChange(body({ changes: [DEADLINE_CHANGE, DEADLINE_CHANGE] }))).toEqual({
      ok: false,
      reason: "ambiguous deadline change",
    });
  });

  it.each([
    ["seconds", "2026-11-03 10:00:00"],
    ["an ISO separator", "2026-11-03T10:00"],
    ["a Polish date order", "03.11.2026 10:00"],
    ["an impossible day", "2026-11-31 10:00"],
    ["hour 24", "2026-11-03 24:00"],
    ["a time skipped by DST", "2027-03-28 02:30"],
    ["a time repeated by DST", "2026-10-25 02:30"],
    ["trailing text", "2026-11-03 10:00 (UTC)"],
    ["nothing", ""],
  ])("rejects a new deadline with %s", (_case, value) => {
    const html = body({
      changes: [change("8.1.  Termin składania ofert", "2026-10-29 08:00", value)],
    });
    expect(extractDeadlineChange(html)).toEqual({ ok: false, reason: "invalid value: deadline" });
  });

  it("never borrows the new value from the next change", () => {
    const withoutValue =
      `<h3 class="mb-0">${HEADING}</h3> 8.1.  Termin składania ofert ` +
      `<p> Przed zmianą: <br/> 2026-10-29 08:00 </p>`;
    expect(extractDeadlineChange(body({ changes: [withoutValue, OTHER_CHANGE] }))).toEqual({
      ok: false,
      reason: "invalid value: deadline",
    });
  });

  it("rejects a deadline change with two new values", () => {
    const twice = `${DEADLINE_CHANGE}<p> Po zmianie: <br/> 2026-11-04 10:00 </p>`;
    expect(extractDeadlineChange(body({ changes: [twice] }))).toEqual({
      ok: false,
      reason: "invalid value: deadline",
    });
  });

  /** Hostile bodies of exactly `length` characters (the pattern repeated, then cut). */
  function hostileBodies(length: number): [string, string][] {
    const patterns: [string, string][] = [
      ["'<' repeated", "<"],
      ["unclosed comments", "<!--"],
      ["empty tags", "<a>"],
      ["unclosed scripts", "<script>"],
      ["entity starts", "&#1"],
      ["labels", `<h3>${KIND_LABEL}</h3>`],
      ["change headings", `<h3>${HEADING}</h3>8.1. Termin składania ofert`],
    ];
    return patterns.map(([name, pattern]) => [
      name,
      pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length),
    ]);
  }

  it.each(hostileBodies(200_000))(
    "handles 200 000 characters of %s in linear time",
    (_case, html) => {
      expect(html).toHaveLength(200_000);
      const started = performance.now();
      const result = extractDeadlineChange(html);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(!result.ok || result.change.kind === "none").toBe(true);
    },
  );

  // The adapter's bound (MAX_HTML_BODY_LENGTH). Each case takes well under
  // 100 ms here; a quadratic scan of a million characters would take minutes.
  it.each(hostileBodies(1_000_000))(
    "handles 1 000 000 characters of %s in linear time",
    (_case, html) => {
      expect(html).toHaveLength(1_000_000);
      const started = performance.now();
      const result = extractDeadlineChange(html);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(!result.ok || result.change.kind === "none").toBe(true);
    },
  );

  /**
   * Combining marks of differing classes (220, 230): canonical reordering in
   * NFC is quadratic in such a run (80 000 characters took ~2 s before the
   * normalization bound). Each body is well-formed, so the scan reads all of it.
   */
  function combiningMarkBodies(length: number): [string, string, number][] {
    const runOf = (marks: string, runLength: number) =>
      marks.repeat(Math.ceil(runLength / marks.length)).slice(0, runLength);
    const bodies: [string, string, number][] = [];
    const markRuns: [string, string][] = [
      ["U+0316 U+0301 repeated", "\u0316\u0301"],
      ["U+0316 U+0301 in alternating order", "\u0316\u0301\u0301\u0316"],
    ];
    for (const [name, marks] of markRuns) {
      bodies.push([`${name}, one bare text run`, runOf(marks, length), 1]);
      bodies.push([`${name}, inside one element`, `<p>${runOf(marks, length - 7)}</p>`, 1]);
      // As many segments as possible at the normalization bound.
      const piece = `<b>${runOf(marks, MAX_NORMALIZED_SEGMENT_LENGTH)}`;
      const count = Math.floor(length / piece.length);
      bodies.push([
        `${name}, segments at the normalization bound`,
        // The padding joins the last segment.
        piece.repeat(count) + "x".repeat(length - count * piece.length),
        count,
      ]);
    }
    return bodies;
  }

  it.each(combiningMarkBodies(1_000_000))(
    "handles 1 000 000 characters of %s in linear time",
    (_case, html, segmentCount) => {
      expect(html).toHaveLength(1_000_000);
      const started = performance.now();
      const result = extractDeadlineChange(html);
      expect(performance.now() - started).toBeLessThan(2_000);
      // The whole body was scanned: nothing unclosed, every segment read.
      const { segments, complete } = textSegments(html);
      expect(complete).toBe(true);
      expect(segments).toHaveLength(segmentCount);
      expect(result).toEqual({ ok: false, reason: "invalid source fields: htmlBody" });
    },
  );
});

describe("bzpAdapter with NoticeUpdateNotice records", () => {
  it("normalizes the captured updates into notice updates, never into opportunities", () => {
    const results = normalizeAll(fixtureRecords());
    expect(results.map((result) => (result.ok ? result.kind : result.reason))).toEqual([
      "notice_update",
      "notice_update",
      "notice_update",
      "notice_update",
      "notice_update",
    ]);
    const [first] = results;
    expect(first).toEqual({
      ok: true,
      kind: "notice_update",
      update: {
        sourceId: "bzp",
        externalId: "2026/BZP 00507126/01",
        tenderId: "ocds-148610-7679f479-52e9-4912-8b9c-3c435343fc20",
        publishedAt: expect.any(Date) as Date,
        fetchedAt: FETCHED_AT,
        change: { kind: "deadline", deadline: new Date("2026-11-03T09:00:00.000Z") },
      },
    });
    const updates = results.flatMap((result) =>
      result.ok && result.kind === "notice_update" ? [result.update] : [],
    );
    expect(updates.map((update) => update.externalId)).toEqual([
      "2026/BZP 00507126/01",
      "2026/BZP 00507129/01",
      "2026/BZP 00507130/01",
      "2026/BZP 00507136/01",
      "2026/BZP 00507141/01",
    ]);
    for (const update of updates) {
      expect(update.publishedAt.toISOString().startsWith("2026-10-29T")).toBe(true);
    }
  });

  it("keeps an update without a usable tenderId (ingestion skips it), never guessing a link", () => {
    const [record] = fixtureRecords();
    for (const tenderId of [null, undefined, 42, "x".repeat(20_001)]) {
      const result = normalizeOne({ ...record, tenderId });
      expect(
        result.ok && result.kind === "notice_update" ? result.update.tenderId : "?",
      ).toBeNull();
    }
  });

  it("rejects an update whose htmlBody is missing, not a string or too long", () => {
    const [record] = fixtureRecords();
    const html = htmlBodyOf(record);
    const tooLong = `${html}<!--${"x".repeat(1_000_001 - html.length - 7)}-->`;
    expect(tooLong).toHaveLength(1_000_001);
    for (const htmlBody of [undefined, null, 1, tooLong]) {
      expect(normalizeOne({ ...record, htmlBody })).toEqual({
        ok: false,
        externalId: "2026/BZP 00507126/01",
        reason: "invalid source fields: htmlBody",
      });
    }
  });

  it("accepts an htmlBody of exactly 1 000 000 characters (above the other fields' bound)", () => {
    const [record] = fixtureRecords();
    const html = htmlBodyOf(record);
    const padded = `${html}<!--${"x".repeat(1_000_000 - html.length - 7)}-->`;
    expect(padded).toHaveLength(1_000_000);
    const result = normalizeOne({ ...record, htmlBody: padded });
    expect(result.ok && result.kind === "notice_update" ? result.update.change : null).toEqual({
      kind: "deadline",
      deadline: new Date("2026-11-03T09:00:00.000Z"),
    });
  });

  it("rejects a body that cannot be read with a fixed reason, never with body text", () => {
    const [record] = fixtureRecords();
    const html = htmlBodyOf(record);
    const cases: [string, string][] = [
      [html.replace("2026-11-03 10:00", "2026-11-03 25:00"), "invalid value: deadline"],
      [
        html.replace("3.1.) Nazwa zmienianego", "3.1.) Nazwa zmienionego"),
        "invalid source fields: htmlBody",
      ],
    ];
    for (const [htmlBody, reason] of cases) {
      expect(normalizeOne({ ...record, htmlBody })).toEqual({
        ok: false,
        externalId: "2026/BZP 00507126/01",
        reason,
      });
    }
  });

  it("rejects an update with an invalid publication time", () => {
    const [record] = fixtureRecords();
    expect(normalizeOne({ ...record, publicationDate: "2026-10-29 05:27" })).toEqual({
      ok: false,
      externalId: "2026/BZP 00507126/01",
      reason: "invalid value: publishedAt",
    });
  });

  it("does not depend on the contract-notice fields an update does not use", () => {
    const [record] = fixtureRecords();
    const result = normalizeOne({ ...record, orderObject: 1, objectId: "not-a-guid" });
    expect(result.ok && result.kind).toBe("notice_update");
  });

  it("dispatches on each record's own noticeType", () => {
    const [record] = fixtureRecords();
    expect(normalizeOne({ ...record, noticeType: "TenderResultNotice" })).toEqual({
      ok: false,
      externalId: "2026/BZP 00507126/01",
      reason: "invalid source fields: noticeType",
    });
    // Labelled a contract notice, it must pass the contract-notice schema (it
    // has no deadline, so it would become an opportunity — not an update).
    const asNotice = normalizeOne({ ...record, noticeType: "ContractNotice" });
    expect(asNotice.ok && asNotice.kind).toBe("opportunity");
  });
});
