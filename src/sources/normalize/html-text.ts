import { collapseWhitespace } from "./whitespace.js";

/**
 * Untrusted HTML → visible text segments (pure, no I/O). Moved unchanged from
 * src/sources/bzp/notice-update.ts (PR-03B) in PR-03C, so the BZP update and
 * contract notice readers share one scanner (D-022).
 *
 * The input is untrusted markup of up to the caller's bound (BZP: 1 000 000
 * characters). Every step is linear in its length: one forward scan with
 * `indexOf` and bounded patterns, no regular expression with nested
 * quantifiers runs over the input, markup is never interpreted beyond
 * "a tag ends a text segment", and Unicode normalization (quadratic in a run
 * of combining marks) only ever runs on segments of at most
 * MAX_NORMALIZED_SEGMENT_LENGTH characters.
 */

/**
 * Longest segment that is NFC-normalized. `normalize` reorders combining marks
 * by an insertion sort, so one long run of marks of differing classes is
 * quadratic (80 000 characters: ~2 s; 1 000 000: minutes of blocked event
 * loop). Segments are only ever compared for equality with form labels (the
 * longest the BZP readers use has 65 characters, 69 code points decomposed) or
 * matched as short values. Decomposition never shortens text, so a string
 * canonically equivalent to such a label has at most 69 code points (138
 * UTF-16 units). A longer segment can never match, so it is kept as it is,
 * un-normalized: segment positions do not change, and normalization costs at
 * most this length per segment (linear in the input).
 */
export const MAX_NORMALIZED_SEGMENT_LENGTH = 256;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
/** Bounded alternatives only, so decoding is linear. */
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;

function codePoint(value: number): string {
  const valid = value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff);
  return valid ? String.fromCodePoint(value) : "�";
}

/** The handful of entities a label or a date could plausibly contain. */
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (_match, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined) return codePoint(Number(decimal));
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    return NAMED_ENTITIES[name ?? ""] ?? "";
  });
}

/**
 * Elements whose content is not text (never shown, never matched), with the
 * search for their end tag. Literal patterns: each scan is linear.
 */
const RAW_TEXT_END = new Map([
  ["script", /<\/script/gi],
  ["style", /<\/style/gi],
]);

/** Letters/digits of a tag name right after `<` or `</`, lower-cased; bounded. */
function tagNameAt(html: string, start: number, end: number): string {
  let index = start;
  if (html[index] === "/") index++;
  let name = "";
  while (index < end && name.length < 16) {
    const char = html[index] ?? "";
    if (!/[A-Za-z0-9]/.test(char)) break;
    name += char;
    index++;
  }
  return name.toLowerCase();
}

/**
 * The visible text of `html` as segments: every tag ends a segment; comments
 * and the content of `<script>`/`<style>` are dropped; entities decoded,
 * whitespace collapsed, NFC-normalized when short enough to ever match
 * (MAX_NORMALIZED_SEGMENT_LENGTH), empty segments omitted. An unclosed tag, comment or
 * raw-text element stops the scan: the rest of the body is never read as
 * text, and `complete` is false (the body is malformed, so nothing read from
 * it can be trusted to be the whole notice). Linear: each search starts where
 * the previous one ended and the scan never moves backwards.
 */
export function textSegments(html: string): {
  readonly segments: string[];
  readonly complete: boolean;
} {
  const segments: string[] = [];
  let complete = true;
  let pending = "";
  const flush = () => {
    const collapsed = collapseWhitespace(decodeEntities(pending));
    const segment =
      collapsed.length <= MAX_NORMALIZED_SEGMENT_LENGTH ? collapsed.normalize("NFC") : collapsed;
    if (segment !== "") segments.push(segment);
    pending = "";
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pending += html.slice(index);
      break;
    }
    pending += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) {
        complete = false;
        break;
      }
      index = close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      complete = false;
      break;
    }
    flush();
    const name = tagNameAt(html, open + 1, close);
    index = close + 1;
    const end = html[open + 1] === "/" ? undefined : RAW_TEXT_END.get(name);
    if (end !== undefined) {
      end.lastIndex = index;
      const match = end.exec(html);
      const endClose = match === null ? -1 : html.indexOf(">", match.index);
      if (endClose === -1) {
        complete = false;
        break;
      }
      index = endClose + 1;
    }
  }
  flush();
  return { segments, complete };
}
