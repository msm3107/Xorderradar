import { comparableText } from "../sources/normalize/comparable.js";

/**
 * Word-level text matching for keywords (D-023). Both sides go through
 * `comparableText` (lower case, no diacritics, no format characters such as
 * the soft hyphen) and are split into tokens on every character that is not a
 * letter or a digit, so punctuation, hyphens and spaces are word boundaries.
 */

/** Everything that is not a letter or a digit separates tokens. */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

/** The comparable tokens of a text, in order. Linear in the length of the text. */
export function tokenize(value: string): string[] {
  return comparableText(value)
    .split(SEPARATORS)
    .filter((token) => token !== "");
}

/**
 * Keyword tokens shorter than this match only an equal token ("bhp", "it"),
 * longer ones also the inflected forms below.
 */
export const MIN_INFLECTED_TOKEN_LENGTH = 4;

/** One final vowel (after `comparableText`, so `ą`/`ę`/`ó` are already `a`/`e`/`o`). */
const FINAL_VOWEL = /[aeiouy]$/u;

/** Inflection is a property of words: a token without a letter ("2024", "110") is not one. */
const HAS_LETTER = /\p{L}/u;

/** A keyword token prepared for matching: the token and the prefix that its inflected forms share. */
interface KeywordToken {
  readonly token: string;
  /** null: exact match only. */
  readonly stem: string | null;
}

/**
 * The simple Polish inflection rule (D-023): a text token matches a keyword
 * token when it is equal, or — for a keyword token of at least 4 characters —
 * when it starts with the keyword token minus one final vowel. So
 * "oswietlenie" matches "oswietlenia" and "oswietleniem", "instalacja" matches
 * "instalacji", "remont" matches "remontu" and "szkolenie" "szkoleniach".
 * A token without a letter (a number: "2024") matches only an equal token,
 * so "2024" does not match "20245".
 * Known limits: a stem that changes inside the word is not recognised
 * ("kabel" does not match "kable", "sól" not "soli"), and a short stem can
 * match an unrelated longer word ("sala" → "sal" also matches "salon"); the
 * same holds for excluding keywords ("auto" also excludes "automatyka").
 */
function keywordToken(token: string): KeywordToken {
  if (token.length < MIN_INFLECTED_TOKEN_LENGTH || !HAS_LETTER.test(token)) {
    return { token, stem: null };
  }
  return { token, stem: FINAL_VOWEL.test(token) ? token.slice(0, -1) : token };
}

function tokenMatches(keyword: KeywordToken, word: string): boolean {
  return word === keyword.token || (keyword.stem !== null && word.startsWith(keyword.stem));
}

/** A profile keyword (include or exclude) prepared once per match. */
export interface Keyword {
  /** As written in the profile; shown in the reasons. */
  readonly text: string;
  /** Comparable tokens joined by a space: two keywords with the same key are one keyword. */
  readonly key: string;
  readonly tokens: readonly KeywordToken[];
}

/**
 * The distinct keywords of a profile list, in profile order: a keyword whose
 * tokens equal an earlier one ("Oświetlenie" after "oswietlenie") is dropped,
 * and so is one without any token (the profile schema already refuses those).
 */
export function prepareKeywords(keywords: readonly string[]): Keyword[] {
  const seen = new Set<string>();
  const prepared: Keyword[] = [];
  for (const text of keywords) {
    const tokens = tokenize(text);
    const key = tokens.join(" ");
    if (tokens.length === 0 || seen.has(key)) continue;
    seen.add(key);
    prepared.push({ text, key, tokens: tokens.map(keywordToken) });
  }
  return prepared;
}

/**
 * The index of the first text token, at or after `from`, where the keyword's
 * k tokens match k consecutive tokens of the text (the phrase "instalacja
 * odgromowa" matches "… instalacji odgromowej …"), or -1. Cost: at most
 * (text tokens × keyword tokens) comparisons, also over all calls that
 * resume at the previous result + 1; both are bounded by the schemas
 * (keyword ≤ 100 characters and ≤ 10 tokens, title ≤ 1 000, description
 * ≤ 10 000).
 */
export function findKeyword(words: readonly string[], keyword: Keyword, from = 0): number {
  const { tokens } = keyword;
  if (tokens.length === 0) return -1;
  const lastStart = words.length - tokens.length;
  for (let start = Math.max(0, from); start <= lastStart; start++) {
    let all = true;
    for (let offset = 0; offset < tokens.length && all; offset++) {
      const token = tokens[offset];
      const word = words[start + offset];
      all = token !== undefined && word !== undefined && tokenMatches(token, word);
    }
    if (all) return start;
  }
  return -1;
}

/** True when the keyword occurs in the text tokens (see `findKeyword`). */
export function containsKeyword(words: readonly string[], keyword: Keyword): boolean {
  return findKeyword(words, keyword) !== -1;
}
