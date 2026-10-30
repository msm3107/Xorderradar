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
    tenderId: row.tender_id,
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

type ParsedDraft = z.output<typeof opportunityDraftSchema>;

/**
 * `INSERT … ON CONFLICT (fingerprint) DO UPDATE` for a validated draft, shared
 * by `upsertOpportunity` and `ingestOpportunity`. `id` and `first_seen_at` are
 * never changed by the update; the update only applies to a row of the same
 * source (a fingerprint is per source; never move a row to another source).
 * With `onlyIfChanged` the update also requires a different `content_hash`, so
 * an unchanged notice is not written at all and no row is returned.
 */
function upsertQuery(db: Kysely<Database>, draft: ParsedDraft, onlyIfChanged: boolean) {
  return db
    .insertInto("opportunities")
    .values({
      source_id: draft.sourceId,
      source_url: draft.sourceUrl,
      external_id: draft.externalId,
      tender_id: draft.tenderId,
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
    .onConflict((oc) => {
      const update = oc
        .column("fingerprint")
        .doUpdateSet((eb) => ({
          source_url: eb.ref("excluded.source_url"),
          external_id: eb.ref("excluded.external_id"),
          tender_id: eb.ref("excluded.tender_id"),
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
        .where("opportunities.source_id", "=", (eb) => eb.ref("excluded.source_id"));
      return onlyIfChanged
        ? update.where("opportunities.content_hash", "is distinct from", (eb) =>
            eb.ref("excluded.content_hash"),
          )
        : update;
    });
}

/** Unique index on `(source_id, external_id)` (migration 0001). */
const SOURCE_EXTERNAL_ID_KEY = "opportunities_source_external_id_key";

/** The conflict-update WHERE did not match because the fingerprint belongs to another source. */
function fingerprintOfOtherSource(): DomainError {
  return new DomainError(
    "duplicate",
    "Fingerprint already stored for another source (opportunities_fingerprint_key)",
    ["fingerprint"],
    "opportunities_fingerprint_key",
  );
}

/**
 * Inserts the draft, or — when its `fingerprint` already exists — overwrites
 * the stored fields with the draft, in one atomic statement
 * (`INSERT … ON CONFLICT (fingerprint) DO UPDATE`). `id` and `first_seen_at`
 * are never changed by an update. Always writes; ingestion uses
 * `ingestOpportunity`, which skips unchanged content.
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
    upsertQuery(db, draft, false)
      .returningAll()
      // xmax is 0 only for a row version created by a plain INSERT; the
      // ON CONFLICT DO UPDATE path leaves a non-zero xmax. This is the standard
      // PostgreSQL idiom to tell the two apart within one atomic statement.
      .returning(sql<boolean>`(xmax = 0)`.as("inserted"))
      .executeTakeFirst(),
  );
  if (row === undefined) throw fingerprintOfOtherSource();
  const { inserted, ...stored } = row;
  return { outcome: inserted ? "inserted" : "updated", opportunity: toOpportunity(stored) };
}

export type IngestOutcome = "inserted" | "updated" | "unchanged";

export interface IngestOpportunityResult {
  readonly outcome: IngestOutcome;
  /** Id of the stored row (new, updated or left as it was). */
  readonly id: string;
}

/**
 * Change detection for ingestion (docs/ARCHITECTURE.md §5): inserts a new
 * fingerprint, updates a stored one only when `content_hash` differs, and
 * writes nothing when the content is the same (`unchanged` — `fetched_at` and
 * `updated_at` stay as they were). Same DomainError refusals as
 * `upsertOpportunity`.
 *
 * Safe under concurrent writes of the same fingerprint: one row, outcomes
 * inserted + unchanged/updated (see the retry below).
 *
 * When the upsert returns no row, one more read tells "unchanged" (same
 * source) from "fingerprint of another source". A row that vanished in
 * between (deleted concurrently) is an unexpected state and a plain Error.
 */
export async function ingestOpportunity(
  db: Kysely<Database>,
  input: OpportunityDraft,
): Promise<IngestOpportunityResult> {
  const draft = parseDomain(opportunityDraftSchema, input);
  const write = () =>
    withDomainErrors(() =>
      upsertQuery(db, draft, true)
        // See upsertOpportunity for the xmax idiom.
        .returning(["id", sql<boolean>`(xmax = 0)`.as("inserted")])
        .executeTakeFirst(),
    );
  let row: Awaited<ReturnType<typeof write>>;
  try {
    row = await write();
  } catch (error: unknown) {
    // ON CONFLICT resolves conflicts on its arbiter (fingerprint) only. When
    // the same notice is inserted concurrently, the other unique index
    // (source_id, external_id) can report the conflict instead — after the
    // other insert has committed. One retry then takes the conflict path. A
    // real conflict (the external id stored under another fingerprint) fails
    // the same way again.
    if (!(error instanceof DomainError) || error.constraint !== SOURCE_EXTERNAL_ID_KEY) throw error;
    row = await write();
  }
  if (row !== undefined) return { outcome: row.inserted ? "inserted" : "updated", id: row.id };
  const stored = await db
    .selectFrom("opportunities")
    .select(["id", "source_id"])
    .where("fingerprint", "=", draft.fingerprint)
    .executeTakeFirst();
  if (stored === undefined) {
    throw new Error("Opportunity row vanished between upsert and lookup (concurrent delete?)");
  }
  if (stored.source_id !== draft.sourceId) throw fingerprintOfOtherSource();
  return { outcome: "unchanged", id: stored.id };
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
