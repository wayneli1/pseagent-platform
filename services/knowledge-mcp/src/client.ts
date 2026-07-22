import type { z } from "zod";
import {
  contextResultSchema,
  graphResultSchema,
  healthResultSchema,
  readResultSchema,
  searchResultSchema,
  type ContextInput,
  type ContextResult,
  type GraphInput,
  type GraphResult,
  type HealthResult,
  type ReadInput,
  type ReadResult,
  type SearchInput,
  type SearchResult,
} from "./schemas.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface KnowledgeEngine {
  health(): Promise<HealthResult>;
  context(input: ContextInput): Promise<ContextResult>;
  search(input: SearchInput): Promise<SearchResult>;
  read(input: ReadInput): Promise<ReadResult>;
  graph(input: GraphInput): Promise<GraphResult>;
}

export class KnowledgeClientError extends Error {
  constructor(readonly code: "provider_unavailable" | "invalid_payload" | "unauthorized" | "timeout") {
    super(code);
  }
}

export class HttpKnowledgeEngine implements KnowledgeEngine {
  private readonly baseUrl: string;

  constructor(private readonly config: {
    baseUrl: string;
    token: string;
    timeoutMs: number;
    allowRemote?: boolean;
  }) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new KnowledgeClientError("invalid_payload");
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol === "http:" && !loopback && !config.allowRemote) {
      throw new KnowledgeClientError("invalid_payload");
    }
    if (!config.token.trim()) throw new KnowledgeClientError("invalid_payload");
    this.baseUrl = url.toString().replace(/\/$/u, "");
  }

  health() { return this.request("/health", undefined, healthResultSchema); }
  context(input: ContextInput) { return this.request("/v1/context", input, contextResultSchema); }
  search(input: SearchInput) { return this.request("/v1/search", input, searchResultSchema); }
  read(input: ReadInput) { return this.request("/v1/read", input, readResultSchema); }
  graph(input: GraphInput) { return this.request("/v1/graph", input, graphResultSchema); }

  private async request<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const init: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(this.baseUrl + path, init);
      if (response.status === 401) throw new KnowledgeClientError("unauthorized");
      if (!response.ok) throw new KnowledgeClientError("provider_unavailable");
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new KnowledgeClientError("invalid_payload");
      return schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof KnowledgeClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new KnowledgeClientError("timeout");
      throw new KnowledgeClientError("invalid_payload");
    } finally {
      clearTimeout(timer);
    }
  }
}
