import type { CompanyProfile } from "../domain/company-profile.js";
import type { Opportunity } from "../domain/opportunity.js";
import { MVP_CATEGORIES, type MvpCategory, type Voivodeship } from "../domain/vocabulary.js";
import { comparableText } from "../sources/normalize/comparable.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";
import { normalizeCounty, normalizeVoivodeship } from "../sources/normalize/regions.js";
import { findKeyword, prepareKeywords, tokenize, type Keyword } from "./text.js";

/**
 * Deterministic, explained matching of one offer against one company profile
 * (docs/ARCHITECTURE.md §4.4, D-011, D-023). Pure: no I/O, no clock, no
 * network, no LLM; the same input always gives the same result, reasons in
 * the same order.
 */

/** Points per rule (ARCHITECTURE §4.4; a starting point for calibration in the pilot). */
export const POINTS = {
  category: 40,
  keyword: 30,
  /** Once, when more than one distinct keyword is found. */
  moreKeywords: 10,
  region: 20,
  /** Per excluding keyword found; any one also makes the result a non-match. */
  exclude: -100,
} as const;

/**
 * `matched` needs at least this score, no excluding keyword and a region that
 * is not a mismatch. Category + region (60) passes; with an unknown region
 * category + keyword (70) is needed; a keyword alone passes only with a
 * matching region (50); one keyword with an unknown region (30) does not.
 */
export const MATCH_THRESHOLD = 50;

/** Where a keyword was found; the title is checked first. */
export type MatchField = "title" | "description";

/** A profile category found in the offer, with the offer's CPV codes that map to it. */
export interface CategoryHit {
  readonly category: MvpCategory;
  readonly cpvCodes: readonly string[];
}

/**
 * Why the score is what it is. Every reason carries its points, so the score
 * is always the sum of the reasons' points (AC1). Category and region give
 * exactly one reason each; every distinct keyword and excluding keyword found
 * gives one more.
 */
export type MatchReason =
  /** Profile categories present in the offer (from its CPV codes). */
  | {
      readonly kind: "category";
      readonly points: typeof POINTS.category;
      readonly hits: readonly CategoryHit[];
    }
  /** The offer's CPV codes map to MVP categories, none of them in the profile. */
  | {
      readonly kind: "category_mismatch";
      readonly points: 0;
      readonly offerCategories: readonly MvpCategory[];
    }
  /**
   * The offer has no CPV code that maps to an MVP category (small contracts
   * publish no CPV at all): the category cannot be checked, keywords carry
   * the match (AC6). `cpvCodes` are the offer's codes, possibly none.
   */
  | {
      readonly kind: "category_unverifiable";
      readonly points: 0;
      readonly cpvCodes: readonly string[];
    }
  /** A profile keyword found; the first one found gets the points, the others 0. */
  | {
      readonly kind: "keyword";
      readonly points: typeof POINTS.keyword | 0;
      readonly keyword: string;
      readonly field: MatchField;
    }
  /** More than one distinct keyword found. */
  | {
      readonly kind: "more_keywords";
      readonly points: typeof POINTS.moreKeywords;
      readonly count: number;
    }
  /** An excluding keyword found: never a match, whatever the score (AC2). */
  | {
      readonly kind: "exclude";
      readonly points: typeof POINTS.exclude;
      readonly keyword: string;
      readonly field: MatchField;
    }
  /** The profile names no voivodeship and no county. */
  | { readonly kind: "region_unrestricted"; readonly points: typeof POINTS.region }
  /** A profile voivodeship or county equals the offer's (`value`: the profile's entry, normalized). */
  | {
      readonly kind: "region_match";
      readonly points: typeof POINTS.region;
      readonly via: "voivodeship" | "county";
      readonly value: string;
    }
  /**
   * Outside the profile's region: never a match. Either the offer's
   * voivodeship is known and not among the profile's voivodeships, whatever
   * its county (profile counties never widen a profile that has
   * voivodeships), or the profile has counties only and the offer's known
   * county is none of them. The offer's known parts are given.
   */
  | {
      readonly kind: "region_mismatch";
      readonly points: 0;
      readonly offerVoivodeship: Voivodeship | null;
      readonly offerCounty: string | null;
    }
  /**
   * Not a match and not a mismatch: the offer has no location at all (AC3),
   * gives no voivodeship while the profile has voivodeships, or gives no
   * county while the profile has counties only (BZP publishes no county,
   * AC5). 0 points. A known offer county that matches no profile county is
   * named too (`offerCounty`, absent otherwise), so the explanation is
   * complete.
   */
  | {
      readonly kind: "region_unknown";
      readonly points: 0;
      readonly missing: "location" | "voivodeship" | "county" | "voivodeship_and_county";
      readonly offerCounty?: string;
    };

export interface MatchResult {
  readonly score: number;
  readonly matched: boolean;
  readonly reasons: readonly MatchReason[];
}

