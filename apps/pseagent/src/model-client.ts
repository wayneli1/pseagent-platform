import type { z } from "zod";
import {
  ModelQueueError,
  ModelRequestScheduler,
  type ModelRequestLease,
} from "./model-request-scheduler.js";
import { reportModelCallMetrics } from "./model-metrics-context.js";

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export const MODEL_ROLES = [
  "resolver",
  "planner",
  "synthesizer",
  "verifier",
] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export interface ModelRoleClients {
  readonly resolver: ModelClient;
  readonly planner: ModelClient;
  readonly synthesizer: ModelClient;
  readonly verifier: ModelClient;
}
export interface ModelCallMetrics {
  readonly attemptCount: number;
  readonly queueElapsedMs: number;
  readonly executionElapsedMs: number;
}
export type ModelCallMetricsReporter = (metrics: ModelCallMetrics) => void;
export interface ModelClient {
  completeJson<T>(input: {
    readonly messages: readonly ModelMessage[];
    readonly schema: z.ZodType<T>;
    readonly schemaDescription: string;
    readonly signal?: AbortSignal;
    readonly onMetrics?: ModelCallMetricsReporter;
  }): Promise<T>;
  completeText(input: {
    readonly messages: readonly ModelMessage[];
    readonly signal?: AbortSignal;
    readonly onMetrics?: ModelCallMetricsReporter;
  }): Promise<string>;
}
export class ModelUnavailableError extends Error {
  constructor(readonly code = "model_unavailable") { super(code); }
}
export class InvalidModelPayloadError extends Error {
  readonly rawPayloadLength: number | undefined;

  constructor(
    readonly code = "invalid_model_payload",
    readonly rawPayload?: string,
    readonly schemaDescription?: string,
    readonly finishReason?: string,
  ) {
    super(code);
    this.rawPayloadLength = rawPayload?.length;
  }
}

export class OpenAiCompatibleModelClient implements ModelClient {
  constructor(private readonly config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
    jsonResponseFormat?: boolean;
    scheduler?: ModelRequestScheduler;
  }) {}

  async completeJson<T>(input: {
    messages: readonly ModelMessage[];
    schema: z.ZodType<T>;
    schemaDescription: string;
    signal?: AbortSignal;
    onMetrics?: ModelCallMetricsReporter;
  }): Promise<T> {
    const completion = await this.complete(
      input.messages,
      true,
      input.signal,
      input.onMetrics,
    );
    const content = completion.content;
    let structuredContent: string;
    try {
      structuredContent = extractStructuredJsonObject(content);
    } catch (error) {
      throw new InvalidModelPayloadError(
        error instanceof StructuredEnvelopeError ? error.code : "invalid_json",
        content,
        input.schemaDescription,
        completion.finishReason,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(structuredContent);
    } catch {
      throw new InvalidModelPayloadError(
        "invalid_json",
        content,
        input.schemaDescription,
        completion.finishReason,
      );
    }
    if (!isJsonObject(decoded)) {
      throw new InvalidModelPayloadError(
        "invalid_json_object",
        content,
        input.schemaDescription,
        completion.finishReason,
      );
    }
    const parsed = input.schema.safeParse(decoded);
    if (!parsed.success) {
      throw new InvalidModelPayloadError(
        `invalid_schema:${summarizeIssueTree(parsed.error.issues)}`,
        content,
        input.schemaDescription,
        completion.finishReason,
      );
    }
    return parsed.data;
  }

  async completeText(input: {
    messages: readonly ModelMessage[];
    signal?: AbortSignal;
    onMetrics?: ModelCallMetricsReporter;
  }): Promise<string> {
    return (await this.complete(
      input.messages,
      false,
      input.signal,
      input.onMetrics,
    )).content;
  }

  private async complete(
    messages: readonly ModelMessage[],
    json: boolean,
    callerSignal?: AbortSignal,
    onMetrics?: ModelCallMetricsReporter,
  ): Promise<{ readonly content: string; readonly finishReason?: string }> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let modelLease: ModelRequestLease | undefined;
    let attemptCount = 0;
    let executionStartedAt: number | undefined;
    try {
    try {
      modelLease = await (this.config.scheduler ?? DEFAULT_MODEL_REQUEST_SCHEDULER)
        .acquire(signal);
    } catch (error) {
      if (error instanceof ModelQueueError) {
        throw new ModelUnavailableError(error.code);
      }
      throw error;
    }
    executionStartedAt = Date.now();
    const body = {
      model: this.config.model,
      temperature: 0,
      max_tokens: this.config.maxTokens,
      messages,
      ...(json && this.config.jsonResponseFormat !== false
        ? { response_format: { type: "json_object" } }
        : {}),
    };
    const url = `${this.config.baseUrl.replace(/\/$/u, "")}/chat/completions`;
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    } satisfies RequestInit;
    let lastFailureCode = "model_unavailable";
    for (let attempt = 0; attempt < MODEL_TRANSPORT_MAX_ATTEMPTS; attempt += 1) {
      attemptCount = attempt + 1;
      let response: Response;
      try {
        response = await fetch(url, request);
      } catch {
        if (signal.aborted) throw new ModelUnavailableError();
        if (attempt + 1 >= MODEL_TRANSPORT_MAX_ATTEMPTS) {
          throw new ModelUnavailableError(lastFailureCode);
        }
        await waitForModelRetry(MODEL_TRANSPORT_RETRY_MS[attempt]!, signal);
        continue;
      }
      if (!response.ok) {
        lastFailureCode = `model_unavailable_${response.status}`;
        if (
          !MODEL_TRANSIENT_HTTP_STATUSES.has(response.status) ||
          attempt + 1 >= MODEL_TRANSPORT_MAX_ATTEMPTS
        ) {
          throw new ModelUnavailableError(lastFailureCode);
        }
        await response.body?.cancel().catch(() => undefined);
        await waitForModelRetry(
          Math.max(
            retryAfterMs(response.headers.get("retry-after")) ?? 0,
            MODEL_TRANSPORT_RETRY_MS[attempt]!,
          ),
          signal,
        );
        continue;
      }
      try {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
          throw new InvalidModelPayloadError();
        }
        const parsed = JSON.parse(text) as {
          choices?: Array<{
            finish_reason?: unknown;
            message?: { content?: unknown };
          }>;
        };
        const choice = parsed.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new InvalidModelPayloadError();
        }
        return {
          content,
          ...(typeof choice?.finish_reason === "string"
            ? { finishReason: choice.finish_reason }
            : {}),
        };
      } catch (error) {
        if (error instanceof InvalidModelPayloadError) throw error;
        throw new InvalidModelPayloadError();
      }
    }
    throw new ModelUnavailableError(lastFailureCode);
    } catch(error) {
      if(error instanceof ModelUnavailableError&&signal.aborted){
        if(callerSignal?.aborted)throw new ModelUnavailableError("model_request_aborted");
        if(timeout.aborted)throw new ModelUnavailableError("model_timeout");
      }
      throw error;
    } finally {
      try {
        const metrics = {
          attemptCount,
          queueElapsedMs: modelLease?.queueElapsedMs ?? 0,
          executionElapsedMs: executionStartedAt === undefined
            ? 0
            : Math.max(0, Date.now() - executionStartedAt),
        };
        onMetrics?.(metrics);
        reportModelCallMetrics(metrics);
      } catch {
        // Metrics are diagnostic-only and must never change the answer path.
      }
      modelLease?.release();
    }
  }
}

