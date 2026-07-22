import { statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

export const KNOWLEDGE_TOOL_NAMES = [
  "knowledge_status",
  "knowledge_context",
  "knowledge_search",
  "knowledge_read",
  "knowledge_graph",
] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

export interface KnowledgeToolCaller {
  connect(): Promise<void>;
  call(name: KnowledgeToolName, input: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

type McpClientFacade = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{ structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
};

type TransportFacade = { stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null };

export interface KnowledgeToolCallerDependencies {
  createClient?: () => McpClientFacade;
  createTransport?: (options: StdioServerParameters) => TransportFacade;
}

export class KnowledgeToolCallerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "KnowledgeToolCallerError";
  }
}

export class StdioKnowledgeToolCaller implements KnowledgeToolCaller {
  private readonly createClient: () => McpClientFacade;
  private readonly createTransport: (options: StdioServerParameters) => TransportFacade;
  private state: "idle" | "connecting" | "connected" | "closing" | "closed" = "idle";
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private client?: McpClientFacade;
  private clientClosed = false;

  constructor(
    private readonly entryPath: string,
    dependencies: KnowledgeToolCallerDependencies = {},
  ) {
    this.createClient = dependencies.createClient ?? (() =>
      new Client({ name: "pseagent-app", version: "0.1.0" }) as unknown as McpClientFacade);
    this.createTransport = dependencies.createTransport ?? ((options) =>
      new StdioClientTransport(options) as TransportFacade);
  }

  async connect(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") {
      throw new KnowledgeToolCallerError("knowledge_mcp_closed");
    }
    if (this.state === "connected") return;
    if (this.connectPromise) return this.connectPromise;

    this.state = "connecting";
    this.connectPromise = this.startConnection();
    return this.connectPromise;
  }

  async call(name: KnowledgeToolName, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!KNOWLEDGE_TOOL_NAMES.includes(name)) {
      throw new KnowledgeToolCallerError("knowledge_mcp_tool_forbidden");
    }
    if (!isRecord(input)) throw new KnowledgeToolCallerError("knowledge_mcp_invalid_input");
    await this.connect();
    if (!this.client || this.state !== "connected") throw new KnowledgeToolCallerError("knowledge_mcp_closed");

    try {
      const result = await this.client.callTool(
        { name, arguments: input },
        undefined,
        signal === undefined ? undefined : { signal },
      );
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = result.content?.find((item) => item.type === "text")?.text;
      if (text === undefined) throw new KnowledgeToolCallerError("knowledge_mcp_invalid_result");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof KnowledgeToolCallerError) throw error;
      if (signal?.aborted) throw new KnowledgeToolCallerError("knowledge_mcp_cancelled");
      throw new KnowledgeToolCallerError("knowledge_mcp_call_failed");
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return;
    this.state = "closing";
    this.closePromise = (async () => {
      if (this.connectPromise) {
        try {
          await this.connectPromise;
        } catch {
          // Connection errors are already redacted for the original caller.
        }
      }
      await this.closeClient();
      this.state = "closed";
    })();
    return this.closePromise;
  }

  private async startConnection(): Promise<void> {
    try {
      const normalizedEntry = validateAndNormalizeEntry(this.entryPath);
      const client = this.createClient();
      this.client = client;
      const transport = this.createTransport({
        command: process.execPath,
        args: [normalizedEntry],
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {
        // Drain child stderr without retaining or exposing secrets or knowledge content.
      });
      await client.connect(transport);
      const listed = await client.listTools();
      if (!hasExactToolAllowlist(listed.tools.map((tool) => tool.name))) {
        throw new KnowledgeToolCallerError("knowledge_mcp_tool_allowlist_mismatch");
      }
      if (this.state === "closing" || this.state === "closed") {
        throw new KnowledgeToolCallerError("knowledge_mcp_closed");
      }
      this.state = "connected";
    } catch (error) {
      await this.closeClient();
      if (this.state !== "closing" && this.state !== "closed") this.state = "idle";
      if (error instanceof KnowledgeToolCallerError) throw error;
      throw new KnowledgeToolCallerError("knowledge_mcp_connect_failed");
    }
  }

  private async closeClient(): Promise<void> {
    if (!this.client || this.clientClosed) return;
    this.clientClosed = true;
    try {
      await this.client.close();
    } catch {
      // Closing is best effort and must not expose transport details.
    }
  }
}

function validateAndNormalizeEntry(entryPath: string): string {
  if (!path.isAbsolute(entryPath)) throw new KnowledgeToolCallerError("knowledge_mcp_invalid_entry");
  const normalized = process.platform === "win32" && entryPath.startsWith("\\\\?\\")
    ? entryPath.slice(4)
    : path.normalize(entryPath);
  try {
    if (!statSync(normalized).isFile()) throw new Error("not_file");
  } catch {
    throw new KnowledgeToolCallerError("knowledge_mcp_invalid_entry");
  }
  return normalized;
}

function hasExactToolAllowlist(names: string[]): boolean {
  if (names.length !== KNOWLEDGE_TOOL_NAMES.length) return false;
  const actual = [...names].sort();
  const expected = [...KNOWLEDGE_TOOL_NAMES].sort();
  return actual.every((name, index) => name === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
