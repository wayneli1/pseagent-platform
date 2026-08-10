import { describe, expect, it } from "vitest";
import type {
  CoverageVerificationAction,
  FinalAction,
  KnowledgePlan,
} from "./contracts.js";
import {
  buildCoverageVerifierEnvelope,
  deterministicCoverageVerificationReport,
  validateCoverageVerifierEnvelope,
} from "./coverage-verifier.js";

const plan: KnowledgePlan = {
  subject: "迁移",
  requirements: [{
    id: "R1",
    question: "迁移前置条件",
    evidenceMode: "direct_only",
    evidenceAspects: [{ id: "A1", label: "前置条件", terms: ["前置条件"] }],
    queries: [{ text: "迁移 前置条件", aspectIds: ["A1"] }],
  }],
};

const draft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: "迁移前需要确认账号范围 [1]。还需安排窗口 [2]。",
    citations: [1, 2],
  }],
  citations: [1, 2],
};

const evidence = [1, 2].map((citation) => ({
  requirementId: "R1",
  citation,
  title: `资料${citation}`,
  path: `wiki/concepts/${citation}.md`,
  content: citation === 1 ? "确认账号范围。" : "安排迁移窗口。",
  aspectIds: ["A1"],
}));

describe("coverage verifier envelope", () => {
  it("freezes requirement order, target indexes and evidence ids", () => {
    const envelope = buildCoverageVerifierEnvelope({ plan, draft, evidence });

    expect(envelope.requirements).toEqual([{
      id: "R1",
      targetSegmentIndexes: [0, 1],
      relatedContextIndexes: [],
      evidenceCitations: [1, 2],
    }]);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.requirements)).toBe(true);
    expect(Object.isFrozen(envelope.requirements[0])).toBe(true);
    expect(Object.isFrozen(envelope.requirements[0]?.evidenceCitations)).toBe(true);
  });

  it("accepts decisions that only classify frozen target segments", () => {
    const envelope = buildCoverageVerifierEnvelope({ plan, draft, evidence });
    const decision: CoverageVerificationAction = {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain_partial",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        coveredAspectIds: ["A1"],
        reason: "partial_support",
      }],
    };

    expect(validateCoverageVerifierEnvelope(envelope, decision)).toBeUndefined();
  });

  it("materializes one deterministic claim decision per frozen segment", () => {
    const report = deterministicCoverageVerificationReport(
      draft,
      plan,
      evidence,
    );

    expect(report).toMatchObject({
      inferred: true,
      summaries: [{
        retainedDirectSegmentCount: 2,
        retainedSynthesizedSegmentCount: 0,
        removedSegmentCount: 0,
        claimDecisions: [
          { claimIndex: 0, status: "retained_direct", citations: [1] },
          { claimIndex: 1, status: "retained_direct", citations: [2] },
        ],
      }],
    });
  });

  it.each([
    ["reorders requirements", { id: "R2", retainedTargetSegmentIndexes: [0] }, "requirement_order_mismatch"],
    ["adds a target segment", { id: "R1", retainedTargetSegmentIndexes: [2] }, "target_segment_index_out_of_range:R1:2"],
    ["adds related context", { id: "R1", retainedTargetSegmentIndexes: [], retainedRelatedContextIndexes: [0] }, "related_context_index_out_of_range:R1:0"],
  ] as const)("rejects a verifier that %s", (_label, replacement, expected) => {
    const envelope = buildCoverageVerifierEnvelope({ plan, draft, evidence });
    const base: CoverageVerificationAction["requirements"][number] = {
      id: "R1",
      targetDecision: "retain_partial",
      retainedTargetSegmentIndexes: [0],
      synthesizedTargetSegmentIndexes: [],
      retainedRelatedContextIndexes: [],
      coveredAspectIds: ["A1"],
      reason: "partial_support",
    };
    const decision = {
      action: "verify",
      requirements: [{
        ...base,
        ...(replacement as unknown as Partial<typeof base>),
      }],
    } as CoverageVerificationAction;

    expect(validateCoverageVerifierEnvelope(envelope, decision)).toBe(expected);
  });
});
