import type {
  BlindAcceptanceHardGate,
  BlindAcceptanceReport,
} from "./blind-acceptance-contract.ts";

export const enterpriseReleaseThresholds = Object.freeze({
  retrievalRecall: 0.95,
  maximumRegressionDegradation: 0.02,
});

export interface EnterpriseReleaseEvidence {
  readonly blindAcceptance: BlindAcceptanceReport;
  readonly retrieval: {
    readonly total: number;
    readonly recalled: number;
  };
  readonly historicalRegression: {
    readonly baselineTotal: number;
    readonly baselinePassed: number;
    readonly currentTotal: number;
    readonly currentPassed: number;
  };
  readonly releaseQuality: {
    readonly passed: boolean;
    readonly safetyFailures: number;
    readonly availabilityFailures: number;
    readonly latencyPassed: boolean;
  };
}

export interface EnterpriseReleaseCheck {
  readonly id: string;
  readonly observed: number;
  readonly comparison: "minimum" | "maximum" | "zero" | "true";
  readonly threshold: number;
  readonly passed: boolean;
}

export interface EnterpriseReleaseDecision {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly checks: readonly EnterpriseReleaseCheck[];
  readonly metrics: {
    readonly retrievalRecallRate: number;
    readonly historicalBaselinePassRate: number;
    readonly historicalCurrentPassRate: number;
    readonly historicalRegressionDegradation: number;
  };
}

export function evaluateEnterpriseReleaseGate(
  evidence: EnterpriseReleaseEvidence,
): EnterpriseReleaseDecision {
  assertCount("retrieval.total", evidence.retrieval.total);
  assertBoundedCount("retrieval.recalled", evidence.retrieval.recalled,
    evidence.retrieval.total);
  assertCount("historical.baselineTotal", evidence.historicalRegression.baselineTotal);
  assertBoundedCount("historical.baselinePassed",
    evidence.historicalRegression.baselinePassed,
    evidence.historicalRegression.baselineTotal);
  assertCount("historical.currentTotal", evidence.historicalRegression.currentTotal);
  assertBoundedCount("historical.currentPassed",
    evidence.historicalRegression.currentPassed,
    evidence.historicalRegression.currentTotal);
  assertNonNegativeInteger("releaseQuality.safetyFailures",
    evidence.releaseQuality.safetyFailures);
  assertNonNegativeInteger("releaseQuality.availabilityFailures",
    evidence.releaseQuality.availabilityFailures);

  const retrievalRecallRate = rate(evidence.retrieval.recalled, evidence.retrieval.total);
  const historicalBaselinePassRate = rate(
    evidence.historicalRegression.baselinePassed,
    evidence.historicalRegression.baselineTotal,
  );
  const historicalCurrentPassRate = rate(
    evidence.historicalRegression.currentPassed,
    evidence.historicalRegression.currentTotal,
  );
  const historicalRegressionDegradation = roundMetric(Math.max(
    0,
    historicalBaselinePassRate - historicalCurrentPassRate,
  ));
  const checks: EnterpriseReleaseCheck[] = [
    ...evidence.blindAcceptance.hardGates.map(fromBlindGate),
    trueGate("blind_acceptance.qualified", evidence.blindAcceptance.qualified),
    minimumGate("retrieval.recall_rate", retrievalRecallRate,
      enterpriseReleaseThresholds.retrievalRecall),
    maximumGate("historical_regression.degradation",
      historicalRegressionDegradation,
      enterpriseReleaseThresholds.maximumRegressionDegradation),
    trueGate("release_quality.passed", evidence.releaseQuality.passed),
    trueGate("release_quality.latency", evidence.releaseQuality.latencyPassed),
    zeroGate("release_quality.safety_failures", evidence.releaseQuality.safetyFailures),
    zeroGate("release_quality.availability_failures",
      evidence.releaseQuality.availabilityFailures),
  ];
  return {
    schemaVersion: 1,
    passed: checks.every((check) => check.passed),
    checks,
    metrics: {
      retrievalRecallRate,
      historicalBaselinePassRate,
      historicalCurrentPassRate,
      historicalRegressionDegradation,
    },
  };
}

function fromBlindGate(gate: BlindAcceptanceHardGate): EnterpriseReleaseCheck {
  return { ...gate, id: `blind_acceptance.${gate.id}` };
}

function minimumGate(id: string, observed: number, threshold: number): EnterpriseReleaseCheck {
  return { id, observed, comparison: "minimum", threshold, passed: observed >= threshold };
}

function maximumGate(id: string, observed: number, threshold: number): EnterpriseReleaseCheck {
  return { id, observed, comparison: "maximum", threshold, passed: observed <= threshold };
}

function zeroGate(id: string, observed: number): EnterpriseReleaseCheck {
  return { id, observed, comparison: "zero", threshold: 0, passed: observed === 0 };
}

function trueGate(id: string, observed: boolean): EnterpriseReleaseCheck {
  return { id, observed: observed ? 1 : 0, comparison: "true", threshold: 1, passed: observed };
}

function rate(numerator: number, denominator: number): number {
  return roundMetric(numerator / denominator);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function assertCount(id: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_${id}`);
}

function assertNonNegativeInteger(id: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${id}`);
}

function assertBoundedCount(id: string, value: number, total: number): void {
  assertNonNegativeInteger(id, value);
  if (value > total) throw new Error(`invalid_${id}`);
}
