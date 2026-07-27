import { describe, expect, it, vi } from "vitest";
import type { AgentAction, KnowledgePlan } from "./contracts.js";
import { runKnowledgeAgent } from "./agent-loop.js";
import { InvalidModelPayloadError, type ModelClient, type ModelMessage } from "./model-client.js";
import { KNOWLEDGE_AGENT_SYSTEM_PROMPT } from "./prompts.js";

const revision = "a".repeat(40);
const hash = "b".repeat(64);

it("puts requirement-bound strict knowledge action shapes in the model prompt", () => {
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.search","input":{"requirementId":"R1","query":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.read_page","input":{"requirementId":"R1","path":"..."}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.graph","input":{"requirementId":"R1","path":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"final","requirements":[{"id":"R1","coverage":"complete|partial|none","citations":[1]}],"answer":"... [1]","citations":[1]}',
  );
});

it("defines evidence-bounded adaptive answer depth in the knowledge prompt", () => {
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("在已读取的知识证据范围内充分回答用户问题");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("事实查询应直接、简洁地回答");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("方法类问题应说明关键步骤和注意事项");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "方案、部署和架构类问题应适当展开，分别说明方案组成、实施思路、主要风险与待确认项",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "其中某一项缺少知识证据时不得省略或编造，应明确标记为待确认",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "证据只能支持部分内容时，应明确区分已确认内容与待确认内容，并使用 partial",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "没有可靠知识证据时使用 none，不得依靠模型先验补充答案",
  );
});

const search = (requirementId: string, query: string, topK = 5): AgentAction => ({
  action: "tool",
  tool: "kb.search",
  input: { requirementId, query, topK },
});
const read = (requirementId: string, path: string): AgentAction => ({
  action: "tool",
  tool: "kb.read_page",
  input: { requirementId, path },
});
const graph = (requirementId: string, path: string, topK = 5): AgentAction => ({
  action: "tool",
  tool: "kb.graph",
  input: { requirementId, path, topK },
});
const final = (
  coverage: "complete" | "partial" | "none",
  answer = "",
  citations: number[] = [],
  requirements = [{ id: "R1", coverage, citations }],
): AgentAction => ({
  action: "final",
  requirements,
  answer,
  citations,
});

function scriptedAgentModel(script: Array<AgentAction | Error>) {
  const schemas: string[] = [];
  const prompts: Array<readonly ModelMessage[]> = [];
  const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
    schemas.push(input.schemaDescription);
    prompts.push(input.messages);
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new InvalidModelPayloadError();
    return input.schema.parse(next);
  });
  return {
    completeJson,
    completeText: vi.fn(),
    get calls() { return completeJson.mock.calls.length; },
    lastSchemaName: () => schemas.at(-1),
    prompts,
  } as unknown as ModelClient & {
    readonly calls: number;
    lastSchemaName(): string | undefined;
    prompts: readonly (readonly ModelMessage[])[];
  };
}

type SearchFixture = {
  readonly path: string;
  readonly title?: string;
  readonly matchedTerms?: string[];
};

function fakeSession(options: {
  readonly hits?: Readonly<Record<string, readonly SearchFixture[]>>;
  readonly graphHits?: readonly SearchFixture[];
  readonly failAllSearches?: boolean;
} = {}) {
  const searchMock = vi.fn(async (query: string) => {
    if (options.failAllSearches) throw new Error("search unavailable");
    const fixtures = options.hits?.[query] ?? [];
    return {
      project: "coremail-professional" as const,
      revision,
      hits: fixtures.map((fixture, index) => ({
        path: fixture.path,
        title: fixture.title ?? fixture.path,
        score: 1 - index / 10,
        matchedTerms: fixture.matchedTerms ?? [query],
        snippet: `snippet:${query}`,
      })),
    };
  });
  const graphMock = vi.fn(async () => ({
    project: "coremail-professional" as const,
    revision,
    hits: (options.graphHits ?? []).map((fixture) => ({
      path: fixture.path,
      title: fixture.title ?? fixture.path,
      relation: "related",
    })),
  }));
  const readPageMock = vi.fn(async (path: string) => ({
    project: "coremail-professional" as const,
    path,
    title: path,
    type: "guide",
    tags: [],
    related: [],
    sources: [],
    body: `body:${path}`,
    contentHash: hash,
  }));
  return {
    project: "coremail-professional" as const,
    revision,
    schema: "schema",
    overview: "overview",
    search: searchMock,
    graph: graphMock,
    readPage: readPageMock,
    compactPage: vi.fn(() => "compact page"),
    totalToolCalls: () =>
      searchMock.mock.calls.length + graphMock.mock.calls.length + readPageMock.mock.calls.length,
  };
}

