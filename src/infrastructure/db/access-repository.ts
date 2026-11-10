import { createHash, randomBytes } from "node:crypto";
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from "kysely";
import { isDeadlock, isUniqueViolation } from "./errors.js";
import type { AccessEmailKind, AccessTokenPurpose, Database } from "./schema.js";

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
/** The confirmation link of a new address (D-031): single use, 24 hours. */
export const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * HOUR_MS;

const TOKEN_TTL_MS: Readonly<Record<AccessTokenPurpose, number>> = {
  login: LOGIN_TOKEN_TTL_MS,
  unsubscribe: UNSUBSCRIBE_TOKEN_TTL_MS,
  email_change: EMAIL_CHANGE_TOKEN_TTL_MS,
};

/**
 * Access e-mails of one kind a profile gets per 24 hours at most (D-031): a
 * self-service login link, or an address confirmation. Counted in the
 * database under the profile row's lock, so concurrent requests cannot pass it.
 */
export const ACCESS_EMAILS_PER_DAY = 3;

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

/**
 * Stores a new token of `purpose` for the profile and returns the secret.
 * An `email_change` token is issued by requestEmailChange only: it is bound
 * to its pending address.
 */
export async function issueAccessToken(
  db: Kysely<Database>,
  profileId: string,
  purpose: Exclude<AccessTokenPurpose, "email_change">,
): Promise<IssuedToken> {
  return insertToken(db, profileId, purpose, null);
}

async function insertToken(
  db: Kysely<Database>,
  profileId: string,
  purpose: AccessTokenPurpose,
  email: string | null,
): Promise<IssuedToken> {
  const token = newSecretToken();
  const row = await db
    .insertInto("access_tokens")
    .values({
      token_hash: hashSecretToken(token),
      profile_id: profileId,
      purpose,
      expires_at: nowPlus(TOKEN_TTL_MS[purpose]),
      email,
    })
    .returning("expires_at")
    .executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at };
}

/**
 * The two links of one digest e-mail (D-027), issued only while the profile
 * still has `email`, the address the e-mail goes to. The profile row is
 * locked FOR SHARE first: an e-mail change in progress (FOR NO KEY UPDATE)
 * is waited for, and the row is then read again with its new address. null
 * when the address differs (or the profile is gone): nothing is issued.
 */
export async function issueDigestTokens(
  db: Kysely<Database>,
  profileId: string,
  email: string,
): Promise<{ readonly login: IssuedToken; readonly unsubscribe: IssuedToken } | null> {
  return db.transaction().execute(async (trx) => {
    const profile = await trx
      .selectFrom("company_profiles")
      .select("id")
      .where("id", "=", profileId)
      .where("email", "=", email)
      .forShare()
      .executeTakeFirst();
    if (profile === undefined) return null;
    const login = await issueAccessToken(trx, profileId, "login");
    return { login, unsubscribe: await issueAccessToken(trx, profileId, "unsubscribe") };
  });
}

/**
 * Read-only: is `token` an unexpired token of `purpose` (and, for a login
 * token, not used yet)? Pages shown on GET use this, so a mail scanner that
 * prefetches a link never uses it up.
 */
