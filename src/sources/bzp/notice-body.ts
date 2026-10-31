import { emailSchema, text } from "../../domain/common.js";
import {
  contactSchema,
  currencySchema,
  decimalAmountSchema,
  type OpportunityContact,
} from "../../domain/opportunity.js";
import { textSegments } from "../normalize/html-text.js";
import { cleanText } from "../normalize/whitespace.js";

/**
 * Reads the offer details the list API only publishes inside the `htmlBody`
 * of a contract notice or a small contract (D-022): the short description,
 * the buyer's contact (e-mail, phone) and the estimated value with its
 * currency. Only these values leave this module — never the markup and never
 * any other text of the body.
 *
 * The body is untrusted markup of up to the adapter's bound (1 000 000
 * characters). It is split by the shared linear scanner
 * (`../normalize/html-text.ts`); after that each field is one forward pass
 * over the segments, collecting a bounded amount of text, and every regular
 * expression runs on a bounded string only (a 40-character prefix or a
 * bounded value block). A body that cannot be read (unclosed construct) gives
 * no details; it never rejects the notice — every other field still maps.
 */

export type BzpOpportunityNoticeType = "ContractNotice" | "SmallContractNotice";

/** The values read from `htmlBody`; each is null when not published or unusable. */
export interface BzpNoticeDetails {
  readonly description: string | null;
  readonly contact: OpportunityContact | null;
  readonly estimatedValue: string | null;
  readonly currency: string | null;
}

export const NO_DETAILS: BzpNoticeDetails = {
  description: null,
  contact: null,
  estimatedValue: null,
  currency: null,
};

interface NoticeLabels {
  readonly description: string;
  readonly phone: string;
  readonly email: string;
  readonly value: string;
  /** Separate currency field; null when the form puts the code next to the value. */
  readonly currency: string | null;
}

/**
 * Form labels as published (fixtures 2026-10-29), without their trailing
 * colon: a label matches with or without one. Contract notices
 * ("Ogłoszenie o zamówieniu", section numbering 1.5./4.x) and small contracts
 * ("Ogłoszenie o zamówieniu… bez stosowania ustawy", 1.4./3.x) number the same
 * fields differently.
 */
const LABELS: Readonly<Record<BzpOpportunityNoticeType, NoticeLabels>> = {
  ContractNotice: {
    description: "4.2.2.) Krótki opis przedmiotu zamówienia",
    phone: "1.5.7.) Numer telefonu",
    email: "1.5.9.) Adres poczty elektronicznej",
    value: "4.1.5.) Wartość zamówienia",
    currency: null,
  },
  SmallContractNotice: {
    description: "3.3.) Krótki opis przedmiotu zamówienia",
    phone: "1.4.7.) Numer telefonu",
    email: "1.4.9.) Adres poczty elektronicznej",
    value: "3.4.) Wartość",
    currency: "3.5) Kod waluty",
  },
};

/**
 * Start of a numbered form label ("4.2.6.) Główny kod CPV:", "3.5) Kod
 * waluty:", "1.4) Krajowy Numer…"): at least two dotted numbers, then `)`.
 * Description lines such as "1. …", "2.1 Projekt…", "1) ST…" or "14.1.Wykonawca…"
 * do not match. Tested on a 40-character prefix only.
 */
const FORM_LABEL = /^(\d{1,3}(?:\.\d{1,3})+)\.?\)(?:\s|$)/;
/** Section headings ("SEKCJA IV – PRZEDMIOT ZAMÓWIENIA") also end a field. */
const SECTION_HEADING = /^SEKCJA\s/;

/** The number of a form label ("4.2.6.) …" → [4, 2, 6]), or null for any other segment. */
function labelNumber(segment: string): readonly number[] | null {
  const number = FORM_LABEL.exec(segment.slice(0, 40))?.[1];
  return number === undefined ? null : number.split(".").map(Number);
}

/** Numeric lexicographic order: [4, 2, 10] > [4, 2, 6] > [4, 2] > [3, 5]. */
function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * Whether `segment` ends the field of the label numbered `own`: a section
 * heading, or a form label numbered the same (the label repeated, e.g. the next
 * part) or higher — within the fields read, the form numbers its labels in
 * increasing order (after 4.2.2 comes 4.2.6, after 3.3 comes 3.4/3.5). A lower
 * number ("1.1)", "2.1.)" inside 4.2.2.) is a numbered line of the field's own
 * text, not the next label. Without an own number, every form label is a boundary.
 */
function isBoundary(segment: string, own: readonly number[] | null): boolean {
  if (SECTION_HEADING.test(segment.slice(0, 40))) return true;
  const number = labelNumber(segment);
  return number !== null && (own === null || compareNumbers(number, own) >= 0);
}

function isLabel(segment: string, label: string): boolean {
  return segment === label || segment === `${label}:`;
}

