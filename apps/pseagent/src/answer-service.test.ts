import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "./answer-service.js";
import {
  AnswerService,
  PSE_ACTIVE_DEADLINE_MS,
  temporaryUnavailableResult,
} from "./answer-service.js";
import type { AnswerResult, HistoricalAnswer } from "./contracts.js";
import { HISTORICAL_ANSWER_WARNING } from "./contracts.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";
import { ScopeRouter } from "./router.js";

const knowledgePlan = {
  subject: "Coremail",
  requirements: [{ id: "R1" as const, question: "产品问题", queries: ["Coremail 产品问题"] }],
};

function createPlanner() {
  return { plan: vi.fn(async () => knowledgePlan) } satisfies KnowledgePlanner;
}

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
  const session = {
    project: "coremail-professional",
    schema: "专业库 schema",
    overview: "专业库用途",
  } as KnowledgeSession;
  const knowledge = { open: vi.fn(async () => session) };
  const planner = createPlanner();
  const runAgent = vi.fn<AgentRunner>(async () => primary);
  const service = new AnswerService({
    model,
    router,
    planner,
    knowledge,
    runAgent,
    historicalProvider,
  });
  return { service, planner, runAgent };
}

describe("AnswerService", () => {
  it("answers normal questions without opening either knowledge source", async () => {
    const model = {
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const router = { route: vi.fn(async () => "normal" as const) };
    const knowledge = { open: vi.fn() };
    const planner = createPlanner();
    const runAgent = vi.fn();
    const historicalProvider = {
      answer: vi.fn(async () => historicalAnswer),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const service = new AnswerService({
      model,
      router,
      planner,
      knowledge,
      runAgent,
      historicalProvider,
    });

    const noProviderExecution = await service.answerDetailed("普通问题");
    expect(noProviderExecution).toMatchObject({
      historicalAttempted: false,
      historicalUsed: false,
    });
    expect(noProviderExecution.result).toEqual({
      scope: "normal",
      status: "answered",
      answer: "普通回答",
      references: [],
    });
    expect(knowledge.open).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
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
    const planner = createPlanner();
    const runAgent = vi.fn();
    const service = new AnswerService({
      model,
      router: new ScopeRouter(model),
      planner,
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
    expect(planner.plan).not.toHaveBeenCalled();
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
      references: [formalReference],
    };
    const historicalProvider = {
      answer: vi.fn(async () => historicalAnswer),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const usedProviderExecution = await service.answerDetailed(
      "产品问题",
      "不应传递的对话上下文",
    );
    expect(usedProviderExecution).toMatchObject({
      historicalAttempted: true,
      historicalUsed: true,
    });
    expect(usedProviderExecution.result).toEqual({
      ...primary,
      historicalAnswer,
    });
    expect(historicalProvider.answer).toHaveBeenCalledOnce();
    expect(historicalProvider.answer).toHaveBeenCalledWith(
      "产品问题",
      expect.any(AbortSignal),
    );
  });

  it("plans a knowledge question before running the agent and passes the exact plan through", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "answered",
      answer: "正式回答",
      references: [formalReference],
    };
    const historicalProvider = {
      answer: vi.fn(async () => historicalAnswer),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service, planner, runAgent } = createProfessionalService(primary, historicalProvider);

    const before = Date.now();
    await expect(service.answer("产品问题", "有限上下文")).resolves.toBe(primary);
    const after = Date.now();
    expect(planner.plan).toHaveBeenCalledWith(expect.objectContaining({
      scope: "professional",
      question: "产品问题",
      conversationContext: "有限上下文",
      schema: "专业库 schema",
      overview: "专业库用途",
      signal: expect.any(AbortSignal),
    }));
    expect(runAgent.mock.calls[0]?.[0].plan).toEqual(knowledgePlan);
    expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeGreaterThanOrEqual(
      before + PSE_ACTIVE_DEADLINE_MS,
    );
    expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeLessThanOrEqual(
      after + PSE_ACTIVE_DEADLINE_MS,
    );
    expect(runAgent.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(planner.plan.mock.invocationCallOrder[0]).toBeLessThan(
      runAgent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("returns temporarily unavailable without running the agent when planning fails", async () => {
    const model = {} as ModelClient;
    const runAgent = vi.fn<AgentRunner>();
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: {
        plan: vi.fn(async () => {
          throw new Error("invalid plan after repair");
        }),
      },
      knowledge: {
        open: vi.fn(async () => ({
          schema: "专业库 schema",
          overview: "专业库用途",
        }) as KnowledgeSession),
      },
      runAgent,
    });

    await expect(service.answer("产品问题")).resolves.toMatchObject({
      scope: "professional",
      status: "temporarily_unavailable",
      references: [],
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("records and safely degrades an invalid knowledge plan payload", async () => {
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "invalid-plan",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const runAgent = vi.fn<AgentRunner>();
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: {
        plan: vi.fn(async () => {
          throw new InvalidModelPayloadError(
            "invalid_json",
            "{\"subject\":",
            "pse_knowledge_plan",
            "abort",
          );
        }),
      },
      diagnostics: { start: () => trace },
      knowledge: {
        open: vi.fn(async () => ({
          schema: "专业库 schema",
          overview: "专业库用途",
        }) as KnowledgeSession),
      },
      runAgent,
    });

    await expect(service.answerDetailed("产品问题")).resolves.toMatchObject({
      retryable: false,
      stopReason: "final",
      result: {
        scope: "professional",
        status: "not_covered",
        references: [],
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "model_payload",
      reason: "invalid_json",
      rawPayload: "{\"subject\":",
      rawPayloadLength: 11,
      schemaDescription: "pse_knowledge_plan",
      finishReason: "abort",
    }));
    expect(events).toContainEqual({
      event: "fallback",
      reason: "invalid_model_payload",
      outcome: "not_covered",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("records route, plan, and a content-free finish summary when diagnostics are enabled", async () => {
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "request-1",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      diagnostics: { start: () => trace },
      knowledge: {
        open: vi.fn(async () => ({
          schema: "专业库 schema",
          overview: "专业库用途",
        }) as KnowledgeSession),
      },
      runAgent: vi.fn<AgentRunner>(async (input) => {
        return {
          scope: "professional",
          status: "answered",
          answer: "不应写入诊断的完整回答",
          references: [formalReference],
        };
      }),
    });

    await service.answer("不应直接写入诊断的完整问题");

    expect(events.map((event) => event.event)).toEqual(["route", "plan", "finish"]);
    expect(events[1]).toMatchObject({ event: "plan", subject: "Coremail" });
    expect(events[2]).toMatchObject({
      event: "finish",
      scope: "professional",
      status: "answered",
      citationCount: 1,
      historicalAttempted: false,
      historicalUsed: false,
    });
    expect(JSON.stringify(events)).not.toContain("不应写入诊断的完整回答");
    expect(JSON.stringify(events)).not.toContain("不应直接写入诊断的完整问题");
  });

  it("records an attempted but unused historical lookup when the provider has no answer", async () => {
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

    const emptyProviderExecution = await service.answerDetailed("产品问题");

    expect(emptyProviderExecution).toMatchObject({
      historicalAttempted: true,
      historicalUsed: false,
    });
    expect(emptyProviderExecution.result).toBe(primary);
  });

  it("records an attempted but unused historical lookup when the provider fails", async () => {
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

    const failedProviderExecution = await service.answerDetailed("产品问题");

    expect(failedProviderExecution).toMatchObject({
      historicalAttempted: true,
      historicalUsed: false,
    });
    expect(failedProviderExecution.result).toBe(primary);
  });

  it("marks model unavailability as retryable without changing the public answer", async () => {
    const model = {
      completeText: vi.fn(async () => {
        throw new ModelUnavailableError("model_unavailable_503");
      }),
    } as unknown as ModelClient;
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => "normal" as const) },
      planner: createPlanner(),
      knowledge: { open: vi.fn() },
      runAgent: vi.fn(),
    });

    await expect(service.answerDetailed("普通问题")).resolves.toMatchObject({
      retryable: true,
      stopReason: "model_unavailable",
      result: { status: "temporarily_unavailable" },
    });
    await expect(service.answer("普通问题")).resolves.toEqual({
      scope: "normal",
      status: "temporarily_unavailable",
      answer: "问答服务暂时不可用，请稍后重试。",
      references: [],
    });
  });

  it("does not retry a stable invalid model payload", async () => {
    const model = {
      completeText: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_schema");
      }),
    } as unknown as ModelClient;
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => "normal" as const) },
      planner: createPlanner(),
      knowledge: { open: vi.fn() },
      runAgent: vi.fn(),
    });

    await expect(service.answerDetailed("普通问题")).resolves.toMatchObject({
      retryable: false,
      stopReason: "invalid_model_payload",
      result: { status: "temporarily_unavailable" },
    });
  });

  it.each([
    ["model_unavailable", true],
    ["seed_unavailable", true],
    ["invalid_model_payload", false],
    ["invalid_final", false],
    ["turn_budget_exhausted", false],
    ["coverage_verifier_unavailable", true],
    ["coverage_verifier_invalid", false],
  ] as const)(
    "maps agent stop %s to retryable=%s",
    async (reason, retryable) => {
      const service = new AnswerService({
        model: {} as ModelClient,
        router: { route: vi.fn(async () => "professional" as const) },
        planner: createPlanner(),
        knowledge: {
          open: vi.fn(async () => ({
            project: "coremail-professional",
            schema: "专业库 schema",
            overview: "专业库用途",
          }) as KnowledgeSession),
        },
        runAgent: vi.fn<AgentRunner>(async (input) => {
          input.trace.record({ event: "stop", reason });
          return temporaryUnavailableResult("professional");
        }),
      });

      await expect(service.answerDetailed("产品问题")).resolves.toMatchObject({
        retryable,
        stopReason: reason,
        result: { status: "temporarily_unavailable" },
      });
    },
  );
});
