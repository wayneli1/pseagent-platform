import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnswerResult,
  HistoricalReference,
} from "./contracts.js";
import { pseAnswerInputSchema } from "./contracts.js";

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
      const result = await dependencies.answer(question, conversationContext, extra.signal);
      return {
        content: [{ type: "text" as const, text: formatMcpText(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
  return server;
}

export function formatMcpText(result: AnswerResult): string {
  if (!result.historicalAnswer) return result.answer;
  const historical = result.historicalAnswer;
  return [
    result.answer,
    "Jira/Wiki 历史资料辅助回答",
    historical.warning,
    `可信度：${confidenceLabels[historical.confidence]}`,
    historical.answer,
    "历史来源：",
    ...historical.references.map(formatHistoricalReference),
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
    reference.url ? `链接：${reference.url}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [heading, ...details].join("\n");
}
