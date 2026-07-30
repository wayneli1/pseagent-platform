import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { normalAnswerMessages, ROUTE_SYSTEM_PROMPT } from "./prompts.js";
import { ScopeRouter } from "./router.js";
import { PSEAGENT_SELF_CONTEXT } from "./self-context.js";

describe("ScopeRouter", () => {
  it("puts the complete strict route contract in the model prompt", () => {
    expect(ROUTE_SYSTEM_PROMPT).toContain(
      '{"action":"route","scope":"professional|general|normal"}',
    );
    expect(ROUTE_SYSTEM_PROMPT).toContain("当前问题中的明确主体优先于会话上下文");
  });

  it.each([
    ["Coremail XT6 怎么部署？", "professional"],
    ["怎样向银行客户介绍 Coremail 容灾方案？", "professional"],
    ["如何做厂商无关的售前需求访谈？", "general"],
    ["帮我写一个 JavaScript 数组去重函数", "normal"],
  ] as const)("routes %s to %s", async (_question, expected) => {
    const completeJson = vi.fn(async () => ({ action: "route", scope: expected }));
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;
    await expect(new ScopeRouter(model).route(_question)).resolves.toBe(expected);
  });

  it("repairs an invalid route and never silently downgrades", async () => {
    const completeJson = vi.fn()
      .mockRejectedValueOnce(new InvalidModelPayloadError())
      .mockResolvedValueOnce({ action: "route", scope: "professional" });
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;
    await expect(new ScopeRouter(model).route("Coremail")).resolves.toBe("professional");
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("makes two repair attempts before rejecting an invalid route", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError();
    });
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route("Coremail"))
      .rejects.toBeInstanceOf(InvalidModelPayloadError);
    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it.each([
    "请介绍一下 PSEAgent 项目的目标和整体架构",
    "当前机器人和 Lunkr 是什么关系？",
    "你自己的知识边界是什么？",
    "这个助手是否使用 OpenClaw？",
  ])("routes an explicit self question to normal without model routing: %s", async (question) => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(
      new ScopeRouter(model).route(
        question,
        "此前一直在讨论 Coremail 邮件系统、网关、迁移和部署。",
      ),
    ).resolves.toBe("normal");
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("injects the controlled PSEAgent self description into normal answers", () => {
    const messages = normalAnswerMessages("PSEAgent 的目标是什么？");
    expect(messages[0]?.content).toContain(PSEAGENT_SELF_CONTEXT);
    expect(messages[0]?.content).toContain("不得把 PSEAgent 解释为其他同名项目");
  });
});
