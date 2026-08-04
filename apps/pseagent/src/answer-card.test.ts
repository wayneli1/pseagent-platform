import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "./model-client.js";
import {
  AnswerCardRegistry,
  AnswerCardRegistryError,
  normalizeQuestion,
} from "./answer-card-registry.js";
import { DefaultAnswerCardMatcher } from "./answer-card-matcher.js";
import { adaptAnswerCardToTaskSpec } from "./answer-card-task-spec-adapter.js";
import { applyAnswerCardPoliciesToPlan } from "./answer-card-task-spec-adapter.js";
import { identityResolvedQuestion } from "./question-resolver.js";
import { taskSpecSchema } from "./task-spec.js";
import { violatesAnswerCardForbiddenClaims } from "./answer-card-policy.js";

const professionalRevision = "a".repeat(40);
const generalRevision = "b".repeat(40);

function catalog() {
  return {
    schemaVersion: 1,
    domains: [
      {
        domain: "coremail-professional",
        revision: professionalRevision,
        contentHash: "c".repeat(64),
      },
      {
        domain: "presales-general",
        revision: generalRevision,
        contentHash: "d".repeat(64),
      },
    ],
    cards: [
      {
        cardSchemaVersion: 1,
        cardId: "CM-MIGRATION-001",
        domain: "coremail-professional",
        title: "Coremail 迁移能力",
        canonicalQuestion: "Coremail支持哪些迁移能力？",
        questionFamily: "migration_and_risk",
        aliases: ["Coremail 可以怎么迁移"],
        applicability: { products: ["Coremail"], versions: ["*"] },
        obligations: [{
          id: "O1",
          label: "说明 Coremail 迁移能力",
          domains: ["coremail-professional"],
          evidencePolicy: "direct",
          requiredConcepts: ["Coremail", "迁移能力"],
          forbiddenClaims: ["保证所有系统零停机迁移"],
          preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
        }],
        owner: "professional-owner",
        reviewers: ["professional-reviewer"],
        reviewStatus: "approved",
        regressionCaseIds: ["RC-CM-MIGRATION-001"],
      },
      {
        cardSchemaVersion: 1,
        cardId: "PS-RISK-001",
        domain: "presales-general",
        title: "迁移风险沟通",
        canonicalQuestion: "迁移项目如何沟通风险？",
        questionFamily: "migration_and_risk",
        aliases: ["怎么向客户说明迁移风险"],
        applicability: { scenarios: ["迁移"], versions: ["*"] },
        obligations: [{
          id: "O2",
          label: "给出迁移风险沟通方法",
          domains: ["presales-general"],
          evidencePolicy: "synthesis",
          requiredConcepts: ["迁移", "风险沟通"],
          forbiddenClaims: [],
          preferredEvidencePaths: ["wiki/queries/migration-risk.md"],
        }],
        owner: "general-owner",
        reviewers: ["general-reviewer"],
        reviewStatus: "released",
        regressionCaseIds: ["RC-PS-RISK-001"],
      },
    ],
    families: [{
      schemaVersion: 1,
      familyId: "MIXED-MIGRATION-001",
      title: "迁移能力与风险沟通",
      canonicalQuestion: "如何设计 Coremail 迁移方案并沟通风险？",
      aliases: ["Coremail 迁移项目怎么做风险沟通"],
      bindings: [
        {
          obligationId: "O1",
          cardObligationId: "O1",
          label: "说明 Coremail 迁移能力",
          domain: "coremail-professional",
          cardId: "CM-MIGRATION-001",
        },
        {
          obligationId: "O2",
          cardObligationId: "O2",
          label: "给出迁移风险沟通方法",
          domain: "presales-general",
          cardId: "PS-RISK-001",
        },
      ],
      reviewStatus: "approved",
    }],
  };
}

