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

const completeAction: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: "基于正式资料给出建议 [1]。",
    citations: [1],
  }],
  citations: [1],
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

  it("keeps audited related guidance visible when case input is missing", () => {
    const ledger = {
      project: "presales-general",
      revision: "a".repeat(40),
      units: [{
        inputState: "missing",
        ambiguous: false,
        conflictDetected: false,
        verification: { coverage: "none" },
      }],
    } as unknown as EvidenceLedger;

    const result = formatKnowledgeFinal(
      "general",
      targetNoneWithRelatedContext,
      [reference, relatedReference],
      { evidenceLedgers: [ledger] },
    );

    expect(result).toMatchObject({
      status: "partially_answered",
      knowledgeCoverage: "none",
      caseAssessability: "insufficient",
    });
    expect(result.answer).toContain("正式知识库相关信息：");
    expect(result.answer).toContain("SMTP、POP3 和 IMAP");
    expect(result.answer).toContain("覆盖结论：");
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

  it("uses the structured renderer to deduplicate cross-obligation text", () => {
    const result = formatKnowledgeFinal("professional", {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "complete",
          answer: "1. 支持标准协议 [1]。",
          citations: [1],
        },
        {
          id: "R2",
          coverage: "complete",
          answer: "支持标准协议 [1]。\n2. 此外，需核对适用版本 [1]。",
          citations: [1],
        },
      ],
      citations: [1],
    }, [reference]);

    expect(result.answer.match(/支持标准协议/gu)).toHaveLength(1);
    expect(result.answer).toContain("- 需核对适用版本 [1]。");
    expect(result.answer).not.toContain("1. 支持标准协议");
    expect(result.answer).not.toContain("2. 此外");
  });

  it("does not downgrade coverage for an optional uncovered obligation", () => {
    const result = formatKnowledgeFinal("professional", {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "complete",
          answer: "必答项已覆盖 [1]。",
          citations: [1],
        },
        {
          id: "R2",
          coverage: "none",
          answer: "可选项未覆盖。",
          citations: [],
        },
      ],
      citations: [1],
    }, [reference], {
      requirementBindings: [
        {
          globalRequirementId: "R1",
          deliverableId: "D1",
          obligationId: "O1",
          domain: "coremail-professional",
        },
        {
          globalRequirementId: "R2",
          deliverableId: "D1",
          obligationId: "O2",
          domain: "coremail-professional",
          required: false,
        },
      ],
    });

    expect(result).toMatchObject({
      status: "answered",
      knowledgeCoverage: "complete",
    });
  });

  it.each([
    {
      question: "已知客户现网是 Exchange、约 1.5 万用户、计划 Q4 采购、预算未批、竞争对手已进场，请重新评估项目并给出下一步。",
      expected: ["Exchange", "1.5 万", "Q4", "预算未批"],
    },
    {
      question: "用户约 6 万、两地三中心，要求 RPO 不超过 5 分钟、RTO 不超过 30 分钟，请给出架构建议。",
      expected: ["6 万", "两地三中心", "RPO", "RTO"],
    },
  ])("keeps user-provided background and constraints visible: $question", ({
    question,
    expected,
  }) => {
    const result = formatKnowledgeFinal("professional", completeAction, [reference], {
      question,
    });

    expect(result.answer).toContain("用户提供的背景与约束（非知识库结论）：");
    for (const value of expected) expect(result.answer).toContain(value);
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
    expect(result.answer).toContain("下一步验证：");
    expect(result.answer).toContain("当前 POC 机会");
    expect(result.answer).toContain("客户决策链、预算与 POC 评价结果");
    expect(result.answer).not.toContain("知识库尚未覆盖问题的其余部分");
  });

  it("makes an explicit evidence conflict visible even if model wording omits it", () => {
    const action: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "需要核对版本与适用范围 [1]。",
        citations: [1],
      }],
      citations: [1],
    };
    const ledger = {
      project: "coremail-professional",
      revision: "a".repeat(40),
      units: [{
        inputState: "not_applicable",
        ambiguous: false,
        conflictDetected: true,
        freshness: "not_assessed",
        verification: { coverage: "complete" },
      }],
    } as unknown as EvidenceLedger;

    const result = formatKnowledgeFinal("professional", action, [reference], {
      evidenceLedgers: [ledger],
    });

    expect(result.caseAssessability).toBe("conflicting");
    expect(result.answer).toContain("正式资料冲突");
    expect(result.answer).toContain("不能合并为单一确定结论");
    expect(result.answer).toContain("版本、资料日期、权威级别与适用范围");
  });

  it("reports an input-only gap as a partial answer instead of missing knowledge", () => {
    const action: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "缺少当次客户事实，不能可靠判断。",
        citations: [],
      }],
      citations: [],
    };
    const ledger = {
      project: "presales-general",
      revision: "a".repeat(40),
      units: [{
        inputState: "missing",
        ambiguous: false,
        conflictDetected: false,
        verification: { coverage: "none" },
      }],
    } as unknown as EvidenceLedger;
    const gap: CoverageGap = {
      id: "G1",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      domain: "presales-general",
      gapClass: "input",
      reason: "required_customer_input_missing",
      subject: "当前机会",
      missingAspect: "客户决策与预算事实",
      affectsConclusion: true,
      confirmedBoundary: "缺少当次客户输入，当前无法可靠判断。",
      nextAction: "补齐客户事实后再评估。",
    };

    const result = formatKnowledgeFinal("general", action, [], {
      evidenceLedgers: [ledger],
      coverageGaps: [gap],
    });

    expect(result).toMatchObject({
      status: "partially_answered",
      knowledgeCoverage: "none",
      caseAssessability: "insufficient",
      references: [],
    });
    expect(result.answer).toContain("客户决策与预算事实");
    expect(result.answer).not.toContain("当前知识库暂未覆盖");
    expect(result.answer).not.toContain("资料来源：");
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

  it("lists the formal material classes needed for an uncovered product capability", () => {
    const gap: CoverageGap = {
      id: "G1",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      domain: "coremail-professional",
      gapClass: "retrieval",
      reason: "retrieval_budget_exhausted",
      subject: "某产品",
      missingAspect: "支持性和适用版本",
      affectsConclusion: true,
      confirmedBoundary: "检索预算已结束，核验尚未完整。",
      nextAction: "继续检索。",
    };
    const action: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "正式知识库未覆盖该能力，无法确认是否支持。",
        citations: [],
      }],
      citations: [],
    };

    const result = formatKnowledgeFinal("professional", action, [], {
      coverageGaps: [gap],
      question: "某产品是否支持新的登录能力，适用版本、License 和配置步骤是什么？",
    });

    expect(result.answer).toContain("资料补充口径");
    expect(result.answer).toContain("正式产品功能说明或发布说明");
    expect(result.answer).toContain("产品版本—功能支持矩阵");
    expect(result.answer).toContain("License、SKU 或版本授权说明");
    expect(result.answer).toContain("正式管理员配置手册");
  });

  it("lists dated security evidence and approval for an uncovered universal vulnerability commitment", () => {
    const gap: CoverageGap = {
      id: "G1",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      domain: "coremail-professional",
      gapClass: "freshness",
      reason: "retrieval_budget_exhausted",
      subject: "当前版本高危漏洞修复状态",
      missingAspect: "截至当前的完整 CVE 覆盖结论",
      affectsConclusion: true,
    };
    const action: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有正式资料无法支持该全量结论。",
        citations: [],
      }],
      citations: [],
    };

    const result = formatKnowledgeFinal("professional", action, [], {
      coverageGaps: [gap],
      question: "能否保证当前版本已修复全部高危 CVE，并写进合同？",
    });

    expect(result.answer).toContain("官方安全公告及漏洞清单");
    expect(result.answer).toContain("正式复测、扫描或渗透测试报告");
    expect(result.answer).toContain("产品、安全和法务审批");
    expect(result.answer).toContain("截止日期");
    expect(result.answer).toContain("不能依据现有正式资料确认上述结论");
    expect(result.answer).not.toMatch(/^1\. 对象：/mu);
  });
});
