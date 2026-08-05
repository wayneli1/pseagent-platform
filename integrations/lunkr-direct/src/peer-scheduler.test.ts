import { describe, expect, it, vi } from "vitest";
import { PeerScheduler } from "./peer-scheduler.js";

describe("PeerScheduler", () => {
  it("runs at most four distinct peers and serializes each peer", async () => {
    const scheduler = new PeerScheduler(4, 5);
    const labels = ["a1", "a2", "b1", "c1", "d1", "e1"] as const;
    const gates = new Map(labels.map((label) => [label, deferred<void>()]));
    const started: string[] = [];
    const submit = (peerUid: string, label: typeof labels[number]) =>
      scheduler.submit(peerUid, {
        accept: async () => undefined,
        work: async () => {
          started.push(label);
          await gates.get(label)!.promise;
        },
      });

    const a1 = submit("a", "a1");
    const a2 = submit("a", "a2");
    const b1 = submit("b", "b1");
    const c1 = submit("c", "c1");
    const d1 = submit("d", "d1");
    const e1 = submit("e", "e1");

    await vi.waitFor(() => expect(started).toEqual(
      expect.arrayContaining(["a1", "b1", "c1", "d1"]),
    ));
    expect(started).not.toContain("a2");
    expect(started).not.toContain("e1");
    expect(a1.kind).toBe("started");
    expect(a2).toMatchObject({
      kind: "peer_queued",
      questionId: 2,
      ahead: 1,
    });
    expect(e1).toMatchObject({
      kind: "global_queued",
      questionId: 1,
    });
    expect(scheduler.activePeerCount).toBe(4);

    for (const label of ["a1", "b1", "c1", "d1"] as const) {
      gates.get(label)!.resolve();
    }
    await vi.waitFor(() => {
      expect(started).toContain("a2");
      expect(started).toContain("e1");
    });
    gates.get("a2")!.resolve();
    gates.get("e1")!.resolve();
    await Promise.all([
      a1.completion,
      a2.completion,
      b1.completion,
      c1.completion,
      d1.completion,
      e1.completion,
    ]);
    expect(scheduler.activePeerCount).toBe(0);
  });

  it("moves a peer with remaining work behind other waiting peers", async () => {
    const scheduler = new PeerScheduler(1, 5);
    const a1Gate = deferred<void>();
    const c1Gate = deferred<void>();
    const started: string[] = [];
    const submit = (peerUid: string, label: string, gate?: Deferred<void>) =>
      scheduler.submit(peerUid, {
        accept: async () => undefined,
        work: async () => {
          started.push(label);
          await gate?.promise;
        },
      });

    const a1 = submit("a", "a1", a1Gate);
    const a2 = submit("a", "a2");
    const c1 = submit("c", "c1", c1Gate);
    await vi.waitFor(() => expect(started).toEqual(["a1"]));

    a1Gate.resolve();
    await vi.waitFor(() => expect(started).toEqual(["a1", "c1"]));
    expect(started).not.toContain("a2");

    c1Gate.resolve();
    await Promise.all([a1.completion, a2.completion, c1.completion]);
    expect(started).toEqual(["a1", "c1", "a2"]);
  });

  it("rejects the sixth pending question without allocating an id", async () => {
    const scheduler = new PeerScheduler(1, 5);
    const activeGate = deferred<void>();
    const work = (gate?: Deferred<void>) => ({
      accept: async () => undefined,
      work: async () => {
        await gate?.promise;
      },
    });
    const active = scheduler.submit("a", work(activeGate));
    const pending = Array.from({ length: 5 }, () =>
      scheduler.submit("a", work()));
    const rejected = scheduler.submit("a", work());

    expect(pending.map((receipt) => receipt.questionId))
      .toEqual([2, 3, 4, 5, 6]);
    expect(rejected).toMatchObject({
      kind: "peer_full",
      questionId: undefined,
      ahead: 6,
    });
    await rejected.completion;

    activeGate.resolve();
    await Promise.all([
      active.completion,
      ...pending.map((receipt) => receipt.completion),
    ]);
  });

  it("reports only reliable processing and per-peer queue state", async () => {
    const scheduler = new PeerScheduler(1, 5);
    const activeGate = deferred<void>();
    const accept = async () => undefined;
    const active = scheduler.submit("a", {
      accept,
      work: async () => activeGate.promise,
    });
    const queued = scheduler.submit("a", {
      accept,
      work: async () => undefined,
    });
    const globallyQueued = scheduler.submit("b", {
      accept,
      work: async () => undefined,
    });

    expect(scheduler.status("missing")).toEqual([]);
    expect(scheduler.status("a")).toEqual([
      {
        questionId: 1,
        state: "processing",
        ahead: 0,
        waitingForCapacity: false,
      },
      {
        questionId: 2,
        state: "queued",
        ahead: 1,
        waitingForCapacity: false,
      },
    ]);
    expect(scheduler.status("b")).toEqual([
      {
        questionId: 1,
        state: "queued",
        ahead: 0,
        waitingForCapacity: true,
      },
    ]);

    activeGate.resolve();
    await Promise.all([
      active.completion,
      queued.completion,
      globallyQueued.completion,
    ]);
    expect(scheduler.status("a")).toEqual([]);
    expect(scheduler.status("b")).toEqual([]);
  });

  it("releases the peer slot when work rejects", async () => {
    const scheduler = new PeerScheduler(1, 5);
    const started: string[] = [];
    const failed = scheduler.submit("a", {
      accept: async () => undefined,
      work: async () => {
        started.push("a");
        throw new Error("work failed");
      },
    });
    const failure = expect(failed.completion).rejects.toThrow("work failed");
    const next = scheduler.submit("b", {
      accept: async () => undefined,
      work: async () => {
        started.push("b");
      },
    });

    await Promise.all([failure, next.completion]);
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.activePeerCount).toBe(0);
  });

  it("never starts work when acceptance delivery fails", async () => {
    const scheduler = new PeerScheduler(1, 5);
    let workStarted = false;
    const receipt = scheduler.submit("a", {
      accept: async () => {
        throw new Error("ack send failed");
      },
      work: async () => {
        workStarted = true;
      },
    });

    await expect(receipt.completion).rejects.toThrow("ack send failed");
    expect(workStarted).toBe(false);
    expect(scheduler.activePeerCount).toBe(0);
  });

  it("increments epoch, resets numbering, aborts active work, and drops pending work", async () => {
    const scheduler = new PeerScheduler(1, 5);
    let activeSignal!: AbortSignal;
    let pendingStarted = false;
    const active = scheduler.submit("a", {
      accept: async () => undefined,
      work: async ({ signal }) => {
        activeSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const pending = scheduler.submit("a", {
      accept: async () => undefined,
      work: async () => {
        pendingStarted = true;
      },
    });
    await vi.waitFor(() => expect(activeSignal).toBeInstanceOf(AbortSignal));

    expect(scheduler.reset("a")).toEqual({
      epoch: 1,
      activeCancelled: true,
      pendingCancelled: 1,
    });
    expect(activeSignal.aborted).toBe(true);
    await Promise.all([active.completion, pending.completion]);
    expect(pendingStarted).toBe(false);
    expect(scheduler.isCurrent("a", 0)).toBe(false);
    expect(scheduler.isCurrent("a", 1)).toBe(true);

    const next = scheduler.submit("a", {
      accept: async () => undefined,
      work: async () => undefined,
    });
    expect(next).toMatchObject({ questionId: 1, epoch: 1 });
    await next.completion;
  });

  it("keeps the slot occupied until abort-ignoring work actually settles", async () => {
    const scheduler = new PeerScheduler(1, 5);
    const oldWorkGate = deferred<void>();
    const started: string[] = [];
    const old = scheduler.submit("a", {
      accept: async () => undefined,
      work: async () => {
        started.push("old");
        await oldWorkGate.promise;
      },
    });
    await vi.waitFor(() => expect(started).toEqual(["old"]));

    scheduler.reset("a");
    await old.completion;
    const nextPeer = scheduler.submit("b", {
      accept: async () => undefined,
      work: async () => {
        started.push("next");
      },
    });
    expect(nextPeer.kind).toBe("global_queued");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["old"]);
    expect(scheduler.activePeerCount).toBe(1);

    oldWorkGate.resolve();
    await nextPeer.completion;
    expect(started).toEqual(["old", "next"]);
    expect(scheduler.activePeerCount).toBe(0);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
