import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HISTORICAL_ANSWER_WARNING,
  agentActionSchema,
  answerResultSchema,
  coverageVerificationActionSchema,
  finalOnlyActionSchema,
  historicalAnswerSchema,
  knowledgePlanSchema,
  requirementCoverageSchema,
  routeActionSchema,
  type RelatedContextItem,
  type RequirementCoverage,
} from "./contracts.js";

const historical = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "low",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史资料原文",
  references: [{
    sourceType: "jira",
    id: "10001",
    key: "CMHA-1097",
    title: "镜像版本记录",
    url: "https://jira.example.test/browse/CMHA-1097",
    updatedAt: "2026-07-20",
    versions: ["5.0", "5.1"],
    status: "已解决",
  }],
} as const;

describe("PSEAgent contracts", () => {
  it("states that Coremail MCP history may contain many errors and is clues only", () => {
    expect(HISTORICAL_ANSWER_WARNING).toBe(
      "以下内容由 Coremail MCP 根据 Jira/Wiki 历史资料自动整理，并非正式知识库答案，也未经过产品或售前人员验证。内容可能存在较多错误、过时信息、资料缺失或版本不匹配，请仅作为继续检索的线索，不能直接用于客户答复、投标、部署、升级或变更决策。",
    );
  });

  it("accepts only professional, general, and normal routes", () => {
    for (const scope of ["professional", "general", "normal"] as const) {
      expect(routeActionSchema.parse({ action: "route", scope })).toEqual({ action: "route", scope });
    }
    for (const scope of ["both", "mixed", "ambiguous"]) {
      expect(() => routeActionSchema.parse({ action: "route", scope })).toThrow();
    }
  });

  it("requires an explicit evidence mode on every knowledge requirement", () => {
    expect(knowledgePlanSchema.safeParse({
      subject: "售前职责",
      requirements: [{
        id: "R1",
        question: "售前工程师的工作职责",
        queries: ["售前 工作职责"],
      }],
    }).success).toBe(false);

    expect(knowledgePlanSchema.parse({
      subject: "售前职责",
      requirements: [{
        id: "R1",
        question: "售前工程师的工作职责",
        queries: ["售前 工作职责"],
        evidenceMode: "synthesis_allowed",
      }],
    }).requirements[0]?.evidenceMode).toBe("synthesis_allowed");

    expect(knowledgePlanSchema.safeParse({
      subject: "售前职责",
      requirements: [{
        id: "R1",
        question: "售前工程师的工作职责",
        queries: ["售前 工作职责"],
        evidenceMode: "model_guess",
      }],
    }).success).toBe(false);
  });

  it("rejects project and revision in model-visible tool inputs", () => {
    expect(() => agentActionSchema.parse({
      action: "tool",
      tool: "kb.search",
      input: { query: "Coremail AI", topK: 5, project: "coremail-professional" },
    })).toThrow();
  });

  it("accepts parallel reads for distinct pages and rejects an exact duplicate pair", () => {
    expect(agentActionSchema.parse({
      action: "tool",
      tool: "kb.read_pages",
      input: {
        pages: [
          { requirementId: "R1", path: "wiki/one.md" },
          { requirementId: "R1", path: "wiki/two.md" },
        ],
      },
    })).toMatchObject({ tool: "kb.read_pages" });

    expect(() => agentActionSchema.parse({
      action: "tool",
      tool: "kb.read_pages",
      input: {
        pages: [
          { requirementId: "R1", path: "wiki/one.md" },
          { requirementId: "R1", path: "wiki/one.md" },
        ],
      },
    })).toThrow();
  });

  it("accepts two parallel reads for each of four planned requirements", () => {
    expect(agentActionSchema.parse({
      action: "tool",
      tool: "kb.read_pages",
      input: {
        pages: [
          { requirementId: "R1", path: "wiki/r1-primary.md" },
          { requirementId: "R1", path: "wiki/r1-secondary.md" },
          { requirementId: "R2", path: "wiki/r2-primary.md" },
          { requirementId: "R2", path: "wiki/r2-secondary.md" },
          { requirementId: "R3", path: "wiki/r3-primary.md" },
          { requirementId: "R3", path: "wiki/r3-secondary.md" },
          { requirementId: "R4", path: "wiki/r4-primary.md" },
          { requirementId: "R4", path: "wiki/r4-secondary.md" },
        ],
      },
    })).toMatchObject({ tool: "kb.read_pages" });
  });

  it("strips harmless per-requirement explanation fields while keeping final citation fields strict", () => {
    const parsed = agentActionSchema.parse({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "结论[1]",
        citations: [1],
        explanation: "模型附带说明",
      }],
      citations: [1],
    });
    expect(parsed).toEqual({
      action: "final",
      requirements: [{ id: "R1", coverage: "complete", answer: "结论[1]", citations: [1] }],
      citations: [1],
    });
    expect(() => agentActionSchema.parse({
      action: "final",
      requirements: [{ id: "R1", coverage: "complete", answer: "结论[1]", citations: [1] }],
      citations: [1],
      project: "coremail-professional",
    })).toThrow();
  });

  it("derives omitted aggregate final citations from valid requirement metadata", () => {
    const parsed = agentActionSchema.parse({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "产品体系包括核心包和周边产品 [1][2]。",
        citations: [1, 2],
      }],
    });

    expect(parsed).toEqual({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "产品体系包括核心包和周边产品 [1][2]。",
        citations: [1, 2],
      }],
      citations: [1, 2],
    });
  });

  it("replaces a malformed aggregate final citation field with requirement metadata", () => {
    const parsed = finalOnlyActionSchema.parse({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: "资料仅覆盖部分产品线 [2]。",
        citations: [2],
      }],
      citations: "2",
    });

    expect(parsed.citations).toEqual([2]);
  });

  it("accepts only strict per-requirement coverage verification results", () => {
    expect(coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [0],
        reason: "related_only",
      }],
    })).toMatchObject({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "not_covered",
        retainedTargetSegmentIndexes: [],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [0],
      }],
    });

    expect(coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0, 1],
        synthesizedTargetSegmentIndexes: [0, 1],
        retainedRelatedContextIndexes: [],
        reason: "synthesized_support",
      }],
    })).toMatchObject({
      requirements: [{
        synthesizedTargetSegmentIndexes: [0, 1],
        reason: "synthesized_support",
      }],
    });

    expect(() => coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        answer: "模型不得重新输出正文",
        reason: "invented_reason",
      }],
    })).toThrow();
  });

  it("drops only malformed optional related context at the model boundary", () => {
    const parsed = agentActionSchema.parse({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "正式资料未覆盖目标协议，无法确认是否支持。",
        citations: [],
        relatedContext: [
          {
            statement: "资料明确列出 SMTP、POP3 和 IMAP [1]。",
            citations: [1],
          },
          {
            statement: "引用数组为空的可选信息。",
            citations: [],
          },
          {
            statement: "元数据有引用但正文没有内联标记。",
            citations: [1],
          },
        ],
      }],
      citations: [1],
    });

    expect(parsed).toMatchObject({
      requirements: [{
        relatedContext: [{
          statement: "资料明确列出 SMTP、POP3 和 IMAP [1]。",
          citations: [1],
        }],
      }],
    });
  });

  it("accepts bounded related context only for uncovered requirements", () => {
    const noneWithContext = {
      id: "R1",
      coverage: "none" as const,
      answer: "正式资料未提及目标协议，无法确认是否支持。",
      citations: [],
      relatedContext: [{
        statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
        citations: [1, 2],
      }],
    };

    expect(requirementCoverageSchema.parse(noneWithContext)).toEqual(noneWithContext);
    expect(() => requirementCoverageSchema.parse({
      ...noneWithContext,
      relatedContext: Array.from({ length: 4 }, () => noneWithContext.relatedContext[0]),
    })).toThrow();
    expect(() => requirementCoverageSchema.parse({
      ...noneWithContext,
      relatedContext: [{ statement: "没有引用", citations: [] }],
    })).toThrow();
    expect(() => requirementCoverageSchema.parse({
      ...noneWithContext,
      coverage: "complete",
    })).toThrow();
  });

  it("exports statically readonly related-context coverage arrays", () => {
    expectTypeOf<RequirementCoverage["relatedContext"]>()
      .toEqualTypeOf<readonly RelatedContextItem[] | undefined>();
    expectTypeOf<RelatedContextItem["citations"]>()
      .toEqualTypeOf<readonly number[]>();
  });

  it("keeps historical answers separate and requires verifiable Jira/Wiki sources", () => {
    const parsed = answerResultSchema.parse({
      scope: "professional",
      status: "not_covered",
      answer: "固定未覆盖文本",
      references: [],
      historicalAnswer: historical,
    });
    expect(parsed.references).toEqual([]);
    expect(parsed.historicalAnswer?.references[0]?.versions).toEqual(["5.0", "5.1"]);

    expect(() => historicalAnswerSchema.parse({ ...historical, confidence: "none" })).toThrow();
    expect(() => historicalAnswerSchema.parse({ ...historical, references: [] })).toThrow();
    expect(() => historicalAnswerSchema.parse({
      ...historical,
      references: [{ sourceType: "local", title: "本地来源" }],
    })).toThrow();
    expect(() => historicalAnswerSchema.parse({
      ...historical,
      warning: "可省略的警告",
    })).toThrow();
    expect(() => historicalAnswerSchema.parse({
      ...historical,
      answer: "x".repeat(32_769),
    })).toThrow();
  });
});
