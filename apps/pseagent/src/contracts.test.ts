import { describe, expect, it } from "vitest";
import {
  HISTORICAL_ANSWER_WARNING,
  agentActionSchema,
  answerResultSchema,
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
