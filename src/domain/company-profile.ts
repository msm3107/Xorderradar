import { z } from "zod";
import { emailSchema, labelList, text } from "./common.js";
import { MVP_CATEGORIES, VOIVODESHIPS } from "./vocabulary.js";

/** A keyword can only ever match text when it has a letter or a digit (PR-04 tokenizer). */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Most words in one keyword. Matching costs (text tokens × keyword tokens)
 * per keyword (D-023), and real phrases are a few words long.
 */
export const MAX_KEYWORD_TOKENS = 10;

/** Dropped inside words by the matching tokenizer (`comparableText`): format characters and marks. */
const NOT_WORD_BREAKS = /[\p{Cf}\p{M}]/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The number of tokens the matching tokenizer (src/matching/text.ts) makes of
 * a keyword: runs of letters and digits once format characters and combining
 * marks are removed. Kept here because the domain imports nothing from
 * matching; a test pins it to `tokenize`.
 */
export function keywordTokenCount(keyword: string): number {
  return keyword.replace(NOT_WORD_BREAKS, "").match(WORD)?.length ?? 0;
}

/** Include/exclude keywords: short labels, each with at least one letter or digit, ≤ 10 words. */
function keywordList() {
  return z
    .array(
      text(100)
        .refine((keyword) => HAS_LETTER_OR_DIGIT.test(keyword), "must contain a letter or a digit")
        .refine(
          (keyword) => keywordTokenCount(keyword) <= MAX_KEYWORD_TOKENS,
          `must have at most ${String(MAX_KEYWORD_TOKENS)} words`,
        ),
    )
    .max(100);
}

/**
 * Company profile = subscription (docs/DECISIONS.md D-009): the alert recipient
 * and the matching preferences in one record (PR-04, D-023):
 * - categories: at least one, from the closed MVP list (docs/PRODUCT.md);
 * - voivodeships: canonical names of the 16 voivodeships only (a front end
 *   such as `profile:create` turns other spellings into them first);
 * - counties: names as entered (no county dictionary, D-022); matching
 *   compares their normalized form;
 * - keywords: may be empty; each must contain a letter or a digit and have at
 *   most MAX_KEYWORD_TOKENS words.
 * Region lists may be empty: no regional restriction.
 */
const profileFields = {
  email: emailSchema,
  name: text(200),
  categories: z.array(z.enum(MVP_CATEGORIES)).min(1).max(100),
  includeKeywords: keywordList(),
  excludeKeywords: keywordList(),
  voivodeships: z.array(z.enum(VOIVODESHIPS)).max(100),
  counties: labelList(),
  active: z.boolean(),
};

/** Every field is explicit on create: no hidden defaults for preferences. */
export const companyProfileInputSchema = z.strictObject(profileFields);

/**
 * Partial update; at least one field must be given. A key whose value is
 * `undefined` does not count: it would not change anything.
 */
export const companyProfilePatchSchema = z
  .strictObject(profileFields)
  .partial()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "at least one field is required",
  );

export type CompanyProfileInput = z.input<typeof companyProfileInputSchema>;
export type CompanyProfilePatch = z.input<typeof companyProfilePatchSchema>;

export interface CompanyProfile extends z.output<typeof companyProfileInputSchema> {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
