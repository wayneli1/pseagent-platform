import {
  StageBudgetAllocator,
  type ReliabilityStage,
} from "../apps/pseagent/src/stage-budget.js";

export const stageBudgetFaultScenarioIds = Object.freeze([
  "preflight_to_obligation",
  "obligation_to_retrieval",
  "retrieval_to_claim_draft",
  "claim_draft_to_verification",
  "verification_to_revision",
  "revision_to_finalization",
] as const);

export interface StageBudgetFaultObservation {
  readonly id: string;
  readonly expiredStage: ReliabilityStage;
  readonly nextStage: ReliabilityStage;
  readonly injectedAtMs: number;
  readonly expiredRemainingMs: number;
  readonly nextRemainingMs: number;
  readonly expiredSignalAborted: boolean;
  readonly passed: boolean;
}

export interface StageBudgetFaultDecision {
  readonly passed: boolean;
  readonly scenarioCount: number;
  readonly missingScenarioIds: readonly string[];
  readonly duplicateScenarioIds: readonly string[];
  readonly unexpectedScenarioIds: readonly string[];
  readonly failedScenarioIds: readonly string[];
}

const transitions: readonly {
  readonly id: (typeof stageBudgetFaultScenarioIds)[number];
  readonly expiredStage: ReliabilityStage;
  readonly nextStage: ReliabilityStage;
  readonly injectedAtMs: number;
}[] = Object.freeze([
  { id: "preflight_to_obligation", expiredStage: "preflight_cache", nextStage: "obligation_compile", injectedAtMs: 10_001 },
  { id: "obligation_to_retrieval", expiredStage: "obligation_compile", nextStage: "retrieval", injectedAtMs: 35_001 },
  { id: "retrieval_to_claim_draft", expiredStage: "retrieval", nextStage: "claim_draft", injectedAtMs: 85_001 },
  { id: "claim_draft_to_verification", expiredStage: "claim_draft", nextStage: "verification_consensus", injectedAtMs: 125_001 },
  { id: "verification_to_revision", expiredStage: "verification_consensus", nextStage: "targeted_revision", injectedAtMs: 150_001 },
  { id: "revision_to_finalization", expiredStage: "targeted_revision", nextStage: "finalization", injectedAtMs: 160_001 },
]);

export function runStageBudgetFaultInjection(): readonly StageBudgetFaultObservation[] {
  return Object.freeze(transitions.map((transition) => {
    const budget = new StageBudgetAllocator({
      startedAt: 0,
      now: () => transition.injectedAtMs,
    });
    const expiredRemainingMs = budget.remainingMs(transition.expiredStage);
    const nextRemainingMs = budget.remainingMs(transition.nextStage);
    const expiredSignalAborted = budget.signal(transition.expiredStage).aborted;
    return Object.freeze({
      ...transition,
      expiredRemainingMs,
      nextRemainingMs,
      expiredSignalAborted,
      passed: expiredRemainingMs === 0 && expiredSignalAborted && nextRemainingMs > 0,
    });
  }));
}

export function evaluateStageBudgetFaultInjection(
  observations: readonly StageBudgetFaultObservation[],
): StageBudgetFaultDecision {
  const expected = new Set<string>(stageBudgetFaultScenarioIds);
  const counts = new Map<string, number>();
  for (const observation of observations) {
    counts.set(observation.id, (counts.get(observation.id) ?? 0) + 1);
  }
  const missingScenarioIds = stageBudgetFaultScenarioIds.filter((id) => !counts.has(id));
  const duplicateScenarioIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const unexpectedScenarioIds = [...counts.keys()]
    .filter((id) => !expected.has(id))
    .sort();
  const failedScenarioIds = observations
    .filter((observation) => expected.has(observation.id) && !observation.passed)
    .map((observation) => observation.id)
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort();
  const passed =
    observations.length === stageBudgetFaultScenarioIds.length &&
    missingScenarioIds.length === 0 &&
    duplicateScenarioIds.length === 0 &&
    unexpectedScenarioIds.length === 0 &&
    failedScenarioIds.length === 0;
  return Object.freeze({
    passed,
    scenarioCount: observations.length,
    missingScenarioIds: Object.freeze(missingScenarioIds),
    duplicateScenarioIds: Object.freeze(duplicateScenarioIds),
    unexpectedScenarioIds: Object.freeze(unexpectedScenarioIds),
    failedScenarioIds: Object.freeze(failedScenarioIds),
  });
}
