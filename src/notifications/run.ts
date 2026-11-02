import type { Kysely } from "kysely";
import type { CompanyProfile } from "../domain/company-profile.js";
import { DomainError } from "../domain/errors.js";
import type { Opportunity } from "../domain/opportunity.js";
import { issueDigestTokens } from "../infrastructure/db/access-repository.js";
import { withAdvisoryLock, type LockResult } from "../infrastructure/db/advisory-lock.js";
import {
  getCompanyProfile,
  listActiveCompanyProfiles,
} from "../infrastructure/db/company-profiles-repository.js";
import {
  claimDeliveries,
  getProfileDeliverySummary,
  listDeliveryStates,
  markDeliveries,
  type DeliveryKey,
} from "../infrastructure/db/deliveries-repository.js";
import type { Database, DeliveryTransport } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";
import { warsawDay } from "../sources/normalize/warsaw-time.js";
import { loginUrl, unsubscribeUrl } from "../web/links.js";
import {
  DIGEST_CANDIDATE_LIMIT,
  DIGEST_NEW_DAYS,
  matchingItems,
  readDigestCandidates,
} from "./candidates.js";
import { buildDigest, type DigestLinks } from "./digest.js";
import { sendWithRetry, type EmailSender, type SendFailureKind } from "./sender.js";

/**
 * The `digest` run (PR-05, D-024): for every active profile, at most one
 * e-mail a day with the new offers matching it, each offer at most once.
 */

/** Advisory lock serializing `digest` runs; a different key from `ingest` (D-019 pattern). */
export const DIGEST_LOCK_KEY = 7_206_120_309_002;
export const DIGEST_LOCK_HEARTBEAT_MS = 5_000;
// Defined with the candidate query the web page of matches shares (PR-06B).
export { DIGEST_CANDIDATE_LIMIT, DIGEST_NEW_DAYS };
/** Offers per e-mail; the rest waits for the next digest (overflow). */
export const DIGEST_MAX_ITEMS = 50;
/** Runs that may try to deliver one offer to one profile before it is given up. */
export const DIGEST_MAX_ATTEMPTS = 3;

/** Reason of the run signal's abort when the digest lock connection broke. */
export class DigestLockLostError extends Error {
  override readonly name = "DigestLockLostError";
  readonly code = "lock_lost";

  constructor() {
    super("The digest lock was lost during the run");
  }
}

/** Runs `task` while holding the digest lock; `{ acquired: false }` at once when it is held. */
export async function withDigestLock<T>(
  db: Kysely<Database>,
  task: (signal: AbortSignal) => Promise<T>,
  options: { readonly logger: Logger; readonly heartbeatMs?: number },
): Promise<LockResult<T>> {
  return withAdvisoryLock(
    db,
    { key: DIGEST_LOCK_KEY, name: "digest", lostError: () => new DigestLockLostError() },
    task,
    { logger: options.logger, heartbeatMs: options.heartbeatMs ?? DIGEST_LOCK_HEARTBEAT_MS },
  );
}

/**
 * - `sent`: the e-mail was accepted;
 * - `failed`: it certainly was not delivered (rows `failed`, retried by later runs);
 *   after a setup or unreachable failure without spending an attempt;
 * - `uncertain`: the send may or may not have reached the server (rows stay `pending`);
 * - `nothing_new`: no new matching offer;
 * - `already_sent_today`: today's digest went out already;
 * - `pending_today`: a run today claimed offers and never recorded the outcome;
 * - `dry_run`: what would be sent (nothing written or sent);
 * - `inactive`, `not_found`, `invalid_profile`: only for `--profile`, except
 *   invalid rows, which are reported in every run;
 * - `address_changed`: the profile's e-mail changed during the run (on the
 *   web, D-027); nothing issued, claimed or sent, the next run sends to the
 *   new address. Detected only with PUBLIC_BASE_URL (while issuing the links);
 * - `not_run`: the run stopped (lock lost, or a send failure that is not about
 *   the message: see DigestSummary.errorCode) before this profile.
 */
export type ProfileDigestStatus =
  | "sent"
  | "failed"
  | "uncertain"
  | "nothing_new"
  | "already_sent_today"
  | "pending_today"
  | "dry_run"
  | "inactive"
  | "not_found"
  | "invalid_profile"
  | "address_changed"
  | "not_run";

