import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { AccessTokenPurpose, Database } from "./schema.js";

/**
 * Secret tokens and sessions of the web access (PR-06A, D-026). Every
 * secret is 256 bits from the CSPRNG, base64url (43 characters); the
 * database stores only its SHA-256, so a leaked table grants nothing. A fast
 * hash is enough: the input is random, not a password. Validity is always
 * decided by the database clock (`now()`), in the same statement that reads
 * or uses the row.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A login link from an e-mail or `access:link`: single use, 7 days. */
export const LOGIN_TOKEN_TTL_MS = 168 * HOUR_MS;
/** An unsubscribe link (one per e-mail, RFC 8058): reusable, 60 days. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 1440 * HOUR_MS;
/** A browser session: absolute expiry, 30 days, not extended by use. */
export const SESSION_TTL_MS = 720 * HOUR_MS;

const TOKEN_TTL_MS: Readonly<Record<AccessTokenPurpose, number>> = {
  login: LOGIN_TOKEN_TTL_MS,
  unsubscribe: UNSUBSCRIBE_TOKEN_TTL_MS,
};

const TOKEN_BYTES = 32;
/** The form of every secret token: 32 bytes as base64url without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new secret: 256 bits from the CSPRNG, base64url. */
export function newSecretToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** True for a string shaped like a secret token (checked before any lookup). */
export function isSecretToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** SHA-256 of the token, hex: the only form a token is stored or looked up in. */
export function hashSecretToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `now() + ms` in SQL (the database clock decides every expiry). */
function nowPlus(ms: number) {
  return sql<Date>`now() + make_interval(secs => ${ms / 1000})`;
}

export interface IssuedToken {
  /** The secret itself: shown once (a link), never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** Stores a new token of `purpose` for the profile and returns the secret. */
export async function issueAccessToken(
  db: Kysely<Database>,
  profileId: string,
  purpose: AccessTokenPurpose,
): Promise<IssuedToken> {
  const token = newSecretToken();
  const row = await db
    .insertInto("access_tokens")
    .values({
      token_hash: hashSecretToken(token),
      profile_id: profileId,
      purpose,
      expires_at: nowPlus(TOKEN_TTL_MS[purpose]),
    })
    .returning("expires_at")
    .executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at };
}

/**
 * Read-only: is `token` an unexpired token of `purpose` (and, for a login
 * token, not used yet)? Pages shown on GET use this, so a mail scanner that
 * prefetches a link never uses it up.
 */
