import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "./answer-service.js";
import { AnswerService } from "./answer-service.js";
import type { AnswerResult, HistoricalAnswer } from "./contracts.js";
import { HISTORICAL_ANSWER_WARNING } from "./contracts.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { ModelClient } from "./model-client.js";
import { ScopeRouter } from "./router.js";

const historicalAnswer: HistoricalAnswer = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "medium",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史资料回答",
  references: [{
    sourceType: "jira",
    key: "PSE-123",
    title: "历史方案",
  }],
};

const formalReference = {
  index: 1,
  project: "coremail-professional" as const,
  title: "正式知识",
  path: "products/formal.md",
  revision: "rev-1",
  contentHash: "a".repeat(64),
};

function createProfessionalService(
  primary: AnswerResult,
  historicalProvider: HistoricalAnswerProvider,
) {
  const model = {} as ModelClient;
  const router = { route: vi.fn(async () => "professional" as const) };
  const session = { project: "coremail-professional" } as KnowledgeSession;
  const knowledge = { open: vi.fn(async () => session) };
  const runAgent = vi.fn<AgentRunner>(async () => primary);
  const service = new AnswerService({
    model,
    router,
    knowledge,
    runAgent,
    historicalProvider,
  });
  return { service, runAgent };
}

describe("AnswerService", () => {
  it("answers normal questions without opening either knowledge source", async () => {
    const model = {
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const router = { route: vi.fn(async () => "normal" as const) };
    const knowledge = { open: vi.fn() };
    const runAgent = vi.fn();
    const historicalProvider = {
      answer: vi.fn(async () => historicalAnswer),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const service = new AnswerService({
      model,
      router,
      knowledge,
      runAgent,
      historicalProvider,
    });

    await expect(service.answer("普通问题")).resolves.toEqual({
      scope: "normal",
      status: "answered",
      answer: "普通回答",
      references: [],
    });
    expect(knowledge.open).not.toHaveBeenCalled();
    expect(historicalProvider.answer).not.toHaveBeenCalled();
  });

  it("answers PSEAgent architecture as normal even when Coremail dominates history", async () => {
    const completeJson = vi.fn();
    const model = {
      completeJson,
      completeText: vi.fn(async (input: { messages: { content: string }[] }) => {
        expect(input.messages[0]?.content).toContain("PSEAgent 是 Coremail 售前问答统一入口");
        return "PSEAgent 负责路由、知识检索和引用；Lunkr 只负责消息收发。";
      }),
    } as unknown as ModelClient;
    const knowledge = { open: vi.fn() };
    const runAgent = vi.fn();
    const service = new AnswerService({
      model,
      router: new ScopeRouter(model),
      knowledge,
      runAgent,
    });

    await expect(service.answer(
      "请介绍一下 PSEAgent 项目的目标和整体架构",
      "前面讨论了 Coremail AI、十万用户部署、Domino 迁移和安全网关。",
    )).resolves.toEqual({
      scope: "normal",
      status: "answered",
      answer: "PSEAgent 负责路由、知识检索和引用；Lunkr 只负责消息收发。",
      references: [],
    });
    expect(completeJson).not.toHaveBeenCalled();
    expect(knowledge.open).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([
    {
      scope: "professional",
      status: "answered",
      answer: "正式回答",
      references: [formalReference],
    },
    {
      scope: "professional",
      status: "partially_answered",
      answer: "部分正式回答",
      references: [formalReference],
    },
    {
      scope: "professional",
      status: "temporarily_unavailable",
      answer: "知识问答服务暂时不可用，请稍后重试。",
      references: [],
    },
  ] satisfies AnswerResult[])(
    "does not use historical material when the formal result is $status",
    async (primary) => {
      const historicalProvider = {
        answer: vi.fn(async () => historicalAnswer),
        close: vi.fn(async () => undefined),
      } satisfies HistoricalAnswerProvider;
      const { service } = createProfessionalService(primary, historicalProvider);

      await expect(service.answer("产品问题")).resolves.toBe(primary);
      expect(historicalProvider.answer).not.toHaveBeenCalled();
    },
  );

  it("adds a separate historical answer only when formal knowledge is not covered", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => historicalAnswer),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    await expect(service.answer("产品问题", "不应传递的对话上下文")).resolves.toEqual({
      ...primary,
      historicalAnswer,
    });
    expect(historicalProvider.answer).toHaveBeenCalledOnce();
    expect(historicalProvider.answer).toHaveBeenCalledWith("产品问题", undefined);
  });

  it("keeps the exact formal result when the historical provider has no answer", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    await expect(service.answer("产品问题")).resolves.toBe(primary);
  });

  it("keeps the exact formal result when the historical provider fails", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async (): Promise<HistoricalAnswer | undefined> => {
        throw new Error("historical provider failed");
      }),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    await expect(service.answer("产品问题")).resolves.toBe(primary);
  });
});
