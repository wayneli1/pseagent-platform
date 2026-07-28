import { describe, expect, it } from "vitest";
import {
  HISTORICAL_ANSWER_WARNING,
  agentActionSchema,
  answerResultSchema,
  coverageVerificationActionSchema,
  historicalAnswerSchema,
  routeActionSchema,
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
  it("accepts only professional, general, and normal routes", () => {
    for (const scope of ["professional", "general", "normal"] as const) {
      expect(routeActionSchema.parse({ action: "route", scope })).toEqual({ action: "route", scope });
    }
    for (const scope of ["both", "mixed", "ambiguous"]) {
      expect(() => routeActionSchema.parse({ action: "route", scope })).toThrow();
    }
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

  it("accepts only strict per-requirement coverage verification results", () => {
    expect(coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有正文未覆盖目标协议。",
        citations: [],
        reason: "related_only",
      }],
      citations: [],
    })).toMatchObject({
      action: "verify",
      requirements: [{ id: "R1", coverage: "none" }],
    });

    expect(() => coverageVerificationActionSchema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "支持[1]",
        citations: [1],
        reason: "invented_reason",
      }],
      citations: [1],
    })).toThrow();
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
