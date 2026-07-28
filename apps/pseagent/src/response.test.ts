import { describe, expect, it } from "vitest";
import type { AnswerStatus, Coverage, FinalAction, Reference } from "./contracts.js";
import {
  GENERAL_UNAVAILABLE_TEXT,
  KNOWLEDGE_UNAVAILABLE_TEXT,
  NOT_COVERED_TEXT,
  deriveStatus,
  formatAnswerResult,
  formatKnowledgeFinal,
} from "./response.js";

const reference: Reference = {
  index: 1,
  project: "coremail-professional",
  title: "Coremail AI 助手",
  path: "wiki/concepts/coremail-ai助手.md",
  revision: "a".repeat(40),
  contentHash: "b".repeat(64),
};

const relatedReference: Reference = {
  ...reference,
  index: 2,
  title: "Coremail 协议能力",
  path: "wiki/concepts/protocols.md",
  contentHash: "c".repeat(64),
};

const targetNoneWithRelatedContext: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "none",
    answer: "正式资料未提及目标协议，无法确认 Coremail 是否支持。",
    citations: [],
    relatedContext: [{
      statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
      citations: [1, 2],
    }],
  }],
  citations: [1, 2],
};

describe("knowledge response", () => {
  it.each<[Coverage[], number, AnswerStatus]>([
    [["none"], 0, "not_covered"],
    [["none"], 2, "not_covered"],
    [["complete"], 1, "answered"],
    [["partial"], 1, "partially_answered"],
    [["complete"], 0, "answered"],
    [["complete", "none"], 3, "partially_answered"],
    [["complete", "complete"], 2, "answered"],
  ])("maps requirement coverage %s with %i refs to %s", (coverage, refs, expected) => {
    expect(deriveStatus(coverage, refs)).toBe(expected);
  });

  it("retains audited related context while reporting an uncovered target", () => {
    const result = formatKnowledgeFinal(
      "professional",
      targetNoneWithRelatedContext,
      [reference, relatedReference],
    );

    expect(result).toMatchObject({ status: "not_covered", references: [reference, relatedReference] });
    expect(result.answer).toBe([
      "正式知识库相关信息：",
      "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
      "覆盖结论：",
      "正式资料未提及目标协议，无法确认 Coremail 是否支持。",
      "正式知识库资料来源：",
      [
        "[1] Coremail AI 助手 — coremail-professional/wiki/concepts/coremail-ai助手.md",
        "[2] Coremail 协议能力 — coremail-professional/wiki/concepts/protocols.md",
      ].join("\n"),
    ].join("\n\n"));
    expect(result.answer).not.toContain("不支持");
  });

  it("uses the fixed uncovered fallback when no related context is available", () => {
    const result = formatKnowledgeFinal("professional", {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "正式资料未提及目标协议，无法确认是否支持。",
        citations: [],
      }],
      citations: [],
    }, [reference]);

    expect(result).toEqual({
      scope: "professional",
      status: "not_covered",
      answer: NOT_COVERED_TEXT,
      references: [],
    });
  });

  it("uses exact fixed not-covered and unavailable texts", () => {
    expect(formatAnswerResult({ scope: "professional", status: "not_covered", answer: "draft", references: [] }).answer)
      .toBe(NOT_COVERED_TEXT);
    expect(formatAnswerResult({ scope: "general", status: "temporarily_unavailable", answer: "stack", references: [] }).answer)
      .toBe(KNOWLEDGE_UNAVAILABLE_TEXT);
    expect(formatAnswerResult({ scope: "normal", status: "temporarily_unavailable", answer: "stack", references: [] }).answer)
      .toBe(GENERAL_UNAVAILABLE_TEXT);
  });

  it("preserves a non-empty audited not-covered result and its formal references", () => {
    const result = formatAnswerResult({
      scope: "professional",
      status: "not_covered",
      answer: "正式知识库相关信息：\n\n资料明确列出 SMTP 协议能力 [1]。",
      references: [reference],
    });

    expect(result).toEqual({
      scope: "professional",
      status: "not_covered",
      answer: "正式知识库相关信息：\n\n资料明确列出 SMTP 协议能力 [1]。",
      references: [reference],
    });
  });

  it("formats only public source metadata", () => {
    const result = formatAnswerResult({
      scope: "professional",
      status: "answered",
      answer: "支持该能力[1]。",
      references: [reference],
    });

    expect(result.answer).toBe("支持该能力[1]。\n\n资料来源：\n[1] Coremail AI 助手 — coremail-professional/wiki/concepts/coremail-ai助手.md");
    expect(result.answer).not.toContain(reference.revision);
    expect(result.answer).not.toContain(reference.contentHash);
    expect(result.references).toEqual([reference]);
  });

  it("adds a limitation to partial answers when the draft lacks one", () => {
    const result = formatAnswerResult({
      scope: "professional",
      status: "partially_answered",
      answer: "已确认部分内容[1]。",
      references: [reference],
    });

    expect(result.answer).toContain("知识库尚未覆盖问题的其余部分。");
    expect(result.answer.indexOf("其余部分")).toBeLessThan(result.answer.indexOf("资料来源："));
  });
});
