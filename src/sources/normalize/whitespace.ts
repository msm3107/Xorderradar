/**
 * Whitespace helpers shared by source adapters (pure, no I/O). `\s` with the
 * `u` flag covers every Unicode space, including NBSP (U+00A0) and the narrow
 * NBSP (U+202F) used as thousands separators.
 */

/** Every run of whitespace → one space; leading/trailing whitespace removed. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Control characters (`\p{Cc}`: C0, DEL and C1, including NEL U+0085): never
 * part of stored text (NUL is also refused by PostgreSQL text). They become a
 * space, as a raw tab or a line break inside one stored line would.
 */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Invisible format characters that could reorder or hide stored text when it
 * is shown: bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069) and zero-width characters (U+200B–U+200D, U+2060, U+FEFF).
 * Removed without a trace, so a word they sit inside stays one word.
 */
const INVISIBLE_FORMAT_CHARACTERS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/**
 * Text for storage: invisible format characters removed, control characters
 * become spaces (a decoded `&#7;` or a raw tab must not end up inside a stored
 * line), then whitespace is collapsed.
 */
export function cleanText(value: string): string {
  return collapseWhitespace(
    value.replace(INVISIBLE_FORMAT_CHARACTERS, "").replace(CONTROL_CHARACTERS, " "),
  );
}
