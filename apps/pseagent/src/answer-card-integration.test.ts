import { describe, expect, it, vi } from "vitest";
import { AnswerService } from "./answer-service.js";
import type { KnowledgePlan } from "./contracts.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import type { AnswerCardMatch, AnswerCardMatcher } from "./answer-card-matcher.js";
import { identityResolvedQuestion } from "./question-resolver.js";
import { DeterministicTaskSpecGuard, taskSpecSchema } from "./task-spec.js";
import type { TaskAnalysisShadow } from "./task-analysis-shadow.js";

const professionalRevision = "a".repeat(40);
const generalRevision = "b".repeat(40);
const catalogHash = "c".repeat(64);
const cardIdHash = "d".repeat(64);
const question = "请说明 Coremail 迁移能力及迁移风险沟通方法。";

const legacyPlan: KnowledgePlan = {
  subject: question,
  requirements: [{
    id: "R1",
    question,
    evidenceMode: "synthesis_allowed",
    evidenceAspects: [{ id: "A1", label: "迁移", terms: ["迁移"] }],
    queries: [{ text: question, aspectIds: ["A1"] }],
  }],
};

function taskAnalysis(domains: "single" | "mixed"): TaskAnalysisShadow {
  const taskSpec = taskSpecSchema.parse({
    subject: question,
    entities: [{
      id: "E1",
      label: "Coremail",
      role: "product",
      sourceText: "Coremail",
    }],
    deliverables: [{
      id: "D1",
      label: "迁移说明",
      kind: "recommendation",
      required: true,
      sourceText: question,
      obligations: [
        {
          id: "O1",
          label: "迁移能力",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "Coremail 迁移能力",
        },
        ...(domains === "single"
          ? []
          : [{
              id: "O2",
              label: "迁移风险沟通方法",
              targetEntityIds: ["E1"],
              evidencePolicy: "synthesis" as const,
              domains: ["presales-general" as const],
              required: true,
              sourceText: "迁移风险沟通方法",
            }]),
      ],
    }],
  });
  const resolvedQuestion = identityResolvedQuestion(question);
  return {
    analyze: vi.fn(async () => ({
      resolvedQuestion,
      taskSpec,
      guard: new DeterministicTaskSpecGuard().validate({
        resolvedQuestion,
        taskSpec,
      }),
      elapsedMs: 1,
    })),
  };
}

function exactMatch(): Exclude<AnswerCardMatch, { matchType: "none" }> {
  return {
    matchType: "exact",
    confidence: "deterministic",
    catalogHash,
    bindings: [{
      obligationId: "O1",
      cardObligationId: "O1",
      cardId: "CM-MIGRATION-001",
      label: "说明 Coremail 迁移能力",
      domain: "coremail-professional",
      domains: ["coremail-professional"],
      required: true,
      evidencePolicy: "direct",
      requiredConcepts: ["Coremail", "迁移能力"],
      forbiddenClaims: ["保证零停机"],
      preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
    }],
    cardIdHashes: [cardIdHash],
    expectedRevisions: { "coremail-professional": professionalRevision },
    candidateCount: 1,
  };
}

function matcher(match: AnswerCardMatch): AnswerCardMatcher {
  return { match: vi.fn(async () => match) };
}

function trace(events: DiagnosticEvent[]): DiagnosticTrace {
  return {
    requestId: "answer-card-integration",
    record(event) {
      events.push(event);
    },
  };
}

