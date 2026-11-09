import { sql, type Kysely } from "kysely";
import { hashSecretToken, isSecretToken } from "./access-repository.js";
import type { Database, FeedbackVerdict } from "./schema.js";

/**
 * The customers' ratings of offers, „Trafne”/„Nietrafne” (PR-12, D-032):
 * one row per profile and offer in match_feedback, changed in place by one
 * atomic upsert. A rating link of a digest (token purpose `feedback`) rates
 * only offers delivered to its profile; the web list rates with the
 * session (the caller checks the offer). Only ids, verdicts and times are
 * stored — no titles, no addresses.
 */

/** The offer id in a rating link or form: a lowercase uuid as PostgreSQL prints it. */
const OPPORTUNITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a string shaped like an offer id (checked before any lookup). */
export function isOpportunityId(value: string): boolean {
  return OPPORTUNITY_ID.test(value);
}

/**
 * Deliveries that let a rating link rate the offer: claimed (the e-mail went
 * out or its outcome is unknown) or sent. A failed one was never received.
 */
const RATABLE_DELIVERY_STATUSES = ["pending", "sent"] as const;

/** The ON CONFLICT update: the new verdict; updated_at only when it changed. */
const upsert = {
  verdict: sql<FeedbackVerdict>`excluded.verdict`,
  updated_at: sql<Date>`CASE WHEN match_feedback.verdict = excluded.verdict
    THEN match_feedback.updated_at ELSE now() END`,
};

/** What the confirmation page of a rating link shows. */
export interface FeedbackLinkOffer {
  readonly title: string;
  /** The profile's current rating of the offer; null when not rated yet. */
  readonly verdict: FeedbackVerdict | null;
}

/**
 * Read-only (a mail scanner may fetch the link): the offer behind a rating
 * link when `token` is an unexpired `feedback` token and the offer was
 * delivered to the token's profile; null for anything else — an unknown,
 * expired or other-purpose token, a malformed id, an offer of another
 * profile — so the caller shows one neutral page for all of them.
 */
export async function feedbackLinkOffer(
  db: Kysely<Database>,
  token: string,
  opportunityId: string,
): Promise<FeedbackLinkOffer | null> {
  if (!isSecretToken(token) || !isOpportunityId(opportunityId)) return null;
  const row = await db
    .selectFrom("access_tokens as t")
    .innerJoin("opportunities as o", (join) => join.on("o.id", "=", opportunityId))
    .leftJoin("match_feedback as f", (join) =>
      join.onRef("f.profile_id", "=", "t.profile_id").onRef("f.opportunity_id", "=", "o.id"),
    )
    .select(["o.title", "f.verdict"])
    .where("t.token_hash", "=", hashSecretToken(token))
    .where("t.purpose", "=", "feedback")
    .where("t.expires_at", ">", sql<Date>`now()`)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("deliveries as d")
          .select(sql`1`.as("one"))
          .whereRef("d.profile_id", "=", "t.profile_id")
          .whereRef("d.opportunity_id", "=", "o.id")
          .where("d.status", "in", RATABLE_DELIVERY_STATUSES),
      ),
    )
    .executeTakeFirst();
  return row === undefined ? null : { title: row.title, verdict: row.verdict };
}

/**
 * The POST of a rating link: stores the verdict under the same conditions
 * as feedbackLinkOffer, in one statement (INSERT … SELECT … ON CONFLICT DO
 * UPDATE), so a concurrent or repeated POST leaves exactly one row with the
 * last verdict. updated_at moves only when the verdict changes. false (nothing
 * written) for anything feedbackLinkOffer refuses.
 */
