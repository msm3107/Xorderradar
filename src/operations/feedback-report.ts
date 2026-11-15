import { MVP_CATEGORIES, type MvpCategory } from "../domain/vocabulary.js";
import type {
  FeedbackCounts,
  ProfileDeliveryCounts,
  VerdictCounts,
} from "../infrastructure/db/feedback-repository.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";

/**
 * `feedback:report` (PR-12, D-032): how many offers the customers rated
 * „Trafne” and „Nietrafne”, in total, per profile and per category, and the
 * precision (the relevant share); in total and per profile also the offers
 * sent and the coverage (the rated share of them), since few customers rate
 * and they rate the bad matches more often. Pure: the counts come from
 * countFeedback. Ids, category keys and numbers only — never an address or a
 * title.
 */

/** Counts of one group; precision is null without any rating, never 0. */
export interface ReportCounts {
  readonly ratings: number;
  readonly relevant: number;
  readonly notRelevant: number;
  /** relevant / ratings, rounded to 3 decimals; null when there is no rating. */
  readonly precision: number | null;
}

/** The offers sent and how many of them were rated; coverage is null with none sent, never 0. */
export interface CoverageCounts {
  /** Distinct offers sent to the profile (`sent` deliveries; from `--since` on). */
  readonly delivered: number;
  /** Of those, the offers rated (any verdict, any time). */
  readonly ratedDelivered: number;
  /** ratedDelivered / delivered, rounded to 3 decimals; null when nothing was sent. */
  readonly coverage: number | null;
}

export interface FeedbackReport {
  /** The first day counted (`--since`, Poland's calendar day); null: every rating. */
  readonly since: string | null;
  readonly total: ReportCounts & CoverageCounts;
  /** Profiles with at least one rating or one offer sent counted, by id. */
  readonly profiles: readonly (ReportCounts & CoverageCounts & { readonly profileId: string })[];
  /**
   * Per MVP category of the rated offers (by their CPV codes, D-022): an
   * offer in two categories counts in both; null: offers in none. Only
   * categories with ratings, in the vocabulary's order, null last.
   */
  readonly categories: readonly (ReportCounts & { readonly category: MvpCategory | null })[];
}

/** part / whole, rounded to 3 decimals; null when whole is 0 (never 0). */
function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
}

/** The relevant share, rounded to 3 decimals; null without any rating (never 0). */
export function precision(relevant: number, ratings: number): number | null {
  return share(relevant, ratings);
}

/** The rated share of the offers sent, rounded to 3 decimals; null with none sent (never 0). */
export function coverage(ratedDelivered: number, delivered: number): number | null {
  return share(ratedDelivered, delivered);
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

type Delivered = Omit<ProfileDeliveryCounts, "profileId">;

function coverageCounts(counts: Delivered): CoverageCounts {
  return {
    delivered: counts.delivered,
    ratedDelivered: counts.ratedDelivered,
    coverage: coverage(counts.ratedDelivered, counts.delivered),
  };
}

function add(a: VerdictCounts, b: VerdictCounts): VerdictCounts {
  return { relevant: a.relevant + b.relevant, notRelevant: a.notRelevant + b.notRelevant };
}

function addDelivered(a: Delivered, b: Delivered): Delivered {
  return {
    delivered: a.delivered + b.delivered,
    ratedDelivered: a.ratedDelivered + b.ratedDelivered,
  };
}

const NONE: VerdictCounts = { relevant: 0, notRelevant: 0 };
const NONE_DELIVERED: Delivered = { delivered: 0, ratedDelivered: 0 };

export function buildFeedbackReport(counts: FeedbackCounts, since: string | null): FeedbackReport {
  const total = counts.profiles.reduce(add, NONE);
  const totalDelivered = counts.deliveries.reduce(addDelivered, NONE_DELIVERED);
  // A profile appears with ratings, offers sent or both: the ones that never
  // rate are exactly the bias coverage shows. Ordered by id (uuids in
  // lowercase: code-unit order is PostgreSQL's uuid order).
  const ratedBy = new Map(counts.profiles.map((profile) => [profile.profileId, profile]));
  const deliveredTo = new Map(counts.deliveries.map((profile) => [profile.profileId, profile]));
  const profileIds = [...new Set([...ratedBy.keys(), ...deliveredTo.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
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
    total: { ...reportCounts(total), ...coverageCounts(totalDelivered) },
    profiles: profileIds.map((profileId) => ({
      profileId,
      ...reportCounts(ratedBy.get(profileId) ?? NONE),
      ...coverageCounts(deliveredTo.get(profileId) ?? NONE_DELIVERED),
    })),
    categories: order.flatMap((category) => {
      const found = byCategory.get(category);
      return found === undefined ? [] : [{ category, ...reportCounts(found) }];
    }),
  };
}
