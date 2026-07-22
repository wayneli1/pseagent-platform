import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HttpKnowledgeEngine, type KnowledgeEngine } from "./client.js";
import {
  contextInputSchema,
  graphInputSchema,
  readInputSchema,
  searchInputSchema,
} from "./schemas.js";

export const TOOL_NAMES = [
  "knowledge_status",
  "knowledge_context",
  "knowledge_search",
  "knowledge_read",
  "knowledge_graph",
] as const;

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createKnowledgeMcpServer(engine: KnowledgeEngine): McpServer {
  const server = new McpServer({ name: "pseagent-knowledge", version: "0.1.0" });
  server.registerTool("knowledge_status", { inputSchema: {} }, async () => result(await engine.health()));
  server.registerTool("knowledge_context", { inputSchema: contextInputSchema.shape }, async (input) =>
    result(await engine.context(contextInputSchema.parse(input))));
  server.registerTool("knowledge_search", { inputSchema: searchInputSchema.shape }, async (input) =>
    result(await engine.search(searchInputSchema.parse(input))));
  server.registerTool("knowledge_read", { inputSchema: readInputSchema.shape }, async (input) =>
    result(await engine.read(readInputSchema.parse(input))));
  server.registerTool("knowledge_graph", { inputSchema: graphInputSchema.shape }, async (input) =>
    result(await engine.graph(graphInputSchema.parse(input))));
  return server;
}

export async function runKnowledgeMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const baseUrl = z.string().url().parse(env.KNOWLEDGE_ENGINE_URL);
  const token = z.string().trim().min(1).parse(env.KNOWLEDGE_ENGINE_TOKEN);
  const timeoutMs = z.coerce.number().int().min(1_000).max(180_000).parse(env.KNOWLEDGE_ENGINE_TIMEOUT_MS ?? 30_000);
  const engine = new HttpKnowledgeEngine({
    baseUrl,
    token,
    timeoutMs,
    allowRemote: env.KNOWLEDGE_ENGINE_ALLOW_REMOTE === "true",
  });
  await createKnowledgeMcpServer(engine).connect(new StdioServerTransport());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runKnowledgeMcp().catch(() => {
    process.stderr.write("knowledge_mcp_startup_failed\n");
    process.exitCode = 1;
  });
}
