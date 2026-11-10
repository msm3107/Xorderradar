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
import {
  lockLiveSession,
  pendingEmailLinkLive,
  requestEmailChange,
  type IssuedToken,
} from "./access-repository.js";
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
  pendingEmail?: string,
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
        pending_email: pendingEmail,
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

/** The form's values plus the address waiting for its confirmation (D-031), null when none. */
export interface StoredProfileForm extends StoredProfileSettings {
  readonly pendingEmail: string | null;
  /** `pendingEmail` is set but its confirmation link no longer works (expired or revoked). */
  readonly pendingEmailExpired: boolean;
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
): Promise<StoredProfileForm | null> {
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
      "pending_email",
    ])
    .select((eb) => pendingEmailLinkLive(eb).as("pending_link_live"))
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
    pendingEmail: row.pending_email,
    pendingEmailExpired: row.pending_email !== null && row.pending_link_live !== true,
  };
}

/** The result of a profile form save (D-031); null from updateProfileSettings when nothing was saved. */
export type SettingsUpdate =
  | {
      readonly kind: "saved";
      readonly profile: CompanyProfile;
      /**
       * A new address was submitted: it is pending, `profile.email` is still
       * the old one. The confirmation link goes to `newEmail`, a notice
       * without links to `currentEmail`. null when the address is unchanged.
       */
      readonly emailChange: {
        readonly currentEmail: string;
        readonly newEmail: string;
        readonly link: IssuedToken;
      } | null;
    }
  /** A new address, but ACCESS_EMAILS_PER_DAY confirmations were sent today: nothing saved. */
  | { readonly kind: "email_change_limit" };

/**
 * Saves the profile form (PR-06B, D-027, D-031): every field but `active`,
 * in one transaction. A new e-mail address does not replace `email`: it
 * goes to `pending_email`, with a confirmation link (24 hours) replacing any
 * earlier one; `email`, the sessions and the other links stay as they are
 * until confirmEmailChange. An unchanged address keeps a pending change.
 * null — nothing saved — when the profile does not exist or the session
 * ended meanwhile (a logout or revoke in another tab). No uniqueness check
 * of the new address here: the form never tells whether another profile
 * uses it (D-031); the confirmation does.
 *
 * Lock order, the one every writer of a profile's access follows: profile
 * row FOR NO KEY UPDATE → the kept session FOR KEY SHARE → tokens → the
 * profile UPDATE, last. The UPDATE changes no unique key, so it never needs
 * more than the NO KEY UPDATE already held, and a login's session INSERT
 * (KEY SHARE through its foreign key) passes it. access:revoke, the
 * confirmation, the cancel and „Wyślij mi link” take the profile row first
 * as well: they run one after the other. The digest's token issue locks the
 * profile FOR SHARE (issueDigestTokens) and waits for this transaction. The
 * hourly cleanup deletes expired tokens in its own row order, so a cycle
 * with it stays possible in theory: a deadlock (40P01) is retried once.
 */
export async function updateProfileSettings(
  db: Kysely<Database>,
  id: string,
  settings: CompanyProfileSettings,
  keepSessionToken: string,
): Promise<SettingsUpdate | null> {
  const profileId = parseDomain(entityIdSchema, id);
  const { email, ...changes } = parseDomain(companyProfileSettingsSchema, settings);
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
      if (current.email === email) {
        const profile = await updateRow(trx, profileId, changes);
        return profile === null ? null : { kind: "saved", profile, emailChange: null };
      }
      const link = await requestEmailChange(trx, profileId, email);
      if (link === null) return { kind: "email_change_limit" };
      const profile = await updateRow(trx, profileId, changes, email);
      if (profile === null) return null;
      return {
        kind: "saved",
        profile,
        emailChange: { currentEmail: current.email, newEmail: email, link },
      };
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
