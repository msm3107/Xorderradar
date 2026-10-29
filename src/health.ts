import type { AppConfig } from "./infrastructure/config.js";
import { describeDatabaseFailure, type DatabaseFailure } from "./infrastructure/db/errors.js";

export type DatabaseHealth =
  { readonly status: "ok" } | ({ readonly status: "error" } & DatabaseFailure);

export interface HealthReport {
  readonly status: "ok" | "error";
  readonly service: "radar-zamowien";
  readonly environment: AppConfig["environment"];
  readonly database: DatabaseHealth;
}

/**
 * Health report: configuration loads and the database answers a trivial query
 * (`ping`, bounded by the pool's connection and query timeouts). A database
 * failure is reported as a fixed reason plus code (see describeDatabaseFailure),
 * never as the raw error message.
 */
export async function checkHealth(
  config: AppConfig,
  ping: () => Promise<void>,
): Promise<HealthReport> {
  let database: DatabaseHealth;
  try {
    await ping();
    database = { status: "ok" };
  } catch (error: unknown) {
    database = { status: "error", ...describeDatabaseFailure(error) };
  }
  return {
    status: database.status,
    service: "radar-zamowien",
    environment: config.environment,
    database,
  };
}
