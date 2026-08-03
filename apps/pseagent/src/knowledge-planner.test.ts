import { describe, expect, it, vi } from "vitest";
import { knowledgePlanSchema } from "./contracts.js";
import { ModelKnowledgePlanner } from "./knowledge-planner.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { KNOWLEDGE_PLAN_SYSTEM_PROMPT } from "./prompts.js";

function plannedEvidence(...texts: string[]) {
  return {
    evidenceAspects: [{
      id: "A1" as const,
      label: "目标证据",
      terms: ["目标", "证据"],
    }],
    queries: texts.map((text) => ({
      text,
      aspectIds: ["A1" as const],
    })),
  };
}

const compositePlan = {
  subject: "Coremail 安全网关",
  requirements: [
    {
      id: "R1" as const,
      question: "详细功能清单",
      ...plannedEvidence("Coremail 安全网关 功能清单", "CACTER CAC 功能"),
      evidenceMode: "direct_only" as const,
    },
    {
      id: "R2" as const,
      question: "POC 注意事项",
      ...plannedEvidence("网关 POC 测试要点", "安全网关 POC 注意事项"),
      evidenceMode: "synthesis_allowed" as const,
    },
  ],
};

function plannerInput() {
  return {
    scope: "professional" as const,
    question: "请介绍安全网关的详细功能和 POC 注意事项",
    conversationContext: "正在做客户测试",
    purpose: "专业知识库边界",
    schema: "受控 schema",
    planningOverview: "专业知识库用途",
  };
}

describe("knowledge plan schema", () => {
  it("accepts one to six sequential requirements with semantic query variants", () => {
    expect(knowledgePlanSchema.parse(compositePlan)).toEqual(compositePlan);
    expect(knowledgePlanSchema.parse({
      subject: "Coremail AI",
      requirements: [{
        id: "R1",
        question: "Coremail AI 是什么",
        ...plannedEvidence("Coremail AI 新功能"),
        evidenceMode: "direct_only",
      }],
    }).requirements).toHaveLength(1);
  });

  it.each([
    {
      subject: "网关",
      requirements: [{
        id: "R2",
        question: "功能",
        ...plannedEvidence("安全网关功能"),
        evidenceMode: "direct_only",
      }],
    },
    {
      subject: "网关",
      requirements: [
        {
          id: "R1",
          question: "功能",
          ...plannedEvidence("安全网关功能"),
          evidenceMode: "direct_only",
        },
        {
          id: "R1",
          question: "POC",
          ...plannedEvidence("网关 POC"),
          evidenceMode: "direct_only",
        },
      ],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        ...plannedEvidence("995065939-poc阶段资料", "网关 POC 测试要点"),
        evidenceMode: "direct_only",
      }],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        ...plannedEvidence("网关 POC", "网关   POC"),
        evidenceMode: "direct_only",
      }],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "测试范围",
          terms: ["范围"],
        }],
        queries: [{
          text: "网关 POC 测试范围",
          aspectIds: ["A2"],
        }],
      }],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "测试范围", terms: ["范围"] },
          { id: "A2", label: "验收标准", terms: ["验收"] },
        ],
        queries: [{
          text: "网关 POC 测试范围",
          aspectIds: ["A1"],
        }],
      }],
    },
  ])("rejects invalid or identifier-led plans", (value) => {
    expect(knowledgePlanSchema.safeParse(value).success).toBe(false);
  });
});

