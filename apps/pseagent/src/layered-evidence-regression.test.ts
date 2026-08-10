import { describe, expect, it, vi } from "vitest";
import {
  runKnowledgeAgent,
  type KnowledgeAgentSession,
} from "./agent-loop.js";
import { AnswerService } from "./answer-service.js";
import type {
  AgentAction,
  CoverageVerificationAction,
  FinalAction,
  KnowledgePlan,
} from "./contracts.js";
import {
  InvalidCoverageVerificationError,
  SYNTHESIS_DISCLOSURE,
  verifyKnowledgeCoverage,
  type CoverageEvidenceDocument,
} from "./coverage-verifier.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import {
  ModelKnowledgePlanner,
  type KnowledgePlanner,
} from "./knowledge-planner.js";
import type { ModelClient } from "./model-client.js";

const revision = "a".repeat(40);
const contentHash = "b".repeat(64);

const dutyPages = [
  "wiki/synthesis/售前诊断式对话框架.md",
  "wiki/concepts/解决方案销售.md",
  "wiki/concepts/愿景演示与技术证明的区分.md",
  "wiki/concepts/可信顾问.md",
  "wiki/synthesis/售前冲突沟通场景集.md",
  "wiki/concepts/机会质量与客户证据.md",
] as const;

const dutyDomains = [
  "需求诊断与访谈",
  "方案组织与价值表达",
  "产品演示与技术证明",
  "客户关系建立与深化",
  "冲突沟通与异议处理",
  "机会管理与项目推进",
] as const;

const dutyBodies = new Map<string, string>([
  [dutyPages[0], "通过诊断式提问识别客户痛点、后果与改变理由。"],
  [dutyPages[1], "将诊断结果组织为购买愿景和差异化解决方案价值。"],
  [dutyPages[2], "按客户角色区分愿景演示与技术证明。"],
  [dutyPages[3], "通过可靠性、亲密感和低自我导向建立可信顾问关系。"],
  [dutyPages[4], "处理客户异议、报价质疑以及内外部协同冲突。"],
  [dutyPages[5], "识别关键角色并以客户可观察证据推进销售机会。"],
]);

const exchangePages = [
  "wiki/comparison/coremail-vs-exchange对比.md",
  "wiki/findings/协鑫集团项目经验-海外exchange替换与客户关系重建.md",
] as const;

const exchangeBodies = new Map<string, string>([
  [
    exchangePages[0],
    [
      "Coremail 在个性化定制、较低 TCO、原厂现场服务和邮件安全功能方面具备差异化能力。",
      "对比材料同时提醒：Exchange 也有扩展、安全和品牌定制能力，不能表述为完全不支持。",
    ].join("\n"),
  ],
  [
    exchangePages[1],
    [
      "海外 Exchange 替换案例将降低运维成本和满足数据主权要求列为 Coremail 的价值主张。",
      "该结论来自单一案例，不应直接泛化到所有客户。",
    ].join("\n"),
  ],
]);

const dutyPlan: KnowledgePlan = {
  subject: "售前工程师职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的核心职责领域",
    evidenceAspects: dutyDomains.map((label, index) => ({
      id: `A${index + 1}`,
      label,
      terms: label.split("与"),
    })),
    queries: [
      {
        text: "售前工程师 工作职责 方法论",
        aspectIds: ["A1", "A2", "A3"],
      },
      {
        text: "售前 关系 冲突 机会推进",
        aspectIds: ["A4", "A5", "A6"],
      },
    ],
    evidenceMode: "synthesis_allowed",
  }],
};

