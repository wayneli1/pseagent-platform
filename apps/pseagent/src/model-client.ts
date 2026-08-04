import type { z } from "zod";

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
export interface ModelClient {
  completeJson<T>(input: {
    readonly messages: readonly ModelMessage[];
    readonly schema: z.ZodType<T>;
    readonly schemaDescription: string;
    readonly signal?: AbortSignal;
  }): Promise<T>;
  completeText(input: {
    readonly messages: readonly ModelMessage[];
    readonly signal?: AbortSignal;
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
  }) {}

  async completeJson<T>(input: {
    messages: readonly ModelMessage[];
    schema: z.ZodType<T>;
    schemaDescription: string;
    signal?: AbortSignal;
  }): Promise<T> {
    const completion = await this.complete(input.messages, true, input.signal);
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

  async completeText(input: { messages: readonly ModelMessage[]; signal?: AbortSignal }): Promise<string> {
    return (await this.complete(input.messages, false, input.signal)).content;
  }

  private async complete(
    messages: readonly ModelMessage[],
    json: boolean,
    callerSignal?: AbortSignal,
  ): Promise<{ readonly content: string; readonly finishReason?: string }> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const body = {
      model: this.config.model,
      temperature: 0,
      max_tokens: this.config.maxTokens,
      messages,
      ...(json && this.config.jsonResponseFormat !== false
        ? { response_format: { type: "json_object" } }
        : {}),
    };
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new ModelUnavailableError(`model_unavailable_${response.status}`);
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new InvalidModelPayloadError();
      const parsed = JSON.parse(text) as {
        choices?: Array<{
          finish_reason?: unknown;
          message?: { content?: unknown };
        }>;
      };
      const choice = parsed.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new InvalidModelPayloadError();
      return {
        content,
        ...(typeof choice?.finish_reason === "string"
          ? { finishReason: choice.finish_reason }
          : {}),
      };
    } catch (error) {
      if (error instanceof ModelUnavailableError || error instanceof InvalidModelPayloadError) throw error;
      if (signal.aborted) throw new ModelUnavailableError();
      throw new ModelUnavailableError();
    }
  }
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
