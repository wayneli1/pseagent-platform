import { describe, expect, it, vi } from "vitest";
import {
  coverageVerificationActionSchema,
  type CoverageVerificationAction,
  type CoverageVerificationReason,
  type FinalAction,
  type KnowledgePlan,
} from "./contracts.js";
import {
  coverageVerificationReport,
  inferCoverageVerificationReport,
  InvalidCoverageVerificationError,
  notCoveredRequirementAnswer,
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
    evidenceAspects: [{
      id: "A1",
      label: "协议支持性",
      terms: ["目标协议", "支持"],
    }],
    queries: [{
      text: "Coremail 目标协议支持",
      aspectIds: ["A1"],
    }],
    evidenceMode: "direct_only",
  }],
};

const synthesisPlan: KnowledgePlan = {
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责有哪些",
    evidenceAspects: [{
      id: "A1",
      label: "职责领域",
      terms: ["售前", "职责"],
    }],
    queries: [{
      text: "售前 工作职责",
      aspectIds: ["A1"],
    }],
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
  it("rejects a verifier decision that drops one explicitly named scenario choice", async () => {
    const plan: KnowledgePlan = {
      subject: "DNS 切换",
      requirements: [{
        id: "R1",
        question: "CNAME 跳转和直接改 A 记录各适合什么场景",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "两种方案的适用场景",
          terms: ["CNAME", "A 记录", "适用场景"],
        }],
        queries: [{ text: "CNAME A 记录适用场景", aspectIds: ["A1"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "CNAME 跳转适合减少客户端改动的场景 [1]。",
          "直接改 A 记录适合客户端可统一变更的场景 [1]。",
        ].join("\n"),
        citations: [1],
      }],
      citations: [1],
    };
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse(completeJson.mock.calls.length === 1
      ? {
          action: "verify",
          requirements: [{
            id: "R1",
            targetDecision: "retain_partial",
            retainedTargetSegmentIndexes: [1],
            synthesizedTargetSegmentIndexes: [],
            retainedRelatedContextIndexes: [],
            coveredAspectIds: ["A1"],
            reason: "partial_support",
          }],
        }
      : {
          action: "verify",
          requirements: [{
            id: "R1",
            targetDecision: "retain",
            retainedTargetSegmentIndexes: [0, 1],
            synthesizedTargetSegmentIndexes: [],
            retainedRelatedContextIndexes: [],
            coveredAspectIds: ["A1"],
            reason: "direct_support",
          }],
        }));

    const result = await verifyKnowledgeCoverage({
      question: plan.subject,
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "DNS 切换方案对比",
        path: "wiki/comparisons/dns.md",
        content: "正文分别说明 CNAME 跳转和直接修改 A 记录的适用场景。",
      }],
      model: { completeJson } as unknown as ModelClient,
    });

    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(result.requirements[0]?.coverage).toBe("complete");
    expect(result.requirements[0]?.answer).toContain("CNAME");
  });

  it.each(["；", "。"])(
    "applies a trailing citation to preceding same-line comparison clauses separated by %s",
    async (separator) => {
    const plan: KnowledgePlan = {
      subject: "协议对比",
      requirements: [{
        id: "R1",
        question: "POP3 和 IMAP 在文件夹上有什么差别",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "POP3 与 IMAP 的文件夹差别",
          terms: ["POP3", "IMAP", "文件夹"],
        }],
        queries: [{ text: "POP3 IMAP 文件夹", aspectIds: ["A1"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: `**文件夹**：POP3 仅可操作收件箱${separator}IMAP 可操作所有文件夹 [1]。`,
        citations: [1],
      }],
      citations: [1],
    };
    const completeJson = vi.fn(async () => ({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0, 1],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        coveredAspectIds: ["A1"],
        reason: "direct_support",
      }],
    } as CoverageVerificationAction));

    const result = await verifyKnowledgeCoverage({
      question: plan.subject,
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "POP3 与 IMAP 协议对比",
        path: "wiki/comparisons/pop3-vs-imap.md",
        content: "POP3 仅可操作收件箱，IMAP 可操作所有文件夹。",
        aspectIds: ["A1"],
      }],
      model: modelFromCompleteJson(completeJson),
    });

    expect(completeJson).toHaveBeenCalledOnce();
    expect(result.requirements[0]).toEqual(draft.requirements[0]);
    },
  );

  it("normalizes an accidental synthesized marker for direct-only evidence", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [0],
        retainedRelatedContextIndexes: [],
        coveredAspectIds: ["A1"],
        reason: "direct_support",
      }],
    }));
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "是否支持目标协议",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
      onVerified,
    });

    expect(result.requirements[0]).toMatchObject({
      coverage: "complete",
      answer: "草稿结论[1]。",
    });
    expect(onVerified).toHaveBeenCalledWith([expect.objectContaining({
      reason: "direct_support",
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 0,
    })]);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("rejects duplicate or extra summaries when materializing a report", () => {
    const summary = {
      id: "R1",
      reason: "direct_support" as const,
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 0,
      coveredAspectCount: 1,
      missingAspectCount: 0,
      coveredAspectIds: ["A1"],
      missingAspectIds: [],
      claimDecisions: [{
        claimIndex: 0,
        status: "retained_direct" as const,
        citations: [1],
        coveredAspectIds: ["A1"],
      }],
    };
    expect(() => coverageVerificationReport(completeDraft, [summary, summary]))
      .toThrowError(expect.objectContaining<Partial<InvalidCoverageVerificationError>>({
        message: "verification_summary_mismatch",
      }));
  });

  it.each([
    {
      name: "duplicate claim indexes",
      claimDecisions: [
        {
          claimIndex: 0,
          status: "retained_direct" as const,
          citations: [1],
          coveredAspectIds: ["A1"],
        },
        {
          claimIndex: 0,
          status: "removed" as const,
          citations: [1],
          coveredAspectIds: [],
        },
      ],
      code: "verification_claim_index_invalid",
    },
    {
      name: "retained citation outside the materialized requirement",
      claimDecisions: [{
        claimIndex: 0,
        status: "retained_direct" as const,
        citations: [2],
        coveredAspectIds: ["A1"],
      }],
      code: "verification_claim_citation_invalid",
    },
    {
      name: "claim aspect outside the covered aspect set",
      claimDecisions: [{
        claimIndex: 0,
        status: "retained_direct" as const,
        citations: [1],
        coveredAspectIds: ["A2"],
      }],
      code: "verification_claim_aspect_invalid",
    },
  ])("rejects $name", ({ claimDecisions, code }) => {
    expect(() => coverageVerificationReport(completeDraft, [{
      id: "R1",
      reason: "direct_support",
      retainedDirectSegmentCount: claimDecisions.filter(
        (claim) => claim.status === "retained_direct",
      ).length,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: claimDecisions.filter(
        (claim) => claim.status === "removed",
      ).length,
      coveredAspectCount: 1,
      missingAspectCount: 0,
      coveredAspectIds: ["A1"],
      missingAspectIds: [],
      claimDecisions,
    }])).toThrowError(expect.objectContaining<Partial<InvalidCoverageVerificationError>>({
      message: code,
    }));
  });

  it("infers one conservative aggregate claim decision for an injected verifier", () => {
    const report = inferCoverageVerificationReport(
      completeDraft,
      singleRequirementPlan,
    );

    expect(report.summaries[0]?.claimDecisions).toEqual([{
      claimIndex: 0,
      status: "retained_direct",
      citations: [1],
      coveredAspectIds: ["A1"],
    }]);
  });

  it("marks a synthesized partial fallback as inferred instead of direct support", () => {
    const report = inferCoverageVerificationReport(
      {
        ...synthesisDraft,
        requirements: [{
          ...synthesisDraft.requirements[0]!,
          coverage: "partial",
        }],
      },
      synthesisPlan,
    );

    expect(report.inferred).toBe(true);
    expect(report.summaries[0]?.claimDecisions).toEqual([{
      claimIndex: 0,
      status: "retained_synthesized",
      citations: [1, 2],
      coveredAspectIds: [],
    }]);
  });

  it("keeps a sentence citation attached when it follows punctuation", async () => {
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "正文直接确认目标协议。 [1]",
        citations: [1],
      }],
      citations: [1],
    };

    const result = await verifyKnowledgeCoverage({
      question: "是否支持目标协议",
      plan: singleRequirementPlan,
      draft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "direct_support",
        }],
      } as CoverageVerificationAction),
    });

    expect(result.requirements[0]).toEqual(draft.requirements[0]);
  });

  it("audits an uncited factual segment, removes it, and keeps its structural heading", async () => {
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "**1. 核心能力**",
          "正文直接确认目标协议[1]。",
          "未经引用的额外断言。",
        ].join("\n"),
        citations: [1],
      }],
      citations: [1],
    };
    const onReport = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "是否支持目标协议",
      plan: singleRequirementPlan,
      draft,
      evidence: [{
        ...evidence[0],
        content: "正文直接确认目标协议。",
        aspectIds: ["A1"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
      onReport,
    });

    expect(result.requirements[0]).toEqual({
      id: "R1",
      coverage: "complete",
      answer: "**1. 核心能力**\n正文直接确认目标协议[1]。",
      citations: [1],
    });
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({
      summaries: [expect.objectContaining({
        claimDecisions: [
          {
            claimIndex: 0,
            status: "retained_direct",
            citations: [1],
            coveredAspectIds: ["A1"],
          },
          {
            claimIndex: 1,
            status: "removed",
            citations: [],
            coveredAspectIds: [],
          },
        ],
      })],
    }));
    expect(result.requirements[0]?.answer).not.toContain("额外断言");
  });

  it("conservatively removes an uncited segment from a retain decision", async () => {
    const completeJson = vi.fn(async (
      _input: Parameters<ModelClient["completeJson"]>[0],
    ) => ({
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0, 1],
        synthesizedTargetSegmentIndexes: [],
        retainedRelatedContextIndexes: [],
        coveredAspectIds: ["A1"],
        reason: "direct_support",
      }],
    } as CoverageVerificationAction));

    const result = await verifyKnowledgeCoverage({
      question: "是否支持目标协议",
      plan: singleRequirementPlan,
      draft: {
        ...completeDraft,
        requirements: [{
          ...completeDraft.requirements[0]!,
          answer: "正文直接确认目标协议[1]。未经引用的额外断言。",
        }],
      },
      evidence,
      model: modelFromCompleteJson(completeJson),
    });

    expect(completeJson).toHaveBeenCalledOnce();
    expect(result.requirements[0]).toMatchObject({
      coverage: "complete",
      answer: "正文直接确认目标协议[1]。",
      citations: [1],
    });
  });

  it("downgrades complete when cited pages do not cover every dynamic aspect", async () => {
    const plan: KnowledgePlan = {
      subject: "互补能力",
      requirements: [{
        id: "R1",
        question: "归纳两个互补能力面",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "能力一", terms: ["能力一"] },
          { id: "A2", label: "能力二", terms: ["能力二"] },
        ],
        queries: [
          { text: "能力一资料", aspectIds: ["A1"] },
          { text: "能力二资料", aspectIds: ["A2"] },
        ],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "当前证据只说明能力一 [1]。",
        citations: [1],
      }],
      citations: [1],
    };
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "归纳两个互补能力面",
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "能力一",
        path: "wiki/concepts/能力一.md",
        content: "正文说明能力一。",
        aspectIds: ["A1"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [0],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]).toMatchObject({
      id: "R1",
      coverage: "partial",
      citations: [1],
    });
    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "synthesized_support",
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 1,
      removedSegmentCount: 0,
      coveredAspectCount: 1,
      missingAspectCount: 1,
    }]);
  });

  it("does not count a cited page aspect that the retained answer never states", async () => {
    const plan: KnowledgePlan = {
      subject: "互补能力",
      requirements: [{
        id: "R1",
        question: "归纳两个互补能力面",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["需求访谈"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [{
          text: "售前互补能力",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "售前需要做好需求诊断 [1]。",
        citations: [1],
      }],
      citations: [1],
    };
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "归纳两个互补能力面",
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "综合方法",
        path: "wiki/synthesis/methods.md",
        content: "正文同时说明需求诊断与可信顾问。",
        aspectIds: ["A1", "A2"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [0],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]).toMatchObject({
      coverage: "partial",
      citations: [1],
    });
    expect(onVerified).toHaveBeenCalledWith([
      expect.objectContaining({
        coveredAspectCount: 1,
        missingAspectCount: 1,
      }),
    ]);
  });

  it("does not override the verifier's explicit missing aspect with a lexical match", async () => {
    const plan: KnowledgePlan = {
      subject: "两项能力",
      requirements: [{
        id: "R1",
        question: "说明能力一和能力二",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "能力一", terms: ["能力一"] },
          { id: "A2", label: "能力二", terms: ["能力二"] },
        ],
        queries: [{ text: "两项能力", aspectIds: ["A1", "A2"] }],
      }],
    };
    const onReport = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "说明能力一和能力二",
      plan,
      draft: {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "草稿同时写了能力一和能力二[1]。",
          citations: [1],
        }],
        citations: [1],
      },
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "两项能力",
        path: "wiki/two-aspects.md",
        content: "正文提及能力一和能力二。",
        aspectIds: ["A1", "A2"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [0],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onReport,
    });

    expect(result.requirements[0]?.coverage).toBe("partial");
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({
      summaries: [expect.objectContaining({
        coveredAspectIds: ["A1"],
        missingAspectIds: ["A2"],
      })],
    }));
  });

  it("marks a broad answer partial when one verifier-confirmed planned aspect is missing", async () => {
    const evidenceAspects = Array.from({ length: 4 }, (_, index) => ({
      id: `A${index + 1}` as `A${number}`,
      label: `主题${index + 1}`,
      terms: [`术语${index + 1}`],
    }));
    const plan: KnowledgePlan = {
      subject: "宽泛主题",
      requirements: [{
        id: "R1",
        question: "概述这个主题的主要方向",
        evidenceMode: "synthesis_allowed",
        evidenceAspects,
        queries: [{
          text: "宽泛主题主要方向",
          aspectIds: evidenceAspects.map((aspect) => aspect.id),
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "主题一、主题二和主题三构成主要方向 [1]。",
        citations: [1],
      }],
      citations: [1],
    };

    const onReport = vi.fn();
    const result = await verifyKnowledgeCoverage({
      question: plan.requirements[0]!.question,
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "宽泛主题",
        path: "wiki/synthesis/broad-topic.md",
        content: "正文说明主题一、主题二、主题三和主题四。",
        aspectIds: ["A1", "A2", "A3", "A4"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [0],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2", "A3"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onReport,
    });

    expect(result.requirements[0]).toMatchObject({
      coverage: "partial",
      citations: [1],
    });
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({
      summaries: [expect.objectContaining({
        coveredAspectIds: ["A1", "A2", "A3"],
        missingAspectIds: ["A4"],
      })],
      coveredRequirementIds: ["R1"],
      missingRequirementIds: ["R1"],
    }));
  });

  it("restores complete after unsupported extras are removed when every aspect remains covered", async () => {
    const plan: KnowledgePlan = {
      subject: "审计能力",
      requirements: [{
        id: "R1",
        question: "Coremail 如何支持邮件审计",
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "审计记录", terms: ["审计日志"] },
          { id: "A2", label: "权限控制", terms: ["三员分立"] },
        ],
        queries: [{
          text: "Coremail 邮件审计",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: [
          "审计记录会保留审计日志 [1]。",
          "权限控制采用三员分立 [2]。",
          "管理员可以任意读取所有邮件 [2]。",
        ].join("\n"),
        citations: [1, 2],
      }],
      citations: [1, 2],
    };
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "Coremail 如何支持邮件审计",
      plan,
      draft,
      evidence: [
        {
          requirementId: "R1",
          citation: 1,
          title: "审计管理",
          path: "wiki/concepts/审计管理.md",
          content: "正文说明系统保留审计日志。",
          aspectIds: ["A1"],
        },
        {
          requirementId: "R1",
          citation: 2,
          title: "三员分立",
          path: "wiki/concepts/三员分立.md",
          content: "正文说明权限控制采用三员分立。",
          aspectIds: ["A2"],
        },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]).toEqual({
      id: "R1",
      coverage: "complete",
      answer: [
        "审计记录会保留审计日志 [1]。",
        "权限控制采用三员分立 [2]。",
      ].join("\n"),
      citations: [1, 2],
    });
    expect(JSON.stringify(result)).not.toContain("任意读取");
    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "partial_support",
      retainedDirectSegmentCount: 2,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 1,
      coveredAspectCount: 2,
      missingAspectCount: 0,
    }]);
  });

  it("keeps a heavily trimmed answer partial even when one coarse aspect remains covered", async () => {
    const plan: KnowledgePlan = {
      subject: "可执行请求",
      requirements: [{
        id: "R1",
        question: "怎样把请求写得可执行",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "可执行请求",
          terms: ["可执行"],
        }],
        queries: [{ text: "可执行请求", aspectIds: ["A1"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "明确对象 [1]。",
          "明确动作 [1]。",
          "明确时间 [1]。",
          "约定检查点 [1]。",
        ].join("\n"),
        citations: [1],
      }],
      citations: [1],
    };

    const result = await verifyKnowledgeCoverage({
      question: plan.subject,
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "请求与要求的区别",
        path: "wiki/concepts/request.md",
        content: "正式资料说明应约定检查点。",
        aspectIds: ["A1"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [3],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
    });

    expect(result.requirements[0]).toMatchObject({
      coverage: "partial",
      answer: "约定检查点 [1]。",
    });
  });

  it("does not hide a verifier downgrade of an originally complete structured answer", async () => {
    const plan: KnowledgePlan = {
      subject: "认证配置",
      requirements: [{
        id: "R1",
        question: "认证流程的关键配置是什么",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "关键配置",
          terms: ["关键配置"],
        }],
        queries: [{ text: "认证流程关键配置", aspectIds: ["A1"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "AuthorizeUrl 指向授权页面 [1]。",
          "AccessTokenUrl 用于获取令牌 [1]。",
        ].join("\n"),
        citations: [1],
      }],
      citations: [1],
    };

    const result = await verifyKnowledgeCoverage({
      question: plan.subject,
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "认证配置",
        path: "wiki/concepts/auth.md",
        content: "AuthorizeUrl 指向授权页面，AccessTokenUrl 用于获取令牌。",
        aspectIds: ["A1"],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
    });

    expect(result.requirements[0]?.coverage).toBe("partial");
    expect(result.requirements[0]?.answer).not.toContain("AccessTokenUrl");
  });

  it("keeps partial after filtering when a planned aspect is still missing", async () => {
    const plan: KnowledgePlan = {
      subject: "两项能力",
      requirements: [{
        id: "R1",
        question: "说明两项能力",
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "能力一", terms: ["能力一"] },
          { id: "A2", label: "能力二", terms: ["能力二"] },
        ],
        queries: [{ text: "两项能力", aspectIds: ["A1", "A2"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: ["正文确认能力一 [1]。", "草稿声称能力二 [2]。"].join("\n"),
        citations: [1, 2],
      }],
      citations: [1, 2],
    };

    const result = await verifyKnowledgeCoverage({
      question: "说明两项能力",
      plan,
      draft,
      evidence: [
        {
          requirementId: "R1",
          citation: 1,
          title: "能力一",
          path: "wiki/concepts/能力一.md",
          content: "正文确认能力一。",
          aspectIds: ["A1"],
        },
        {
          requirementId: "R1",
          citation: 2,
          title: "相邻资料",
          path: "wiki/concepts/相邻资料.md",
          content: "正文没有说明能力二。",
          aspectIds: [],
        },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
    });

    expect(result.requirements[0]).toMatchObject({
      coverage: "partial",
      answer: "正文确认能力一 [1]。",
      citations: [1],
    });
  });

  it("accepts semantically equivalent aspect wording confirmed by the verifier", async () => {
    const plan: KnowledgePlan = {
      subject: "职责归纳",
      requirements: [{
        id: "R1",
        question: "归纳两个职责领域",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "产品演示", terms: ["技术证明"] },
          { id: "A2", label: "冲突沟通", terms: ["异议处理"] },
        ],
        queries: [{
          text: "职责领域",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "方案展示需要按客户角色控制内容深度 [1]。",
          "客户质疑应转化为可协商的需要 [2]。",
        ].join("\n"),
        citations: [1, 2],
      }],
      citations: [1, 2],
    };
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "归纳两个职责领域",
      plan,
      draft,
      evidence: [
        {
          requirementId: "R1",
          citation: 1,
          title: "演示方法",
          path: "wiki/concepts/demo.md",
          content: "正文说明愿景演示、技术证明与角色分层。",
          aspectIds: ["A1"],
        },
        {
          requirementId: "R1",
          citation: 2,
          title: "沟通方法",
          path: "wiki/concepts/conflict.md",
          content: "正文说明冲突沟通、客户异议与需要辨析。",
          aspectIds: ["A2"],
        },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [0, 1],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]?.coverage).toBe("complete");
    expect(onVerified).toHaveBeenCalledWith([
      expect.objectContaining({
        coveredAspectCount: 2,
        missingAspectCount: 0,
      }),
    ]);
  });

  it("binds a pure structural heading to its adjacent cited factual segment", async () => {
    const plan: KnowledgePlan = {
      subject: "职责归纳",
      requirements: [{
        id: "R1",
        question: "归纳两个职责领域",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["需求访谈"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [{
          text: "职责领域",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: [
          "**需求诊断**",
          "用需求访谈确认问题与影响 [1]。",
          "**信任建立**",
          "再以可信顾问方式给出透明建议 [2]。",
        ].join("\n"),
        citations: [1, 2],
      }],
      citations: [1, 2],
    };
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "归纳两个职责领域",
      plan,
      draft,
      evidence: [
        {
          requirementId: "R1",
          citation: 1,
          title: "需求诊断",
          path: "wiki/concepts/diagnosis.md",
          content: "正文说明需求访谈。",
          aspectIds: ["A1"],
        },
        {
          requirementId: "R1",
          citation: 2,
          title: "可信顾问",
          path: "wiki/concepts/trust.md",
          content: "正文说明可信顾问。",
          aspectIds: ["A2"],
        },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [0, 1],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
    });

    expect(result.requirements[0]?.coverage).toBe("complete");
    expect(onVerified).toHaveBeenCalledWith([
      expect.objectContaining({
        coveredAspectCount: 2,
        missingAspectCount: 0,
      }),
    ]);
  });

  it("accepts semantically equivalent covered aspects without requiring literal labels or navigation tags", async () => {
    const plan: KnowledgePlan = {
      subject: "综合建议",
      requirements: [{
        id: "R1",
        question: "给出发现问题并建立共识的建议",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["需求访谈"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [{ text: "发现问题 建立共识", aspectIds: ["A1", "A2"] }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "先共同澄清现状与影响[1]。再以透明沟通形成双方认可的下一步[1]。",
        citations: [1],
      }],
      citations: [1],
    };
    const onVerified = vi.fn();
    const onReport = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "给出发现问题并建立共识的建议",
      plan,
      draft,
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "方法正文",
        path: "wiki/method.md",
        content: "正文说明共同澄清现状、识别影响并通过透明沟通形成共识。",
        aspectIds: [],
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [0, 1],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2"],
          reason: "synthesized_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
      onReport,
    });

    expect(result.requirements[0]?.coverage).toBe("complete");
    expect(onVerified).toHaveBeenCalledWith([
      expect.objectContaining({
        coveredAspectCount: 2,
        missingAspectCount: 0,
      }),
    ]);
    expect(onReport).toHaveBeenCalledWith({
      summaries: [expect.objectContaining({
        coveredAspectIds: ["A1", "A2"],
        missingAspectIds: [],
      })],
      coveredRequirementIds: ["R1"],
      missingRequirementIds: [],
    });
  });

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
          coveredAspectIds: ["A1"],
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
      coveredAspectCount: 1,
      missingAspectCount: 0,
    }]);
  });

  it("does not bypass the verifier for a business-specific synthesis question", async () => {
    const fullDutyDraft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "模型草稿会由正式六页证据映射替换[1][2][3][4][5][6]。",
        citations: [1, 2, 3, 4, 5, 6],
      }],
      citations: [1, 2, 3, 4, 5, 6],
    };
    const fullDutyEvidence = [
      ["售前诊断式对话框架", "wiki/synthesis/售前诊断式对话框架.md"],
      ["解决方案销售", "wiki/concepts/解决方案销售.md"],
      ["愿景演示与技术证明的区分", "wiki/concepts/愿景演示与技术证明的区分.md"],
      ["可信顾问", "wiki/concepts/可信顾问.md"],
      ["售前冲突沟通场景集", "wiki/synthesis/售前冲突沟通场景集.md"],
      ["机会质量与客户证据", "wiki/concepts/机会质量与客户证据.md"],
    ].map(([title, path], index) => ({
      requirementId: "R1",
      citation: index + 1,
      title: title!,
      path: path!,
      content: `# ${title}\n正式知识正文`,
    }));
    const completeJson = vi.fn(async () => ({
      action: "verify" as const,
      requirements: [{
        id: "R1",
        targetDecision: "retain" as const,
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [0],
        retainedRelatedContextIndexes: [],
        coveredAspectIds: ["A1"],
        reason: "synthesized_support" as const,
      }],
    }));
    const onVerified = vi.fn();

    const result = await verifyKnowledgeCoverage({
      question: "售前工程师的工作职责有哪些？",
      plan: synthesisPlan,
      draft: fullDutyDraft,
      evidence: fullDutyEvidence,
      model: modelFromCompleteJson(completeJson),
      onVerified,
    });

    expect(completeJson).toHaveBeenCalledOnce();
    expect(result.requirements[0]).toMatchObject({
      coverage: "complete",
      citations: [1, 2, 3, 4, 5, 6],
    });
    expect(result.requirements[0]?.answer).toContain(
      "模型草稿会由正式六页证据映射替换",
    );
    expect(result.requirements[0]?.answer).not.toContain(
      "需求诊断与访谈",
    );
    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "synthesized_support",
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 1,
      removedSegmentCount: 0,
      coveredAspectCount: 1,
      missingAspectCount: 0,
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
      coveredAspectCount: 0,
      missingAspectCount: 1,
    }]);
  });

  it("reports retained direct, retained synthesized, and removed segments without changing the legacy callback", async () => {
    const plan: KnowledgePlan = {
      subject: "混合证据决策",
      requirements: [{
        id: "R1",
        question: "归纳两项有证据支持的结论",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "直接事实", terms: ["直接确认"] },
          { id: "A2", label: "综合结论", terms: ["综合归纳"] },
        ],
        queries: [{
          text: "直接事实 综合结论",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const draft: FinalAction = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "partial",
        answer: [
          "正文直接确认事实一 [1]。",
          "两篇资料可综合归纳结论二 [2]。",
          "草稿还包含未获支持的结论三 [3]。",
        ].join("\n"),
        citations: [1, 2, 3],
      }],
      citations: [1, 2, 3],
    };
    const onVerified = vi.fn();
    const onReport = vi.fn();

    await verifyKnowledgeCoverage({
      question: "归纳两项有证据支持的结论",
      plan,
      draft,
      evidence: [
        {
          requirementId: "R1",
          citation: 1,
          title: "直接事实",
          path: "wiki/direct.md",
          content: "正文直接确认事实一。",
          aspectIds: ["A1"],
        },
        {
          requirementId: "R1",
          citation: 2,
          title: "综合材料",
          path: "wiki/synthesis.md",
          content: "正文提供形成结论二的基础事实。",
          aspectIds: ["A2"],
        },
        {
          requirementId: "R1",
          citation: 3,
          title: "相邻材料",
          path: "wiki/adjacent.md",
          content: "正文不支持草稿中的结论三。",
          aspectIds: [],
        },
      ],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [0, 1],
          synthesizedTargetSegmentIndexes: [1],
          retainedRelatedContextIndexes: [],
          coveredAspectIds: ["A1", "A2"],
          reason: "partial_support",
        }],
      } as CoverageVerificationAction),
      onVerified,
      onReport,
    });

    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({
      summaries: [expect.objectContaining({
        claimDecisions: [
          {
            claimIndex: 0,
            status: "retained_direct",
            citations: [1],
            coveredAspectIds: ["A1"],
          },
          {
            claimIndex: 1,
            status: "retained_synthesized",
            citations: [2],
            coveredAspectIds: ["A2"],
          },
          {
            claimIndex: 2,
            status: "removed",
            citations: [3],
            coveredAspectIds: [],
          },
        ],
      })],
    }));
    expect(onVerified).toHaveBeenCalledWith([{
      id: "R1",
      reason: "partial_support",
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 1,
      removedSegmentCount: 1,
      coveredAspectCount: 2,
      missingAspectCount: 0,
    }]);
  });

  it.each([
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
        coveredAspectCount: 0,
        missingAspectCount: 1,
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
          coveredAspectIds: ["A1"],
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

  it("normalizes bounded provider aliases and omitted mechanical fields", async () => {
    const capture = schemaParsingVerifier({
      requirements: [{
        decision: "supported",
        retainedSegmentIndexes: [0, 0],
        aspectIds: ["A1"],
      }],
    });

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: capture.model,
    });

    expect(result).toEqual(completeDraft);
    expect(capture.completeJson).toHaveBeenCalledOnce();
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
          coveredAspectIds: ["A1"],
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

  it("repairs a dangling section when its unsupported opening sentence is removed", async () => {
    const result = await verifyKnowledgeCoverage({
      question: "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
      plan: singleRequirementPlan,
      draft: {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "partial",
          answer:
            "**1. 国产化与安全能力：** Coremail 支持未经证实的能力 [1]。并支持 SM2/SM3/SM4 国密算法 [2]。\n**2. 金融行业信创替换实践：** 广发银行采用全栈国产化架构 [3]。",
          citations: [1, 2, 3],
        }],
        citations: [1, 2, 3],
      },
      evidence: [{
        requirementId: "R1",
        citation: 1,
        title: "未采用的证据",
        path: "wiki/unsupported.md",
        content: "该证据不能支持草稿的第一句话。",
      }, {
        requirementId: "R1",
        citation: 2,
        title: "国密算法",
        path: "wiki/crypto.md",
        content: "Coremail 支持 SM2、SM3 和 SM4 国密算法。",
      }, {
        requirementId: "R1",
        citation: 3,
        title: "金融行业实践",
        path: "wiki/finance.md",
        content: "广发银行采用全栈国产化架构。",
      }],
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain_partial",
          retainedTargetSegmentIndexes: [1, 2],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [],
          reason: "partial_support",
        }],
      } as unknown as CoverageVerificationAction),
    });

    expect(result.requirements[0]?.answer).toBe(
      "**1. 国产化与安全能力：** 支持 SM2/SM3/SM4 国密算法 [2]。\n**2. 金融行业信创替换实践：** 广发银行采用全栈国产化架构 [3]。",
    );
    expect(result.requirements[0]?.citations).toEqual([2, 3]);
    expect(result.requirements[0]?.answer).not.toContain("未经证实");
    expect(result.requirements[0]?.answer).not.toMatch(/^并/u);
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
        answer: notCoveredRequirementAnswer("是否支持目标协议"),
        citations: [],
        relatedContext: [{
          statement: "资料还说明 HTTP/HTTPS 用于 Webmail 访问 [2]。",
          citations: [2],
        }],
      }],
      citations: [2],
    });
  });

  it("drops retained related context that repeats the protected target", async () => {
    const draft: FinalAction = {
      ...relatedOnlyDraft,
      requirements: [{
        ...relatedOnlyDraft.requirements[0]!,
        relatedContext: [
          relatedOnlyDraft.requirements[0]!.relatedContext![0]!,
          {
            statement: "资料还说明目标协议已经具备兼容能力 [2]。",
            citations: [2],
          },
        ],
      }],
    };
    const result = await verifyKnowledgeCoverage({
      question: "Coremail 是否支持目标协议",
      plan: {
        ...singleRequirementPlan,
        requirements: [{
          ...singleRequirementPlan.requirements[0]!,
          question: "目标协议的支持情况",
        }],
      },
      draft,
      evidence,
      model: scriptedVerifier({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "not_covered",
          retainedTargetSegmentIndexes: [],
          synthesizedTargetSegmentIndexes: [],
          retainedRelatedContextIndexes: [0, 1],
          reason: "related_only",
        }],
      }),
    });

    expect(result.requirements[0]?.relatedContext).toEqual([
      relatedOnlyDraft.requirements[0]!.relatedContext![0],
    ]);
    expect(result.citations).toEqual([1]);
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
        answer: notCoveredRequirementAnswer("是否支持目标协议"),
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
          coveredAspectIds: ["A1"],
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
    expect(completeJson).toHaveBeenCalledTimes(5);
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

  it("falls back to conservative whole-requirement verification after structural failures", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => {
      if (completeJson.mock.calls.length <= 3) {
        throw new InvalidModelPayloadError("invalid_schema:requirements");
      }
      return input.schema.parse({
        requirements: [{ decision: "supported" }],
      });
    });

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    });

    expect(result).toMatchObject({
      action: "final",
      requirements: [{ id: "R1", coverage: "partial", citations: [1] }],
      citations: [1],
    });
    expect(completeJson).toHaveBeenCalledTimes(4);
    expect(completeJson.mock.calls[3]?.[0].schemaDescription)
      .toBe("pse_whole_requirement_verification");
  });

  it("falls back conservatively after repeated recoverable decision-shape failures", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => {
      if (completeJson.mock.calls.length <= 3) {
        return input.schema.parse({
          action: "verify",
          requirements: [{
            id: "R1",
            targetDecision: "retain_partial",
            retainedTargetSegmentIndexes: [],
            synthesizedTargetSegmentIndexes: [],
            retainedRelatedContextIndexes: [],
            reason: "partial_support",
          }],
        });
      }
      return input.schema.parse({
        requirements: [{ decision: "supported" }],
      });
    });

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft: completeDraft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    });

    expect(result.requirements[0]?.coverage).not.toBe("none");
    expect(completeJson).toHaveBeenCalledTimes(4);
    expect(completeJson.mock.calls[3]?.[0].schemaDescription)
      .toBe("pse_whole_requirement_verification");
  });

  it("removes uncited segments during conservative whole-requirement fallback", async () => {
    const draft: FinalAction = {
      ...completeDraft,
      requirements: [{
        ...completeDraft.requirements[0]!,
        answer: "有引用的结论[1]。\n没有引用的补充断言。",
      }],
    };
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => {
      if (completeJson.mock.calls.length <= 3) {
        return input.schema.parse({
          action: "verify",
          requirements: [{
            id: "R1",
            targetDecision: "retain",
            retainedTargetSegmentIndexes: [0, 1],
            synthesizedTargetSegmentIndexes: [],
            retainedRelatedContextIndexes: [],
            reason: "direct_support",
          }],
        });
      }
      return input.schema.parse({ requirements: [{ decision: "supported" }] });
    });

    const result = await verifyKnowledgeCoverage({
      question: "问题",
      plan: singleRequirementPlan,
      draft,
      evidence,
      model: modelFromCompleteJson(completeJson),
    });

    expect(result.requirements[0]).toMatchObject({ coverage: "partial" });
    expect(result.requirements[0]?.answer).toContain("有引用的结论");
    expect(result.requirements[0]?.answer).not.toContain("补充断言");
    expect(completeJson).toHaveBeenCalledOnce();
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
