import { describe, expect, it, vi } from "vitest";
import type { AgentAction } from "./contracts.js";
import { runKnowledgeAgent } from "./agent-loop.js";
import { InvalidModelPayloadError, type ModelClient, type ModelMessage } from "./model-client.js";
import { KNOWLEDGE_AGENT_SYSTEM_PROMPT } from "./prompts.js";

const revision = "a".repeat(40);
const hash = "b".repeat(64);

it("puts every strict knowledge action shape in the model prompt", () => {
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.search","input":{"query":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.read_page","input":{"path":"..."}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.graph","input":{"path":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"final","coverage":"complete|partial|none","answer":"... [1]","citations":[1]}',
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
    "用户要求详细回答时，方案、部署和架构类答案必须显式包含“主要风险”和“待确认项”",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "没有对应知识证据时，在该项明确写明“知识证据不足，待确认”",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "优先服从用户明确提出的“简要”或“详细”要求",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "不得为了丰富内容补充没有知识证据支持的事实",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "证据只能支持部分内容时，应明确区分已确认内容与待确认内容，并使用 partial",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "没有可靠知识证据时使用 none，不得依靠模型先验补充答案",
  );
});

const search = (query: string, topK = 5): AgentAction => ({
  action: "tool", tool: "kb.search", input: { query, topK },
});
const final = (coverage: "complete" | "partial" | "none", answer = "", citations: number[] = []): AgentAction => ({
  action: "final", coverage, answer, citations,
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

function fakeSession(options: { alwaysNew?: boolean; noHits?: boolean } = {}) {
  let sequence = 0;
  const searchMock = vi.fn(async () => {
    sequence += 1;
    return {
      project: "coremail-professional" as const,
      revision,
      hits: options.noHits ? [] : [{
        path: options.alwaysNew ? `wiki/path-${sequence}.md` : "wiki/path.md",
        title: "Page",
        score: 1,
        matchedTerms: ["term"],
        snippet: "snippet",
      }],
    };
  });
  const graphMock = vi.fn(async () => ({ project: "coremail-professional" as const, revision, hits: [] }));
  const readPageMock = vi.fn(async (path: string) => ({
    project: "coremail-professional" as const,
    path,
    title: "Page",
    type: "guide",
    tags: [],
    related: [],
    sources: [],
    body: "body",
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
    totalToolCalls: () => searchMock.mock.calls.length + graphMock.mock.calls.length + readPageMock.mock.calls.length,
  };
}

function agentInput(model: ModelClient, session: ReturnType<typeof fakeSession>) {
  return { scope: "professional" as const, question: "Coremail AI 是什么？", model, session };
}

describe("runKnowledgeAgent", () => {
  it("never exceeds eight model turns or four retrieval actions", async () => {
    const model = scriptedAgentModel(Array.from({ length: 8 }, (_, index) => search(`query-${index}`)));
    const session = fakeSession({ alwaysNew: true });

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBeLessThanOrEqual(8);
    expect(session.totalToolCalls()).toBeLessThanOrEqual(4);
    expect(result.status).toBe("temporarily_unavailable");
  });

  it("rejects an exact duplicate and forces the next turn to final", async () => {
    const model = scriptedAgentModel([
      search("Coremail AI"),
      search("Coremail AI"),
      final("none"),
    ]);
    const session = fakeSession();

    await runKnowledgeAgent(agentInput(model, session));

    expect(session.search).toHaveBeenCalledTimes(1);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    const finalPayload = JSON.parse(model.prompts.at(-1)?.at(-1)?.content ?? "null") as {
      finalOnly?: boolean;
    };
    expect(finalPayload.finalOnly).toBe(true);
  });

  it("forces final after two consecutive no-gain actions", async () => {
    const model = scriptedAgentModel([
      search("first"),
      search("second"),
      search("third"),
      final("none"),
    ]);

    await runKnowledgeAgent(agentInput(model, fakeSession()));

    expect(model.lastSchemaName()).toBe("pse_final_action");
  });

  it("uses final-only on turn eight", async () => {
    const invalid = () => new InvalidModelPayloadError();
    const model = scriptedAgentModel([
      invalid(), search("one"), invalid(), search("two"), invalid(), search("three"), invalid(), final("none"),
    ]);

    await runKnowledgeAgent(agentInput(model, fakeSession({ alwaysNew: true })));

    expect(model.calls).toBe(8);
    expect(model.lastSchemaName()).toBe("pse_final_action");
  });

  it("removes tools after the fourth retrieval", async () => {
    const model = scriptedAgentModel([
      search("one"), search("two"), search("three"), search("four"), final("none"),
    ]);

    await runKnowledgeAgent(agentInput(model, fakeSession({ alwaysNew: true })));

    expect(model.lastSchemaName()).toBe("pse_final_action");
  });

  it("records one invalid action as a bounded observation", async () => {
    const model = scriptedAgentModel([new InvalidModelPayloadError(), final("none")]);

    await runKnowledgeAgent(agentInput(model, fakeSession()));

    expect(model.prompts[1]?.some((message) => message.content.includes("invalid_model_payload"))).toBe(true);
  });

  it("returns unavailable after two consecutive invalid actions", async () => {
    const model = scriptedAgentModel([new InvalidModelPayloadError(), new InvalidModelPayloadError()]);

    const result = await runKnowledgeAgent(agentInput(model, fakeSession()));

    expect(model.calls).toBe(2);
    expect(result.status).toBe("temporarily_unavailable");
  });

  it("allows exactly one repair attempt for invalid citations", async () => {
    const badFinal = final("complete", "未经读取的结论[1]", [1]);
    const model = scriptedAgentModel([badFinal, badFinal]);

    const result = await runKnowledgeAgent(agentInput(model, fakeSession()));

    expect(model.calls).toBe(2);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(result.status).toBe("temporarily_unavailable");
  });

  it("never answers a covered final without a read-page reference", async () => {
    const model = scriptedAgentModel([
      final("complete", "未经读取的结论[1]", [1]),
      final("none", "当前资料未覆盖该问题", []),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, fakeSession()));

    expect(result.status).toBe("not_covered");
    expect(result.references).toEqual([]);
  });

  it("returns unavailable for invalid citations on turn eight", async () => {
    const invalid = () => new InvalidModelPayloadError();
    const model = scriptedAgentModel([
      invalid(), search("one"), invalid(), search("two"), invalid(), search("three"), invalid(),
      final("complete", "未经读取的结论[1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, fakeSession({ alwaysNew: true })));

    expect(model.calls).toBe(8);
    expect(result.status).toBe("temporarily_unavailable");
  });
});
