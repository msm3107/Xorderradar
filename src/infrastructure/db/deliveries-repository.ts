import { sql, type Kysely } from "kysely";
import type { Database, DeliveryStatus, DeliveryTransport } from "./schema.js";

/**
 * Persistence of `digest` deliveries (migration 0005, D-024). A row says "this
 * offer went (or is going) to this profile over this transport"; the unique
 * key (profile, offer, transport) makes every delivery at-most-once.
 */

export interface DeliveryKey {
  readonly profileId: string;
  readonly transport: DeliveryTransport;
}

export interface ProfileDeliverySummary {
  /** Today's digest: `sent` if one went out, else `pending` if one may have. */
  readonly today: "sent" | "pending" | null;
  /** All rows still `pending` (a run stopped between claim and outcome). */
  readonly pending: number;
}

/** What is known about the profile's deliveries before a run decides anything. */
export async function getProfileDeliverySummary(
  db: Kysely<Database>,
  key: DeliveryKey,
  digestDate: string,
): Promise<ProfileDeliverySummary> {
  const row = await db
    .selectFrom("deliveries")
    .select([
      sql<string>`count(*) FILTER (WHERE status = 'pending')`.as("pending"),
      sql<boolean>`coalesce(bool_or(status = 'sent' AND digest_date = ${digestDate}::date), false)`.as(
        "sent_today",
      ),
      sql<boolean>`coalesce(bool_or(status = 'pending' AND digest_date = ${digestDate}::date), false)`.as(
        "pending_today",
      ),
    ])
    .where("profile_id", "=", key.profileId)
    .where("transport", "=", key.transport)
    .executeTakeFirstOrThrow();
  return {
    today: row.sent_today ? "sent" : row.pending_today ? "pending" : null,
    // count(*) is bigint, which `pg` returns as text.
    pending: Number(row.pending),
  };
}

export interface DeliveryState {
  readonly status: DeliveryStatus;
  readonly attempts: number;
}

/** The existing deliveries of the given offers to the profile, by offer id. */
export async function listDeliveryStates(
  db: Kysely<Database>,
  key: DeliveryKey,
  opportunityIds: readonly string[],
): Promise<Map<string, DeliveryState>> {
  const states = new Map<string, DeliveryState>();
  if (opportunityIds.length === 0) return states;
  const rows = await db
    .selectFrom("deliveries")
    .select(["opportunity_id", "status", "attempts"])
    .where("profile_id", "=", key.profileId)
    .where("transport", "=", key.transport)
    .where("opportunity_id", "=", sql<string>`ANY(${[...opportunityIds]}::uuid[])`)
    .execute();
  for (const row of rows) {
    states.set(row.opportunity_id, { status: row.status, attempts: row.attempts });
  }
  return states;
}

export interface ClaimRequest extends DeliveryKey {
  readonly digestDate: string;
  /** Offers never delivered to the profile: inserted as `pending`. */
  readonly newIds: readonly string[];
  /** Offers whose delivery failed before: set back to `pending` if still below the limit. */
  readonly retryIds: readonly string[];
  readonly maxAttempts: number;
}

/**
 * Claims offers for one e-mail in one transaction and returns the ids
 * actually claimed — only those may be sent. A row that exists already
 * (another run claimed or sent it) is not inserted (ON CONFLICT DO NOTHING);
 * a failed row is taken back only while it is still `failed` and below the
 * attempt limit. The claim is committed before the e-mail is sent, so a crash
 * after it leaves `pending` rows that are never sent again (at-most-once).
 */
export async function claimDeliveries(
  db: Kysely<Database>,
  request: ClaimRequest,
): Promise<string[]> {
  const { profileId, transport, digestDate } = request;
  return db.transaction().execute(async (trx) => {
    const claimed: string[] = [];
    if (request.newIds.length > 0) {
      const inserted = await trx
        .insertInto("deliveries")
        .values(
          request.newIds.map((opportunityId) => ({
            profile_id: profileId,
            opportunity_id: opportunityId,
            transport,
            digest_date: digestDate,
            status: "pending" as const,
            attempts: 0,
          })),
        )
        .onConflict((oc) =>
          oc.constraint("deliveries_profile_opportunity_transport_key").doNothing(),
        )
        .returning("opportunity_id")
        .execute();
      claimed.push(...inserted.map((row) => row.opportunity_id));
    }
    if (request.retryIds.length > 0) {
      const retried = await trx
        .updateTable("deliveries")
        .set({ status: "pending", digest_date: digestDate, error_code: null })
        .where("profile_id", "=", profileId)
        .where("transport", "=", transport)
        .where("opportunity_id", "=", sql<string>`ANY(${[...request.retryIds]}::uuid[])`)
        .where("status", "=", "failed")
        .where("attempts", "<", request.maxAttempts)
        .returning("opportunity_id")
        .execute();
      claimed.push(...retried.map((row) => row.opportunity_id));
    }
    return claimed;
  });
}

export type DeliveryOutcome =
  | { readonly status: "sent" }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      /**
       * false when the failure was about the run, not the message (a broken
       * SMTP setup, an unreachable server): the attempt is not counted, so the
       * offer stays eligible once the cause is fixed.
       */
      readonly spendAttempt: boolean;
    };