/** Stored description bound (`description: text(10_000)`). */
const MAX_DESCRIPTION_LENGTH = 10_000;
/** Contact bounds: `contact.phone` text(50), `contact.raw` text(500). */
const MAX_PHONE_LENGTH = 50;
const MAX_CONTACT_RAW_LENGTH = 500;
/** No value block of a well-formed notice comes near this; a longer one is unusable. */
const MAX_VALUE_BLOCK_LENGTH = 100;
const MAX_CURRENCY_BLOCK_LENGTH = 10;

/**
 * The cleaned segments of the field starting after `segments[label]`, up to
 * the next boundary (`isBoundary`). Collection stops once their total
 * length (joined with one separator) exceeds `maxLength`, or at a segment
 * longer than that (`overflow`: text was left out; the caller decides what
 * that means), so the work is bounded by the field, not by the body.
 */
function fieldLines(
  segments: readonly string[],
  label: number,
  maxLength: number,
): { readonly lines: string[]; readonly overflow: boolean; readonly end: number } {
  const own = labelNumber(segments[label] ?? "");
  const lines: string[] = [];
  let length = 0;
  let index = label + 1;
  for (; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    if (isBoundary(segment, own)) break;
    // Only a bounded prefix of a longer segment is ever cleaned; it overflows anyway.
    const long = segment.length > maxLength;
    const line = cleanText(long ? segment.slice(0, maxLength + 1) : segment);
    if (line !== "") {
      lines.push(line);
      length += line.length + 1;
    }
    if (long || length > maxLength + 1) return { lines, overflow: true, end: index };
  }
  return { lines, overflow: false, end: index };
}

/** The field as one line (parts joined by a space), or null when empty or over `maxLength`. */
function singleLineField(
  segments: readonly string[],
  label: number,
  maxLength: number,
): string | null {
  const { lines, overflow } = fieldLines(segments, label, maxLength);
  const value = lines.join(" ");
  return overflow || value === "" || value.length > maxLength ? null : value;
}

function labelPositions(segments: readonly string[], label: string): number[] {
  const positions: number[] = [];
  segments.forEach((segment, index) => {
    if (isLabel(segment, label)) positions.push(index);
  });
  return positions;
}

