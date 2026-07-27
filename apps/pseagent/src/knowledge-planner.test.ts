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
    },
    {
      id: "R2" as const,
      question: "POC 注意事项",
      queries: ["网关 POC 测试要点", "安全网关 POC 注意事项"],
    },
  ],
};

function plannerInput() {
  return {
    scope: "professional" as const,
    question: "请介绍安全网关的详细功能和 POC 注意事项",
    conversationContext: "正在做客户测试",
    schema: "受控 schema",
    overview: "专业知识库用途",
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
      expect(input.messages[1]?.content).toContain('"knowledgeOverview":"专业知识库用途"');
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

  it("repairs an invalid model payload exactly once", async () => {
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

  it("does not attempt a third model call after two invalid payloads", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError();
    });
    const planner = new ModelKnowledgePlanner({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(planner.plan(plannerInput())).rejects.toBeInstanceOf(InvalidModelPayloadError);
    expect(completeJson).toHaveBeenCalledTimes(2);
  });
});
