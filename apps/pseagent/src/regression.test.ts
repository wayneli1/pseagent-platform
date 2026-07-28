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
  if (item.expectedStatus === "not_covered" && (item.requiredFacts.length !== 0 || item.allowedSourcePages.length !== 0)) {
    context.addIssue({ code: "custom", path: ["expectedStatus"], message: "not_covered_must_not_declare_evidence" });
  }
});
type RegressionCase = z.infer<typeof regressionCaseSchema>;

const datasetPath = fileURLToPath(new URL("../../../tests/regression/questions.json", import.meta.url));
const cases = z.array(regressionCaseSchema).length(40).parse(JSON.parse(readFileSync(datasetPath, "utf8")));
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
  const body = evidence?.requiredFacts.join("；") ?? "";
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
          ? [{ path, title: evidence.id, score: 1, matchedTerms: evidence.requiredFacts, snippet: body }]
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

describe("fixed 40-question scripted protocol regression", () => {
  it("is explicitly a protocol harness rather than a real retrieval quality test", () => {
    expect(scriptedModel).toBeTypeOf("function");
    expect(fakeSession).toBeTypeOf("function");
  });

  it("contains exactly 40 unique stable IDs", () => {
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map((item) => item.id)).size).toBe(40);
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

  it.each(cases)("routes and handles $id", async (testCase) => {
    const routeModel = routingModel();
    const routed = await new ScopeRouter(routeModel).route(testCase.question);
    expect(routed).toBe(testCase.expectedScope);
    expect(routeModel.completeJson).toHaveBeenCalledOnce();

    const evidence = testCase.expectedScope !== "normal" && testCase.expectedStatus === "answered"
      ? testCase
      : undefined;
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
      expect(result.answer).toBe(NOT_COVERED_TEXT);
      expect(result.references).toEqual([]);
      expect(pagesRead).toEqual([]);
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
