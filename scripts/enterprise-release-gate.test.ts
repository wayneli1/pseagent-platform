import { describe, expect, it } from "vitest";
import type { BlindAcceptanceReport } from "./blind-acceptance-contract.js";
import {
  evaluateEnterpriseReleaseGate,
  type EnterpriseReleaseEvidence,
} from "./enterprise-release-gate.js";

describe("enterprise release gate", () => {
  it("passes only when every independent hard metric passes", () => {
    const decision = evaluateEnterpriseReleaseGate(evidence());

    expect(decision.passed).toBe(true);
    expect(decision.metrics).toMatchObject({
      retrievalRecallRate: 0.95,
      historicalBaselinePassRate: 0.98,
      historicalCurrentPassRate: 0.96,
      historicalRegressionDegradation: 0.02,
    });
    expect(decision.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails when regression degradation exceeds two percentage points", () => {
    const input = evidence();
    const decision = evaluateEnterpriseReleaseGate({
      ...input,
      historicalRegression: {
        ...input.historicalRegression,
        currentPassed: 95,
      },
    });

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual(expect.objectContaining({
      id: "historical_regression.degradation",
      observed: 0.03,
      passed: false,
    }));
  });

  it("does not allow a total score to hide a failed blind, retrieval, safety, or latency gate", () => {
    const input = evidence();
    const decision = evaluateEnterpriseReleaseGate({
      ...input,
      blindAcceptance: {
        ...input.blindAcceptance,
        qualified: false,
        hardGates: input.blindAcceptance.hardGates.map((gate, index) =>
          index === 0 ? { ...gate, passed: false } : gate),
      },
      retrieval: { total: 100, recalled: 94 },
      releaseQuality: {
        passed: false,
        latencyPassed: false,
        safetyFailures: 1,
        availabilityFailures: 0,
      },
    });

    expect(decision.passed).toBe(false);
    expect(decision.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "blind_acceptance.all_outputs.chain_success",
        "blind_acceptance.qualified",
        "retrieval.recall_rate",
        "release_quality.passed",
        "release_quality.latency",
        "release_quality.safety_failures",
      ]));
  });

  it("rejects missing or impossible denominator evidence", () => {
    const input = evidence();
    expect(() => evaluateEnterpriseReleaseGate({
      ...input,
      retrieval: { total: 0, recalled: 0 },
    })).toThrow("invalid_retrieval.total");
    expect(() => evaluateEnterpriseReleaseGate({
      ...input,
      retrieval: { total: 10, recalled: 11 },
    })).toThrow("invalid_retrieval.recalled");
  });
});

function evidence(): EnterpriseReleaseEvidence {
  return {
    blindAcceptance: {
      qualified: true,
      hardGates: [{
        id: "all_outputs.chain_success",
        observed: 1,
        comparison: "minimum",
        threshold: 0.995,
        passed: true,
      }],
    } as BlindAcceptanceReport,
    retrieval: { total: 100, recalled: 95 },
    historicalRegression: {
      baselineTotal: 100,
      baselinePassed: 98,
      currentTotal: 100,
      currentPassed: 96,
    },
    releaseQuality: {
      passed: true,
      latencyPassed: true,
      safetyFailures: 0,
      availabilityFailures: 0,
    },
  };
}
