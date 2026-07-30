import { describe, expect, it, vi } from "vitest";
import {
  coverageVerificationActionSchema,
  type CoverageVerificationAction,
  type CoverageVerificationReason,
  type FinalAction,
  type KnowledgePlan,
} from "./contracts.js";
import {
  InvalidCoverageVerificationError,
  type CoverageVerifierInput,
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
    evidenceMode: "direct_only",
  }],
};

const synthesisPlan: KnowledgePlan = {
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责有哪些",
    queries: ["售前 工作职责"],
    evidenceMode: "synthesis_allowed",
  }],
};

const synthesisDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: [
      "售前职责包括需求诊断与访谈 [1]。",
      "售前职责还包括产品演示与机会推进 [2]。",
    ].join("\n"),
    citations: [1, 2],
  }],
  citations: [1, 2],
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

const mixedSupportDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: [
      "POC 测试方案通常包括测试目标、测试环境、测试范围、测试用例和验收标准 [1]。",
      "该方案可以保证所有项目零风险通过验收 [2]。",
    ].join("\n"),
    citations: [1, 2],
  }],
  citations: [1, 2],
};

const relatedOnlyDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "none",
    answer: "正式资料未提及目标协议，无法确认是否支持。",
    citations: [],
    relatedContext: [
      {
        statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。",
        citations: [1],
      },
      {
        statement: "资料还说明 HTTP/HTTPS 用于 Webmail 访问 [2]。",
        citations: [2],
      },
    ],
  }],
  citations: [1, 2],
};

const targetOmittedDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "none",
    answer: "正式资料未覆盖目标能力。",
    citations: [],
  }],
  citations: [],
};

const evidence = [
  {
    requirementId: "R1",
    citation: 1,
    title: "协议基础",
    path: "wiki/concepts/协议基础.md",
    content: "正文列出 SMTP、POP3 和 IMAP。",
  },
  {
    requirementId: "R1",
    citation: 2,
    title: "Webmail",
    path: "wiki/concepts/Webmail.md",
    content: "正文说明 HTTP/HTTPS 用于 Webmail。",
  },
] as const;