describe("answer card online orchestration", () => {
  it("observes an exact match in shadow without changing the legacy plan", async () => {
    const events: DiagnosticEvent[] = [];
    const runAgent = vi.fn(async () => ({
      scope: "professional" as const,
      status: "answered" as const,
      answer: "沿用原链路",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as never,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: { plan: vi.fn(async () => legacyPlan) },
      diagnostics: { start: () => trace(events) },
      knowledge: {
        open: vi.fn(async () => ({
          project: "coremail-professional",
          revision: professionalRevision,
          purpose: "purpose",
          schema: "schema",
          planningOverview: "overview",
        }) as never),
      },
      runAgent,
      taskAnalysisShadow: taskAnalysis("single"),
      answerCardMatcher: matcher(exactMatch()),
      answerCardExactActiveEnabled: false,
    });

    const result = await service.answerDetailed(question);

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.requestId).not.toBe("answer-card-integration");
    expect(result.answerCardMatch).toMatchObject({
      matchType: "exact",
      confidence: "deterministic",
      cardIdHashes: [cardIdHash],
    });
    expect(result.feedbackContext).toEqual({
      scope: "professional",
      status: "answered",
      referenceCount: 0,
      historicalUsed: false,
    });
    expect(result.result.answer).toBe("沿用原链路");
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ plan: legacyPlan }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "answer_card_match",
      matchType: "exact",
      cardIdHashes: [cardIdHash],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "answer_card_activation",
      activated: false,
      reason: "shadow_only",
    }));
  });

  it("activates an exact card as governed bindings but still calls the agent", async () => {
    const runAgent = vi.fn(async () => ({
      scope: "professional" as const,
      status: "answered" as const,
      answer: "经正式知识检索和校验后的回答",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as never,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: { plan: vi.fn(async () => legacyPlan) },
      knowledge: {
        open: vi.fn(async () => ({
          project: "coremail-professional",
          revision: professionalRevision,
          purpose: "purpose",
          schema: "schema",
          planningOverview: "overview",
        }) as never),
      },
      runAgent,
      taskAnalysisShadow: taskAnalysis("single"),
      taskSpecActiveEnabled: true,
      answerCardMatcher: matcher(exactMatch()),
      answerCardExactActiveEnabled: true,
    });

    const result = await service.answerDetailed(question);

    expect(result.result.answer).toContain("正式知识检索和校验");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ retrievalStrategy: "coverage_units" }),
      requirementBindings: [expect.objectContaining({
        cardId: "CM-MIGRATION-001",
        obligationId: "O1",
        preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
      })],
    }));
  });

  it("activates an exact card when model task analysis is unavailable", async () => {
    const plan = vi.fn();
    const runAgent = vi.fn(async () => ({
      scope: "professional" as const,
      status: "answered" as const,
      answer: "governed exact answer",
      references: [],
    }));
    const service = new AnswerService({
      model: {} as never,
      router: { route: vi.fn() },
      planner: { plan },
      knowledge: {
        open: vi.fn(async () => ({
          project: "coremail-professional",
          revision: professionalRevision,
          purpose: "purpose",
          schema: "schema",
          planningOverview: "overview",
        }) as never),
      },
      runAgent,
      taskSpecActiveEnabled: true,
      answerCardMatcher: {
        routeExact: vi.fn(() => ({
          domain: "coremail-professional" as const,
          expectedRevision: professionalRevision,
        })),
        match: vi.fn(async () => exactMatch()),
      },
      answerCardExactActiveEnabled: true,
    });

    const result = await service.answerDetailed(question);

    expect(result.result).toMatchObject({ status: "answered" });
    expect(result.answerCardActivation).toEqual({
      activated: true,
      reason: "activated",
      obligationCount: 1,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      requirementBindings: [expect.objectContaining({
        obligationId: "O1",
        cardId: "CM-MIGRATION-001",
        preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
      })],
    }));
  });

  it("lets an active governed exact card correct a model routing mistake", async () => {
    const router = { route: vi.fn(async () => "general" as const) };
    const open = vi.fn(async (scope: "professional" | "general") => ({
      project: scope === "professional" ? "coremail-professional" : "presales-general",
      revision: scope === "professional" ? professionalRevision : generalRevision,
      purpose: "purpose",
      schema: "schema",
      planningOverview: "overview",
    }) as never);
    const service = new AnswerService({
      model: {} as never,
      router,
      planner: { plan: vi.fn(async () => legacyPlan) },
      knowledge: { open },
      runAgent: vi.fn(async () => ({
        scope: "professional" as const,
        status: "answered" as const,
        answer: "governed answer",
        references: [],
      })),
      taskAnalysisShadow: taskAnalysis("single"),
      taskSpecActiveEnabled: true,
      answerCardMatcher: {
        routeExact: vi.fn(() => ({
          domain: "coremail-professional" as const,
          expectedRevision: professionalRevision,
        })),
        match: vi.fn(async () => exactMatch()),
      },
      answerCardExactActiveEnabled: true,
    });

    const result = await service.answerDetailed(question);

    expect(result.result.scope).toBe("professional");
    expect(router.route).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("professional", expect.any(AbortSignal));
  });

  it("fails a cross-domain active card closed when a bound release revision drifts", async () => {
    const events: DiagnosticEvent[] = [];
    const familyMatch: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      ...exactMatch(),
      matchType: "family",
      confidence: "high",
      familyId: "MIXED-MIGRATION-001",
      bindings: [
        ...exactMatch().bindings,
        {
          obligationId: "O2",
          cardObligationId: "O2",
          cardId: "PS-RISK-001",
          label: "给出迁移风险沟通方法",
          domain: "presales-general",
          domains: ["presales-general"],
          required: true,
          evidencePolicy: "synthesis",
          requiredConcepts: ["迁移风险", "沟通方法"],
          forbiddenClaims: [],
          preferredEvidencePaths: ["wiki/queries/migration-risk.md"],
        },
      ],
      cardIdHashes: [cardIdHash, "e".repeat(64)],
      expectedRevisions: {
        "coremail-professional": professionalRevision,
        "presales-general": generalRevision,
      },
    };
    let openCount = 0;
    const service = new AnswerService({
      model: {} as never,
      router: { route: vi.fn(async () => "professional" as const) },
      planner: { plan: vi.fn(async () => legacyPlan) },
      diagnostics: { start: () => trace(events) },
      knowledge: {
        open: vi.fn(async (scope: "professional" | "general") => {
          openCount += 1;
          const project = scope === "professional"
            ? "coremail-professional"
            : "presales-general";
          return {
            project,
            revision: scope === "general" ? "f".repeat(40) : professionalRevision,
            purpose: "purpose",
            schema: "schema",
            planningOverview: "overview",
          } as never;
        }),
      },
      runAgent: vi.fn(),
      runAgentDetailed: vi.fn(async (input) => ({
        outcome: "verified" as const,
        project: input.session.project,
        revision: input.session.revision,
        action: {
          action: "final" as const,
          requirements: [{
            id: "R1" as const,
            coverage: "complete" as const,
            answer: "已验证 [1]。",
            citations: [1],
          }],
          citations: [1],
        },
        references: [{
          index: 1,
          project: input.session.project,
          title: "资料",
          path: "wiki/evidence.md",
          revision: input.session.revision,
          contentHash: "1".repeat(64),
        }],
      })),
      taskAnalysisShadow: taskAnalysis("mixed"),
      taskSpecActiveEnabled: true,
      multiDomainActiveEnabled: true,
      answerCardMatcher: matcher(familyMatch),
      answerCardExactActiveEnabled: true,
      answerCardFamilyActiveEnabled: true,
    });

    const result = await service.answerDetailed(question);

    expect(openCount).toBe(3);
    expect(result.result).toMatchObject({ status: "temporarily_unavailable" });
    expect(events).toContainEqual(expect.objectContaining({
      event: "domain_execution",
      domain: "presales-general",
      result: "unavailable",
      reason: "session_snapshot_mismatch",
    }));
  });
});
