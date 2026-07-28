import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  HISTORICAL_ANSWER_WARNING,
  type AnswerResult,
} from "./contracts.js";
import { createPseMcpServer, formatMcpText } from "./mcp-server.js";

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

  it("renders an isolated historical section without rewriting Markdown or Mermaid", () => {
    const rawHistoricalAnswer = [
      "原始历史答案。",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");
    const result: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。",
      references: [],
      historicalAnswer: {
        provider: "coremail_mcp",
        verified: false,
        confidence: "low",
        warning: HISTORICAL_ANSWER_WARNING,
        answer: rawHistoricalAnswer,
        references: [{
          sourceType: "jira",
          key: "CMHA-1097",
          title: "镜像版本记录",
          updatedAt: "2026-07-20",
          versions: ["5.0", "5.1"],
          status: "已解决",
          url: "https://jira.example.test/browse/CMHA-1097",
        }],
      },
    };

    const text = formatMcpText(result);

    expect(text).toContain(result.answer);
    expect(text).toContain("⚠️ Coremail MCP 低可信历史线索（可能不正确）");
    expect(text).toContain(HISTORICAL_ANSWER_WARNING);
    expect(text).toContain("MCP 自报置信度：低（不代表内容正确）");
    expect(text).toContain(rawHistoricalAnswer);
    expect(text).toContain("版本：5.0、5.1");
    expect(text.indexOf(result.answer)).toBeLessThan(text.indexOf(rawHistoricalAnswer));
    expect(text).not.toContain("Jira/Wiki 历史资料辅助回答");
    expect(text).not.toContain("\n\n可信度：低\n\n");
    expect(result.references).toEqual([]);
  });
});
