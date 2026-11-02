/**
 * The one /dopasowania computation slot of a server process (D-027).
 *
 * Matching is CPU work in this single process, so one list is computed at a
 * time. A request that finds the slot taken waits in a short FIFO queue; on
 * release the slot goes straight to the oldest waiter (it stays taken, so
 * there is no stampede of waiters racing for it). A full queue, a wait that
 * runs out and a client that hangs up while waiting each end the wait without
 * any computation; no timer or listener outlives the wait.
 */

/** How a wait for the slot ended; only "acquired" obliges the caller to `release()`. */
export type SlotOutcome = "acquired" | "full" | "timeout" | "gone";

/** The waiting client's response: its "close" means it hung up. */
export interface ClientConnection {
  readonly closed: boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface MatchesSlot {
  /** Takes the slot, or waits for it in FIFO order (bounded in count and time). */
  acquire(client: ClientConnection): Promise<SlotOutcome>;
  /** Frees the slot or hands it to the next waiter; once per "acquired". */
  release(): void;
  /** Requests waiting now (tests and diagnostics). */
  readonly waiting: number;
}

export interface MatchesSlotLimits {
  readonly maxWaitMs: number;
  readonly maxWaiters: number;
}

export function createMatchesSlot(limits: MatchesSlotLimits): MatchesSlot {
  let busy = false;
  /** Oldest first; each entry hands the slot over and ends that wait. */
  const waiters: (() => void)[] = [];

  return {
    acquire(client) {
      // First: a client already gone gets nothing computed, even with the slot free.
      if (client.closed) return Promise.resolve("gone");
      if (!busy) {
        busy = true;
        return Promise.resolve("acquired");
      }
      if (waiters.length >= limits.maxWaiters) return Promise.resolve("full");
      return new Promise<SlotOutcome>((resolve) => {
        const end = (outcome: SlotOutcome): void => {
          clearTimeout(timer);
          client.off("close", onClose);
          const index = waiters.indexOf(grant);
          if (index !== -1) waiters.splice(index, 1);
          resolve(outcome);
        };
        // Called by release() after it took this entry off the queue.
        const grant = (): void => {
          end("acquired");
        };
        const onClose = (): void => {
          end("gone");
        };
        const timer = setTimeout(() => {
          end("timeout");
        }, limits.maxWaitMs);
        client.once("close", onClose);
        waiters.push(grant);
      });
    },
    release() {
      const next = waiters.shift();
      // Handed over directly: the slot stays taken for the next waiter.
      if (next === undefined) busy = false;
      else next();
    },
    get waiting() {
      return waiters.length;
    },
  };
}
