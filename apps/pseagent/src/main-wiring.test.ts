import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRunner, DetailedAgentRunner } from "./answer-service.js";
import type { AnswerResult } from "./contracts.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { KnowledgeToolCaller } from "./knowledge-tool-caller.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import type { ModelClient, ModelRoleClients } from "./model-client.js";
import { createPseAgentRuntime } from "./main.js";
import type { TaskAnalysisShadow } from "./task-analysis-shadow.js";
import { taskSpecSchema } from "./task-spec.js";
import type { AnswerCardMatcher } from "./answer-card-matcher.js";

const configEnv = {
  PSE_MODEL_BASE_URL: "https://model.example.test/v1",
  PSE_MODEL_API_KEY: "test-key",
  PSE_MODEL_NAME: "main-model",
  PSE_MODEL_TIMEOUT_MS: "60000",
  PSE_REQUEST_TIMEOUT_MS: "570000",
  PSE_ACTIVE_DEADLINE_MS: "540000",
  KNOWLEDGE_MCP_COMMAND: "node",
  KNOWLEDGE_MCP_ENTRY_PATH: process.execPath,
};

const enabledConfigEnv = {
  ...configEnv,
  COREMAIL_MCP_ENABLED: "true",
  COREMAIL_MCP_COMMAND: "node",
  COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
  COREMAIL_MCP_TIMEOUT_MS: "30000",
};

