export const RELIABILITY_STAGE_LIMITS_MS = Object.freeze({
  preflight_cache: 10_000,
  obligation_compile: 25_000,
  retrieval: 50_000,
  claim_draft: 40_000,
  verification_consensus: 25_000,
  targeted_revision: 10_000,
  finalization: 5_000,
});

export type ReliabilityStage = keyof typeof RELIABILITY_STAGE_LIMITS_MS;

const STAGE_END_OFFSET_MS: Readonly<Record<ReliabilityStage, number>> =
  Object.freeze({
    preflight_cache: 10_000,
    obligation_compile: 35_000,
    retrieval: 85_000,
    claim_draft: 125_000,
    verification_consensus: 150_000,
    targeted_revision: 160_000,
    finalization: 165_000,
  });

export class StageBudgetAllocator {
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(input: {
    readonly startedAt: number;
    readonly now?: () => number;
  }) {
    if (!Number.isFinite(input.startedAt) || input.startedAt < 0) {
      throw new Error("stage_budget_started_at_invalid");
    }
    this.startedAt = input.startedAt;
    this.now = input.now ?? Date.now;
  }

  signal(stage: ReliabilityStage, parent?: AbortSignal): AbortSignal {
    const remainingMs = this.remainingMs(stage);
    const cutoff = remainingMs === 0
      ? AbortSignal.abort(new Error(`stage_budget_exhausted:${stage}`))
      : AbortSignal.timeout(Math.max(1, remainingMs));
    return parent === undefined ? cutoff : AbortSignal.any([parent, cutoff]);
  }

  deadlineAt(stage: ReliabilityStage): number {
    return this.startedAt + STAGE_END_OFFSET_MS[stage];
  }

  remainingMs(stage: ReliabilityStage): number {
    return Math.max(0, this.deadlineAt(stage) - this.now());
  }
}
