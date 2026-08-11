import { describe, expect, it } from "vitest";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type { Reference } from "./contracts.js";
import type { BoundClaim } from "./structured-claim.js";
import {
  reduceObligationOutcomes,
  renderBoundClaims,
  type ObligationOutcome,
} from "./obligation-outcome.js";

const contract: AtomicObligationContract = {
  subject: "归档与项目判断",
  sourceQuestion: "说明归档能力，并判断当前项目是否可推进。",
  obligations: [
    {
      id: "O1",
      sourceSpan: { start: 0, end: 6 },
      sourceText: "说明归档能力",
      kind: "fact",
      targetEntityIds: ["归档"],
      domains: ["coremail-professional"],
      evidencePolicy: "direct",
      evidenceTypes: ["formal_page"],
      risk: "low",
      completionCriteria: ["正式资料直接支持"],
      required: true,
    },
    {
      id: "O2",
      sourceSpan: { start: 7, end: 18 },
      sourceText: "判断当前项目是否可推进",
      kind: "case_judgement",
      targetEntityIds: ["当前项目"],
      domains: ["presales-general"],
      evidencePolicy: "customer_input",
      evidenceTypes: ["customer_fact"],
      risk: "high",
      completionCriteria: ["客户事实足以判断"],
      required: true,
    },
  ],
};

const references: readonly Reference[] = [
  {
    index: 1,
    project: "coremail-professional",
    title: "归档说明",
    path: "product/archive.md",
    revision: "a".repeat(40),
    contentHash: "b".repeat(64),
  },
  {
    index: 2,
    project: "presales-general",
    title: "项目评估方法",
    path: "method/qualification.md",
    revision: "c".repeat(40),
    contentHash: "d".repeat(64),
  },
];

function claim(input: Partial<BoundClaim> & Pick<BoundClaim, "claimId" | "obligationId" | "domain" | "text">): BoundClaim {
  return {
    kind: "fact",
    citationIndexes: [input.obligationId === "O1" ? 1 : 2],
    coveredAspectIds: ["A1"],
    support: "direct",
    evidenceIdentities: [input.obligationId === "O1" ? "b".repeat(64) : "d".repeat(64)],
    ...input,
  };
}

describe("obligation outcome reducer", () => {
  it("marks the answer complete only when every required obligation is complete", () => {
    const outcomes: readonly ObligationOutcome[] = [
      { obligationId: "O1", state: "complete", claims: [claim({ claimId: "CL1", obligationId: "O1", domain: "coremail-professional", text: "支持归档。" })] },
      { obligationId: "O2", state: "complete", claims: [claim({ claimId: "CL2", obligationId: "O2", domain: "presales-general", text: "事实充分时可以推进。" })] },
    ];

    expect(reduceObligationOutcomes({ contract, outcomes })).toEqual({
      status: "answered",
      knowledgeCoverage: "complete",
      caseAssessability: "sufficient",
      policyDisposition: "allowed",
    });
  });

  it("keeps a missing customer input local and returns a partial answer", () => {
    const outcomes: readonly ObligationOutcome[] = [
      { obligationId: "O1", state: "complete", claims: [claim({ claimId: "CL1", obligationId: "O1", domain: "coremail-professional", text: "支持归档。" })] },
      { obligationId: "O2", state: "missing_input", claims: [], gapReason: "缺少预算审批和决策链事实" },
    ];

    expect(reduceObligationOutcomes({ contract, outcomes })).toEqual({
      status: "partially_answered",
      knowledgeCoverage: "partial",
      caseAssessability: "insufficient",
      policyDisposition: "limited",
    });
  });

  it.each([
    ["not_covered", "not_covered", "refused"],
    ["unavailable", "temporarily_unavailable", "needs_escalation"],
  ] as const)("maps a fully %s result without reading generated prose", (state, status, policyDisposition) => {
    const outcomes: readonly ObligationOutcome[] = contract.obligations.map((obligation) => ({
      obligationId: obligation.id,
      state,
      claims: [],
    }));

    expect(reduceObligationOutcomes({ contract, outcomes })).toMatchObject({
      status,
      knowledgeCoverage: "none",
      policyDisposition,
    });
  });

  it("treats a completed fixed policy refusal as an answered policy result", () => {
    const outcomes: readonly ObligationOutcome[] = contract.obligations.map((obligation) => ({
      obligationId: obligation.id,
      state: "policy_blocked" as const,
      claims: [],
    }));

    expect(reduceObligationOutcomes({
      contract,
      outcomes,
      policyDisposition: "needs_escalation",
    })).toEqual({
      status: "answered",
      knowledgeCoverage: "none",
      caseAssessability: "not_applicable",
      policyDisposition: "needs_escalation",
    });
  });

  it("rejects missing and duplicate obligation outcomes", () => {
    expect(() => reduceObligationOutcomes({
      contract,
      outcomes: [{ obligationId: "O1", state: "not_covered", claims: [] }],
    })).toThrow("obligation_outcome_missing:O2");
    expect(() => reduceObligationOutcomes({
      contract,
      outcomes: [
        { obligationId: "O1", state: "not_covered", claims: [] },
        { obligationId: "O1", state: "not_covered", claims: [] },
        { obligationId: "O2", state: "not_covered", claims: [] },
      ],
    })).toThrow("obligation_outcome_duplicate:O1");
  });
});

describe("bound claim renderer", () => {
  it("renders each factual claim with its citations on the same list item", () => {
    const rendered = renderBoundClaims({
      contract,
      outcomes: [
        {
          obligationId: "O1",
          state: "complete",
          claims: [claim({ claimId: "CL1", obligationId: "O1", domain: "coremail-professional", text: "支持邮件归档。", citationIndexes: [1] })],
        },
        {
          obligationId: "O2",
          state: "partial",
          claims: [claim({ claimId: "CL2", obligationId: "O2", domain: "presales-general", text: "应核对预算与决策链。", kind: "method", citationIndexes: [2] })],
          gapReason: "尚缺少本项目事实",
        },
      ],
      references,
    });

    expect(rendered).toContain("- 支持邮件归档。[1]");
    expect(rendered).toContain("- 应核对预算与决策链。[2]");
    expect(rendered).toContain("- 资料缺口：尚缺少本项目事实");
    for (const line of rendered.split("\n").filter((item) => /^- (?!资料缺口)/u.test(item))) {
      expect(line).toMatch(/\[\d+\]$/u);
    }
  });

  it("fails closed when a factual claim references a missing public reference", () => {
    expect(() => renderBoundClaims({
      contract,
      outcomes: [
        {
          obligationId: "O1",
          state: "complete",
          claims: [claim({ claimId: "CL1", obligationId: "O1", domain: "coremail-professional", text: "支持邮件归档。", citationIndexes: [99] })],
        },
        { obligationId: "O2", state: "not_covered", claims: [] },
      ],
      references,
    })).toThrow("bound_claim_reference_missing:CL1:99");
  });
});
