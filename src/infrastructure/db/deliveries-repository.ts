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
