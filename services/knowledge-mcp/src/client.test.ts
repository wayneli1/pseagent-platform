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

  it("accepts the zero-downtime deployment status returned by the engine",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({status:"ready",projects:[{project:"coremail-professional",revision:"a".repeat(40),lexicalStatus:"ready",graphStatus:"ready"},{project:"presales-general",revision:"b".repeat(40),lexicalStatus:"ready",graphStatus:"ready"}],deployment:{status:"reloading",servingPreviousVersion:true,releaseId:"KR-2026-08-TEST",professionalRevision:"c".repeat(40),generalRevision:"b".repeat(40),errorCode:null}}),{status:200})));
    const result=await new HttpKnowledgeEngine({baseUrl:"http://127.0.0.1:19829",token:"secret",timeoutMs:1_000}).health();
    expect(result.deployment).toMatchObject({status:"reloading",servingPreviousVersion:true,professionalRevision:"c".repeat(40)});
  });

  it("passes governed search filters through and validates hit metadata", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      project: "coremail-professional",
      revision: "a".repeat(40),
      hits: [{
        path: "wiki/queries/ai-assistant.md",
        title: "AI 助手支持什么能力？",
        score: 420,
        matchedTerms: ["AI", "助手"],
        snippet: "受治理的答案卡摘要",
        pageType: "query",
        reviewStatus: "approved",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const engine = new HttpKnowledgeEngine({
      baseUrl: "http://127.0.0.1:19829",
      token: "top-secret",
      timeoutMs: 1_000,
    });

    const result = await engine.search({
      project: "coremail-professional",
      query: "AI 助手支持什么能力？",
      topK: 5,
      pageType: "query",
      reviewStatus: "approved",
      searchMode: "answer_cards",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pageType: "query",
      reviewStatus: "approved",
      searchMode: "answer_cards",
    });
    expect(result.hits[0]).toMatchObject({
      pageType: "query",
      reviewStatus: "approved",
    });
  });
});
