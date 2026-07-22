import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KnowledgeEngine } from "./client.js";
import { createKnowledgeMcpServer, TOOL_NAMES } from "./server.js";

describe("Knowledge MCP", () => {
  it("exposes the five read-only tools and no query tool", async () => {
    const engine = {} as KnowledgeEngine;
    const server = createKnowledgeMcpServer(engine);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "knowledge_context",
      "knowledge_graph",
      "knowledge_read",
      "knowledge_search",
      "knowledge_status",
    ]);
    expect(tools.tools.some((tool) => tool.name === "knowledge_query")).toBe(false);
    await Promise.all([client.close(), server.close()]);
  });

  it("keeps the literal allowlist reviewable", () => expect(TOOL_NAMES).toHaveLength(5));
});
