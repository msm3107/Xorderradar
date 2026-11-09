import { MVP_CATEGORIES, type MvpCategory } from "../domain/vocabulary.js";
import type { FeedbackCounts, VerdictCounts } from "../infrastructure/db/feedback-repository.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";

/**
 * `feedback:report` (PR-12, D-032): how many offers the customers rated
 * „Trafne” and „Nietrafne”, in total, per profile and per category, and the
 * precision (the relevant share). Pure: the counts come from countFeedback.
 * Ids, category keys and numbers only — never an address or a title.
 */

/** Counts of one group; precision is null without any rating, never 0. */
export interface ReportCounts {
  readonly ratings: number;
  readonly relevant: number;
  readonly notRelevant: number;
  /** relevant / ratings, rounded to 3 decimals; null when there is no rating. */
  readonly precision: number | null;
}

export interface FeedbackReport {
  /** The first day counted (`--since`, Poland's calendar day); null: every rating. */
  readonly since: string | null;
  readonly total: ReportCounts;
  /** Profiles with at least one rating counted, by id. */
  readonly profiles: readonly (ReportCounts & { readonly profileId: string })[];
  /**
   * Per MVP category of the rated offers (by their CPV codes, D-022): an
   * offer in two categories counts in both; null: offers in none. Only
   * categories with ratings, in the vocabulary's order, null last.
   */
  readonly categories: readonly (ReportCounts & { readonly category: MvpCategory | null })[];
}

/** The relevant share, rounded to 3 decimals; null without any rating (never 0). */
export function precision(relevant: number, ratings: number): number | null {
  return ratings === 0 ? null : Math.round((relevant / ratings) * 1000) / 1000;
}

function reportCounts(counts: VerdictCounts): ReportCounts {
  const ratings = counts.relevant + counts.notRelevant;
  return {
    ratings,
    relevant: counts.relevant,
    notRelevant: counts.notRelevant,
    precision: precision(counts.relevant, ratings),
  };
}

function add(a: VerdictCounts, b: VerdictCounts): VerdictCounts {
  return { relevant: a.relevant + b.relevant, notRelevant: a.notRelevant + b.notRelevant };
}

const NONE: VerdictCounts = { relevant: 0, notRelevant: 0 };

export function buildFeedbackReport(counts: FeedbackCounts, since: string | null): FeedbackReport {
  const total = counts.profiles.reduce(add, NONE);
  const byCategory = new Map<MvpCategory | null, VerdictCounts>();
  for (const group of counts.offers) {
    const categories = mvpCategoriesForCpv(group.cpvCodes);
    for (const category of categories.length === 0 ? [null] : categories) {
      byCategory.set(category, add(byCategory.get(category) ?? NONE, group));
    }
  }
  const order: readonly (MvpCategory | null)[] = [...MVP_CATEGORIES, null];
  return {
    since,
    total: reportCounts(total),
    profiles: counts.profiles.map((profile) => ({
      profileId: profile.profileId,
      ...reportCounts(profile),
    })),
    categories: order.flatMap((category) => {
      const found = byCategory.get(category);
      return found === undefined ? [] : [{ category, ...reportCounts(found) }];
    }),
  };
}
