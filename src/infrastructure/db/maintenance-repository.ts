import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.js";

/**
 * Catalog reads of `backup` and `restore` (PR-07A): the schema they work on
 * (the connection's current schema, as for the migrations) and its tables.
 */

/** The connection's current schema; null when search_path names no existing schema. */
export async function currentSchemaName(db: Kysely<Database>): Promise<string | null> {
  const { rows } = await sql<{ schema: string | null }>`SELECT current_schema() AS schema`.execute(
    db,
  );
  return rows[0]?.schema ?? null;
}

/** Names of the schema's ordinary and partitioned tables, sorted. */
export async function listSchemaTables(db: Kysely<Database>, schema: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `.execute(db);
  return rows.map((row) => row.name);
}

/**
 * Whether the schema holds any relation at all (table, view, sequence, ...):
 * a restore goes only into an empty one.
 */
export async function schemaHasRelations(db: Kysely<Database>, schema: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema}
    ) AS found
  `.execute(db);
  return rows[0]?.found === true;
}

/** Exact row counts of the given tables of the schema (identifiers quoted). */
export async function countTableRows(
  db: Kysely<Database>,
  schema: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await sql<{ count: string }>`
      SELECT count(*) AS count FROM ${sql.id(schema, table)}
    `.execute(db);
    const count = rows[0]?.count;
    if (count === undefined) throw new Error("count query returned no row");
    // count(*) is bigint, which `pg` returns as text.
    counts[table] = Number(count);
  }
  return counts;
}
