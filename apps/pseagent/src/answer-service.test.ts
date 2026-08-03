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
import type { TaskAnalysisShadow } from "./task-analysis-shadow.js";
import { taskSpecSchema } from "./task-spec.js";

const knowledgePlan = {
  subject: "Coremail",
  requirements: [{
    id: "R1" as const,
    question: "产品问题",
    evidenceAspects: [{
      id: "A1" as const,
      label: "产品证据",
      terms: ["Coremail", "产品"],
    }],
    queries: [{
      text: "Coremail 产品问题",
      aspectIds: ["A1" as const],
    }],
    evidenceMode: "direct_only" as const,
  }],
};

function createPlanner() {
  return { plan: vi.fn(async () => knowledgePlan) } satisfies KnowledgePlanner;
}

function createKnowledgeSessionFixture(): KnowledgeSession {
  return {
    project: "coremail-professional",
    revision: "a".repeat(40),
    purpose: "专业库用途",
    schema: "专业库 schema",
    planningOverview: "专业库 overview",
    planningOverviewMeta: {
      status: "ready",
      contentHash: "b".repeat(64),
      rendererVersion: "planning-overview-v1",
      originalChars: 14,
      exposedChars: 14,
      truncated: false,
    },
  } as unknown as KnowledgeSession;
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
const displayedHistoricalLookup = {
  outcome: "display" as const,
  answer: historicalAnswer,
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
  const session = createKnowledgeSessionFixture();
  const knowledge = { open: vi.fn(async () => session) };
  const planner = createPlanner();
  const runAgent = vi.fn<AgentRunner>(async (input) => {
    if (primary.status !== "temporarily_unavailable") {
      const coverage = primary.status === "answered"
        ? "complete"
        : primary.status === "partially_answered"
          ? "partial"
          : "none";
      const citations = primary.references.map((reference) => reference.index);
      input.trace.record({
        event: "coverage",
        stage: "draft",
        requirements: [{
          id: "R1",
          evidenceMode: "direct_only",
          coverage,
          citations,
        }],
        citations,
        stopReason: "final",
      });
      input.trace.record({
        event: "coverage",
        stage: "verified",
        requirements: [{
          id: "R1",
          evidenceMode: "direct_only",
          coverage,
          citations,
          retainedDirectSegmentCount: coverage === "none" ? 0 : 1,
          retainedSynthesizedSegmentCount: 0,
          removedSegmentCount: 0,
        }],
        citations,
        stopReason: "final",
      });
    }
    return primary;
  });
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
  it("observes TaskSpec shadow analysis without changing the legacy answer path", async () => {
    const events: DiagnosticEvent[] = [];
    const rawQuestion = "还有华为呢？";
    const rawContext = "用户：比较客户多节点方案";
    const shadow = {
      analyze: vi.fn(async () => ({
        resolvedQuestion: {
          rawQuestion,
          standaloneQuestion: "华为有哪些多节点方案？",
          contextUsed: true,
          inheritedSubjects: ["多节点方案"],
          corrections: [],
        },
        taskSpec: taskSpecSchema.parse({
          subject: "华为多节点方案",
          entities: [{ id: "E1", label: "华为", role: "reference", sourceText: "华为" }],
          deliverables: [{
            id: "D1",
            label: "华为多节点方案",
            kind: "fact",
            required: true,
            sourceText: "华为有哪些多节点方案",
            obligations: [{
              id: "O1",
              label: "华为多节点方案",
              targetEntityIds: ["E1"],
              evidencePolicy: "direct",
              domains: ["coremail-professional"],
              required: true,
              sourceText: "华为",
            }],
          }],
        }),
        guard: {
          ok: true,
          issues: [],
          explicitEntityCount: 1,
          mappedExplicitEntityCount: 1,
          explicitRequestCount: 1,
          mappedExplicitRequestCount: 1,
        },
        elapsedMs: 10,
      })),
    } satisfies TaskAnalysisShadow;
    const runAgent = vi.fn<AgentRunner>(async () => ({
      scope: "professional",
      status: "answered",
      answer: "旧链路回答",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      diagnostics: {
        start: () => ({
          requestId: "task-shadow",
          record(event) { events.push(event); },
        }),
      },
      knowledge: { open: vi.fn(async () => createKnowledgeSessionFixture()) },
      runAgent,
      taskAnalysisShadow: shadow,
      taskSpecShadowTimeoutMs: 5_000,
    });

    await expect(service.answer(rawQuestion, rawContext)).resolves.toMatchObject({
      answer: "旧链路回答",
    });
    expect(shadow.analyze).toHaveBeenCalledWith(expect.objectContaining({
      question: rawQuestion,
      conversationContext: rawContext,
      legacyPlan: knowledgePlan,
    }));
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      question: rawQuestion,
      conversationContext: rawContext,
      plan: knowledgePlan,
    }));
    expect(events.map((event) => event.event)).toEqual([
      "route",
      "plan",
      "question_resolution",
      "task_spec",
      "task_spec_guard",
      "task_spec_shadow",
      "finish",
    ]);
    expect(JSON.stringify(events)).not.toContain("华为");
  });

  it("keeps answering when optional TaskSpec shadow analysis fails", async () => {
    const shadow = {
      analyze: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_task_spec");
      }),
    } satisfies TaskAnalysisShadow;
    const runAgent = vi.fn<AgentRunner>(async () => ({
      scope: "professional",
      status: "answered",
      answer: "主链回答",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      knowledge: { open: vi.fn(async () => createKnowledgeSessionFixture()) },
      runAgent,
      taskAnalysisShadow: shadow,
    });

    await expect(service.answer("Coremail 问题")).resolves.toMatchObject({
      status: "answered",
      answer: "主链回答",
    });
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("answers normal questions without opening either knowledge source", async () => {
    const model = {
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const router = { route: vi.fn(async () => "normal" as const) };
    const knowledge = { open: vi.fn() };
    const planner = createPlanner();
    const runAgent = vi.fn();
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
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
    expect(noProviderExecution).not.toHaveProperty("draftCoverage");
    expect(noProviderExecution).not.toHaveProperty("verifiedCoverage");
    expect(noProviderExecution).not.toHaveProperty("historicalGateReason");
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
        answer: vi.fn(async () => displayedHistoricalLookup),
        close: vi.fn(async () => undefined),
      } satisfies HistoricalAnswerProvider;
      const { service } = createProfessionalService(primary, historicalProvider);

      await expect(service.answer("Coremail 产品问题")).resolves.toBe(primary);
      expect(historicalProvider.answer).not.toHaveBeenCalled();
    },
  );

  it("exposes verified formal-support counts without evaluating the historical gate", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "answered",
      answer: "正式回答",
      references: [formalReference],
    };
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const execution = await service.answerDetailed("Coremail 产品问题");

    expect(execution).toMatchObject({
      draftCoverage: ["complete"],
      verifiedCoverage: ["complete"],
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 0,
      historicalAttempted: false,
      historicalUsed: false,
    });
    expect(execution).not.toHaveProperty("historicalGateReason");
  });

  it.each([
    {
      evidenceMode: "direct_only",
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 0,
    },
    {
      evidenceMode: "synthesis_allowed",
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 2,
    },
  ] as const)(
    "blocks history with formal support from $evidenceMode evidence",
    async ({
      evidenceMode,
      retainedDirectSegmentCount,
      retainedSynthesizedSegmentCount,
    }) => {
      const events: DiagnosticEvent[] = [];
      const historicalProvider = {
        answer: vi.fn(async () => displayedHistoricalLookup),
        close: vi.fn(async () => undefined),
      } satisfies HistoricalAnswerProvider;
      const service = new AnswerService({
        model: {} as ModelClient,
        router: { route: vi.fn(async () => "professional" as const) },
        planner: {
          plan: vi.fn(async () => ({
            subject: knowledgePlan.subject,
            requirements: [{
              id: "R1" as const,
              question: "产品问题",
              evidenceAspects: [{
                id: "A1" as const,
                label: "产品证据",
                terms: ["Coremail", "产品"],
              }],
              queries: [{
                text: "Coremail 产品问题",
                aspectIds: ["A1" as const],
              }],
              evidenceMode,
            }],
          })),
        },
        diagnostics: {
          start: () => ({
            requestId: `formal-support-${evidenceMode}`,
            record(event: DiagnosticEvent) {
              events.push(event);
            },
          }),
        },
        knowledge: {
          open: vi.fn(async () => createKnowledgeSessionFixture()),
        },
        runAgent: vi.fn<AgentRunner>(async (input) => {
          input.trace.record({
            event: "coverage",
            stage: "verified",
            requirements: [{
              id: "R1",
              evidenceMode,
              coverage: "complete",
              citations: [1],
              retainedDirectSegmentCount,
              retainedSynthesizedSegmentCount,
              removedSegmentCount: 0,
            }],
            reasons: [{
              id: "R1",
              reason: retainedSynthesizedSegmentCount > 0
                ? "synthesized_support"
                : "direct_support",
            }],
            citations: [1],
            stopReason: "final",
          });
          return {
            scope: "professional",
            status: "not_covered",
            answer: "防御性测试：结果状态与正式支持不一致",
            references: [],
          };
        }),
        historicalProvider,
      });

      const execution = await service.answerDetailed("Coremail 产品问题");

      expect(execution).toMatchObject({
        verifiedCoverage: ["complete"],
        retainedDirectSegmentCount,
        retainedSynthesizedSegmentCount,
        removedSegmentCount: 0,
        historicalGateReason: "formal_support_present",
        historicalAttempted: false,
        historicalUsed: false,
      });
      expect(historicalProvider.answer).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain(
        "direct_formal_evidence_present",
      );
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
      answer: vi.fn(async () => displayedHistoricalLookup),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const usedProviderExecution = await service.answerDetailed(
      "Coremail 产品问题",
      "不应传递的对话上下文",
    );
    expect(usedProviderExecution).toMatchObject({
      draftCoverage: ["none"],
      verifiedCoverage: ["none"],
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 0,
      historicalGateReason: "eligible",
      historicalAttempted: true,
      historicalUsed: true,
    });
    expect(usedProviderExecution.result).toEqual({
      ...primary,
      historicalAnswer,
    });
    expect(historicalProvider.answer).toHaveBeenCalledOnce();
    expect(historicalProvider.answer).toHaveBeenCalledWith(
      "Coremail 产品问题",
      expect.any(AbortSignal),
    );
  });

  it("attaches a notice instead of historical content when the completed lookup is hidden", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => ({
        outcome: "hidden" as const,
        reason: "topic_mismatch" as const,
      })),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const execution = await service.answerDetailed(
      "Coremail 与未知系统的差异",
    );

    expect(execution).toMatchObject({
      historicalAttempted: true,
      historicalUsed: false,
      historicalNoticeShown: true,
      historicalRejectedReason: "topic_mismatch",
      result: {
        ...primary,
        historicalNotice: {
          provider: "coremail_mcp",
          searched: true,
          displayed: false,
          reason: "topic_mismatch",
        },
      },
    });
    expect(execution.result).not.toHaveProperty("historicalAnswer");
  });

  it("does not use Coremail MCP for a generic mail-system question", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      knowledge: {
        open: vi.fn(async () => createKnowledgeSessionFixture()),
      },
      runAgent: vi.fn<AgentRunner>(async (input) => {
        input.trace.record({
          event: "coverage",
          stage: "verified",
          requirements: [{
            id: "R1",
            evidenceMode: "direct_only",
            coverage: "none",
            citations: [],
            retainedDirectSegmentCount: 0,
            retainedSynthesizedSegmentCount: 0,
            removedSegmentCount: 0,
          }],
          reasons: [{ id: "R1", reason: "target_omitted" }],
          citations: [],
          stopReason: "final",
        });
        return primary;
      }),
      historicalProvider,
    });

    const execution = await service.answerDetailed("推荐一份邮件系统的 POC 方案给我");

    expect(execution).toMatchObject({
      historicalGateReason: "question_not_explicit_coremail",
      historicalAttempted: false,
      historicalUsed: false,
      result: { status: "not_covered" },
    });
    expect(historicalProvider.answer).not.toHaveBeenCalled();
  });

  it("returns structural failures as unavailable without using Coremail MCP", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "temporarily_unavailable",
      answer: "知识问答服务暂时不可用，请稍后重试。",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      knowledge: {
        open: vi.fn(async () => createKnowledgeSessionFixture()),
      },
      runAgent: vi.fn<AgentRunner>(async (input) => {
        input.trace.record({
          event: "fallback",
          reason: "invalid_model_payload",
          outcome: "temporarily_unavailable",
        });
        input.trace.record({ event: "stop", reason: "invalid_model_payload" });
        return primary;
      }),
      historicalProvider,
    });

    const execution = await service.answerDetailed("Coremail 有哪些能力？");

    expect(execution).toMatchObject({
      retryable: true,
      stopReason: "invalid_model_payload",
      historicalAttempted: false,
      historicalUsed: false,
      result: { status: "temporarily_unavailable" },
    });
    expect(execution).not.toHaveProperty("historicalGateReason");
    expect(historicalProvider.answer).not.toHaveBeenCalled();
  });

  it("does not use Coremail MCP before formal coverage verification completes", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖",
      references: [],
    };
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      knowledge: {
        open: vi.fn(async () => createKnowledgeSessionFixture()),
      },
      runAgent: vi.fn<AgentRunner>(async () => primary),
      historicalProvider,
    });

    const execution = await service.answerDetailed("Coremail 有哪些能力？");

    expect(execution).toMatchObject({
      historicalGateReason: "formal_verification_incomplete",
      historicalAttempted: false,
      historicalUsed: false,
      result: { status: "not_covered" },
    });
    expect(historicalProvider.answer).not.toHaveBeenCalled();
  });

  it("plans a knowledge question before running the agent and passes the exact plan through", async () => {
    const primary: AnswerResult = {
      scope: "professional",
      status: "answered",
      answer: "正式回答",
      references: [formalReference],
    };
    const historicalProvider = {
      answer: vi.fn(async () => displayedHistoricalLookup),
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
      purpose: "专业库用途",
      schema: "专业库 schema",
      planningOverview: "专业库 overview",
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

  it("uses injected request and active deadline budgets", async () => {
    const requestTimeoutMs = 570_000;
    const activeDeadlineMs = 540_000;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const runAgent = vi.fn<AgentRunner>(async () => ({
      scope: "professional",
      status: "not_covered",
      answer: "未覆盖",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as ModelClient,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: createPlanner(),
      knowledge: {
        open: vi.fn(async () => createKnowledgeSessionFixture()),
      },
      runAgent,
      requestTimeoutMs,
      activeDeadlineMs,
    });

    try {
      const before = Date.now();
      await service.answer("产品问题");
      const after = Date.now();

      expect(timeout).toHaveBeenCalledWith(requestTimeoutMs);
      expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeGreaterThanOrEqual(
        before + activeDeadlineMs,
      );
      expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeLessThanOrEqual(
        after + activeDeadlineMs,
      );
    } finally {
      timeout.mockRestore();
    }
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
        open: vi.fn(async () => createKnowledgeSessionFixture()),
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
        open: vi.fn(async () => createKnowledgeSessionFixture()),
      },
      runAgent,
    });

    await expect(service.answerDetailed("产品问题")).resolves.toMatchObject({
      retryable: true,
      stopReason: "invalid_model_payload",
      result: {
        scope: "professional",
        status: "temporarily_unavailable",
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
      outcome: "temporarily_unavailable",
    });
    expect(events).toContainEqual({
      event: "stop",
      reason: "invalid_model_payload",
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
        open: vi.fn(async () => createKnowledgeSessionFixture()),
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
    expect(events[1]).toMatchObject({
      event: "plan",
      requirementCount: 1,
      aspectCount: 1,
      queryCount: 1,
      directOnlyCount: 1,
      synthesisAllowedCount: 0,
    });
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
      answer: vi.fn(async () => ({ outcome: "unavailable" as const })),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const emptyProviderExecution = await service.answerDetailed("Coremail 产品问题");

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
      answer: vi.fn(async () => {
        throw new Error("historical provider failed");
      }),
      close: vi.fn(async () => undefined),
    } satisfies HistoricalAnswerProvider;
    const { service } = createProfessionalService(primary, historicalProvider);

    const failedProviderExecution = await service.answerDetailed("Coremail 产品问题");

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

  it("marks an invalid model payload as retryable", async () => {
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
      retryable: true,
      stopReason: "invalid_model_payload",
      result: { status: "temporarily_unavailable" },
    });
  });

  it.each([
    ["model_unavailable", true],
    ["seed_unavailable", true],
    ["invalid_model_payload", true],
    ["invalid_final", true],
    ["turn_budget_exhausted", false],
    ["evidence_review_unavailable", true],
    ["coverage_verifier_unavailable", true],
    ["coverage_verifier_invalid", true],
  ] as const)(
    "maps agent stop %s to retryable=%s",
    async (reason, retryable) => {
      const service = new AnswerService({
        model: {} as ModelClient,
        router: { route: vi.fn(async () => "professional" as const) },
        planner: createPlanner(),
        knowledge: {
          open: vi.fn(async () => createKnowledgeSessionFixture()),
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
