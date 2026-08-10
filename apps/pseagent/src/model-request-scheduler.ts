export type ModelQueueErrorCode =
  | "model_queue_full"
  | "model_queue_timeout"
  | "model_request_aborted";

export class ModelQueueError extends Error {
  constructor(readonly code: ModelQueueErrorCode) {
    super(code);
    this.name = "ModelQueueError";
  }
}

export interface ModelRequestLease {
  readonly queueElapsedMs: number;
  release(): void;
}

export interface ModelRequestSchedulerConfig {
  readonly maxConcurrency: number;
  readonly maxQueueSize: number;
  readonly queueTimeoutMs: number;
  readonly now?: () => number;
}

interface Waiter {
  readonly queuedAt: number;
  readonly signal: AbortSignal;
  readonly resolve: (lease: ModelRequestLease) => void;
  readonly reject: (error: ModelQueueError) => void;
  readonly onAbort: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class ModelRequestScheduler {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly now: () => number;

  constructor(private readonly config: ModelRequestSchedulerConfig) {
    assertPositiveInteger(config.maxConcurrency, "model_concurrency_invalid");
    assertNonNegativeInteger(config.maxQueueSize, "model_queue_size_invalid");
    assertPositiveInteger(config.queueTimeoutMs, "model_queue_timeout_invalid");
    this.now = config.now ?? Date.now;
  }

  acquire(signal: AbortSignal): Promise<ModelRequestLease> {
    if (signal.aborted) {
      return Promise.reject(new ModelQueueError("model_request_aborted"));
    }
    if (this.active < this.config.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.createLease(0));
    }
    if (this.waiters.length >= this.config.maxQueueSize) {
      return Promise.reject(new ModelQueueError("model_queue_full"));
    }

    const queuedAt = this.now();
    return new Promise<ModelRequestLease>((resolve, reject) => {
      const onAbort = (): void => {
        this.rejectWaiter(waiter, "model_request_aborted");
      };
      const timeout = setTimeout(() => {
        this.rejectWaiter(waiter, "model_queue_timeout");
      }, this.config.queueTimeoutMs);
      const waiter: Waiter = {
        queuedAt,
        signal,
        resolve,
        reject,
        onAbort,
        timeout,
        settled: false,
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  snapshot(): { readonly active: number; readonly queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  private createLease(queueElapsedMs: number): ModelRequestLease {
    let released = false;
    return {
      queueElapsedMs,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.grantNext();
      },
    };
  }

  private grantNext(): void {
    while (
      this.active < this.config.maxConcurrency &&
      this.waiters.length > 0
    ) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled || waiter.signal.aborted) {
        this.cleanupWaiter(waiter);
        continue;
      }
      waiter.settled = true;
      this.cleanupWaiter(waiter);
      this.active += 1;
      waiter.resolve(this.createLease(Math.max(0, this.now() - waiter.queuedAt)));
    }
  }

  private rejectWaiter(waiter: Waiter, code: ModelQueueErrorCode): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.cleanupWaiter(waiter);
    waiter.reject(new ModelQueueError(code));
  }

  private cleanupWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timeout);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
}