/** Counts are offers, not e-mails. */
export interface ProfileDigestSummary {
  readonly profileId: string;
  readonly status: ProfileDigestStatus;
  /** Candidate offers matching the profile. */
  readonly matched: number;
  /** Offers claimed for this e-mail (dry run: that would be claimed). */
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  /** The profile's `pending` rows after the run: sends whose outcome is unknown. */
  readonly uncertain: number;
  /** Matching offers left for a later digest by the per-e-mail cap. */
  readonly overflow: number;
  /** The error code of a failed or uncertain send. */
  readonly errorCode?: string;
}

export interface DigestSummary {
  readonly digestDate: string;
  readonly transport: DeliveryTransport;
  readonly dryRun: boolean;
  /** Candidate offers read (shared by all profiles). */
  readonly candidates: number;
  /** DIGEST_CANDIDATE_LIMIT was reached: some offers were not considered. */
  readonly candidatesTruncated: boolean;
  /** Stored offers left out because they fail the domain schema (shared by all profiles). */
  readonly skippedInvalidRows: number;
  /**
   * Why the run stopped before the remaining profiles, when a send failed for
   * a reason that is not about the message (setup, unreachable, uncertain); else null.
   */
  readonly errorCode: DigestStopCode | null;
  readonly profiles: readonly ProfileDigestSummary[];
}

export type DigestStopCode =
  "send_setup_failed" | "send_server_unreachable" | "send_outcome_unknown";

/**
 * The run stops at a send failure that is not about the message: it would
 * repeat for every profile (a broken setup, an unreachable server), or it
 * may leave every profile with an unknown outcome (D-024).
 */
function stopCode(kind: SendFailureKind): DigestStopCode | null {
  switch (kind) {
    case "setup":
      return "send_setup_failed";
    case "unreachable":
      return "send_server_unreachable";
    case "uncertain":
      return "send_outcome_unknown";
    case "transient":
    case "permanent":
      return null;
  }
}

export interface DigestRunDeps {
  readonly db: Kysely<Database>;
  /** The transport the deliveries are recorded for. */
  readonly transport: DeliveryTransport;
  /** null in a dry run: nothing is sent. */
  readonly sender: EmailSender | null;
  readonly now: Date;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  /** Aborted when the run's lock is lost: no further profile is started. */
  readonly signal: AbortSignal;
  readonly retryDelaysMs?: readonly number[];
  /**
   * PUBLIC_BASE_URL (an origin), when set: every e-mail gets a login link
   * and a one-click unsubscribe link (PR-06A). null keeps the reply-only
   * footer and the mailto-only List-Unsubscribe.
   */
  readonly publicBaseUrl?: string | null;
}

export interface DigestRunOptions {
  /** Only this profile (a uuid, already validated); else all active ones. */
  readonly profileId: string | null;
  readonly dryRun: boolean;
}

/** Statuses that make the command exit with 1. */
const FAILING_STATUSES: ReadonlySet<ProfileDigestStatus> = new Set([
  "failed",
  "uncertain",
  "not_found",
  "invalid_profile",
  "not_run",
]);

/** The profile's outcome makes the command fail (exit 1). */
export function profileFailed(profile: ProfileDigestSummary): boolean {
  return FAILING_STATUSES.has(profile.status);
}

export function digestFailed(summary: DigestSummary): boolean {
  return summary.errorCode !== null || summary.profiles.some(profileFailed);
}

function emptySummary(profileId: string, status: ProfileDigestStatus): ProfileDigestSummary {
  return {
    profileId,
    status,
    matched: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    uncertain: 0,
    overflow: 0,
  };
}

type ProfileSelection =
  | { readonly kind: "profile"; readonly profile: CompanyProfile }
  | { readonly kind: "skip"; readonly summary: ProfileDigestSummary };

