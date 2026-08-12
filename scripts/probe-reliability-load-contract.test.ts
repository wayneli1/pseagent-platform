import { describe, expect, it } from "vitest";
import {
  collectReliabilityModelMetrics,
  evaluateReliabilityLoadGate,
  parseReliabilityKnowledgeHealth,
  parseReliabilityRuntimeIdentity,
  parseReliabilitySchedulerIdentity,
  selectReliabilityCases,
  summarizeReliabilityLoad,
} from "./probe-reliability-load-contract.js";

describe("reliability load report", () => {
  it("selects explicit diagnostic case ids without changing their requested order", () => {
    const cases = [{ id: "P01" }, { id: "P02" }, { id: "P10" }];
    expect(selectReliabilityCases(cases, "P10,P02,P10", 1)).toEqual([
      { id: "P10" },
      { id: "P02" },
    ]);
    expect(() => selectReliabilityCases(cases, "P99", 1))
      .toThrow("unknown_reliability_id:P99");
  });

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

  it("records the bounded scheduler identity used by the load run", () => {
    expect(parseReliabilitySchedulerIdentity({})).toEqual({
      maxConcurrency: 4,
      maxQueueSize: 32,
      queueTimeoutMs: 60_000,
    });
    expect(parseReliabilitySchedulerIdentity({
      PSE_MODEL_MAX_CONCURRENCY: "7",
      PSE_MODEL_MAX_QUEUE: "64",
      PSE_MODEL_QUEUE_TIMEOUT_MS: "90000",
    })).toEqual({
      maxConcurrency: 7,
      maxQueueSize: 64,
      queueTimeoutMs: 90_000,
    });
    expect(() => parseReliabilitySchedulerIdentity({
      PSE_MODEL_MAX_QUEUE: "-1",
    })).toThrow("invalid_reliability_scheduler_identity");
  });

  it("fails closed unless the deterministic control plane is active with a cold cache", () => {
    expect(parseReliabilityRuntimeIdentity({
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_ENABLED: "false",
    })).toEqual({
      controlPlaneEnabled: true,
      cacheMode: "disabled",
    });
    expect(() => parseReliabilityRuntimeIdentity({}))
      .toThrow("reliability_control_plane_required");
    expect(() => parseReliabilityRuntimeIdentity({
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "false",
    })).toThrow("reliability_control_plane_required");
    expect(() => parseReliabilityRuntimeIdentity({
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_ENABLED: "true",
    })).toThrow("reliability_load_requires_cold_cache");
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

  it("qualifies only when all four required concurrency profiles meet every hard gate", () => {
    const result = evaluateReliabilityLoadGate([
      loadSummary(1),
      loadSummary(2),
      loadSummary(4),
      loadSummary(10),
    ]);

    expect(result).toMatchObject({
      qualified: true,
      missingConcurrencies: [],
    });
    expect(result.hardGates).toHaveLength(12);
    expect(result.hardGates.every((gate) => gate.passed)).toBe(true);
  });

  it("fails the profile that misses success or enterprise latency thresholds", () => {
    const result = evaluateReliabilityLoadGate([
      loadSummary(1),
      loadSummary(2),
      loadSummary(4),
      loadSummary(10, {
        successful: 9,
        successRate: 0.9,
        p95Ms: 120_001,
        p99Ms: 180_001,
      }),
    ]);

    expect(result.qualified).toBe(false);
    expect(result.hardGates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "concurrency_10.success_rate",
        observed: 0.9,
        threshold: 0.995,
        passed: false,
      }),
      expect.objectContaining({
        id: "concurrency_10.p95_latency_ms",
        observed: 120_001,
        threshold: 120_000,
        passed: false,
      }),
      expect.objectContaining({
        id: "concurrency_10.p99_latency_ms",
        observed: 180_001,
        threshold: 180_000,
        passed: false,
      }),
    ]));
  });

  it("fails closed when a required concurrency profile is missing", () => {
    const result = evaluateReliabilityLoadGate([
      loadSummary(1),
      loadSummary(2),
      loadSummary(4),
    ]);

    expect(result).toMatchObject({
      qualified: false,
      missingConcurrencies: [10],
    });
  });

  it("rejects duplicate concurrency profiles instead of choosing one", () => {
    expect(() => evaluateReliabilityLoadGate([
      loadSummary(1),
      loadSummary(2),
      loadSummary(4),
      loadSummary(10),
      loadSummary(10),
    ])).toThrow("duplicate_reliability_load_concurrency");
  });

  it("rejects an unapproved concurrency profile instead of hiding it", () => {
    expect(() => evaluateReliabilityLoadGate([
      loadSummary(1),
      loadSummary(2),
      loadSummary(4),
      loadSummary(8),
      loadSummary(10),
    ])).toThrow("unexpected_reliability_load_concurrency");
  });
});

function loadSummary(
  concurrency: number,
  overrides: Partial<ReturnType<typeof summarizeReliabilityLoad>> = {},
): ReturnType<typeof summarizeReliabilityLoad> {
  return {
    concurrency,
    total: 10,
    successful: 10,
    unavailable: 0,
    failures: 0,
    successRate: 1,
    p50Ms: 10_000,
    p95Ms: 20_000,
    p99Ms: 25_000,
    queueP95Ms: 1_000,
    stopReasons: { final: 10 },
    ...overrides,
  };
}
