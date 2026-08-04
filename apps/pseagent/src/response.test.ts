import { describe, expect, it } from "vitest";
import type { AnswerStatus, Coverage, FinalAction, Reference } from "./contracts.js";
import type { CoverageGap } from "./coverage-gap.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
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

  it("separates knowledge coverage from current-case assessability", () => {
    const action: FinalAction = {
      action: "final",
      requirements: [
        { id: "R1", coverage: "complete", answer: "可按正式方法推进 POC[1]。", citations: [1] },
        { id: "R2", coverage: "none", answer: "缺少当次客户事实，不能判断当前赢率。", citations: [] },
      ],
      citations: [1],
    };
    const ledger = {
      project: "presales-general",
      revision: "a".repeat(40),
      units: [
        {
          inputState: "not_applicable",
          ambiguous: false,
          conflictDetected: false,
          verification: { coverage: "complete" },
        },
        {
          inputState: "missing",
          ambiguous: false,
          conflictDetected: false,
          verification: { coverage: "none" },
        },
      ],
    } as unknown as EvidenceLedger;
    const gap: CoverageGap = {
      id: "G1",
      requirementId: "R2",
      deliverableId: "D2",
      obligationId: "O2",
      domain: "presales-general",
      gapClass: "input",
      reason: "required_customer_input_missing",
      subject: "当前 POC 机会",
      missingAspect: "客户决策链、预算与 POC 评价结果",
      affectsConclusion: true,
      confirmedBoundary: "已有方法知识，但缺少本次机会事实。",
      nextAction: "补齐客户决策链、预算和 POC 评价结果后再评估赢率。",
    };

    const result = formatKnowledgeFinal("general", action, [reference], {
      evidenceLedgers: [ledger],
      coverageGaps: [gap],
    });

    expect(result).toMatchObject({
      status: "answered",
      knowledgeCoverage: "complete",
      caseAssessability: "insufficient",
    });
    expect(result.answer).toContain("尚未确认的部分：");
    expect(result.answer).toContain("当前 POC 机会");
    expect(result.answer).toContain("客户决策链、预算与 POC 评价结果");
    expect(result.answer).not.toContain("知识库尚未覆盖问题的其余部分");
  });

  it("shows at most three precise gap groups without dropping later gaps", () => {
    const gaps: CoverageGap[] = ["架构", "迁移", "授权", "服务"].map((label, index) => ({
      id: `G${index + 1}`,
      requirementId: `R${index + 1}`,
      deliverableId: `D${index + 1}`,
      obligationId: `O${index + 1}`,
      domain: "coremail-professional",
      gapClass: "knowledge",
      reason: "no_matching_page",
      subject: `对象${index + 1}`,
      missingAspect: label,
      affectsConclusion: true,
      confirmedBoundary: `尚未找到${label}证据。`,
      nextAction: `补充${label}正式资料。`,
    }));
    const action: FinalAction = {
      action: "final",
      requirements: [
        { id: "R1", coverage: "partial", answer: "已确认基础能力[1]。", citations: [1] },
      ],
      citations: [1],
    };

    const result = formatKnowledgeFinal("professional", action, [reference], {
      coverageGaps: gaps,
    });

    expect(result.answer.match(/^\d+\. /gmu)).toHaveLength(3);
    for (const label of ["架构", "迁移", "授权", "服务"]) {
      expect(result.answer).toContain(label);
    }
  });
});
