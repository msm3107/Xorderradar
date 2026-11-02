import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatchesSlot, type SlotOutcome } from "../src/web/matches-slot.js";

/** A stand-in for a ServerResponse: only `closed` and its "close" event matter. */
class FakeClient extends EventEmitter {
  closed = false;
  hangUp(): void {
    this.closed = true;
    this.emit("close");
  }
}

/** The outcome so far, without awaiting a wait that has not ended. */
function track(wait: Promise<SlotOutcome>): { outcome: SlotOutcome | null } {
  const state: { outcome: SlotOutcome | null } = { outcome: null };
  void wait.then((outcome) => {
    state.outcome = outcome;
  });
  return state;
}

describe("the /dopasowania slot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is taken at once when free and free again after release", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
    slot.release();
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
    expect(slot.waiting).toBe(0);
  });

  it("hands the slot to the waiters in arrival order, one at a time", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
    const first = track(slot.acquire(new FakeClient()));
    const second = track(slot.acquire(new FakeClient()));
    expect(slot.waiting).toBe(2);

    slot.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.outcome).toBe("acquired");
    // Handed over directly: the second still waits, and a newcomer queues behind it.
    expect(second.outcome).toBeNull();
    const third = track(slot.acquire(new FakeClient()));
    await vi.advanceTimersByTimeAsync(0);
    expect(third.outcome).toBeNull();
    expect(slot.waiting).toBe(2);

    slot.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.outcome).toBe("acquired");
    expect(third.outcome).toBeNull();
    slot.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.outcome).toBe("acquired");
    slot.release();
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
  });

  it("refuses at once when the queue is full", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 2 });
    await slot.acquire(new FakeClient());
    track(slot.acquire(new FakeClient()));
    track(slot.acquire(new FakeClient()));
    expect(await slot.acquire(new FakeClient())).toBe("full");
    expect(slot.waiting).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("ends a wait after maxWaitMs and drops its timer and listener", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    await slot.acquire(new FakeClient());
    const client = new FakeClient();
    const wait = track(slot.acquire(client));
    expect(client.listenerCount("close")).toBe(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(wait.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.outcome).toBe("timeout");
    expect(slot.waiting).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.listenerCount("close")).toBe(0);

    // The holder's release does not hand the slot to the expired wait.
    slot.release();
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
  });

  it("drops a client that hung up while waiting and serves the next one", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    await slot.acquire(new FakeClient());
    const leaving = new FakeClient();
    const left = track(slot.acquire(leaving));
    const staying = new FakeClient();
    const stayed = track(slot.acquire(staying));

    leaving.hangUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(left.outcome).toBe("gone");
    expect(slot.waiting).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(leaving.listenerCount("close")).toBe(0);

    slot.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stayed.outcome).toBe("acquired");
    expect(vi.getTimerCount()).toBe(0);
    expect(staying.listenerCount("close")).toBe(0);
    // A hang-up after the handover changes nothing.
    staying.hangUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(stayed.outcome).toBe("acquired");
  });

  it("gives a client that is already gone nothing, even with the slot free", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    const gone = new FakeClient();
    gone.closed = true;
    expect(await slot.acquire(gone)).toBe("gone");
    expect(gone.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The slot was never taken: the next client gets it at once, with no release.
    expect(await slot.acquire(new FakeClient())).toBe("acquired");
    expect(slot.waiting).toBe(0);
  });

  it("does not queue a client that is already gone", async () => {
    const slot = createMatchesSlot({ maxWaitMs: 3000, maxWaiters: 8 });
    await slot.acquire(new FakeClient());
    const gone = new FakeClient();
    gone.closed = true;
    expect(await slot.acquire(gone)).toBe("gone");
    expect(slot.waiting).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(gone.listenerCount("close")).toBe(0);
  });
});
