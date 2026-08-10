export interface RequestBudgetInput {
  readonly startedAt: number;
  readonly requestTimeoutMs: number;
  readonly activeDeadlineMs: number;
  readonly returnReserveMs: number;
  readonly now?: () => number;
}

/**
 * One monotonic budget shared by every stage of an answer request.
 * Child stages may shorten this budget, but can never extend it.
 */
export class RequestBudget {
  readonly requestDeadlineAt: number;
  readonly activeDeadlineAt: number;
  private readonly returnReserveMs: number;
  private readonly now: () => number;

  constructor(input: RequestBudgetInput) {
    assertPositiveDuration(input.requestTimeoutMs, "request_timeout_invalid");
    assertPositiveDuration(input.activeDeadlineMs, "active_deadline_invalid");
    if (!Number.isFinite(input.returnReserveMs) || input.returnReserveMs < 0) {
      throw new Error("return_reserve_invalid");
    }
    if (input.activeDeadlineMs + input.returnReserveMs > input.requestTimeoutMs) {
      throw new Error("active_deadline_exceeds_request_budget");
    }
    this.requestDeadlineAt = input.startedAt + input.requestTimeoutMs;
    this.activeDeadlineAt = input.startedAt + input.activeDeadlineMs;
    this.returnReserveMs = input.returnReserveMs;
    this.now = input.now ?? Date.now;
  }

  remainingRequestMs(): number {
    return Math.max(0, this.requestDeadlineAt - this.now());
  }

  remainingActiveMs(): number {
    return Math.max(0, this.activeDeadlineAt - this.now());
  }

  remainingUsableMs(): number {
    return Math.max(
      0,
      Math.min(
        this.remainingActiveMs(),
        this.remainingRequestMs() - this.returnReserveMs,
      ),
    );
  }

  canStart(minimumExecutionMs: number): boolean {
    if (!Number.isFinite(minimumExecutionMs) || minimumExecutionMs < 0) {
      return false;
    }
    return this.remainingUsableMs() >= minimumExecutionMs;
  }

  stageDeadlineAt(maximumDurationMs: number): number {
    assertPositiveDuration(maximumDurationMs, "stage_duration_invalid");
    return Math.min(
      this.activeDeadlineAt,
      this.now() + maximumDurationMs,
      this.requestDeadlineAt - this.returnReserveMs,
    );
  }

  signalForStage(maximumDurationMs: number, parent?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(
      Math.max(1, this.stageDeadlineAt(maximumDurationMs) - this.now()),
    );
    return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
  }
}

function assertPositiveDuration(value: number, code: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(code);
}
