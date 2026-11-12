import type {
  Opportunity,
  OpportunityContact,
  OpportunityLocation,
} from "../domain/opportunity.js";
import { CATEGORY_LABELS } from "../domain/vocabulary.js";
import { formatReason } from "../matching/format.js";
import type { MatchReason } from "../matching/match.js";
import { ATTRIBUTION_LABEL, BK_SOURCE_ID, bkAttribution } from "../sources/bk/attribution.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";
import { warsawWallTime, type WarsawLocalTime } from "../sources/normalize/warsaw-time.js";
import { cleanText } from "../sources/normalize/whitespace.js";

/**
 * The offer card (PR-11): one matched offer as the customer sees it, built
 * once and rendered by the digest's text and HTML parts, /dopasowania and
 * /przyklad, so the four cannot show different content (PR-11 AC3). Pure: no
 * I/O, no clock — `now` (the render time) is passed in, because the deadline
 * line counts days from it. Only what the source published is shown; a
 * missing value is "nie podano", never 0 or a guess. Values are cleaned
 * (`cleanText`), not escaped: each renderer escapes for its own format.
 */

/** One matched offer and why it matched (matchOpportunity's reasons). */
export interface MatchedOffer {
  readonly offer: Opportunity;
  readonly reasons: readonly MatchReason[];
}

/** One labelled line of a card. */
export interface CardRow {
  readonly label: string;
  readonly value: string;
  /** The deadline is 0–2 Polish calendar days away: shown with URGENT_WORD before the value. */
  readonly urgent: boolean;
}

/**
 * The card in the order every renderer shows it, so the four views cannot
 * differ (PR-11 AC3) and the first screen of a 390 px phone answers "how
 * much, until when, why me" (owner's review of PR #17, D-030):
 *
 * 1. `title`;
 * 2. `lead`: value, deadline, "Dlaczego pasuje" and — only without a usable
 *    link — "Link: nie podano", where the button would be;
 * 3. the "Otwórz ogłoszenie" button (e-mail text: line) to `url`;
 * 4. `body`: buyer, location, the description excerpt (when given; the web
 *    unfolds `fullDescription` under it) and the source attribution (Baza
 *    Konkurencyjności only) — always visible, as its terms require;
 * 5. `more`: the publication date and the contact (when given), then
 *    `matchDetails` — folded into one <details> on the web, the small last
 *    lines of the e-mail (mail clients do not all support <details>).
 */
export interface OfferCard {
  readonly title: string;
  readonly lead: readonly CardRow[];
  /** The source link, http(s) only; null when the stored URL is anything else. */
  readonly url: string | null;
  readonly body: readonly CardRow[];
  /** The whole description, only when the excerpt had to cut it (web only; the e-mail keeps the excerpt). */
  readonly fullDescription: string | null;
  readonly more: readonly CardRow[];
  /** CPV codes and the technical reasons ("Szczegóły dopasowania"), each one item. */
  readonly matchDetails: readonly string[];
}

export const NOT_GIVEN = "nie podano";
export const VALUE_LABEL = "Wartość szacunkowa";
export const DEADLINE_LABEL = "Termin składania ofert";
export const WHY_LABEL = "Dlaczego pasuje";
export const DESCRIPTION_LABEL = "Opis";
export const LINK_LABEL = "Link";
/** The button (web, e-mail HTML) and the line (e-mail text) that open the source. */
export const OPEN_LABEL = "Otwórz ogłoszenie";
export const FULL_DESCRIPTION_LABEL = "Pełny opis";
export const MATCH_DETAILS_LABEL = "Szczegóły dopasowania";
/** The web's one disclosure: the `more` rows and the match details. */
export const MORE_LABEL = "Więcej szczegółów";
/** Before a deadline 0–2 days away, so it is seen without reading the date. */
export const URGENT_WORD = "PILNE";
/** Days (Polish calendar) up to which a deadline is URGENT_WORD. */
const URGENT_DAYS = 2;

