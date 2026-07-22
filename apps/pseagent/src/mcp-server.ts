import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnswerResult } from "./contracts.js";
import { pseAnswerInputSchema } from "./contracts.js";

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
  return result.answer;
}
