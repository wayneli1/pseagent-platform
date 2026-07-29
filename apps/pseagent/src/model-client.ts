import type { z } from "zod";

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
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
  constructor(
    readonly code = "invalid_model_payload",
    readonly rawPayload?: string,
    readonly schemaDescription?: string,
  ) {
    super(code);
  }
}

export class OpenAiCompatibleModelClient implements ModelClient {
  constructor(private readonly config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  }) {}

  async completeJson<T>(input: {
    messages: readonly ModelMessage[];
    schema: z.ZodType<T>;
    schemaDescription: string;
    signal?: AbortSignal;
  }): Promise<T> {
    const content = await this.complete(input.messages, true, input.signal);
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      throw new InvalidModelPayloadError(
        "invalid_json",
        content,
        input.schemaDescription,
      );
    }
    const parsed = input.schema.safeParse(decoded);
    if (!parsed.success) {
      throw new InvalidModelPayloadError(
        `invalid_schema:${summarizeIssueTree(parsed.error.issues)}`,
        content,
        input.schemaDescription,
      );
    }
    return parsed.data;
  }

  async completeText(input: { messages: readonly ModelMessage[]; signal?: AbortSignal }): Promise<string> {
    return this.complete(input.messages, false, input.signal);
  }

  private async complete(messages: readonly ModelMessage[], json: boolean, callerSignal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const body = {
      model: this.config.model,
      temperature: 0,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
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
      const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new InvalidModelPayloadError();
      return content;
    } catch (error) {
      if (error instanceof ModelUnavailableError || error instanceof InvalidModelPayloadError) throw error;
      if (signal.aborted) throw new ModelUnavailableError();
      throw new ModelUnavailableError();
    }
  }
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
