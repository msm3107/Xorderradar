import { sql, type Kysely, type Selectable } from "kysely";
import type { z } from "zod";
import { entityIdSchema, parseDomain } from "../../domain/common.js";
import { DomainError } from "../../domain/errors.js";
import {
  contactSchema,
  locationSchema,
  opportunityDraftSchema,
  type Opportunity,
  type OpportunityDraft,
} from "../../domain/opportunity.js";
import { withDomainErrors } from "./errors.js";
import type { Database, OpportunitiesTable } from "./schema.js";

export type UpsertOutcome = "inserted" | "updated";

export interface UpsertOpportunityResult {
  readonly outcome: UpsertOutcome;
  readonly opportunity: Opportunity;
}

/**
 * Validates a jsonb value read back from the database. On failure the field
 * paths are recorded in `invalid` (paths only, never values) and null is
 * returned; the caller then refuses the whole row.
 */
function parseStoredJson<T extends z.ZodType>(
  schema: T,
  value: unknown,
  field: string,
  invalid: string[],
): z.output<T> | null {
  if (value === null) return null;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  invalid.push(...result.error.issues.map((issue) => [field, ...issue.path.map(String)].join(".")));
  return null;
}

/**
 * Maps a row to the domain type. Columns are guaranteed by their SQL types
 * and CHECKs; only jsonb needs validation. A row that no longer matches the
 * domain schema (e.g. edited by hand) is refused as DomainError
 * `invalid_stored_row` instead of surfacing a raw ZodError.
 */
function toOpportunity(row: Selectable<OpportunitiesTable>): Opportunity {
  const invalid: string[] = [];
  const location = parseStoredJson(locationSchema, row.location, "location", invalid);
  const contact = parseStoredJson(contactSchema, row.contact, "contact", invalid);
  if (invalid.length > 0) {
    const fields = [...new Set(invalid)];
    throw new DomainError(
      "invalid_stored_row",
      `Stored opportunity ${row.id} does not match the domain schema: ${fields.join(", ")}`,
      fields,
      null,
      row.id,
    );
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    externalId: row.external_id,
    issuerName: row.issuer_name,
    title: row.title,
    description: row.description,
    location,
    publishedAt: row.published_at,
    deadline: row.deadline,
    estimatedValue: row.estimated_value,
    // char(3): always exactly three letters (CHECK), so no padding to strip.
    currency: row.currency,
    categories: row.categories,
    contact,
    fetchedAt: row.fetched_at,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    fingerprint: row.fingerprint,
    contentHash: row.content_hash,
    status: row.status,
  };
}

/**
 * Inserts the draft, or — when its `fingerprint` already exists — overwrites
 * the stored fields with the draft, in one atomic statement
 * (`INSERT … ON CONFLICT (fingerprint) DO UPDATE`). `id` and `first_seen_at`
 * are never changed by an update. Whether anything actually changed (content
 * hash comparison) is decided by ingestion in PR-03, not here.
 *
 * Refusals are DomainErrors: invalid draft (`invalid_input`), unregistered
 * source (`unknown_reference`), the same `(sourceId, externalId)` under a
 * different fingerprint (`duplicate`), or a fingerprint already stored for a
 * different source (`duplicate` — never silently moved between sources).
 */
export async function upsertOpportunity(
  db: Kysely<Database>,
  input: OpportunityDraft,
): Promise<UpsertOpportunityResult> {
  const draft = parseDomain(opportunityDraftSchema, input);
  const row = await withDomainErrors(() =>
    db
      .insertInto("opportunities")
      .values({
        source_id: draft.sourceId,
        source_url: draft.sourceUrl,
        external_id: draft.externalId,
        issuer_name: draft.issuerName,
        title: draft.title,
        description: draft.description,
        location: draft.location === null ? null : JSON.stringify(draft.location),
        published_at: draft.publishedAt,
        deadline: draft.deadline,
        estimated_value: draft.estimatedValue,
        currency: draft.currency,
        categories: draft.categories,
        contact: draft.contact === null ? null : JSON.stringify(draft.contact),
        fetched_at: draft.fetchedAt,
        fingerprint: draft.fingerprint,
        content_hash: draft.contentHash,
        status: draft.status,
      })
      .onConflict((oc) =>
        oc
          .column("fingerprint")
          .doUpdateSet((eb) => ({
            source_url: eb.ref("excluded.source_url"),
            external_id: eb.ref("excluded.external_id"),
            issuer_name: eb.ref("excluded.issuer_name"),
            title: eb.ref("excluded.title"),
            description: eb.ref("excluded.description"),
            location: eb.ref("excluded.location"),
            published_at: eb.ref("excluded.published_at"),
            deadline: eb.ref("excluded.deadline"),
            estimated_value: eb.ref("excluded.estimated_value"),
            currency: eb.ref("excluded.currency"),
            categories: eb.ref("excluded.categories"),
            contact: eb.ref("excluded.contact"),
            fetched_at: eb.ref("excluded.fetched_at"),
            content_hash: eb.ref("excluded.content_hash"),
            status: eb.ref("excluded.status"),
            updated_at: sql<Date>`now()`,
          }))
          // A fingerprint is per source; never move a row to another source.
          .where("opportunities.source_id", "=", (eb) => eb.ref("excluded.source_id")),
      )
      .returningAll()
      // xmax is 0 only for a row version created by a plain INSERT; the
      // ON CONFLICT DO UPDATE path leaves a non-zero xmax. This is the standard
      // PostgreSQL idiom to tell the two apart within one atomic statement.
      .returning(sql<boolean>`(xmax = 0)`.as("inserted"))
      .executeTakeFirst(),
  );
  if (row === undefined) {
    // The conflict-update WHERE did not match: same fingerprint, other source.
    throw new DomainError(
      "duplicate",
      "Fingerprint already stored for another source (opportunities_fingerprint_key)",
      ["fingerprint"],
      "opportunities_fingerprint_key",
    );
  }
  const { inserted, ...stored } = row;
  return { outcome: inserted ? "inserted" : "updated", opportunity: toOpportunity(stored) };
}

export async function getOpportunity(
  db: Kysely<Database>,
  id: string,
): Promise<Opportunity | null> {
  const opportunityId = parseDomain(entityIdSchema, id);
  const row = await db
    .selectFrom("opportunities")
    .selectAll()
    .where("id", "=", opportunityId)
    .executeTakeFirst();
  return row === undefined ? null : toOpportunity(row);
}
