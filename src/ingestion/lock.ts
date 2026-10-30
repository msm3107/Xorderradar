import { sql, type Kysely } from "kysely";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import type { Database } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";

/**
 * Key of the session-level PostgreSQL advisory lock that serializes `ingest`
 * runs (docs/ARCHITECTURE.md §6, D-019). Advisory locks are per database, not
 * per schema, so one key covers every process using the same database.
 * Arbitrary but fixed; it must not change while an old process may still run.
 * Kysely's migrator uses its own, different key.
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

/** `lockLost`: the lock connection broke while the task ran; its signal was aborted. */
export type LockResult<T> =
  | { readonly acquired: true; readonly value: T; readonly lockLost: boolean }
  | { readonly acquired: false };

export interface IngestLockOptions {
  /** Lock loss and release failures are logged with codes only. */
  readonly logger: Logger;
  /** INGEST_LOCK_HEARTBEAT_MS when absent; tests use a shorter interval. */
  readonly heartbeatMs?: number;
}

const LOCK_KEY_FIELD = String(INGEST_LOCK_KEY);

/**
 * Runs `task` while holding the ingest lock, or returns `{ acquired: false }`
 * at once when another session holds it (never waits). The lock is taken with
 * `pg_try_advisory_lock` on one dedicated pooled connection and held for the
 * whole task; `task` uses the pool for its own queries, not this connection.
 *
 * The lock lives as long as that connection's session. While the task runs,
 * the connection is checked every `heartbeatMs`; when a check fails (the
 * session was terminated, the server restarted, the network broke), the
 * signal passed to `task` is aborted with IngestLockLostError so the run stops
 * instead of continuing unprotected, and the result reports `lockLost`. A
 * broken connection never crashes the process: the pool gives every client an
 * 'error' listener (createDatabase).
 *
 * The lock is released afterwards, also when `task` rejects. A failing
 * release is logged and does not discard the task's result: the session still
 * ends when the caller closes the pool, and the server then drops the lock.
 */
export async function withIngestLock<T>(
  db: Kysely<Database>,
  task: (signal: AbortSignal) => Promise<T>,
  options: IngestLockOptions,
): Promise<LockResult<T>> {
  const { logger } = options;
  const heartbeatMs = options.heartbeatMs ?? INGEST_LOCK_HEARTBEAT_MS;
  return db.connection().execute(async (connection): Promise<LockResult<T>> => {
    const { rows } = await sql<{
      acquired: boolean;
    }>`SELECT pg_try_advisory_lock(${INGEST_LOCK_KEY}::bigint) AS acquired`.execute(connection);
    if (rows[0]?.acquired !== true) return { acquired: false };

    const controller = new AbortController();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    // The check in flight, awaited before the connection is used for the unlock.
    let check: Promise<void> = Promise.resolve();
    const scheduleCheck = (): void => {
      timer = setTimeout(() => {
        check = sql`SELECT 1`.execute(connection).then(
          () => {
            if (!stopped) scheduleCheck();
          },
          (error: unknown) => {
            logger.error("ingest lock lost", {
              lockKey: LOCK_KEY_FIELD,
              errorCode: describeDatabaseFailure(error).code,
            });
            controller.abort(new IngestLockLostError());
          },
        );
      }, heartbeatMs);
    };
    scheduleCheck();

    let value: T;
    try {
      value = await task(controller.signal);
    } finally {
      stopped = true;
      clearTimeout(timer);
      await check;
      // After a loss there is no session left to unlock.
      if (!controller.signal.aborted) {
        try {
          await sql`SELECT pg_advisory_unlock(${INGEST_LOCK_KEY}::bigint)`.execute(connection);
        } catch (error: unknown) {
          logger.error("ingest lock release failed", {
            lockKey: LOCK_KEY_FIELD,
            errorCode: describeDatabaseFailure(error).code,
          });
        }
      }
    }
    return { acquired: true, value, lockLost: controller.signal.aborted };
  });
}
