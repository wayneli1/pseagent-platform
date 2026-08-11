import { describe, expect, it } from "vitest";
import { runWithBoundedConcurrency } from "./bounded-concurrency.js";

describe("runWithBoundedConcurrency", () => {
  it("never starts more workers than the configured product capacity", async () => {
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];

    await runWithBoundedConcurrency([0, 1, 2, 3, 4], 3, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 5 : 1));
      completed.push(item);
      active -= 1;
    });

    expect(maximumActive).toBe(3);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects an invalid concurrency instead of silently running serially", async () => {
    await expect(runWithBoundedConcurrency([1], 0, async () => undefined))
      .rejects.toThrow("bounded_concurrency_invalid");
  });
});
