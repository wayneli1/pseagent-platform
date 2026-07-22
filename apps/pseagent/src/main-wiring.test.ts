import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRunner } from "./answer-service.js";
import type { AnswerResult } from "./contracts.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { KnowledgeToolCaller } from "./knowledge-tool-caller.js";
import type { ModelClient } from "./model-client.js";
import { createPseAgentRuntime } from "./main.js";

const configEnv = {
  PSE_MODEL_BASE_URL: "https://model.example.test/v1",
  PSE_MODEL_API_KEY: "test-key",
  PSE_MODEL_NAME: "main-model",
  PSE_MODEL_TIMEOUT_MS: "60000",
  KNOWLEDGE_MCP_COMMAND: "node",
  KNOWLEDGE_MCP_ENTRY_PATH: process.execPath,
};

describe("main wiring", () => {
  it("uses one model for routing, normal answers, and the knowledge agent", async () => {
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
    const agentResult: AnswerResult = {
      scope: "professional", status: "not_covered", answer: "未覆盖", references: [],
    };
    const runAgent = vi.fn<AgentRunner>(async () => agentResult);
    const closeServer = vi.fn(async () => undefined);
    const server = { close: closeServer } as unknown as McpServer;

    const runtime = await createPseAgentRuntime(configEnv, {
      createModel,
      createRouter,
      createKnowledgeCaller: () => caller,
      createKnowledgeSessionFactory: () => knowledge,
      runAgent,
      createServer: () => server,
    });

    await expect(runtime.answer("普通问题")).resolves.toMatchObject({ scope: "normal", answer: "普通回答" });
    await expect(runtime.answer("产品问题")).resolves.toBe(agentResult);
    expect(createModel).toHaveBeenCalledOnce();
    expect(model.completeText).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].model).toBe(model);
    expect(caller.connect).toHaveBeenCalledOnce();

    await runtime.close();
    await runtime.close();
    expect(caller.close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
  });
});
