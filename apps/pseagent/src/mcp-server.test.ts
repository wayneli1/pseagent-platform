import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "./contracts.js";
import { createPseMcpServer } from "./mcp-server.js";

const fixture: AnswerResult = {
  scope: "professional",
  status: "answered",
  answer: "Coremail AI 支持该能力[1]。\n\n资料来源：\n[1] Coremail AI — coremail-professional/wiki/ai.md",
  references: [{
    index: 1,
    project: "coremail-professional",
    title: "Coremail AI",
    path: "wiki/ai.md",
    revision: "a".repeat(40),
    contentHash: "b".repeat(64),
  }],
};

async function connectedClient(server: ReturnType<typeof createPseMcpServer>) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("PSEAgent MCP", () => {
  it("exposes exactly one pse_answer tool", async () => {
    const pair = await connectedClient(createPseMcpServer({ answer: vi.fn() }));

    const tools = await pair.client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(["pse_answer"]);
    expect(tools.tools.some((tool) => tool.name === "pse_route")).toBe(false);
    await Promise.all([pair.client.close(), pair.server.close()]);
  });

  it("accepts question plus optional context and returns text plus structured content", async () => {
    const answer = vi.fn(async () => fixture);
    const pair = await connectedClient(createPseMcpServer({ answer }));

    const result = await pair.client.callTool({
      name: "pse_answer",
      arguments: { question: "列出 Coremail AI 新功能", conversationContext: "客户关注客户端能力" },
    });

    expect(answer).toHaveBeenCalledWith("列出 Coremail AI 新功能", "客户关注客户端能力", expect.any(AbortSignal));
    expect(result.content).toEqual([{ type: "text", text: fixture.answer }]);
    expect(result.structuredContent).toMatchObject({ scope: "professional", status: "answered" });
    await Promise.all([pair.client.close(), pair.server.close()]);
  });
});
