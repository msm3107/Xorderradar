import { setImmediate } from "node:timers/promises";
import type { Kysely } from "kysely";
import type { Opportunity } from "../domain/opportunity.js";
import {
  listDigestCandidates,
  type MatchCandidates,
} from "../infrastructure/db/opportunities-repository.js";
import type { Database } from "../infrastructure/db/schema.js";
import { matchOpportunity, type MatchableProfile } from "../matching/match.js";
import type { DigestItem } from "./digest.js";

/**
 * Which offers count as new and which of them match a profile: shared by the
 * `digest` run and the web page of matches (PR-06B, D-027), so both always
 * show the same set by the same rules.
 */

/** Offers first stored longer ago than this are not "new" any more. */
export const DIGEST_NEW_DAYS = 7;
/** Upper bound of candidate offers read per run (all profiles share them). */
export const DIGEST_CANDIDATE_LIMIT = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestCandidates extends MatchCandidates {
  /** DIGEST_CANDIDATE_LIMIT was reached: some offers were not considered. */
  readonly truncated: boolean;
}

/**
 * The candidate offers at `now`: not closed or cancelled, deadline not passed
 * (unknown kept), first stored in the last DIGEST_NEW_DAYS days; soonest
 * deadline first. Invalid stored rows are returned in `skipped`.
 */
export async function readDigestCandidates(
  db: Kysely<Database>,
  now: Date,
): Promise<DigestCandidates> {
  const candidates = await listDigestCandidates(db, {
    firstSeenSince: new Date(now.getTime() - DIGEST_NEW_DAYS * DAY_MS),
    now,
    limit: DIGEST_CANDIDATE_LIMIT,
  });
  return {
    ...candidates,
    truncated: candidates.offers.length + candidates.skipped.length >= DIGEST_CANDIDATE_LIMIT,
  };
}

/**
 * Milliseconds of matching between two yields to the event loop. Matching
 * is synchronous CPU work whose cost per offer depends on the profile:
 * measured locally from about 0.15 ms (typical profile) to about 2 ms
 * (maximal profile: 100 + 100 long keywords) per offer, i.e. up to 13–14 s
 * for 10 000 offers. `serve` computes it per request (/dopasowania), so it
 * yields by time, not by count: other requests wait at most about this long
 * plus one offer.
 */
export const MATCH_YIELD_AFTER_MS = 20;

/**
 * The offers matching the profile, in the candidates' order, with the
 * reasons. Yields to the event loop once MATCH_YIELD_AFTER_MS have passed
 * since the last yield; the result does not depend on it.
 */
export async function matchingItems(
  profile: MatchableProfile,
  offers: readonly Opportunity[],
): Promise<DigestItem[]> {
  const matched: DigestItem[] = [];
  let lastYield = performance.now();
  for (const offer of offers) {
    if (performance.now() - lastYield > MATCH_YIELD_AFTER_MS) {
      await setImmediate();
      lastYield = performance.now();
    }
    const result = matchOpportunity(offer, profile);
    if (result.matched) matched.push({ offer, reasons: result.reasons });
  }
  return matched;
}