describe("layered formal evidence business regression", () => {
  it("answers presales duties from six formal pages without historical fallback", async () => {
    const preloadedPageOrder = [
      dutyPages[3],
      dutyPages[4],
      dutyPages[0],
      dutyPages[1],
      dutyPages[2],
      dutyPages[5],
    ] as const;
    const citationByPage = new Map(
      preloadedPageOrder.map((path, index) => [path, index + 1]),
    );
    const answer = dutyDomains.map(
      (domain, index) =>
        `${domain}：${dutyBodies.get(dutyPages[index]!)} [${
          citationByPage.get(dutyPages[index]!)!
        }]`,
    ).join("\n");
    const citations = dutyPages.map((path) => citationByPage.get(path)!);
    const actions: Array<AgentAction | CoverageVerificationAction> = [
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer,
          citations,
        }],
        citations,
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1, 2, 3, 4, 5],
          synthesizedTargetSegmentIndexes: [0, 1, 2, 3, 4, 5],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      },
    ];
    const model = sequenceModel(actions);
    const session = generalSession();
    const planner = {
      plan: vi.fn(async () => dutyPlan),
    } satisfies KnowledgePlanner;
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => "general" as const) },
      planner,
      knowledge: {
        open: vi.fn(async () => session as unknown as KnowledgeSession),
      },
      runAgent: runKnowledgeAgent,
    });

    const execution = await service.answerDetailed(
      "售前工程师的工作职责有哪些？",
    );

    expect(execution.result.scope).toBe("general");
    expect(execution.result.status).toBe("answered");
    expect(execution.result.answer.startsWith(SYNTHESIS_DISCLOSURE)).toBe(true);
    for (const domain of dutyDomains) {
      expect(execution.result.answer).toContain(domain);
    }
    expect(execution.result.answer).not.toContain("正式知识库相关信息：");
    expect(execution.result.references).toHaveLength(6);
    expect(execution.result.references.every(
      (reference) => reference.project === "presales-general",
    )).toBe(true);
    expect(execution.result.references.map((reference) => reference.path).sort())
      .toEqual([...dutyPages].sort());
    expect(session.readPage).toHaveBeenCalledTimes(6);
    expect(execution).toMatchObject({
      historicalAttempted: false,
      historicalUsed: false,
      draftCoverage: ["complete"],
      verifiedCoverage: ["complete"],
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 6,
      removedSegmentCount: 0,
    });
    expect(execution).not.toHaveProperty("historicalGateReason");
  });

  it("answers Coremail versus Exchange from formal comparison pages without historical fallback", async () => {
    const answer = [
      "个性化定制：Coremail 对企业个性化需求的支持度更高 [1]。",
      "总体成本：Coremail 可通过较低资源消耗和邮件去重降低 TCO [1]。",
      "服务方式：Coremail 可提供原厂人员现场服务 [1]。",
      "安全能力：Coremail 提供陌生人识别、水印、密级邮件和私有加密等能力 [1]。",
      "替换价值：海外案例还体现了降低运维成本和满足数据主权要求的价值 [2]。",
      "边界：Exchange 也具备扩展和高级安全能力，具体比较应结合版本、许可与客户场景 [1][2]。",
    ].join("\n");
    const actions: Array<AgentAction | CoverageVerificationAction> = [
      ...exchangePages.map((path): AgentAction => ({
        action: "tool",
        tool: "kb.read_page",
        input: { requirementId: "R1", path },
      })),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer,
          citations: [1, 2],
        }],
        citations: [1, 2],
      },
      {
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0, 1, 2, 3, 4, 5],
          synthesizedTargetSegmentIndexes: [0, 1, 2, 3, 4, 5],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      },
    ];
    const model = sequenceModel(actions);
    const planner = {
      plan: vi.fn(async (): Promise<KnowledgePlan> => ({
        subject: "Coremail 与 Exchange 对比",
        requirements: [{
          id: "R1",
          question: "Coremail 相比 Exchange 的优势及适用边界",
          evidenceAspects: [
            {
              id: "A1",
              label: "产品差异化",
              terms: ["TCO", "定制", "服务", "安全"],
            },
            {
              id: "A2",
              label: "替换价值与边界",
              terms: ["运维成本", "数据主权", "适用边界"],
            },
          ],
          queries: [
            {
              text: "Coremail Exchange 对比 TCO 定制 服务 安全",
              aspectIds: ["A1"],
            },
            {
              text: "Exchange 替换 Coremail 运维成本 数据主权",
              aspectIds: ["A2"],
            },
          ],
          evidenceMode: "synthesis_allowed",
        }],
      })),
    } satisfies KnowledgePlanner;
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => "professional" as const) },
      planner,
      knowledge: {
        open: vi.fn(async () =>
          exchangeSession() as unknown as KnowledgeSession),
      },
      runAgent: runKnowledgeAgent,
    });

    const execution = await service.answerDetailed(
      "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
    );

    expect(execution.result).toMatchObject({
      scope: "professional",
      status: "answered",
    });
    for (const fact of [
      "个性化定制",
      "TCO",
      "原厂人员现场服务",
      "安全能力",
      "数据主权",
      "具体比较应结合版本、许可与客户场景",
    ]) {
      expect(execution.result.answer).toContain(fact);
    }
    expect(execution.result.references.map((reference) => reference.path))
      .toEqual(exchangePages);
    expect(execution.result.historicalAnswer).toBeUndefined();
    expect(execution.result.historicalNotice).toBeUndefined();
    expect(execution).toMatchObject({
      historicalAttempted: false,
      historicalUsed: false,
      retainedSynthesizedSegmentCount: 6,
      removedSegmentCount: 0,
    });
  });

  it("rejects synthesized support for an unrecorded Coremail protocol", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 协议支持",
      requirements: [{
        id: "R1",
        question: "Coremail 是否支持未记载协议",
        evidenceAspects: [{
          id: "A1",
          label: "协议支持性",
          terms: ["未记载协议", "支持"],
        }],
        queries: [{
          text: "Coremail 未记载协议 支持",
          aspectIds: ["A1"],
        }],
        evidenceMode: "direct_only",
      }],
    };
    const draft = singleRequirementDraft(
      "Coremail 支持未记载协议 [1]。",
      [1],
    );
    const invalidDecision: CoverageVerificationAction = {
      action: "verify",
      requirements: [{
        id: "R1",
        targetDecision: "retain",
        retainedTargetSegmentIndexes: [0],
        synthesizedTargetSegmentIndexes: [0],
        retainedRelatedContextIndexes: [],
        reason: "synthesized_support",
      }],
    };

    await expect(verifyKnowledgeCoverage({
      question: "Coremail 是否支持未记载协议？",
      plan,
      draft,
      evidence: [evidence(1, dutyPages[0], "资料只介绍其他协议。")],
      model: fixedModel(invalidDecision),
    })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
  });

  it.each([
    "Coremail 适用版本是什么？",
    "Coremail 十万用户容量和并发上限是多少？",
    "Coremail 的许可证授权和报价如何？",
  ])("normalizes protected requirement to direct_only: %s", async (question) => {
    const planner = new ModelKnowledgePlanner(sequenceModel([{
      subject: "Coremail 受保护事实",
      requirements: [{
        id: "R1",
        question,
        evidenceAspects: [{
          id: "A1",
          label: "岗位职责",
          terms: ["岗位", "职责"],
        }],
        queries: [{
          text: question,
          aspectIds: ["A1"],
        }],
        evidenceMode: "synthesis_allowed",
      }],
    }]));

    const plan = await planner.plan({
      scope: "professional",
      question,
      purpose: "purpose",
      schema: "schema",
      planningOverview: "overview",
    });

    expect(plan.requirements[0]?.evidenceMode).toBe("direct_only");
  });

  it("removes a duties claim supported only by an adjacent quotation-conflict page", async () => {
    const draft = singleRequirementDraft(
      "售前工程师的职责包括完整的需求、方案、演示和推进工作 [1]。",
      [1],
    );
    const result = await verifyKnowledgeCoverage({
      question: "售前工程师的工作职责有哪些？",
      plan: dutyPlan,
      draft,
      evidence: [evidence(
        1,
        "wiki/synthesis/售前冲突沟通场景集.md",
        "本页只讨论客户对报价的质疑和冲突沟通步骤。",
      )],
      model: fixedModel({
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

    expect(result.requirements[0]).toMatchObject({
      coverage: "none",
      citations: [],
    });
  });

  it("retains a disclosed conflict only with both formal pages cited", async () => {
    const draft = singleRequirementDraft(
      "两篇资料对售前是否负责最终报价给出相反边界，因此该职责仍待确认 [1][2]。",
      [1, 2],
    );
    const result = await verifyKnowledgeCoverage({
      question: "售前工程师是否负责最终报价？",
      plan: dutyPlan,
      draft,
      evidence: [
        evidence(1, dutyPages[0], "资料一将报价沟通列为售前协作内容。"),
        evidence(2, dutyPages[4], "资料二明确最终报价由销售负责。"),
      ],
      model: fixedModel({
        action: "verify",
        requirements: [{
          id: "R1",
          targetDecision: "retain",
          retainedTargetSegmentIndexes: [0],
          synthesizedTargetSegmentIndexes: [0],
          retainedRelatedContextIndexes: [],
          reason: "synthesized_support",
        }],
      }),
    });

    expect(result.requirements[0]?.answer.startsWith(SYNTHESIS_DISCLOSURE))
      .toBe(true);
    expect(result.requirements[0]?.citations).toEqual([1, 2]);
  });
});

function generalSession(): KnowledgeAgentSession {
  return {
    project: "presales-general",
    revision,
    purpose: "general purpose",
    schema: "general schema",
    search: vi.fn(async () => ({
      project: "presales-general" as const,
      revision,
      hits: dutyPages.map((path, index) => ({
        path,
        title: dutyDomains[index]!,
        score: 1 - index / 10,
        matchedTerms: [dutyDomains[index]!],
        snippet: dutyBodies.get(path)!,
      })),
    })),
    graph: vi.fn(async () => ({
      project: "presales-general" as const,
      revision,
      hits: [],
    })),
    readPage: vi.fn(async (path: string) => ({
      project: "presales-general" as const,
      path,
      title: dutyDomains[dutyPages.indexOf(
        path as (typeof dutyPages)[number],
      )] ?? path,
      type: "concept",
      tags: [],
      related: [],
      sources: [],
      body: dutyBodies.get(path) ?? "",
      contentHash,
    })),
    compactPage: vi.fn((page) => page.body),
  };
}

function exchangeSession(): KnowledgeAgentSession {
  return {
    project: "coremail-professional",
    revision,
    purpose: "professional purpose",
    schema: "professional schema",
    search: vi.fn(async () => ({
      project: "coremail-professional" as const,
      revision,
      hits: exchangePages.map((path, index) => ({
        path,
        title: index === 0
          ? "Coremail vs Exchange对比"
          : "协鑫集团项目经验：海外Exchange替换与客户关系重建",
        score: 1 - index / 10,
        matchedTerms: ["Coremail", "Exchange"],
        snippet: exchangeBodies.get(path)!,
      })),
    })),
    graph: vi.fn(async () => ({
      project: "coremail-professional" as const,
      revision,
      hits: [],
    })),
    readPage: vi.fn(async (path: string) => ({
      project: "coremail-professional" as const,
      path,
      title: path === exchangePages[0]
        ? "Coremail vs Exchange对比"
        : "协鑫集团项目经验：海外Exchange替换与客户关系重建",
      type: path === exchangePages[0] ? "comparison" : "finding",
      tags: ["Coremail", "Exchange"],
      related: [],
      sources: [],
      body: exchangeBodies.get(path) ?? "",
      contentHash,
    })),
    compactPage: vi.fn((page) => page.body),
  };
}

function sequenceModel(responses: unknown[]): ModelClient {
  const remaining = [...responses];
  return {
    completeJson: vi.fn(async (input) => {
      const next = remaining.shift();
      if (next === undefined) throw new Error("missing_scripted_response");
      return input.schema.parse(next);
    }),
    completeText: vi.fn(),
  } as unknown as ModelClient;
}

function fixedModel(response: unknown): ModelClient {
  return {
    completeJson: vi.fn(async (input) => input.schema.parse(response)),
    completeText: vi.fn(),
  } as unknown as ModelClient;
}

function singleRequirementDraft(
  answer: string,
  citations: number[],
): FinalAction {
  return {
    action: "final",
    requirements: [{
      id: "R1",
      coverage: "complete",
      answer,
      citations,
    }],
    citations,
  };
}

function evidence(
  citation: number,
  path: string,
  content: string,
): CoverageEvidenceDocument {
  return {
    requirementId: "R1",
    citation,
    title: path,
    path,
    content,
  };
}
