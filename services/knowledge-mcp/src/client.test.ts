import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpKnowledgeEngine, KnowledgeClientError } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

describe("HttpKnowledgeEngine", () => {
  it("rejects non-loopback plain HTTP by default", () => {
    expect(() => new HttpKnowledgeEngine({
      baseUrl: "http://example.com",
      token: "secret",
      timeoutMs: 1_000,
    })).toThrow(KnowledgeClientError);
  });

  it("never echoes the bearer token from an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret-body", { status: 401 })));
    const engine = new HttpKnowledgeEngine({
      baseUrl: "http://127.0.0.1:19829",
      token: "top-secret",
      timeoutMs: 1_000,
    });
    await expect(engine.health()).rejects.not.toThrow(/top-secret|secret-body/u);
  });
});
