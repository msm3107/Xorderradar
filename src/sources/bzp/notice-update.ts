import type { NoticeUpdateChange } from "../../domain/notice-update.js";
import { warsawLocalToUtc } from "../warsaw-time.js";

/**
 * Reads the one change ingestion applies from the `htmlBody` of a BZP
 * "Ogłoszenie o zmianie ogłoszenia" (NoticeUpdateNotice, D-015): the new offer
 * deadline ("8.1. Termin składania ofert" → "Po zmianie") of a changed
 * contract notice. Nothing else in the body is read, and no text from it is
 * ever returned except that parsed instant.
 *
 * The body is untrusted markup of up to the adapter's bound (1 000 000
 * characters). Every step is linear in its length: one forward scan with
 * `indexOf` and bounded patterns, no regular expression with nested
 * quantifiers runs over the body, markup is never interpreted beyond
 * "a tag ends a text segment", and Unicode normalization (quadratic in a run
 * of combining marks) only ever runs on segments of at most
 * MAX_NORMALIZED_SEGMENT_LENGTH characters.
 */

/** Section 3.1: which kind of notice is being changed. */
const CHANGED_KIND_LABEL = "3.1.) Nazwa zmienianego ogłoszenia:";
/** The only kind whose changes apply to an opportunity. */
const CONTRACT_NOTICE_KIND = "Ogłoszenie o zamówieniu";
/** Section 3.4.1, repeated before every single change. */
const CHANGE_HEADING = "3.4.1.) Opis zmiany, w tym tekst, który należy dodać lub zmienić:";
/** The changed field (two spaces after "8.1." in the raw body; whitespace is collapsed). */
const DEADLINE_LABEL = "8.1. Termin składania ofert";
const NEW_VALUE_LABEL = "Po zmianie:";
/** `YYYY-MM-DD HH:MM`, Europe/Warsaw local time; applied to one short segment only. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
/**
 * Longest segment that is NFC-normalized. `normalize` reorders combining marks
 * by an insertion sort, so one long run of marks of differing classes is
 * quadratic (80 000 characters: ~2 s; 1 000 000: minutes of blocked event
 * loop). Segments are only ever compared for equality with the labels above
 * (at most 65 characters, 69 code points decomposed) or matched as a
 * 16-character date. Decomposition never shortens text, so a string
 * canonically equivalent to one of them has at most 69 code points (138 UTF-16
 * units). A longer segment can never match, so it is kept as it is,
 * un-normalized: segment positions do not change, and normalization costs at
 * most this length per segment (linear in the body).
 */
export const MAX_NORMALIZED_SEGMENT_LENGTH = 256;

/** Fixed rejection reasons (field names only, never source text). */
export const deadlineChangeRejections = [
  "invalid source fields: htmlBody",
  "ambiguous deadline change",
  "invalid value: deadline",
] as const;
export type DeadlineChangeRejection = (typeof deadlineChangeRejections)[number];

export type DeadlineChangeResult =
  | { readonly ok: true; readonly change: NoticeUpdateChange }
  | { readonly ok: false; readonly reason: DeadlineChangeRejection };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
/** Bounded alternatives only, so decoding is linear. */
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;

function codePoint(value: number): string {
  const valid = value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff);
  return valid ? String.fromCodePoint(value) : "�";
}

/** The handful of entities a label or a date could plausibly contain. */
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (_match, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined) return codePoint(Number(decimal));
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    return NAMED_ENTITIES[name ?? ""] ?? "";
  });
}

/**
 * Elements whose content is not text (never shown, never matched), with the
 * search for their end tag. Literal patterns: each scan is linear.
 */
const RAW_TEXT_END = new Map([
  ["script", /<\/script/gi],
  ["style", /<\/style/gi],
]);

/** Letters/digits of a tag name right after `<` or `</`, lower-cased; bounded. */
function tagNameAt(html: string, start: number, end: number): string {
  let index = start;
  if (html[index] === "/") index++;
  let name = "";
  while (index < end && name.length < 16) {
    const char = html[index] ?? "";
    if (!/[A-Za-z0-9]/.test(char)) break;
    name += char;
    index++;
  }
  return name.toLowerCase();
}

/**
 * The visible text of `html` as segments: every tag ends a segment; comments
 * and the content of `<script>`/`<style>` are dropped; entities decoded,
 * whitespace collapsed, NFC-normalized when short enough to ever match
 * (MAX_NORMALIZED_SEGMENT_LENGTH), empty segments omitted. An unclosed tag, comment or
 * raw-text element stops the scan: the rest of the body is never read as
 * text, and `complete` is false (the body is malformed, so nothing read from
 * it can be trusted to be the whole notice). Linear: each search starts where
 * the previous one ended and the scan never moves backwards.
 */
