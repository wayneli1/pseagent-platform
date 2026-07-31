import { describe, expect, it, vi } from "vitest";
import { knowledgePlanSchema } from "./contracts.js";
import { ModelKnowledgePlanner } from "./knowledge-planner.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { KNOWLEDGE_PLAN_SYSTEM_PROMPT } from "./prompts.js";

const compositePlan = {
  subject: "Coremail 安全网关",
  requirements: [
    {
      id: "R1" as const,
      question: "详细功能清单",
      queries: ["Coremail 安全网关 功能清单", "CACTER CAC 功能"],
      evidenceMode: "direct_only" as const,
    },
    {
      id: "R2" as const,
      question: "POC 注意事项",
      queries: ["网关 POC 测试要点", "安全网关 POC 注意事项"],
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
        queries: ["Coremail AI 新功能"],
        evidenceMode: "direct_only",
      }],
    }).requirements).toHaveLength(1);
  });

  it.each([
    {
      subject: "网关",
      requirements: [{ id: "R2", question: "功能", queries: ["安全网关功能"] }],
    },
    {
      subject: "网关",
      requirements: [
        { id: "R1", question: "功能", queries: ["安全网关功能"] },
        { id: "R1", question: "POC", queries: ["网关 POC"] },
      ],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        queries: ["995065939-poc阶段资料", "网关 POC 测试要点"],
      }],
    },
    {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "POC",
        queries: ["网关 POC", "网关   POC"],
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
          queries: ["Coremail 十万用户 多活架构"],
          evidenceMode: "direct_only" as const,
        },
        {
          id: "R2" as const,
          question: "如何规划容灾方案",
          queries: ["Coremail 十万用户 容灾方案"],
          evidenceMode: "synthesis_allowed" as const,
        },
        {
          id: "R3" as const,
          question: "镜像同步机制如何实现",
          queries: ["Coremail 镜像同步机制"],
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
    expect(result.requirements[0]?.queries.join(" ")).toMatch(/十万用户.*Coremail.*(?:容量|硬件)/u);
    expect(result.requirements.slice(1).map((requirement) => requirement.id))
      .toEqual(["R2", "R3", "R4"]);
  });

  it.each([
    ["售前工程师的工作职责有哪些？", "售前职责", "synthesis_allowed"],
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
          queries: [requirementQuestion],
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

  it("expands presales duty retrieval into complementary evidence facets", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({
      subject: "售前工程师职责",
      requirements: [{
        id: "R1",
        question: "售前工程师的工作职责有哪些？",
        queries: ["售前工程师的岗位职责"],
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

    expect(result.requirements[0]?.queries).toEqual([
      "售前工程师的岗位职责",
      "愿景演示 技术证明 解决方案销售 需求诊断 可信顾问",
      "机会质量 客户证据 售前冲突沟通场景集",
    ]);
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
