import { describe, expect, it } from "vitest";
import {
  collectReliabilityModelMetrics,
  parseReliabilityKnowledgeHealth,
  summarizeReliabilityLoad,
} from "./probe-reliability-load-contract.js";

describe("reliability load report", () => {
  it("records the revisions actually served by the knowledge engine", () => {
    expect(parseReliabilityKnowledgeHealth({
      status: "ready",
      projects: [
        {
          project: "coremail-professional",
          revision: "a".repeat(40),
          lexicalStatus: "ready",
          graphStatus: "ready",
        },
        {
          project: "presales-general",
          revision: "b".repeat(40),
          lexicalStatus: "ready",
          graphStatus: "ready",
        },
      ],
    })).toEqual({
      professional: "a".repeat(40),
      general: "b".repeat(40),
    });
  });

  it("keeps content-free queue and execution metrics for one request", () => {
    expect(collectReliabilityModelMetrics([
      { event: "route" },
      {
        event: "model_call",
        queueElapsedMs: 12,
        executionElapsedMs: 800,
        attemptCount: 1,
      },
      {
        event: "model_call",
        queueElapsedMs: 47,
        executionElapsedMs: 1_200,
        attemptCount: 2,
      },
    ])).toEqual({
      queueElapsedMs: 47,
      modelExecutionElapsedMs: 2_000,
      modelAttemptCount: 3,
    });
  });

  it("counts aborted and missing answers in the denominator", () => {
    const summary = summarizeReliabilityLoad(2, [
      { elapsedMs: 10, status: "answered", stopReason: "final" },
      { elapsedMs: 20, status: "temporarily_unavailable", stopReason: "model_queue_timeout" },
      { elapsedMs: 30, stopReason: "probe_exception", failure: "timeout" },
    ]);

    expect(summary).toMatchObject({
      concurrency: 2,
      total: 3,
      successful: 1,
      unavailable: 1,
      failures: 1,
      successRate: 1 / 3,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
      stopReasons: {
        final: 1,
        model_queue_timeout: 1,
        probe_exception: 1,
      },
    });
  });

  it("uses nearest-rank percentiles without dropping tail records", () => {
    const summary = summarizeReliabilityLoad(10, [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 100,
    ].map((elapsedMs) => ({
      elapsedMs,
      status: "answered",
      stopReason: "final",
    })));

    expect(summary).toMatchObject({ p50Ms: 5, p95Ms: 100, p99Ms: 100 });
  });

  it("rejects an empty profile instead of reporting a false pass", () => {
    expect(() => summarizeReliabilityLoad(4, [])).toThrow("empty_load_profile");
  });
});