export async function isUsableAccessToken(
  db: Kysely<Database>,
  token: string,
  purpose: Exclude<AccessTokenPurpose, "email_change">,
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

/**
 * The unexpired session's own id (the row's uuid, never the cookie value)
 * and its profile, or null like findSessionProfile.
 */
export async function findSession(
  db: Kysely<Database>,
  sessionToken: string,
): Promise<{ readonly sessionId: string; readonly profileId: string } | null> {
  if (!isSecretToken(sessionToken)) return null;
  const row = await db
    .selectFrom("sessions")
    .select(["id", "profile_id"])
    .where("token_hash", "=", hashSecretToken(sessionToken))
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row === undefined ? null : { sessionId: row.id, profileId: row.profile_id };
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

/**
 * "Włącz ponownie powiadomienia" on the profile page (PR-06B): the mirror of
 * deactivateProfile, idempotent the same way. false when the profile does not exist.
 */
export async function activateProfile(db: Kysely<Database>, profileId: string): Promise<boolean> {
  const row = await db
    .updateTable("company_profiles")
    .set({
      active: true,
      updated_at: sql<Date>`CASE WHEN active THEN updated_at ELSE now() END`,
    })
    .where("id", "=", profileId)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The company name of an unexpired unsubscribe token, for its confirmation
 * page (the token's holder can unsubscribe anyway); null for an unknown or
 * expired token. Read-only, like isUsableAccessToken.
 */
export async function unsubscribeTokenProfileName(
  db: Kysely<Database>,
  token: string,
): Promise<string | null> {
  if (!isSecretToken(token)) return null;
  const row = await db
    .selectFrom("access_tokens")
    .innerJoin("company_profiles", "company_profiles.id", "access_tokens.profile_id")
    .select("company_profiles.name")
    .where("access_tokens.token_hash", "=", hashSecretToken(token))
    .where("access_tokens.purpose", "=", "unsubscribe")
    .where("access_tokens.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row?.name ?? null;
}

/** What a profile page shows; read directly, so a row the schema refuses still shows. */
export interface ProfileStatus {
  readonly name: string;
  /** The current notification address (the profile page shows it to its own session). */
  readonly email: string;
  readonly active: boolean;
  /** A new address waiting for its confirmation (D-031); null when none. */
  readonly pendingEmail: string | null;
  /** `pendingEmail` is set but its confirmation link no longer works (pendingEmailLinkLive). */
  readonly pendingEmailExpired: boolean;
}

/**
 * Whether the profile's pending address (D-031) still has an unexpired
 * confirmation link — the one condition isUsableEmailChangeToken checks
 * besides the token itself. False once the link expired or was revoked
 * (access:revoke): `pending_email` stays, and the profile pages say the link
 * expired instead of „Oczekuje na potwierdzenie”. A subquery of the profile
 * row's own SELECT, so no extra query.
 */
export function pendingEmailLinkLive(eb: ExpressionBuilder<Database, "company_profiles">) {
  return eb.exists(
    eb
      .selectFrom("access_tokens")
      .select("access_tokens.id")
      .whereRef("access_tokens.profile_id", "=", "company_profiles.id")
      .where("access_tokens.purpose", "=", "email_change")
      .whereRef("access_tokens.email", "=", "company_profiles.pending_email")
      .where("access_tokens.expires_at", ">", sql<Date>`now()`),
  );
}

export async function getProfileStatus(
  db: Kysely<Database>,
  profileId: string,
): Promise<ProfileStatus | null> {
  const row = await db
    .selectFrom("company_profiles")
    .select(["name", "email", "active", "pending_email"])
    .select((eb) => pendingEmailLinkLive(eb).as("pending_link_live"))
    .where("id", "=", profileId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    name: row.name,
    email: row.email,
    active: row.active,
    pendingEmail: row.pending_email,
    pendingEmailExpired: row.pending_email !== null && row.pending_link_live !== true,
  };
}

/**
 * Inside `trx`, which holds the profile row (FOR NO KEY UPDATE): records one
 * more access e-mail of `kind` and returns true, unless the profile already
 * had ACCESS_EMAILS_PER_DAY of them in the last 24 hours (false, nothing
 * recorded). The row lock makes count and insert atomic: a concurrent
 * request waits for it, and its count — a new statement in READ COMMITTED —
 * then sees this one's row.
 */
async function claimAccessEmail(
  trx: Transaction<Database>,
  profileId: string,
  kind: AccessEmailKind,
): Promise<boolean> {
  const sent = await trx
    .selectFrom("access_emails")
    .select(sql<string>`count(*)`.as("count"))
    .where("profile_id", "=", profileId)
    .where("kind", "=", kind)
    .where("created_at", ">", sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirstOrThrow();
  if (Number(sent.count) >= ACCESS_EMAILS_PER_DAY) return false;
  await trx.insertInto("access_emails").values({ profile_id: profileId, kind }).execute();
  return true;
}

/** What one „Wyślij mi link” request found (D-031); never shown to the requester. */
export type LoginLinkRequest =
  | {
      readonly kind: "issued";
      readonly profileId: string;
      /** The profile's address, where the link goes. */
      readonly email: string;
      readonly link: IssuedToken;
    }
  | { readonly kind: "limit_reached"; readonly profileId: string }
  | { readonly kind: "no_profile" };

/**
 * „Wyślij mi link” (D-031): a new login token for the profile whose current
 * address is `email` (already normalized), also when its e-mails are off
 * (`active = false`), at most ACCESS_EMAILS_PER_DAY per 24 hours. One
 * transaction: the profile row FOR NO KEY UPDATE first, like every other
 * writer of the profile's access (updateProfileSettings), then the count and
 * the token. A pending address is not looked up: until it is confirmed,
 * links go to the current one.
 */
export async function requestLoginLink(
  db: Kysely<Database>,
  email: string,
): Promise<LoginLinkRequest> {
  return db.transaction().execute(async (trx): Promise<LoginLinkRequest> => {
    const profile = await trx
      .selectFrom("company_profiles")
      .select(["id", "email"])
      .where("email", "=", email)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (profile === undefined) return { kind: "no_profile" };
    if (!(await claimAccessEmail(trx, profile.id, "login_link"))) {
      return { kind: "limit_reached", profileId: profile.id };
    }
    const link = await issueAccessToken(trx, profile.id, "login");
    return { kind: "issued", profileId: profile.id, email: profile.email, link };
  });
}

/**
 * Inside the transaction of the profile form's save (updateProfileSettings,
 * which holds the profile row): a new confirmation link for `email`, the
 * address that goes into pending_email. Any earlier `email_change` token of
 * the profile is deleted first — a new change replaces the pending one. null
 * when the profile had ACCESS_EMAILS_PER_DAY confirmations in 24 hours.
 */
export async function requestEmailChange(
  trx: Transaction<Database>,
  profileId: string,
  email: string,
): Promise<IssuedToken | null> {
  if (!(await claimAccessEmail(trx, profileId, "email_change"))) return null;
  await deleteEmailChangeTokens(trx, profileId);
  return insertToken(trx, profileId, "email_change", email);
}

async function deleteEmailChangeTokens(
  trx: Transaction<Database>,
  profileId: string,
): Promise<void> {
  await trx
    .deleteFrom("access_tokens")
    .where("profile_id", "=", profileId)
    .where("purpose", "=", "email_change")
    .execute();
}

/**
 * Read-only, for GET /potwierdz-email/<token>: is `token` an unexpired
 * confirmation link of the address still pending on its profile? A mail
 * scanner fetching the link changes nothing.
 */
export async function isUsableEmailChangeToken(
  db: Kysely<Database>,
  token: string,
): Promise<boolean> {
  if (!isSecretToken(token)) return false;
  const row = await db
    .selectFrom("access_tokens")
    .innerJoin("company_profiles", "company_profiles.id", "access_tokens.profile_id")
    .select("access_tokens.id")
    .where("access_tokens.token_hash", "=", hashSecretToken(token))
    .where("access_tokens.purpose", "=", "email_change")
    .where("access_tokens.expires_at", ">", sql<Date>`now()`)
    .whereRef("access_tokens.email", "=", "company_profiles.pending_email")
    .executeTakeFirst();
  return row !== undefined;
}

/** The outcome of POST /potwierdz-email/<token> (D-031). */
export type EmailChangeConfirmation =
  | {
      readonly kind: "changed";
      readonly profileId: string;
      /** The confirming browser's session belongs to the profile and stays open. */
      readonly keptSession: boolean;
    }
  /** Unknown, expired, already used, cancelled or replaced: one neutral page for all. */
  | { readonly kind: "invalid" }
  /** Another profile has the address by now: nothing changed. */
  | { readonly kind: "taken" };

/**
 * Confirms a pending address (D-031), in one transaction: `email` becomes
 * pending_email, pending_email is cleared, and every token of the profile —
 * this one included, which uses it up — and every session but the
 * confirming browser's (when it is the profile's) is deleted, as the e-mail
 * change of D-027 did. Lock order (D-027): profile row FOR NO KEY UPDATE →
 * the kept session FOR KEY SHARE → tokens (DELETE) → other sessions
 * (DELETE) → the profile UPDATE, last. Changing `email` (a unique key)
 * makes that UPDATE take the FOR UPDATE-strength lock, which waits for the
 * KEY SHARE of a login's session INSERT; such a login holds its token row,
 * which the tokens DELETE has waited for already, so it has no lock left to
 * take, and its new session is deleted with the others (a new snapshot per
 * statement). A deadlock with the hourly cleanup stays possible in theory
 * and is retried once. Two confirmations of one link: the second waits for the
 * profile row, then finds pending_email cleared and the token gone — exactly
 * one changes the address. Another profile using the address by now (the
 * UNIQUE key) rolls everything back: `taken`.
 */
export async function confirmEmailChange(
  db: Kysely<Database>,
  token: string,
  sessionToken: string | null,
): Promise<EmailChangeConfirmation> {
  if (!isSecretToken(token)) return { kind: "invalid" };
  const tokenHash = hashSecretToken(token);
  const liveLink = (trx: Transaction<Database>) =>
    trx
      .selectFrom("access_tokens")
      .select(["profile_id", "email"])
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", "email_change")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
  const confirm = () =>
    db.transaction().execute(async (trx): Promise<EmailChangeConfirmation> => {
      const found = await liveLink(trx);
      if (found === undefined || found.email === null) return { kind: "invalid" };
      const profileId = found.profile_id;
      const profile = await trx
        .selectFrom("company_profiles")
        .select("pending_email")
        .where("id", "=", profileId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      // Read again under the row lock: a confirmation, cancel or new change
      // that held it has deleted or replaced the token meanwhile.
      const link = await liveLink(trx);
      if (profile === undefined || link === undefined || link.email !== profile.pending_email) {
        return { kind: "invalid" };
      }
      const keep =
        sessionToken !== null && (await lockLiveSession(trx, profileId, sessionToken))
          ? sessionToken
          : null;
      await deleteAccess(trx, profileId, keep === null ? null : hashSecretToken(keep));
      await trx
        .updateTable("company_profiles")
        .set({
          email: sql<string>`pending_email`,
          pending_email: null,
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", profileId)
        .execute();
      return { kind: "changed", profileId, keptSession: keep !== null };
    });
  const attempt = async (): Promise<EmailChangeConfirmation> => {
    try {
      return await confirm();
    } catch (error: unknown) {
      if (isUniqueViolation(error, "company_profiles_email_key")) return { kind: "taken" };
      throw error;
    }
  };
  try {
    return await attempt();
  } catch (error: unknown) {
    if (!isDeadlock(error)) throw error;
    return attempt();
  }
}

/**
 * „Anuluj zmianę” (D-031): clears pending_email and deletes the profile's
 * confirmation link, so a link already sent no longer works. Idempotent.
 * Profile row first, then the session (as in updateProfileSettings); false —
 * nothing changed — when the session ended meanwhile.
 */
export async function cancelEmailChange(
  db: Kysely<Database>,
  profileId: string,
  sessionToken: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const profile = await trx
      .selectFrom("company_profiles")
      .select("id")
      .where("id", "=", profileId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (profile === undefined) return false;
    if (!(await lockLiveSession(trx, profileId, sessionToken))) return false;
    await deleteEmailChangeTokens(trx, profileId);
    await trx
      .updateTable("company_profiles")
      .set({ pending_email: null })
      .where("id", "=", profileId)
      .where("pending_email", "is not", null)
      .execute();
    return true;
  });
}

/** What `revokeProfileAccess` deleted. */
export interface RevokedAccess {
  readonly tokens: number;
  readonly sessions: number;
}

/**
 * `access:revoke`: deletes every token (login, unsubscribe and an address
 * confirmation; used or not) and every session of the profile, in one
 * transaction, so each e-mail link and signed-in browser stops working at
 * once (a forwarded digest, a lost device; D-026). The profile row itself is
 * not touched: a pending address stays until cancelled or saved again.
 */
export async function revokeProfileAccess(
  db: Kysely<Database>,
  profileId: string,
): Promise<RevokedAccess> {
  return db.transaction().execute(async (trx) => {
    // The profile row first, like the e-mail confirmation (confirmEmailChange):
    // the two never run interleaved, so they cannot deadlock over tokens and sessions.
    await trx
      .selectFrom("company_profiles")
      .select("id")
      .where("id", "=", profileId)
      .forNoKeyUpdate()
      .execute();
    return deleteAccess(trx, profileId, null);
  });
}

/**
 * Inside `trx`: true when the session is unexpired and the profile's, and
 * then locked (FOR KEY SHARE) so a logout or revoke cannot delete it before
 * `trx` ends. false when it is gone or expired.
 */
export async function lockLiveSession(
  trx: Transaction<Database>,
  profileId: string,
  sessionToken: string,
): Promise<boolean> {
  if (!isSecretToken(sessionToken)) return false;
  const row = await trx
    .selectFrom("sessions")
    .select("id")
    .where("token_hash", "=", hashSecretToken(sessionToken))
    .where("profile_id", "=", profileId)
    .where("expires_at", ">", sql<Date>`now()`)
    .forKeyShare()
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Tokens go first: a login racing with the revoke either has its token
 * deleted under it (the conditional UPDATE then finds nothing) or holds the
 * token row until it commits, so its new session is already visible to the
 * sessions DELETE (a new snapshot per statement in READ COMMITTED).
 */
async function deleteAccess(
  trx: Transaction<Database>,
  profileId: string,
  keepSessionHash: string | null,
): Promise<RevokedAccess> {
  const tokens = await trx
    .deleteFrom("access_tokens")
    .where("profile_id", "=", profileId)
    .executeTakeFirst();
  let sessions = trx.deleteFrom("sessions").where("profile_id", "=", profileId);
  if (keepSessionHash !== null) sessions = sessions.where("token_hash", "<>", keepSessionHash);
  const deleted = await sessions.executeTakeFirst();
  return { tokens: Number(tokens.numDeletedRows), sessions: Number(deleted.numDeletedRows) };
}

/** Expired rows deleted per table and call, so one cleanup is a short statement. */
export const ACCESS_CLEANUP_BATCH = 1000;

/**
 * Deletes at most `limit` access_emails rows older than 24 hours: the daily
 * limits no longer count them. Called by `serve` with deleteExpiredAccess.
 */
export async function deleteOldAccessEmails(
  db: Kysely<Database>,
  limit: number = ACCESS_CLEANUP_BATCH,
): Promise<number> {
  const deleted = await db
    .deleteFrom("access_emails")
    .where(
      "id",
      "in",
      db
        .selectFrom("access_emails")
        .select("id")
        .where("created_at", "<=", sql<Date>`now() - interval '24 hours'`)
        .limit(limit),
    )
    .executeTakeFirst();
  return Number(deleted.numDeletedRows);
}

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