const singlePlan: KnowledgePlan = {
  subject: "Coremail AI",
  requirements: [{ id: "R1", question: "Coremail AI 是什么", queries: ["seed-r1"] }],
};

function agentInput(
  model: ModelClient,
  session: ReturnType<typeof fakeSession>,
  plan: KnowledgePlan = singlePlan,
  deadlineAt?: number,
) {
  return {
    scope: "professional" as const,
    question: "测试问题",
    plan,
    model,
    session,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}

function payloadAt(model: ReturnType<typeof scriptedAgentModel>, index: number) {
  return JSON.parse(model.prompts[index]?.at(-1)?.content ?? "null") as {
    finalOnly?: boolean;
    requirementEvidence?: Array<{
      id: string;
      candidates: Array<{
        path: string;
        rrfScore: number;
        sourceQueries: string[];
        rankings: Array<{ query: string; rank: number; score: number }>;
        read: boolean;
      }>;
      citationIndexes: number[];
    }>;
    observations?: string[];
  };
}

describe("runKnowledgeAgent", () => {
  it("automatically searches every seed query and fuses candidates with RRF", async () => {
    const plan: KnowledgePlan = {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "网关功能和 POC",
        queries: ["功能查询", "POC 查询"],
      }],
    };
    const session = fakeSession({
      hits: {
        "功能查询": [
          { path: "wiki/shared.md" },
          { path: "wiki/feature-only.md" },
        ],
        "POC 查询": [
          { path: "wiki/shared.md" },
          { path: "wiki/poc-only.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/shared.md"),
      final("complete", "网关功能和 POC[1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledTimes(2);
    expect(session.search).toHaveBeenCalledWith("功能查询", 10, undefined);
    expect(session.search).toHaveBeenCalledWith("POC 查询", 10, undefined);
    const candidates = payloadAt(model, 0).requirementEvidence?.[0]?.candidates ?? [];
    expect(candidates[0]).toMatchObject({
      path: "wiki/shared.md",
      sourceQueries: ["功能查询", "POC 查询"],
      rankings: [
        { query: "功能查询", rank: 1, score: 1 },
        { query: "POC 查询", rank: 1, score: 1 },
      ],
    });
    expect(candidates[0]?.rrfScore).toBeGreaterThan(candidates[1]?.rrfScore ?? 0);
  });

  it("uses dynamic per-requirement budgets instead of a global four-action cap", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "功能", queries: ["seed-r1"] },
        { id: "R2", question: "POC", queries: ["seed-r2"] },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1.md" }],
        "seed-r2": [{ path: "wiki/r2.md" }],
        "supplement-r1": [{ path: "wiki/r1-extra.md" }],
        "supplement-r2": [{ path: "wiki/r2-extra.md" }],
      },
      graphHits: [{ path: "wiki/related.md" }],
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/r1.md"),
      graph("R1", "wiki/r1.md"),
      read("R2", "wiki/r2.md"),
      graph("R2", "wiki/r2.md"),
      search("R1", "supplement-r1"),
      search("R2", "supplement-r2"),
      final("complete", "功能[1]，POC[2]", [1, 2], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [2] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(model.calls).toBe(7);
    expect(session.totalToolCalls()).toBe(8);
    expect(result.status).toBe("answered");
    expect(result.references.map((reference) => reference.path)).toEqual(["wiki/r1.md", "wiki/r2.md"]);
  });

  it("rejects reading a candidate through a different requirement", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "功能", queries: ["seed-r1"] },
        { id: "R2", question: "POC", queries: ["seed-r2"] },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1.md" }],
        "seed-r2": [{ path: "wiki/r2.md" }],
      },
    });
    const model = scriptedAgentModel([
      read("R2", "wiki/r1.md"),
      read("R2", "wiki/r2.md"),
      read("R1", "wiki/r1.md"),
      final("complete", "功能[2]；POC[1]", [2, 1], [
        { id: "R1", coverage: "complete", citations: [2] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledTimes(2);
    expect(session.readPage).toHaveBeenNthCalledWith(1, "wiki/r2.md", undefined);
    expect(session.readPage).toHaveBeenNthCalledWith(2, "wiki/r1.md", undefined);
    expect(payloadAt(model, 1).observations?.join("\n"))
      .toContain("path_not_candidate_for_requirement");
  });

  it("stops a no-gain requirement without preventing evidence reads for another", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "不存在的资料", queries: ["seed-r1"] },
        { id: "R2", question: "已有资料", queries: ["seed-r2"] },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [],
        "seed-r2": [{ path: "wiki/r2.md" }],
        "still-no-hit": [],
      },
    });
    const model = scriptedAgentModel([
      search("R1", "still-no-hit"),
      read("R2", "wiki/r2.md"),
      final("partial", "R2 已确认[1]，R1 资料不足", [1], [
        { id: "R1", coverage: "none", citations: [] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledWith("wiki/r2.md", undefined);
    expect(result.status).toBe("partially_answered");
  });

  it("does not execute normalized duplicate seed queries again", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      search("R1", "  SEED-R1  "),
      final("none", "当前资料未覆盖该问题"),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(session.search).toHaveBeenCalledOnce();
    expect(payloadAt(model, 1).observations?.join("\n")).toContain("duplicate_query");
  });

  it("passes requirement-specific terms into section compaction", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md", matchedTerms: ["AI 助手"] }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/r1.md"),
      final("complete", "结论[1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(session.compactPage).toHaveBeenCalledWith(
      expect.objectContaining({ path: "wiki/r1.md" }),
      expect.arrayContaining(["Coremail AI 是什么", "seed-r1", "AI 助手"]),
    );
  });

  it("does not accept none while a requirement still has an unread candidate", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
    });
    const model = scriptedAgentModel([
      final("none", "当前资料未覆盖该问题"),
      read("R1", "wiki/r1.md"),
      final("complete", "读取后确认[1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 1).observations?.join("\n")).toContain(
      "coverage_gate_requires_read",
    );
    expect(session.readPage).toHaveBeenCalledOnce();
    expect(result.status).toBe("answered");
  });

  it("requests a final-only action after the active deadline", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([final("none", "当前资料未覆盖该问题")]);

    await runKnowledgeAgent(agentInput(model, session, singlePlan, Date.now() - 1));

    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(payloadAt(model, 0).finalOnly).toBe(true);
  });

  it("returns unavailable when every automatic seed search fails", async () => {
    const session = fakeSession({ failAllSearches: true });
    const model = scriptedAgentModel([]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(result.status).toBe("temporarily_unavailable");
    expect(model.calls).toBe(0);
  });

  it("records one invalid action as a bounded observation", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(),
      final("none", "当前资料未覆盖该问题"),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 1).observations?.join("\n")).toContain("invalid_model_payload");
  });

  it("returns unavailable after two consecutive invalid actions", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(),
      new InvalidModelPayloadError(),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(2);
    expect(result.status).toBe("temporarily_unavailable");
  });

  it("allows exactly one repair attempt for invalid citations", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const badFinal = final("complete", "未经读取的结论[1]", [1]);
    const model = scriptedAgentModel([badFinal, badFinal]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(2);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(result.status).toBe("temporarily_unavailable");
  });

  it("never answers a covered final without a read-page reference", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      final("complete", "未经读取的结论[1]", [1]),
      final("none", "当前资料未覆盖该问题", []),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(result.status).toBe("not_covered");
    expect(result.references).toEqual([]);
  });
});
