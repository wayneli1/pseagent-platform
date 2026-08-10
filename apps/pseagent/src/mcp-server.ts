import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnswerResult,
  HistoricalReference,
} from "./contracts.js";
import { answerResultSchema, pseAnswerInputSchema } from "./contracts.js";
import {
  HISTORICAL_BLOCK_MAX_CHARS,
  HISTORICAL_NOTICE_MESSAGES,
  HISTORICAL_REFERENCE_LIMIT,
  sanitizeHistoricalBody,
  truncateText,
} from "./historical-display.js";

const confidenceLabels = {
  low: "低",
  medium: "中",
  high: "高",
} as const;

export function createPseMcpServer(dependencies: {
  readonly answer: (
    question: string,
    conversationContext?: string,
    signal?: AbortSignal,
  ) => Promise<AnswerResult>;
}): McpServer {
  const server = new McpServer({ name: "coremail-pseagent", version: "0.2.0" });
  server.registerTool(
    "pse_answer",
    {
      description: "由 PSEAgent 内部完成普通/专业/通用路由、必要检索和最终回答。每个用户问题只调用一次。",
      inputSchema: pseAnswerInputSchema.shape,
    },
    async ({ question, conversationContext }, extra) => {
      const result = answerResultSchema.parse(
        await dependencies.answer(question, conversationContext, extra.signal),
      );
      return {
        content: [{ type: "text" as const, text: formatMcpText(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
  return server;
}

export function formatMcpText(result: AnswerResult): string {
  if (result.historicalNotice) {
    return [
      result.answer,
      HISTORICAL_NOTICE_MESSAGES[result.historicalNotice.reason],
    ].join("\n\n");
  }
  if (!result.historicalAnswer) return result.answer;
  const historical = result.historicalAnswer;
  if (historical.confidence === "low") {
    return [
      result.answer,
      HISTORICAL_NOTICE_MESSAGES.low_confidence,
    ].join("\n\n");
  }
  const historicalBlock = [
    "⚠️ 补充历史线索（可能不正确）",
    historical.warning,
    `线索置信度：${confidenceLabels[historical.confidence]}（不代表内容正确）`,
    sanitizeHistoricalBody(historical.answer),
    "历史来源：",
    ...historical.references
      .slice(0, HISTORICAL_REFERENCE_LIMIT)
      .map(formatHistoricalReference),
  ].join("\n\n");
  return [
    result.answer,
    truncateText(historicalBlock, HISTORICAL_BLOCK_MAX_CHARS),
  ].join("\n\n");
}

function formatHistoricalReference(
  reference: HistoricalReference,
  index: number,
): string {
  const identity = reference.key ?? reference.id;
  const heading = [
    `${index + 1}. ${reference.sourceType === "jira" ? "Jira" : "Wiki"}`,
    identity,
    `《${reference.title}》`,
  ].filter((part): part is string => part !== undefined).join(" ");
  const details = [
    reference.updatedAt ? `更新时间：${reference.updatedAt}` : undefined,
    reference.status ? `状态：${reference.status}` : undefined,
    reference.versions?.length ? `版本：${reference.versions.join("、")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [heading, ...details].join("\n");
}
