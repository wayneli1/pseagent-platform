import { describe, expect, it } from "vitest";
import {
  evaluateStageBudgetFaultInjection,
  runStageBudgetFaultInjection,
  stageBudgetFaultScenarioIds,
} from "./stage-budget-fault-injection-contract.js";

describe("stage budget fault injection", () => {
  it("isolates every expired stage from the next stage budget", () => {
    const observations = runStageBudgetFaultInjection();

    expect(observations.map((item) => item.id)).toEqual(stageBudgetFaultScenarioIds);
    expect(observations).toHaveLength(6);
    for (const observation of observations) {
      expect(observation.expiredRemainingMs).toBe(0);
      expect(observation.expiredSignalAborted).toBe(true);
      expect(observation.nextRemainingMs).toBeGreaterThan(0);
      expect(observation.passed).toBe(true);
    }
    expect(evaluateStageBudgetFaultInjection(observations)).toMatchObject({
      passed: true,
      scenarioCount: 6,
      failedScenarioIds: [],
    });
  });

  it("fails closed on missing, duplicate, unexpected, or failed observations", () => {
    const valid = runStageBudgetFaultInjection();
    expect(evaluateStageBudgetFaultInjection(valid.slice(1)).passed).toBe(false);
    expect(evaluateStageBudgetFaultInjection([...valid, valid[0]!]).passed).toBe(false);
    expect(evaluateStageBudgetFaultInjection([{
      ...valid[0]!,
      id: "unexpected_transition",
    }, ...valid.slice(1)]).passed).toBe(false);
    expect(evaluateStageBudgetFaultInjection([{
      ...valid[0]!,
      passed: false,
    }, ...valid.slice(1)])).toMatchObject({
      passed: false,
      failedScenarioIds: [valid[0]!.id],
    });
  });
});