export async function isUsableAccessToken(
  db: Kysely<Database>,
  token: string,
  purpose: AccessTokenPurpose,
): Promise<boolean> {
  if (!isSecretToken(token)) return false;
  const row = await db
    .selectFrom("access_tokens")
    .select("id")
    .where("token_hash", "=", hashSecretToken(token))
    .where("purpose", "=", purpose)
    .where("used_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row !== undefined;
}

export interface NewSession {
  /** The session id for the cookie; never stored or logged. */
  readonly sessionToken: string;
  readonly profileId: string;
}

/**
 * Uses a login token up and opens a session, in one transaction: the token
 * is consumed by a single conditional UPDATE (unused and unexpired), so two
 * concurrent requests can never both succeed. null for an unknown, used or
 * expired token alike (the caller shows one neutral page).
 */
export async function consumeLoginToken(
  db: Kysely<Database>,
  token: string,
): Promise<NewSession | null> {
  if (!isSecretToken(token)) return null;
  return db.transaction().execute(async (trx) => {
    const used = await trx
      .updateTable("access_tokens")
      .set({ used_at: sql<Date>`now()` })
      .where("token_hash", "=", hashSecretToken(token))
      .where("purpose", "=", "login")
      .where("used_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .returning("profile_id")
      .executeTakeFirst();
    if (used === undefined) return null;
    const sessionToken = newSecretToken();
    await trx
      .insertInto("sessions")
      .values({
        token_hash: hashSecretToken(sessionToken),
        profile_id: used.profile_id,
        expires_at: nowPlus(SESSION_TTL_MS),
      })
      .execute();
    return { sessionToken, profileId: used.profile_id };
  });
}

/** The profile of an unexpired session, or null (unknown, expired or malformed id). */
export async function findSessionProfile(
  db: Kysely<Database>,
  sessionToken: string,
): Promise<string | null> {
  if (!isSecretToken(sessionToken)) return null;
  const row = await db
    .selectFrom("sessions")
    .select("profile_id")
    .where("token_hash", "=", hashSecretToken(sessionToken))
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row?.profile_id ?? null;
}

/** Logout: deletes the session row (a no-op when it is gone already). */
export async function deleteSession(db: Kysely<Database>, sessionToken: string): Promise<void> {
  if (!isSecretToken(sessionToken)) return;
  await db.deleteFrom("sessions").where("token_hash", "=", hashSecretToken(sessionToken)).execute();
}

/**
 * Switches the profile's notifications off. Idempotent: an inactive profile
 * stays inactive and keeps its `updated_at`. A plain UPDATE without reading
 * the row through the profile schema, so unsubscribing works even for a row
 * that no longer satisfies it. false when the profile does not exist.
 */
export async function deactivateProfile(db: Kysely<Database>, profileId: string): Promise<boolean> {
  const row = await db
    .updateTable("company_profiles")
    .set({
      active: false,
      updated_at: sql<Date>`CASE WHEN active THEN now() ELSE updated_at END`,
    })
    .where("id", "=", profileId)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * One-click unsubscribe (RFC 8058): deactivates the profile of an unexpired
 * unsubscribe token, in one statement. Reusable and idempotent: the token is
 * not used up, and a repeated request changes nothing. false for an unknown
 * or expired token.
 */
export async function unsubscribeWithToken(db: Kysely<Database>, token: string): Promise<boolean> {
  if (!isSecretToken(token)) return false;
  const row = await db
    .updateTable("company_profiles")
    .set({
      active: false,
      updated_at: sql<Date>`CASE WHEN active THEN now() ELSE updated_at END`,
    })
    .where(
      "id",
      "=",
      db
        .selectFrom("access_tokens")
        .select("profile_id")
        .where("token_hash", "=", hashSecretToken(token))
        .where("purpose", "=", "unsubscribe")
        .where("expires_at", ">", sql<Date>`now()`),
    )
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/** What a profile page shows; read directly, so a row the schema refuses still shows. */
export interface ProfileStatus {
  readonly name: string;
  readonly active: boolean;
}

export async function getProfileStatus(
  db: Kysely<Database>,
  profileId: string,
): Promise<ProfileStatus | null> {
  const row = await db
    .selectFrom("company_profiles")
    .select(["name", "active"])
    .where("id", "=", profileId)
    .executeTakeFirst();
  return row ?? null;
}

/** Expired rows deleted per table and call, so one cleanup is a short statement. */
export const ACCESS_CLEANUP_BATCH = 1000;

/**
 * Deletes at most `limit` expired tokens and `limit` expired sessions (used
 * login tokens go when they expire). Called by `serve` at start and hourly.
 */
export async function deleteExpiredAccess(
  db: Kysely<Database>,
  limit: number = ACCESS_CLEANUP_BATCH,
): Promise<{ readonly tokens: number; readonly sessions: number }> {
  const tokens = await db
    .deleteFrom("access_tokens")
    .where(
      "id",
      "in",
      db
        .selectFrom("access_tokens")
        .select("id")
        .where("expires_at", "<=", sql<Date>`now()`)
        .limit(limit),
    )
    .executeTakeFirst();
  const sessions = await db
    .deleteFrom("sessions")
    .where(
      "id",
      "in",
      db
        .selectFrom("sessions")
        .select("id")
        .where("expires_at", "<=", sql<Date>`now()`)
        .limit(limit),
    )
    .executeTakeFirst();
  return { tokens: Number(tokens.numDeletedRows), sessions: Number(sessions.numDeletedRows) };
}
