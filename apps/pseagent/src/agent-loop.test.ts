import { describe, expect, it, vi } from "vitest";
import type { AgentAction, FinalAction, KnowledgePlan } from "./contracts.js";
import {
  inferCoverageVerificationReport,
  InvalidCoverageVerificationError,
  notCoveredRequirementAnswer,
  type CoverageVerifierInput,
} from "./coverage-verifier.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import {
  readLimitFor,
  runKnowledgeAgent,
  runKnowledgeAgentDetailed,
} from "./agent-loop.js";
import { formatKnowledgeFinal } from "./response.js";
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
    '{"action":"tool","tool":"kb.search","input":{"requirementId":"R1","query":"...","aspectIds":["A1"],"topK":5}}',
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
  input: { requirementId, query, aspectIds: ["A1"], topK },
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
  readonly snippet?: string;
};

function fakeSession(options: {
  readonly hits?: Readonly<Record<string, readonly SearchFixture[]>>;
  readonly graphHits?: readonly SearchFixture[];
  readonly failAllSearches?: boolean;
  readonly failedQueries?: readonly string[];
  readonly failedQueryAttempts?: Readonly<Record<string, number>>;
  readonly failGraph?: boolean;
  readonly failedReadPaths?: readonly string[];
  readonly failedReadAttempts?: number;
  readonly pageType?: string;
  readonly pageSources?: readonly string[];
  readonly pageBodies?: Readonly<Record<string, string>>;
} = {}) {
  const remainingFailedQueryAttempts = new Map(
    Object.entries(options.failedQueryAttempts ?? {}),
  );
  const searchMock = vi.fn(async (query: string) => {
    const remainingFailures = remainingFailedQueryAttempts.get(query) ?? 0;
    if (remainingFailures > 0) {
      remainingFailedQueryAttempts.set(query, remainingFailures - 1);
    }
    if (
      options.failAllSearches ||
      options.failedQueries?.includes(query) ||
      remainingFailures > 0
    ) {
      throw new Error("search unavailable");
    }
    const fixtures = options.hits?.[query] ?? [];
    return {
      project: "coremail-professional" as const,
      revision,
      hits: fixtures.map((fixture, index) => ({
        path: fixture.path,
        title: fixture.title ?? fixture.path,
        score: 1 - index / 10,
        matchedTerms: fixture.matchedTerms ?? [query],
        snippet: fixture.snippet ?? `snippet:${query}`,
      })),
    };
  });
  const graphMock = vi.fn(async () => {
    if (options.failGraph) throw new Error("graph unavailable");
    return {
      project: "coremail-professional" as const,
      revision,
      hits: (options.graphHits ?? []).map((fixture) => ({
        path: fixture.path,
        title: fixture.title ?? fixture.path,
        relation: "related",
      })),
    };
  });
  let remainingFailedReadAttempts = options.failedReadAttempts ?? 0;
  const readPageMock = vi.fn(async (path: string) => {
    if (
      options.failedReadPaths?.includes(path) ||
      remainingFailedReadAttempts > 0
    ) {
      remainingFailedReadAttempts = Math.max(0, remainingFailedReadAttempts - 1);
      throw new Error("read unavailable");
    }
    return {
      project: "coremail-professional" as const,
      path,
      title: path,
      type: options.pageType ?? "guide",
      tags: [],
      related: [],
      sources: [...(options.pageSources ?? [])],
      body: options.pageBodies?.[path] ?? `body:${path}`,
      contentHash: hash,
    };
  });
  return {
    project: "coremail-professional" as const,
    revision,
    purpose: "purpose",
    schema: "schema",
    authorizeGovernedPaths: vi.fn(),
    search: searchMock,
    graph: graphMock,
    readPage: readPageMock,
    compactPage: vi.fn((page: { readonly path: string }) =>
      options.pageBodies?.[page.path] ?? "compact page"),
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
    verifyCoverage: async (input: CoverageVerifierInput) =>
      reportAndReturn(input),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}

function reportAndReturn(
  input: CoverageVerifierInput,
  action: FinalAction = input.draft,
): FinalAction {
  input.onReport?.(inferCoverageVerificationReport(action, input.plan));
  return action;
}

function payloadAt(model: ReturnType<typeof scriptedAgentModel>, index: number) {
  return JSON.parse(model.prompts[index]?.at(-1)?.content ?? "null") as {
    finalOnly?: boolean;
    requirementEvidence?: Array<{
      id: string;
      evidenceCondition: {
        requirementId: string;
        inputState: "not_applicable" | "available" | "missing";
        ambiguous: boolean;
        conflictDetected: boolean;
        freshness: "not_assessed" | "current" | "stale_or_unconfirmed";
      };
      candidates: Array<{
        path: string;
        rrfScore: number;
        sourceQueries: string[];
        rankings: Array<{ query: string; rank: number; score: number }>;
        aspectIds: string[];
        read: boolean;
      }>;
      aspects: Array<{
        id: string;
        label: string;
        candidateCount: number;
        readCandidateCount: number;
      }>;
      citationIndexes: number[];
      remainingReads: number;
    }>;
    readEvidence?: Array<{
      requirementId: string;
      citation: number;
      path: string;
      content: string;
      aspectIds: string[];
    }>;
    observations?: string[];
  };
}

describe("runKnowledgeAgent", () => {
  it("keeps coverage-unit seed searches isolated from the global raw question", async () => {
    const plan: KnowledgePlan = {
      subject: "并列对象",
      retrievalStrategy: "coverage_units",
      requirements: [
        {
          id: "R1",
          question: "甲公司的目标方案",
          ...plannedEvidence("甲公司 目标方案"),
          evidenceMode: "direct_only",
        },
        {
          id: "R2",
          question: "乙公司的目标方案",
          ...plannedEvidence("乙公司 目标方案"),
          evidenceMode: "direct_only",
        },
      ],
    };
    const session = fakeSession();
    const model = scriptedAgentModel([
      final("none", "", [], [
        { id: "R1", coverage: "none", citations: [] },
        { id: "R2", coverage: "none", citations: [] },
      ]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search.mock.calls.map(([query]) => query)).toEqual([
      "甲公司 目标方案",
      "乙公司 目标方案",
    ]);
    expect(session.search).not.toHaveBeenCalledWith(
      "测试问题",
      expect.anything(),
      expect.anything(),
    );
  });

  it("records an unavailable seed snapshot for every coverage unit before early return", async () => {
    const plan: KnowledgePlan = {
      subject: "不可用检索",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "对象一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "对象二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "coverage-unit-all-seed-unavailable",
      record(event: DiagnosticEvent) { events.push(event); },
    } satisfies DiagnosticTrace;

    const result = await runKnowledgeAgent({
      ...agentInput(scriptedAgentModel([]), fakeSession({ failAllSearches: true }), plan),
      trace,
    });

    expect(result.status).toBe("temporarily_unavailable");
    expect(events as unknown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "coverage_unit_seed_snapshot",
        reason: "all_seed_unavailable",
        requirements: [
          expect.objectContaining({
            id: "R1",
            seedSearchStatus: "unavailable",
            candidateCount: 0,
            readCandidateCount: 0,
            unreadCandidateCount: 0,
            remainingReads: 3,
          }),
          expect.objectContaining({
            id: "R2",
            seedSearchStatus: "unavailable",
            candidateCount: 0,
            readCandidateCount: 0,
            unreadCandidateCount: 0,
            remainingReads: 3,
          }),
        ],
      }),
    ]));
  });

  it("preloads at most one page per coverage unit before the first model call", async () => {
    const plan: KnowledgePlan = {
      subject: "三个并列对象",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "对象一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "对象二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
        { id: "R3", question: "对象三", ...plannedEvidence("seed-r3"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/r1-first.md" },
          { path: "wiki/r1-second.md" },
          { path: "wiki/r1-third.md" },
        ],
        "seed-r2": [{ path: "wiki/r2.md" }],
        "seed-r3": [{ path: "wiki/r3.md" }],
      },
    });
    const model = scriptedAgentModel([
      final("complete", "三个对象均已确认", [1, 2, 3], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [2] },
        { id: "R3", coverage: "complete", citations: [3] },
      ]),
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "coverage-unit-fair-preload",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      trace,
    });

    expect(session.readPage.mock.calls.map(([path]) => path)).toEqual([
      "wiki/r1-first.md",
      "wiki/r2.md",
      "wiki/r3.md",
    ]);
    expect(payloadAt(model, 0).requirementEvidence?.map((requirement) => ({
      id: requirement.id,
      read: requirement.candidates.filter((candidate) => candidate.read).length,
    }))).toEqual([
      { id: "R1", read: 1 },
      { id: "R2", read: 1 },
      { id: "R3", read: 1 },
    ]);
    const verified = events.find((event) =>
      event.event === "coverage" && event.stage === "verified");
    const r1Diagnostic = (verified as unknown as {
      requirements: Array<{
        id: string;
        candidateCount: number;
        readCandidateCount: number;
        unreadCandidateCount: number;
        remainingReads: number;
      }>;
    }).requirements.find((requirement) => requirement.id === "R1");
    expect(r1Diagnostic).toMatchObject({
      candidateCount: 3,
      readCandidateCount: 1,
      unreadCandidateCount: 2,
      remainingReads: 2,
    });
    expect(result.status).toBe("answered");
  });

  it("deduplicates one targeted page across coverage-unit batch reads", async () => {
    const plan: KnowledgePlan = {
      subject: "共享正式证据",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "对象一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "对象二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/shared.md" }],
        "seed-r2": [{ path: "wiki/shared.md" }],
      },
    });
    const model = scriptedAgentModel([
      final("complete", "同一正式页面分别支持两个对象", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledOnce();
    expect(payloadAt(model, 0).requirementEvidence?.map((requirement) => ({
      id: requirement.id,
      citations: requirement.citationIndexes,
      read: requirement.candidates[0]?.read,
    }))).toEqual([
      { id: "R1", citations: [1], read: true },
      { id: "R2", citations: [1], read: true },
    ]);
    expect(result.status).toBe("answered");
  });

  it("keeps independent coverage-unit seed states in coverage diagnostics", async () => {
    const plan: KnowledgePlan = {
      subject: "不同检索状态",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "有候选", ...plannedEvidence("seed-success"), evidenceMode: "direct_only" },
        { id: "R2", question: "空结果", ...plannedEvidence("seed-empty"), evidenceMode: "direct_only" },
        { id: "R3", question: "检索失败", ...plannedEvidence("seed-failed"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: { "seed-success": [{ path: "wiki/supported.md" }] },
      failedQueries: ["seed-failed"],
    });
    const model = scriptedAgentModel([
      final("partial", "仅对象一已确认", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "none", citations: [] },
        { id: "R3", coverage: "none", citations: [] },
      ]),
    ]);
    const events: DiagnosticEvent[] = [];
    const trace = {
      requestId: "coverage-unit-seed-states",
      record(event: DiagnosticEvent) {
        events.push(event);
      },
    } satisfies DiagnosticTrace;

    await runKnowledgeAgent({ ...agentInput(model, session, plan), trace });

    const verified = events.find((event) =>
      event.event === "coverage" && event.stage === "verified");
    const requirements = (verified as unknown as {
      requirements: Array<{
        id: string;
        candidateCount: number;
        readCandidateCount: number;
        unreadCandidateCount: number;
        remainingReads: number;
        seedSearchStatus: string;
      }>;
    }).requirements;
    expect(requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "R1",
        candidateCount: 1,
        readCandidateCount: 1,
        unreadCandidateCount: 0,
        remainingReads: 2,
        seedSearchStatus: "success",
      }),
      expect.objectContaining({
        id: "R2",
        candidateCount: 0,
        readCandidateCount: 0,
        unreadCandidateCount: 0,
        remainingReads: 3,
        seedSearchStatus: "empty",
      }),
      expect.objectContaining({
        id: "R3",
        candidateCount: 0,
        readCandidateCount: 0,
        unreadCandidateCount: 0,
        remainingReads: 3,
        seedSearchStatus: "unavailable",
      }),
    ]));
  });

  it("does not adopt another coverage unit's final citation without candidate ownership", async () => {
    const plan: KnowledgePlan = {
      subject: "引用隔离",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "对象一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "对象二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }], "seed-r2": [] },
    });
    const model = scriptedAgentModel([
      final("complete", "错误地让两个对象共用引用", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
      final("complete", "第二次仍让两个对象共用引用", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
      final("partial", "仅对象一有正式证据", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "none", citations: [] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(model.calls).toBe(1);
    expect(result.status).toBe("partially_answered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      "wiki/r1.md",
    ]);
  });

  it("does not leak an R1 graph candidate or citation into R2", async () => {
    const plan: KnowledgePlan = {
      subject: "图谱引用隔离",
      retrievalStrategy: "coverage_units",
      requirements: [
        { id: "R1", question: "对象一", ...plannedEvidence("seed-r1"), evidenceMode: "direct_only" },
        { id: "R2", question: "对象二", ...plannedEvidence("seed-r2"), evidenceMode: "direct_only" },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/r1-anchor.md" }],
        "seed-r2": [{ path: "wiki/r2-anchor.md" }],
      },
      graphHits: [{ path: "wiki/r1-graph.md" }],
    });
    const model = scriptedAgentModel([
      graph("R1", "wiki/r1-anchor.md"),
      read("R1", "wiki/r1-graph.md"),
      final("complete", "错误地让R2引用R1图谱证据", [3], [
        { id: "R1", coverage: "complete", citations: [3] },
        { id: "R2", coverage: "complete", citations: [3] },
      ]),
      final("partial", "仅R1引用图谱证据", [3], [
        { id: "R1", coverage: "complete", citations: [3] },
        { id: "R2", coverage: "none", citations: [] },
      ]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(model.calls).toBe(3);
    expect(payloadAt(model, 2).requirementEvidence?.find(
      (requirement) => requirement.id === "R2",
    )?.candidates.map((candidate) => candidate.path)).not.toContain("wiki/r1-graph.md");
    expect(result.status).toBe("partially_answered");
  });

  it("does not expand graph candidates from a global-only source", async () => {
    const plan: KnowledgePlan = {
      subject: "图谱归属隔离",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: "对象一",
        ...plannedEvidence("seed-r1"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "测试问题": [{ path: "wiki/global-only.md" }],
        "seed-r1": [],
      },
      graphHits: [{ path: "wiki/washed-graph-hit.md" }],
    });
    const model = scriptedAgentModel([
      graph("R1", "wiki/global-only.md"),
      final("none", "该单元没有定向候选"),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.graph).not.toHaveBeenCalled();
    expect(payloadAt(model, 1).observations?.join("\n")).toContain(
      "requirement_graph_action_rejected",
    );
    expect(session.search).not.toHaveBeenCalledWith(
      "测试问题",
      expect.anything(),
      expect.anything(),
    );
    expect(result.status).toBe("not_covered");
  });

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
      return reportAndReturn(input, {
        action: "final" as const,
        requirements: [{
          id: "R1" as const,
          coverage: "none" as const,
          answer: "现有知识正文未覆盖目标协议。",
          citations: [],
        }],
        citations: [],
      });
    });

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
      verifyCoverage,
      trace,
    });

    expect(result).toMatchObject({
      scope: "professional",
      status: "not_covered",
      knowledgeCoverage: "none",
      caseAssessability: "not_applicable",
      references: [],
    });
    expect(result.answer).toContain("尚未确认的部分：");
    expect(result.answer).toContain("测试证据面");
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
      return reportAndReturn(input);
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
      return reportAndReturn(input);
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
    expect(result.answer).toContain(notCoveredRequirementAnswer(
      "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
    ));
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
    expect(result.status).toBe("temporarily_unavailable");
    expect(events).toContainEqual(expect.objectContaining({
      event: "validation",
      result: "rejected",
      reason: "related_citation_metadata_mismatch",
    }));
    expect(events).toContainEqual({
      event: "fallback",
      reason: "coverage_verifier_invalid",
      outcome: "temporarily_unavailable",
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
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) => {
      const { draft } = input;
      expect(draft).toMatchObject({
        requirements: [{
          coverage: "none",
          answer: notCoveredRequirementAnswer(singlePlan.requirements[0]!.question),
          citations: [],
          relatedContext: [{ citations: [1] }],
        }],
        citations: [1],
      });
      return reportAndReturn(input, draft);
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
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

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
      aspectIds: ["A1"],
      rankings: [
        { query: "功能查询", rank: 1, score: 1 },
        { query: "POC 查询", rank: 1, score: 1 },
      ],
    });
    expect(candidates[0]?.rrfScore).toBeGreaterThan(candidates[1]?.rrfScore ?? 0);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.aspects).toEqual([{
      id: "A1",
      label: "测试证据面",
      candidateCount: 3,
      readCandidateCount: 0,
    }]);
  });

  it("prioritizes an exact direct-evidence title over a broader multi-aspect hit", async () => {
    const question = "Coremail 对比 Exchange 的优势";
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question,
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "总体对比", terms: ["Coremail", "Exchange"] },
          { id: "A2", label: "安全能力", terms: ["安全"] },
        ],
        queries: [
          { text: "Coremail Exchange 对比", aspectIds: ["A1"] },
          { text: "邮件安全能力", aspectIds: ["A2"] },
        ],
      }],
    };
    const session = fakeSession({
      hits: {
        [question]: [
          {
            path: "wiki/concepts/mail-security.md",
            title: "邮件安全能力",
          },
          {
            path: "wiki/concepts/localization.md",
            title: "信创适配与现场服务",
          },
          {
            path: "wiki/comparison/coremail-vs-exchange.md",
            title: "Coremail vs Exchange 对比",
          },
        ],
        "Coremail Exchange 对比": [{
          path: "wiki/entities/security-gateway.md",
          title: "邮件安全网关",
        }],
        "邮件安全能力": [{
          path: "wiki/entities/security-gateway.md",
          title: "邮件安全网关",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/coremail-vs-exchange.md"),
      final("complete", "正式对比结论 [1]", [1]),
    ]);

    await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
    });

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0])
      .toMatchObject({
        path: "wiki/comparison/coremail-vs-exchange.md",
      });
  });

  it("prioritizes unread candidates that can cover a missing dynamic aspect", async () => {
    const plan: KnowledgePlan = {
      subject: "动态证据面",
      requirements: [{
        id: "R1",
        question: "归纳两个互补证据面",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "证据面一", terms: ["证据一"] },
          { id: "A2", label: "证据面二", terms: ["证据二"] },
        ],
        queries: [
          { text: "查询证据一", aspectIds: ["A1"] },
          { text: "查询证据二", aspectIds: ["A2"] },
        ],
      }],
    };
    const session = fakeSession({
      hits: {
        "查询证据一": [{ path: "wiki/a-one.md" }],
        "查询证据二": [{ path: "wiki/a-two.md" }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/a-one.md"),
      read("R1", "wiki/a-two.md"),
      final("complete", "两个证据面均已覆盖 [1][2]", [1, 2]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    const afterFirstRead =
      payloadAt(model, 1).requirementEvidence?.[0];
    expect(afterFirstRead?.candidates[0]).toMatchObject({
      path: "wiki/a-two.md",
      aspectIds: ["A2"],
      read: false,
    });
    expect(afterFirstRead?.aspects).toEqual([
      {
        id: "A1",
        label: "证据面一",
        candidateCount: 1,
        readCandidateCount: 1,
      },
      {
        id: "A2",
        label: "证据面二",
        candidateCount: 1,
        readCandidateCount: 0,
      },
    ]);
  });

  it("accepts a supported partial answer without forcing literal aspect wording", async () => {
    const plan: KnowledgePlan = {
      subject: "互补能力",
      requirements: [{
        id: "R1",
        question: "归纳两个互补能力",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["需求访谈"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [
          { text: "需求诊断资料", aspectIds: ["A1"] },
          { text: "信任建立资料", aspectIds: ["A2"] },
        ],
      }],
    };
    const session = fakeSession({
      hits: {
        "需求诊断资料": [{
          path: "wiki/concepts/diagnosis.md",
          title: "需求诊断",
        }],
        "信任建立资料": [{
          path: "wiki/concepts/trust.md",
          title: "信任建立",
        }],
      },
    });
    session.compactPage
      .mockReturnValueOnce("正文说明需求诊断和需求访谈。")
      .mockReturnValueOnce("正文说明信任建立和可信顾问。");
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R1", path: "wiki/concepts/diagnosis.md" },
        { requirementId: "R1", path: "wiki/concepts/trust.md" },
      ),
      final("partial", "需求诊断 [1]", [1]),
      final("complete", "需求诊断 [1]；信任建立 [2]", [1, 2]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("partially_answered");
    expect(model.calls).toBe(2);
  });

  it("accepts a supported partial comparison without forcing a fixed outline", async () => {
    const plan: KnowledgePlan = {
      subject: "产品差异化对比",
      requirements: [{
        id: "R1",
        question: "Alpha 相比 Beta 有哪些差异化优势，并说明对比边界",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异化优势及边界",
          terms: ["Alpha", "Beta", "差异化优势", "对比边界"],
        }],
        queries: [{
          text: "Alpha Beta 差异化优势 对比边界",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异化优势 对比边界": [
          {
            path: "wiki/comparison/alpha-vs-beta.md",
            title: "Alpha vs Beta 对比",
          },
          {
            path: "wiki/cases/alpha-project.md",
            title: "Alpha 项目案例",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      final("partial", "已确认主要差异，但邻近主题尚未覆盖 [1]", [1]),
      final("complete", "差异化优势和对比边界均由正式对比页确认 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("partially_answered");
    expect(session.readPage).toHaveBeenCalledTimes(1);
    expect(model.calls).toBe(2);
  });

  it("accepts a semantically focused complete comparison without literal dimension matching", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 与 Exchange 对比",
      requirements: [{
        id: "R1",
        question: "Coremail 相比 Exchange 有哪些优势",
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "个性化定制", terms: ["定制能力"] },
          { id: "A2", label: "客观对比边界", terms: ["客观边界"] },
        ],
        queries: [{
          text: "Coremail Exchange 定制能力 客观边界",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Coremail Exchange 定制能力 客观边界": [{
          path: "wiki/comparison/coremail-vs-exchange.md",
          title: "Coremail vs Exchange 对比",
        }],
      },
    });
    session.compactPage.mockReturnValue(
      "正式正文覆盖个性化定制和定制能力，并说明应保留客观对比边界。",
    );
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/coremail-vs-exchange.md"),
      final("complete", "个性化定制能力更强 [1]。", [1]),
      final(
        "complete",
        "个性化定制能力更强 [1]。\n客观对比边界应结合场景说明 [1]。",
        [1],
      ),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question: plan.requirements[0]!.question,
    });

    expect(result.status).toBe("answered");
    expect(model.calls).toBe(2);
  });

  it("recognizes mixed Chinese-English product titles and forces the exact comparison read", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 与 Exchange 对比",
      requirements: [{
        id: "R1",
        question: "对比exchange邮件系统，coremail的优势有哪些呢",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Coremail 与 Exchange 的优势对比",
          terms: ["Coremail", "Exchange", "优势", "对比"],
        }],
        queries: [{
          text: "邮件系统优势",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "邮件系统优势": [{
          path: "wiki/comparisons/localization.md",
          title: "信创技术栈适配矩阵",
        }, {
          path: "wiki/comparison/coremail-vs-exchange.md",
          title: "Coremail vs Exchange 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      final("none"),
      final("complete", "正式对比页确认了 Coremail 的主要优势 [1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledTimes(1);
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/comparison/coremail-vs-exchange.md",
      undefined,
    );
    expect(payloadAt(model, 1).finalOnly).toBe(true);
    expect(payloadAt(model, 1).observations?.join("\n")).toContain(
      "coverage_gate_forced_read",
    );
    expect(result.status).toBe("answered");
  });

  it("reserves an exact comparison read after adjacent pages used the normal budget", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 与 Exchange 对比",
      requirements: [{
        id: "R1",
        question: "对比 Exchange 邮件系统，Coremail 有哪些优势",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Coremail 与 Exchange 的优势对比",
          terms: ["Coremail", "Exchange", "优势"],
        }],
        queries: [{ text: "宽泛对比", aspectIds: ["A1"] }],
      }],
    };
    const adjacentPaths = [
      "wiki/concepts/migration.md",
      "wiki/concepts/localization.md",
      "wiki/concepts/security.md",
    ];
    const exactPath = "wiki/comparison/coremail-vs-exchange.md";
    const session = fakeSession({
      hits: {
        "宽泛对比": adjacentPaths.map((path) => ({ path })),
        "精确产品对比": [{
          path: exactPath,
          title: "Coremail vs Exchange 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", adjacentPaths[0]!),
      read("R1", adjacentPaths[1]!),
      read("R1", adjacentPaths[2]!),
      search("R1", "精确产品对比"),
      final("none"),
      final("complete", "正式对比页确认了主要优势 [4]。", [4]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledTimes(4);
    expect(session.readPage).toHaveBeenLastCalledWith(exactPath, undefined);
    expect(result.status).toBe("answered");
    expect(result.references.map((reference) => reference.path)).toEqual([
      exactPath,
    ]);
  });

  it("defers an adjacent page when a batch already contains the exact comparison", async () => {
    const plan: KnowledgePlan = {
      subject: "产品差异化对比",
      requirements: [{
        id: "R1",
        question: "Alpha 相比 Beta 有哪些差异化优势",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异化优势",
          terms: ["Alpha", "Beta", "差异化优势"],
        }],
        queries: [{
          text: "Alpha Beta 差异化优势",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异化优势": [
          {
            path: "wiki/comparison/alpha-vs-beta.md",
            title: "Alpha vs Beta 对比",
          },
          {
            path: "wiki/cases/alpha-localization.md",
            title: "Alpha 国产化案例",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        {
          requirementId: "R1",
          path: "wiki/comparison/alpha-vs-beta.md",
        },
        {
          requirementId: "R1",
          path: "wiki/cases/alpha-localization.md",
        },
      ),
      final("complete", "正式对比页已覆盖差异化优势 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(session.readPage).toHaveBeenCalledTimes(1);
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/comparison/alpha-vs-beta.md",
      undefined,
    );
    expect(payloadAt(model, 1).observations?.join("\n")).toContain(
      "adjacent_comparison_page_deferred",
    );
  });

  it("redirects an adjacent single read to the closest exact comparison", async () => {
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Alpha 和 Beta 有哪些差异",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异",
          terms: ["Alpha", "Beta", "差异"],
        }],
        queries: [{
          text: "Alpha Beta 差异",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异": [
          {
            path: "wiki/comparison/alpha-vs-beta.md",
            title: "Alpha vs Beta 对比",
          },
          {
            path: "wiki/cases/alpha-project.md",
            title: "Alpha 项目案例",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/cases/alpha-project.md"),
      final("complete", "正式对比页确认了 Alpha 与 Beta 的主要差异 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/comparison/alpha-vs-beta.md",
      undefined,
    );
    expect(payloadAt(model, 1).observations?.join("\n")).toContain(
      "direct_comparison_read_redirected",
    );
  });

  it("rewrites an uncovered draft once after reading the exact comparison", async () => {
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Alpha 和 Beta 有哪些差异",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异",
          terms: ["Alpha", "Beta", "差异"],
        }],
        queries: [{
          text: "Alpha Beta 差异",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异": [{
          path: "wiki/comparison/alpha-vs-beta.md",
          title: "Alpha vs Beta 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      final("none"),
      final("complete", "正式对比页确认了 Alpha 与 Beta 的主要差异 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "direct_answer_repair_required",
    );
  });

  it("rewrites a comparison draft whose cited claims lose their subjects", async () => {
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Alpha 和 Beta 有哪些差异与限制",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异和限制",
          terms: ["Alpha", "Beta", "差异", "限制"],
        }],
        queries: [{
          text: "Alpha Beta 差异限制",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异限制": [{
          path: "wiki/comparison/alpha-vs-beta.md",
          title: "Alpha vs Beta 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "- 不支持多中心部署 [1]。\n- 其切换粒度为整机 [1]。",
          citations: [1],
        }],
        citations: [1],
      },
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "Alpha 支持多中心部署 [1]。\nBeta 不支持多中心部署，切换粒度为整机 [1]。",
          citations: [1],
        }],
        citations: [1],
      },
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "comparison_subject_repair_required",
    );
    expect(result.answer).toContain("Beta 不支持多中心部署");
  });

  it("rewrites a scenario comparison that omits one explicitly named choice", async () => {
    const plan: KnowledgePlan = {
      subject: "DNS 切换",
      requirements: [{
        id: "R1",
        question: "上线时 CNAME 跳转和直接改 A 记录各适合什么场景",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "两种 DNS 方案的适用场景",
          terms: ["CNAME", "A 记录", "适用场景"],
        }],
        queries: [{ text: "CNAME A 记录适用场景", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "CNAME A 记录适用场景": [{
          path: "wiki/comparison/dns-cutover.md",
          title: "CNAME 与 A 记录切换对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/dns-cutover.md"),
      final("complete", "直接改 A 记录适合客户端可统一变更的场景 [1]。", [1]),
      final(
        "complete",
        "CNAME 跳转适合减少客户端改动的场景 [1]。\n直接改 A 记录适合客户端可统一变更的场景 [1]。",
        [1],
      ),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "comparison_subject_repair_required",
    );
    expect(result.answer).toContain("CNAME");
  });

  it("rewrites a direct technical comparison that omits one named side", async () => {
    const plan: KnowledgePlan = {
      subject: "迁移对比",
      requirements: [{
        id: "R1",
        question: "Exchange 和 Domino 在接口、权限和运行环境上有什么区别",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "两种迁移方式的区别",
          terms: ["Exchange", "Domino", "接口", "权限", "运行环境"],
        }],
        queries: [{ text: "Exchange Domino 迁移对比", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Exchange Domino 迁移对比": [{
          path: "wiki/comparison/exchange-vs-domino.md",
          title: "Exchange 与 Domino 迁移对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/exchange-vs-domino.md"),
      final("complete", "Domino 依赖本地客户端和 ACL [1]。", [1]),
      final(
        "complete",
        "Exchange 使用服务接口和模拟用户权限 [1]。\nDomino 依赖本地客户端和 ACL [1]。",
        [1],
      ),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "comparison_subject_repair_required",
    );
    expect(result.answer).toContain("Exchange");
  });

  it("accepts comparison bullets under an explicit object heading", async () => {
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Alpha 和 Beta 有哪些差异",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异",
          terms: ["Alpha", "Beta", "差异"],
        }],
        queries: [{ text: "Alpha Beta 差异", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 差异": [{
          path: "wiki/comparison/alpha-vs-beta.md",
          title: "Alpha vs Beta 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      final("complete", "Alpha：\n- 支持多中心部署 [1]。\nBeta：\n- 不支持多中心部署 [1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(result.status).toBe("answered");
    expect(model.calls).toBe(2);
  });

  it("passes the comparison completeness and formal-name contract to synthesis", async () => {
    const plan: KnowledgePlan = {
      subject: "高可用选型",
      requirements: [{
        id: "R1",
        question: "比较方案甲和方案乙的关键差异、限制和选型理由",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "关键差异、限制和选型理由",
          terms: ["方案甲", "方案乙", "差异", "限制"],
        }],
        queries: [{ text: "方案甲 方案乙 对比", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "方案甲 方案乙 对比": [{
          path: "wiki/comparison/alpha-vs-beta.md",
          title: "方案甲与方案乙对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      final("complete", "方案甲与方案乙的主要差异和限制已由正式对比页确认 [1]。", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    const systemPrompt = model.prompts[1]?.[0]?.content ?? "";
    expect(systemPrompt).toContain("足以改变选型判断的主要对比维度");
    expect(systemPrompt).toContain("模块全称与缩写");
  });

  it("rewrites a structured direct answer after verification drops required stages", async () => {
    const plan: KnowledgePlan = {
      subject: "认证对接",
      requirements: [{
        id: "R1",
        question: "认证流程和关键配置是什么",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "认证流程和关键配置",
          terms: ["认证流程", "关键配置"],
        }],
        queries: [{ text: "认证流程关键配置", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "认证流程关键配置": [{
          path: "wiki/concepts/auth.md",
          title: "认证对接",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/auth.md"),
      final("complete", "先跳转授权页面 [1]。\n再交换令牌并取得用户标识 [1]。", [1]),
      final("complete", "先跳转授权页面 [1]。\n再交换令牌并取得用户标识 [1]。", [1]),
    ]);
    const verifyCoverage = vi.fn()
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input, {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            coverage: "partial" as const,
            answer: "再交换令牌并取得用户标识 [1]。",
          })),
        }))
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(verifyCoverage).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "structured_coverage_repair_required",
    );
  });

  it("rewrites an ordered taxonomy when verification removes its leading items", async () => {
    const plan: KnowledgePlan = {
      subject: "购买影响角色",
      requirements: [{
        id: "R1",
        question: "怎样识别经济、用户、技术和 Coach 四类角色",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "四类角色",
          terms: ["经济", "用户", "技术", "Coach"],
        }],
        queries: [{ text: "四类购买影响角色", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "四类购买影响角色": [{
          path: "wiki/concepts/buying-roles.md",
          title: "四类购买影响角色",
        }],
      },
    });
    const fullAnswer =
      "1. 经济角色能释放或否决资源 [1]。\n2. 用户角色判断工作与绩效影响 [1]。\n3. 技术角色执行筛选标准 [1]。\n4. Coach 提供准确信息并帮助接触角色 [1]。";
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/buying-roles.md"),
      final("complete", fullAnswer, [1]),
      final("complete", fullAnswer, [1]),
    ]);
    const verifyCoverage = vi.fn()
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input, {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            answer: "4. Coach 提供准确信息并帮助接触角色 [1]。",
          })),
        }))
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(verifyCoverage).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "structured_coverage_repair_required",
    );
    expect(result.answer).toContain("经济角色");
    expect(result.answer).toContain("用户角色");
    expect(result.answer).toContain("技术角色");
    expect(result.answer).toContain("Coach");
  });

  it("runs one evidence-grounded completeness review for an explicitly named method", async () => {
    const plan: KnowledgePlan = {
      subject: "Mom Test 访谈",
      requirements: [{
        id: "R1",
        question: "怎样用 Mom Test 把赞美追问成事实",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [{
          id: "A1",
          label: "核心规则与访谈步骤",
          terms: ["过去具体行为", "少说多听", "频率", "严重性"],
        }],
        queries: [{ text: "Mom Test 核心规则 访谈步骤", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Mom Test 核心规则 访谈步骤": [{
          path: "wiki/synthesis/mom-test.md",
          title: "Mom Test 方法总览",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/synthesis/mom-test.md"),
      final("complete", "追问最近一次具体行为，并要求下一步承诺 [1]。", [1]),
      final(
        "complete",
        "先谈客户情境并少说多听，再追问最近一次具体行为、发生频率、问题严重性、责任人和现有替代，最后用客户实际承诺验证推进 [1]。",
        [1],
      ),
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "named_method_completeness_review_required",
    );
    expect(result.answer).toContain("少说多听");
    expect(result.answer).toContain("问题严重性");
  });

  it("rewrites an answer that omits one formally coordinated framework component", async () => {
    const path = "wiki/concepts/results-first.md";
    const plan: KnowledgePlan = {
      subject: "结果优先演示",
      requirements: [{
        id: "R1",
        question: "怎样先建立相关性再按角色下钻证据",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "结果优先演示结构",
          terms: ["结果优先", "倒金字塔", "按需深入"],
        }],
        queries: [{ text: "结果优先演示结构", aspectIds: ["A1"] }],
      }],
    };
    const evidence =
      "该结构包括 **Do the Last Thing First**（先展示最终结果）、" +
      "**Illustration**（简洁画面）和 **Inverted Pyramid**（倒金字塔结构）" +
      "三个相互配合的方法。\n### 边界与风险\n" +
      "- 对敏感数据需使用脱敏或示意环境";
    const session = fakeSession({
      hits: {
        "结果优先演示结构": [{ path, title: "结果优先演示结构" }],
      },
      pageBodies: { [path]: evidence },
    });
    const model = scriptedAgentModel([
      read("R1", path),
      final(
        "complete",
        "用 Do the Last Thing First 先展示最终结果，再以 Inverted Pyramid 按需深入 [1]。",
        [1],
      ),
      final(
        "complete",
        "用 Do the Last Thing First 先展示最终结果，以 Illustration 简洁画面连接情境，再以 Inverted Pyramid 按需深入 [1]。",
        [1],
      ),
      final(
        "complete",
        "用 Do the Last Thing First 先展示最终结果，以 Illustration 简洁画面连接情境，再以 Inverted Pyramid 按需深入；敏感数据使用脱敏或示意环境 [1]。",
        [1],
      ),
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(model.calls).toBe(4);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "named_method_completeness_review_required",
    );
    expect(result.answer).toContain("Illustration");
    expect(result.answer).toContain("简洁画面");
    expect(result.answer).toContain("脱敏");
    expect(payloadAt(model, 3).observations?.join("\n")).toContain(
      "framework_boundary_repair_required",
    );
  });

  it("projects formal framework boundaries when repeated rewrites still omit them", async () => {
    const path = "wiki/concepts/results-first.md";
    const plan: KnowledgePlan = {
      subject: "结果优先演示",
      requirements: [{
        id: "R1",
        question: "怎样先建立相关性再按角色下钻证据",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "结果优先演示结构",
          terms: ["结果优先", "倒金字塔", "按需深入"],
        }],
        queries: [{ text: "结果优先演示结构", aspectIds: ["A1"] }],
      }],
    };
    const evidence =
      "该结构包括 **Do the Last Thing First**（先展示最终结果）、" +
      "**Illustration**（简洁画面）和 **Inverted Pyramid**（倒金字塔结构）" +
      "三个相互配合的方法。\n### 边界与风险\n" +
      "- 对敏感数据需使用脱敏或示意环境\n" +
      "- 不能只展示漂亮仪表盘而无法说明业务含义";
    const session = fakeSession({
      hits: {
        "结果优先演示结构": [{ path, title: "结果优先演示结构" }],
      },
      pageBodies: { [path]: evidence },
    });
    const incomplete = final(
      "complete",
      "用 Do the Last Thing First 先展示最终结果，以 Illustration 简洁画面连接情境，再以 Inverted Pyramid 按需深入 [1]。",
      [1],
    );
    const model = scriptedAgentModel([
      read("R1", path),
      incomplete,
      incomplete,
      incomplete,
      incomplete,
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(model.calls).toBe(5);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(result.answer).toContain("**正式边界**");
    expect(result.answer).toContain("对敏感数据需使用脱敏或示意环境 [1]");
    expect(result.answer).toContain("不能只展示漂亮仪表盘而无法说明业务含义 [1]");
  });

  it("rewrites a collection that stops after its first numbered item", async () => {
    const plan: KnowledgePlan = {
      subject: "实施确认",
      requirements: [{
        id: "R1",
        question: "实施前还要确认什么",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "实施确认事项",
          terms: ["实施确认"],
        }],
        queries: [{ text: "实施确认事项", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "实施确认事项": [{
          path: "wiki/concepts/implementation.md",
          title: "实施确认",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/implementation.md"),
      final("complete", "实施前需确认以下事项：1）确认用户所属组织 [1]。", [1]),
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: "实施前需确认以下事项：1）确认用户所属组织 [1]；2）确认产品版本 [1]；3）确认实际组织配置 [1]。",
          citations: [1],
        }],
        citations: [1],
      },
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(model.calls).toBe(3);
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "broken_collection_enumeration",
    );
    expect(result.answer).toContain("产品版本");
    expect(result.answer).toContain("实际组织配置");
  });

  it("rewrites a collection when verification removes a middle ordinal", async () => {
    const plan: KnowledgePlan = {
      subject: "实施确认",
      requirements: [{
        id: "R1",
        question: "实施前还要确认什么",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "实施确认事项",
          terms: ["实施确认"],
        }],
        queries: [{ text: "实施确认事项", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "实施确认事项": [{
          path: "wiki/concepts/implementation.md",
          title: "实施确认",
        }],
      },
    });
    const complete =
      "实施前需确认以下事项：一是确认用户组织 [1]；二是确认服务等级 [1]；" +
      "三是确认产品版本 [1]；四是确认实际配置 [1]。";
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/implementation.md"),
      final("complete", complete, [1]),
      final("complete", complete, [1]),
    ]);
    const verifyCoverage = vi.fn()
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input, {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            answer:
              "实施前需确认以下事项：一是确认用户组织 [1]；二是确认服务等级 [1]；四是确认实际配置 [1]。",
          })),
        }))
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(verifyCoverage).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "structured_coverage_repair_required",
    );
    expect(result.answer).toContain("三是确认产品版本");
  });

  it("rewrites a comparison after verification drops one explicitly named side", async () => {
    const plan: KnowledgePlan = {
      subject: "协议对比",
      requirements: [{
        id: "R1",
        question: "POP3 和 IMAP 在文件夹、存储和同步上有什么差别",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "POP3 与 IMAP 的差别",
          terms: ["POP3", "IMAP", "文件夹", "存储", "同步"],
        }],
        queries: [{ text: "POP3 IMAP 协议对比", aspectIds: ["A1"] }],
      }],
    };
    const session = fakeSession({
      hits: {
        "POP3 IMAP 协议对比": [{
          path: "wiki/comparison/pop3-vs-imap.md",
          title: "POP3 与 IMAP 协议对比",
        }],
      },
    });
    const completeComparison =
      "POP3 仅操作收件箱，邮件下载到本地且不同步 [1]。\n" +
      "IMAP 可操作所有文件夹，邮件保留在服务器并同步 [1]。";
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/pop3-vs-imap.md"),
      final("complete", completeComparison, [1]),
      final("complete", completeComparison, [1]),
    ]);
    const verifyCoverage = vi.fn()
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input, {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            answer: "IMAP 可操作所有文件夹，邮件保留在服务器并同步 [1]。",
          })),
        }))
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("answered");
    expect(verifyCoverage).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "comparison_subject_repair_required",
    );
    expect(result.answer).toContain("POP3");
    expect(result.answer).toContain("IMAP");
  });

  it("accepts a verifier-supported partial comparison without another rewrite", async () => {
    const plan: KnowledgePlan = {
      subject: "产品对比",
      requirements: [{
        id: "R1",
        question: "Alpha 与 Beta 有哪些差异",
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: "Alpha 与 Beta 的差异",
          terms: ["Alpha", "Beta", "差异"],
        }],
        queries: [{
          text: "Alpha Beta 对比",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "Alpha Beta 对比": [{
          path: "wiki/comparison/alpha-vs-beta.md",
          title: "Alpha vs Beta 对比",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparison/alpha-vs-beta.md"),
      final("complete", "Alpha 与 Beta 的第一版差异结论 [1]", [1]),
      final("complete", "Alpha 与 Beta 的保守差异结论与边界 [1]", [1]),
    ]);
    const verifyCoverage = vi.fn()
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input, {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            coverage: "partial" as const,
          })),
        }))
      .mockImplementationOnce(async (input: CoverageVerifierInput) =>
        reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(result.status).toBe("partially_answered");
    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(model.calls).toBe(2);
  });

  it("preloads broad synthesis pages by uncovered aspect before asking for a final", async () => {
    const plan: KnowledgePlan = {
      subject: "宽泛归纳",
      requirements: [{
        id: "R1",
        question: "归纳四个互补证据面",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "领域一", terms: ["术语一"] },
          { id: "A2", label: "领域二", terms: ["术语二"] },
          { id: "A3", label: "领域三", terms: ["术语三"] },
          { id: "A4", label: "领域四", terms: ["术语四"] },
        ],
        queries: [
          { text: "领域一与领域二", aspectIds: ["A1", "A2"] },
          { text: "领域三", aspectIds: ["A3"] },
          { text: "领域四", aspectIds: ["A4"] },
        ],
      }],
    };
    const session = fakeSession({
      hits: {
        "领域一与领域二 术语一 术语二": [
          {
            path: "wiki/a1.md",
            title: "术语一",
            matchedTerms: ["术语一"],
            snippet: "术语一正文",
          },
          {
            path: "wiki/a2.md",
            title: "术语二",
            matchedTerms: ["术语二"],
            snippet: "术语二正文",
          },
        ],
        "领域三": [{
          path: "wiki/a3.md",
          title: "术语三",
          matchedTerms: ["术语三"],
        }],
        "领域四": [{
          path: "wiki/a4.md",
          title: "术语四",
          matchedTerms: ["术语四"],
        }],
      },
    });
    const model = scriptedAgentModel([
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: [
            "领域一 [1][2][3][4]；",
            "领域二 [1][2][3][4]；",
            "领域三 [1][2][3][4]；",
            "领域四 [1][2][3][4]。",
          ].join(""),
          citations: [1, 2, 3, 4],
        }],
        citations: [1, 2, 3, 4],
      },
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.readPage).toHaveBeenCalledTimes(4);
    expect(model.calls).toBe(1);
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(4);
  });

  it("attributes a broad-query hit only to aspects supported by its own metadata", async () => {
    const plan: KnowledgePlan = {
      subject: "互补领域",
      requirements: [{
        id: "R1",
        question: "归纳多个互补领域",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["诊断式销售"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [{
          text: "售前互补领域",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "售前互补领域 诊断式销售 可信顾问": [
          {
            path: "wiki/concepts/diagnosis.md",
            title: "诊断式销售",
            matchedTerms: ["诊断式销售"],
            snippet: "通过问题诊断发现需求。",
          },
          {
            path: "wiki/concepts/trust.md",
            title: "可信顾问",
            matchedTerms: ["可信顾问"],
            snippet: "通过信任方程建立关系。",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/diagnosis.md"),
      read("R1", "wiki/concepts/trust.md"),
      final("complete", "需求诊断与信任建立 [1][2]", [1, 2]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    const candidates =
      payloadAt(model, 0).requirementEvidence?.[0]?.candidates ?? [];
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "wiki/concepts/diagnosis.md",
        aspectIds: ["A1"],
      }),
      expect.objectContaining({
        path: "wiki/concepts/trust.md",
        aspectIds: ["A2"],
      }),
    ]));
  });

  it("widens one synthesis search window without adding queries", async () => {
    const evidenceAspects = Array.from({ length: 8 }, (_, index) => ({
      id: `A${index + 1}` as `A${number}`,
      label: `证据面${index + 1}`,
      terms: [`术语${index + 1}`],
    }));
    const plan = {
      subject: "多面归纳",
      requirements: [{
        id: "R1" as const,
        question: "归纳多个互补证据面",
        evidenceMode: "synthesis_allowed" as const,
        evidenceAspects,
        queries: [{
          text: "多面归纳查询",
          aspectIds: evidenceAspects.map((aspect) => aspect.id),
        }],
      }],
    } satisfies KnowledgePlan;
    const session = fakeSession();
    const model = scriptedAgentModel([
      final("none", "当前资料未覆盖该问题"),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledTimes(2);
    expect(session.search).toHaveBeenCalledWith(
      "多面归纳查询 术语1 术语2 术语3 术语4 术语5 术语6 术语7 术语8",
      20,
      undefined,
    );
  });

  it("keeps a single-aspect query binding when hit metadata uses different wording", async () => {
    const plan: KnowledgePlan = {
      subject: "单一领域",
      requirements: [{
        id: "R1",
        question: "说明单一领域",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["诊断式销售"] },
        ],
        queries: [{
          text: "售前需求发现",
          aspectIds: ["A1"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "售前需求发现": [{
          path: "wiki/concepts/discovery.md",
          title: "客户问题发现",
          matchedTerms: ["需求发现"],
          snippet: "帮助客户看见问题。",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/discovery.md"),
      final("complete", "需求诊断 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(
      payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0],
    ).toMatchObject({
      path: "wiki/concepts/discovery.md",
      aspectIds: ["A1"],
    });
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

  it("uses the model-planned compatibility query without injecting a scenario query", async () => {
    const plan: KnowledgePlan = {
      subject: "Coremail 信创兼容性",
      requirements: [{
        id: "R1",
        question: "Coremail 在信创环境中的兼容性如何",
        ...plannedEvidence("Coremail 信创环境兼容性 CPU 操作系统 数据库"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "Coremail 信创环境兼容性 CPU 操作系统 数据库": [{
          path: "wiki/comparisons/信创技术栈适配矩阵.md",
        }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/comparisons/信创技术栈适配矩阵.md"),
      final("complete", "适配矩阵列出了已验证的技术栈 [1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledWith(
      "Coremail 信创环境兼容性 CPU 操作系统 数据库",
      10,
      undefined,
    );
    expect(session.search).not.toHaveBeenCalledWith(
      "信创技术栈适配矩阵",
      10,
      undefined,
    );
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/comparisons/信创技术栈适配矩阵.md");
    expect(result.status).toBe("answered");
  });

  it.each([
    {
      label: "migration capability",
      question: "Coremail 邮件迁移项目通常需要考虑哪些产品能力",
      path: "wiki/comparison/第三方邮件系统迁移方式对比.md",
    },
    {
      label: "disaster recovery",
      question: "Coremail 如何设计容灾和高可用",
      path: "wiki/concepts/邮件系统多活与容灾设计.md",
    },
    {
      label: "vendor-neutral discovery",
      question: "如何开展厂商无关的售前需求访谈",
      path: "wiki/synthesis/售前诊断式对话框架.md",
    },
  ])("uses the model-planned query for $label questions", async ({
    question,
    path,
  }) => {
    const plan: KnowledgePlan = {
      subject: question,
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence(question),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        [question]: [{ path }],
      },
    });
    const model = scriptedAgentModel([
      read("R1", path),
      final("complete", "已读取目标知识页 [1]。", [1]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session, plan));

    expect(session.search).toHaveBeenCalledWith(question, 10, undefined);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe(path);
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

  it("keeps an atomic acceptance question anchored to the overall subject", async () => {
    const plan: KnowledgePlan = {
      subject: "Outlook PST 历史邮件导入 Coremail 客户端",
      requirements: [{
        id: "R1",
        question: "验收要看什么",
        evidenceMode: "direct_only",
        evidenceAspects: [{ id: "A1", label: "验收要点", terms: ["验收"] }],
        queries: [
          { text: "验收要看什么", aspectIds: ["A1"] },
          {
            text: "验收要看什么 Outlook PST 历史邮件导入 Coremail 客户端",
            aspectIds: ["A1"],
          },
        ],
      }],
      retrievalStrategy: "coverage_units",
    };
    const session = fakeSession({
      hits: {
        "验收要看什么": [{
          path: "wiki/synthesis/project-acceptance.md",
          title: "项目验收要点",
        }],
        "验收要看什么 Outlook PST 历史邮件导入 Coremail 客户端": [
          {
            path: "wiki/synthesis/project-acceptance.md",
            title: "项目验收要点",
          },
          {
            path: "wiki/concepts/coremail-client-pst-import.md",
            title: "Coremail 客户端 PST 导入",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/coremail-client-pst-import.md"),
      final("complete", "核对目标账户、兼容边界和导入结果 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/coremail-client-pst-import.md");
  });

  it("prioritizes an explicitly named single-term concept page", async () => {
    const question = "客户要求继续降价，怎样用 BATNA 谈判？";
    const query = "客户降价 BATNA 谈判";
    const plan: KnowledgePlan = {
      subject: question,
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence(query),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        [query]: [
          {
            path: "wiki/synthesis/negotiation-guide.md",
            title: "售前谈判场景应对手册",
          },
          {
            path: "wiki/concepts/batna.md",
            title: "BATNA",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/batna.md"),
      final("complete", "先确定可执行的最佳替代方案，再设置保留点 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/batna.md");
  });

  it("treats a matching query page as curated evidence instead of burying it behind broad concepts", async () => {
    const question = "Coremail 重复发信如何区分客户端重发和 deliveragent 重投？";
    const query = "Coremail 重复发信 客户端重发 deliveragent 重投";
    const plan: KnowledgePlan = {
      subject: question,
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence(query),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        [query]: [
          {
            path: "wiki/concepts/mail-troubleshooting.md",
            title: "Coremail 邮件收发问题排查流程",
          },
          {
            path: "wiki/queries/duplicate-send.md",
            title: "Coremail 重复发信如何区分客户端重发和 deliveragent 重投",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/queries/duplicate-send.md"),
      final("complete", "结合客户端记录与投递日志判断 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/queries/duplicate-send.md");
  });

  it("uses an intent verb together with a domain term to identify the primary page", async () => {
    const question = "Coremail 如何设计容灾和高可用";
    const plan: KnowledgePlan = {
      subject: "高可用设计",
      requirements: [{
        id: "R1",
        question,
        ...plannedEvidence("邮件系统设计容灾高可用"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession({
      hits: {
        "邮件系统设计容灾高可用": [
          {
            path: "wiki/concepts/mirror.md",
            title: "私有云镜像容灾",
          },
          {
            path: "wiki/concepts/availability.md",
            title: "邮件系统多活与容灾设计",
          },
        ],
      },
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/availability.md"),
      final("complete", "多活与容灾设计结论 [1]", [1]),
    ]);

    await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      question,
    });

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.candidates[0]?.path)
      .toBe("wiki/concepts/availability.md");
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

  it("expands the synthesis read budget to the number of dynamic evidence aspects", () => {
    const evidenceAspects = Array.from({ length: 8 }, (_, index) => ({
      id: `A${index + 1}` as `A${number}`,
      label: `证据面${index + 1}`,
      terms: [`术语${index + 1}`],
    }));
    const requirement = {
      id: "R1" as const,
      question: "归纳八个互补证据面",
      evidenceMode: "synthesis_allowed" as const,
      evidenceAspects,
      queries: [{
        text: "检索八个互补证据面",
        aspectIds: evidenceAspects.map((aspect) => aspect.id),
      }],
    } satisfies KnowledgePlan["requirements"][number];

    expect(readLimitFor(requirement)).toBe(8);
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

  it("does not execute the completed global seed query again as a supplemental query", async () => {
    const session = fakeSession({ hits: { "seed-r1": [], "测试问题": [] } });
    const model = scriptedAgentModel([
      search("R1", "  测试问题  "),
      final("none", "当前资料未覆盖该问题"),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(session.search).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 1).observations?.join("\n")).toContain("duplicate_query");
  });

  it("allows the same supplemental query to recover after a transient search failure", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [], "测试问题": [], "瞬时查询": [] },
      failedQueryAttempts: { "瞬时查询": 1 },
    });
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        search("R1", "瞬时查询"),
        search("R1", "瞬时查询"),
        final("none", "当前资料未覆盖该问题"),
      ]),
      session,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    expect(session.search).toHaveBeenCalledTimes(4);
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.queries.filter((query) =>
        query.query === "瞬时查询").map((query) => query.status)).toEqual([
        "unavailable",
        "empty",
      ]);
    }
  });

  it("rejects supplemental searches bound to an unknown dynamic aspect", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      {
        action: "tool",
        tool: "kb.search",
        input: {
          requirementId: "R1",
          query: "补充查询",
          aspectIds: ["A2"],
          topK: 5,
        },
      },
      final("none", "当前资料未覆盖该问题"),
    ]);

    await runKnowledgeAgent(agentInput(model, session));

    expect(session.search).toHaveBeenCalledTimes(2);
    expect(payloadAt(model, 1).observations?.join("\n"))
      .toContain("unknown_search_aspect");
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
      expect.arrayContaining([
        "Coremail AI 是什么",
        "seed-r1",
        "测试证据面",
        "测试证据",
        "AI 助手",
      ]),
    );
  });

  it("resolves read-page aspects from compacted body content", async () => {
    const plan: KnowledgePlan = {
      subject: "互补领域",
      requirements: [{
        id: "R1",
        question: "归纳需求诊断与信任建立",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "需求诊断", terms: ["诊断式销售"] },
          { id: "A2", label: "信任建立", terms: ["可信顾问"] },
        ],
        queries: [{
          text: "售前互补领域",
          aspectIds: ["A1", "A2"],
        }],
      }],
    };
    const session = fakeSession({
      hits: {
        "售前互补领域 诊断式销售 可信顾问": [{
          path: "wiki/concepts/advisor.md",
          title: "顾问关系",
          matchedTerms: ["顾问关系"],
          snippet: "关系方法。",
        }],
      },
    });
    session.compactPage.mockReturnValue(
      "正文说明如何成为可信顾问并完成信任建立。",
    );
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/advisor.md"),
      final("partial", "信任建立职责 [1]", [1]),
    ]);

    await runKnowledgeAgent(agentInput(model, session, plan));

    expect(
      payloadAt(model, 1).requirementEvidence?.[0]?.candidates[0],
    ).toMatchObject({
      path: "wiki/concepts/advisor.md",
      aspectIds: ["A2"],
      read: true,
    });
    expect(
      payloadAt(model, 1).requirementEvidence?.[0]?.aspects,
    ).toEqual([
      {
        id: "A1",
        label: "需求诊断",
        candidateCount: 0,
        readCandidateCount: 0,
      },
      {
        id: "A2",
        label: "信任建立",
        candidateCount: 1,
        readCandidateCount: 1,
      },
    ]);
    expect(payloadAt(model, 1).readEvidence).toEqual([
      expect.objectContaining({
        requirementId: "R1",
        citation: 1,
        path: "wiki/concepts/advisor.md",
        content: "正文说明如何成为可信顾问并完成信任建立。",
        aspectIds: ["A2"],
      }),
    ]);
  });

  it("does not accept none while a requirement still has an unread candidate", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
    });
    const model = scriptedAgentModel([
      final("none", "当前资料未覆盖该问题"),
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
      final("complete", "两页共同确认[1][2]", [1, 2]),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(payloadAt(model, 2).observations?.join("\n")).toContain(
      "coverage_gate_requires_read",
    );
    expect(session.readPage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("answered");
  });

  it("returns a verified partial answer with a retrieval gap when forced review cannot advance", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/concepts/first.md" },
          { path: "wiki/concepts/second.md" },
        ],
      },
      failedReadPaths: ["wiki/concepts/second.md"],
    });
    const model = scriptedAgentModel([
      read("R1", "wiki/concepts/first.md"),
      final("partial", "当前已确认部分内容[1]，其余仍需核验。", [1]),
    ]);

    const result = await runKnowledgeAgentDetailed(agentInput(model, session));

    expect(result).toMatchObject({
      outcome: "verified",
      action: {
        requirements: [{ coverage: "partial", citations: [1] }],
      },
      evidenceLedger: {
        units: [{ retrieval: { readBudgetExhausted: true } }],
      },
      coverageGaps: [{
        gapClass: "retrieval",
        reason: "tool_unavailable",
      }],
    });
    expect(model.calls).toBe(2);
    expect(session.readPage).toHaveBeenCalledTimes(2);
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
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));
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
      finalAfterR1Read,
      finalAfterR1Read,
    ]);
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      verifyCoverage,
    });

    expect(model.calls).toBe(5);
    const gateObservations = (payloadAt(model, 4).observations ?? [])
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
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) =>
      reportAndReturn(input));
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
          answer: notCoveredRequirementAnswer("能力一"),
          citations: [],
        },
        {
          ...invalidFinal.requirements[1],
          answer: notCoveredRequirementAnswer("能力二"),
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
      "model_call",
      "read",
      "model_call",
      "coverage",
      "model_call",
      "coverage",
      "coverage_gaps",
    ]);
    expect(events.find((event) => event.event === "candidates")).toEqual({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [{ id: "A1", candidateCount: 1, readCandidateCount: 0 }],
    });
    expect(events.find((event) => event.event === "read")).toEqual({
      event: "read",
      requirementId: "R1",
      citation: 1,
      sectionHeadingCount: 0,
      aspectIds: ["A1"],
    });
    expect(events.filter((event) => event.event === "coverage")).toEqual([
      expect.objectContaining({ stage: "draft" }),
      expect.objectContaining({ stage: "verified" }),
    ]);
    expect(events.find((event) => event.event === "coverage_gaps")).toEqual({
      event: "coverage_gaps",
      domainCount: 1,
      gapCount: 0,
      gaps: [],
    });
    expect(JSON.stringify(events)).not.toContain("body:wiki/r1.md");
    expect(JSON.stringify(events)).not.toContain("wiki/r1.md");
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
      "temporarily_unavailable",
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

  it("preloads reviewed answer-card evidence even when lexical seed search misses", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      final("complete", "Reviewed governed migration evidence [1]", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        cardId: "CM-MIGRATION-001",
        cardObligationId: "O1",
        requiredConcepts: ["migration"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
    });

    expect(session.authorizeGovernedPaths).toHaveBeenCalledWith([
      "wiki/queries/governed-answer.md",
    ]);
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/queries/governed-answer.md",
      undefined,
    );
    expect(result).toMatchObject({
      status: "answered",
      references: [{ path: "wiki/queries/governed-answer.md" }],
    });
    expect(model.calls).toBe(1);
    expect(model.lastSchemaName()).toBe("pse_final_action");
  });

  it("does not preload unrelated seed pages after governed card evidence is ready", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/unrelated-project.md" }] },
    });
    session.compactPage.mockReturnValue(
      "The governed page requires measurable success criteria.",
    );
    const model = scriptedAgentModel([
      final("complete", "Use measurable success criteria [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        cardId: "CM-GOVERNED-001",
        cardObligationId: "O1",
        requiredConcepts: ["success criteria"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
    });

    expect(result.status).toBe("answered");
    expect(session.readPage).toHaveBeenCalledWith(
      "wiki/queries/governed-answer.md",
      undefined,
    );
    expect(session.readPage).not.toHaveBeenCalledWith(
      "wiki/unrelated-project.md",
      undefined,
    );
    expect(result.references).toEqual([
      expect.objectContaining({ path: "wiki/queries/governed-answer.md" }),
    ]);
  });

  it("repairs a missing answer-card concept as a natural model-authored fact", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    session.compactPage.mockReturnValue("The governed page requires measurable success criteria.");
    const model = scriptedAgentModel([
      final("complete", "Discuss business value with the customer [1].", [1]),
      final("complete", "Discuss business value and agree measurable success criteria with the customer [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["success criteria"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
    });

    expect(result.status).toBe("answered");
    expect(result.answer).toContain("success criteria");
    expect(result.answer).not.toContain("处理原则包括");
    expect(model.calls).toBe(2);
    expect(payloadAt(model, 1).observations).toEqual(expect.arrayContaining([
      expect.stringContaining("answer_card_concept_repair_required"),
    ]));
    expect(model.lastSchemaName()).toBe("pse_final_action");
  });

  it("asks for a natural rewrite when verification removes an answer-card concept", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    session.compactPage.mockReturnValue("The governed page requires a migration transition period.");
    const model = scriptedAgentModel([
      final("complete", "Use the approved migration boundary [1].", [1]),
      final("complete", "Use the approved migration transition period [1].", [1]),
      final("complete", "Use the approved migration transition period [1].", [1]),
    ]);
    let verificationCalls = 0;

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["transition period"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
      verifyCoverage: async (input) => {
        verificationCalls += 1;
        return reportAndReturn(input, verificationCalls === 1 ? {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            answer: "Use the approved migration boundary [1].",
            citations: [1],
          })),
          citations: [1],
        } : input.draft);
      },
    });

    expect(result.status).toBe("answered");
    expect(result.answer).toContain("transition period");
    expect(result.answer).not.toContain("处理原则包括");
    expect(model.calls).toBe(3);
    expect(verificationCalls).toBe(2);
  });

  it("restores a complete evidence fact after verifier concept repairs are exhausted", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    session.compactPage.mockReturnValue(
      "Use the approved migration transition period before the final cutover.",
    );
    const model = scriptedAgentModel([
      final("complete", "Use the approved migration transition period [1].", [1]),
      final("complete", "Use the approved migration transition period [1].", [1]),
      final("complete", "Use the approved migration transition period [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["transition period"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
      verifyCoverage: async (input) => reportAndReturn(input, {
        ...input.draft,
        requirements: input.draft.requirements.map((requirement) => ({
          ...requirement,
          answer: "Use the approved migration boundary [1].",
          citations: [1],
        })),
        citations: [1],
      }),
    });

    expect(result.status).toBe("answered");
    expect(result.answer).toContain("transition period before the final cutover");
    expect(result.answer).not.toContain("处理原则包括");
    expect(model.calls).toBe(3);
  });

  it("restores complete coverage when every grounded card fact survives verification", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    session.compactPage.mockReturnValue(
      "Use the approved migration transition period before final cutover.",
    );
    const model = scriptedAgentModel([
      final("complete", "Use the approved migration transition period [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["transition period"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
      verifyCoverage: async (input) => {
        const action = {
          ...input.draft,
          requirements: input.draft.requirements.map((requirement) => ({
            ...requirement,
            coverage: "partial" as const,
          })),
        };
        const report = inferCoverageVerificationReport(action, input.plan);
        input.onReport?.({
          ...report,
          summaries: report.summaries.map((summary) => ({
            ...summary,
            missingAspectCount: 0,
            missingAspectIds: [],
          })),
        });
        return action;
      },
    });

    expect(result.status).toBe("answered");
    expect(result.answer).toContain("transition period");
  });

  it("fails closed instead of keyword stuffing when a required concept stays missing", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      final("complete", "Discuss the approved migration path [1].", [1]),
      final("complete", "Discuss the approved migration path [1].", [1]),
      final("complete", "Discuss the approved migration path [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["MigratePassword"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
    });

    expect(result.status).toBe("temporarily_unavailable");
    expect(model.calls).toBe(3);
  });

  it("projects a complete governed fact after natural concept repairs are exhausted", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    session.compactPage.mockReturnValue(
      "Agree on measurable success criteria before proposing a price.",
    );
    const model = scriptedAgentModel([
      final("complete", "Discuss the approved value path [1].", [1]),
      final("complete", "Discuss the approved value path [1].", [1]),
      final("complete", "Discuss the approved value path [1].", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session),
      requirementBindings: [{
        domain: "presales-general",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        requiredConcepts: ["success criteria"],
        preferredEvidencePaths: ["wiki/queries/governed-answer.md"],
      }],
    });

    expect(result.status).toBe("answered");
    expect(result.answer).toContain(
      "Agree on measurable success criteria before proposing a price",
    );
    expect(result.answer).not.toContain("处理原则包括");
    expect(model.calls).toBe(3);
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

  it("returns unavailable after two explicit action repair attempts remain invalid", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([
      new InvalidModelPayloadError(),
      new InvalidModelPayloadError(),
      new InvalidModelPayloadError(),
    ]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(3);
    expect(result.status).toBe("temporarily_unavailable");
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

  it("does not preload pages for a business-specific synthesis question", async () => {
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
      read("R1", pages[0]!.path),
      final("complete", "根据已读正文进行保守归纳 [1]", [1]),
    ]);

    const result = await runKnowledgeAgent({
      ...agentInput(model, session, plan),
      scope: "general",
      question,
    });

    expect(payloadAt(model, 0).requirementEvidence?.[0]?.citationIndexes)
      .toEqual([]);
    expect(session.readPage).toHaveBeenCalledTimes(1);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.citationIndexes)
      .toHaveLength(0);
    expect(result.status).toBe("answered");
    expect(result.references).toHaveLength(1);
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

  it("allows two bounded repair attempts for invalid citations", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const badFinal = final("complete", "未经读取的结论[1]", [1]);
    const model = scriptedAgentModel([badFinal, badFinal, badFinal]);

    const result = await runKnowledgeAgent(agentInput(model, session));

    expect(model.calls).toBe(3);
    expect(model.lastSchemaName()).toBe("pse_final_action");
    expect(result.status).toBe("temporarily_unavailable");
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

  it("returns a verified unformatted detailed result and keeps the wrapper equivalent", async () => {
    const createFixture = () => {
      const session = fakeSession({ hits: { "seed-r1": [{ path: "wiki/r1.md" }] } });
      const model = scriptedAgentModel([
        read("R1", "wiki/r1.md"),
        final("complete", "已验证事实[1]。", [1]),
      ]);
      return { session, model };
    };
    const detailedFixture = createFixture();
    const detailed = await runKnowledgeAgentDetailed({
      ...agentInput(detailedFixture.model, detailedFixture.session),
      requirementBindings: [{
        domain: "coremail-professional",
        requirementId: "R1",
        deliverableId: "D7",
        obligationId: "O9",
        order: 4,
      }],
    });
    expect(detailed).toMatchObject({
      outcome: "verified",
      project: "coremail-professional",
      revision,
      action: {
        action: "final",
        requirements: [{ coverage: "complete", citations: [1] }],
      },
      references: [{ index: 1, path: "wiki/r1.md" }],
      verification: {
        coveredRequirementIds: ["R1"],
        missingRequirementIds: [],
      },
      evidenceLedger: {
        project: "coremail-professional",
        revision,
        units: [{
          binding: { deliverableId: "D7", obligationId: "O9" },
          queries: [
            { id: "Q1", status: "success" },
            { id: "Q2", status: "empty", plannedQueryIndexes: [] },
          ],
          candidates: [{ id: "C1", path: "wiki/r1.md" }],
          reads: [{ candidateId: "C1", status: "success", citation: 1 }],
          verification: { covered: true, missing: false },
        }],
      },
      coverageGaps: [],
    });
    expect(detailed).not.toHaveProperty("answer");
    expect(detailed).not.toHaveProperty("status");

    const wrapperFixture = createFixture();
    const wrapped = await runKnowledgeAgent(agentInput(wrapperFixture.model, wrapperFixture.session));
    expect(wrapped).toMatchObject({
      scope: "professional",
      status: "answered",
      references: [{ index: 1, path: "wiki/r1.md" }],
    });
    if (detailed.outcome === "verified") {
      expect(wrapped).toEqual(formatKnowledgeFinal(
        "professional",
        detailed.action,
        detailed.references,
      ));
    }
  });

  it("attributes a verified zero-candidate miss to a specific knowledge gap", async () => {
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([final("none", "当前资料未覆盖")]),
      fakeSession({ hits: { "seed-r1": [] } }),
    ));

    expect(result).toMatchObject({
      outcome: "verified",
      verification: {
        coveredRequirementIds: [],
        missingRequirementIds: ["R1"],
      },
      evidenceLedger: {
        units: [{
          queries: [
            { status: "empty", plannedQueryIndexes: [0] },
            { status: "empty", plannedQueryIndexes: [] },
          ],
          candidates: [],
          reads: [],
        }],
      },
      coverageGaps: [{
        id: "G1",
        requirementId: "R1",
        gapClass: "knowledge",
        reason: "no_matching_page",
        missingAspect: "测试证据面",
      }],
    });
  });

  it("keeps a partially failed required search classified as retrieval, not knowledge", async () => {
    const plan: KnowledgePlan = {
      subject: "检索失败归因",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: "确认测试证据",
        ...plannedEvidence("seed-unavailable", "seed-empty"),
        evidenceMode: "direct_only",
      }],
    };
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([final("none", "当前正式资料未覆盖")]),
      fakeSession({
        hits: { "seed-empty": [] },
        failedQueries: ["seed-unavailable"],
      }),
      plan,
    ));

    expect(result).toMatchObject({
      outcome: "verified",
      coverageGaps: [{
        gapClass: "retrieval",
        reason: "tool_unavailable",
      }],
    });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.queries.map((query) => query.status))
        .toEqual(expect.arrayContaining(["unavailable", "empty"]));
      expect(result.coverageGaps?.[0]).not.toMatchObject({ gapClass: "knowledge" });
    }
  });

  it("keeps seed ledger order stable when concurrent searches finish out of order", async () => {
    const plan: KnowledgePlan = {
      subject: "并发检索顺序",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: "确认测试证据",
        ...plannedEvidence("slow-seed", "fast-seed"),
        evidenceMode: "direct_only",
      }],
    };
    const session = fakeSession();
    session.search.mockImplementation(async (query: string) => {
      await new Promise((resolve) => setTimeout(resolve, query === "slow-seed" ? 15 : 0));
      return {
        project: "coremail-professional",
        revision,
        hits: [],
      };
    });
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([final("none", "当前正式资料未覆盖")]),
      session,
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.queries.map((query) => query.query))
        .toEqual(["slow-seed", "fast-seed"]);
    }
  });

  it("orders shared-only ledger candidates independently of final citation order", async () => {
    const plan: KnowledgePlan = {
      subject: "跨义务共享证据排序",
      requirements: [
        {
          id: "R1",
          question: "确认甲乙证据",
          evidenceMode: "direct_only",
          evidenceAspects: [{ id: "A1", label: "甲乙证据", terms: ["甲", "乙"] }],
          queries: [{ text: "甲乙证据", aspectIds: ["A1"] }],
        },
        {
          id: "R2",
          question: "复用已核验资料",
          evidenceMode: "direct_only",
          evidenceAspects: [{ id: "A1", label: "复用资料", terms: ["复用"] }],
          queries: [{ text: "无候选资料", aspectIds: ["A1"] }],
        },
      ],
    };
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        readPages(
          { requirementId: "R1", path: "wiki/shared-a.md" },
          { requirementId: "R1", path: "wiki/shared-b.md" },
        ),
        final("complete", "", [1, 2], [
          { id: "R1", coverage: "complete", citations: [1, 2] },
          { id: "R2", coverage: "complete", citations: [2, 1] },
        ]),
      ]),
      fakeSession({
        hits: {
          "甲乙证据": [
            { path: "wiki/shared-a.md", title: "甲证据" },
            { path: "wiki/shared-b.md", title: "乙证据" },
          ],
          "无候选资料": [],
        },
      }),
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[1]?.candidates.map(({ path }) => path))
        .toEqual(["wiki/shared-a.md", "wiki/shared-b.md"]);
    }
  });

  it("records seed, supplemental, and graph candidate provenance from executed tools", async () => {
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        graph("R1", "wiki/r1.md"),
        search("R1", "extra-query"),
        final("complete", "已核验事实[1]", [1]),
      ]),
      fakeSession({
        hits: {
          "seed-r1": [{ path: "wiki/r1.md" }],
          "extra-query": [{ path: "wiki/extra.md" }],
        },
        graphHits: [{ path: "wiki/graph.md" }],
      }),
      { ...singlePlan, retrievalStrategy: "coverage_units" },
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.candidates.map((candidate) => ({
        path: candidate.path,
        sources: candidate.sources,
      }))).toEqual(expect.arrayContaining([
        { path: "wiki/r1.md", sources: ["seed"] },
        { path: "wiki/extra.md", sources: ["supplemental"] },
        { path: "wiki/graph.md", sources: ["graph"] },
      ]));
    }
  });

  it("records a failed broad global search on every affected requirement", async () => {
    const plan: KnowledgePlan = {
      subject: "全局检索归属",
      requirements: [
        {
          id: "R1",
          question: "确认甲项证据",
          ...plannedEvidence("seed-r1"),
          evidenceMode: "direct_only",
        },
        {
          id: "R2",
          question: "确认乙项证据",
          ...plannedEvidence("seed-r2"),
          evidenceMode: "direct_only",
        },
      ],
    };
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([final("none", "当前正式资料未覆盖", [], [
        { id: "R1", coverage: "none", citations: [] },
        { id: "R2", coverage: "none", citations: [] },
      ])]),
      fakeSession({
        hits: { "seed-r1": [], "seed-r2": [] },
        failedQueries: ["测试问题"],
      }),
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      for (const unit of result.evidenceLedger?.units ?? []) {
        expect(unit.queries).toEqual(expect.arrayContaining([
          expect.objectContaining({
            phase: "seed",
            query: "测试问题",
            status: "unavailable",
            plannedQueryIndexes: [],
          }),
        ]));
      }
      expect(result.coverageGaps?.map((gap) => [
        gap.requirementId,
        gap.gapClass,
        gap.reason,
      ])).toEqual([
        ["R1", "retrieval", "tool_unavailable"],
        ["R2", "retrieval", "tool_unavailable"],
      ]);
    }
  });

  it("executes one physical seed search when the global and planned queries normalize equally", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        scriptedAgentModel([final("none", "当前正式资料未覆盖")]),
        session,
      ),
      question: "  SEED-R1  ",
    });

    expect(result).toMatchObject({ outcome: "verified" });
    expect(session.search).toHaveBeenCalledTimes(1);
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.queries).toHaveLength(1);
      expect(result.evidenceLedger?.units[0]?.queries[0]).toMatchObject({
        plannedQueryIndexes: [0],
        status: "empty",
      });
    }
  });

  it("limits shared physical seed hits to each consumer's own search window", async () => {
    const plan: KnowledgePlan = {
      subject: "共享查询窗口",
      requirements: [
        {
          id: "R1",
          question: "直接核验共同证据",
          evidenceMode: "direct_only",
          evidenceAspects: [{ id: "A1", label: "共同证据", terms: ["共同证据"] }],
          queries: [{ text: "共同证据 第二方面 第三方面 第四方面", aspectIds: ["A1"] }],
        },
        {
          id: "R2",
          question: "综合核验共同证据",
          evidenceMode: "synthesis_allowed",
          evidenceAspects: [
            { id: "A1", label: "共同证据", terms: ["共同证据"] },
            { id: "A2", label: "第二方面", terms: ["第二方面"] },
            { id: "A3", label: "第三方面", terms: ["第三方面"] },
            { id: "A4", label: "第四方面", terms: ["第四方面"] },
          ],
          queries: [{
            text: "共同证据 第二方面 第三方面 第四方面",
            aspectIds: ["A1", "A2", "A3", "A4"],
          }],
        },
      ],
    };
    const hits = Array.from({ length: 12 }, (_, index) => ({
      path: `wiki/shared-${String(index + 1).padStart(2, "0")}.md`,
      title: `共同证据 ${index + 1}`,
      matchedTerms: ["共同证据"],
      snippet: "共同证据",
    }));
    const model = scriptedAgentModel([final("none", "当前正式资料未覆盖", [], [
      { id: "R1", coverage: "none", citations: [] },
      { id: "R2", coverage: "none", citations: [] },
    ])]);

    await runKnowledgeAgentDetailed(agentInput(
      model,
      fakeSession({ hits: { "共同证据 第二方面 第三方面 第四方面": hits } }),
      plan,
    ));

    expect(payloadAt(model, 0).requirementEvidence?.map((item) =>
      item.aspects[0]?.candidateCount)).toEqual([10, 12]);
  });

  it("fans a global-only batch read success into every explicit consumer as a direct read", async () => {
    const plan: KnowledgePlan = {
      subject: "全局候选显式读取",
      requirements: [
        {
          id: "R1",
          question: "确认甲项测试证据",
          ...plannedEvidence("seed-r1"),
          evidenceMode: "direct_only",
        },
        {
          id: "R2",
          question: "确认乙项测试证据",
          ...plannedEvidence("seed-r2"),
          evidenceMode: "direct_only",
        },
      ],
    };
    const session = fakeSession({
      hits: {
        "测试证据": [{
          path: "wiki/global-shared.md",
          title: "测试证据",
          matchedTerms: ["测试证据"],
        }],
        "seed-r1": [],
        "seed-r2": [],
      },
    });
    const model = scriptedAgentModel([
      readPages(
        { requirementId: "R2", path: "wiki/global-shared.md" },
        { requirementId: "R1", path: "wiki/global-shared.md" },
      ),
      final("complete", "已核验共享事实[1]", [1], [
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [1] },
      ]),
    ]);
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(model, session, plan),
      question: "测试证据",
    });

    expect(result).toMatchObject({ outcome: "verified", coverageGaps: [] });
    expect(session.readPage).toHaveBeenCalledTimes(1);
    expect(payloadAt(model, 1).requirementEvidence?.map((item) =>
      item.remainingReads)).toEqual([2, 2]);
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units.map((unit) =>
        unit.reads.map((item) => item.status))).toEqual([
        ["success"],
        ["success"],
      ]);
    }
  });

  it("keeps an unread aspect-matched global candidate as a retrieval gap after read budget exhaustion", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/one.md" },
          { path: "wiki/two.md" },
          { path: "wiki/three.md" },
        ],
        "测试证据": [{
          path: "wiki/global-relevant.md",
          title: "测试证据",
          matchedTerms: ["测试证据"],
        }],
      },
    });
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        scriptedAgentModel([
          readPages(
            { requirementId: "R1", path: "wiki/one.md" },
            { requirementId: "R1", path: "wiki/two.md" },
          ),
          read("R1", "wiki/three.md"),
          final("none", "当前正式资料未覆盖"),
        ]),
        session,
      ),
      question: "测试证据",
    });

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.candidates.find((candidate) =>
        candidate.path === "wiki/global-relevant.md")?.reviewRequired).toBe(true);
      expect(result.coverageGaps?.[0]).toMatchObject({
        gapClass: "retrieval",
        reason: "retrieval_budget_exhausted",
      });
    }
  });

  it("keeps an unread unclassified global candidate out of knowledge-gap attribution", async () => {
    const session = fakeSession({
      hits: {
        "seed-r1": [
          { path: "wiki/one.md" },
          { path: "wiki/two.md" },
          { path: "wiki/three.md" },
        ],
        "全局未知页面": [{
          path: "wiki/global-unclassified.md",
          title: "索引条目",
          matchedTerms: ["索引条目"],
          snippet: "索引条目",
        }],
      },
    });
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        scriptedAgentModel([
          readPages(
            { requirementId: "R1", path: "wiki/one.md" },
            { requirementId: "R1", path: "wiki/two.md" },
          ),
          read("R1", "wiki/three.md"),
          final("none", "当前正式资料未覆盖"),
        ]),
        session,
      ),
      question: "全局未知页面",
    });

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.candidates.find((candidate) =>
        candidate.path === "wiki/global-unclassified.md")?.reviewRequired).toBe(true);
      expect(result.coverageGaps?.[0]).toMatchObject({
        gapClass: "retrieval",
        reason: "retrieval_budget_exhausted",
      });
    }
  });

  it("continues broad synthesis after one preload read fails and returns a retrieval gap", async () => {
    const plan: KnowledgePlan = {
      subject: "综合预读容错",
      requirements: [{
        id: "R1",
        question: "综合四类证据",
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [
          { id: "A1", label: "甲类", terms: ["甲类"] },
          { id: "A2", label: "乙类", terms: ["乙类"] },
          { id: "A3", label: "丙类", terms: ["丙类"] },
          { id: "A4", label: "丁类", terms: ["丁类"] },
        ],
        queries: [{
          text: "甲类 乙类 丙类 丁类",
          aspectIds: ["A1", "A2", "A3", "A4"],
        }],
      }],
    };
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([final("partial", "已核验部分事实[1]", [1])]),
      fakeSession({
        hits: {
          "甲类 乙类 丙类 丁类": [
            { path: "wiki/a-fail.md", title: "甲类", matchedTerms: ["甲类"], snippet: "甲类" },
            { path: "wiki/b.md", title: "乙类", matchedTerms: ["乙类"], snippet: "乙类" },
            { path: "wiki/c.md", title: "丙类", matchedTerms: ["丙类"], snippet: "丙类" },
            { path: "wiki/d.md", title: "丁类", matchedTerms: ["丁类"], snippet: "丁类" },
          ],
        },
        failedReadPaths: ["wiki/a-fail.md"],
      }),
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.reads).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "wiki/a-fail.md", status: "unavailable" }),
        expect.objectContaining({ status: "success" }),
      ]));
      expect(result.coverageGaps?.[0]).toMatchObject({
        gapClass: "retrieval",
        reason: "tool_unavailable",
      });
    }
  });

  it.each([
    ["R1 first", [{ requirementId: "R1", path: "wiki/shared.md" }, { requirementId: "R2", path: "wiki/shared.md" }]],
    ["R2 first", [{ requirementId: "R2", path: "wiki/shared.md" }, { requirementId: "R1", path: "wiki/shared.md" }]],
  ] as const)(
    "fans a shared physical read failure out to every accepted requirement: %s",
    async (_name, pages) => {
      const plan: KnowledgePlan = {
        subject: "共享读取失败",
        requirements: [
          {
            id: "R1",
            question: "确认甲项证据",
            ...plannedEvidence("seed-r1"),
            evidenceMode: "direct_only",
          },
          {
            id: "R2",
            question: "确认乙项证据",
            ...plannedEvidence("seed-r2"),
            evidenceMode: "direct_only",
          },
        ],
      };
      const session = fakeSession({
        hits: {
          "seed-r1": [{ path: "wiki/shared.md" }],
          "seed-r2": [{ path: "wiki/shared.md" }],
        },
        failedReadPaths: ["wiki/shared.md"],
      });
      const model = scriptedAgentModel([
        readPages(...pages),
        final("none", "当前正式资料未覆盖", [], [
          { id: "R1", coverage: "none", citations: [] },
          { id: "R2", coverage: "none", citations: [] },
        ]),
      ]);

      await runKnowledgeAgent(agentInput(model, session, plan));

      const observations = payloadAt(model, 1).observations?.join("\n") ?? "";
      expect(observations).toContain('"requirementId":"R1"');
      expect(observations).toContain('"requirementId":"R2"');
      expect(observations).toContain('"tool":"kb.read_page"');
    },
  );

  it("clears shared read failures for every requirement after one physical retry succeeds", async () => {
    const plan: KnowledgePlan = {
      subject: "共享读取恢复",
      requirements: [
        {
          id: "R1",
          question: "确认甲项证据",
          ...plannedEvidence("seed-r1"),
          evidenceMode: "direct_only",
        },
        {
          id: "R2",
          question: "确认乙项证据",
          ...plannedEvidence("seed-r2"),
          evidenceMode: "direct_only",
        },
      ],
    };
    const session = fakeSession({
      hits: {
        "seed-r1": [{ path: "wiki/shared.md" }],
        "seed-r2": [{ path: "wiki/shared.md" }],
      },
      failedReadAttempts: 1,
    });
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        readPages(
          { requirementId: "R2", path: "wiki/shared.md" },
          { requirementId: "R1", path: "wiki/shared.md" },
        ),
        read("R1", "wiki/shared.md"),
        final("complete", "共享正式事实[1]", [1], [
          { id: "R1", coverage: "complete", citations: [1] },
          { id: "R2", coverage: "complete", citations: [1] },
        ]),
      ]),
      session,
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified", coverageGaps: [] });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units).toHaveLength(2);
      for (const unit of result.evidenceLedger?.units ?? []) {
        expect(unit.retrieval.toolUnavailableCount).toBe(0);
        expect(unit.reads.map((item) => item.status)).toEqual([
          "unavailable",
          "success",
        ]);
      }
      expect(session.readPage).toHaveBeenCalledTimes(2);
    }
  });

  it("allows an explicitly repeated read action to recover from a transient failure", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/transient.md" }] },
      failedReadAttempts: 1,
    });
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        read("R1", "wiki/transient.md"),
        read("R1", "wiki/transient.md"),
        final("complete", "瞬时失败后已核验事实[1]", [1]),
      ]),
      session,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    expect(session.readPage).toHaveBeenCalledTimes(2);
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.reads).toEqual([
        expect.objectContaining({ path: "wiki/transient.md", status: "unavailable" }),
        expect.objectContaining({ path: "wiki/transient.md", status: "success" }),
      ]);
    }
  });

  it.each([
    ["summary", "summary", [] as const, "summary_only", "summary_only"],
    [
      "external",
      "external",
      ["https://example.test/formal-source"] as const,
      "external_only",
      "external_source_only",
    ],
  ] as const)("preserves %s source provenance when one read is shared across requirements", async (
    _name,
    pageType,
    pageSources,
    expectedBoundary,
    expectedReason,
  ) => {
    const plan: KnowledgePlan = {
      subject: "共享来源边界",
      requirements: [
        {
          id: "R1",
          question: "确认甲项证据",
          ...plannedEvidence("seed-r1"),
          evidenceMode: "direct_only",
        },
        {
          id: "R2",
          question: "确认乙项证据",
          ...plannedEvidence("seed-r2"),
          evidenceMode: "direct_only",
        },
      ],
    };
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        readPages(
          { requirementId: "R1", path: "wiki/shared.md" },
          { requirementId: "R2", path: "wiki/shared.md" },
        ),
        final("partial", "摘要只能确认部分事实[1]", [1], [
          { id: "R1", coverage: "partial", citations: [1] },
          { id: "R2", coverage: "partial", citations: [1] },
        ]),
      ]),
      fakeSession({
        hits: {
          "seed-r1": [{ path: "wiki/shared.md" }],
          "seed-r2": [{ path: "wiki/shared.md" }],
        },
        pageType,
        pageSources,
      }),
      plan,
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units.map((unit) => unit.sourceBoundary))
        .toEqual([expectedBoundary, expectedBoundary]);
      expect(result.coverageGaps?.map((gap) => [gap.requirementId, gap.gapClass, gap.reason]))
        .toEqual([
          ["R1", "source", expectedReason],
          ["R2", "source", expectedReason],
        ]);
    }
  });

  it.each([
    ["empty", false, "empty"],
    ["unavailable", true, "unavailable"],
  ] as const)("records graph %s as an obligation-bound ledger action", async (
    _name,
    failGraph,
    expectedStatus,
  ) => {
    const result = await runKnowledgeAgentDetailed(agentInput(
      scriptedAgentModel([
        graph("R1", "wiki/r1.md"),
        read("R1", "wiki/r1.md"),
        final("none", "当前正式资料未覆盖"),
      ]),
      fakeSession({
        hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
        failGraph,
      }),
    ));

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.graphs).toEqual([
        expect.objectContaining({
          id: "G1",
          sourcePath: "wiki/r1.md",
          status: expectedStatus,
          hitCount: 0,
        }),
      ]);
      expect(result.coverageGaps?.[0]).toMatchObject(
        failGraph
          ? { gapClass: "retrieval", reason: "tool_unavailable" }
          : { gapClass: "knowledge", reason: "read_pages_do_not_support" },
      );
    }
  });

  it.each([
    [
      "required input",
      { inputState: "missing", ambiguous: false, conflictDetected: false, freshness: "not_assessed" },
      ["input", "required_customer_input_missing"],
    ],
    [
      "ambiguity",
      { inputState: "not_applicable", ambiguous: true, conflictDetected: false, freshness: "not_assessed" },
      ["ambiguity", "ambiguous_question"],
    ],
    [
      "conflict",
      { inputState: "not_applicable", ambiguous: false, conflictDetected: true, freshness: "not_assessed" },
      ["conflict", "conflicting_sources"],
    ],
    [
      "freshness",
      { inputState: "not_applicable", ambiguous: false, conflictDetected: false, freshness: "stale_or_unconfirmed" },
      ["freshness", "stale_or_unconfirmed"],
    ],
  ] as const)("threads structured %s evidence conditions into the real gap producer", async (
    _name,
    condition,
    expected,
  ) => {
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        scriptedAgentModel([final("none", "当前正式资料未覆盖")]),
        fakeSession({ hits: { "seed-r1": [] } }),
      ),
      requirementEvidenceConditions: [{
        requirementId: "R1",
        ...condition,
      }],
    });

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect([
        result.coverageGaps?.[0]?.gapClass,
        result.coverageGaps?.[0]?.reason,
      ]).toEqual(expected);
    }
  });

  it("removes current-case conclusions when required customer input is missing", async () => {
    const plan: KnowledgePlan = {
      subject: "当前机会判断",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: "判断当前机会赢率",
        evidenceMode: "synthesis_allowed",
        ...plannedEvidence("seed-r1"),
      }],
    };
    const model = scriptedAgentModel([
      final("complete", "当前机会赢率为 75%。"),
    ]);
    const verifierModel = {
      completeJson: vi.fn(),
      completeText: vi.fn(),
    } as unknown as ModelClient;
    const verifyCoverage = vi.fn(async (input: CoverageVerifierInput) => {
      expect(input.model).toBe(verifierModel);
      expect(input.draft.requirements[0]).toMatchObject({
        coverage: "none",
        citations: [],
      });
      expect(input.draft.requirements[0]?.answer).not.toContain("75%");
      return reportAndReturn(input);
    });

    const session = fakeSession({ hits: { "seed-r1": [{ path: "wiki/r1.md" }] } });
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        model,
        session,
        plan,
      ),
      verifyCoverage,
      verifierModel,
      requirementEvidenceConditions: [{
        requirementId: "R1",
        inputState: "missing",
        ambiguous: false,
        conflictDetected: false,
        freshness: "not_assessed",
      }],
    });

    expect(verifyCoverage).toHaveBeenCalledOnce();
    expect(session.search).not.toHaveBeenCalled();
    expect(result.outcome === "verified" && result.evidenceLedger?.units[0]?.queries)
      .toEqual([expect.objectContaining({ status: "not_applicable" })]);
    expect(payloadAt(model, 0).requirementEvidence?.[0]?.evidenceCondition)
      .toMatchObject({ inputState: "missing" });
    expect(result).toMatchObject({
      outcome: "verified",
      action: { requirements: [{ coverage: "none", citations: [] }] },
      coverageGaps: [{ gapClass: "input", reason: "required_customer_input_missing" }],
    });
  });

  it("materializes retained and removed verifier segments as distinct ledger claims", async () => {
    const plan: KnowledgePlan = {
      subject: "逐段证据决策",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: "分别核验已支持事实与待确认事实",
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "已支持事实", terms: ["已支持"] },
          { id: "A2", label: "待确认事实", terms: ["待确认"] },
        ],
        queries: [{ text: "逐段核验证据", aspectIds: ["A1", "A2"] }],
      }],
    };
    const model = scriptedAgentModel([
      final("partial", "已支持事实[1]。待确认事实[1]。", [1]),
    ]);
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        model,
        fakeSession({
          hits: { "逐段核验证据": [{ path: "wiki/claims.md" }] },
        }),
        plan,
      ),
      verifyCoverage: async (input) => {
        input.onReport?.({
          summaries: [{
            id: "R1",
            reason: "partial_support",
            retainedDirectSegmentCount: 1,
            retainedSynthesizedSegmentCount: 0,
            removedSegmentCount: 1,
            coveredAspectCount: 1,
            missingAspectCount: 1,
            coveredAspectIds: ["A1"],
            missingAspectIds: ["A2"],
            claimDecisions: [
              {
                claimIndex: 0,
                status: "retained_direct",
                citations: [1],
                coveredAspectIds: ["A1"],
              },
              {
                claimIndex: 1,
                status: "removed",
                citations: [1],
                coveredAspectIds: [],
              },
            ],
          }],
          coveredRequirementIds: ["R1"],
          missingRequirementIds: ["R1"],
        });
        return input.draft;
      },
    });

    expect(result).toMatchObject({ outcome: "verified" });
    if (result.outcome === "verified") {
      expect(result.evidenceLedger?.units[0]?.claims).toEqual([
        {
          claimIndex: 0,
          status: "retained_direct",
          citations: [1],
          coveredAspectIds: ["A1"],
        },
        {
          claimIndex: 1,
          status: "removed",
          citations: [1],
          coveredAspectIds: [],
        },
      ]);
    }
  });

  it("fails closed when a verifier returns without a structured verification report", async () => {
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(
        scriptedAgentModel([final("none", "当前资料未覆盖该问题")]),
        fakeSession({ hits: { "seed-r1": [] } }),
      ),
      verifyCoverage: async (input) => input.draft,
    });

    expect(result).toMatchObject({ outcome: "unavailable" });
  });

  it("uses one absolute-deadline signal for tools, action model, and verifier", async () => {
    const session = fakeSession({
      hits: { "seed-r1": [{ path: "wiki/r1.md" }] },
    });
    const model = scriptedAgentModel([
      graph("R1", "wiki/r1.md"),
      read("R1", "wiki/r1.md"),
      final("complete", "已验证事实[1]。", [1]),
    ]);
    let verifierSignal: AbortSignal | undefined;
    const result = await runKnowledgeAgentDetailed({
      ...agentInput(model, session),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      verifyCoverage: async (input) => {
        verifierSignal = input.signal;
        return reportAndReturn(input);
      },
    });
    expect(result.outcome).toBe("verified");

    const searchCalls = session.search.mock.calls as unknown as Array<
      [string, number, AbortSignal?]
    >;
    const graphCalls = session.graph.mock.calls as unknown as Array<
      [string, number, AbortSignal?]
    >;
    const readCalls = session.readPage.mock.calls as unknown as Array<
      [string, AbortSignal?]
    >;
    const observedSignals = [
      searchCalls[0]?.[2],
      graphCalls[0]?.[2],
      readCalls[0]?.[1],
      ...((model.completeJson as unknown as { mock: { calls: Array<[{
        signal?: AbortSignal;
      }]> } }).mock.calls.map(([input]) => input.signal)),
      verifierSignal,
    ];
    expect(observedSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(observedSignals).size).toBe(1);
  });

  it("does not start the coverage verifier after the absolute deadline", async () => {
    const session = fakeSession({ hits: { "seed-r1": [] } });
    const model = scriptedAgentModel([final("none", "当前资料未覆盖该问题")]);
    const verifyCoverage = vi.fn(async ({ draft }: CoverageVerifierInput) => draft);

    const result = await runKnowledgeAgentDetailed({
      ...agentInput(model, session),
      deadlineAt: Date.now() - 1,
      verifyCoverage,
    });

    expect(result.outcome).toBe("unavailable");
    expect(verifyCoverage).not.toHaveBeenCalled();
  });
});