async function selectProfiles(
  db: Kysely<Database>,
  profileId: string | null,
  logger: Logger,
): Promise<ProfileSelection[]> {
  const invalid = (id: string, fields: readonly string[]): ProfileSelection => {
    logger.warn("invalid stored profile skipped", { profileId: id, fields });
    return { kind: "skip", summary: emptySummary(id, "invalid_profile") };
  };
  if (profileId === null) {
    const { profiles, skipped } = await listActiveCompanyProfiles(db);
    return [
      ...skipped.map((row) => invalid(row.id, row.fields)),
      ...profiles.map((profile): ProfileSelection => ({ kind: "profile", profile })),
    ];
  }
  try {
    const profile = await getCompanyProfile(db, profileId);
    if (profile === null) return [{ kind: "skip", summary: emptySummary(profileId, "not_found") }];
    if (!profile.active) return [{ kind: "skip", summary: emptySummary(profileId, "inactive") }];
    return [{ kind: "profile", profile }];
  } catch (error: unknown) {
    if (!(error instanceof DomainError) || error.code !== "invalid_stored_row") throw error;
    return [invalid(profileId, error.fields)];
  }
}

/**
 * A fresh login token and unsubscribe token for one e-mail; null without
 * PUBLIC_BASE_URL; "address_changed" when the profile's address is no longer
 * the one read at the start of the run (an e-mail change on the web, D-027).
 */
async function issueLinks(
  db: Kysely<Database>,
  profile: CompanyProfile,
  publicBaseUrl: string | null,
): Promise<DigestLinks | null | "address_changed"> {
  if (publicBaseUrl === null) return null;
  const tokens = await issueDigestTokens(db, profile.id, profile.email);
  if (tokens === null) return "address_changed";
  const { login, unsubscribe } = tokens;
  return {
    profileUrl: loginUrl(publicBaseUrl, login.token),
    unsubscribeUrl: unsubscribeUrl(publicBaseUrl, unsubscribe.token),
  };
}

/**
 * One profile: skip it when today's digest is done (or its outcome is
 * unknown); else match, leave out offers already delivered (or given up
 * after DIGEST_MAX_ATTEMPTS), claim at most DIGEST_MAX_ITEMS — committed
 * before sending — send, and record the outcome. A crash or an uncertain
 * send leaves the claimed rows `pending`: they are reported, never resent.
 * `stop` is set when the send failure ends the run (stopCode).
 */
async function digestProfile(
  deps: DigestRunDeps,
  profile: CompanyProfile,
  candidates: readonly Opportunity[],
  digestDate: string,
  dryRun: boolean,
): Promise<{ readonly summary: ProfileDigestSummary; readonly stop: DigestStopCode | null }> {
  const done = (summary: ProfileDigestSummary) => ({ summary, stop: null });
  const { db, logger } = deps;
  const key: DeliveryKey = { profileId: profile.id, transport: deps.transport };
  const base = emptySummary(profile.id, "nothing_new");
  const before = await getProfileDeliverySummary(db, key, digestDate);
  if (before.today !== null) {
    const status = before.today === "sent" ? "already_sent_today" : "pending_today";
    return done({ ...base, status, uncertain: before.pending });
  }

  const matched = await matchingItems(profile, candidates);
  const states = await listDeliveryStates(
    db,
    key,
    matched.map((item) => item.offer.id),
  );
  // Candidates come soonest deadline first, so the cap keeps the most urgent.
  const eligible = matched.filter((item) => {
    const state = states.get(item.offer.id);
    return (
      state === undefined || (state.status === "failed" && state.attempts < DIGEST_MAX_ATTEMPTS)
    );
  });
  const selected = eligible.slice(0, DIGEST_MAX_ITEMS);
  const counts = {
    ...base,
    matched: matched.length,
    overflow: eligible.length - selected.length,
    uncertain: before.pending,
  };
  if (selected.length === 0) return done(counts);
  if (dryRun || deps.sender === null)
    return done({ ...counts, status: "dry_run", claimed: selected.length });

  // Issued before the claim, so a database failure here leaves no claimed
  // row pending; tokens of an e-mail never sent just expire unused.
  const links = await issueLinks(db, profile, deps.publicBaseUrl ?? null);
  // Nothing claimed yet: the next run sends these offers to the new address.
  if (links === "address_changed") return done({ ...counts, status: "address_changed" });
  const claimedIds = new Set(
    await claimDeliveries(db, {
      ...key,
      digestDate,
      newIds: selected.filter((item) => !states.has(item.offer.id)).map((item) => item.offer.id),
      retryIds: selected.filter((item) => states.has(item.offer.id)).map((item) => item.offer.id),
      maxAttempts: DIGEST_MAX_ATTEMPTS,
    }),
  );
  const items = selected.filter((item) => claimedIds.has(item.offer.id));
  if (items.length === 0) return done(counts);
  const ids = items.map((item) => item.offer.id);
  const claimed = { ...counts, claimed: items.length };

  const email = buildDigest(profile, items, deps.now, {
    overflow: counts.overflow,
    ...(links === null ? {} : { links }),
  });
  const result = await sendWithRetry(
    deps.sender,
    {
      to: profile.email,
      ...email,
      ...(links === null ? {} : { unsubscribeUrl: links.unsubscribeUrl }),
    },
    {
      sleep: deps.sleep,
      signal: deps.signal,
      ...(deps.retryDelaysMs === undefined ? {} : { delaysMs: deps.retryDelaysMs }),
    },
  );
  if (result.ok) {
    await markDeliveries(db, key, ids, { status: "sent" });
    return done({ ...claimed, status: "sent", sent: items.length });
  }
  const { code, kind } = result.error;
  const stop = stopCode(kind);
  if (kind === "uncertain") {
    logger.warn("digest send outcome unknown; offers left pending", {
      profileId: profile.id,
      errorCode: code,
      offers: items.length,
    });
    return {
      summary: {
        ...claimed,
        status: "uncertain",
        uncertain: before.pending + items.length,
        errorCode: code,
      },
      stop,
    };
  }
  // A setup or unreachable failure says nothing about these offers: no attempt is spent.
  await markDeliveries(db, key, ids, {
    status: "failed",
    errorCode: code,
    spendAttempt: stop === null,
  });
  logger.warn("digest send failed", {
    profileId: profile.id,
    errorCode: code,
    kind,
    offers: items.length,
  });
  return {
    summary: { ...claimed, status: "failed", failed: items.length, errorCode: code },
    stop,
  };
}

