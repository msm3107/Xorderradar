import { collapseWhitespace } from "./whitespace.js";

/** Combining marks (diacritics once decomposed). */
const MARKS = /\p{M}/gu;

/**
 * Invisible format characters (`\p{Cf}`): the soft hyphen U+00AD that word
 * processors insert inside words ("oświe\u00adtlenie"), zero-width and bidi
 * characters, U+FEFF. They are not part of the word, so they are dropped
 * without a trace (PR-04, D-023).
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Text for comparisons only — never stored, never shown (D-022): lower case,
 * diacritics removed (`ą` → `a`, `ó` → `o`, …, and `ł` → `l`, which Unicode
 * does not decompose), format characters (`\p{Cf}`, e.g. the soft hyphen)
 * removed, whitespace collapsed. Pure.
 *
 * Linear in the input length, also for hostile input: marks already present
 * are removed before decomposition, because `normalize` sorts a run of
 * combining marks by an insertion sort (quadratic), so such a run must never
 * reach it. After that, every character decomposes into a base plus a few
 * marks, so NFD is linear. Lower-casing comes before NFD, because it can add a
 * mark of its own (`İ` → `i` + U+0307); every other step is one regular
 * replacement without backtracking.
 */
export function comparableText(value: string): string {
  const decomposed = value
    .replace(FORMAT_CHARACTERS, "")
    .replace(MARKS, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(MARKS, "");
  return collapseWhitespace(decomposed.replace(/ł/gu, "l"));
}
