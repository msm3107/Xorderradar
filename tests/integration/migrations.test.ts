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
    expect(await migrateToLatest(schema.db)).toEqual(["0001_core_schema"]);
    expect(await tablesInSchema()).toEqual([
      "company_profiles",
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
    expect(rows.map((row) => row.name)).toEqual(["0001_core_schema"]);
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
    expect(runs.flat()).toEqual(["0001_core_schema"]);
  });
});