/** "Szczegóły dopasowania" for a CPV code outside the MVP vocabulary (category_unverifiable). */
export const CPV_OUTSIDE_VOCABULARY =
  "kod CPV spoza naszej listy kategorii — kategorii nie da się sprawdzić";

/** Longest description excerpt, in characters (graphemes). */
export const SNIPPET_MAX_CHARS = 300;
/** CPV codes shown per offer; the rest are counted. */
const CPV_CODES_SHOWN = 5;

/**
 * Neither source says whether its value is net or gross (D-030): BZP's
 * "Wartość zamówienia" and the Baza Konkurencyjności's sum carry no marker,
 * so the card says so instead of guessing.
 */
const VALUE_BASIS = "(źródło nie podaje, netto czy brutto)";

/** Polish plural form for `count`: one, few (2–4, not 12–14), many. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

const graphemes = new Intl.Segmenter("pl", { granularity: "grapheme" });

/** At most `max` characters (graphemes); longer text is cut at a word boundary and ends with "…". */
export function snippet(value: string, max: number = SNIPPET_MAX_CHARS): string {
  const chars = Array.from(graphemes.segment(cleanText(value)), (part) => part.segment);
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // A boundary far back would waste most of the snippet: cut mid-word then.
  const head = lastSpace >= cut.length * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/** The stored amount: a non-negative decimal string (decimalAmountSchema). */
const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * "120 000,00 PLN": thousands grouped with a no-break space (U+00A0, so the
 * amount never wraps), a decimal comma, at least two decimals. Built from the
 * stored string digit by digit, never through a floating-point number; a
 * fraction longer than two digits keeps its significant digits (rounding
 * would change the published amount).
 */
export function formatAmount(value: string, currency: string): string {
  const match = DECIMAL_AMOUNT.exec(value);
  if (match === null) return cleanText(`${value} ${currency}`);
  const [, integer = "", fraction = ""] = match;
  const grouped = integer.replace(/\B(?=(?:\d{3})+$)/g, " ");
  const digits = Math.max(2, fraction.replace(/0+$/, "").length);
  return `${grouped},${fraction.padEnd(digits, "0").slice(0, digits)} ${cleanText(currency)}`;
}

/** The "Wartość szacunkowa" value: the amount and that its basis is unknown, or "nie podano". */
export function formatValue(value: string | null, currency: string | null): string {
  if (value === null || currency === null) return NOT_GIVEN;
  return `${formatAmount(value, currency)} ${VALUE_BASIS}`;
}

/** Weekday abbreviations by `Date#getUTCDay()` (0 = Sunday): fixed, not locale data. */
const WEEKDAYS = ["nd", "pn", "wt", "śr", "czw", "pt", "sob"] as const;
const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The Warsaw calendar day of a wall time as a UTC midnight, for whole-day differences. */
function calendarDay(local: WarsawLocalTime): number {
  return Date.UTC(local.year, local.month - 1, local.day);
}

/** `DD.MM.YYYY` in Poland's time. */
export function formatPolishDay(instant: Date): string {
  const local = warsawWallTime(instant);
  return `${pad2(local.day)}.${pad2(local.month)}.${String(local.year)}`;
}

/** `DD.MM` in Poland's time (the subject's nearest deadline). */
export function formatPolishDayMonth(instant: Date): string {
  const local = warsawWallTime(instant);
  return `${pad2(local.day)}.${pad2(local.month)}`;
}

export interface DeadlineText {
  /** "18.11.2026 (śr) 10:00 — za 12 dni", "… — jutro", "… — dziś", "… — minął" or "nie podano". */
  readonly text: string;
  readonly urgent: boolean;
}

/**
 * The deadline in Poland's time with its distance from `now` in Polish
 * calendar days (the deadline's day minus today's, both in Warsaw, so a DST
 * change or the hour does not shift it): 0 "dziś", 1 "jutro", then "za N dni".
 * A deadline before `now` — also earlier today — "minął". Not passed and at
 * most URGENT_DAYS away: urgent. Intl only converts the time zone; the
 * weekday comes from the fixed table.
 */
export function formatDeadline(deadline: Date | null, now: Date): DeadlineText {
  if (deadline === null) return { text: NOT_GIVEN, urgent: false };
  const local = warsawWallTime(deadline);
  const day = calendarDay(local);
  const days = Math.round((day - calendarDay(warsawWallTime(now))) / DAY_MS);
  const passed = deadline.getTime() < now.getTime();
  const distance = passed
    ? "minął"
    : days === 0
      ? "dziś"
      : days === 1
        ? "jutro"
        : `za ${String(days)} dni`;
  const weekday = WEEKDAYS[new Date(day).getUTCDay()] ?? "";
  return {
    text:
      `${pad2(local.day)}.${pad2(local.month)}.${String(local.year)} (${weekday}) ` +
      `${pad2(local.hour)}:${pad2(local.minute)} — ${distance}`,
    urgent: !passed && days <= URGENT_DAYS,
  };
}

function formatLocation(location: OpportunityLocation | null): string {
  if (location === null) return NOT_GIVEN;
  const parts = [
    location.city,
    location.county === undefined ? undefined : `powiat ${location.county}`,
    location.voivodeship === undefined ? undefined : `woj. ${location.voivodeship}`,
  ].filter((part): part is string => part !== undefined);
  if (parts.length > 0) return parts.join(", ");
  return location.raw ?? NOT_GIVEN;
}

function formatContact(contact: OpportunityContact | null): string | null {
  if (contact === null) return null;
  const parts = [contact.name, contact.email, contact.phone].filter(
    (part): part is string => part !== undefined,
  );
  if (parts.length > 0) return parts.join(", ");
  return contact.raw ?? null;
}

/** The source link when it is http(s); anything else (e.g. `javascript:`) is not shown. */
export function safeLink(value: string): string | null {
  const url = URL.parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
}

/**
 * "Dlaczego pasuje" as one sentence of its human parts, joined with " · ":
 * the profile's categories the offer has (their names), each keyword found
 * and where, and the matching region — "Elektryka · słowo „oświetlenie” w
 * tytule · mazowieckie". Presentation only: the reasons and their points
 * stay as matchOpportunity made them. A matched offer always has a category
 * or a keyword (MATCH_THRESHOLD); should none be there, the technical
 * reasons are shown rather than an empty line.
 */
export function whySentence(reasons: readonly MatchReason[]): string {
  const parts = reasons.flatMap((reason): string[] => {
    switch (reason.kind) {
      case "category":
        return reason.hits.map((hit) => CATEGORY_LABELS[hit.category]);
      case "keyword":
        return [`słowo „${reason.keyword}” w ${reason.field === "title" ? "tytule" : "opisie"}`];
      case "region_match":
        return [reason.via === "county" ? `powiat ${reason.value}` : reason.value];
      case "category_mismatch":
      case "category_unverifiable":
      case "more_keywords":
      case "exclude":
      case "region_unrestricted":
      case "region_mismatch":
      case "region_unknown":
        return [];
    }
  });
  if (parts.length > 0) return parts.join(" · ");
  const technical = technicalReasons(reasons);
  return technical.length > 0 ? technical.join(" · ") : NOT_GIVEN;
}

/**
 * The reasons whySentence leaves out, in the customer's wording (category
 * names, not keys). The card words two of them itself rather than through
 * formatReason, whose wording stays for `match:preview` (the operator's
 * view): more keywords is left out (the keywords are each in "Dlaczego
 * pasuje" already) and a CPV code outside the vocabulary is said in plain
 * Polish.
 */
function technicalReasons(reasons: readonly MatchReason[]): string[] {
  return reasons.flatMap((reason): string[] => {
    switch (reason.kind) {
      case "category":
      case "keyword":
      case "region_match":
      case "more_keywords":
        return [];
      case "category_unverifiable":
        // The codes are the "CPV:" item already.
        return reason.cpvCodes.length === 0 ? [formatReason(reason)] : [CPV_OUTSIDE_VOCABULARY];
      case "category_mismatch":
      case "exclude":
      case "region_unrestricted":
      case "region_mismatch":
      case "region_unknown":
        return [formatReason(reason, { categoryLabels: CATEGORY_LABELS })];
    }
  });
}

/**
 * "Szczegóły dopasowania": the offer's other categories (names; those that
 * matched are in the "Dlaczego pasuje" sentence, those of a category
 * mismatch in its reason), its CPV codes (the first CPV_CODES_SHOWN, the
 * rest counted) and the technical reasons (region unknown or outside, CPV
 * outside the vocabulary, a category mismatch …).
 */
export function matchDetails(offer: Opportunity, reasons: readonly MatchReason[]): string[] {
  const items: string[] = [];
  const named = new Set(
    reasons.flatMap((reason) =>
      reason.kind === "category"
        ? reason.hits.map((hit) => hit.category)
        : reason.kind === "category_mismatch"
          ? reason.offerCategories
          : [],
    ),
  );
  const others = mvpCategoriesForCpv(offer.categories)
    .filter((category) => !named.has(category))
    .map((category) => CATEGORY_LABELS[category]);
  if (others.length > 0) {
    const label = plural(
      others.length,
      "Inna kategoria ogłoszenia",
      "Inne kategorie ogłoszenia",
      "Inne kategorie ogłoszenia",
    );
    // Names contain commas: "; " keeps them apart.
    items.push(`${label}: ${others.join("; ")}`);
  }
  if (offer.categories.length > 0) {
    const shown = offer.categories.slice(0, CPV_CODES_SHOWN).join(", ");
    const more = offer.categories.length - CPV_CODES_SHOWN;
    items.push(
      `CPV: ${shown}${more > 0 ? ` i ${String(more)} ${plural(more, "inny", "inne", "innych")}` : ""}`,
    );
  }
  items.push(...technicalReasons(reasons));
  return items.map(cleanText);
}

/**
 * The attribution the Baza Konkurencyjności's terms of reuse require with each
 * of its offers (D-030). Other sources need none (BZP: D-015).
 */
function sourceAttribution(offer: Opportunity): string | null {
  return offer.sourceId === BK_SOURCE_ID ? bkAttribution(offer.fetchedAt) : null;
}

function row(label: string, value: string, urgent = false): CardRow {
  return { label, value, urgent };
}

/** One matched offer as a card, its deadline counted from `now` (the render time). */
export function offerCard({ offer, reasons }: MatchedOffer, now: Date): OfferCard {
  const deadline = formatDeadline(offer.deadline, now);
  const url = safeLink(offer.sourceUrl);
  // Stored text is clean already; cleaning again keeps a line break or a
  // control character out of the e-mail whatever the row holds.
  const lead: CardRow[] = [
    // Built from validated digits and a currency code; holds a no-break space on purpose.
    row(VALUE_LABEL, formatValue(offer.estimatedValue, offer.currency)),
    row(DEADLINE_LABEL, deadline.text, deadline.urgent),
    row(WHY_LABEL, cleanText(whySentence(reasons))),
  ];
  if (url === null) lead.push(row(LINK_LABEL, NOT_GIVEN));
  const body: CardRow[] = [
    row("Zamawiający", cleanText(offer.issuerName)),
    row("Lokalizacja", cleanText(formatLocation(offer.location))),
  ];
  const description = offer.description === null ? "" : cleanText(offer.description);
  const excerpt = snippet(description);
  if (excerpt !== "") body.push(row(DESCRIPTION_LABEL, excerpt));
  const attribution = sourceAttribution(offer);
  if (attribution !== null) body.push(row(ATTRIBUTION_LABEL, attribution));
  const more: CardRow[] = [
    row(
      "Data publikacji",
      offer.publishedAt === null ? NOT_GIVEN : formatPolishDay(offer.publishedAt),
    ),
  ];
  const contact = formatContact(offer.contact);
  if (contact !== null) more.push(row("Kontakt", cleanText(contact)));
  return {
    title: cleanText(offer.title),
    lead,
    url,
    body,
    fullDescription: excerpt !== description ? description : null,
    more,
    matchDetails: matchDetails(offer, reasons),
  };
}
