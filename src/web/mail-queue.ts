/**
 * The access e-mail work of the web process (D-031): „Wyślij mi link” and
 * the address confirmation run after their response, one job at a time, so
 * a response never waits for the database or the SMTP server and its timing
 * says nothing about the address. In memory and bounded: at most
 * `maxPending` jobs wait, a job beyond that is dropped (the caller logs it).
 * A restart loses the waiting jobs — the customer asks again. No queue
 * service: one process, one chain of promises (docs/ARCHITECTURE.md).
 */

/** One unit of work; it logs its own outcome. A rejection is a bug, reported via onError. */
export type MailJob = () => Promise<void>;

export interface MailQueue {
  /** Queues `job`; false — dropped — when `maxPending` jobs wait already or the queue is closed. */
  push(job: MailJob): boolean;
  /** Jobs waiting now, the running one not counted (tests). */
  readonly pending: number;
  /** True once close() was called: every push is refused from then on. */
  readonly closed: boolean;
  /**
   * Refuses new jobs and drops the waiting ones (`dropped`), then waits for
   * the running job at most `deadlineMs`: `timedOut` when it was still
   * running then. Such a job is not stopped — the caller abandons it.
   */
  close(deadlineMs: number): Promise<MailQueueClosed>;
}

export interface MailQueueClosed {
  readonly dropped: number;
  readonly timedOut: boolean;
}

/** Jobs waiting at most: a flood is dropped rather than held in memory. */
export const MAIL_QUEUE_MAX_PENDING = 20;

export function createMailQueue(
  onError: (error: unknown) => void,
  maxPending: number = MAIL_QUEUE_MAX_PENDING,
): MailQueue {
  const waiting: MailJob[] = [];
  let running: Promise<void> | null = null;
  let closed = false;

  const drain = async (): Promise<void> => {
    // Start after the current turn: the request that queued the job answers first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let job = waiting.shift(); job !== undefined; job = waiting.shift()) {
      try {
        await job();
      } catch (error: unknown) {
        onError(error);
      }
    }
    // In the same turn as the empty shift above: a push after it starts a new drain.
    running = null;
  };

  return {
    push(job) {
      if (closed || waiting.length >= maxPending) return false;
      waiting.push(job);
      running ??= drain();
      return true;
    },
    get pending() {
      return waiting.length;
    },
    get closed() {
      return closed;
    },
    async close(deadlineMs) {
      closed = true;
      const dropped = waiting.splice(0).length;
      if (running === null) return { dropped, timedOut: false };
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<true>((resolve) => {
        timer = setTimeout(() => {
          resolve(true);
        }, deadlineMs);
      });
      // drain() never rejects: every job's failure is caught above.
      const timedOut = await Promise.race([running.then(() => false), deadline]);
      clearTimeout(timer);
      return { dropped, timedOut };
    },
  };
}
