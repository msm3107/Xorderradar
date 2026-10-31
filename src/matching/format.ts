import type { MatchReason, MatchField } from "./match.js";

/**
 * Polish, one-line explanations of match reasons (D-011: every result says
 * why). Pure. The text of keywords and regions is shown as stored; a caller
 * that prints to a terminal cleans the whole line (`cleanText`).
 */

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

/** One reason, e.g. "kategoria: elektryka (CPV 45310000-3)" or "słowo: oświetlenie (tytuł)". */
export function formatReason(reason: MatchReason): string {
  switch (reason.kind) {
    case "category":
      return `kategoria: ${reason.hits
        .map((hit) => `${hit.category} (CPV ${hit.cpvCodes.join(", ")})`)
        .join(", ")}`;
    case "category_mismatch":
      return `kategoria: niezgodna (oferta: ${reason.offerCategories.join(", ")})`;
    case "category_unverifiable":
      return reason.cpvCodes.length === 0
        ? "brak CPV — kategoria niesprawdzalna"
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

/** All reasons in order, joined with "; ". */
export function formatReasons(reasons: readonly MatchReason[]): string {
  return reasons.map(formatReason).join("; ");
}
