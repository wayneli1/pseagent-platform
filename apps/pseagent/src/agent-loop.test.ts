import { describe, expect, it, vi } from "vitest";
import type { AgentAction, KnowledgePlan } from "./contracts.js";
import {
  InvalidCoverageVerificationError,
  type CoverageVerifierInput,
} from "./coverage-verifier.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import { runKnowledgeAgent } from "./agent-loop.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
  type ModelMessage,
} from "./model-client.js";
import { KNOWLEDGE_AGENT_SYSTEM_PROMPT } from "./prompts.js";
import { NOT_COVERED_TEXT } from "./response.js";

const revision = "a".repeat(40);
const hash = "b".repeat(64);

function plannedEvidence(
  ...texts: string[]
): Pick<KnowledgePlan["requirements"][number], "evidenceAspects" | "queries"> {
  return {
    evidenceAspects: [{
      id: "A1",
      label: "测试证据面",
      terms: ["测试证据"],
    }],
    queries: texts.map((text) => ({ text, aspectIds: ["A1"] })),
  };
}

it("puts requirement-bound strict knowledge action shapes in the model prompt", () => {
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.search","input":{"requirementId":"R1","query":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.read_page","input":{"requirementId":"R1","path":"..."}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.read_pages","input":{"pages":[{"requirementId":"R1","path":"..."},{"requirementId":"R2","path":"..."}]}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"tool","tool":"kb.graph","input":{"requirementId":"R1","path":"...","topK":5}}',
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    '{"action":"final","requirements":[{"id":"R1","coverage":"none","answer":"正式知识库未提及目标协议，无法确认是否支持。","citations":[],"relatedContext":[{"statement":"正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1][2]。","citations":[1,2]}]}],"citations":[1,2]}',
  );
});

it("defines evidence-bounded adaptive answer depth in the knowledge prompt", () => {
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("在已读取的知识证据范围内充分回答用户问题");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("事实查询应直接、简洁地回答");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain("方法类问题应说明关键步骤和注意事项");
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "必须显式覆盖证据中的主要能力、测试方式、评分或高权重项、合规门槛和结论限制",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "禁止用“见引用”“如某页所列”“参考资料”或仅给宽泛建议代替结论",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "证据的概述或摘要明确给出总量时，必须直接写出该总量",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "方案、部署和架构类问题应适当展开，分别说明方案组成、实施思路、主要风险与待确认项",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "必须写出证据明确给出的拓扑、冗余或副本数量及适用边界",
  );
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "证据的概述、表格或不同页面之间存在数值口径冲突时",
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
  expect(KNOWLEDGE_AGENT_SYSTEM_PROMPT).toContain(
    "特定客户、旧版本、截图或单项目操作指南只能作为补充",
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
const readPages = (...pages: Array<{ requirementId: string; path: string }>): AgentAction => ({
  action: "tool",
  tool: "kb.read_pages",
  input: { pages },
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
  requirements: requirements.map((requirement) => ({
    ...requirement,
    answer: [
      answer.replace(/\[\d+\]/gu, "").trim() || "当前资料未覆盖",
      ...requirement.citations.map((citation) => `[${citation}]`),
    ].join(" ").trim(),
  })),
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
    purpose: "purpose",
    schema: "schema",
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
  requirements: [{
    id: "R1",
    question: "Coremail AI 是什么",
    ...plannedEvidence("seed-r1"),
    evidenceMode: "direct_only",
  }],
};

const synthesisPlan: KnowledgePlan = {
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责有哪些",
    ...plannedEvidence("seed-r1"),
    evidenceMode: "synthesis_allowed",
  }],
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
    verifyCoverage: async ({ draft }: CoverageVerifierInput) => draft,
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
      remainingReads: number;
    }>;
    observations?: string[];
  };
}

