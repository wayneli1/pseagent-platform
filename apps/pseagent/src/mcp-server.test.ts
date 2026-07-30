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

  it("renders a bounded historical section while preserving safe Markdown", () => {
    const rawHistoricalAnswer = [
      "原始历史答案。",
      "内部链接：https://wiki.coremail.cn/pages/viewpage.action?pageId=123",
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
        confidence: "medium",
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
    expect(text).toContain("MCP 自报置信度：中（不代表内容正确）");
    expect(text).toContain("原始历史答案。");
    expect(text).toContain("```mermaid");
    expect(text).toContain("版本：5.0、5.1");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("链接：");
    expect(text.indexOf(result.answer)).toBeLessThan(text.indexOf("原始历史答案。"));
    expect(text).not.toContain("Jira/Wiki 历史资料辅助回答");
    expect(text).not.toContain("\n\n可信度：低\n\n");
    expect(result.references).toEqual([]);
  });

  it.each([
    [
      "topic_mismatch",
      "补充说明：已检索 Coremail MCP 历史资料，但检索内容与当前问题不匹配，因此未展示。",
    ],
    [
      "low_confidence",
      "补充说明：已检索 Coremail MCP 历史资料，但结果置信度较低，因此未展示。",
    ],
    [
      "no_reliable_source",
      "补充说明：已检索 Coremail MCP 历史资料，但未找到与当前问题可靠匹配的内容。",
    ],
  ] as const)("renders only the fixed hidden-history notice for %s", (reason, notice) => {
    const result: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "当前正式知识库暂未覆盖该问题。",
      references: [],
      historicalNotice: {
        provider: "coremail_mcp",
        searched: true,
        displayed: false,
        reason,
      },
    };

    const text = formatMcpText(result);

    expect(text).toBe(`${result.answer}\n\n${notice}`);
    expect(text).not.toContain("⚠️ Coremail MCP 低可信历史线索");
    expect(text).not.toContain("历史来源：");
    expect(text).not.toContain("http");
  });

  it("fails closed when a low-confidence historical answer reaches the renderer", () => {
    const result: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "当前正式知识库暂未覆盖该问题。",
      references: [],
      historicalAnswer: {
        provider: "coremail_mcp",
        verified: false,
        confidence: "low",
        warning: HISTORICAL_ANSWER_WARNING,
        answer: "不应显示的低置信度正文",
        references: [{
          sourceType: "jira",
          key: "LOW-1",
          title: "低置信度来源",
        }],
      },
    };

    const text = formatMcpText(result);

    expect(text).toBe([
      result.answer,
      "补充说明：已检索 Coremail MCP 历史资料，但结果置信度较低，因此未展示。",
    ].join("\n\n"));
    expect(text).not.toContain("不应显示的低置信度正文");
    expect(text).not.toContain("LOW-1");
  });

  it("limits the complete visible historical block to 3000 characters and three sources", () => {
    const result: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: "正式知识未覆盖。",
      references: [],
      historicalAnswer: {
        provider: "coremail_mcp",
        verified: false,
        confidence: "medium",
        warning: HISTORICAL_ANSWER_WARNING,
        answer: `历史正文：${"内容".repeat(2_000)}`,
        references: Array.from({ length: 5 }, (_, index) => ({
          sourceType: "jira" as const,
          key: `MAIL-${index + 1}`,
          title: `来源${index + 1}`,
          url: `https://jira.coremail.cn/browse/MAIL-${index + 1}`,
        })),
      },
    };

    const text = formatMcpText(result);
    const historicalBlock = text.slice(result.answer.length + 2);

    expect(historicalBlock.length).toBeLessThanOrEqual(3_000);
    expect(text).toContain("MAIL-1");
    expect(text).toContain("MAIL-3");
    expect(text).not.toContain("MAIL-4");
    expect(text).not.toContain("https://");
  });

  it("leaves formal related-context sections intact when no historical answer exists", () => {
    const result: AnswerResult = {
      scope: "professional",
      status: "not_covered",
      answer: [
        "正式知识库相关信息：",
        "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
        "覆盖结论：",
        "正式资料未提及目标协议，无法确认 Coremail 是否支持。",
        "正式知识库资料来源：",
        "[1] Coremail 协议能力 — coremail-professional/wiki/protocols.md",
        "[2] Coremail 邮件协议 — coremail-professional/wiki/mail-protocols.md",
      ].join("\n\n"),
      references: [{
        ...fixture.references[0]!,
        path: "wiki/protocols.md",
      }, {
        ...fixture.references[0]!,
        index: 2,
        title: "Coremail 邮件协议",
        path: "wiki/mail-protocols.md",
        contentHash: "c".repeat(64),
      }],
    };

    const text = formatMcpText(result);

    expect(text).toBe(result.answer);
    expect(text.match(/正式知识库资料来源：/gu)).toHaveLength(1);
    expect(text).not.toContain("历史来源：");
  });
});
