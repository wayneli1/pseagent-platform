import { describe, expect, it } from "vitest";
import {
  RELIABILITY_STAGE_LIMITS_MS,
  StageBudgetAllocator,
} from "./stage-budget.js";
import { RequestBudget } from "./request-budget.js";

describe("StageBudgetAllocator", () => {
  it("uses fixed absolute windows so compile cannot borrow retrieval time", () => {
    let now = 0;
    const budget = new StageBudgetAllocator({ startedAt: 0, now: () => now });

    now = 34_000;
    expect(budget.remainingMs("obligation_compile")).toBe(1_000);
    expect(budget.remainingMs("retrieval")).toBe(51_000);

    now = 36_000;
    expect(budget.remainingMs("obligation_compile")).toBe(0);
    expect(budget.remainingMs("retrieval")).toBe(49_000);
  });

  it("keeps the approved stage limits and finalization cutoff immutable", () => {
    const budget = new StageBudgetAllocator({ startedAt: 0 });
    expect(RELIABILITY_STAGE_LIMITS_MS).toEqual({
      preflight_cache: 10_000,
      obligation_compile: 25_000,
      retrieval: 50_000,
      claim_draft: 40_000,
      verification_consensus: 25_000,
      targeted_revision: 10_000,
      finalization: 5_000,
    });
    expect(budget.deadlineAt("finalization")).toBe(165_000);
  });

  it("reserves fifteen seconds after the active finalization deadline", () => {
    const request = new RequestBudget({
      startedAt: 0,
      requestTimeoutMs: 180_000,
      activeDeadlineMs: 165_000,
      returnReserveMs: 15_000,
    });
    const stages = new StageBudgetAllocator({ startedAt: 0 });

    expect(request.requestDeadlineAt - stages.deadlineAt("finalization"))
      .toBe(15_000);
  });

  it("combines a stage cutoff with its parent cancellation", () => {
    const parent = new AbortController();
    const budget = new StageBudgetAllocator({ startedAt: Date.now() });
    const signal = budget.signal("retrieval", parent.signal);

    parent.abort(new Error("caller_cancelled"));

    expect(signal.aborted).toBe(true);
  });
});
