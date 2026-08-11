import { describe, expect, it } from "vitest";
import type { BlindAcceptanceReport } from "./blind-acceptance-contract.js";
import {
  evaluateEnterpriseReleaseGate,
  type EnterpriseReleaseEvidence,
} from "./enterprise-release-gate.js";

describe("enterprise release verification artifacts", () => {
  it("rejects evidence without independently hashed verification artifacts", () => {
    const input = evidence() as EnterpriseReleaseEvidence & {
      verificationArtifacts?: unknown;
    };
    delete input.verificationArtifacts;

    expect(() => evaluateEnterpriseReleaseGate(input))
      .toThrow("enterprise_release_verification_artifacts_required");
  });

  it.each([
    ["scorerCalibration", "artifacts.scorer_calibration"],
    ["modelCallBudget", "artifacts.model_call_budget"],
    ["stageBudgetFaultInjection", "artifacts.stage_budget_fault_injection"],
    ["coldCacheIsolation", "artifacts.cold_cache_isolation"],
    ["loadGate", "artifacts.load_gate"],
    ["historicalRegression", "artifacts.historical_regression"],
  ] as const)("fails the %s artifact independently", (key, expectedCheck) => {
    const input = evidence();
    const decision = evaluateEnterpriseReleaseGate({
      ...input,
      verificationArtifacts: {
        ...input.verificationArtifacts,
        [key]: { ...input.verificationArtifacts[key], passed: false },
      },
    });

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual(expect.objectContaining({
      id: expectedCheck,
      passed: false,
    }));
  });
});

function evidence(): EnterpriseReleaseEvidence {
  const sha256 = "a".repeat(64);
  return {
    blindAcceptance: {
      qualified: true,
      hardGates: [],
    } as BlindAcceptanceReport,
    retrieval: { total: 100, recalled: 95 },
    historicalRegression: {
      baselineTotal: 100,
      baselinePassed: 98,
      currentTotal: 100,
      currentPassed: 98,
    },
    releaseQuality: {
      passed: true,
      latencyPassed: true,
      safetyFailures: 0,
      availabilityFailures: 0,
    },
    verificationArtifacts: {
      scorerCalibration: {
        passed: true, sha256, scorerVersion: 3,
        labelledCaseCount: 25, dangerousFalseNegatives: 0,
      },
      modelCallBudget: {
        passed: true, sha256, allowedMaximumOpenEndedCalls: 3,
        observedMaximumOpenEndedCalls: 3,
      },
      stageBudgetFaultInjection: { passed: true, sha256, scenarioCount: 6 },
      coldCacheIsolation: {
        passed: true, sha256, cacheMode: "cold_disabled",
        cacheHitCount: 0, observationCount: 300,
      },
      loadGate: {
        passed: true, sha256, concurrency: 4,
        chainSuccessRate: 1, p95LatencyMs: 100_000, p99LatencyMs: 150_000,
      },
      historicalRegression: { passed: true, sha256, suiteCount: 4 },
    },
  };
}
