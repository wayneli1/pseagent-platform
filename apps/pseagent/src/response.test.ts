import { describe, expect, it } from "vitest";
import type { AnswerStatus, Coverage, Reference } from "./contracts.js";
import {
  GENERAL_UNAVAILABLE_TEXT,
  KNOWLEDGE_UNAVAILABLE_TEXT,
  NOT_COVERED_TEXT,
  deriveStatus,
  formatAnswerResult,
} from "./response.js";

const reference: Reference = {
  index: 1,
  project: "coremail-professional",
  title: "Coremail AI 助手",
  path: "wiki/concepts/coremail-ai助手.md",
  revision: "a".repeat(40),
  contentHash: "b".repeat(64),
};

describe("knowledge response", () => {
  it.each<[Coverage, number, AnswerStatus]>([
    ["none", 0, "not_covered"],
    ["complete", 1, "answered"],
    ["partial", 1, "partially_answered"],
    ["complete", 0, "not_covered"],
  ])("maps coverage %s with %i refs to %s", (coverage, refs, expected) => {
    expect(deriveStatus(coverage, refs)).toBe(expected);
  });

  it("uses exact fixed not-covered and unavailable texts", () => {
    expect(formatAnswerResult({ scope: "professional", status: "not_covered", answer: "draft", references: [] }).answer)
      .toBe(NOT_COVERED_TEXT);
    expect(formatAnswerResult({ scope: "general", status: "temporarily_unavailable", answer: "stack", references: [] }).answer)
      .toBe(KNOWLEDGE_UNAVAILABLE_TEXT);
    expect(formatAnswerResult({ scope: "normal", status: "temporarily_unavailable", answer: "stack", references: [] }).answer)
      .toBe(GENERAL_UNAVAILABLE_TEXT);
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
