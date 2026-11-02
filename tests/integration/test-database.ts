import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely, type Transaction } from "kysely";
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

export interface PausedTransaction<T> {
  /** The backend running the transaction, once `before` has run. */
  readonly pid: Promise<number>;
  /** Lets the transaction go on with `after` (and commit). */
  resume(): void;
  /** The transaction's outcome. */
  readonly done: Promise<T>;
}

/**
 * Runs `before` in a transaction on its own connection, then holds the
 * transaction open (with its locks) until `resume()`; then `after` runs and
 * the transaction commits. Lets a test interleave two transactions in an
 * exact order instead of relying on timing.
 */
export function pausedTransaction<T>(
  db: Kysely<Database>,
  before: (trx: Transaction<Database>) => Promise<void>,
  after: (trx: Transaction<Database>) => Promise<T>,
): PausedTransaction<T> {
  let resume = (): void => undefined;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let paused: (pid: number) => void = () => undefined;
  const pausedAt = new Promise<number>((resolve) => {
    paused = resolve;
  });
  const done = db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    await before(trx);
    paused(rows[0]?.pid ?? 0);
    await resumed;
    return after(trx);
  });
  // A transaction that fails before pausing must not leave the test waiting.
  const pid = Promise.race([
    pausedAt,
    done.then(() => {
      throw new Error("the transaction ended before pausing");
    }),
  ]);
  return { pid, resume, done };
}

/** Waits (bounded) until some backend waits for a lock held by `pid`; returns that backend. */
export async function waitUntilBlockedBy(db: Kysely<Database>, pid: number): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY (pg_blocking_pids(pid))
    `.execute(db);
    const blocked = rows[0]?.pid;
    if (blocked !== undefined) return blocked;
    await delay(10);
  }
  throw new Error(`no backend got blocked by ${String(pid)}`);
}
