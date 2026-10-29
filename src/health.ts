import type { AppConfig } from "./infrastructure/config.js";

export interface HealthReport {
  readonly status: "ok";
  readonly service: "radar-zamowien";
  readonly environment: AppConfig["environment"];
}

/**
 * Liveness report. PR-00 has no external dependencies, so the only thing this
 * proves is that configuration loads and the application wiring runs.
 * PR-01 extends it with a database connectivity check.
 */
export function checkHealth(config: AppConfig): HealthReport {
  return { status: "ok", service: "radar-zamowien", environment: config.environment };
}
