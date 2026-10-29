import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { TestProject } from "vitest/node";
import { createDatabase } from "../../src/infrastructure/db/database.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Prefix of every schema created by this test run (see test-database.ts). */
    testSchemaPrefix: string;
  }
}

/**
 * Runs once per `vitest` invocation, in the main process.
 *
 * Test schemas are dropped once, after *all* test files have finished, not
 * per file: Kysely's Migrator lists tables across every visible schema before
 * taking its lock, and a schema dropped concurrently by another file makes
 * that catalog query fail (SQLSTATE 3F000).
 */
export default function setup(project: TestProject) {
  const prefix = `test_${randomUUID().replaceAll("-", "").slice(0, 12)}_`;
  project.provide("testSchemaPrefix", prefix);

  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    process.stderr.write(
      "\nNOTICE: TEST_DATABASE_URL is not set — PostgreSQL integration tests are SKIPPED " +
        "(see README → Testy).\n\n",
    );
    return undefined;
  }

  return async () => {
    const admin = createDatabase(url);
    try {
      const { rows } = await sql<{ name: string }>`
        SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, ${prefix})
      `.execute(admin);
      for (const { name } of rows) {
        await sql`DROP SCHEMA ${sql.id(name)} CASCADE`.execute(admin);
      }
    } finally {
      await admin.destroy();
    }
  };
}
