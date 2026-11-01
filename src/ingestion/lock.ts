import type { Kysely } from "kysely";
import { withAdvisoryLock, type LockResult } from "../infrastructure/db/advisory-lock.js";
import type { Database } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";

export type { LockResult } from "../infrastructure/db/advisory-lock.js";

/**
 * Key of the session-level PostgreSQL advisory lock that serializes `ingest`
 * runs (docs/ARCHITECTURE.md §6, D-019). Advisory locks are per database, not
 * per schema, so one key covers every process using the same database.
 * Arbitrary but fixed; it must not change while an old process may still run.
 * Kysely's migrator uses its own, different key; `digest` has its own too.
 */
export const INGEST_LOCK_KEY = 7_206_120_309_001;

/**
 * How often the lock connection is checked while a run holds the lock. A
 * broken connection means the server has released the lock (or will, once it
 * notices), so the run is aborted within about this long — or within the
 * query timeout (35 s) when the network stops answering altogether.
 */
export const INGEST_LOCK_HEARTBEAT_MS = 5_000;

/** Reason of the run signal's abort when the lock connection broke (error code `lock_lost`). */
export class IngestLockLostError extends Error {
  override readonly name = "IngestLockLostError";
  readonly code = "lock_lost";

  constructor() {
    super("The ingest lock was lost during the run");
  }
}

export interface IngestLockOptions {
  /** Lock loss and release failures are logged with codes only. */
  readonly logger: Logger;
  /** INGEST_LOCK_HEARTBEAT_MS when absent; tests use a shorter interval. */
  readonly heartbeatMs?: number;
}

/**
 * Runs `task` while holding the ingest lock, or returns `{ acquired: false }`
 * at once when another session holds it (never waits). See withAdvisoryLock
 * for how the lock is held, checked and released.
 */
export async function withIngestLock<T>(
  db: Kysely<Database>,
  task: (signal: AbortSignal) => Promise<T>,
  options: IngestLockOptions,
): Promise<LockResult<T>> {
  return withAdvisoryLock(
    db,
    { key: INGEST_LOCK_KEY, name: "ingest", lostError: () => new IngestLockLostError() },
    task,
    { logger: options.logger, heartbeatMs: options.heartbeatMs ?? INGEST_LOCK_HEARTBEAT_MS },
  );
}
