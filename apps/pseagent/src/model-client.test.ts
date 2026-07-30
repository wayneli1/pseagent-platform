import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InvalidModelPayloadError, ModelUnavailableError, OpenAiCompatibleModelClient } from "./model-client.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => new OpenAiCompatibleModelClient({
  baseUrl: "https://model.example/v1",
  apiKey: "top-secret",
  model: "one-model",
  timeoutMs: 1_000,
  maxTokens: 8_192,
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
});
