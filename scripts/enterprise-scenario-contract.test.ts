import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { PseAnswerExecution } from "../apps/pseagent/src/answer-service.js";
import {
  evaluateConsistency,
  evaluateEnterpriseScenario,
  parseEnterpriseScenarios,
  type EnterpriseScenario,
} from "./enterprise-scenario-contract.js";

const scenario: EnterpriseScenario = {
  id: "T-01",
  userId: "tester",
  profile: "测试用户",
  turn: 1,
  question: "当前信息不足时怎样提升赢率？",
  consistencyKey: "win-rate",
  expected: {
    scopes: ["general"],
    statuses: ["partially_answered"],
    minimumReferences: 1,
    caseAssessabilities: ["insufficient"],
    gapClasses: ["input"],
    obligations: [{ id: "action", anyOf: ["补齐信息", "访谈"] }],
    forbiddenPatterns: ["赢率为\\s*\\d+%"],
  },
};

function execution(answer = "当前无法可靠判断赢率。请补齐信息并访谈决策人。"): PseAnswerExecution {
  return {
    requestId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00f9",
    result: {
      scope: "general",
      status: "partially_answered",
      answer: `${answer}\n缺失信息：客户决策链`,
      references: [{
        index: 1,
        project: "presales-general",
        title: "诊断式销售",
        path: "wiki/concepts/example.md",
        revision: "abc",
        contentHash: "a".repeat(64),
      }],
      knowledgeCoverage: "complete",
      caseAssessability: "insufficient",
    },
    retryable: false,
    stopReason: "final",
    historicalAttempted: false,
    historicalUsed: false,
    feedbackContext: {
      scope: "general",
      status: "partially_answered",
      referenceCount: 1,
      historicalUsed: false,
    },
    coverageGaps: [{
      id: "G1",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      domain: "presales-general",
      gapClass: "input",
      reason: "required_customer_input_missing",
      subject: "当前项目赢率",
      missingAspect: "客户决策链",
      affectsConclusion: true,
    }],
  };
}

describe("enterprise scenario contract", () => {
  it("scores semantic alternatives, evidence and specific gaps without exact text matching", () => {
    const evaluation = evaluateEnterpriseScenario(scenario, execution());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.score).toBe(1);
  });

  it("rejects an invented percentage and a hidden specific gap", () => {
    const result = execution("赢率为 70%，建议继续推进。");
    const withoutVisibleGap = {
      ...result,
      result: { ...result.result, answer: "赢率为 70%，建议继续推进。" },
    };
    const evaluation = evaluateEnterpriseScenario(scenario, withoutVisibleGap);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "specific-gap-visible", passed: false }),
      expect.objectContaining({ category: "safety", passed: false }),
    ]));
  });

  it("compares repeated answers by direction rather than wording", () => {
    const second = execution("现有事实不足以量化。先访谈并补齐信息。");
    const checks = evaluateConsistency([
      { scenario, execution: execution() },
      { scenario: { ...scenario, id: "T-02", turn: 2 }, execution: second },
    ]);
    expect(checks).toEqual([
      expect.objectContaining({ id: "consistency:win-rate", passed: true }),
    ]);
  });

  it("recognizes a precise knowledge gap from the authoritative answer axes", () => {
    const knowledgeGapScenario: EnterpriseScenario = {
      ...scenario,
      expected: {
        scopes: ["general"],
        statuses: ["not_covered"],
        minimumReferences: 0,
        gapClasses: ["knowledge"],
        obligations: [{ id: "boundary", anyOf: ["未提及", "无法确认"] }],
      },
    };
    const base = execution();
    const evaluation = evaluateEnterpriseScenario(knowledgeGapScenario, {
      ...base,
      result: {
        ...base.result,
        status: "not_covered",
        answer: "正式知识库未提及目标能力，无法确认是否支持。",
        references: [],
        knowledgeCoverage: "none",
      },
      coverageGaps: undefined,
    });

    expect(evaluation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gap-class", passed: true }),
    ]));
  });

  it("validates unique ids and user turns", () => {
    expect(parseEnterpriseScenarios([scenario])).toHaveLength(1);
    expect(() => parseEnterpriseScenarios([scenario, scenario])).toThrow(
      "duplicate_scenario_id:T-01",
    );
  });

  it("keeps exactly three realistic users with ten ordered turns each", () => {
    const corpus = parseEnterpriseScenarios(JSON.parse(readFileSync(
      new URL("../tests/regression/enterprise-user-scenarios.json", import.meta.url),
      "utf8",
    )));
    const users = [...new Set(corpus.map((item) => item.userId))];
    expect(users).toHaveLength(3);
    for (const userId of users) {
      expect(corpus
        .filter((item) => item.userId === userId)
        .map((item) => item.turn)
        .sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });
});
