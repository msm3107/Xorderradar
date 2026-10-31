import { isWellFormedText } from "../../domain/common.js";
import { VOIVODESHIPS, type Voivodeship } from "../../domain/vocabulary.js";
import { comparableText } from "./comparable.js";
import { collapseWhitespace } from "./whitespace.js";

// The list itself is in the domain (D-023), next to the profile schema that validates against it.
export { VOIVODESHIPS, type Voivodeship };

/** Comparable form (no diacritics, `ł` → `l`) → canonical name. */
const BY_COMPARABLE = new Map<string, Voivodeship>(
  VOIVODESHIPS.map((name) => [comparableText(name), name]),
);

/** Longer input is never a voivodeship name (with prefix and spacing); not even compared. */
const MAX_REGION_INPUT_LENGTH = 100;

const VOIVODESHIP_PREFIX = /^(?:wojewodztwo\s+|woj\.\s*|woj\s+)/u;

/**
 * A voivodeship as written by a user or a source → its canonical name, or
 * null when it is not one of the 16 (never a guess, no fuzzy matching).
 * Accepts any letter case, a "woj." / "województwo" prefix, missing Polish
 * letters ("slaskie", "lodzkie") and spaces around the hyphen
 * ("kujawsko - pomorskie").
 */
export function normalizeVoivodeship(value: string): Voivodeship | null {
  if (value.length > MAX_REGION_INPUT_LENGTH) return null;
  const key = comparableText(value)
    .replace(VOIVODESHIP_PREFIX, "")
    .replace(/\s*-\s*/gu, "-");
  return BY_COMPARABLE.get(key) ?? null;
}

const COUNTY_PREFIX = /^(?:powiat(?:\s+|$)|pow\.\s*)/iu;

/**
 * A county name in one written form — "powiat" / "pow." prefix removed,
 * whitespace collapsed, lower case, Polish letters kept — for comparing a
 * customer profile with stored locations (PR-04). There is no county
 * dictionary (YAGNI, D-022): the result is not checked against the 380
 * counties, and nothing is derived; empty or overlong input → null. BZP never
 * publishes a county (NUTS 3 is a subregion), so `location.county` stays empty
 * for BZP offers.
 */
export function normalizeCounty(value: string): string | null {
  if (value.length > MAX_REGION_INPUT_LENGTH || !isWellFormedText(value)) return null;
  const name = collapseWhitespace(collapseWhitespace(value).replace(COUNTY_PREFIX, ""));
  return name === "" ? null : name.toLowerCase();
}
