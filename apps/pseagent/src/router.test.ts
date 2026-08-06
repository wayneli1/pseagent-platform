import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { normalAnswerMessages, ROUTE_SYSTEM_PROMPT } from "./prompts.js";
import {
  isUnambiguouslyGeneralPresalesQuestion,
  isUnambiguouslyNormalQuestion,
  isUnambiguouslyProfessionalQuestion,
  ScopeRouter,
} from "./router.js";
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

  it.each([
    "售前工程师的工作职责有哪些？",
    "请综合知识库说明售前工程师通常承担哪些核心工作。",
    "售前如何做好客户需求访谈和冲突沟通？",
  ])("routes an unambiguously generic presales question without model drift: %s", async (question) => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route(question)).resolves.toBe("general");
    expect(completeJson).not.toHaveBeenCalled();
    expect(isUnambiguouslyGeneralPresalesQuestion(question)).toBe(true);
  });

  it.each([
    "Coremail 售前工程师如何介绍产品功能？",
    "售前工程师如何规划邮件系统迁移？",
    "售前如何对比 Exchange 与 Coremail？",
  ])("does not override a product-bound presales question: %s", (question) => {
    expect(isUnambiguouslyGeneralPresalesQuestion(question)).toBe(false);
  });

  it.each([
    "Coremail 邮件迁移如何分批实施？",
    "Exchange 与 Coremail 共存时域名转发怎样设计？",
    "昨天找到的案例写的是 XT5，今天客户环境是 XT6，旧案例能直接套用吗？",
    "华为和比亚迪邮件项目的合同金额是多少？",
    "现有知识里关于某项目，哪些是已记录事实，哪些只是可借鉴的经验？",
    "招标要求支持 IPv6 双栈，售前要准备哪些验证证据，能否承诺所有模块都支持？",
    "项目要求各模块适配双栈，应该准备哪些技术验证？",
    "客户提出 DLP 要扫描正文附件并支持 OCR、移动端审核，售前该如何核验而不是直接承诺？",
    "客户要求 SAML 和 LDAP 集成，售前应确认哪些接口和版本边界？",
  ])("routes an explicit product boundary without model ambiguity: %s", async (question) => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    expect(isUnambiguouslyProfessionalQuestion(question)).toBe(true);
    await expect(new ScopeRouter(model).route(question)).resolves.toBe("professional");
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("keeps a product-neutral opportunity question in the general boundary", () => {
    expect(isUnambiguouslyProfessionalQuestion(
      "客户在 POC 阶段，信息不足时如何提升赢率？",
    )).toBe(false);
  });

  it.each([
    "售前如何用 SPIN 做需求访谈？",
    "市场活动线索怎样按 MTL 评分、培育和移交？",
  ])("does not treat a presales-method acronym as a product capability: %s", async (question) => {
    const completeJson = vi.fn(async () => ({ action: "route", scope: "general" as const }));
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    expect(isUnambiguouslyProfessionalQuestion(question)).toBe(false);
    await expect(new ScopeRouter(model).route(question)).resolves.toBe("general");
  });

  it.each([
    "顺便解释一下 HTTP 404 是什么。",
    "换个话题，写一首四行的夏日短诗。",
  ])("routes an explicit non-domain request to normal without model JSON: %s", async (question) => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    expect(isUnambiguouslyNormalQuestion(question)).toBe(true);
    await expect(new ScopeRouter(model).route(question, "Coremail 迁移上下文"))
      .resolves.toBe("normal");
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("keeps a capacity and recovery follow-up in the professional context", async () => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route(
      "用户约 6 万、两地三中心，RPO 5 分钟、RTO 30 分钟，请给出容量输入。",
      "前面正在讨论 Exchange 与 Coremail 邮件系统。",
    )).resolves.toBe("professional");
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("repairs an invalid route and never silently downgrades", async () => {
    const completeJson = vi.fn()
      .mockRejectedValueOnce(new InvalidModelPayloadError())
      .mockResolvedValueOnce({ action: "route", scope: "professional" });
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;
    await expect(new ScopeRouter(model).route("客户现场出现 HTTP 404，怎样排查？"))
      .resolves.toBe("professional");
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("normalizes a scope-only provider response without accepting extra fields", async () => {
    const completeJson = vi.fn(async (
      input: Parameters<ModelClient["completeJson"]>[0],
    ) => input.schema.parse({ scope: "professional" }));
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route("客户现场出现 HTTP 404，怎样排查？"))
      .resolves.toBe("professional");
    expect(() => completeJson.mock.calls[0]?.[0].schema.parse({
      scope: "professional",
      confidence: 0.9,
    })).toThrow();
  });

  it("keeps product context after all route repair attempts fail", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError();
    });
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route(
      "客户现场出现 HTTP 404，怎样排查？",
      "前面正在讨论 Coremail XT6 的部署和迁移。",
    )).resolves.toBe("professional");
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

  it.each([
    "目前客户信息不足，这种情况下我们的赢率如何？",
    "客户只说先测一测，怎样判断是真机会还是陪标？",
    "接触不到决策人，怎样建立决策链并找到内部支持者？",
    "客户在 POC 中不断要求免费增加非标项，售前怎样控制范围？",
    "客户一直盯着报价压价，怎么把话题转回业务价值？",
    "做邮件系统售前时，客户只说想优化但讲不清需求，该怎么继续追问？",
  ])("routes a product-neutral opportunity question to general: %s", async (question) => {
    const completeJson = vi.fn();
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;

    await expect(new ScopeRouter(model).route(
      question,
      "此前讨论过 Coremail 技术方案。",
    )).resolves.toBe("general");
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("injects the controlled PSEAgent self description into normal answers", () => {
    const messages = normalAnswerMessages("PSEAgent 的目标是什么？");
    expect(messages[0]?.content).toContain(PSEAGENT_SELF_CONTEXT);
    expect(messages[0]?.content).toContain("不得把 PSEAgent 解释为其他同名项目");
  });
});
