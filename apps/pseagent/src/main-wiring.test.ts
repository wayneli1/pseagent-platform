import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRunner } from "./answer-service.js";
import type { AnswerResult } from "./contracts.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { KnowledgeToolCaller } from "./knowledge-tool-caller.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import type { ModelClient } from "./model-client.js";
import { createPseAgentRuntime } from "./main.js";

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
