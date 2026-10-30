import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

describe.skipIf(skipWithoutDatabase)("migrations (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  async function tablesInSchema(): Promise<string[]> {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name
    `.execute(schema.db);
    return rows.map((row) => row.table_name);
  }

  it("starts from an empty schema", async () => {
    expect(await tablesInSchema()).toEqual([]);
  });

  it("applies every migration on an empty database", async () => {
    expect(await migrateToLatest(schema.db)).toEqual([
      "0001_core_schema",
      "0002_ingestion_runs",
      "0003_opportunities_tender_id",
    ]);
    expect(await tablesInSchema()).toEqual([
      "company_profiles",
      "ingestion_runs",
      "kysely_migration",
      "kysely_migration_lock",
      "opportunities",
      "sources",
    ]);
  });

  it("is idempotent: a second run applies nothing and changes nothing", async () => {
    expect(await migrateToLatest(schema.db)).toEqual([]);
    expect(await migrateToLatest(schema.db)).toEqual([]);
    const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(
      schema.db,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "0001_core_schema",
      "0002_ingestion_runs",
      "0003_opportunities_tender_id",
    ]);
  });

  it("creates the integrity constraints from ARCHITECTURE §5", async () => {
    const { rows } = await sql<{ name: string }>`
      SELECT conname AS name FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace
      UNION
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
    `.execute(schema.db);
    const names = rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "opportunities_fingerprint_key",
        "opportunities_source_external_id_key",
        "opportunities_source_tender_id_idx",
        "opportunities_estimated_value_check",
        "opportunities_value_currency_check",
        "opportunities_currency_check",
        "opportunities_status_check",
        "opportunities_location_check",
        "opportunities_contact_check",
        "opportunities_source_id_fkey",
        "company_profiles_email_key",
        "company_profiles_email_check",
      ]),
    );
  });

  it("adds a nullable tender_id column, indexed per source but not unique (0003)", async () => {
    const { rows: columns } = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'opportunities' AND column_name = 'tender_id'
    `.execute(schema.db);
    expect(columns).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const { rows: indexes } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'opportunities_source_tender_id_idx'
    `.execute(schema.db);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).not.toContain("UNIQUE");
    expect(indexes[0]?.indexdef).toContain("(source_id, tender_id)");
    expect(indexes[0]?.indexdef).toContain("WHERE (tender_id IS NOT NULL)");
  });
});

describe.skipIf(skipWithoutDatabase)("migrations: concurrent runs (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(async () => {
    await schema.close();
  });

  it("apply each migration exactly once", async () => {
    const runs = await Promise.all([migrateToLatest(schema.db), migrateToLatest(schema.db)]);
    expect(runs.flat()).toEqual([
      "0001_core_schema",
      "0002_ingestion_runs",
      "0003_opportunities_tender_id",
    ]);
  });
});