const plan = {
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

describe("main wiring", () => {
  it("applies the configured scheduler when all model roles share one model", async () => {
    let releaseFetch!: () => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      notifyFetchStarted();
      await fetchGate;
      return new Response(JSON.stringify({
        choices: [{
          message: { content: "normal answer" },
          finish_reason: "stop",
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const server = { close: vi.fn(async () => undefined) } as unknown as McpServer;
    const runtime = await createPseAgentRuntime({
      ...configEnv,
      PSE_MODEL_MAX_CONCURRENCY: "1",
      PSE_MODEL_MAX_QUEUE: "0",
      PSE_MODEL_QUEUE_TIMEOUT_MS: "1000",
    }, {
      createRouter: () => ({ route: vi.fn(async () => "normal" as const) }),
      createKnowledgePlanner: () => ({ plan: vi.fn(async () => plan) }),
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => ({ open: vi.fn() }),
      createServer: () => server,
    });

    try {
      const first = runtime.answer("hello");
      await fetchStarted;
      const second = await Promise.race([
        runtime.answer("hello again"),
        new Promise<"scheduler_timeout">((resolve) => {
          setTimeout(() => resolve("scheduler_timeout"), 100);
        }),
      ]);
      expect(second).not.toBe("scheduler_timeout");
      expect(second).toMatchObject({ status: "temporarily_unavailable" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      releaseFetch();
      await expect(first).resolves.toMatchObject({
        scope: "normal",
        status: "answered",
        answer: "normal answer",
      });
    } finally {
      releaseFetch();
      await runtime.close();
      fetchSpy.mockRestore();
    }
  });

  it("uses one model for routing, planning, normal answers, and the knowledge agent", async () => {
    const model = {
      completeJson: vi.fn(),
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const createModel = vi.fn(() => model);
    const router = { route: vi.fn(async (question: string) => question === "普通问题" ? "normal" as const : "professional" as const) };
    const createRouter = vi.fn((received: ModelClient) => {
      expect(received).toBe(model);
      return router;
    });
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const session = { project: "coremail-professional" } as KnowledgeSession;
    const knowledge = { open: vi.fn(async () => session) };
    const planner = { plan: vi.fn(async () => plan) } satisfies KnowledgePlanner;
    const createKnowledgePlanner = vi.fn((received: ModelClient) => {
      expect(received).toBe(model);
      return planner;
    });
    const agentResult: AnswerResult = {
      scope: "professional", status: "not_covered", answer: "未覆盖", references: [],
    };
    const runAgent = vi.fn<AgentRunner>(async (input) => {
      input.trace.record({
        event: "coverage",
        stage: "draft",
        requirements: [{
          id: "R1",
          evidenceMode: "direct_only",
          coverage: "none",
          citations: [],
        }],
        citations: [],
        stopReason: "final",
      });
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
          removedSegmentCount: 1,
        }],
        citations: [],
        stopReason: "final",
      });
      return agentResult;
    });
    const closeServer = vi.fn(async () => undefined);
    const server = { close: closeServer } as unknown as McpServer;
    const createHistoricalProvider = vi.fn();

    const runtime = await createPseAgentRuntime(configEnv, {
      createModel,
      createRouter,
      createKnowledgePlanner,
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => knowledge,
      runAgent,
      createServer: () => server,
      createHistoricalProvider,
    });

    await expect(runtime.answer("普通问题")).resolves.toMatchObject({ scope: "normal", answer: "普通回答" });
    const beforeProductAnswer = Date.now();
    const productExecution = await runtime.answerDetailed("产品问题");
    const afterProductAnswer = Date.now();
    expect(productExecution).toMatchObject({
      result: agentResult,
      draftCoverage: ["none"],
      verifiedCoverage: ["none"],
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 1,
    });
    expect(productExecution).not.toHaveProperty("historicalGateReason");
    const normalExecution = await runtime.answerDetailed("普通问题");
    expect(normalExecution).toMatchObject({
      retryable: false,
      stopReason: "final",
      result: { scope: "normal", answer: "普通回答" },
    });
    expect(normalExecution).not.toHaveProperty("draftCoverage");
    expect(normalExecution).not.toHaveProperty("verifiedCoverage");
    expect(normalExecution).not.toHaveProperty("historicalGateReason");
    expect(createModel).toHaveBeenCalledOnce();
    expect(createKnowledgePlanner).toHaveBeenCalledOnce();
    expect(model.completeText).toHaveBeenCalledTimes(2);
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].plan).toEqual(plan);
    expect(runAgent.mock.calls[0]?.[0].model).toBe(model);
    expect(runAgent.mock.calls[0]?.[0].verifierModel).toBe(model);
    expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeGreaterThanOrEqual(
      beforeProductAnswer + 540_000,
    );
    expect(runAgent.mock.calls[0]?.[0].deadlineAt).toBeLessThanOrEqual(
      afterProductAnswer + 540_000,
    );
    expect(caller.connect).toHaveBeenCalledOnce();
    expect(createHistoricalProvider).not.toHaveBeenCalled();

    await runtime.close();
    await runtime.close();
    expect(caller.close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("wires resolver, planner, synthesizer, and verifier as independent roles", async () => {
    const roleModel = (): ModelClient => ({
      completeJson: vi.fn(),
      completeText: vi.fn(async () => "普通回答"),
    });
    const models: ModelRoleClients = {
      resolver: roleModel(),
      planner: roleModel(),
      synthesizer: roleModel(),
      verifier: roleModel(),
    };
    const createModelRoles = vi.fn(() => models);
    const createRouter = vi.fn((received: ModelClient) => {
      expect(received).toBe(models.resolver);
      return { route: vi.fn(async () => "professional" as const) };
    });
    const planner = { plan: vi.fn(async () => plan) } satisfies KnowledgePlanner;
    const createKnowledgePlanner = vi.fn((received: ModelClient) => {
      expect(received).toBe(models.planner);
      return planner;
    });
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const runAgent = vi.fn<AgentRunner>(async () => ({
      scope: "professional",
      status: "answered",
      answer: "角色隔离回答",
      references: [],
    }));
    const server = { close: vi.fn(async () => undefined) } as unknown as McpServer;

    const runtime = await createPseAgentRuntime(configEnv, {
      createModelRoles,
      createRouter,
      createKnowledgePlanner,
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => ({
        open: vi.fn(async () => ({ project: "coremail-professional" } as KnowledgeSession)),
      }),
      runAgent,
      createServer: () => server,
    });
    await runtime.answer("产品问题");

    expect(createModelRoles).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: models.synthesizer,
      verifierModel: models.verifier,
    }));
    await runtime.close();
  });

  it("constructs the optional TaskSpec shadow only when explicitly enabled", async () => {
    const model = {
      completeJson: vi.fn(),
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const server = {
      close: vi.fn(async () => undefined),
    } as unknown as McpServer;
    const analyzer = {
      analyze: vi.fn(),
    } as unknown as TaskAnalysisShadow;
    const createTaskAnalysisShadow = vi.fn(() => analyzer);

    const disabledRuntime = await createPseAgentRuntime(configEnv, {
      createModel: () => model,
      createRouter: () => ({ route: vi.fn(async () => "normal" as const) }),
      createKnowledgePlanner: () => ({ plan: vi.fn(async () => plan) }),
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => ({ open: vi.fn() }),
      runAgent: vi.fn(),
      createServer: () => server,
      createTaskAnalysisShadow,
    });
    expect(createTaskAnalysisShadow).not.toHaveBeenCalled();
    await disabledRuntime.close();

    const enabledCaller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const enabledServer = {
      close: vi.fn(async () => undefined),
    } as unknown as McpServer;
    const enabledRuntime = await createPseAgentRuntime({
      ...configEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
    }, {
      createModel: () => model,
      createRouter: () => ({ route: vi.fn(async () => "normal" as const) }),
      createKnowledgePlanner: () => ({ plan: vi.fn(async () => plan) }),
      createKnowledgeCaller: () => enabledCaller,
      createKnowledgeSessionFactory: () => ({ open: vi.fn() }),
      runAgent: vi.fn(),
      createServer: () => enabledServer,
      createTaskAnalysisShadow,
    });
    expect(createTaskAnalysisShadow).toHaveBeenCalledOnce();
    expect(createTaskAnalysisShadow).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        taskSpecShadow: { enabled: true, timeoutMs: 60_000 },
        taskSpecActiveEnabled: true,
      }),
    );
    await enabledRuntime.close();
  });

  it("constructs the answer-card matcher only for an explicit shadow catalog", async () => {
    const model = {
      completeJson: vi.fn(),
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const createAnswerCardMatcher = vi.fn(() => ({
      match: vi.fn(),
    }) as unknown as AnswerCardMatcher);
    const runtimeDependencies = () => {
      const caller = {
        connect: vi.fn(async () => undefined),
        call: vi.fn(),
        close: vi.fn(async () => undefined),
      } satisfies KnowledgeToolCaller;
      return {
        createModel: () => model,
        createRouter: () => ({ route: vi.fn(async () => "normal" as const) }),
        createKnowledgePlanner: () => ({ plan: vi.fn(async () => plan) }),
        createKnowledgeCaller: () => caller,
        createKnowledgeSessionFactory: () => ({ open: vi.fn() }),
        runAgent: vi.fn(),
        createServer: () => ({
          close: vi.fn(async () => undefined),
        }) as unknown as McpServer,
        createAnswerCardMatcher,
      };
    };

    const disabled = await createPseAgentRuntime(configEnv, runtimeDependencies());
    expect(createAnswerCardMatcher).not.toHaveBeenCalled();
    await disabled.close();

    const enabled = await createPseAgentRuntime({
      ...configEnv,
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: "C:\\runtime\\answer-card-catalog.json",
    }, runtimeDependencies());
    expect(createAnswerCardMatcher).toHaveBeenCalledOnce();
    expect(createAnswerCardMatcher).toHaveBeenCalledWith(model, {
      enabled: true,
      required: false,
      catalogPath: "C:\\runtime\\answer-card-catalog.json",
      exactActiveEnabled: false,
      familyActiveEnabled: false,
    });
    await enabled.close();
  });

  it("wires the multi-domain flag and detailed executor without changing the external result", async () => {
    const model = {} as ModelClient;
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    let sessionSequence = 0;
    const knowledge = {
      open: vi.fn(async (scope: "professional" | "general") => ({
        project: scope === "professional" ? "coremail-professional" : "presales-general",
        revision: String(++sessionSequence).padStart(40, "0"),
        purpose: `${scope} purpose`,
        schema: `${scope} schema`,
        planningOverview: `${scope} overview`,
      }) as KnowledgeSession),
    };
    const shadow = {
      analyze: vi.fn(async () => ({
        resolvedQuestion: {
          rawQuestion: "Coremail版本是什么，信息不足时怎样推进项目",
          standaloneQuestion: "Coremail版本是什么，信息不足时怎样推进项目",
          contextUsed: false,
          inheritedSubjects: [],
          corrections: [],
        },
        taskSpec: taskSpecSchema.parse({
          subject: "Coremail 与项目推进",
          entities: [
            { id: "E1", label: "Coremail", role: "product", sourceText: "Coremail" },
            { id: "E2", label: "项目", role: "target", sourceText: "项目" },
          ],
          deliverables: [
            {
              id: "D1",
              label: "版本",
              kind: "fact",
              required: true,
              sourceText: "Coremail版本是什么",
              obligations: [{
                id: "O1",
                label: "确认版本",
                targetEntityIds: ["E1"],
                evidencePolicy: "direct",
                domains: ["coremail-professional"],
                required: true,
                sourceText: "Coremail版本是什么",
              }],
            },
            {
              id: "D2",
              label: "推进建议",
              kind: "recommendation",
              required: true,
              sourceText: "信息不足时怎样推进项目",
              obligations: [{
                id: "O2",
                label: "给出推进建议",
                targetEntityIds: ["E2"],
                evidencePolicy: "synthesis",
                domains: ["presales-general"],
                required: true,
                sourceText: "信息不足时怎样推进项目",
              }],
            },
          ],
        }),
        guard: {
          ok: true,
          issues: [],
          explicitEntityCount: 2,
          mappedExplicitEntityCount: 2,
          explicitRequestCount: 2,
          mappedExplicitRequestCount: 2,
        },
        elapsedMs: 1,
      })),
    } satisfies TaskAnalysisShadow;
    const legacy = vi.fn<AgentRunner>();
    const detailed = vi.fn<DetailedAgentRunner>(async (input) => ({
      outcome: "verified",
      project: input.session.project,
      revision: input.session.revision,
      action: {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "该必答项暂无正式知识证据。",
          citations: [],
        }],
        citations: [],
      },
      references: [],
    }));
    const server = { close: vi.fn(async () => undefined) } as unknown as McpServer;

    const runtime = await createPseAgentRuntime({
      ...configEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
    }, {
      createModel: () => model,
      createRouter: () => ({ route: vi.fn(async () => "professional" as const) }),
      createKnowledgePlanner: () => ({ plan: vi.fn(async () => plan) }),
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => knowledge,
      runAgent: legacy,
      runAgentDetailed: detailed,
      createTaskAnalysisShadow: () => shadow,
      createServer: () => server,
    });

    const execution = await runtime.answerDetailed(
      "Coremail版本是什么，信息不足时怎样推进项目",
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(detailed).toHaveBeenCalledTimes(2);
    expect(execution.domainsUsed).toEqual([
      "coremail-professional",
      "presales-general",
    ]);
    expect(execution.result).not.toHaveProperty("domainsUsed");
    expect(execution.result.status).toBe("not_covered");
    expect(new Set(detailed.mock.calls.map(([input]) => input.signal)).size).toBe(1);
    await runtime.close();
  });

  it("lazily wires and idempotently closes the enabled historical provider", async () => {
    const model = {
      completeJson: vi.fn(),
      completeText: vi.fn(async () => "普通回答"),
    } as unknown as ModelClient;
    const caller = {
      connect: vi.fn(async () => undefined),
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies KnowledgeToolCaller;
    const session = { project: "coremail-professional" } as KnowledgeSession;
    const knowledge = { open: vi.fn(async () => session) };
    const planner = { plan: vi.fn(async () => plan) } satisfies KnowledgePlanner;
    const runAgent = vi.fn<AgentRunner>(async () => ({
      scope: "professional",
      status: "not_covered",
      answer: "未覆盖",
      references: [],
    }));
    const provider = {
      answer: vi.fn(async () => ({ outcome: "unavailable" as const })),
      close: vi.fn(async (): Promise<void> => {
        throw new Error("close failure");
      }),
    } satisfies HistoricalAnswerProvider;
    const createHistoricalProvider = vi.fn(() => provider);
    const closeServer = vi.fn(async () => undefined);
    const server = { close: closeServer } as unknown as McpServer;

    const runtime = await createPseAgentRuntime(enabledConfigEnv, {
      createModel: () => model,
      createRouter: () => ({
        route: vi.fn(async () => "normal" as const),
      }),
      createKnowledgePlanner: () => planner,
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => knowledge,
      runAgent,
      createServer: () => server,
      createHistoricalProvider,
    });

    expect(createHistoricalProvider).toHaveBeenCalledOnce();
    expect(createHistoricalProvider).toHaveBeenCalledWith({
      enabled: true,
      command: "node",
      entryPath: "C:\\runtime\\dist\\server.js",
      timeoutMs: 30000,
    });
    expect(provider.answer).not.toHaveBeenCalled();

    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.close).toHaveBeenCalledOnce();
    expect(caller.close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
  });
});
