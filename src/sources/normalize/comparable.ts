import { collapseWhitespace } from "./whitespace.js";

/** Combining marks (diacritics once decomposed). */
const MARKS = /\p{M}/gu;

/**
 * Text for comparisons only — never stored, never shown (D-022): lower case,
 * diacritics removed (`ą` → `a`, `ó` → `o`, …, and `ł` → `l`, which Unicode
 * does not decompose), whitespace collapsed. Pure.
 *
 * Marks already present are removed before decomposition: `normalize` sorts
 * a run of combining marks by an insertion sort (quadratic), so a hostile run
 * of thousands of marks must never reach it. After that, every character
 * decomposes into a base plus a few marks, so NFD is linear.
 */
export function comparableText(value: string): string {
  const decomposed = value.replace(MARKS, "").normalize("NFD").replace(MARKS, "");
  return collapseWhitespace(decomposed.toLowerCase().replace(/ł/gu, "l"));
}
