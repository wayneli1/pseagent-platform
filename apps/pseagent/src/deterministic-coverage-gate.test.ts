import { describe, expect, it } from "vitest";
import type { FinalAction, KnowledgePlan } from "./contracts.js";
import {
  evaluateDeterministicCoverageGate,
  type DeterministicCoverageGateInput,
} from "./deterministic-coverage-gate.js";

describe("evaluateDeterministicCoverageGate", () => {
  it("accepts grounded low-risk method guidance without semantic verification", () => {
    const result = evaluateDeterministicCoverageGate(input({
      question: "售前访谈应该按什么步骤开展？",
      requirementQuestion: "售前访谈的步骤与方法",
      answer: "先确认目标，再访谈关键角色，最后记录下一步 [1]。",
      content: "售前访谈应确认目标、访谈关键角色并记录下一步。",
      evidenceMode: "synthesis_allowed",
    }));

    expect(result).toMatchObject({
      disposition: "deterministic_accept",
      risk: "low",
      reasons: [],
    });
  });

  it.each([
    ["numeric_promise", "可承诺 99.99% SLA [1]。"],
    ["version_capability", "V6.0 已支持该归档能力 [1]。"],
    ["compatibility", "系统兼容目标协议 [1]。"],
    ["legal_or_contract", "合同责任由原厂全部承担 [1]。"],
  ] as const)("requires semantic verification for %s", (reason, answer) => {
    const result = evaluateDeterministicCoverageGate(input({ answer }));

    expect(result.disposition).toBe("semantic_required");
    expect(result.risk).toBe("high");
    expect(result.reasons).toContain(reason);
  });

  it("requires semantic verification when evidence is conflicting or ambiguous", () => {
    const result = evaluateDeterministicCoverageGate(input({
      conditions: [{
        requirementId: "R1",
        conflictDetected: true,
        freshness: "stale_or_unconfirmed",
        inputState: "not_applicable",
        ambiguous: true,
      }],
    }));

    expect(result.disposition).toBe("semantic_required");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "conflicting_evidence",
      "ambiguous_evidence",
      "stale_or_unconfirmed_evidence",
    ]));
  });

  it("rejects a citation that is not owned by the requirement evidence envelope", () => {
    const result = evaluateDeterministicCoverageGate(input({
      answer: "建议先确认目标 [2]。",
      citations: [2],
    }));

    expect(result).toMatchObject({
      disposition: "reject",
      risk: "high",
      reasons: ["citation_outside_evidence_envelope"],
    });
  });

  it("accepts an explicit customer-input gap without treating it as a knowledge gap", () => {
    const value = input({
      coverage: "none",
      answer: "缺少判断“当前容量是否足够”所需的当次客户输入，暂不形成当前个案结论。",
      citations: [],
      conditions: [{
        requirementId: "R1",
        conflictDetected: false,
        freshness: "not_assessed",
        inputState: "missing",
        ambiguous: false,
      }],
    });
    const result = evaluateDeterministicCoverageGate(value);

    expect(result).toMatchObject({
      disposition: "deterministic_accept",
      risk: "low",
      missingInputRequirementIds: ["R1"],
      knowledgeMissingRequirementIds: [],
    });
  });

  it("requires semantic verification when a retained claim has no citation", () => {
    const result = evaluateDeterministicCoverageGate(input({
      answer: "建议先确认目标。",
      citations: [],
    }));

    expect(result).toMatchObject({
      disposition: "semantic_required",
      risk: "high",
    });
    expect(result.reasons).toContain("uncited_claim");
  });
});

function input(overrides: {
  readonly question?: string;
  readonly requirementQuestion?: string;
  readonly answer?: string;
  readonly content?: string;
  readonly coverage?: "complete" | "partial" | "none";
  readonly citations?: readonly number[];
  readonly evidenceMode?: "direct_only" | "synthesis_allowed";
  readonly conditions?: DeterministicCoverageGateInput["conditions"];
} = {}): DeterministicCoverageGateInput {
  const citations = [...(overrides.citations ?? [1])];
  const plan: KnowledgePlan = {
    subject: "售前建议",
    requirements: [{
      id: "R1",
      question: overrides.requirementQuestion ?? "售前建议",
      evidenceMode: overrides.evidenceMode ?? "direct_only",
      evidenceAspects: [{ id: "A1", label: "建议", terms: ["建议"] }],
      queries: [{ text: "售前 建议", aspectIds: ["A1"] }],
    }],
  };
  const draft: FinalAction = {
    action: "final",
    requirements: [{
      id: "R1",
      coverage: overrides.coverage ?? "complete",
      answer: overrides.answer ?? "建议先确认目标 [1]。",
      citations,
    }],
    citations,
  };
  return {
    question: overrides.question ?? "给出售前建议",
    plan,
    draft,
    evidence: [{
      requirementId: "R1",
      citation: 1,
      title: "售前方法",
      path: "wiki/concepts/售前方法.md",
      content: overrides.content ?? "建议先确认目标。",
      aspectIds: ["A1"],
    }],
    conditions: overrides.conditions ?? [],
  };
}
