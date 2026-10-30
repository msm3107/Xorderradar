import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { NoCurrentSchemaError } from "./errors.js";
import { migrations } from "./migrations.js";
import type { Database } from "./schema.js";

/*
 * Pool limits. Every command is a short-lived process (cron) that runs its
 * work mostly sequentially, so a handful of connections is plenty, and every
 * wait is bounded so a broken database fails the command instead of hanging.
 * Fixed constants rather than env variables until a deployment needs to tune
 * them (YAGNI).
 */
/** Upper bound on open connections per process. */
const POOL_MAX_CONNECTIONS = 5;
/** Max time to establish a connection (TCP + TLS + auth) or wait for a free one. */
const CONNECTION_TIMEOUT_MS = 5_000;
/** Idle connections are closed after this long. */
const IDLE_TIMEOUT_MS = 10_000;
/** Server-side limit for a single statement (`statement_timeout`). */
const STATEMENT_TIMEOUT_MS = 30_000;
/**
 * Client-side limit for a single query, slightly above the server-side one:
 * also covers a server or network that stops responding entirely.
 */
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5_000;
/** Idle time before the first TCP keepalive probe on an open connection. */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * Creates the query builder over a small connection pool. Nothing connects
 * until the first query. The caller owns the result and must `destroy()` it
 * when the command ends, otherwise open connections keep the process alive.
 */
export function createDatabase(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    application_name: "radar-zamowien",
    // TCP keepalive, so a connection held for a long run (the ingest lock)
    // notices a dead peer even while no query is in flight.
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
  });
  // An idle pooled connection can fail (e.g. server restart). Without a
  // listener `pg` re-emits that as an uncaught 'error' event and kills the
  // process; the broken client is already discarded by the pool and the next
  // query reports its own error, so there is nothing else to do here.
  pool.on("error", () => undefined);
  // The same for a checked-out connection: pg-pool removes its idle listener
  // while a client is in use, and Kysely adds none, so a connection held
  // between queries (the ingest lock) that is terminated by the server would
  // otherwise crash the process. Its next query rejects instead, and that
  // caller reports the failure (withIngestLock: `lock_lost`).
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Round trip to the database; rejects when it is unreachable or refuses the query. */
export async function pingDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}

/** Failure of a migration run; `failedMigration` is null when no migration had started. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";

  constructor(
    readonly failedMigration: string | null,
    override readonly cause: unknown,
  ) {
    super(
      failedMigration === null
        ? "Migration run failed"
        : `Migration ${JSON.stringify(failedMigration)} failed`,
    );
  }
}

/** The connection's current schema, or null when search_path names no existing schema. */
async function currentSchema(db: Kysely<Database>): Promise<string | null> {
  const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(
    db,
  );
  return rows[0]?.schema ?? null;
}

/**
 * The migrator over the static migration list. Its bookkeeping tables
 * (`kysely_migration`, `kysely_migration_lock`) live in the connection's
 * current schema, next to the tables they describe: without an explicit
 * schema the migrator would accept a bookkeeping table found in *any* schema.
 */
function createMigrator(db: Kysely<Database>, schema: string): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...migrations }) },
    migrationTableSchema: schema,
  });
}

/**
 * Applies all pending migrations and returns the names applied by this run
 * (empty when the schema is already up to date, so re-running is a no-op).
 *
 * Kysely's Migrator serializes concurrent runs with a PostgreSQL advisory lock
 * and runs all pending migrations in one transaction.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const schema = await currentSchema(db);
  if (schema === null) {
    // search_path names no existing schema: nowhere to create the tables.
    throw new MigrationError(null, new NoCurrentSchemaError());
  }

  const { error, results = [] } = await createMigrator(db, schema).migrateToLatest();
  if (error !== undefined) {
    const failed = results.find((result) => result.status === "Error");
    throw new MigrationError(failed?.migrationName ?? null, error);
  }
  return results
    .filter((result) => result.status === "Success")
    .map((result) => result.migrationName);
}

/**
 * Names of the migrations not yet applied in the connection's current schema
 * (all of them when it has no migration ledger or search_path names no
 * existing schema). Read-only: never creates the ledger or takes the
 * migration lock. The schema-readiness check of `ingest` and `health`.
 */
export async function pendingMigrations(db: Kysely<Database>): Promise<string[]> {
  const schema = await currentSchema(db);
  if (schema === null) return Object.keys(migrations).sort();
  const all = await createMigrator(db, schema).getMigrations();
  return all.filter((migration) => migration.executedAt === undefined).map(({ name }) => name);
}
