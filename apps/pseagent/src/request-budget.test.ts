import { describe, expect, it } from "vitest";
import { RequestBudget } from "./request-budget.js";

describe("RequestBudget", () => {
  it("keeps stage deadlines inside one absolute active deadline", () => {
    let now = 1_000;
    const budget = new RequestBudget({
      startedAt: now,
      requestTimeoutMs: 180_000,
      activeDeadlineMs: 150_000,
      returnReserveMs: 5_000,
      now: () => now,
    });

    expect(budget.requestDeadlineAt).toBe(181_000);
    expect(budget.activeDeadlineAt).toBe(151_000);
    expect(budget.stageDeadlineAt(60_000)).toBe(61_000);

    now = 130_000;
    expect(budget.stageDeadlineAt(60_000)).toBe(151_000);
    expect(budget.remainingActiveMs()).toBe(21_000);
  });

  it("reserves response time before allowing another expensive stage", () => {
    let now = 10_000;
    const budget = new RequestBudget({
      startedAt: now,
      requestTimeoutMs: 180_000,
      activeDeadlineMs: 175_000,
      returnReserveMs: 5_000,
      now: () => now,
    });

    now = 176_000;
    expect(budget.remainingRequestMs()).toBe(14_000);
    expect(budget.canStart(10_000)).toBe(false);
    expect(budget.canStart(8_999)).toBe(true);
  });

  it("rejects an active deadline that consumes the response reserve", () => {
    expect(() => new RequestBudget({
      startedAt: 0,
      requestTimeoutMs: 180_000,
      activeDeadlineMs: 178_000,
      returnReserveMs: 5_000,
    })).toThrow("active_deadline_exceeds_request_budget");
  });

  it("supports the enterprise default of a fifteen-second return reserve", () => {
    const budget = new RequestBudget({
      startedAt: 0,
      requestTimeoutMs: 180_000,
      activeDeadlineMs: 165_000,
      returnReserveMs: 15_000,
      now: () => 160_000,
    });

    expect(budget.remainingUsableMs()).toBe(5_000);
    expect(budget.canStart(5_001)).toBe(false);
  });
});
