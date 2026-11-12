import type { MvpCategory } from "../domain/vocabulary.js";
import type { MatchReason, MatchField } from "./match.js";

/**
 * Polish, one-line explanations of match reasons (D-011: every result says
 * why). Pure. The text of keywords and regions is shown as stored; a caller
 * that prints to a terminal cleans the whole line (`cleanText`).
 */

export interface FormatReasonOptions {
  /**
   * Names shown for the MVP categories instead of their keys
   * (`CATEGORY_LABELS`): the customer's digest and web page. There a
   * category reason is the labels only, each in Polish quotes and joined
   * with ", " ("kategoria: „Elektryka”, „Serwis, naprawy i konserwacja”"):
   * labels contain commas themselves, the quotes say where one ends, and
   * "; " stays the separator between reasons. The CPV codes are left out
   * (the offer card's "Szczegóły dopasowania" show them, PR-11). Without it the keys are
   * shown with their codes (`match:preview`, the operator's view).
   */
  readonly categoryLabels?: Readonly<Record<MvpCategory, string>>;
}

const FIELD_NAMES: Readonly<Record<MatchField, string>> = {
  title: "tytuł",
  description: "opis",
};

const MISSING_REGION: Readonly<
  Record<Extract<MatchReason, { kind: "region_unknown" }>["missing"], string>
> = {
  location: "oferta nie podaje lokalizacji",
  voivodeship: "źródło nie podaje województwa",
  county: "źródło nie podaje powiatu",
  voivodeship_and_county: "źródło nie podaje województwa ani powiatu",
};

/**
 * One reason, e.g. "kategoria: elektryka (CPV 45310000-3)" or "słowo:
 * oświetlenie (tytuł)"; with `categoryLabels`, "kategoria: „Elektryka”".
 */
export function formatReason(reason: MatchReason, options: FormatReasonOptions = {}): string {
  const { categoryLabels } = options;
  const labelled = (keys: readonly MvpCategory[]): string | null =>
    categoryLabels === undefined ? null : keys.map((key) => `„${categoryLabels[key]}”`).join(", ");
  switch (reason.kind) {
    case "category":
      return `kategoria: ${
        labelled(reason.hits.map((hit) => hit.category)) ??
        reason.hits.map((hit) => `${hit.category} (CPV ${hit.cpvCodes.join(", ")})`).join(", ")
      }`;
    case "category_mismatch":
      return `kategoria: niezgodna (oferta: ${
        labelled(reason.offerCategories) ?? reason.offerCategories.join(", ")
      })`;
    case "category_unverifiable":
      return reason.cpvCodes.length === 0
        ? "kategoria: ogłoszenie nie podaje kodu CPV"
        : `CPV spoza słownika (${reason.cpvCodes.join(", ")}) — kategoria niesprawdzalna`;
    case "keyword":
      return `słowo: ${reason.keyword} (${FIELD_NAMES[reason.field]})`;
    case "more_keywords":
      return `więcej niż jedno słowo kluczowe (${String(reason.count)})`;
    case "exclude":
      return `wykluczone słowem: ${reason.keyword} (${FIELD_NAMES[reason.field]})`;
    case "region_unrestricted":
      return "region: bez ograniczeń";
    case "region_match":
      return reason.via === "county" ? `region: powiat ${reason.value}` : `region: ${reason.value}`;
    case "region_mismatch": {
      const offer = [
        reason.offerVoivodeship,
        reason.offerCounty === null ? null : `powiat ${reason.offerCounty}`,
      ].filter((part): part is string => part !== null);
      return `region: poza profilem (oferta: ${offer.join(", ")})`;
    }
    case "region_unknown": {
      const outside =
        reason.offerCounty === undefined ? [] : [`powiat ${reason.offerCounty} poza profilem`];
      // ", " inside one reason: "; " separates reasons (formatReasons).
      return `region: nieznany — ${[...outside, MISSING_REGION[reason.missing]].join(", ")}`;
    }
  }
}

/** All reasons in order, joined with "; " (only between reasons, never inside one). */
export function formatReasons(
  reasons: readonly MatchReason[],
  options: FormatReasonOptions = {},
): string {
  return reasons.map((reason) => formatReason(reason, options)).join("; ");
}
