import { describe, expect, it, vi } from "vitest";
import {
  coverageVerificationActionSchema,
  type CoverageVerificationAction,
  type CoverageVerificationReason,
  type FinalAction,
  type KnowledgePlan,
} from "./contracts.js";
import {
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
  it.each([
    {
      label: "missing complete reason",
      draft: completeDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedRelatedContextIndexes: [],
        }],
      },
      expectedReason: "direct_support",
    },
    {
      label: "unknown partial reason",
      draft: partialDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedRelatedContextIndexes: [],
          reason: "provider_partial",
        }],
      },
      expectedReason: "partial_support",
    },
    {
      label: "missing related-only reason",
      draft: relatedOnlyDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedRelatedContextIndexes: [0],
        }],
      },
      expectedReason: "related_only",
    },
    {
      label: "unknown downgrade reason",
      draft: completeDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedRelatedContextIndexes: [],
          reason: "provider_removed_claim",
        }],
      },
      expectedReason: "unsupported_claim_removed",
    },
    {
      label: "unknown omitted-target reason",
      draft: targetOmittedDraft,
      decision: {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedRelatedContextIndexes: [],
          reason: "provider_no_match",
        }],
      },
      expectedReason: "target_omitted",
    },
  ] satisfies Array<{
    label: string;
    draft: FinalAction;
    decision: unknown;
    expectedReason: CoverageVerificationReason;
  }>)("normalizes $label at the model boundary", async ({
    draft,
    decision,
    expectedReason,
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
      { id: "R1", reason: expectedReason },
    ]);
  });

  it("keeps the exported verifier contract decision-only and strict", () => {
    expect(coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
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
          retainedRelatedContextIndexes: [1, 0],
          reason: "related_only",
        }],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
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
          retainedRelatedContextIndexes: [],
          reason: "direct_support",
        }],
      }),
    });

    expect(result).toEqual(completeDraft);
    expect(result.requirements[0]).not.toBe(completeDraft.requirements[0]);
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
        retainedRelatedContextIndexes: [],
        reason: "target_omitted",
      }],
    }, relatedOnlyDraft, evidence],
    ["retaining a none target", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedRelatedContextIndexes: [],
        reason: "target_omitted",
      }],
    }, relatedOnlyDraft, evidence],
    ["retaining related context with a target", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedRelatedContextIndexes: [0],
        reason: "direct_support",
      }],
    }, completeDraft, evidence],
    ["an out-of-range related index", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedRelatedContextIndexes: [2],
        reason: "related_only",
      }],
    }, relatedOnlyDraft, evidence],
    ["related evidence from another requirement", {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedRelatedContextIndexes: [0],
        reason: "related_only",
      }],
    }, relatedOnlyDraft, [{ ...evidence[0], requirementId: "R2" }]],
  ] as const)(
    "falls back conservatively after three invalid decisions: %s",
    async (_label, decision, draft, decisionEvidence) => {
      const completeJson = vi.fn(async () =>
        decision as unknown as CoverageVerificationAction);
      const result = await verifyKnowledgeCoverage({
        question: "问题",
        plan: singleRequirementPlan,
        draft,
        evidence: decisionEvidence,
        model: modelFromCompleteJson(completeJson),
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
          retainedRelatedContextIndexes: [2],
          reason: "related_only",
        }],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
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

  it("returns a deterministic uncovered result after three invalid model payloads", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError(
        "invalid_schema:requirements.0.targetDecision:invalid_value",
      );
    });
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
      onVerified,
    });

    expect(result).toMatchObject({
      requirements: [{ coverage: "none", citations: [] }],
      citations: [],
    });
    expect(completeJson).toHaveBeenCalledTimes(3);
    expect(onVerified).toHaveBeenCalledWith([
      { id: "R1", reason: "target_omitted" },
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
