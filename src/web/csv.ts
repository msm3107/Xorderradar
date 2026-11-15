import type { Opportunity, OpportunityLocation } from "../domain/opportunity.js";
import { CATEGORY_LABELS } from "../domain/vocabulary.js";
import type { FeedbackVerdict } from "../infrastructure/db/schema.js";
import { safeLink } from "../notifications/card.js";
import { BK_SOURCE_ID, bkAttribution } from "../sources/bk/attribution.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";
import { formatWarsawMinute, warsawDay } from "../sources/normalize/warsaw-time.js";
import { verdictWord } from "./links.js";

/**
 * GET /dopasowania.csv (PR-12, D-032): the list of /dopasowania as a file a
 * spreadsheet opens — `;` between cells (a Polish Excel's list separator),
 * UTF-8 with a BOM (so Excel reads the Polish letters), CRLF lines, RFC 4180
 * quoting. Pure: the rows come from the same list as the page. A value the
 * source did not give is an empty cell, never 0 or „nie podano”.
 */

/** One offer of the list and the profile's rating of it (null: not rated). */
export interface CsvItem {
  readonly offer: Opportunity;
  readonly verdict: FeedbackVerdict | null;
}

export const CSV_HEADER = [
  "Tytuł",
  "Zamawiający",
  "Termin składania ofert (czas polski)",
  "Data publikacji",
  "Wartość szacunkowa",
  "Waluta",
  "Lokalizacja",
  "Kategorie",
  "Kody CPV",
  "Link",
  "Źródło",
  "Ocena",
] as const;

const BOM = "\uFEFF";
const SEPARATOR = ";";
const LINE_END = "\r\n";

/**
 * A spreadsheet runs a cell starting with one of these as a formula (CSV
 * injection, OWASP): such a cell gets a leading `'`, which shows it as text.
 * Source text is untrusted — a title may start with `=`.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A cell holding one of these is quoted (RFC 4180). */
const NEEDS_QUOTES = /[;"\r\n]/;

/**
 * The „Źródło” of a BZP offer. `bzp` is BZP_SOURCE_ID (sources/bzp/adapter.ts),
 * not imported: web takes nothing from the adapters' modules but pure helpers.
 */
const BZP_ID = "bzp";
const BZP_NAME = "Biuletyn Zamówień Publicznych";

/** The source column: the BK attribution its terms require (D-030), BZP's name, else empty. */
function source(offer: Opportunity): string {
  if (offer.sourceId === BK_SOURCE_ID) return bkAttribution(offer.fetchedAt);
  return offer.sourceId === BZP_ID ? BZP_NAME : "";
}

/** One cell: formula-neutralised, then quoted with doubled quotes when needed. */
export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(SEPARATOR) + LINE_END;
}

/** As on the card (city, county, voivodeship; else the published text); "" when none. */
function location(value: OpportunityLocation | null): string {
  if (value === null) return "";
  const parts = [
    value.city,
    value.county === undefined ? undefined : `powiat ${value.county}`,
    value.voivodeship === undefined ? undefined : `woj. ${value.voivodeship}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : (value.raw ?? "");
}

/** The stored decimal with a decimal comma (a Polish spreadsheet's number); never rounded. */
function amount(value: string | null): string {
  return value === null ? "" : value.replace(".", ",");
}

function row({ offer, verdict }: CsvItem): string[] {
  return [
    offer.title,
    offer.issuerName,
    offer.deadline === null ? "" : formatWarsawMinute(offer.deadline),
    offer.publishedAt === null ? "" : warsawDay(offer.publishedAt),
    amount(offer.estimatedValue),
    offer.currency ?? "",
    location(offer.location),
    mvpCategoriesForCpv(offer.categories)
      .map((category) => CATEGORY_LABELS[category])
      // Names contain commas (as on the card).
      .join("; "),
    offer.categories.join(", "),
    safeLink(offer.sourceUrl) ?? "",
    source(offer),
    verdict === null ? "" : verdictWord(verdict),
  ];
}

/** The whole file: BOM, the header and one line per item, in the given order. */
export function matchesCsv(items: readonly CsvItem[]): string {
  return BOM + csvLine(CSV_HEADER) + items.map((item) => csvLine(row(item))).join("");
}
