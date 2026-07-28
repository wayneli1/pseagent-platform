import { describe, expect, it } from "vitest";
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
