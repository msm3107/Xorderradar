import { sql, type Kysely, type Selectable } from "kysely";
import {
  companyProfileInputSchema,
  companyProfilePatchSchema,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfilePatch,
} from "../../domain/company-profile.js";
import { entityIdSchema, parseDomain } from "../../domain/common.js";
import { DomainError } from "../../domain/errors.js";
import { withDomainErrors } from "./errors.js";
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
  return db.transaction().execute(async (trx) => {
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
  });
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