/** What matching reads of an offer. */
export type MatchableOpportunity = Pick<
  Opportunity,
  "title" | "description" | "categories" | "location"
>;

/** What matching reads of a profile. */
export type MatchableProfile = Pick<
  CompanyProfile,
  "categories" | "includeKeywords" | "excludeKeywords" | "voivodeships" | "counties"
>;

function categoryReason(offer: MatchableOpportunity, profile: MatchableProfile): MatchReason {
  const offerCategories = mvpCategoriesForCpv(offer.categories);
  if (offerCategories.length === 0) {
    return { kind: "category_unverifiable", points: 0, cpvCodes: [...offer.categories] };
  }
  const wanted = new Set<string>(profile.categories);
  const hits = MVP_CATEGORIES.filter(
    (category) => wanted.has(category) && offerCategories.includes(category),
  ).map((category) => ({
    category,
    cpvCodes: offer.categories.filter((code) => mvpCategoriesForCpv([code]).includes(category)),
  }));
  return hits.length > 0
    ? { kind: "category", points: POINTS.category, hits }
    : { kind: "category_mismatch", points: 0, offerCategories };
}

/** Comparable tokens of the searched fields; the description may be missing. */
interface SearchedText {
  readonly title: readonly string[];
  readonly description: readonly string[];
}

const FIELDS: readonly MatchField[] = ["title", "description"];

/** The field where the keyword is first found (title first), or null. */
function foundIn(text: SearchedText, keyword: Keyword): MatchField | null {
  return FIELDS.find((field) => findKeyword(text[field], keyword) !== -1) ?? null;
}

/** A place a keyword was found: the field and the text tokens it covers. */
interface Span {
  readonly field: MatchField;
  /** `field:start:length`; equal keys are the same words. */
  readonly key: string;
}

/** The keyword's hits, title first, each field in text order, at most `limit`. */
function hitSpans(text: SearchedText, keyword: Keyword, limit: number): Span[] {
  const spans: Span[] = [];
  for (const field of FIELDS) {
    let start = findKeyword(text[field], keyword);
    while (start !== -1 && spans.length < limit) {
      spans.push({ field, key: `${field}:${String(start)}:${String(keyword.tokens.length)}` });
      start = findKeyword(text[field], keyword, start + 1);
    }
  }
  return spans;
}

/**
 * One reason per keyword with evidence of its own, in profile order. Each
 * counted keyword gets a hit (span of text tokens) that no other counted
 * keyword has: hits are assigned as a maximum bipartite matching (augmenting
 * paths, keywords in profile order, hits title first and in text order — so
 * deterministic). "oświetlenie" and "oświetlenia" on one "Oświetlenie" share
 * the only span, so only the first counts (no second reason, no bonus);
 * "sala" and "salon" on "salonu i sali" both count ("salon" → "salonu",
 * "sala" → "sali"). Hits per keyword are capped at the number of keywords:
 * a keyword with that many hits always has a free one, so the cap does not
 * change the result and bounds the work (≤ 100 keywords × 100 hits).
 */
function keywordReasons(text: SearchedText, profile: MatchableProfile): MatchReason[] {
  const keywords = prepareKeywords(profile.includeKeywords);
  const candidates = keywords.map((keyword) => hitSpans(text, keyword, keywords.length));
  const owner = new Map<string, number>();
  const assigned = new Map<number, Span>();
  const assign = (index: number, visited: Set<string>): boolean => {
    for (const span of candidates[index] ?? []) {
      if (visited.has(span.key)) continue;
      visited.add(span.key);
      const current = owner.get(span.key);
      if (current === undefined || assign(current, visited)) {
        owner.set(span.key, index);
        assigned.set(index, span);
        return true;
      }
    }
    return false;
  };
  const reasons: MatchReason[] = [];
  keywords.forEach((_, index) => assign(index, new Set()));
  keywords.forEach((keyword, index) => {
    const span = assigned.get(index);
    if (span === undefined) return;
    const points = reasons.length === 0 ? POINTS.keyword : 0;
    reasons.push({ kind: "keyword", points, keyword: keyword.text, field: span.field });
  });
  if (reasons.length > 1) {
    reasons.push({ kind: "more_keywords", points: POINTS.moreKeywords, count: reasons.length });
  }
  return reasons;
}

function excludeReasons(text: SearchedText, profile: MatchableProfile): MatchReason[] {
  const reasons: MatchReason[] = [];
  for (const keyword of prepareKeywords(profile.excludeKeywords)) {
    const field = foundIn(text, keyword);
    if (field !== null) {
      reasons.push({
        kind: "exclude",
        points: POINTS.exclude,
        keyword: keyword.text,
        field,
      });
    }
  }
  return reasons;
}

/**
 * A county in the one form both sides are compared in (AC7, D-023):
 * `comparableText(normalizeCounty(x))`, then the spelling variants of the same
 * name made equal — whitespace after a dot removed ("m. st." = "m.st."), the
 * "m.st." / "miasto stołeczne" prefix and the "(miasto na prawach powiatu)"
 * suffix dropped, so "m. st. Warszawa", "m.st. Warszawa" and "Warszawa" are
 * one county, as are "Kraków (miasto na prawach powiatu)" and "Kraków". The
 * city county "krakow" stays different from the rural "krakowski". null: not
 * a county name.
 */