const MODEL_TRANSPORT_MAX_ATTEMPTS = 4;
const MODEL_TRANSPORT_RETRY_MS = [1_000, 3_000, 10_000] as const;
const MODEL_TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MODEL_REQUEST_SCHEDULER = new ModelRequestScheduler({
  maxConcurrency: 3,
  maxQueueSize: 64,
  queueTimeoutMs: 30_000,
});

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(30_000, Math.max(0, date - Date.now()));
}

async function waitForModelRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ModelUnavailableError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new ModelUnavailableError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class StructuredEnvelopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StructuredEnvelopeError";
  }
}

function extractStructuredJsonObject(raw: string): string {
  let content = raw.trim();
  for (let count = 0; /^<think>/iu.test(content); count += 1) {
    if (count >= 4) throw new StructuredEnvelopeError("invalid_reasoning_envelope");
    const closingIndex = content.search(/<\/think>/iu);
    if (closingIndex < 0) {
      throw new StructuredEnvelopeError("invalid_reasoning_envelope");
    }
    const closing = content.slice(closingIndex).match(/^<\/think>/iu)?.[0];
    if (closing === undefined) {
      throw new StructuredEnvelopeError("invalid_reasoning_envelope");
    }
    content = content.slice(closingIndex + closing.length).trim();
  }

  if (content.startsWith("```")) {
    const opening = content.match(/^```(?:json)?[ \t]*\r?\n/iu)?.[0];
    if (opening === undefined || !content.endsWith("```")) {
      throw new StructuredEnvelopeError("invalid_code_fence_envelope");
    }
    const interior = content.slice(opening.length, -3);
    if (interior.includes("```")) {
      throw new StructuredEnvelopeError("invalid_code_fence_envelope");
    }
    content = interior.trim();
  }

  try {
    const direct = JSON.parse(content) as unknown;
    if (!isJsonObject(direct)) {
      throw new StructuredEnvelopeError("invalid_json_object");
    }
    return content;
  } catch (error) {
    if (error instanceof StructuredEnvelopeError) throw error;
  }

  const candidates = findValidJsonObjects(content);
  if (candidates.length === 0) throw new StructuredEnvelopeError("invalid_json");
  if (candidates.length > 1) {
    throw new StructuredEnvelopeError("ambiguous_json_object");
  }
  return candidates[0]!;
}

function findValidJsonObjects(content: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") continue;
    const end = balancedObjectEnd(content, start);
    if (end === undefined) continue;
    const candidate = content.slice(start, end + 1);
    try {
      if (isJsonObject(JSON.parse(candidate))) candidates.push(candidate);
    } catch {
      // Invalid brace-delimited prose is not a structured candidate.
    }
    start = end;
  }
  return candidates;
}

function balancedObjectEnd(content: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeIssueTree(value: unknown): string {
  const summaries: string[] = [];
  const visit = (current: unknown): void => {
    if (summaries.length >= 8) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    const issue = current as Record<string, unknown>;
    if (typeof issue.code === "string") {
      const path = Array.isArray(issue.path)
        ? issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
        : "";
      const expected = typeof issue.expected === "string"
        ? `(expected=${issue.expected})`
        : "";
      summaries.push(`${path || "root"}:${issue.code}${expected}`);
    }
    if (Array.isArray(issue.errors)) visit(issue.errors);
  };
  visit(value);
  return summaries.join("|").slice(0, 512) || "unknown";
}
