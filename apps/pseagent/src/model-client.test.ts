import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InvalidModelPayloadError, ModelUnavailableError, OpenAiCompatibleModelClient } from "./model-client.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => new OpenAiCompatibleModelClient({
  baseUrl: "https://model.example/v1",
  apiKey: "top-secret",
  model: "one-model",
  timeoutMs: 1_000,
});

describe("model client", () => {
  it("rejects non-JSON model content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "not json" } }] })));
    await expect(client().completeJson({
      messages: [], schema: z.object({ ok: z.boolean() }), schemaDescription: "test",
    })).rejects.toBeInstanceOf(InvalidModelPayloadError);
  });
  it("redacts HTTP provider bodies and secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("top-secret raw body", { status: 401 })));
    await expect(client().completeText({ messages: [] })).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(client().completeText({ messages: [] })).rejects.not.toThrow(/top-secret|raw body/u);
  });
});
