import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InvalidModelPayloadError, ModelUnavailableError, OpenAiCompatibleModelClient } from "./model-client.js";
import { ModelRequestScheduler } from "./model-request-scheduler.js";

afterEach(() => vi.unstubAllGlobals());
const client = (overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleModelClient>[0]> = {}) => new OpenAiCompatibleModelClient({
  baseUrl: "https://model.example/v1",
  apiKey: "top-secret",
  model: "one-model",
  timeoutMs: 1_000,
  maxTokens: 8_192,
  ...overrides,
});

describe("model client", () => {
  it("rejects non-JSON model content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "not json" } }] })));
    const failure = client().completeJson({
      messages: [], schema: z.object({ ok: z.boolean() }), schemaDescription: "test",
    });
    await expect(failure).rejects.toMatchObject({
      code: "invalid_json",
      rawPayload: "not json",
      rawPayloadLength: 8,
      schemaDescription: "test",
    });
  });
  it("reports the exact rejected field type and retains the rejected JSON", async () => {
    const rawPayload = JSON.stringify({ citations: "1,2" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ choices: [{ message: { content: rawPayload } }] })));

    const failure = client().completeJson({
      messages: [],
      schema: z.object({ citations: z.array(z.number().int()) }),
      schemaDescription: "pse_final_action",
    });

    await expect(failure).rejects.toMatchObject({
      code: expect.stringContaining("citations:invalid_type(expected=array)"),
      rawPayload,
      rawPayloadLength: rawPayload.length,
      schemaDescription: "pse_final_action",
    });
  });
  it("sends the configured output budget and retains the provider finish reason", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      Response.json({
        choices: [{
          finish_reason: "length",
          message: { content: "{\"ok\":" },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const failure = client().completeJson({
      messages: [],
      schema: z.object({ ok: z.boolean() }),
      schemaDescription: "test",
    });

    await expect(failure).rejects.toMatchObject({
      code: "invalid_json",
      finishReason: "length",
      rawPayloadLength: 6,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      max_tokens?: number;
    };
    expect(body.max_tokens).toBe(8_192);
  });
  it("redacts HTTP provider bodies and secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("top-secret raw body", { status: 401 })));
    await expect(client().completeText({ messages: [] })).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(client().completeText({ messages: [] })).rejects.not.toThrow(/top-secret|raw body/u);
  });

  it("retries transient provider throttling without exposing the response body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("limited secret", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "recovered" } }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const metrics = vi.fn();
    await expect(client({ timeoutMs: 3_000 }).completeText({
      messages: [],
      onMetrics: metrics,
    }))
      .resolves.toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      attemptCount: 2,
      queueElapsedMs: expect.any(Number),
      executionElapsedMs: expect.any(Number),
    }));
  });

  it("does not retry a non-transient authentication failure", async () => {
    const fetchMock = vi.fn(async () => new Response("secret", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().completeText({ messages: [] })).rejects.toMatchObject({
      code: "model_unavailable_401",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports its own deadline as a model timeout instead of generic unavailability", async () => {
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
    })));
    await expect(client({timeoutMs:20}).completeText({messages:[]})).rejects.toMatchObject({code:"model_timeout"});
  });

  it("keeps a caller cancellation distinct from a provider timeout", async () => {
    const controller=new AbortController();
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      if(init?.signal?.aborted)reject(init.signal.reason);
      else init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
    })));
    const completion=client({timeoutMs:1_000}).completeText({messages:[],signal:controller.signal});
    controller.abort();
    await expect(completion).rejects.toMatchObject({code:"model_request_aborted"});
  });

  it("shares the injected concurrency limit across model clients", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scheduler = new ModelRequestScheduler({
      maxConcurrency: 2,
      maxQueueSize: 10,
      queueTimeoutMs: 1_000,
    });

    await Promise.all(Array.from({ length: 7 }, () =>
      client({ scheduler }).completeText({ messages: [] })));

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(maximumActive).toBeLessThanOrEqual(2);
  });

  it("accepts one strict JSON object wrapped by a leading think block and JSON fence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: "<think>内部推理，不应进入结果</think>\n```json\n{\"ok\":true}\n```" } }],
    })));

    await expect(client().completeJson({
      messages: [],
      schema: z.object({ ok: z.literal(true) }).strict(),
      schemaDescription: "test",
    })).resolves.toEqual({ ok: true });
  });

  it("extracts one unique valid JSON object from bounded provider prose", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: "下面是结构结果：\n{\"value\":\"带有 { 花括号 } 的字符串\"}\n结束。" } }],
    })));

    await expect(client().completeJson({
      messages: [],
      schema: z.object({ value: z.string() }).strict(),
      schemaDescription: "test",
    })).resolves.toEqual({ value: "带有 { 花括号 } 的字符串" });
  });

  it.each([
    ["multiple objects", "{\"ok\":true}\n{\"ok\":false}", "ambiguous_json_object"],
    ["unclosed think", "<think>unfinished\n{\"ok\":true}", "invalid_reasoning_envelope"],
    ["unclosed fence", "```json\n{\"ok\":true}", "invalid_code_fence_envelope"],
    ["array root", "[1,2,3]", "invalid_json_object"],
  ])("rejects unsafe structured envelope: %s", async (_name, content, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content } }],
    })));

    await expect(client().completeJson({
      messages: [],
      schema: z.object({ ok: z.boolean() }).strict(),
      schemaDescription: "test",
    })).rejects.toMatchObject({ code });
  });

  it("still applies the strict schema after envelope extraction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: "```json\n{\"ok\":true,\"extra\":\"forbidden\"}\n```" } }],
    })));

    await expect(client().completeJson({
      messages: [],
      schema: z.object({ ok: z.boolean() }).strict(),
      schemaDescription: "test",
    })).rejects.toMatchObject({ code: expect.stringContaining("unrecognized_keys") });
  });

  it("declares providers that do not support response_format", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await client({ jsonResponseFormat: false }).completeJson({
      messages: [],
      schema: z.object({ ok: z.boolean() }),
      schemaDescription: "test",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      response_format?: unknown;
    };
    expect(body).not.toHaveProperty("response_format");
  });
});
