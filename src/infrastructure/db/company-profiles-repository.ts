import { sql, type Kysely, type Selectable } from "kysely";
import {
  companyProfileInputSchema,
  companyProfilePatchSchema,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfilePatch,
} from "../../domain/company-profile.js";
import { entityIdSchema, parseDomain } from "../../domain/common.js";
import { withDomainErrors } from "./errors.js";
import type { CompanyProfilesTable, Database } from "./schema.js";

function toCompanyProfile(row: Selectable<CompanyProfilesTable>): CompanyProfile {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    categories: row.categories,
    includeKeywords: row.include_keywords,
    excludeKeywords: row.exclude_keywords,
    voivodeships: row.voivodeships,
    counties: row.counties,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/** Updates the given fields only; returns null when the profile does not exist. */
export async function updateCompanyProfile(
  db: Kysely<Database>,
  id: string,
  patch: CompanyProfilePatch,
): Promise<CompanyProfile | null> {
  const profileId = parseDomain(entityIdSchema, id);
  const changes = parseDomain(companyProfilePatchSchema, patch);
  const row = await withDomainErrors(() =>
    db
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

/** Deletes the profile; returns false when it did not exist. */
export async function deleteCompanyProfile(db: Kysely<Database>, id: string): Promise<boolean> {
  const profileId = parseDomain(entityIdSchema, id);
  const result = await db
    .deleteFrom("company_profiles")
    .where("id", "=", profileId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
