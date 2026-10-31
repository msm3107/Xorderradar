import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { parseDomain } from "../../domain/common.js";
import {
  sourceIdSchema,
  sourceInputSchema,
  type Source,
  type SourceInput,
} from "../../domain/source.js";
import { withDomainErrors } from "./errors.js";
import type { Database, SourcesTable } from "./schema.js";

/** Default and maximum page size for list queries (no unbounded reads). */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

const listLimitSchema = z.int().min(1).max(MAX_LIST_LIMIT);

/** Validates a caller-provided list limit; out-of-range values are an input error. */
export function parseListLimit(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_LIST_LIMIT : parseDomain(listLimitSchema, limit);
}

function toSource(row: Selectable<SourcesTable>): Source {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Registers a source or updates its name, base URL and enabled flag. */
export async function upsertSource(db: Kysely<Database>, input: SourceInput): Promise<Source> {
  const source = parseDomain(sourceInputSchema, input);
  const row = await withDomainErrors(() =>
    db
      .insertInto("sources")
      .values({
        id: source.id,
        name: source.name,
        base_url: source.baseUrl,
        enabled: source.enabled,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({
          name: eb.ref("excluded.name"),
          base_url: eb.ref("excluded.base_url"),
          enabled: eb.ref("excluded.enabled"),
          updated_at: sql<Date>`now()`,
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
  return toSource(row);
}

export async function getSource(db: Kysely<Database>, id: string): Promise<Source | null> {
  const sourceId = parseDomain(sourceIdSchema, id);
  const row = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", sourceId)
    .executeTakeFirst();
  return row === undefined ? null : toSource(row);
}

/** Enabled sources ordered by id, at most `limit` (default 100, max 1000). */
export async function listEnabledSources(db: Kysely<Database>, limit?: number): Promise<Source[]> {
  const rows = await db
    .selectFrom("sources")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("id")
    .limit(parseListLimit(limit))
    .execute();
  return rows.map(toSource);
}
