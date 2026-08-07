import { describe, expect, it } from "vitest";
import { workerPoolConcurrency } from "./worker-pool-config.js";

describe("worker pool configuration", () => {
  it("uses the fallback when the pool is not configured", () => {
    expect(workerPoolConcurrency({}, "KNOWLEDGE_OPS_VALIDATION_CONCURRENCY", 2)).toBe(2);
  });

  it("allows an isolated worker to disable unrelated pools", () => {
    expect(workerPoolConcurrency({ KNOWLEDGE_OPS_MAINTENANCE_CONCURRENCY: "0" }, "KNOWLEDGE_OPS_MAINTENANCE_CONCURRENCY", 1)).toBe(0);
  });

  it.each(["-1", "1.5", "17", "invalid"])("rejects invalid concurrency %s", (value) => {
    expect(() => workerPoolConcurrency({ KNOWLEDGE_OPS_REVIEW_CONCURRENCY: value }, "KNOWLEDGE_OPS_REVIEW_CONCURRENCY", 4)).toThrow("KNOWLEDGE_OPS_REVIEW_CONCURRENCY_invalid");
  });
});
