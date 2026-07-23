import { statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  HISTORICAL_ANSWER_WARNING,
  historicalAnswerSchema,
  type HistoricalAnswer,
  type HistoricalReference,
} from "./contracts.js";

export interface HistoricalAnswerProvider {
  answer(question: string, signal?: AbortSignal): Promise<HistoricalAnswer | undefined>;
  close(): Promise<void>;
}

export type CoremailMcpErrorCode =
  | "coremail_mcp_timeout"
  | "coremail_mcp_connect_failed"
  | "coremail_mcp_auth_failed"
  | "coremail_mcp_invalid_result"
  | "coremail_mcp_closed";

export function coremailKnowledgeArguments(question: string) {
  return {
    question,
    intent: "auto",
    limit: 8,
    includeComments: true,
    commentMode: "relevant",
    profileRanking: true,
    explainRanking: false,
    includeRelationExpansion: true,
    relationDepth: 1,
    diagnosticsLevel: "summary",
  } as const;
}

const rawSourceSchema = z.object({
  source_type: z.string(),
  id: z.string().optional(),
  key: z.string().optional(),
  title: z.string().min(1),
  url: z.string().optional(),
  updated_at: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const rawAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.string(),
  sources: z.array(z.unknown()),
}).passthrough();

export function sanitizeCoremailHistoricalAnswer(
  input: unknown,
): HistoricalAnswer | undefined {
  const parsed = rawAnswerSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { answer, confidence } = parsed.data;
  if (answer.trim().length === 0 || answer.length > 32_768) return undefined;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    return undefined;
  }

  const seen = new Set<string>();
  const references: HistoricalReference[] = [];
  for (const raw of parsed.data.sources) {
    const source = rawSourceSchema.safeParse(raw);
    if (!source.success) continue;
    if (source.data.source_type !== "jira" && source.data.source_type !== "wiki") {
      continue;
    }
    const metadata = source.data.metadata;
    const versions = Array.isArray(metadata?.fix_versions)
      ? metadata.fix_versions.filter((value): value is string =>
        typeof value === "string" && value.length > 0).slice(0, 20)
      : undefined;
    const status = typeof metadata?.status === "string" && metadata.status.length > 0
      ? metadata.status
      : undefined;
    const key = [
      source.data.source_type,
      source.data.key ?? source.data.id ?? source.data.url ?? source.data.title,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      sourceType: source.data.source_type,
      title: source.data.title,
      ...(source.data.id ? { id: source.data.id } : {}),
      ...(source.data.key ? { key: source.data.key } : {}),
      ...(source.data.url ? { url: source.data.url } : {}),
      ...(source.data.updated_at ? { updatedAt: source.data.updated_at } : {}),
      ...(versions?.length ? { versions } : {}),
      ...(status ? { status } : {}),
    });
    if (references.length === 20) break;
  }
  if (references.length === 0) return undefined;

  return historicalAnswerSchema.parse({
    provider: "coremail_mcp",
    verified: false,
    confidence,
    warning: HISTORICAL_ANSWER_WARNING,
    answer,
    references,
  });
}

type McpClientFacade = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  }>;
  close(): Promise<void>;
};

type TransportFacade = {
  stderr?: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
};

export interface CoremailMcpClientDependencies {
  readonly command: string;
  readonly timeoutMs: number;
  readonly createClient?: () => McpClientFacade;
  readonly createTransport?: (options: StdioServerParameters) => TransportFacade;
  readonly defaultEnvironment?: () => Record<string, string>;
  readonly validateEntry?: (entryPath: string) => string;
  readonly reportError?: (code: CoremailMcpErrorCode) => void;
}

class CoremailMcpClientError extends Error {
  constructor(readonly code: CoremailMcpErrorCode) {
    super(code);
    this.name = "CoremailMcpClientError";
  }
}

