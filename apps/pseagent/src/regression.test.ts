import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runKnowledgeAgent, type KnowledgeAgentSession } from "./agent-loop.js";
import { AnswerService } from "./answer-service.js";
import {
  answerStatusSchema,
  scopeSchema,
  type AgentAction,
} from "./contracts.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { ModelClient, ModelMessage } from "./model-client.js";
import { NOT_COVERED_TEXT } from "./response.js";
import { ScopeRouter } from "./router.js";

const projectSchema = z.enum(["coremail-professional", "presales-general"]);
const regressionCaseSchema = z.object({
  id: z.string().regex(/^[PGNMX]\d{2}$/u),
  question: z.string().trim().min(1),
  expectedScope: scopeSchema,
  expectedStatus: answerStatusSchema,
  allowedProjects: z.array(projectSchema),
  requiredFacts: z.array(z.string().trim().min(1)),
  relatedFacts: z.array(z.string().trim().min(1)).default([]),
  forbiddenFacts: z.array(z.string().trim().min(1)).min(1),
  allowedSourcePages: z.array(z.string().trim().min(1)),
}).strict().superRefine((item, context) => {
  const expectedProjects = item.expectedScope === "professional"
    ? ["coremail-professional"]
    : item.expectedScope === "general"
      ? ["presales-general"]
      : [];
  if (JSON.stringify(item.allowedProjects) !== JSON.stringify(expectedProjects)) {
    context.addIssue({ code: "custom", path: ["allowedProjects"], message: "scope_project_mismatch" });
  }
  if (item.expectedScope === "normal" && item.expectedStatus !== "answered") {
    context.addIssue({ code: "custom", path: ["expectedStatus"], message: "normal_must_be_answered" });
  }
  const coveredKnowledgeCase = item.expectedScope !== "normal" && item.expectedStatus === "answered";
  if (coveredKnowledgeCase && (item.requiredFacts.length === 0 || item.allowedSourcePages.length === 0)) {
    context.addIssue({ code: "custom", path: ["allowedSourcePages"], message: "covered_case_requires_evidence" });
  }
  if (item.expectedStatus === "not_covered" && item.requiredFacts.length !== 0) {
    context.addIssue({ code: "custom", path: ["requiredFacts"], message: "not_covered_must_not_declare_target_facts" });
  }
  if (item.expectedStatus !== "not_covered" && item.relatedFacts.length !== 0) {
    context.addIssue({ code: "custom", path: ["relatedFacts"], message: "related_facts_require_not_covered" });
  }
  const relatedEvidenceDeclared = item.relatedFacts.length > 0 || (
    item.expectedStatus === "not_covered" && item.allowedSourcePages.length > 0
  );
  if (
    relatedEvidenceDeclared &&
    (item.relatedFacts.length === 0 || item.allowedSourcePages.length === 0)
  ) {
    context.addIssue({ code: "custom", path: ["relatedFacts"], message: "related_evidence_requires_facts_and_pages" });
  }
});
type RegressionCase = z.infer<typeof regressionCaseSchema>;

const datasetPath = fileURLToPath(new URL("../../../tests/regression/questions.json", import.meta.url));
const cases = z.array(regressionCaseSchema).length(41).parse(JSON.parse(readFileSync(datasetPath, "utf8")));
const revision = "a".repeat(40);
const contentHash = "b".repeat(64);

function scriptedModel(actions: AgentAction[], textAnswer: string): ModelClient {
  return {
    completeJson: vi.fn(async (input) => {
      const next = actions.shift();
      if (!next) throw new Error("missing_scripted_action");
      return input.schema.parse(next);
    }),
    completeText: vi.fn(async () => textAnswer),
  };
}

function routingModel(): ModelClient {
  return {
    completeJson: vi.fn(async (input) => {
      const prompt = input.messages.map((message: ModelMessage) => message.content).join("\n");
      const matches = cases.filter((item) => prompt.includes(item.question));
      expect(matches).toHaveLength(1);
      return input.schema.parse({ action: "route", scope: matches[0]?.expectedScope });
    }),
    completeText: vi.fn(),
  } as unknown as ModelClient;
}