export function textSegments(html: string): {
  readonly segments: string[];
  readonly complete: boolean;
} {
  const segments: string[] = [];
  let complete = true;
  let pending = "";
  const flush = () => {
    const collapsed = decodeEntities(pending).replace(/\s+/gu, " ").trim();
    const segment =
      collapsed.length <= MAX_NORMALIZED_SEGMENT_LENGTH ? collapsed.normalize("NFC") : collapsed;
    if (segment !== "") segments.push(segment);
    pending = "";
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pending += html.slice(index);
      break;
    }
    pending += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) {
        complete = false;
        break;
      }
      index = close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      complete = false;
      break;
    }
    flush();
    const name = tagNameAt(html, open + 1, close);
    index = close + 1;
    const end = html[open + 1] === "/" ? undefined : RAW_TEXT_END.get(name);
    if (end !== undefined) {
      end.lastIndex = index;
      const match = end.exec(html);
      const endClose = match === null ? -1 : html.indexOf(">", match.index);
      if (endClose === -1) {
        complete = false;
        break;
      }
      index = endClose + 1;
    }
  }
  flush();
  return { segments, complete };
}

function positionsOf(segments: readonly string[], value: string): number[] {
  const positions: number[] = [];
  segments.forEach((segment, index) => {
    if (segment === value) positions.push(index);
  });
  return positions;
}

/** `YYYY-MM-DD HH:MM` in Warsaw → instant, or null (format, calendar, DST gap/overlap). */
function parseWarsawDeadline(value: string): Date | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null) return null;
  const part = (index: number) => Number(match[index]);
  return warsawLocalToUtc({
    year: part(1),
    month: part(2),
    day: part(3),
    hour: part(4),
    minute: part(5),
  });
}

/**
 * Pure and deterministic. Outcomes:
 * - an unclosed tag, comment, `<script>` or `<style>` anywhere, or section 3.1
 *   missing, repeated or empty → `invalid source fields: htmlBody`;
 * - the changed notice is not a contract notice → none / `not_contract_notice_change`;
 * - no "8.1. Termin składania ofert" change → none / `no_deadline_change`;
 * - more than one such change → `ambiguous deadline change`;
 * - its "Po zmianie" value missing, repeated, not exactly `YYYY-MM-DD HH:MM`,
 *   not a real date/time, or not a single instant in Warsaw (DST) →
 *   `invalid value: deadline`;
 * - otherwise the new deadline.
 */
export function extractDeadlineChange(htmlBody: string): DeadlineChangeResult {
  const { segments, complete } = textSegments(htmlBody);
  if (!complete) return { ok: false, reason: "invalid source fields: htmlBody" };
  const kindLabels = positionsOf(segments, CHANGED_KIND_LABEL);
  const [kindLabel] = kindLabels;
  const kind = kindLabel === undefined ? undefined : segments[kindLabel + 1];
  if (kindLabels.length !== 1 || kind === undefined) {
    return { ok: false, reason: "invalid source fields: htmlBody" };
  }
  if (kind !== CONTRACT_NOTICE_KIND) {
    return { ok: true, change: { kind: "none", reason: "not_contract_notice_change" } };
  }

  const headings = positionsOf(segments, CHANGE_HEADING);
  const deadlineChanges = headings.filter((heading) => segments[heading + 1] === DEADLINE_LABEL);
  const [deadlineChange] = deadlineChanges;
  if (deadlineChange === undefined) {
    return { ok: true, change: { kind: "none", reason: "no_deadline_change" } };
  }
  if (deadlineChanges.length > 1) return { ok: false, reason: "ambiguous deadline change" };

  // The change runs up to the next change heading (or the end of the body).
  const nextHeading = headings.find((heading) => heading > deadlineChange) ?? segments.length;
  const change = segments.slice(deadlineChange + 2, nextHeading);
  const newValueLabels = positionsOf(change, NEW_VALUE_LABEL);
  const [newValueLabel] = newValueLabels;
  const value = newValueLabel === undefined ? undefined : change[newValueLabel + 1];
  const deadline =
    newValueLabels.length === 1 && value !== undefined ? parseWarsawDeadline(value) : null;
  if (deadline === null) return { ok: false, reason: "invalid value: deadline" };
  return { ok: true, change: { kind: "deadline", deadline } };
}