describe("ModelKnowledgePlanner", () => {
  it("uses the bounded knowledge context and returns a structured composite plan", async () => {
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
      expect(input.schemaDescription).toBe("pse_knowledge_plan");
      expect(input.messages[0]?.content).toBe(KNOWLEDGE_PLAN_SYSTEM_PROMPT);
      expect(input.messages[1]?.content).toContain('"knowledgeSchema":"受控 schema"');
      expect(input.messages[1]?.content).toContain('"knowledgePurpose":"专业知识库边界"');
      expect(input.messages[1]?.content).toContain('"planningOverview":"专业知识库用途"');
      expect(input.messages[1]?.content).toContain('"conversationContext":"正在做客户测试"');
      return input.schema.parse(compositePlan);
    });
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(planner.plan(plannerInput())).resolves.toEqual(compositePlan);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("splits an explicit user scale into its own capacity requirement", async () => {
    const bundledPlan = {
      subject: "十万用户 Coremail 邮件系统多活、容灾和镜像同步规划",
      requirements: [
        {
          id: "R1" as const,
          question: "十万用户规模下如何规划多活架构",
          ...plannedEvidence("Coremail 十万用户 多活架构"),
          evidenceMode: "direct_only" as const,
        },
        {
          id: "R2" as const,
          question: "如何规划容灾方案",
          ...plannedEvidence("Coremail 十万用户 容灾方案"),
          evidenceMode: "synthesis_allowed" as const,
        },
        {
          id: "R3" as const,
          question: "镜像同步机制如何实现",
          ...plannedEvidence("Coremail 镜像同步机制"),
          evidenceMode: "synthesis_allowed" as const,
        },
      ],
    };
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse(bundledPlan));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      question: "十万用户规模的 Coremail 邮件系统，如何规划多活、容灾和镜像同步？",
    });

    expect(result.requirements).toHaveLength(4);
    expect(result.requirements[0]).toMatchObject({
      id: "R1",
      question: expect.stringMatching(/十万用户.*(?:服务器|存储|容量|硬件)/u),
      evidenceMode: "direct_only",
    });
    expect(result.requirements[0]?.queries.map((query) => query.text).join(" "))
      .toMatch(/十万用户.*Coremail.*(?:容量|硬件)/u);
    expect(result.requirements.slice(1).map((requirement) => requirement.id))
      .toEqual(["R2", "R3", "R4"]);
  });

  it.each([
    ["售前工程师的工作职责有哪些？", "售前职责", "synthesis_allowed"],
    ["对比 Exchange 邮件系统，Coremail 的优势有哪些？", "Coremail 相比 Exchange 的优势及边界", "direct_only"],
    ["Coremail 是否支持目标协议？", "目标协议支持", "direct_only"],
    ["Coremail 适用哪个版本？", "适用版本", "direct_only"],
    ["最大支持多少用户？", "最大用户数", "direct_only"],
    ["授权和报价是多少？", "授权报价", "direct_only"],
    ["列出全部兼容数据库", "兼容数据库完整清单", "direct_only"],
  ] as const)(
    "normalizes evidence mode for %s",
    async (question, requirementQuestion, expectedMode) => {
      const completeJson = vi.fn(async (
        input: Parameters<ModelClient["completeJson"]>[0],
      ) => input.schema.parse({
        subject: requirementQuestion,
        requirements: [{
          id: "R1",
          question: requirementQuestion,
          ...plannedEvidence(requirementQuestion),
          evidenceMode: "synthesis_allowed",
        }],
      }));
      const planner = new ModelKnowledgePlanner({
        completeJson,
        completeText: vi.fn(),
      } as unknown as ModelClient);

      const result = await planner.plan({
        ...plannerInput(),
        question,
      });

      expect(result.requirements[0]?.evidenceMode).toBe(expectedMode);
    },
  );

  it("collapses overview-derived neighbor topics for a direct product comparison", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Coremail 相比 Exchange 的优势及适用边界",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "产品差异", terms: ["定制", "TCO"] },
          { id: "A2", label: "信创适配", terms: ["国产化"] },
          { id: "A3", label: "行业案例", terms: ["金融案例"] },
        ],
        queries: [
          { text: "Coremail Exchange 对比优势", aspectIds: ["A1"] },
          { text: "Coremail Exchange 信创适配", aspectIds: ["A2"] },
          { text: "Coremail Exchange 行业案例", aspectIds: ["A3"] },
        ],
      }],
    }));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      question: "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
    });

    expect(result.requirements[0]).toMatchObject({
      evidenceMode: "direct_only",
      evidenceAspects: [{
        id: "A1",
        label: "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
      }],
    });
    expect(result.requirements[0]?.queries.every(
      (query) => query.aspectIds.join(",") === "A1",
    )).toBe(true);
  });

  it("deterministically caps an otherwise valid model plan at three queries", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Coremail 相比 Exchange 的优势",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "B9",
          label: "产品对比",
          terms: [
            "Coremail",
            "Exchange",
            "对比",
            "优势",
            "定制",
            "TCO",
            "服务",
            "安全",
            "边界",
          ],
        }],
        queries: [
          { text: "Coremail Exchange 对比一", aspectIds: ["B9"] },
          { text: "Coremail Exchange 对比二", aspectIds: ["B9"] },
          { text: "Coremail Exchange 对比三", aspectIds: ["B9"] },
          { text: "Coremail Exchange 对比四", aspectIds: ["B9"] },
        ],
      }],
    }));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      question: "Coremail 相比 Exchange 有哪些优势？",
    });

    expect(result.requirements[0]?.queries).toHaveLength(3);
    expect(result.requirements[0]?.evidenceAspects[0]).toMatchObject({
      id: "A1",
    });
    expect(result.requirements[0]?.evidenceAspects[0]?.terms).toHaveLength(8);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("preserves model-generated complementary evidence aspects without code augmentation", async () => {
    const dynamicEvidence = {
      evidenceAspects: [
        {
          id: "A1" as const,
          label: "需求与方案",
          terms: ["需求诊断", "解决方案"],
        },
        {
          id: "A2" as const,
          label: "关系与推进",
          terms: ["可信顾问", "机会推进"],
        },
      ],
      queries: [
        {
          text: "售前需求诊断与解决方案组织",
          aspectIds: ["A1" as const],
        },
        {
          text: "售前可信顾问与机会推进",
          aspectIds: ["A2" as const],
        },
      ],
    };
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "售前工程师职责",
      requirements: [{
        id: "R1",
        question: "售前工程师的工作职责有哪些？",
        ...dynamicEvidence,
        evidenceMode: "synthesis_allowed",
      }],
    }));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      scope: "general",
      question: "售前工程师的工作职责有哪些？",
    });

    expect(result.requirements[0]).toMatchObject(dynamicEvidence);
  });

  it("balances a broad synthesis query across the existing three-query budget", async () => {
    const evidenceAspects = Array.from({ length: 6 }, (_, index) => ({
      id: `A${index + 1}` as `A${number}`,
      label: `证据面${index + 1}`,
      terms: [`区分术语${index + 1}`],
    }));
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "多面归纳",
      requirements: [{
        id: "R1",
        question: "归纳多个互补证据面",
        evidenceMode: "synthesis_allowed",
        evidenceAspects,
        queries: [{
          text: "多面归纳查询",
          aspectIds: evidenceAspects.map((aspect) => aspect.id),
        }],
      }],
    }));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      question: "归纳多个互补证据面",
    });

    expect(result.requirements[0]?.queries).toEqual([
      {
        text: "多面归纳查询 区分术语1 区分术语2",
        aspectIds: ["A1", "A2"],
      },
      {
        text: "多面归纳查询 区分术语3 区分术语4",
        aspectIds: ["A3", "A4"],
      },
      {
        text: "多面归纳查询 区分术语5 区分术语6",
        aspectIds: ["A5", "A6"],
      },
    ]);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("adds distinguishing aspect terms to a broad direct-evidence query", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "Coremail XT6 部署方式",
      requirements: [{
        id: "R1",
        question: "Coremail XT6 常见部署方式有哪些",
        evidenceMode: "direct_only",
        evidenceAspects: [
          {
            id: "A1",
            label: "单机部署",
            terms: ["单机部署", "单节点"],
          },
          {
            id: "A2",
            label: "多机部署",
            terms: ["多机部署", "分布式部署"],
          },
        ],
        queries: [{
          text: "Coremail XT6 常见部署方式",
          aspectIds: ["A1", "A2"],
        }],
      }],
    }));
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await planner.plan({
      ...plannerInput(),
      question: "Coremail XT6 常见部署方式有哪些",
    });

    expect(result.requirements[0]?.queries).toEqual([{
      text: "Coremail XT6 常见部署方式 单机部署 单节点 多机部署 分布式部署",
      aspectIds: ["A1", "A2"],
    }]);
  });

  it("repairs an invalid model payload", async () => {
    const completeJson = vi.fn()
      .mockRejectedValueOnce(new InvalidModelPayloadError())
      .mockImplementationOnce(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
        expect(input.messages.at(-1)?.content).toContain("只重新输出合法规划 JSON");
        return input.schema.parse(compositePlan);
      });
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(planner.plan(plannerInput())).resolves.toEqual(compositePlan);
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("makes two repair attempts before rejecting invalid payloads", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError();
    });
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(planner.plan(plannerInput())).rejects.toBeInstanceOf(InvalidModelPayloadError);
    expect(completeJson).toHaveBeenCalledTimes(3);
  });
});