export function countyKey(value: string): string | null {
  const county = normalizeCounty(value);
  if (county === null) return null;
  const key = comparableText(county)
    .replace(/\.\s+/gu, ".")
    .replace(/^(?:m\.st\.|miasto stoleczne )/u, "")
    .replace(/ ?\(miasto na prawach powiatu\)$/u, "")
    .trim();
  return key === "" ? null : key;
}

function regionReason(offer: MatchableOpportunity, profile: MatchableProfile): MatchReason {
  const usesVoivodeships = profile.voivodeships.length > 0;
  const usesCounties = profile.counties.length > 0;
  if (!usesVoivodeships && !usesCounties) {
    return { kind: "region_unrestricted", points: POINTS.region };
  }
  const { location } = offer;
  if (location === null) return { kind: "region_unknown", points: 0, missing: "location" };

  // Absent or not recognisable counts as not given by the source.
  const offerVoivodeship =
    location.voivodeship === undefined ? null : normalizeVoivodeship(location.voivodeship);
  const offerCounty = location.county === undefined ? null : normalizeCounty(location.county);
  const offerCountyKey = offerCounty === null ? null : countyKey(offerCounty);

  const voivodeships = profile.voivodeships.map(normalizeVoivodeship);
  // Profile counties never widen a profile that has voivodeships: a known
  // voivodeship outside them is a mismatch, whatever the county (owner's
  // decision after the live-data review, D-023). Narrowing by county inside a
  // listed voivodeship is not implemented: no source gives counties yet.
  if (usesVoivodeships && offerVoivodeship !== null && !voivodeships.includes(offerVoivodeship)) {
    return {
      kind: "region_mismatch",
      points: 0,
      offerVoivodeship,
      offerCounty: offerCountyKey === null ? null : offerCounty,
    };
  }

  // A profile entry that does not normalize (refused on create, but a stored
  // row may predate that) never matches anything; it still counts as a used
  // dimension, so it cannot turn the profile into "unrestricted". A county
  // match is reported first; with voivodeships in the profile it can only
  // decide when the offer's voivodeship is listed or unknown.
  if (usesCounties && offerCountyKey !== null) {
    const county = profile.counties.find((entry) => countyKey(entry) === offerCountyKey);
    if (county !== undefined) {
      return {
        kind: "region_match",
        points: POINTS.region,
        via: "county",
        value: normalizeCounty(county) ?? county,
      };
    }
  }
  if (offerVoivodeship !== null && voivodeships.includes(offerVoivodeship)) {
    return {
      kind: "region_match",
      points: POINTS.region,
      via: "voivodeship",
      value: offerVoivodeship,
    };
  }

  // Here the profile has no voivodeships, or the offer's voivodeship is unknown.
  const voivodeshipMissing = usesVoivodeships && offerVoivodeship === null;
  const countyMissing = usesCounties && offerCountyKey === null;
  if (!voivodeshipMissing && !countyMissing) {
    return {
      kind: "region_mismatch",
      points: 0,
      offerVoivodeship,
      offerCounty: offerCountyKey === null ? null : offerCounty,
    };
  }
  const missing =
    voivodeshipMissing && countyMissing
      ? "voivodeship_and_county"
      : voivodeshipMissing
        ? "voivodeship"
        : "county";
  // A known county that did not match above: name it.
  const outsideCounty = usesCounties && offerCountyKey !== null ? offerCounty : null;
  return {
    kind: "region_unknown",
    points: 0,
    missing,
    ...(outsideCounty === null ? {} : { offerCounty: outsideCounty }),
  };
}

/**
 * Scores `offer` for `profile` (rules: POINTS, MATCH_THRESHOLD, D-023).
 * Keywords and excluding keywords are searched in the title and the
 * description (when there is one) with the same token rule (src/matching/
 * text.ts). Offer status and deadline are not looked at: filtering closed or
 * expired offers belongs to the caller (`match:preview`, the digest).
 */
export function matchOpportunity(
  offer: MatchableOpportunity,
  profile: MatchableProfile,
): MatchResult {
  const text: SearchedText = {
    title: tokenize(offer.title),
    description: offer.description === null ? [] : tokenize(offer.description),
  };
  const excludes = excludeReasons(text, profile);
  const region = regionReason(offer, profile);
  const reasons: MatchReason[] = [
    categoryReason(offer, profile),
    ...keywordReasons(text, profile),
    ...excludes,
    region,
  ];
  const score = reasons.reduce((sum, reason) => sum + reason.points, 0);
  const matched =
    score >= MATCH_THRESHOLD && excludes.length === 0 && region.kind !== "region_mismatch";
  return { score, matched, reasons };
}
