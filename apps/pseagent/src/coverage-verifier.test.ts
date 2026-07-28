import { describe, expect, it, vi } from "vitest";
import type {
  CoverageVerificationAction,
  FinalAction,
  KnowledgePlan,
} from "./contracts.js";
import {
  InvalidCoverageVerificationError,
  verifyKnowledgeCoverage,
} from "./coverage-verifier.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";

const singleRequirementPlan: KnowledgePlan = {
  subject: "Coremail 协议支持",
  requirements: [{
    id: "R1",
    question: "是否支持目标协议",
    queries: ["Coremail 目标协议支持"],
  }],
};

const completeDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: "草稿结论[1]。",
    citations: [1],
  }],
  citations: [1],
};

const partialDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "partial",
    answer: "草稿仅确认部分内容[1]，其余待确认。",
    citations: [1],
  }],
  citations: [1],
};

const relatedOnlyDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "none",
    answer: "正式资料未提及目标协议，无法确认是否支持。",
    citations: [],
    relatedContext: [{
      statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
      citations: [1, 2],
    }],
  }],
  citations: [1, 2],
};

const directEvidence = [{
  requirementId: "R1",
  citation: 1,
  title: "目标能力",
  path: "wiki/concepts/目标能力.md",
  content: "正文直接确认目标能力。",
}] as const;

