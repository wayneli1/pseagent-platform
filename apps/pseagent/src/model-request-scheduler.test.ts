import { describe, expect, it, vi } from "vitest";
import {
  ModelQueueError,
  ModelRequestScheduler,
} from "./model-request-scheduler.js";

describe("ModelRequestScheduler", () => {
  it("shares one concurrency limit and rejects excess queued work", async () => {
    let now = 100;
    const scheduler = new ModelRequestScheduler({
      maxConcurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 10_000,
      now: () => now,
    });
    const first = await scheduler.acquire(new AbortController().signal);
    const secondPromise = scheduler.acquire(new AbortController().signal);

    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
    await expect(
      scheduler.acquire(new AbortController().signal),
    ).rejects.toMatchObject({ code: "model_queue_full" });

    now = 175;
    first.release();
    const second = await secondPromise;
    expect(second.queueElapsedMs).toBe(75);
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });

    second.release();
    second.release();
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("times out a waiter without consuming a future slot", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new ModelRequestScheduler({
        maxConcurrency: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 50,
      });
      const first = await scheduler.acquire(new AbortController().signal);
      const queued = scheduler.acquire(new AbortController().signal);
      const timedOut = expect(queued).rejects.toMatchObject({
        code: "model_queue_timeout",
      });

      await vi.advanceTimersByTimeAsync(50);
      await timedOut;
      expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });

      first.release();
      expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an aborted waiter and grants the next live waiter", async () => {
    const scheduler = new ModelRequestScheduler({
      maxConcurrency: 1,
      maxQueueSize: 2,
      queueTimeoutMs: 10_000,
    });
    const first = await scheduler.acquire(new AbortController().signal);
    const abortedController = new AbortController();
    const aborted = scheduler.acquire(abortedController.signal);
    const live = scheduler.acquire(new AbortController().signal);

    abortedController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "model_request_aborted" });
    first.release();
    const lease = await live;
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    lease.release();
  });

  it("uses a content-free queue error contract", () => {
    expect(new ModelQueueError("model_queue_full")).toMatchObject({
      code: "model_queue_full",
      message: "model_queue_full",
    });
  });
});