function fakeSession(
  scope: "professional" | "general",
  evidence: RegressionCase | undefined,
  projectsCalled: string[],
  pagesRead: string[],
) {
  const project = scope === "professional" ? "coremail-professional" as const : "presales-general" as const;
  const path = evidence?.allowedSourcePages[0] ?? "wiki/not-covered.md";
  const body = evidence === undefined
    ? ""
    : [...evidence.requiredFacts, ...evidence.relatedFacts].join("；");
  return {
    project,
    revision,
    schema: "schema",
    overview: "overview",
    search: vi.fn(async () => {
      projectsCalled.push(project);
      return {
        project,
        revision,
        hits: evidence
          ? [{
              path,
              title: evidence.id,
              score: 1,
              matchedTerms: [...evidence.requiredFacts, ...evidence.relatedFacts],
              snippet: body,
            }]
          : [],
      };
    }),
    graph: vi.fn(async () => {
      projectsCalled.push(project);
      return { project, revision, hits: [] };
    }),
    readPage: vi.fn(async (requestedPath: string) => {
      projectsCalled.push(project);
      pagesRead.push(requestedPath);
      if (!evidence || !evidence.allowedSourcePages.includes(requestedPath)) throw new Error("unexpected_page_read");
      return {
        project,
        path: requestedPath,
        title: evidence.id,
        type: "concept",
        tags: [],
        related: [],
        sources: ["source.md"],
        body,
        contentHash,
      };
    }),
    compactPage: vi.fn(() => body),
  } satisfies KnowledgeAgentSession;
}

function actionsFor(testCase: RegressionCase): AgentAction[] {
  if (testCase.expectedScope === "normal") return [];
  if (testCase.expectedStatus === "answered") {
    const path = testCase.allowedSourcePages[0];
    if (!path) throw new Error("missing_allowed_source_page");
    return [
      {
        action: "tool",
        tool: "kb.search",
        input: { requirementId: "R1", query: testCase.question, topK: 5 },
      },
      { action: "tool", tool: "kb.read_page", input: { requirementId: "R1", path } },
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "complete",
          answer: `${testCase.requiredFacts.join("；")} [1]`,
          citations: [1],
        }],
        citations: [1],
      },
    ];
  }
  if (testCase.relatedFacts.length > 0) {
    const path = testCase.allowedSourcePages[0];
    if (!path) throw new Error("missing_related_source_page");
    return [
      {
        action: "tool",
        tool: "kb.search",
        input: { requirementId: "R1", query: testCase.question, topK: 5 },
      },
      { action: "tool", tool: "kb.read_page", input: { requirementId: "R1", path } },
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          citations: [],
          relatedContext: [{
            statement: `正文明确列出 ${testCase.relatedFacts.join("、")} 协议能力 [1]。`,
            citations: [1],
          }],
        }],
        citations: [1],
      },
    ];
  }
  return [
    {
      action: "tool",
      tool: "kb.search",
      input: { requirementId: "R1", query: testCase.question, topK: 5 },
    },
    {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "当前资料未覆盖该问题",
        citations: [],
      }],
      citations: [],
    },
  ];
}