describe("verifyKnowledgeCoverage", () => {
  it("accepts a downgrade from complete to none and removes related-only citations", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "邮件系统协议基础",
        path: "wiki/concepts/邮件系统协议基础.md",
        content: "正文仅介绍 SMTP、POP3、IMAP。",
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "现有知识正文未覆盖目标协议。",
          citations: [],
          reason: "related_only",
        }],
        citations: [],
      }),
    });

    expect(result).toEqual({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有知识正文未覆盖目标协议。",
        citations: [],
      }],
      citations: [],
    });
  });

  it("keeps complete coverage when the cited text directly supports the target", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "Coremail 是否支持 SMTP",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "邮件系统协议基础",
        path: "wiki/concepts/邮件系统协议基础.md",
        content: "Coremail 邮件系统支持 SMTP。",
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "Coremail 支持 SMTP[1]。",
          citations: [1],
          reason: "direct_support",
        }],
        citations: [1],
      }),
    });

    expect(result.requirements[0]).toEqual({
      id: "R1",
      coverage: "complete",
      answer: "Coremail 支持 SMTP[1]。",
      citations: [1],
    });
  });

  it("retains a draft related fact or removes one of its citations without promoting it", async () => {
    const retained = await verifyKnowledgeCoverage({
      question: "Coremail 是否支持目标协议",
      plan: singleRequirementPlan,
      draft: relatedOnlyDraft,
      evidence: [
        { ...directEvidence[0], citation: 1 },
        { ...directEvidence[0], citation: 2 },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式资料未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
            citations: [1, 2],
          }],
          reason: "related_only",
        }],
        citations: [1, 2],
      } as CoverageVerificationAction),
    });
    const reduced = await verifyKnowledgeCoverage({
      question: "Coremail 是否支持目标协议",
      plan: singleRequirementPlan,
      draft: relatedOnlyDraft,
      evidence: [
        { ...directEvidence[0], citation: 1 },
        { ...directEvidence[0], citation: 2 },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式资料未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。",
            citations: [1],
          }],
          reason: "related_only",
        }],
        citations: [1],
      } as CoverageVerificationAction),
    });

    expect(retained.requirements[0]?.relatedContext).toEqual(
      relatedOnlyDraft.requirements[0]?.relatedContext,
    );
    expect(reduced).toMatchObject({
      requirements: [{
        coverage: "none",
        citations: [],
        relatedContext: [{ citations: [1] }],
      }],
      citations: [1],
    });
  });

  it.each(["complete", "partial"] as const)(
    "rejects related context when draft and audited coverage both remain %s",
    async (coverage) => {
      const draft = {
        action: "final" as const,
        requirements: [{
          id: "R1" as const,
          coverage,
          answer: coverage === "complete" ? "草稿结论[1]。" : "草稿仅确认部分内容[1]，其余待确认。",
          citations: [1],
          relatedContext: [{
            statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。",
            citations: [1],
          }],
        }],
        citations: [1],
      } as unknown as FinalAction;
      const verified = {
        action: "verify" as const,
        requirements: [{
          id: "R1" as const,
          coverage,
          answer: coverage === "complete" ? "审核结论[1]。" : "审核仅确认部分内容[1]，其余待确认。",
          citations: [1],
          relatedContext: [{
            statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。",
            citations: [1],
          }],
          reason: coverage === "complete" ? "direct_support" : "partial_support",
        }],
        citations: [1],
      } as unknown as CoverageVerificationAction;

      await expect(verifyKnowledgeCoverage({
        question: "Coremail 是否支持目标协议",
        plan: singleRequirementPlan,
        draft,
        evidence: directEvidence,
        model: scriptedVerifier(verified),
      })).rejects.toMatchObject({
        code: "related_context_requires_none_coverage:R1",
      });
    },
  );

  it.each([
    ["a new related fact", {
      coverage: "none",
      citations: [],
      relatedContext: [{ statement: "新增的相关事实[1]。", citations: [1] }],
      topLevel: [1],
    }],
    ["a duplicated related fact", {
      coverage: "none",
      citations: [],
      relatedContext: [
        { statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。", citations: [1, 2] },
        { statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。", citations: [1, 2] },
      ],
      topLevel: [1, 2],
    }],
    ["a new related citation", {
      coverage: "none",
      citations: [],
      relatedContext: [{ statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [3]。", citations: [3] }],
      topLevel: [3],
    }],
    ["a citation from another requirement", {
      coverage: "none",
      citations: [],
      relatedContext: [{ statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [2]。", citations: [2] }],
      topLevel: [2],
      evidence: [{ ...directEvidence[0], requirementId: "R2", citation: 2 }],
    }],
    ["a related citation moved into target citations", {
      coverage: "none",
      citations: [1],
      relatedContext: [{ statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。", citations: [1] }],
      topLevel: [1],
    }],
    ["related context for complete coverage", {
      coverage: "complete",
      citations: [1],
      relatedContext: [{ statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。", citations: [1] }],
      topLevel: [1],
    }],
    ["related context for partial coverage", {
      coverage: "partial",
      citations: [1],
      relatedContext: [{ statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。", citations: [1] }],
      topLevel: [1],
    }],
  ] as const)("rejects %s", async (_name, output) => {
    const verified = {
      action: "verify" as const,
      requirements: [{
        id: "R1" as const,
        coverage: output.coverage,
        answer: output.coverage === "none"
          ? "正式资料未提及目标协议，无法确认是否支持。"
          : `审核目标结论[${output.citations[0]}]。`,
        citations: output.citations,
        relatedContext: output.relatedContext,
        reason: "related_only" as const,
      }],
      citations: output.topLevel,
    } as unknown as CoverageVerificationAction;
    await expect(verifyKnowledgeCoverage({
      question: "Coremail 是否支持目标协议",
      plan: singleRequirementPlan,
      draft: relatedOnlyDraft,
      evidence: ("evidence" in output ? output.evidence : undefined) ?? [
        { ...directEvidence[0], citation: 1 },
        { ...directEvidence[0], citation: 2 },
        { ...directEvidence[0], citation: 3 },
      ],
      model: scriptedVerifier(verified),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
  });

  it.each([
    ["wrong requirement", {
      action: "verify",
      requirements: [{
        id: "R2",
        coverage: "complete",
        answer: "支持[1]",
        citations: [1],
        reason: "direct_support",
      }],
      citations: [1],
    }],
    ["coverage upgrade", {
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "支持[1]",
        citations: [1],
        reason: "direct_support",
      }],
      citations: [1],
    }],
    ["new citation", {
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: "部分支持[2]",
        citations: [2],
        reason: "partial_support",
      }],
      citations: [2],
    }],
    ["wrong top-level union", {
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: "部分支持[1]",
        citations: [1],
        reason: "partial_support",
      }],
      citations: [],
    }],
  ] as const)("rejects %s", async (_name, action) => {
    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: partialDraft,
      evidence: directEvidence,
      model: scriptedVerifier(action as unknown as CoverageVerificationAction),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
  });

  it("rejects a citation that was not read for the audited requirement", async () => {
    const action: CoverageVerificationAction = {
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: "部分支持[1]",
        citations: [1],
        reason: "partial_support",
      }],
      citations: [1],
    };
    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: partialDraft,
      evidence: [{ ...directEvidence[0], requirementId: "R2" }],
      model: scriptedVerifier(action),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
  });

  it("repairs one invalid model payload", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: directEvidence,
      model: scriptedVerifier(
        new InvalidModelPayloadError("invalid_schema"),
        {
          action: "verify",
          requirements: [{
            id: "R1",
            coverage: "complete",
            answer: "正文直接支持[1]。",
            citations: [1],
            reason: "direct_support",
          }],
          citations: [1],
        },
      ),
    });

    expect(result.requirements[0]?.answer).toBe("正文直接支持[1]。");
  });

  it("fails closed after two invalid model payloads", async () => {
    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: directEvidence,
      model: scriptedVerifier(
        new InvalidModelPayloadError("invalid_schema"),
        new InvalidModelPayloadError("invalid_schema"),
      ),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
  });

  it("propagates model unavailability", async () => {
    const unavailable = new ModelUnavailableError();
    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: directEvidence,
      model: scriptedVerifier(unavailable),
    })).rejects.toBe(unavailable);
  });

  it("reports only validated requirement reasons to diagnostics", async () => {
    const onVerified = vi.fn();
    await verifyKnowledgeCoverage({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence: directEvidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "现有知识正文未覆盖目标协议。",
          citations: [],
          reason: "related_only",
        }],
        citations: [],
      }),
      onVerified,
    });

    expect(onVerified).toHaveBeenCalledWith([
      { id: "R1", reason: "related_only" },
    ]);
  });
});

function scriptedVerifier(
  ...actions: Array<CoverageVerificationAction | Error>
): ModelClient {
  let index = 0;
  return {
    completeJson: (async <T>() => {
      const action = actions[index++];
      if (action instanceof Error) throw action;
      return action as unknown as T;
    }) as ModelClient["completeJson"],
    completeText: async () => {
      throw new Error("unexpected completeText");
    },
  };
}