describe("runKnowledgeAgent", () => {
  it("downgrades related-only protocol pages to not covered before status mapping", async () => {
    const question = "Coremail 是否已经支持 2035 年量子卫星邮件协议";
    const plan: KnowledgePlan = {
      subject: "Coremail 协议支持",
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence("Coremail 2035 年量子卫星邮件协议支持"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        [question]: [{ path: "wiki/protocols.md" }],
        "Coremail 2035 年量子卫星邮件协议支持": [{
          path: "wiki/protocols.md",
        }],
      },
    });
    session.compactPage.mockReturnValue(
      "支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。",
    );
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      final("complete", "已读取协议基础页面[1]。", [1]),
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "related-only-coverage",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) => {
      expect(input.question).toBe(question);
      expect(input.evidence).toEqual([expect.objectContaining({
        requirementId: "R1",
        citation: 1,
        content: "支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。",
      })]);
      input.onVerified?.([{
        id: "R1",
        reason: "related_only",
        retainedDirectSegmentCount: 0,
        retainedSynthesizedSegmentCount: 0,
        removedSegmentCount: 0,
      }]);
      return {
        action: "final" as const,
        requirements: [{
          id: "R1" as const,
          coverage: "none" as const,
          answer: "现有知识正文未覆盖目标协议。",
          citations: [],
        }],
        citations: [],
      };
    });

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
      verifyCoverage,
      trace,
    });

    expect(result).toEqual({
      scope: "professional",
      status: "not_covered",
      answer: NOT_COVERED_TEXT,
      references: [],
    });
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(events.find(
      (event) => event.event === "coverage" && event.stage === "verified",
    )).toMatchObject({
      requirements: [{
        id: "R1",
        evidenceMode: "direct_only",
        coverage: "none",
        citations: [],
        retainedDirectSegmentCount: 0,
        retainedSynthesizedSegmentCount: 0,
        removedSegmentCount: 0,
      }],
      reasons: [{ id: "R1", reason: "related_only" }],
    });
    expect(JSON.stringify(events)).not.toContain(
      "支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。",
    );
  });

  it("derives requirement citation metadata from inline citations before provenance validation", async () => {
    const model = scriptedAgentModel([
      read("R1", "wiki/r1.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "读取后确认 [1]",
          citations: [],
        }],
        citations: [],
      },
    ]);
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
    });

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(result).toMatchObject({
      status: "answered",
      references: [{ index: 1, path: "wiki/r1.md" }],
    });
  });

  it("passes related-context citations through final normalization, verifier evidence, and diagnostics", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/protocols.md" }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式资料未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1]。",
            citations: [1],
          }],
        }],
        citations: [],
      },
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "related-context-evidence",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) => {
      expect(input.draft).toMatchObject({
        requirements: [{ citations: [], relatedContext: [{ citations: [1] }] }],
        citations: [1],
      });
      expect(input.evidence).toEqual([expect.objectContaining({
        requirementId: "R1",
        citation: 1,
      })]);
      return input.draft;
    });

    await runKnowledgeAgent({
      ...agentInput(model, session),
      verifyCoverage,
      trace,
    });

    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.event === "coverage")).toEqual([
      expect.objectContaining({ stage: "draft", citations: [1] }),
      expect.objectContaining({ stage: "verified", citations: [1] }),
    ]);
  });

  it("keeps an omitted quantum-satellite target separate from cited related protocols", async () => {
    const question = "Coremail 是否已经支持 2035 年量子卫星邮件协议？";
    const plan: KnowledgePlan = {
      subject: "Coremail 协议支持",
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence("Coremail 2035 年量子卫星邮件协议支持"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: { "Coremail 2035 年量子卫星邮件协议支持": [{ path: "wiki/protocols.md" }] },
    });
    session.compactPage.mockReturnValue("支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。");
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式知识库未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: "正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1]。",
            citations: [1],
          }],
        }],
        citations: [1],
      },
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) => {
      expect(input.draft).toMatchObject({
        requirements: [{
          id: "R1",
          coverage: "none",
          citations: [],
          relatedContext: [{
            statement: "正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1]。",
            citations: [1],
          }],
        }],
        citations: [1],
      });
      expect(input.evidence).toEqual([expect.objectContaining({
        requirementId: "R1",
        citation: 1,
        path: "wiki/protocols.md",
        content: "支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。",
      })]);
      return input.draft;
    });

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
      verifyCoverage,
    });

    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.status).toBe("not_covered");
    expect(result.status).not.toBe("temporarily_unavailable");
    expect(result.answer).toContain("正式知识库相关信息：");
    expect(result.answer).toContain(
      "正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1]。",
    );
    expect(result.answer).toContain("覆盖结论：");
    expect(result.answer).toContain(
      "正式知识库未提及用户询问的目标协议、功能或能力，无法根据正式知识库确认是否支持或兼容。",
    );
    expect(result.references).toEqual([expect.objectContaining({
      index: 1,
      title: "wiki/protocols.md",
      path: "wiki/protocols.md",
    })]);
  });

  it("rejects invalid audited related context after the quantum-satellite verifier", async () => {
    const question = "Coremail 是否已经支持 2035 年量子卫星邮件协议？";
    const plan: KnowledgePlan = {
      subject: "Coremail 协议支持",
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence("Coremail 2035 年量子卫星邮件协议支持"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: { "Coremail 2035 年量子卫星邮件协议支持": [{ path: "wiki/protocols.md" }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式知识库未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: "正文明确列出 SMTP、POP3、IMAP 协议能力 [1]。",
            citations: [1],
          }],
        }],
        citations: [1],
      },
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "quantum-invalid-audited-related",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const verifyCoverage = vi.fn(async () => ({
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "none" as const,
        answer: "正式知识库未提及目标协议，无法确认是否支持。",
        citations: [],
        relatedContext: [{
          statement: "正文明确列出 SMTP、POP3、IMAP 协议能力。",
          citations: [1],
        }],
      }],
      citations: [1],
    }));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
      verifyCoverage,
      trace,
    });

    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.status).toBe("not_covered");
    expect(events).toContainEqual(expect.objectContaining({
      event: "validation",
      result: "rejected",
      reason: "related_citation_metadata_mismatch",
    }));
    expect(events).toContainEqual({
      event: "fallback",
      reason: "coverage_verifier_invalid",
      outcome: "not_covered",
    });
  });

  it("normalizes target citations out of an uncovered draft without rejecting the answer", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/protocols.md" }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式资料未覆盖目标协议，但模型错误附带了目标引用 [1]。",
          citations: [1],
          relatedContext: [{
            statement: "正文明确列出 SMTP、POP3 和 IMAP [1]。",
            citations: [1],
          }],
        }],
        citations: [1],
      },
    ]);
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => {
      expect(draft).toMatchObject({
        requirements: [{
          coverage: "none",
          answer: "现有资料未覆盖该要求，无法根据正式知识库确认。",
          citations: [],
          relatedContext: [{ citations: [1] }],
        }],
        citations: [1],
      });
      return draft;
    });

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      verifyCoverage,
    });

    expect(result.status).toBe("not_covered");
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.references).toHaveLength(1);
  });

  it.each([
    ["removes every marker", "资料明确列出 SMTP、POP3 和 IMAP 协议能力。"],
    ["expands one metadata citation to five markers", "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2][3][4][5]。"],
  ])("drops a malformed optional related item when normalization %s", async (_name, statement) => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/protocols.md" }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/protocols.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式资料未提及目标协议，无法确认是否支持。",
          citations: [],
          relatedContext: [{ statement, citations: [1] }],
        }],
        citations: [],
      },
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "normalized-related-citation-count",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => draft);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      verifyCoverage,
      trace,
    });

    expect(result.status).toBe("not_covered");
    expect(result.references).toEqual([]);
    expect(verifyCoverage).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        requirements: [expect.not.objectContaining({
          relatedContext: expect.anything(),
        })],
        citations: [],
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "validation",
      result: "rejected",
    }));
  });

  it("automatically searches every seed query and fuses candidates with RRF", async () => {
    const plan: KnowledgePlan = {
      subject: "网关",
      requirements: [{
        id: "R1",
        question: "网关功能和 POC",
        ...plannedEvidence("功能查询", "POC 查询"),
        evidenceMode: "direct_only",
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

    expect(session.search).toHaveBeenCalledTimes(3);
    expect(session.search).toHaveBeenCalledWith("测试问题", 10, undefined);
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

  it("shares candidates from the original full-question search with every requirement", async () => {
    const session = fakeSession({
      hits: {
        "测试问题": [{ path: "wiki/concepts/full-question-hit.md" }],
        "seed-r1": [],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/full-question-hit.md"),
      final("complete", "完整问题召回了证据[1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]).toMatchObject({
      path: "wiki/concepts/full-question-hit.md",
      sourceQueries: ["测试问题"],
    });
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/concepts/full-question-hit.md",
      undefined,
    );
    expect(result.status).toBe("answered");
  });

  it("adds controlled lexical variants for seed-query wording gaps", async () => {
    const plan: KnowledgePlan = {
      subject: "网关 POC",
      requirements: [{
        id: "R1",
        question: "POC 注意事项",
        ...plannedEvidence("POC测试关键注意事项 范围控制 压测 资源建议 信创"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "POC测试关键注意事项 范围控制 压测 资源建议 信创": [{
          path: "wiki/concepts/broad-poc.md",
          title: "安全网关信创 POC 售前口径要点",
        }],
        "POC测试要点": [{
          path: "wiki/concepts/gateway-poc.md",
          title: "网关POC测试要点",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/gateway-poc.md"),
      final("complete", "POC 要点[1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledWith(
      "POC测试关键注意事项 范围控制 压测 资源建议 信创",
      10,
      undefined,
    );
    expect(session.search).toHaveBeenCalledWith("POC测试要点", 10, undefined);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/gateway-poc.md");
    expect(result.status).toBe("answered");
  });

  it("adds a tool-focused seed query for migration execution questions", async () => {
    const plan: KnowledgePlan = {
      subject: "Domino 迁移",
      requirements: [{
        id: "R1",
        question: "Domino 迁移执行步骤",
        ...plannedEvidence("Domino 迁移 Coremail 执行步骤"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "Domino 迁移 Coremail 执行步骤": [],
        "Domino 迁移 Coremail 工具": [{
          path: "wiki/entities/Coremail迁移工具-migrateX.md",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/entities/Coremail迁移工具-migrateX.md"),
      final("complete", "使用 migrateX 执行迁移 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledWith(
      "Domino 迁移 Coremail 工具",
      10,
      undefined,
    );
    expect(result.status).toBe("answered");
  });

  it("ranks curated knowledge pages ahead of query indexes and raw source pages", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/queries/query-index.md" },
          { path: "wiki/sources/raw.md" },
          { path: "wiki/concepts/curated.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/curated.md"),
      final("complete", "结论[1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/curated.md");
  });

  it("ranks a title covering more requirement terms ahead of a broader RRF result", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 镜像同步",
      requirements: [{
        id: "R1",
        question: "镜像同步机制在多活和容灾场景中如何实现",
        ...plannedEvidence(
          "Coremail 镜像 同步 机制 多活 容灾",
          "镜像 多活 容灾 规划",
        ),
        evidenceMode: "synthesis_allowed",
      }],
    };
    const session = fakeSession({
      hits: {
        "Coremail 镜像 同步 机制 多活 容灾": [
          {
            path: "wiki/synthesis/general.md",
            title: "邮件系统多活与容灾设计",
          },
          {
            path: "wiki/concepts/mirror-sync.md",
            title: "镜像系统同步机制",
          },
        ],
        "镜像 多活 容灾 规划": [{
          path: "wiki/synthesis/general.md",
          title: "邮件系统多活与容灾设计",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/mirror-sync.md"),
      final("complete", "实时、强制和定时同步 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/mirror-sync.md");
  });

  it("ranks a product entity first for an overall capability requirement", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 安全网关",
      requirements: [{
        id: "R1",
        question: "Coremail 安全网关有哪些核心能力",
        ...plannedEvidence("Coremail 安全网关核心能力", "CACTER邮件安全网关功能"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "Coremail 安全网关核心能力": [
          {
            path: "wiki/concepts/gateway-test.md",
            title: "Coremail 安全网关核心能力专项测试",
          },
          {
            path: "wiki/entities/gateway.md",
            title: "CACTER 邮件安全网关",
          },
        ],
        "CACTER邮件安全网关功能": [{
          path: "wiki/concepts/gateway-test.md",
          title: "Coremail 安全网关核心能力专项测试",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/entities/gateway.md"),
      final("complete", "网关核心能力 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/entities/gateway.md");
  });

  it("uses dynamic per-requirement budgets instead of a global four-action cap", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "功能", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "POC", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
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
    expect(session.totalToolCalls()).toBe(9);
    expect(result.status).toBe("answered");
    expect(result.references.map((reference) => reference.path)).toEqual(["wiki/r1.md", "wiki/r2.md"]);
  });

  it("reads one candidate per requirement in parallel with a single model action", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "容量", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "多活", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
        { id: "R3", question: "同步", ...plannedEvidence("seed-r3"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1.md" }],
        "seed-r2": [{ path: "wiki/r2.md" }],
        "seed-r3": [{ path: "wiki/r3.md" }],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: "wiki/r1.md" },
        { requirementId: "R2", path: "wiki/r2.md" },
        { requirementId: "R3", path: "wiki/r3.md" },
      ),
      final("complete", "容量[1]，多活[2]，同步[3]", [1, 2, 3], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [2] },
        { id: "R3", coverage: "complete", citations: [3] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(model.calls).toBe(2);
    expect(session.readPage).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("answered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/r1.md",
      "wiki/r2.md",
      "wiki/r3.md",
    ]);
  });

  it("reads up to two pages per requirement and defers the rest to a later turn", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/one.md" },
          { path: "wiki/two.md" },
          { path: "wiki/three.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: "wiki/one.md" },
        { requirementId: "R1", path: "wiki/two.md" },
        { requirementId: "R1", path: "wiki/three.md" },
      ),
      read("R1", "wiki/three.md"),
      final("complete", "联合证据[1][2][3]", [1, 2, 3]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(3);
    expect(session.readPage).toHaveBeenCalledTimes(3);
    expect(payloadAt(model, 1).observations?.join("\n"))
      .toContain("batch_read_deferred_for_requirement");
    expect(result.status).toBe("answered");
  });

  it("keeps the per-requirement read budget when a batch contains too many pages", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/one.md" },
          { path: "wiki/two.md" },
          { path: "wiki/three.md" },
          { path: "wiki/four.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: "wiki/one.md" },
        { requirementId: "R1", path: "wiki/two.md" },
      ),
      readPages(
        { requirementId: "R1", path: "wiki/two.md" },
        { requirementId: "R1", path: "wiki/three.md" },
      ),
      readPages(
        { requirementId: "R1", path: "wiki/three.md" },
        { requirementId: "R1", path: "wiki/four.md" },
      ),
      read("R1", "wiki/four.md"),
      final("complete", "三页证据[1][2][3]", [1, 2, 3]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(session.readPage).toHaveBeenCalledTimes(3);
    expect(result.references).toHaveLength(3);
    expect(result.status).toBe("answered");
  });

  it("reads up to six distinct pages for a synthesis requirement", async () => {
    const paths = Array.from(
      { length: 7 },
      (_, index) => `wiki/duty-${index + 1}.md`,
    );
    const session = fakeSession({
      hits: {
        "seed-r1": paths.map((path) => ({ path })),
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: paths[0]! },
        { requirementId: "R1", path: paths[1]! },
      ),
      readPages(
        { requirementId: "R1", path: paths[2]! },
        { requirementId: "R1", path: paths[3]! },
      ),
      readPages(
        { requirementId: "R1", path: paths[4]! },
        { requirementId: "R1", path: paths[5]! },
      ),
      read("R1", paths[6]!),
      final("complete", "六页正式资料共同支持职责归纳", [1, 2, 3, 4, 5, 6]),
    ]);

    const result = await runKnowledgeAgent(
      agentInput(model, session, synthesisPlan),
    );

    expect(session.readPage).toHaveBeenCalledTimes(6);
    expect(payloadAt(model, 3).requirementEvidence?.[0]?.remainingReads).toBe(0);
    expect(result.references.map((reference) => reference.path)).toEqual(
      paths.slice(0, 6),
    );
  });

  it("rejects reading a candidate through a different requirement", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "功能", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "POC", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
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

  it("shares one read citation only with other requirements that retrieved the same page", async () => {
    const plan: KnowledgePlan = {
      subject: "共享证据",
      requirements: [
        { id: "R1", question: "架构", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "容灾", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/shared.md" }],
        "seed-r2": [{ path: "wiki/shared.md" }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/shared.md"),
      final("complete", "架构和容灾均由同页支持[1]", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledOnce();
    expect(payloadAt(model, 1).requirementEvidence?.[1]?.citationIndexes).toEqual([1]);
    expect(payloadAt(model, 1).observations?.join("\n")).toContain("evidence_shared");
    expect(result.status).toBe("answered");
  });

  it("audits a final answer against evidence read for another requirement", async () => {
    const plan: KnowledgePlan = {
      subject: "跨需求终稿引用",
      requirements: [
        { id: "R1", question: "机会判断框架", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "客户证据维度", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1.md" }],
        "seed-r2": [{ path: "wiki/r2.md" }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/r1.md"),
      read("R2", "wiki/r2.md"),
      final("complete", "机会判断同时需要客户证据 [1][2]。", [1, 2], [
        { id: "R1", coverage: "complete", citations: [1, 2] },
        { id: "R2", coverage: "complete", citations: [2] },
      ]),
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "cross-requirement-final-evidence",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      trace,
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: "evidence_shared",
      fromRequirementId: "R2",
      toRequirementId: "R1",
      citation: 2,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "validation",
      result: "rejected",
    }));
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(2);
  });

  it("does not charge shared evidence against the target requirement's direct-read budget", async () => {
    const plan: KnowledgePlan = {
      subject: "共享证据预算",
      requirements: [
        { id: "R1", question: "共享事实", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "三个独立事实", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/shared.md" }],
        "seed-r2": [
          { path: "wiki/shared.md" },
          { path: "wiki/r2-a.md" },
          { path: "wiki/r2-b.md" },
          { path: "wiki/r2-c.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/shared.md"),
      read("R2", "wiki/r2-a.md"),
      read("R2", "wiki/r2-b.md"),
      read("R2", "wiki/r2-c.md"),
      final("complete", "共享事实[1]，三个独立事实[2][3][4]", [1, 2, 3, 4], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1, 2, 3, 4] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledTimes(4);
    expect(payloadAt(model, 1).requirementEvidence?.[1]?.remainingReads).toBe(3);
    expect(result.status).toBe("answered");
  });

  it("does not consume another requirement's read budget for a global-only candidate", async () => {
    const plan: KnowledgePlan = {
      subject: "全局召回",
      requirements: [
        { id: "R1", question: "环境", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "步骤", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "测试问题": [{ path: "wiki/global-only.md" }],
        "seed-r1": [],
        "seed-r2": [],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/global-only.md"),
      read("R2", "wiki/global-only.md"),
      final("complete", "环境和步骤都由同一页支持[1]", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 1).requirementEvidence?.[1]?.citationIndexes).toEqual([]);
    expect(session.readPage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("answered");
  });

  it("stops a no-gain requirement without preventing evidence reads for another", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "不存在的资料", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "已有资料", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
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

    expect(session.search).toHaveBeenCalledTimes(2);
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

  it("does not accept partial while a requirement still has unread candidates and read budget", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/concepts/first.md" },
          { path: "wiki/concepts/second.md" },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/first.md"),
      final("partial", "当前仅确认部分内容[1]，其余待确认。", [1]),
      read("R1", "wiki/concepts/second.md"),
      final("complete", "两页共同确认[1][2]", [1, 2]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "coverage_gate_requires_read",
    );
    expect(session.readPage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("answered");
  });

  it("continues the synthesis coverage gate after three reads when a fourth candidate remains", async () => {
    const paths = [
      "wiki/duty-diagnosis.md",
      "wiki/duty-solution.md",
      "wiki/duty-demo.md",
      "wiki/duty-opportunity.md",
    ];
    const session = fakeSession({
      hits: {
        "seed-r1": paths.map((path) => ({ path })),
      },
    });
    const model = scriptedAgentModel([
      read("R1", paths[0]!),
      read("R1", paths[1]!),
      read("R1", paths[2]!),
      final("partial", "三类职责已经确认", [1, 2, 3]),
      read("R1", paths[3]!),
      final("complete", "四类职责共同构成归纳", [1, 2, 3, 4]),
    ]);

    const result = await runKnowledgeAgent(
      agentInput(model, session, synthesisPlan),
    );

    expect(payloadAt(model, 4).observations?.join("\n")).toContain(
      "coverage_gate_requires_read",
    );
    expect(session.readPage).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("answered");
  });

  it("nudges once per direct-read count before auditing a repeated none final", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/concepts/first.md" },
          { path: "wiki/concepts/second.md" },
          { path: "wiki/concepts/third.md" },
        ],
      },
    });
    const repeatedFinal = {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "正式知识库未覆盖目标能力，无法确认。",
        citations: [],
        relatedContext: [{
          statement: "正文明确列出两项相关能力 [1][2]。",
          citations: [1, 2],
        }],
      }],
      citations: [1, 2],
    } satisfies AgentAction;
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/first.md"),
      read("R1", "wiki/concepts/second.md"),
      ...Array.from({ length: 7 }, () => repeatedFinal),
    ]);
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => draft);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "repeated-final-after-evidence-nudge",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      verifyCoverage,
      trace,
    });

    expect({
      status: result.status,
      stops: events.filter((event) => event.event === "stop"),
    }).toEqual({
      status: "not_covered",
      stops: [],
    });
    expect(payloadAt(model, 3).observations?.join("\n")).toContain(
      "coverage_gate_requires_read",
    );
    expect(model.calls).toBe(4);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/concepts/first.md",
      "wiki/concepts/second.md",
    ]);
  });

  it("tracks coverage-gate read counts independently across requirements", async () => {
    const plan: KnowledgePlan = {
      subject: "复合能力",
      requirements: [
        { id: "R1", question: "能力一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "能力二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/r1-first.md" },
          { path: "wiki/r1-second.md" },
          { path: "wiki/r1-third.md" },
        ],
        "seed-r2": [
          { path: "wiki/r2-first.md" },
          { path: "wiki/r2-second.md" },
          { path: "wiki/r2-third.md" },
        ],
      },
    });
    const firstFinal = {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "none",
          answer: "能力一未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "能力一相关正文 [1]。",
            citations: [1],
          }],
        },
        {
          id: "R2",
          coverage: "none",
          answer: "能力二未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "能力二相关正文 [2][3]。",
            citations: [2, 3],
          }],
        },
      ],
      citations: [1, 2, 3],
    } satisfies AgentAction;
    const finalAfterR1Read = {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "none",
          answer: "能力一仍未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "能力一两页相关正文 [1][4]。",
            citations: [1, 4],
          }],
        },
        {
          id: "R2",
          coverage: "none",
          answer: "能力二仍未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "能力二相关正文 [2][3]。",
            citations: [2, 3],
          }],
        },
      ],
      citations: [1, 4, 2, 3],
    } satisfies AgentAction;
    const model = scriptedAgentModel([
      read("R1", "wiki/r1-first.md"),
      readPages(
        { requirementId: "R2", path: "wiki/r2-first.md" },
        { requirementId: "R2", path: "wiki/r2-second.md" },
      ),
      firstFinal,
      read("R1", "wiki/r1-second.md"),
      finalAfterR1Read,
      finalAfterR1Read,
    ]);
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => draft);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(model.calls).toBe(6);
    const gateObservations = (payloadAt(model, 5).observations ?? [])
      .map((observation) => JSON.parse(observation) as {
        type?: string;
        requirements?: string[];
      })
      .filter((observation) => observation.type === "coverage_gate_requires_read");
    expect(gateObservations).toEqual([
      {
        type: "coverage_gate_requires_read",
        requirements: ["R1", "R2"],
      },
      {
        type: "coverage_gate_requires_read",
        requirements: ["R1"],
      },
    ]);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.status).toBe("not_covered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/r1-first.md",
      "wiki/r1-second.md",
      "wiki/r2-first.md",
      "wiki/r2-second.md",
    ]);
  });

  it("drops a cross-requirement related citation after the same-count gate nudge", async () => {
    const plan: KnowledgePlan = {
      subject: "复合能力",
      requirements: [
        { id: "R1", question: "能力一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "能力二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/r1-first.md" },
          { path: "wiki/r1-unread.md" },
        ],
        "seed-r2": [
          { path: "wiki/r2-first.md" },
          { path: "wiki/r2-unread.md" },
        ],
      },
    });
    const invalidFinal = {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "none",
          answer: "能力一未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "错误引用了能力二正文 [2]。",
            citations: [2],
          }],
        },
        {
          id: "R2",
          coverage: "none",
          answer: "能力二未覆盖。",
          citations: [],
          relatedContext: [{
            statement: "能力二相关正文 [2]。",
            citations: [2],
          }],
        },
      ],
      citations: [2],
    } satisfies AgentAction;
    const model = scriptedAgentModel([
      read("R1", "wiki/r1-first.md"),
      read("R2", "wiki/r2-first.md"),
      invalidFinal,
      invalidFinal,
    ]);
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => draft);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "invalid-final-after-evidence-nudge",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
      trace,
    });

    expect(events).not.toContainEqual(expect.objectContaining({
      event: "validation",
      result: "rejected",
    }));
    expect(model.calls).toBe(4);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(verifyCoverage.mock.calls[0]?.[0].draft).toEqual({
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "none",
          answer: "现有资料未覆盖该要求，无法根据正式知识库确认。",
          citations: [],
        },
        {
          ...invalidFinal.requirements[1],
          answer: "现有资料未覆盖该要求，无法根据正式知识库确认。",
        },
      ],
      citations: [2],
    });
    expect(result.status).toBe("not_covered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/r2-first.md",
    ]);
  });

  it("emits a content-free search-to-coverage diagnostic trail", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/r1.md"),
      final("complete", "读取后确认[1]", [1]),
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "trace-1",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    await runKnowledgeAgent({ ...agentInput(model, session), trace });

    expect(events.map((event) => event.event)).toEqual([
      "search",
      "search",
      "candidates",
      "read",
      "coverage",
      "coverage",
    ]);
    expect(events.find((event) => event.event === "read")).toMatchObject({
      requirementId: "R1",
      path: "wiki/r1.md",
      citation: 1,
    });
    expect(events.filter((event) => event.event === "coverage")).toEqual([
      expect.objectContaining({ stage: "draft" }),
      expect.objectContaining({ stage: "verified" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("body:wiki/r1.md");
    expect(JSON.stringify(events)).not.toContain("读取后确认");
  });

  it.each([
    [
      new ModelUnavailableError(),
      "coverage_verifier_unavailable",
      "temporarily_unavailable",
      "stop",
    ],
    [
      new InvalidCoverageVerificationError(),
      "coverage_verifier_invalid",
      "not_covered",
      "fallback",
    ],
  ] as const)(
    "fails closed when coverage verification fails with %s",
    async (error, reason, expectedStatus, expectedEvent) => {
      const session = fakeSession({
        hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
      });
      const model = scriptedAgentModel([
        read("R1", "wiki/r1.md"),
        final("complete", "正式草稿[1]。", [1]),
      ]);
      const events: DiagnosticEvent[] = [];
      const trace = {
        requestId: "coverage-failure",
        record(event: DiagnosticEvent) {
          events.push(event);
        },
      } satisfies DiagnosticTrace;

      const result = await runKnowledgeAgent({
        ...agentInput(model, session),
        trace,
        verifyCoverage: async () => {
          throw error;
        },
      });

      expect(result.status).toBe(expectedStatus);
      expect(events).toContainEqual(expect.objectContaining({
        event: expectedEvent,
        reason,
      }));
    },
  );

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

  it("repairs one invalid action with an explicit schema instruction", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(
        "invalid_schema:requirements.0.relatedContext.1.citations:too_small",
      ),
      final("none", "当前资料未覆盖该问题"),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.prompts[1]?.at(-1)?.content).toContain("上一次输出不符合 Schema");
    expect(model.prompts[1]?.at(-1)?.content).toContain(
      "requirements.0.relatedContext.1.citations:too_small",
    );
    expect(model.calls).toBe(2);
    expect(result.status).toBe("not_covered");
  });

  it("falls back to not covered after two explicit action repair attempts remain invalid", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(),
      new InvalidModelPayloadError(),
      new InvalidModelPayloadError(),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(3);
    expect(result.status).toBe("not_covered");
  });

  it("recovers from exhausted action repairs by reading the best seed candidate", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [{
          path: "wiki/concepts/愿景演示与技术证明的区分.md",
          title: "愿景演示与技术证明的区分",
        }],
      },
    });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      final("complete", "售前需要完成愿景演示与技术证明[1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, synthesisPlan));

    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/concepts/愿景演示与技术证明的区分.md",
      undefined,
    );
    expect(model.calls).toBe(4);
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(1);
  });

  it("retries a final-only turn when action repairs fail after evidence was read", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/evidence.md", title: "正式证据" }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/evidence.md"),
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      new InvalidModelPayloadError("invalid_json", "{\"action\":", "pse_agent_action", "abort"),
      final("complete", "正式证据支持该结论[1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(5);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(1);
  });

  it("reads a missing presales duty facet before accepting a complete synthesis", async () => {
    const question = "售前工程师的工作职责有哪些？";
    const session = fakeSession({
      hits: {
        "seed-r1": [
          {
            path: "wiki/synthesis/售前诊断式对话框架.md",
            title: "售前诊断式对话框架",
          },
          {
            path: "wiki/concepts/可信顾问.md",
            title: "可信顾问",
          },
        ],
      },
    });
    const completeAnswer = [
      "需求诊断[1]",
      "方案组织[1]",
      "产品演示与技术证明[1]",
      "客户关系与可信顾问[2]",
      "冲突沟通与异议处理[1]",
      "机会管理与项目推进[1]",
    ].join("；");
    const model = scriptedAgentModel([
      read("R1", "wiki/synthesis/售前诊断式对话框架.md"),
      final("complete", "需求诊断、方案组织、产品演示、冲突沟通与机会管理[1]。", [1]),
      final("complete", completeAnswer, [1, 2]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, synthesisPlan),
      scope: "general",
      question,
    });

    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/concepts/可信顾问.md",
      undefined,
    );
    expect(model.calls).toBe(3);
    expect(result.status).toBe("answered");
    expect(result.answer).toContain("客户关系与可信顾问");
  });

  it("preloads all six observed presales duty facets before asking for synthesis", async () => {
    const question = "售前工程师的工作职责有哪些？";
    const query1 = "售前工程师工作职责 售前方法论 岗位职责归纳";
    const query2 = "愿景演示 技术证明 解决方案销售 需求诊断 可信顾问";
    const query3 = "机会质量 客户证据 售前冲突沟通场景集";
    const plan: KnowledgePlan = {
      subject: "售前职责",
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence(query1, query2, query3),
        evidenceMode: "synthesis_allowed",
      }],
    };
    const pages = [
      { path: "wiki/synthesis/售前诊断式对话框架.md", title: "售前诊断式对话框架" },
      { path: "wiki/concepts/解决方案销售.md", title: "解决方案销售" },
      { path: "wiki/concepts/愿景演示与技术证明的区分.md", title: "愿景演示与技术证明的区分" },
      { path: "wiki/concepts/可信顾问.md", title: "可信顾问" },
      { path: "wiki/synthesis/售前冲突沟通场景集.md", title: "售前冲突沟通场景集" },
      { path: "wiki/concepts/机会质量与客户证据.md", title: "机会质量与客户证据" },
    ];
    const session = fakeSession({
      hits: {
        [query1]: pages.slice(0, 2),
        [query2]: pages.slice(2, 4),
        [query3]: pages.slice(4),
      },
    });
    const model = scriptedAgentModel([
      final(
        "complete",
        [
          "需求诊断[1]",
          "方案组织[2]",
          "产品演示与技术证明[3]",
          "客户关系与可信顾问[4]",
          "冲突沟通与异议处理[5]",
          "机会管理与项目推进[6]",
        ].join("；"),
        [1, 2, 3, 4, 5, 6],
      ),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      scope: "general",
      question,
    });

    expect(session.readPage).toHaveBeenCalledTimes(6);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.citationIndexes)
      .toHaveLength(6);
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(6);
  });

  it("requests a shorter closed JSON after the provider aborts a payload", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(
        "invalid_json",
        "{\"action\":\"final\"",
        "pse_agent_action",
        "abort",
      ),
      final("none", "当前资料未覆盖该问题"),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.prompts[1]?.at(-1)?.content).toContain("finish_reason=abort");
    expect(model.prompts[1]?.at(-1)?.content).toContain("600 个汉字以内");
    expect(model.calls).toBe(2);
    expect(result.status).toBe("not_covered");
  });

  it("allows exactly one repair attempt for invalid citations", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const badFinal = final("complete", "未经读取的结论[1]", [1]);
    const model = scriptedAgentModel([badFinal, badFinal]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(2);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(result.status).toBe("not_covered");
  });

  it("normalizes harmless top-level citation ordering before strict validation", async () => {
    const plan: KnowledgePlan = {
      subject: "复合问题",
      requirements: [
        { id: "R1", question: "功能", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "POC", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1.md" }],
        "seed-r2": [{ path: "wiki/r2.md" }],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: "wiki/r1.md" },
        { requirementId: "R2", path: "wiki/r2.md" },
      ),
      final("complete", "功能[1]，POC[2]", [2, 1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [2] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(model.calls).toBe(2);
    expect(result.status).toBe("answered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/r1.md",
      "wiki/r2.md",
    ]);
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