describe("answer card registry and matching", () => {
  it("normalizes punctuation for deterministic exact matching and binds revisions", () => {
    const registry = new AnswerCardRegistry(catalog());

    expect(normalizeQuestion(" Coremail，可以怎么迁移？ ")).toBe(
      normalizeQuestion("coremail可以怎么迁移"),
    );
    expect(registry.exactCard("Coremail，可以怎么迁移？")?.cardId)
      .toBe("CM-MIGRATION-001");
    expect(registry.expectedRevision("presales-general")).toBe(generalRevision);
    expect(registry.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.cardApplicable("CM-MIGRATION-001", "Coremail 迁移能力")).toBe(true);
    expect(registry.cardApplicable("CM-MIGRATION-001", "其他产品迁移能力")).toBe(false);
  });

  it("rejects a family binding that does not resolve to a governed card obligation", () => {
    const invalid = catalog();
    invalid.families[0]!.bindings[1]!.cardObligationId = "O9";

    expect(() => new AnswerCardRegistry(invalid)).toThrowError(
      expect.objectContaining<Partial<AnswerCardRegistryError>>({
        code: "question_family_binding_invalid",
      }),
    );
  });

  it("returns exact without a model call and fails stale catalogs closed", async () => {
    const model = { completeJson: vi.fn() } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    const exact = await matcher.match({
      question: "Coremail支持哪些迁移能力？",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });
    const stale = await matcher.match({
      question: "Coremail支持哪些迁移能力？",
      currentDomain: "coremail-professional",
      currentRevision: "f".repeat(40),
      familyEnabled: true,
    });

    expect(exact).toMatchObject({
      matchType: "exact",
      confidence: "deterministic",
      bindings: [{ cardId: "CM-MIGRATION-001", obligationId: "O1" }],
    });
    expect(stale).toMatchObject({ matchType: "none", reason: "stale_catalog" });
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("uses strict high-confidence family decisions and distinguishes partial matches", async () => {
    const model = {
      completeJson: vi.fn()
        .mockResolvedValueOnce({
          familyId: "MIXED-MIGRATION-001",
          confidence: "high",
          matchedObligationIds: ["O1", "O2"],
        })
        .mockResolvedValueOnce({
          familyId: "MIXED-MIGRATION-001",
          confidence: "high",
          matchedObligationIds: ["O2"],
        }),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );
    const input = {
      question: "请规划 Coremail 迁移并说明怎么和客户沟通风险",
      currentDomain: "coremail-professional" as const,
      currentRevision: professionalRevision,
      familyEnabled: true,
    };

    const full = await matcher.match(input);
    const partial = await matcher.match(input);

    expect(full).toMatchObject({
      matchType: "family",
      confidence: "high",
      familyId: "MIXED-MIGRATION-001",
    });
    expect(full.matchType === "none" ? [] : full.bindings.map((item) => item.domain))
      .toEqual(["coremail-professional", "presales-general"]);
    expect(partial).toMatchObject({ matchType: "partial", confidence: "high" });
  });
});

describe("answer card TaskSpec adapter", () => {
  it("overlays governed obligations while preserving a different user request", async () => {
    const question = "请说明 Coremail 迁移能力及迁移风险沟通方法。";
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
        label: "迁移方案",
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
          {
            id: "O2",
            label: "风险沟通",
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: "迁移风险沟通方法",
          },
        ],
      }],
    });
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      {
        completeJson: vi.fn(async () => ({
          familyId: "MIXED-MIGRATION-001",
          confidence: "high",
          matchedObligationIds: ["O1"],
        })),
      } as unknown as ModelClient,
    );
    const match = await matcher.match({
      question: "请规划 Coremail 迁移并说明怎么和客户沟通风险",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });

    const adapted = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(adapted).toMatchObject({ activated: true });
    if (!adapted.activated) return;
    expect(adapted.guard.ok).toBe(true);
    expect(adapted.taskSpec.deliverables[0]?.obligations).toHaveLength(2);
    expect(adapted.taskSpec.deliverables[0]?.obligations[0]).toMatchObject({
      id: "O1",
      label: "说明 Coremail 迁移能力",
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
    });
    expect(adapted.taskSpec.deliverables[0]?.obligations[1]?.sourceText)
      .toContain("迁移风险沟通方法");
    expect(adapted.policies).toEqual([expect.objectContaining({
      obligationId: "O1",
      cardId: "CM-MIGRATION-001",
      preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
    })]);
    const governedPlan = applyAnswerCardPoliciesToPlan({
      plan: legacyKnowledgePlan(),
      obligationIds: ["O1"],
      policies: adapted.policies,
    });
    expect(governedPlan.requirements[0]?.evidenceAspects[0]?.terms)
      .toEqual(expect.arrayContaining(["Coremail", "迁移能力"]));
    expect(governedPlan.requirements[0]?.queries).toHaveLength(2);
  });

  it("blocks a governed forbidden claim after evidence verification", () => {
    const binding = {
      domain: "coremail-professional" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      forbiddenClaims: ["保证所有系统零停机迁移"],
    };
    expect(violatesAnswerCardForbiddenClaims({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "该方案保证所有系统零停机迁移 [1]。",
        citations: [1],
      }],
      citations: [1],
    }, [binding])).toBe(true);
    expect(violatesAnswerCardForbiddenClaims({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "正式资料不能保证所有系统零停机迁移 [1]。",
        citations: [1],
      }],
      citations: [1],
    }, [binding])).toBe(false);
  });
});

function legacyKnowledgePlan() {
  return {
    subject: "Coremail 迁移",
    requirements: [{
      id: "R1" as const,
      question: "Coremail 迁移能力",
      evidenceMode: "direct_only" as const,
      evidenceAspects: [{ id: "A1" as const, label: "迁移能力", terms: ["迁移"] }],
      queries: [{ text: "Coremail 迁移能力", aspectIds: ["A1" as const] }],
    }],
    retrievalStrategy: "coverage_units" as const,
  };
}