describe("verifyKnowledgeCoverage", () => {
  it("retains synthesized segments with deterministic disclosure and support counts", async () => {
    const onVerified = vi.fn();
    const result = await verifyKnowledgeCoverage({
      question: "售前工程师的工作职责有哪些？",
      plan: synthesisPlan,
      draft: synthesisDraft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [0, 1],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      } as unknown as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]).toEqual({
      id: "R1",
      coverage: "complete",
      answer: [
        "根据正式知识库中多篇资料综合归纳：",
        "售前职责包括需求诊断与访谈 [1]。",
        "售前职责还包括产品演示与机会推进 [2]。",
      ].join("\n"),
      citations: [1, 2],
    });
    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "synthesized_support",
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 2,
      removedSegmentCount: 0,
    }]);
  });

  it("reports mixed direct and synthesized target support separately", async () => {
    const onVerified = vi.fn();

    await verifyKnowledgeCoverage({
      question: "售前职责",
      plan: synthesisPlan,
      draft: synthesisDraft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [1],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      } as unknown as CoverageVerificationAction),
      onVerified,
    });

    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "synthesized_support",
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 1,
      removedSegmentCount: 0,
    }]);
  });

  it.each([
    {
      label: "direct-only synthesis",
      plan: singleRequirementPlan,
      retained: [0],
      synthesized: [0],
    },
    {
      label: "synthesis outside retained target",
      plan: synthesisPlan,
      retained: [0],
      synthesized: [1],
    },
  ])("rejects $label after three decisions", async ({
    plan,
    retained,
    synthesized,
  }) => {
    const completeJson = vi.fn(async () => ({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: retained.length === 1
          ? "retain_partial"
          : "retain",
        retainedTargetSegmentIndexes: retained,
        synthesizedTargetSegmentIndexes: synthesized,
        retainedRelatedContextIndexes: [],
        reason: "synthesized_support",
      }],
    }) as unknown as CoverageVerificationAction);

    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan,
      draft: synthesisDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      label: "missing complete reason",
      draft: completeDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
        }],
      },
      expectedReason: "direct_support",
      expectedDirectCount: 1,
      expectedSynthesizedCount: 0,
      expectedRemovedCount: 0,
    },
    {
      label: "unknown partial reason",
      draft: partialDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "provider_partial",
        }],
      },
      expectedReason: "partial_support",
      expectedDirectCount: 1,
      expectedSynthesizedCount: 0,
      expectedRemovedCount: 0,
    },
    {
      label: "missing related-only reason",
      draft: relatedOnlyDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [0],
        }],
      },
      expectedReason: "related_only",
      expectedDirectCount: 0,
      expectedSynthesizedCount: 0,
      expectedRemovedCount: 0,
    },
    {
      label: "unknown downgrade reason",
      draft: completeDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "provider_removed_claim",
        }],
      },
      expectedReason: "unsupported_claim_removed",
      expectedDirectCount: 0,
      expectedSynthesizedCount: 0,
      expectedRemovedCount: 1,
    },
    {
      label: "unknown omitted-target reason",
      draft: targetOmittedDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "provider_no_match",
        }],
      },
      expectedReason: "target_omitted",
      expectedDirectCount: 0,
      expectedSynthesizedCount: 0,
      expectedRemovedCount: 0,
    },
  ] satisfies Array<{
    label: string;
    draft: FinalAction;
    decision: unknown;
    expectedReason: CoverageVerificationReason;
    expectedDirectCount: number;
    expectedSynthesizedCount: number;
    expectedRemovedCount: number;
  }>)("normalizes $label at the model boundary", async ({
    draft,
    decision,
    expectedReason,
    expectedDirectCount,
    expectedSynthesizedCount,
    expectedRemovedCount,
  }) => {
    const onVerified = vi.fn();

    await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft,
      evidence,
      model: schemaParsingVerifier(decision).model,
      onVerified,
    });

    expect(onVerified).toHaveBeenCalledWith([
      {
        id: "R1",
        reason: expectedReason,
        retainedDirectSegmentCount: expectedDirectCount,
        retainedSynthesizedSegmentCount: expectedSynthesizedCount,
        removedSegmentCount: expectedRemovedCount,
      },
    ]);
  });

  it("keeps the exported verifier contract decision-only and strict", () => {
    expect(coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [0, 2],
        reason: "related_only",
      }],
    })).toMatchObject({
      requirements: [{ retainedRelatedContextIndexes: [0, 2] }],
    });

    for (const invalid of [
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "direct_support",
          answer: "模型不得复制答案",
        }],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [1, 0],
          reason: "related_only",
        }],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [0, 0],
          reason: "related_only",
        }],
      },
    ]) {
      expect(() => coverageVerificationActionSchema.parse(invalid)).toThrow();
    }
  });

  it("retains a supported target by copying the draft exactly", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "direct_support",
        }],
      }),
    });

    expect(result).toEqual(completeDraft);
    expect(result.requirements[0]).not.toBe(completeDraft.requirements[0]);
  });

  it("keeps supported target segments and removes unsupported segments", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "推荐一份 Coremail 邮件系统的 POC 方案给我",
      plan: singleRequirementPlan,
      draft: mixedSupportDraft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "POC测试方案",
        path: "wiki/concepts/POC测试方案.md",
        content:
          "POC测试方案通常包含测试目标、测试环境、测试范围、测试用例和验收标准。",
      }, {
        requirementId: "R1",
        citation: 2,
        title: "项目说明",
        path: "wiki/concepts/项目说明.md",
        content: "项目风险需要按实际范围评估。",
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "partial_support",
        }],
      } as unknown as CoverageVerificationAction),
    });

    expect(result).toEqual({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer:
          "POC 测试方案通常包括测试目标、测试环境、测试范围、测试用例和验收标准 [1]。",
        citations: [1],
      }],
      citations: [1],
    });
    expect(JSON.stringify(result)).not.toContain("零风险");
  });

  it("rebuilds an uncovered result from retained draft indexes without model-written text", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "Coremail 是否支持目标协议",
      plan: singleRequirementPlan,
      draft: relatedOnlyDraft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [1],
          reason: "related_only",
        }],
      }),
    });

    expect(result).toEqual({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有资料未覆盖该要求，无法根据正式知识库确认。",
        citations: [],
        relatedContext: [{
          statement: "资料还说明 HTTP/HTTPS 用于 Webmail 访问 [2]。",
          citations: [2],
        }],
      }],
      citations: [2],
    });
  });

  it("downgrades an unsupported target and removes all target text and citations", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "unsupported_claim_removed",
        }],
      }),
    });

    expect(result).toEqual({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有资料未覆盖该要求，无法根据正式知识库确认。",
        citations: [],
      }],
      citations: [],
    });
    expect(JSON.stringify(result)).not.toContain("草稿结论");
  });

  it.each([
    ["wrong requirement id", {
      action: "verify",
      requirements: [{
        id: "R2",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        reason: "target_omitted",
      }],
    }, relatedOnlyDraft, evidence],
    ["retaining a none target", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        reason: "target_omitted",
      }],
    }, relatedOnlyDraft, evidence],
    ["retaining related context with a target", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [0],
        reason: "direct_support",
      }],
    }, completeDraft, evidence],
    ["an out-of-range related index", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [2],
        reason: "related_only",
      }],
    }, relatedOnlyDraft, evidence],
    ["related evidence from another requirement", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [0],
        reason: "related_only",
      }],
    }, relatedOnlyDraft, [{ ...evidence[0], requirementId: "R2" }]],
  ] as const)(
    "rejects after three invalid decisions: %s",
    async (_label, decision, draft, decisionEvidence) => {
      const completeJson = vi.fn(async () =>
        decision as unknown as CoverageVerificationAction);
      await expect(verifyKnowledgeCoverage({
        question: "问题",
        plan: singleRequirementPlan,
        draft,
        evidence: decisionEvidence,
        model: modelFromCompleteJson(completeJson),
      })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
      expect(completeJson).toHaveBeenCalledTimes(3);
    },
  );

  it("includes the exact deterministic error in the next repair request", async () => {
    const capture = schemaParsingVerifier(
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [2],
          reason: "related_only",
        }],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [0],
          reason: "related_only",
        }],
      },
    );

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: relatedOnlyDraft,
      evidence,
      model: capture.model,
    });

    expect(result.citations).toEqual([1]);
    expect(capture.completeJson).toHaveBeenCalledTimes(2);
    expect(capture.completeJson.mock.calls[1]?.[0].messages.at(-1)?.content)
      .toContain("related_context_index_out_of_range:R1:2");
  });

  it("includes the precise model schema path in the next repair request", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => {
      if (completeJson.mock.calls.length === 1) {
        throw new InvalidModelPayloadError(
          "invalid_schema:requirements.0.retainedRelatedContextIndexes:invalid_type",
        );
      }
      return input.schema.parse({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "direct_support",
        }],
      });
    });

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    });

    expect(result).toEqual(completeDraft);
    expect(completeJson.mock.calls[1]?.[0].messages.at(-1)?.content)
      .toContain(
        "invalid_schema:requirements.0.retainedRelatedContextIndexes:invalid_type",
      );
  });

  it("reports structural failure after three invalid model payloads", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError(
        "invalid_schema:requirements.0.targetDecision:invalid_value",
      );
    });
    const onVerified = vi.fn();

    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
      onVerified,
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
    expect(completeJson).toHaveBeenCalledTimes(3);
    expect(onVerified).toHaveBeenCalledWith([
      {
        id: "R1",
        reason: "target_omitted",
        retainedDirectSegmentCount: 0,
        retainedSynthesizedSegmentCount: 0,
        removedSegmentCount: 1,
      },
    ]);
  });

  it("still propagates model unavailability instead of claiming not covered", async () => {
    const unavailable = new ModelUnavailableError();
    const completeJson = vi.fn(async () => {
      throw unavailable;
    });

    await expect(verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    })).rejects.toBe(unavailable);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("passes the caller abort signal to every model attempt", async () => {
    const controller = new AbortController();
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => {
      expect(input.signal).toBe(controller.signal);
      return input.schema.parse({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "direct_support",
        }],
      });
    });

    await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
      signal: controller.signal,
    });

    expect(completeJson).toHaveBeenCalledOnce();
  });
});