export async function rateWithFeedbackLink(
  db: Kysely<Database>,
  token: string,
  opportunityId: string,
  verdict: FeedbackVerdict,
): Promise<boolean> {
  if (!isSecretToken(token) || !isOpportunityId(opportunityId)) return false;
  const row = await db
    .insertInto("match_feedback")
    .columns(["profile_id", "opportunity_id", "verdict"])
    .expression((eb) =>
      eb
        .selectFrom("access_tokens as t")
        .select([
          "t.profile_id",
          sql<string>`${opportunityId}::uuid`.as("opportunity_id"),
          sql<FeedbackVerdict>`${verdict}`.as("verdict"),
        ])
        .where("t.token_hash", "=", hashSecretToken(token))
        .where("t.purpose", "=", "feedback")
        .where("t.expires_at", ">", sql<Date>`now()`)
        .where((inner) =>
          inner.exists(
            inner
              .selectFrom("deliveries as d")
              .select(sql`1`.as("one"))
              .whereRef("d.profile_id", "=", "t.profile_id")
              .where("d.opportunity_id", "=", opportunityId)
              .where("d.status", "in", RATABLE_DELIVERY_STATUSES),
          ),
        ),
    )
    .onConflict((conflict) =>
      conflict.columns(["profile_id", "opportunity_id"]).doUpdateSet(upsert),
    )
    .returning("profile_id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Stores the profile's verdict on the offer (the web list, session and
 * CSRF checked, the offer checked by the caller): the same atomic upsert
 * as rateWithFeedbackLink.
 */
export async function rateOffer(
  db: Kysely<Database>,
  profileId: string,
  opportunityId: string,
  verdict: FeedbackVerdict,
): Promise<void> {
  await db
    .insertInto("match_feedback")
    .values({ profile_id: profileId, opportunity_id: opportunityId, verdict })
    .onConflict((conflict) =>
      conflict.columns(["profile_id", "opportunity_id"]).doUpdateSet(upsert),
    )
    .execute();
}

/** Was the offer delivered to the profile (claimed or sent, as a rating link requires)? */
export async function wasDelivered(
  db: Kysely<Database>,
  profileId: string,
  opportunityId: string,
): Promise<boolean> {
  if (!isOpportunityId(opportunityId)) return false;
  const row = await db
    .selectFrom("deliveries")
    .select("id")
    .where("profile_id", "=", profileId)
    .where("opportunity_id", "=", opportunityId)
    .where("status", "in", RATABLE_DELIVERY_STATUSES)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** The profile's verdicts on the given offers, by offer id, in one query. */
export async function feedbackVerdicts(
  db: Kysely<Database>,
  profileId: string,
  opportunityIds: readonly string[],
): Promise<Map<string, FeedbackVerdict>> {
  const verdicts = new Map<string, FeedbackVerdict>();
  if (opportunityIds.length === 0) return verdicts;
  const rows = await db
    .selectFrom("match_feedback")
    .select(["opportunity_id", "verdict"])
    .where("profile_id", "=", profileId)
    .where("opportunity_id", "=", sql<string>`ANY(${[...opportunityIds]}::uuid[])`)
    .execute();
  for (const row of rows) verdicts.set(row.opportunity_id, row.verdict);
  return verdicts;
}

/** Ratings counted per verdict. */
export interface VerdictCounts {
  readonly relevant: number;
  readonly notRelevant: number;
}

/** The counts of one profile. */
export interface ProfileVerdictCounts extends VerdictCounts {
  readonly profileId: string;
}

/** The counts of the offers sharing one set of CPV codes (mapped to categories by the caller). */
export interface CpvVerdictCounts extends VerdictCounts {
  readonly cpvCodes: readonly string[];
}

export interface FeedbackCounts {
  readonly profiles: readonly ProfileVerdictCounts[];
  readonly offers: readonly CpvVerdictCounts[];
}

/**
 * The ratings last set on or after `since` (a calendar day in Poland, the
 * start of that day; null: all), counted per profile and per the rated
 * offers' CPV codes (`feedback:report`). Ids, codes and counts only.
 */
export async function countFeedback(
  db: Kysely<Database>,
  since: string | null,
): Promise<FeedbackCounts> {
  const relevant = sql<string>`count(*) FILTER (WHERE f.verdict = 'relevant')`;
  const notRelevant = sql<string>`count(*) FILTER (WHERE f.verdict = 'not_relevant')`;
  // The start of that day in Poland, whatever the session's time zone; no day: every rating.
  const sinceStart =
    since === null
      ? sql<Date>`'-infinity'::timestamptz`
      : sql<Date>`(${since}::date)::timestamp AT TIME ZONE 'Europe/Warsaw'`;
  // One snapshot for both lists, so their totals agree.
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const profileRows = await trx
        .selectFrom("match_feedback as f")
        .select(["f.profile_id", relevant.as("relevant"), notRelevant.as("not_relevant")])
        .where("f.updated_at", ">=", sinceStart)
        .groupBy("f.profile_id")
        .orderBy("f.profile_id")
        .execute();
      const offerRows = await trx
        .selectFrom("match_feedback as f")
        .innerJoin("opportunities as o", "o.id", "f.opportunity_id")
        .select(["o.categories", relevant.as("relevant"), notRelevant.as("not_relevant")])
        .where("f.updated_at", ">=", sinceStart)
        .groupBy("o.categories")
        .orderBy("o.categories")
        .execute();
      return {
        // count(*) is bigint, which `pg` returns as text.
        profiles: profileRows.map((row) => ({
          profileId: row.profile_id,
          relevant: Number(row.relevant),
          notRelevant: Number(row.not_relevant),
        })),
        offers: offerRows.map((row) => ({
          cpvCodes: row.categories,
          relevant: Number(row.relevant),
          notRelevant: Number(row.not_relevant),
        })),
      };
    });
}