/** Records the outcome of one e-mail for its claimed rows (only rows still `pending`). */
export async function markDeliveries(
  db: Kysely<Database>,
  key: DeliveryKey,
  opportunityIds: readonly string[],
  outcome: DeliveryOutcome,
): Promise<void> {
  if (opportunityIds.length === 0) return;
  const spendAttempt = outcome.status === "sent" || outcome.spendAttempt;
  await db
    .updateTable("deliveries")
    .set(
      outcome.status === "sent"
        ? { status: "sent", sent_at: sql<Date>`now()`, error_code: null }
        : { status: "failed", error_code: outcome.errorCode },
    )
    .set((eb) => ({ attempts: spendAttempt ? eb("attempts", "+", 1) : eb.ref("attempts") }))
    .where("profile_id", "=", key.profileId)
    .where("transport", "=", key.transport)
    .where("opportunity_id", "=", sql<string>`ANY(${[...opportunityIds]}::uuid[])`)
    .where("status", "=", "pending")
    .execute();
}

/** Groups listed by `deliveries:pending` at most (one per profile, transport and day). */
export const PENDING_DELIVERIES_MAX_GROUPS = 1000;

/** The pending rows of one profile, transport and digest day: ids and counts only. */
export interface PendingDeliveryGroup {
  readonly profileId: string;
  readonly transport: DeliveryTransport;
  /** `YYYY-MM-DD`. */
  readonly digestDate: string;
  readonly offers: number;
  /** The oldest claim among them (when the e-mail was about to be sent). */
  readonly oldestCreatedAt: Date;
}

export interface PendingDeliveries {
  readonly groups: readonly PendingDeliveryGroup[];
  /** More groups exist than PENDING_DELIVERIES_MAX_GROUPS. */
  readonly truncated: boolean;
}

/**
 * Every `pending` row (an uncertain send or a run stopped between claim and
 * outcome, D-024), grouped per profile, transport and digest day, oldest day
 * first. Ids, dates and counts only — never addresses or offer titles.
 */
export async function listPendingDeliveries(db: Kysely<Database>): Promise<PendingDeliveries> {
  const { rows } = await sql<{
    profile_id: string;
    transport: DeliveryTransport;
    digest_date: string;
    offers: string;
    oldest_created_at: Date;
  }>`
    SELECT
      profile_id,
      transport,
      to_char(digest_date, 'YYYY-MM-DD') AS digest_date,
      count(*) AS offers,
      min(created_at) AS oldest_created_at
    FROM deliveries
    WHERE status = 'pending'
    GROUP BY profile_id, transport, digest_date
    ORDER BY digest_date, profile_id, transport
    LIMIT ${PENDING_DELIVERIES_MAX_GROUPS + 1}
  `.execute(db);
  return {
    groups: rows.slice(0, PENDING_DELIVERIES_MAX_GROUPS).map((row) => ({
      profileId: row.profile_id,
      transport: row.transport,
      digestDate: row.digest_date,
      // count(*) is bigint, which `pg` returns as text.
      offers: Number(row.offers),
      oldestCreatedAt: row.oldest_created_at,
    })),
    truncated: rows.length > PENDING_DELIVERIES_MAX_GROUPS,
  };
}

export interface ResolveRequest {
  readonly profileId: string;
  /** `YYYY-MM-DD`; null: every pending row of the profile. */
  readonly digestDate: string | null;
  /**
   * `sent`: the e-mail arrived — the rows become `sent` (`sent_at` now,
   * `attempts + 1`). `failed`: it did not — the rows are deleted, so the next
   * digest sends those offers as new (if they still qualify).
   */
  readonly outcome: "sent" | "failed";
  /** The digest's advisory-lock key (DIGEST_LOCK_KEY): nothing changes while a digest runs. */
  readonly digestLockKey: number;
}

/** `lock_busy`: a digest run (or another `deliveries:resolve`) holds the digest lock. */
export type ResolveResult =
  { readonly status: "resolved"; readonly changed: number } | { readonly status: "lock_busy" };

/**
 * The operator's decision on pending deliveries (`deliveries:resolve`,
 * D-024) in one transaction: only rows still `pending` of the profile (and
 * day) change. The digest lock is taken first without waiting
 * (`pg_try_advisory_xact_lock`, released at commit/rollback): while a digest
 * holds it — its claimed rows are `pending` until it records the outcome —
 * nothing changes (`lock_busy`, also while another resolve holds it); and
 * while this transaction holds it, a digest starting meanwhile is skipped.
 * `changed` 0: no pending row matched.
 */
export async function resolvePendingDeliveries(
  db: Kysely<Database>,
  request: ResolveRequest,
): Promise<ResolveResult> {
  return db.transaction().execute(async (trx): Promise<ResolveResult> => {
    const { rows } = await sql<{
      acquired: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${request.digestLockKey}::bigint) AS acquired`.execute(trx);
    if (rows[0]?.acquired !== true) return { status: "lock_busy" };
    const day = request.digestDate;
    const changed =
      request.outcome === "sent"
        ? await trx
            .updateTable("deliveries")
            .set({ status: "sent", sent_at: sql<Date>`now()`, error_code: null })
            .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
            .where("profile_id", "=", request.profileId)
            .where("status", "=", "pending")
            .$if(day !== null, (qb) => qb.where("digest_date", "=", sql<Date>`${day}::date`))
            .returning("id")
            .execute()
        : await trx
            .deleteFrom("deliveries")
            .where("profile_id", "=", request.profileId)
            .where("status", "=", "pending")
            .$if(day !== null, (qb) => qb.where("digest_date", "=", sql<Date>`${day}::date`))
            .returning("id")
            .execute();
    return { status: "resolved", changed: changed.length };
  });
}
