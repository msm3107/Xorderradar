import type { AppConfig } from "./infrastructure/config.js";
import { describeDatabaseFailure, type DatabaseFailure } from "./infrastructure/db/errors.js";

export type DatabaseHealth =
  { readonly status: "ok" } | ({ readonly status: "error" } & DatabaseFailure);

/**
 * Whether every migration is applied. `not_checked` when the database itself
 * failed its check; a failure of the check query is reported like a database
 * failure (fixed reason + code).
 */
export type SchemaHealth =
  | { readonly status: "ok" }
  | { readonly status: "not_checked" }
  | {
      readonly status: "error";
      readonly reason: "not_migrated";
      /** Names of the migrations `migrate` would apply. */
      readonly pending: readonly string[];
    }
  | ({ readonly status: "error" } & DatabaseFailure);

export interface HealthReport {
  readonly status: "ok" | "error";
  readonly service: "radar-zamowien";
  readonly environment: AppConfig["environment"];
  readonly database: DatabaseHealth;
  readonly schema: SchemaHealth;
}

/** What the health check needs from the database. */
export interface HealthChecks {
  /** A trivial query, bounded by the pool's connection and query timeouts. */
  readonly ping: () => Promise<void>;
  /** Names of unapplied migrations — the same readiness check as `ingest`. */
  readonly pendingMigrations: () => Promise<readonly string[]>;
}

/**
 * Health report: configuration loads, the database answers a trivial query and
 * has no pending migrations (an un-migrated database cannot run `ingest`).
 * Overall `ok` only when both are. A database failure is reported as a fixed
 * reason plus code (see describeDatabaseFailure), never as the raw error
 * message.
 */
export async function checkHealth(config: AppConfig, checks: HealthChecks): Promise<HealthReport> {
  let database: DatabaseHealth;
  try {
    await checks.ping();
    database = { status: "ok" };
  } catch (error: unknown) {
    database = { status: "error", ...describeDatabaseFailure(error) };
  }
  let schema: SchemaHealth = { status: "not_checked" };
  if (database.status === "ok") {
    try {
      const pending = await checks.pendingMigrations();
      schema =
        pending.length === 0
          ? { status: "ok" }
          : { status: "error", reason: "not_migrated", pending: [...pending] };
    } catch (error: unknown) {
      schema = { status: "error", ...describeDatabaseFailure(error) };
    }
  }
  return {
    status: database.status === "ok" && schema.status === "ok" ? "ok" : "error",
    service: "radar-zamowien",
    environment: config.environment,
    database,
    schema,
  };
}