/**
 * Builds and (unless `dryRun`) sends today's digests. Today is the calendar
 * day in Poland at `deps.now`. Offers are read once for all profiles: not
 * closed or cancelled, deadline not passed (unknown kept), first stored in
 * the last DIGEST_NEW_DAYS days. Invalid stored offers are skipped and
 * counted; logs carry ids and counts only.
 */
export async function runDigest(
  deps: DigestRunDeps,
  options: DigestRunOptions,
): Promise<DigestSummary> {
  const { db, logger, now } = deps;
  const digestDate = warsawDay(now);
  const selections = await selectProfiles(db, options.profileId, logger);
  const candidates = await readDigestCandidates(db, now);
  for (const row of candidates.skipped) {
    logger.warn("invalid stored opportunity skipped", {
      opportunityId: row.id,
      fields: row.fields,
    });
  }
  const candidatesTruncated = candidates.truncated;
  if (candidatesTruncated) {
    logger.warn("digest candidate limit reached", { limit: DIGEST_CANDIDATE_LIMIT });
  }

  const profiles: ProfileDigestSummary[] = [];
  let errorCode: DigestStopCode | null = null;
  for (const selection of selections) {
    if (selection.kind === "skip") {
      profiles.push(selection.summary);
      continue;
    }
    // A lost lock or a failure that would repeat for every profile: spend nothing more.
    if (deps.signal.aborted || errorCode !== null) {
      profiles.push(emptySummary(selection.profile.id, "not_run"));
      continue;
    }
    const { summary, stop } = await digestProfile(
      deps,
      selection.profile,
      candidates.offers,
      digestDate,
      options.dryRun,
    );
    logger.info("digest profile done", { ...summary });
    profiles.push(summary);
    if (stop !== null) {
      errorCode = stop;
      logger.error("digest run stopped; remaining profiles not run", {
        profileId: summary.profileId,
        errorCode,
        sendErrorCode: summary.errorCode,
      });
    }
  }
  return {
    digestDate,
    transport: deps.transport,
    dryRun: options.dryRun,
    candidates: candidates.offers.length,
    candidatesTruncated,
    skippedInvalidRows: candidates.skipped.length,
    errorCode,
    profiles,
  };
}