describe("fixed 41-question scripted protocol regression", () => {
  it("is explicitly a protocol harness rather than a real retrieval quality test", () => {
    expect(scriptedModel).toBeTypeOf("function");
    expect(fakeSession).toBeTypeOf("function");
  });

  it("contains exactly 41 unique stable IDs", () => {
    expect(cases).toHaveLength(41);
    expect(new Set(cases.map((item) => item.id)).size).toBe(41);
    expect(cases.map((item) => item.id)).toEqual([
      "P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10", "P11",
      "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10",
      "N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08", "N09", "N10",
      "M01", "M02", "M03", "M04", "M05",
      "X01", "X02", "X03", "X04", "X05",
    ]);
  });

  it("declares formal related evidence only for P11", () => {
    expect(cases.filter((item) =>
      item.expectedStatus === "not_covered" &&
      (item.relatedFacts.length > 0 || item.allowedSourcePages.length > 0)
    ).map((item) => item.id)).toEqual(["P11"]);
  });

  it("declares complete acceptance expectations for every case", () => {
    for (const item of cases) {
      expect(item.expectedStatus).toBeTruthy();
      expect(item.allowedProjects).toEqual(
        item.expectedScope === "professional"
          ? ["coremail-professional"]
          : item.expectedScope === "general"
            ? ["presales-general"]
            : [],
      );
      expect(item.forbiddenFacts.length).toBeGreaterThan(0);
      if (item.expectedScope !== "normal" && item.expectedStatus === "answered") {
        expect(item.requiredFacts.length).toBeGreaterThan(0);
        expect(item.allowedSourcePages.length).toBeGreaterThan(0);
      }
      if (item.expectedStatus === "not_covered") {
        expect(item.requiredFacts).toEqual([]);
        expect(item.relatedFacts.length === 0).toBe(
          item.allowedSourcePages.length === 0,
        );
      }
    }
  });

  it("contains an evidence-backed answered general case", () => {
    const answeredGeneral = cases.filter(
      (item) => item.expectedScope === "general" && item.expectedStatus === "answered",
    );
    expect(answeredGeneral.length).toBeGreaterThan(0);
    for (const item of answeredGeneral) {
      expect(item.allowedProjects).toEqual(["presales-general"]);
      expect(item.requiredFacts.length).toBeGreaterThan(0);
      expect(item.allowedSourcePages.length).toBeGreaterThan(0);
    }
  });

  it("activates the imported SPIN evidence case", () => {
    expect(cases.find((item) => item.id === "G03")).toMatchObject({
      expectedScope: "general",
      expectedStatus: "answered",
      allowedProjects: ["presales-general"],
      requiredFacts: ["情境问题", "问题问题", "暗示问题", "需求效益问题"],
      allowedSourcePages: ["wiki/concepts/spin四类问题.md"],
    });
  });

  it("keeps P11 uncovered while declaring only formal related protocol evidence", () => {
    expect(cases.find((item) => item.id === "P11")).toMatchObject({
      expectedScope: "professional",
      expectedStatus: "not_covered",
      requiredFacts: [],
      relatedFacts: ["SMTP", "POP3", "IMAP", "HTTP/HTTPS"],
      forbiddenFacts: ["已经支持", "明确不支持", "尚未支持"],
      allowedSourcePages: ["wiki/concepts/邮件系统协议基础.md"],
    });
  });

  it.each(cases)("routes and handles $id", async (testCase) => {
    const routeModel = routingModel();
    const routed = await new ScopeRouter(routeModel).route(testCase.question);
    expect(routed).toBe(testCase.expectedScope);
    expect(routeModel.completeJson).toHaveBeenCalledOnce();

    const evidence = testCase.expectedScope !== "normal" && (
      testCase.expectedStatus === "answered" || testCase.relatedFacts.length > 0
    ) ? testCase : undefined;
    const textAnswer = testCase.requiredFacts.join("；");
    const model = scriptedModel(actionsFor(testCase), textAnswer);
    const projectsCalled: string[] = [];
    const pagesRead: string[] = [];
    const knowledge = {
      open: vi.fn(async (scope: "professional" | "general") =>
        fakeSession(scope, evidence, projectsCalled, pagesRead) as unknown as KnowledgeSession),
    };
    const service = new AnswerService({
      model,
      router: { route: vi.fn(async () => routed) },
      planner: {
        plan: vi.fn(async () => ({
          subject: testCase.question,
          requirements: [{
            id: "R1" as const,
            question: testCase.question,
            queries: [testCase.question],
          }],
        })),
      },
      knowledge,
      runAgent: (input) => runKnowledgeAgent({
        ...input,
        verifyCoverage: async ({ draft }) => draft,
      }),
    });

    const result = await service.answer(testCase.question);

    expect(result.scope).toBe(testCase.expectedScope);
    expect(result.status).toBe(testCase.expectedStatus);
    for (const fact of testCase.requiredFacts) expect(result.answer).toContain(fact);
    for (const fact of testCase.relatedFacts) expect(result.answer).toContain(fact);
    for (const fact of testCase.forbiddenFacts) expect(result.answer).not.toContain(fact);

    if (testCase.expectedScope === "normal") {
      expect(knowledge.open).not.toHaveBeenCalled();
      expect(projectsCalled).toEqual([]);
      expect(pagesRead).toEqual([]);
      expect(result.references).toEqual([]);
      return;
    }

    expect(knowledge.open).toHaveBeenCalledWith(
      testCase.expectedScope,
      expect.any(AbortSignal),
    );
    expect(new Set(projectsCalled)).toEqual(new Set(testCase.allowedProjects));
    if (testCase.expectedStatus === "not_covered") {
      if (testCase.relatedFacts.length === 0) {
        expect(result.answer).toBe(NOT_COVERED_TEXT);
        expect(result.references).toEqual([]);
        expect(pagesRead).toEqual([]);
      } else {
        expect(result.answer).toContain("无法根据正式知识库确认");
        expect(pagesRead).toEqual([testCase.allowedSourcePages[0]]);
        expect(result.references).toHaveLength(1);
        expect(testCase.allowedSourcePages).toContain(result.references[0]?.path);
      }
      return;
    }

    expect(pagesRead).toEqual([testCase.allowedSourcePages[0]]);
    expect(result.references).toHaveLength(1);
    expect(testCase.allowedProjects).toContain(result.references[0]?.project);
    expect(testCase.allowedSourcePages).toContain(result.references[0]?.path);
    expect(result.references[0]?.revision).toBe(revision);
    expect(result.references[0]?.contentHash).toBe(contentHash);
  });
});