/** Cut at the last whitespace before the bound, never inside a surrogate pair, then "…". */
function truncateDescription(value: string): string {
  let cut = value.slice(0, MAX_DESCRIPTION_LENGTH - 1);
  const lastSpace = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  else if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const descriptionSchema = text(MAX_DESCRIPTION_LENGTH);

/**
 * Every occurrence of the description label (a notice in parts repeats it per
 * part), in order, separated by a blank line; inside one occurrence each text
 * segment is a line. Longer than the stored bound → cut at a word boundary
 * with "…". None, empty or not storable (e.g. a lone surrogate) → null.
 */
function descriptionOf(segments: readonly string[], label: string): string | null {
  const parts: string[] = [];
  let length = 0;
  let overflow = false;
  for (let index = 0; index < segments.length && !overflow; index++) {
    if (!isLabel(segments[index] ?? "", label)) continue;
    // Clamped: after a part that filled the bound exactly, any further text overflows.
    const field = fieldLines(segments, index, Math.max(0, MAX_DESCRIPTION_LENGTH - length));
    if (field.lines.length > 0) {
      const part = field.lines.join("\n");
      parts.push(part);
      length += part.length + 2;
    }
    overflow = field.overflow || length > MAX_DESCRIPTION_LENGTH + 2;
    index = field.end - 1;
  }
  if (parts.length === 0) return null;
  const joined = parts.join("\n\n");
  const description =
    overflow || joined.length > MAX_DESCRIPTION_LENGTH ? truncateDescription(joined) : joined;
  const result = descriptionSchema.safeParse(description);
  return result.success ? result.data : null;
}

const phoneSchema = text(MAX_PHONE_LENGTH);

/**
 * The buyer's e-mail and phone, from the first occurrence of each label only
 * (a joint procurement lists further buyers after the first; the first is the
 * one running the procedure). A valid e-mail → `email` (lower case), a phone
 * of at most 50 characters → `phone`; anything else published there →
 * `raw` ("; "-separated). A phone field without a single digit ("-", "brak")
 * carries no number and is dropped, not kept in `raw`. A value that would not
 * fit `raw` (500) is left out rather than cut. Neither published → null. No
 * name is read: the form has none for the buyer, and nothing is enriched from
 * elsewhere.
 */
function contactOf(segments: readonly string[], labels: NoticeLabels): OpportunityContact | null {
  const emailLabel = segments.findIndex((segment) => isLabel(segment, labels.email));
  const phoneLabel = segments.findIndex((segment) => isLabel(segment, labels.phone));
  const email =
    emailLabel === -1 ? null : singleLineField(segments, emailLabel, MAX_CONTACT_RAW_LENGTH);
  const phone =
    phoneLabel === -1 ? null : singleLineField(segments, phoneLabel, MAX_CONTACT_RAW_LENGTH);
  const contact: { email?: string; phone?: string; raw?: string } = {};
  const raw: string[] = [];
  const addRaw = (value: string) => {
    const joined = [...raw, value].join("; ");
    if (joined.length <= MAX_CONTACT_RAW_LENGTH) raw.push(value);
  };
  if (email !== null) {
    const parsed = emailSchema.safeParse(email);
    if (parsed.success) contact.email = parsed.data;
    else addRaw(email);
  }
  if (phone !== null && /\d/.test(phone)) {
    const parsed = phoneSchema.safeParse(phone);
    if (parsed.success) contact.phone = parsed.data;
    else addRaw(phone);
  }
  if (raw.length > 0) contact.raw = raw.join("; ");
  const result = contactSchema.safeParse(contact);
  return result.success ? result.data : null;
}

/**
 * An amount as published: digits, optionally in groups of three separated by a
 * space (NBSP and narrow NBSP are collapsed to a space before), an optional
 * fraction of 1, 2 or 4 digits after "," or ".", and an optional currency code.
 * A fraction of exactly three digits is refused: "1.500" or "1,500" may just
 * as well be a thousands separator, and reading it wrong would publish a value
 * a thousand times off. Applied to a bounded block only.
 */
const AMOUNT = /^([1-9]\d{0,2}(?: \d{3})+|\d{1,18})(?:[.,](\d{1,2}|\d{4}))?(?: ([A-Z]{3}))?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Currency from the separate field: undefined when the form has none, null when unusable. */
function separateCurrency(
  segments: readonly string[],
  label: string | null,
): string | null | undefined {
  if (label === null) return undefined;
  const positions = labelPositions(segments, label);
  const [position] = positions;
  if (position === undefined) return undefined;
  if (positions.length > 1) return null;
  const value = singleLineField(segments, position, MAX_CURRENCY_BLOCK_LENGTH);
  return value !== null && CURRENCY_CODE.test(value) ? value : null;
}

const NO_VALUE = { estimatedValue: null, currency: null } as const;

/**
 * The estimated value and its currency, both or neither (D-022): exactly one
 * value label, its block in the strict AMOUNT format, and exactly one
 * currency — the code in the block and/or the separate currency field, which
 * must agree. Missing, repeated, malformed, ambiguous or out of the
 * `decimalAmountSchema` range → both null; nothing is rounded or guessed, and
 * an unpublished value is never 0. A published zero ("0", "0,00") carries no
 * information and may be a filler, so it is treated as not given: null as
 * well (MASTER_PROMPT §9).
 */
function valueOf(
  segments: readonly string[],
  labels: NoticeLabels,
): { readonly estimatedValue: string | null; readonly currency: string | null } {
  const positions = labelPositions(segments, labels.value);
  const [position] = positions;
  if (position === undefined || positions.length > 1) return NO_VALUE;
  const block = singleLineField(segments, position, MAX_VALUE_BLOCK_LENGTH);
  const match = block === null ? null : AMOUNT.exec(block);
  if (match === null) return NO_VALUE;
  const [, integer = "", fraction, blockCurrency] = match;
  const digits = integer.replaceAll(" ", "").replace(/^0+(?=\d)/, "");
  if (digits === "0" && !/[1-9]/.test(fraction ?? "")) return NO_VALUE;
  const separate = separateCurrency(segments, labels.currency);
  if (separate === null) return NO_VALUE;
  if (blockCurrency !== undefined && separate !== undefined && blockCurrency !== separate) {
    return NO_VALUE;
  }
  const currency = blockCurrency ?? separate;
  if (currency === undefined) return NO_VALUE;
  const amount = fraction === undefined ? digits : `${digits}.${fraction}`;
  const value = decimalAmountSchema.safeParse(amount);
  const code = currencySchema.safeParse(currency);
  return value.success && code.success
    ? { estimatedValue: value.data, currency: code.data }
    : NO_VALUE;
}

/**
 * Pure and deterministic; never throws on any input string. An unclosed tag,
 * comment, `<script>` or `<style>` → NO_DETAILS (the rest of the body was not
 * read, so nothing in it can be trusted to be the whole field).
 */
export function extractNoticeDetails(
  noticeType: BzpOpportunityNoticeType,
  htmlBody: string,
): BzpNoticeDetails {
  const { segments, complete } = textSegments(htmlBody);
  if (!complete) return NO_DETAILS;
  const labels = LABELS[noticeType];
  return {
    description: descriptionOf(segments, labels.description),
    contact: contactOf(segments, labels),
    ...valueOf(segments, labels),
  };
}
