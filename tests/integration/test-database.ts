import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { inject } from "vitest";
import { createDatabase } from "../../src/infrastructure/db/database.js";
import type { Database } from "../../src/infrastructure/db/schema.js";

/**
 * Integration tests run against the PostgreSQL database in TEST_DATABASE_URL
 * (a non-superuser role that owns the database is enough). When it is not set
 * the suites are skipped — loudly, so a green run without a database is never
 * mistaken for a full one.
 */
const rawUrl = process.env.TEST_DATABASE_URL;
export const testDatabaseUrl: string | undefined = rawUrl === "" ? undefined : rawUrl;
/** The notice about skipped suites is printed once per run by global-setup.ts. */
export const skipWithoutDatabase = testDatabaseUrl === undefined;

export function requireTestDatabaseUrl(): string {
  if (testDatabaseUrl === undefined) throw new Error("TEST_DATABASE_URL is not set");
  return testDatabaseUrl;
}

export interface TestSchema {
  /** Connection URL whose search_path points at the private schema. */
  readonly url: string;
  readonly db: Kysely<Database>;
  /** Closes the pool. The schema itself is dropped by global-setup.ts after the run. */
  close(): Promise<void>;
}

/**
 * Creates an empty, uniquely named schema and a pool whose search_path points
 * at it, so test files running in parallel never see each other's tables.
 * The name is generated here (never from input) and quoted with sql.id.
 */
export async function createTestSchema(): Promise<TestSchema> {
  const baseUrl = requireTestDatabaseUrl();
  const name = `${inject("testSchemaPrefix")}${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(baseUrl);
  try {
    await sql`CREATE SCHEMA ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }

  const url = new URL(baseUrl);
  // libpq-style startup option; `pg` reads `options` from the connection string.
  url.searchParams.set("options", `-c search_path=${name}`);
  const db = createDatabase(url.toString());

  return {
    url: url.toString(),
    db,
    close: () => db.destroy(),
  };
}

/** A URL to a closed local port: the connection is refused immediately. */
export const unreachableDatabaseUrl = (password: string) =>
  `postgres://radar:${password}@127.0.0.1:1/radar`;
