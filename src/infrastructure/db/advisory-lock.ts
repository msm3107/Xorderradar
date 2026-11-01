import { sql, type Kysely } from "kysely";
import { describeDatabaseFailure } from "./errors.js";
import type { Database } from "./schema.js";
import type { Logger } from "../logger.js";

/** `lockLost`: the lock connection broke while the task ran; its signal was aborted. */
export type LockResult<T> =
  | { readonly acquired: true; readonly value: T; readonly lockLost: boolean }
  | { readonly acquired: false };

/** One session-level advisory lock (D-019): its fixed key and how it is named in logs. */
export interface AdvisoryLock {
  /** Arbitrary but fixed; it must not change while an old process may still run. */
  readonly key: number;
  /** Prefix of the log messages, e.g. `ingest` → "ingest lock lost". */
  readonly name: string;
  /** The reason the task's signal is aborted with when the lock is lost. */
  readonly lostError: () => Error;
}

export interface AdvisoryLockOptions {
  /** Lock loss and release failures are logged with codes only. */
  readonly logger: Logger;
  readonly heartbeatMs: number;
}

/**
 * Runs `task` while holding `lock`, or returns `{ acquired: false }` at once
 * when another session holds it (never waits). The lock is taken with
 * `pg_try_advisory_lock` on one dedicated pooled connection and held for the
 * whole task; `task` uses the pool for its own queries, not this connection.
 *
 * The lock lives as long as that connection's session. While the task runs,
 * the connection is checked every `heartbeatMs`; when a check fails (the
 * session was terminated, the server restarted, the network broke), the
 * signal passed to `task` is aborted with `lock.lostError()` so the run stops
 * instead of continuing unprotected, and the result reports `lockLost`. A
 * broken connection never crashes the process: the pool gives every client an
 * 'error' listener (createDatabase).
 *
 * The lock is released afterwards, also when `task` rejects. A failing
 * release is logged and does not discard the task's result: the session still
 * ends when the caller closes the pool, and the server then drops the lock.
 */
export async function withAdvisoryLock<T>(
  db: Kysely<Database>,
  lock: AdvisoryLock,
  task: (signal: AbortSignal) => Promise<T>,
  options: AdvisoryLockOptions,
): Promise<LockResult<T>> {
  const { logger, heartbeatMs } = options;
  const lockKeyField = String(lock.key);
  return db.connection().execute(async (connection): Promise<LockResult<T>> => {
    const { rows } = await sql<{
      acquired: boolean;
    }>`SELECT pg_try_advisory_lock(${lock.key}::bigint) AS acquired`.execute(connection);
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
            logger.error(`${lock.name} lock lost`, {
              lockKey: lockKeyField,
              errorCode: describeDatabaseFailure(error).code,
            });
            controller.abort(lock.lostError());
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
          await sql`SELECT pg_advisory_unlock(${lock.key}::bigint)`.execute(connection);
        } catch (error: unknown) {
          logger.error(`${lock.name} lock release failed`, {
            lockKey: lockKeyField,
            errorCode: describeDatabaseFailure(error).code,
          });
        }
      }
    }
    return { acquired: true, value, lockLost: controller.signal.aborted };
  });
}
