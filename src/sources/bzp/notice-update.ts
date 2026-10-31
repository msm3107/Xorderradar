import type { NoticeUpdateChange } from "../../domain/notice-update.js";
import { textSegments } from "../normalize/html-text.js";
import { warsawLocalToUtc } from "../normalize/warsaw-time.js";

/**
 * Reads the one change ingestion applies from the `htmlBody` of a BZP
 * "Ogłoszenie o zmianie ogłoszenia" (NoticeUpdateNotice, D-015): the new offer
 * deadline ("8.1. Termin składania ofert" → "Po zmianie") of a changed
 * contract notice. Nothing else in the body is read, and no text from it is
 * ever returned except that parsed instant.
 *
 * The body is untrusted markup of up to the adapter's bound (1 000 000
 * characters). It is split into text segments by the shared linear scanner
 * (`../normalize/html-text.ts`); every step here is a single pass over those
 * segments with bounded patterns on short segments only.
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