export class StdioCoremailHistoricalAnswerProvider
implements HistoricalAnswerProvider {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly createClient: () => McpClientFacade;
  private readonly createTransport: (
    options: StdioServerParameters,
  ) => TransportFacade;
  private readonly defaultEnvironment: () => Record<string, string>;
  private readonly validateEntry: (entryPath: string) => string;
  private readonly reportError: (code: CoremailMcpErrorCode) => void;
  private readonly closedClients = new WeakSet<McpClientFacade>();
  private state: "idle" | "connecting" | "connected" | "closing" | "closed" =
    "idle";
  private generation = 0;
  private client: McpClientFacade | undefined;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly entryPath: string,
    dependencies: CoremailMcpClientDependencies,
  ) {
    this.command = dependencies.command;
    this.timeoutMs = dependencies.timeoutMs;
    this.createClient = dependencies.createClient ?? (() =>
      new Client({
        name: "pseagent-coremail-history",
        version: "0.1.0",
      }) as unknown as McpClientFacade);
    this.createTransport = dependencies.createTransport ?? ((options) =>
      new StdioClientTransport(options) as TransportFacade);
    this.defaultEnvironment =
      dependencies.defaultEnvironment ?? getDefaultEnvironment;
    this.validateEntry = dependencies.validateEntry ?? validateCoremailEntry;
    this.reportError = dependencies.reportError ??
      ((code) => process.stderr.write(`${code}\n`));
  }

  async answer(
    question: string,
    signal?: AbortSignal,
  ): Promise<HistoricalAnswer | undefined> {
    if (this.state === "closing" || this.state === "closed") {
      this.reportError("coremail_mcp_closed");
      return undefined;
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error("coremail_mcp_timeout")),
      this.timeoutMs,
    );
    timer.unref();
    const requestSignal = signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, signal]);

    try {
      await raceWithAbort(this.connect(), requestSignal);
      const client = this.client;
      if (!client || this.state !== "connected") {
        throw new CoremailMcpClientError("coremail_mcp_connect_failed");
      }
      const result = await client.callTool(
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments(question),
        },
        undefined,
        { signal: requestSignal },
      );
      let raw: unknown;
      if (result.structuredContent !== undefined) {
        raw = result.structuredContent;
      } else {
        const text = result.content?.find((item) => item.type === "text")?.text;
        if (text === undefined) {
          throw new CoremailMcpClientError("coremail_mcp_invalid_result");
        }
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          throw new CoremailMcpClientError("coremail_mcp_invalid_result");
        }
      }
      const historical = sanitizeCoremailHistoricalAnswer(raw);
      if (historical === undefined) {
        throw new CoremailMcpClientError("coremail_mcp_invalid_result");
      }
      return historical;
    } catch (error) {
      if (signal?.aborted && !timeoutController.signal.aborted) {
        await this.resetBrokenConnection();
        return undefined;
      }
      const code = classifyCoremailError(
        error,
        timeoutController.signal.aborted,
      );
      if (
        code !== "coremail_mcp_invalid_result" &&
        code !== "coremail_mcp_closed"
      ) {
        await this.resetBrokenConnection();
      }
      this.reportError(code);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return;
    this.state = "closing";
    this.generation += 1;
    const client = this.client;
    const connecting = this.connectPromise;
    this.client = undefined;
    this.connectPromise = undefined;
    this.closePromise = (async () => {
      if (client) await this.closeClient(client);
      await connecting?.catch(() => undefined);
      this.state = "closed";
    })();
    return this.closePromise;
  }

  private async connect(): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      throw new CoremailMcpClientError("coremail_mcp_closed");
    }
    if (this.state === "connected") return;
    if (this.connectPromise) return this.connectPromise;

    this.state = "connecting";
    const generation = ++this.generation;
    const connecting = this.startConnection(generation);
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = undefined;
    }
  }

  private async startConnection(generation: number): Promise<void> {
    let client: McpClientFacade | undefined;
    try {
      const entry = this.validateEntry(this.entryPath);
      client = this.createClient();
      this.client = client;
      const transport = this.createTransport({
        command: this.command,
        args: [entry],
        env: this.childEnvironment(),
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => undefined);
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) =>
        tool.name === "answer_coremail_knowledge")) {
        throw new CoremailMcpClientError("coremail_mcp_connect_failed");
      }
      if (
        generation !== this.generation ||
        this.state === "closing" ||
        this.state === "closed"
      ) {
        throw new CoremailMcpClientError("coremail_mcp_closed");
      }
      this.state = "connected";
    } catch (error) {
      if (client) await this.closeClient(client);
      if (this.client === client) this.client = undefined;
      if (
        generation === this.generation &&
        this.state !== "closing" &&
        this.state !== "closed"
      ) {
        this.state = "idle";
      }
      throw error;
    }
  }

  private childEnvironment(): Record<string, string> {
    const child: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.defaultEnvironment())) {
      if (
        name.startsWith("PSE_MODEL_") ||
        name.startsWith("KNOWLEDGE_ENGINE_") ||
        name.startsWith("KNOWLEDGE_MCP_")
      ) {
        continue;
      }
      child[name] = value;
    }
    return {
      ...child,
      AI_ADOPTION_ENABLED: "false",
      KNOWLEDGE_ENABLE_CACHE: "false",
      KNOWLEDGE_AUTH_INTERACTIVE: "false",
    };
  }

  private async resetBrokenConnection(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    this.client = undefined;
    this.connectPromise = undefined;
    if (this.state !== "closing" && this.state !== "closed") {
      this.state = "idle";
    }
    if (client) await this.closeClient(client);
  }

  private async closeClient(client: McpClientFacade): Promise<void> {
    if (this.closedClients.has(client)) return;
    this.closedClients.add(client);
    await client.close().catch(() => undefined);
  }
}

function validateCoremailEntry(entryPath: string): string {
  if (!path.isAbsolute(entryPath)) throw new Error("coremail_mcp_invalid_entry");
  const normalized = path.normalize(entryPath);
  if (
    path.basename(normalized).toLowerCase() !== "server.js" ||
    path.basename(path.dirname(normalized)).toLowerCase() !== "dist"
  ) {
    throw new Error("coremail_mcp_invalid_entry");
  }
  try {
    if (!statSync(normalized).isFile()) {
      throw new Error("coremail_mcp_invalid_entry");
    }
  } catch {
    throw new Error("coremail_mcp_invalid_entry");
  }
  return normalized;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function classifyCoremailError(
  error: unknown,
  timedOut: boolean,
): CoremailMcpErrorCode {
  if (timedOut) return "coremail_mcp_timeout";
  if (error instanceof CoremailMcpClientError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/(?:401|302|authentication|credentials|sso)/iu.test(message)) {
    return "coremail_mcp_auth_failed";
  }
  return "coremail_mcp_connect_failed";
}
