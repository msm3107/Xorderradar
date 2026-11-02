import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { z } from "zod";
import {
  companyProfileInputSchema,
  companyProfilePatchSchema,
  companyProfileSettingsSchema,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfilePatch,
  type CompanyProfileSettings,
} from "../../domain/company-profile.js";
import { entityIdSchema, parseDomain } from "../../domain/common.js";
import { DomainError } from "../../domain/errors.js";
import { lockLiveSession, revokeOtherAccess } from "./access-repository.js";
import { isDeadlock, withDomainErrors } from "./errors.js";
import type { CompanyProfilesTable, Database } from "./schema.js";

/**
 * Maps a row to the domain type. The columns have no CHECKs for the profile
 * rules (closed category list, canonical voivodeships, …; D-023), so the row
 * is validated with the input schema; a row that no longer satisfies it (e.g.
 * edited by hand) is refused as DomainError `invalid_stored_row` with the
 * field paths only, never the values.
 */
function toCompanyProfile(row: Selectable<CompanyProfilesTable>): CompanyProfile {
  const result = companyProfileInputSchema.safeParse({
    email: row.email,
    name: row.name,
    categories: row.categories,
    includeKeywords: row.include_keywords,
    excludeKeywords: row.exclude_keywords,
    voivodeships: row.voivodeships,
    counties: row.counties,
    active: row.active,
  });
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)")),
    ];
    throw new DomainError(
      "invalid_stored_row",
      `Stored company profile ${row.id} does not match the domain schema: ${fields.join(", ")}`,
      fields,
      null,
      row.id,
    );
  }
  return { id: row.id, ...result.data, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Creates a profile. The same e-mail (case-insensitive) twice → DomainError `duplicate`. */
export async function createCompanyProfile(
  db: Kysely<Database>,
  input: CompanyProfileInput,
): Promise<CompanyProfile> {
  const profile = parseDomain(companyProfileInputSchema, input);
  const row = await withDomainErrors(() =>
    db
      .insertInto("company_profiles")
      .values({
        email: profile.email,
        name: profile.name,
        categories: profile.categories,
        include_keywords: profile.includeKeywords,
        exclude_keywords: profile.excludeKeywords,
        voivodeships: profile.voivodeships,
        counties: profile.counties,
        active: profile.active,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
  return toCompanyProfile(row);
}

export async function getCompanyProfile(
  db: Kysely<Database>,
  id: string,
): Promise<CompanyProfile | null> {
  const profileId = parseDomain(entityIdSchema, id);
  const row = await db
    .selectFrom("company_profiles")
    .selectAll()
    .where("id", "=", profileId)
    .executeTakeFirst();
  return row === undefined ? null : toCompanyProfile(row);
}

/** A stored profile left out of a list because it no longer satisfies the schema. */
export interface SkippedProfile {
  readonly id: string;
  /** Field paths only, never values. */
  readonly fields: readonly string[];
}

/**
 * All active profiles, oldest first (then by id), for `digest`. A row that
 * fails the schema does not abort the list: it is returned in `skipped` with
 * its id and field paths.
 */
export async function listActiveCompanyProfiles(
  db: Kysely<Database>,
): Promise<{ readonly profiles: CompanyProfile[]; readonly skipped: SkippedProfile[] }> {
  const rows = await db
    .selectFrom("company_profiles")
    .selectAll()
    .where("active", "=", true)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const profiles: CompanyProfile[] = [];
  const skipped: SkippedProfile[] = [];
  for (const row of rows) {
    try {
      profiles.push(toCompanyProfile(row));
    } catch (error: unknown) {
      if (!(error instanceof DomainError) || error.code !== "invalid_stored_row") throw error;
      skipped.push({ id: row.id, fields: error.fields });
    }
  }
  return { profiles, skipped };
}

/**
 * Updates the given fields only; returns null when the profile does not exist.
 * The merged row is validated inside the same transaction as the UPDATE: when
 * the result does not satisfy the schema (an untouched field of an old row,
 * e.g. empty categories) the call fails with `invalid_stored_row` and the
 * write is rolled back, so a failed call never changes the row.
 */
export async function updateCompanyProfile(
  db: Kysely<Database>,
  id: string,
  patch: CompanyProfilePatch,
): Promise<CompanyProfile | null> {
  const profileId = parseDomain(entityIdSchema, id);
  const changes = parseDomain(companyProfilePatchSchema, patch);
  return db.transaction().execute((trx) => updateRow(trx, profileId, changes));
}

async function updateRow(
  trx: Transaction<Database>,
  profileId: string,
  changes: z.output<typeof companyProfilePatchSchema>,
): Promise<CompanyProfile | null> {
  const row = await withDomainErrors(() =>
    trx
      .updateTable("company_profiles")
      // Undefined values are skipped by Kysely, so absent fields stay untouched.
      .set({
        email: changes.email,
        name: changes.name,
        categories: changes.categories,
        include_keywords: changes.includeKeywords,
        exclude_keywords: changes.excludeKeywords,
        voivodeships: changes.voivodeships,
        counties: changes.counties,
        active: changes.active,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", profileId)
      .returningAll()
      .executeTakeFirst(),
  );
  return row === undefined ? null : toCompanyProfile(row);
}

/** The stored values of the profile form's fields, as stored (not validated). */
export interface StoredProfileSettings {
  readonly email: string;
  readonly name: string;
  readonly categories: readonly string[];
  readonly includeKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly voivodeships: readonly string[];
  readonly counties: readonly string[];
}

/**
 * The profile form's current values (PR-06B), read directly like
 * getProfileStatus: a row the schema refuses still fills the form, so the
 * customer can correct it (the schema checks every field again on save).
 * null when the profile does not exist.
 */
export async function getProfileSettings(
  db: Kysely<Database>,
  id: string,
): Promise<StoredProfileSettings | null> {
  const row = await db
    .selectFrom("company_profiles")
    .select([
      "email",
      "name",
      "categories",
      "include_keywords",
      "exclude_keywords",
      "voivodeships",
      "counties",
    ])
    .where("id", "=", parseDomain(entityIdSchema, id))
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    email: row.email,
    name: row.name,
    categories: row.categories,
    includeKeywords: row.include_keywords,
    excludeKeywords: row.exclude_keywords,
    voivodeships: row.voivodeships,
    counties: row.counties,
  };
}

export interface SettingsUpdate {
  readonly profile: CompanyProfile;
  /** The e-mail address changed, so the profile's other access was revoked. */
  readonly emailChanged: boolean;
}

/**
 * Saves the profile form (PR-06B, D-027): every field but `active`, in one
 * transaction. When the e-mail address changes, every access token of the
 * profile and every session except `keepSessionToken` (the one that made the
 * change) is deleted in the same transaction: the links in e-mails sent to
 * the old address and every other signed-in browser stop working. Other
 * changes revoke nothing. null — nothing saved — when the profile does not
 * exist or the session ended meanwhile (a logout or revoke in another tab);
 * the same e-mail as another profile → DomainError `duplicate`.
 *
 * Lock order, so no concurrent writer can close a cycle with this one:
 * profile row FOR NO KEY UPDATE → the kept session FOR KEY SHARE → tokens
 * (DELETE) → other sessions (DELETE) → the profile UPDATE, last. Changing
 * the e-mail (a unique key) makes that UPDATE take the FOR UPDATE-strength
 * lock; until then the row is held only FOR NO KEY UPDATE, which does not
 * block the KEY SHARE that a session or token INSERT takes through its
 * foreign key.
 * - Login (token row UPDATE → session INSERT, KEY SHARE on the profile): if
 *   it holds the token, our token DELETE waits for its commit and the login
 *   never waits on us (its KEY SHARE passes our NO KEY UPDATE); its new
 *   session is then deleted with the other sessions (a new snapshot per
 *   statement). If we deleted the token first, its UPDATE waits holding
 *   nothing of ours and then finds no token. Our final UPDATE may wait for
 *   a login's KEY SHARE, but such a login has no lock left to take.
 * - access:revoke takes the profile row first as well: the two run one after
 *   the other. Logout holds one session row and waits for nothing of ours.
 * - The digest's token issue locks the profile FOR SHARE first
 *   (issueDigestTokens): it waits for this transaction and then sees the new
 *   address, or this one waits for its short transaction and deletes its tokens.
 * The hourly cleanup deletes expired tokens and sessions in its own row order,
 * so a cycle with it stays possible in theory: a deadlock (40P01) is retried once.
 */
export async function updateProfileSettings(
  db: Kysely<Database>,
  id: string,
  settings: CompanyProfileSettings,
  keepSessionToken: string,
): Promise<SettingsUpdate | null> {
  const profileId = parseDomain(entityIdSchema, id);
  const changes = parseDomain(companyProfileSettingsSchema, settings);
  const save = () =>
    db.transaction().execute(async (trx): Promise<SettingsUpdate | null> => {
      const current = await trx
        .selectFrom("company_profiles")
        .select("email")
        .where("id", "=", profileId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) return null;
      if (!(await lockLiveSession(trx, profileId, keepSessionToken))) return null;
      // Both normalized: the schema lower-cases and trims, the column CHECK enforces it.
      const emailChanged = current.email !== changes.email;
      if (emailChanged) await revokeOtherAccess(trx, profileId, keepSessionToken);
      const profile = await updateRow(trx, profileId, changes);
      return profile === null ? null : { profile, emailChanged };
    });
  try {
    return await save();
  } catch (error: unknown) {
    if (!isDeadlock(error)) throw error;
    return save();
  }
}

/** Deletes the profile; returns false when it did not exist. */
export async function deleteCompanyProfile(db: Kysely<Database>, id: string): Promise<boolean> {
  const profileId = parseDomain(entityIdSchema, id);
  const result = await db
    .deleteFrom("company_profiles")
    .where("id", "=", profileId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