function scriptedVerifier(
  ...actions: Array<CoverageVerificationAction | Error>
): ModelClient {
  let index = 0;
  return {
    completeJson: (async <T>() => {
      const action = index < actions.length ? actions[index] : actions.at(-1);
      index += 1;
      if (action instanceof Error) throw action;
      return action as unknown as T;
    }) as ModelClient["completeJson"],
    completeText: async () => {
      throw new Error("unexpected completeText");
    },
  };
}

function schemaParsingVerifier(...payloads: unknown[]): {
  readonly model: ModelClient;
  readonly completeJson: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const completeJson = vi.fn(async (
    input: Parameters<ModelClient["completeJson"]>[0],
  ) => {
    const payload = index < payloads.length ? payloads[index] : payloads.at(-1);
    index += 1;
    const parsed = input.schema.safeParse(payload);
    if (!parsed.success) {
      throw new InvalidModelPayloadError(
        `invalid_schema:${parsed.error.issues[0]?.path.join(".") ?? "root"}`,
      );
    }
    return parsed.data;
  });
  return {
    model: modelFromCompleteJson(completeJson),
    completeJson,
  };
}

function modelFromCompleteJson(
  completeJson: ReturnType<typeof vi.fn>,
): ModelClient {
  return {
    completeJson: completeJson as ModelClient["completeJson"],
    completeText: async () => {
      throw new Error("unexpected completeText");
    },
  };
}
