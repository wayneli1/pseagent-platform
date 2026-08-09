import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "./model-client.js";
import {
  AnswerCardRegistry,
  AnswerCardRegistryError,
  hashAnswerCardIdentifier,
  normalizeQuestion,
} from "./answer-card-registry.js";
import {
  DefaultAnswerCardMatcher,
  type AnswerCardMatch,
} from "./answer-card-matcher.js";
import {
  adaptAnswerCardToTaskSpec,
  compileExactAnswerCardTaskSpec,
} from "./answer-card-task-spec-adapter.js";
import { applyAnswerCardPoliciesToPlan } from "./answer-card-task-spec-adapter.js";
import { identityResolvedQuestion } from "./question-resolver.js";
import { DeterministicTaskSpecGuard, taskSpecSchema } from "./task-spec.js";
import {
  applyGroundedAnswerCardRequiredConcepts,
  answerCardRequirementsWithGroundedConcepts,
  missingAnswerCardRequiredConcepts,
  violatesAnswerCardForbiddenClaims,
} from "./answer-card-policy.js";

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
  it("trusts governed exact aliases without requiring broad applicability labels in the question", async () => {
    const source = catalog();
    source.cards[0]!.aliases.push("What migration capabilities are supported?");
    const registry = new AnswerCardRegistry(source);
    const matcher = new DefaultAnswerCardMatcher(
      registry,
      { completeJson: vi.fn() } as unknown as ModelClient,
    );

    expect(registry.cardApplicable(
      "CM-MIGRATION-001",
      "What migration capabilities are supported?",
    )).toBe(false);
    expect(registry.exactCardApplicable(
      "CM-MIGRATION-001",
      "What migration capabilities are supported?",
    )).toBe(true);
    expect(matcher.routeExact("What migration capabilities are supported?")).toEqual({
      domain: "coremail-professional",
      expectedRevision: professionalRevision,
    });
    await expect(matcher.match({
      question: "What migration capabilities are supported?",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({ matchType: "exact", confidence: "deterministic" });
  });

  it("normalizes punctuation for deterministic exact matching and binds revisions", () => {
    const registry = new AnswerCardRegistry(catalog());

    expect(normalizeQuestion(" Coremail，可以怎么迁移？ ")).toBe(
      normalizeQuestion("coremail可以怎么迁移"),
    );
    expect(registry.exactCard("Coremail，可以怎么迁移？")?.cardId)
      .toBe("CM-MIGRATION-001");
    expect(registry.expectedRevision("presales-general")).toBe(generalRevision);
    expect(registry.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.activeCardCount).toBe(2);
    expect(() => registry.assertHasActiveCards()).not.toThrow();
    expect(registry.cardApplicable("CM-MIGRATION-001", "Coremail 迁移能力")).toBe(true);
    expect(registry.cardApplicable("CM-MIGRATION-001", "其他产品迁移能力")).toBe(false);
  });

  it("reuses one active parent card for a contextual follow-up", async () => {
    const completeJson = vi.fn();
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      { completeJson } as unknown as ModelClient,
    );

    await expect(matcher.match({
      question: "它的第二点具体怎么确认？",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
      contextualCardIdHashes: [hashAnswerCardIdentifier("CM-MIGRATION-001")],
    })).resolves.toMatchObject({
      matchType: "family",
      confidence: "high",
      cardIdHashes: [hashAnswerCardIdentifier("CM-MIGRATION-001")],
    });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("rejects a catalog with no active cards when production requires governed cards", () => {
    const source = catalog();
    source.cards[0]!.reviewStatus = "draft";
    source.cards[1]!.reviewStatus = "draft";
    source.families[0]!.reviewStatus = "draft";
    const registry = new AnswerCardRegistry(source);

    expect(registry.activeCardCount).toBe(0);
    expect(() => registry.assertHasActiveCards()).toThrowError(
      expect.objectContaining<Partial<AnswerCardRegistryError>>({
        code: "answer_card_catalog_has_no_active_cards",
      }),
    );
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

  it("rejects a family that does not govern an explicitly requested named method", async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        familyId: "MIXED-MIGRATION-001",
        confidence: "high",
        matchedObligationIds: ["O1", "O2"],
      })),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "请用 Mom Test 方法规划 Coremail 迁移并说明风险沟通",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_rejected",
      candidateCount: 1,
    });
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("rejects a family that does not govern every explicitly enumerated category", async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        familyId: "MIXED-MIGRATION-001",
        confidence: "high",
        matchedObligationIds: ["O1", "O2"],
      })),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "Coremail 迁移项目请区分能力、风险、财务和法务四类要求",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_rejected",
      candidateCount: 1,
    });
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("rejects an unrelated family for an explicit uncounted list of labels", async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        familyId: "MIXED-MIGRATION-001",
        confidence: "high",
        matchedObligationIds: ["O1", "O2"],
      })),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "Coremail 迁移项目里怎样用能力、风险、财务标记具体要求？",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_rejected",
      candidateCount: 1,
    });
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("rejects an unrelated family for an explicitly paired method request", async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        familyId: "MIXED-MIGRATION-001",
        confidence: "high",
        matchedObligationIds: ["O1", "O2"],
      })),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "迁移项目怎样用能力和财务先建立共同判断？",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_rejected",
      candidateCount: 1,
    });
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("recalls colloquial families from governed obligation concepts", async () => {
    const source = catalog();
    source.cards[1]!.obligations[0]!.requiredConcepts = ["谁能调动跨部门资源"];
    const model = {
      completeJson: vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
        const payload = JSON.parse(input.messages[1]!.content) as {
          candidates: Array<{
            familyId: string;
            obligations: Array<{ requiredConcepts: string[] }>;
          }>;
        };
        expect(payload.candidates.find((candidate) =>
          candidate.familyId === "MIXED-MIGRATION-001")?.obligations)
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ requiredConcepts: ["谁能调动跨部门资源"] }),
          ]));
        return {
          familyId: "MIXED-MIGRATION-001",
          confidence: "high",
          matchedObligationIds: ["O2"],
        };
      }),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(source),
      model,
    );

    await expect(matcher.match({
      question: "这人到底能不能拍板出钱、还能拉动别的部门，怎么看才靠谱？",
      currentDomain: "presales-general",
      currentRevision: generalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "partial",
      confidence: "high",
      familyId: "MIXED-MIGRATION-001",
      bindings: [expect.objectContaining({ cardId: "PS-RISK-001" })],
    });
    expect(model.completeJson).toHaveBeenCalledOnce();
  });

  it("treats a structured no-match decision as a rejection instead of matcher unavailability", async () => {
    const model = {
      completeJson: vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
        input.schema.parse({
          familyId: null,
          confidence: "none",
          matchedObligationIds: [],
        })),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "某企业需要常用系统集成能力",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_rejected",
    });
  });

  it("keeps every required obligation from a selected answer card", async () => {
    const source = catalog();
    source.cards[0]!.obligations.push({
      id: "O3",
      label: "给出迁移后的过渡动作",
      domains: ["coremail-professional"],
      evidencePolicy: "direct",
      requiredConcepts: ["过渡期", "用户重建"],
      forbiddenClaims: [],
      preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
    });
    source.families[0]!.bindings.push({
      obligationId: "O3",
      cardObligationId: "O3",
      label: "给出迁移后的过渡动作",
      domain: "coremail-professional",
      cardId: "CM-MIGRATION-001",
    });
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(source),
      {
        completeJson: vi.fn(async () => ({
          familyId: "MIXED-MIGRATION-001",
          confidence: "high",
          matchedObligationIds: ["O1"],
        })),
      } as unknown as ModelClient,
    );

    const match = await matcher.match({
      question: "请说明 Coremail 迁移范围以及过渡动作",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });

    expect(match).toMatchObject({ matchType: "partial", confidence: "high" });
    expect(match.matchType === "none" ? [] : match.bindings.map((item) => item.obligationId))
      .toEqual(["O1", "O3"]);
  });

  it("falls back only to an unambiguous high-similarity family when the model is unavailable", async () => {
    const model = {
      completeJson: vi.fn(async () => {
        throw new Error("model_request_timeout");
      }),
    } as unknown as ModelClient;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(catalog()),
      model,
    );

    await expect(matcher.match({
      question: "请设计 Coremail 迁移方案并说明风险沟通方法",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "family",
      confidence: "high",
      familyId: "MIXED-MIGRATION-001",
      candidateCount: 1,
    });

    await expect(matcher.match({
      question: "Coremail 当前支持什么？",
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    })).resolves.toMatchObject({
      matchType: "none",
      reason: "family_match_unavailable",
    });
  });
});

describe("answer card TaskSpec adapter", () => {
  it("compiles approved exact bindings without a model-authored TaskSpec", async () => {
    const source = catalog();
    const exactQuestion = source.cards[0]!.canonicalQuestion;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(source),
      { completeJson: vi.fn() } as unknown as ModelClient,
    );
    const match = await matcher.match({
      question: exactQuestion,
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });
    expect(match.matchType).toBe("exact");
    if (match.matchType === "none") return;

    const compiled = compileExactAnswerCardTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(exactQuestion),
    });

    expect(compiled).toMatchObject({ activated: true });
    if (!compiled.activated) return;
    expect(compiled.guard).toMatchObject({ ok: true, issues: [] });
    expect(compiled.taskSpec.deliverables[0]!.obligations).toEqual([
      expect.objectContaining({
        id: "O1",
        label: source.cards[0]!.obligations[0]!.label,
        evidencePolicy: "direct",
        domains: ["coremail-professional"],
      }),
    ]);
    expect(compiled.policies).toEqual([
      expect.objectContaining({
        obligationId: "O1",
        cardId: "CM-MIGRATION-001",
        preferredEvidencePaths: ["wiki/queries/coremail-migration.md"],
      }),
    ]);
  });

  it("routes professional-card customer inputs through the general input boundary", async () => {
    const source = catalog();
    source.cards[0]!.obligations[0]!.evidencePolicy = "customer_input";
    const exactQuestion = source.cards[0]!.canonicalQuestion;
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(source),
      { completeJson: vi.fn() } as unknown as ModelClient,
    );
    const match = await matcher.match({
      question: exactQuestion,
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });
    if (match.matchType === "none") throw new Error("expected_exact_match");

    const compiled = compileExactAnswerCardTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(exactQuestion),
    });

    expect(compiled).toMatchObject({ activated: true });
    if (!compiled.activated) return;
    expect(compiled.taskSpec.deliverables[0]!.obligations[0]).toMatchObject({
      evidencePolicy: "customer_input",
      domains: ["presales-general"],
      evidenceCondition: { inputState: "missing" },
    });
  });

  it("makes an exact governed card authoritative over model-invented obligations", async () => {
    const source = catalog();
    const matcher = new DefaultAnswerCardMatcher(
      new AnswerCardRegistry(source),
      { completeJson: vi.fn() } as unknown as ModelClient,
    );
    const exactQuestion = source.cards[0]!.canonicalQuestion;
    const taskSpec = taskSpecSchema.parse({
      subject: exactQuestion,
      entities: [{ id: "E1", label: "Coremail", role: "product", sourceText: "Coremail" }],
      deliverables: [{
        id: "D1",
        label: "answer",
        kind: "recommendation",
        required: true,
        sourceText: exactQuestion,
        obligations: [
          {
            id: "O1",
            label: "migration",
            targetEntityIds: ["E1"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: exactQuestion,
          },
          {
            id: "O2",
            label: "model-invented generic advice",
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: "generic advice",
          },
        ],
      }],
    });
    const match = await matcher.match({
      question: exactQuestion,
      currentDomain: "coremail-professional",
      currentRevision: professionalRevision,
      familyEnabled: true,
    });
    const adapted = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(exactQuestion),
      taskSpec,
    });

    expect(adapted).toMatchObject({ activated: true });
    if (!adapted.activated) return;
    expect(adapted.taskSpec.deliverables).toHaveLength(1);
    expect(adapted.taskSpec.deliverables[0]!.obligations).toHaveLength(1);
    expect(adapted.taskSpec.deliverables[0]!.obligations[0]).toMatchObject({
      domains: ["coremail-professional"],
      label: source.cards[0]!.obligations[0]!.label,
    });
  });

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
      label: "迁移能力",
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
    });
    expect(adapted.taskSpec.deliverables[0]?.obligations[1]?.sourceText)
      .toContain("迁移风险沟通方法");
    expect(adapted.policies).toEqual([expect.objectContaining({
      obligationId: "O1",
      label: "说明 Coremail 迁移能力",
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
    expect(governedPlan.requirements[0]).toMatchObject({
      question: "说明 Coremail 迁移能力",
      evidenceAspects: [{
        label: "说明 Coremail 迁移能力",
      }],
    });
    expect(governedPlan.requirements[0]?.queries).toHaveLength(2);
  });

  it("preserves customer-input semantics while activating a family answer card", () => {
    const question = "客户在 POC 阶段，拿不到客户信息，我们的赢率如何，怎样提升？";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{
        id: "E1",
        label: "当前商机",
        role: "subject",
        sourceText: "客户在 POC 阶段",
      }],
      deliverables: [{
        id: "D1",
        label: "判断赢率并给出提升建议",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "判断我们的赢率",
          targetEntityIds: ["E1"],
          evidencePolicy: "customer_input",
          evidenceCondition: {
            inputState: "missing",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_assessed",
          },
          domains: ["presales-general"],
          required: true,
          sourceText: "我们的赢率如何",
        }, {
          id: "O2",
          label: "给出提升赢率建议",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          evidenceCondition: {
            inputState: "not_applicable",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_assessed",
          },
          domains: ["presales-general"],
          required: true,
          sourceText: "怎样提升",
        }],
      }],
    });
    const binding = (
      obligationId: string,
      label: string,
      evidencePolicy: "direct" | "synthesis",
      requiredConcepts: readonly string[],
    ) => ({
      obligationId,
      cardObligationId: obligationId,
      cardId: "PS-WIN-RATE-001",
      label,
      domain: "presales-general" as const,
      domains: ["presales-general" as const],
      required: true,
      evidencePolicy,
      requiredConcepts,
      forbiddenClaims: [],
      preferredEvidencePaths: ["wiki/queries/win-rate.md"],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "c".repeat(64),
      familyId: "WIN-RATE-FAMILY",
      bindings: [
        binding("O1", "拒绝伪精确赢率", "direct", ["赢率"]),
        binding("O2", "最小验证动作", "synthesis", ["验证动作"]),
        binding("O3", "核验业务决策资源", "synthesis", ["业务决策资源"]),
      ],
      cardIdHashes: ["d".repeat(64)],
      expectedRevisions: { "presales-general": generalRevision },
      candidateCount: 1,
    };

    const adapted = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(adapted).toMatchObject({ activated: true });
    if (!adapted.activated) return;
    expect(adapted.guard.ok).toBe(true);
    expect(adapted.taskSpec.deliverables[0]?.obligations.slice(0, 2)).toEqual(
      taskSpec.deliverables[0]?.obligations,
    );
    expect(adapted.taskSpec.deliverables[0]?.obligations).toHaveLength(4);
    expect(adapted.taskSpec.deliverables[0]?.obligations[0]).toMatchObject({
      evidencePolicy: "customer_input",
      evidenceCondition: { inputState: "missing" },
      sourceText: "我们的赢率如何",
      domains: ["presales-general"],
    });
    expect(adapted.taskSpec.deliverables[0]?.obligations.slice(2)).toEqual([
      expect.objectContaining({
        label: "拒绝伪精确赢率",
        evidencePolicy: "direct",
        sourceText: "我们的赢率如何",
      }),
      expect.objectContaining({
        label: "核验业务决策资源",
        evidencePolicy: "synthesis",
        sourceText: "怎样提升",
      }),
    ]);
    expect(adapted.policies).toHaveLength(3);
    expect(adapted.policies.map((policy) => policy.cardObligationId)).toEqual([
      "O1",
      "O2",
      "O3",
    ]);
  });

  it("deduplicates one intent and trusts its governed synthesis policy", () => {
    const question = "客户自称能批预算也能协调资源，售前应该核对哪些可验证的动作？";
    const duplicate = (id: string) => ({
      id,
      label: "核实客户的预算和资源权限",
      targetEntityIds: ["E1"],
      evidencePolicy: "direct" as const,
      domains: ["presales-general" as const],
      required: true,
      sourceText: question,
    });
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{
        id: "E1",
        label: question,
        role: "subject",
        sourceText: question,
      }],
      deliverables: [{
        id: "D1",
        label: question,
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [duplicate("O1"), duplicate("O2"), duplicate("O3")],
      }],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "c".repeat(64),
      familyId: "BUDGET-RESOURCE-FAMILY",
      bindings: [{
        obligationId: "O1",
        cardObligationId: "O1",
        cardId: "GEN-BUDGET-RESOURCE-001",
        label: "核验预算与资源调动行为",
        domain: "presales-general",
        domains: ["presales-general"],
        required: true,
        evidencePolicy: "synthesis",
        requiredConcepts: ["预算来自哪里，谁可以调整", "谁能调动跨部门资源"],
        forbiddenClaims: ["不得把口头承诺作为权限证明"],
        preferredEvidencePaths: ["wiki/queries/budget-resource.md"],
      }],
      cardIdHashes: ["d".repeat(64)],
      expectedRevisions: { "presales-general": generalRevision },
      candidateCount: 1,
    };

    const adapted = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(adapted).toMatchObject({ activated: true });
    if (!adapted.activated) return;
    expect(adapted.guard).toMatchObject({ ok: true, issues: [] });
    expect(adapted.taskSpec.deliverables[0]!.obligations).toEqual([
      expect.objectContaining({
        id: "O1",
        label: "核验预算与资源调动行为",
        evidencePolicy: "synthesis",
        domains: ["presales-general"],
      }),
    ]);
    expect(adapted.policies).toEqual([
      expect.objectContaining({
        obligationId: "O1",
        cardId: "GEN-BUDGET-RESOURCE-001",
      }),
    ]);
  });

  it("rejects an ambiguous family binding instead of attaching it to the first task", () => {
    const question = "比较甲方案和乙方案的部署差异。";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: "甲方案", role: "subject", sourceText: "甲方案" }, {
        id: "E2",
        label: "乙方案",
        role: "subject",
        sourceText: "乙方案",
      }],
      deliverables: [{
        id: "D1",
        label: "部署差异",
        kind: "comparison",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "甲方案部署",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "甲方案",
        }, {
          id: "O2",
          label: "乙方案部署",
          targetEntityIds: ["E2"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "乙方案",
        }],
      }],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "c".repeat(64),
      familyId: "DEPLOYMENT-FAMILY",
      bindings: [{
        obligationId: "O1",
        cardObligationId: "O1",
        cardId: "CM-DEPLOYMENT-001",
        label: "核验容量边界",
        domain: "coremail-professional",
        domains: ["coremail-professional"],
        required: true,
        evidencePolicy: "direct",
        requiredConcepts: ["容量边界"],
        forbiddenClaims: [],
        preferredEvidencePaths: [],
      }],
      cardIdHashes: ["d".repeat(64)],
      expectedRevisions: { "coremail-professional": professionalRevision },
      candidateCount: 1,
    };

    expect(adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    })).toEqual({ activated: false, reason: "binding_unmapped" });
  });

  it("anchors multiple governed family obligations to one explicit follow-up deliverable", () => {
    const question = "5000 用户多活方案到底几台前端、几台后端？";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: "5000 用户多活方案", role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: "服务器数量",
        kind: "fact",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "给出前后端数量",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const makeBinding = (
      id: string,
      label: string,
      evidencePolicy: "direct" | "synthesis",
    ): Exclude<AnswerCardMatch, { matchType: "none" }>["bindings"][number] => ({
      obligationId: id,
      cardObligationId: id,
      cardId: "PRO-MULTI-ACTIVE-001",
      label,
      domain: "coremail-professional",
      domains: ["coremail-professional"],
      required: true,
      evidencePolicy,
      requiredConcepts: [label],
      forbiddenClaims: [],
      preferredEvidencePaths: [],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "e".repeat(64),
      familyId: "MULTI-ACTIVE-FAMILY",
      bindings: [
        makeBinding("O1", "服务器数量", "direct"),
        makeBinding("O2", "一致性组件", "direct"),
        makeBinding("O3", "容量边界", "synthesis"),
      ],
      cardIdHashes: ["f".repeat(64)],
      expectedRevisions: { "coremail-professional": professionalRevision },
      candidateCount: 1,
    };

    const result = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) throw new Error("expected activation");
    expect(result.policies).toHaveLength(3);
    expect(result.policies.map((policy) => policy.cardObligationId)).toEqual(["O1", "O2", "O3"]);
  });

  it("uses reviewed family obligation concepts to map a contextual parallel request", () => {
    const question = "如果先看到 state=defer，接下来还要和哪些客户端记录及后续状态对齐，才能确认是服务器重投？";
    const taskSpec = taskSpecSchema.parse({
      subject: "Coremail 重复发信诊断",
      entities: [{
        id: "E1",
        label: "Coremail",
        role: "subject",
        sourceText: "Coremail",
      }],
      deliverables: [{
        id: "D1",
        label: "列出客户端记录",
        kind: "fact",
        required: true,
        sourceText: "哪些客户端记录",
        obligations: [{
          id: "O1",
          label: "说明对齐方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "哪些客户端记录",
        }],
      }],
    });
    const binding = (
      id: string,
      label: string,
      concepts: readonly string[],
    ): Exclude<AnswerCardMatch, { matchType: "none" }>["bindings"][number] => ({
      obligationId: id,
      cardObligationId: id,
      cardId: "PRO-DUPLICATE-SEND-DIAGNOSIS",
      label,
      domain: "coremail-professional",
      domains: ["coremail-professional"],
      required: true,
      evidencePolicy: "direct",
      requiredConcepts: concepts,
      forbiddenClaims: [],
      preferredEvidencePaths: [],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "e".repeat(64),
      familyId: "repair_pro_duplicate_send_diagnosis",
      bindings: [
        binding("O1", "核对 Outlook 客户端重发证据", ["Outlook", "客户端发送记录"]),
        binding("O2", "核对 deliveragent 服务器重投证据", ["state=defer", "state=sent"]),
        binding("O3", "用客户端与服务器证据建立完整时间线", ["投递状态", "完整时间线", "同时核对"]),
      ],
      cardIdHashes: ["f".repeat(64)],
      expectedRevisions: { "coremail-professional": professionalRevision },
      candidateCount: 1,
    };
    const resolvedQuestion = {
      ...identityResolvedQuestion(question),
      standaloneQuestion: "在 Coremail 同一封邮件重复发送场景中，如果先在 deliveragent 日志中看到 state=defer，接下来还需要与哪些客户端记录及后续 deliveragent 状态对齐，才能确认该邮件是服务器重投而非客户端重发？",
      contextUsed: true,
      inheritedSubjects: ["Coremail", "Outlook", "deliveragent", "state=defer"],
    };
    expect(new DeterministicTaskSpecGuard().validate({
      resolvedQuestion,
      taskSpec,
    }).issues).toContainEqual(expect.objectContaining({
      code: "explicit_request_unmapped",
    }));

    const result = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion,
      taskSpec,
    });

    expect(result).toMatchObject({ activated: true });
    if (!result.activated) return;
    expect(result.guard).toMatchObject({ ok: true, issues: [] });
    expect(result.policies.map((policy) => policy.cardObligationId)).toEqual(["O1", "O2", "O3"]);

    const unrelatedQuestion = "如果先看到 state=defer，接下来还要检查补丁下载地址和安装命令？";
    const unrelatedTaskSpec = taskSpecSchema.parse({
      subject: "Coremail 重复发信诊断",
      entities: [{ id: "E1", label: "Coremail", role: "subject", sourceText: "Coremail" }],
      deliverables: [{
        id: "D1",
        label: "检查补丁下载地址",
        kind: "fact",
        required: true,
        sourceText: "检查补丁下载地址",
        obligations: [{
          id: "O1",
          label: "检查补丁下载地址",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "检查补丁下载地址",
        }],
      }],
    });
    expect(adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: {
        ...identityResolvedQuestion(unrelatedQuestion),
        standaloneQuestion: "在 Coremail 重复发信场景中，如果先看到 state=defer，接下来还要检查补丁下载地址和安装命令？",
        contextUsed: true,
        inheritedSubjects: ["Coremail", "state=defer"],
      },
      taskSpec: unrelatedTaskSpec,
    })).toEqual({
      activated: false,
      reason: "guard_rejected",
      issueCodes: ["explicit_request_unmapped"],
    });
  });

  it("rejects a family card that cannot map onto the model task decomposition", () => {
    const question = "Can one governed card cover storage boundaries and operations visibility?";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: "mail storage", role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: "storage answer",
        kind: "fact",
        required: true,
        sourceText: "storage split",
        obligations: [{
          id: "O1",
          label: "explain storage",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "storage split",
        }],
      }, {
        id: "D2",
        label: "visibility answer",
        kind: "fact",
        required: true,
        sourceText: "visibility filter",
        obligations: [{
          id: "O2",
          label: "explain visibility",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "visibility filter",
        }],
      }],
    });
    const binding = (
      id: string,
      label: string,
    ): Exclude<AnswerCardMatch, { matchType: "none" }>["bindings"][number] => ({
      obligationId: id,
      cardObligationId: id,
      cardId: "PRO-MS-BOUNDARY",
      label,
      domain: "coremail-professional",
      domains: ["coremail-professional"],
      required: true,
      evidencePolicy: "synthesis",
      requiredConcepts: [label],
      forbiddenClaims: [],
      preferredEvidencePaths: [],
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "e".repeat(64),
      familyId: "MS-BOUNDARY-FAMILY",
      bindings: [
        binding("O1", "product boundary"),
        binding("O2", "validation process"),
        binding("O3", "contract boundary"),
      ],
      cardIdHashes: ["f".repeat(64)],
      expectedRevisions: { "coremail-professional": professionalRevision },
      candidateCount: 1,
    };

    const result = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(result).toEqual({ activated: false, reason: "binding_unmapped" });
  });

  it("falls back to one approved card contract for a high-confidence contextual family", () => {
    const question = "那它什么时候具备演示资格？";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: "演示资格", role: "subject", sourceText: question }],
      deliverables: [
        { id: "D1", label: "资格条件", kind: "fact", required: true, sourceText: question, obligations: [{ id: "O1", label: "角色条件", targetEntityIds: ["E1"], evidencePolicy: "direct", domains: ["presales-general"], required: true, sourceText: question }] },
        { id: "D2", label: "进入后结构", kind: "recommendation", required: true, sourceText: question, obligations: [{ id: "O2", label: "演示结构", targetEntityIds: ["E1"], evidencePolicy: "synthesis", domains: ["presales-general"], required: true, sourceText: question }] },
      ],
    });
    const binding=(id:string,label:string):Exclude<AnswerCardMatch,{matchType:"none"}>["bindings"][number]=>({obligationId:id,cardObligationId:id,cardId:"GEN-DEMO-QUALIFICATION",label,domain:"presales-general",domains:["presales-general"],required:true,evidencePolicy:"direct",requiredConcepts:[label],forbiddenClaims:[],preferredEvidencePaths:[]});
    const match:Exclude<AnswerCardMatch,{matchType:"none"}>={matchType:"family",confidence:"high",catalogHash:"a".repeat(64),familyId:"demo",bindings:[binding("O1","演示资格条件"),binding("O2","业务问题"),binding("O3","结果优先")],cardIdHashes:["b".repeat(64)],expectedRevisions:{"presales-general":generalRevision},candidateCount:1};

    const result=adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion:{...identityResolvedQuestion(question),standaloneQuestion:"演示请求在什么情况下具备资格？",contextUsed:true,inheritedSubjects:["演示请求"]},
      taskSpec,
    });

    expect(result).toMatchObject({activated:true,policies:[{cardId:"GEN-DEMO-QUALIFICATION"},{cardId:"GEN-DEMO-QUALIFICATION"},{cardId:"GEN-DEMO-QUALIFICATION"}]});
  });

  it("keeps a contextual sub-question focused on the matching card obligation", () => {
    const question = "演示前如何确认客户关键业务问题？";
    const taskSpec = taskSpecSchema.parse({
      subject: "关键业务问题确认",
      entities: [{ id: "E1", label: "客户", role: "target", sourceText: "客户" }],
      deliverables: [{
        id: "D1",
        label: "确认方法",
        kind: "procedure",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "确认客户关键业务问题的方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["presales-general"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const binding = (
      id: string,
      label: string,
      requiredConcepts: readonly string[],
    ): Exclude<AnswerCardMatch, { matchType: "none" }>["bindings"][number] => ({
      obligationId: id,
      cardObligationId: id,
      cardId: "GEN-DEMO-QUALIFICATION",
      label,
      domain: "presales-general",
      domains: ["presales-general"],
      required: true,
      evidencePolicy: "direct",
      requiredConcepts,
      forbiddenClaims: ["不得无依据承诺"],
      preferredEvidencePaths: ["wiki/concepts/演示资格判断.md"],
      answerTemplate: "完整答案卡模板",
    });
    const match: Exclude<AnswerCardMatch, { matchType: "none" }> = {
      matchType: "family",
      confidence: "high",
      catalogHash: "a".repeat(64),
      familyId: "demo",
      bindings: [
        binding("O1", "检查角色、业务问题、紧迫性、预期价值和下一步", [
          "客户角色",
          "关键业务问题",
          "紧迫性",
          "价值",
          "下一步",
        ]),
        binding("O2", "信息不足时调整为探索会或预览", ["探索会", "预览"]),
        binding("O3", "具备资格后采用结果优先结构并确认相关性", [
          "先展示结果",
          "确认相关性",
        ]),
      ],
      cardIdHashes: ["b".repeat(64)],
      expectedRevisions: { "presales-general": generalRevision },
      candidateCount: 1,
    };

    const result = adaptAnswerCardToTaskSpec({
      match,
      resolvedQuestion: {
        ...identityResolvedQuestion(question),
        contextUsed: true,
        inheritedSubjects: ["关键业务问题"],
      },
      taskSpec,
    });

    expect(result).toMatchObject({
      activated: true,
      policies: [{
        cardId: "GEN-DEMO-QUALIFICATION",
        cardObligationId: "O1",
        label: "确认客户关键业务问题的方法",
        requiredConcepts: ["关键业务问题"],
        forbiddenClaims: ["不得无依据承诺"],
      }],
    });
    if (!result.activated) throw new Error("expected contextual card activation");
    expect(result.policies[0]).not.toHaveProperty("answerTemplate");
  });

  it("reports every answer-card concept missing after verification", () => {
    const binding = {
      domain: "presales-general" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["success criteria", "measurement"],
    };
    const action = {
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "complete" as const,
        answer: "Discuss business value with the customer [1].",
        citations: [1],
      }],
      citations: [1],
    };
    expect(missingAnswerCardRequiredConcepts(action, [binding])).toEqual([{
      requirementId: "R1",
      requiredConcepts: ["success criteria", "measurement"],
    }]);
    expect(missingAnswerCardRequiredConcepts({
      ...action,
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Agree on measurable success criteria with the customer [1].",
        citations: [1],
      }],
    }, [binding])).toEqual([{
      requirementId: "R1",
      requiredConcepts: ["measurement"],
    }]);
    expect(missingAnswerCardRequiredConcepts({
      ...action,
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Agree on success criteria and a measurement with the customer [1].",
        citations: [1],
      }],
    }, [binding])).toEqual([]);
    expect(missingAnswerCardRequiredConcepts({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "The reviewed material does not cover this requirement.",
        citations: [],
      }],
      citations: [],
    }, [binding])).toEqual([]);
  });

  it("checks governed concepts and forbidden claims against the combined user answer", () => {
    const bindings = [{
      domain: "coremail-professional" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["AuthorizeUrl", "AccessTokenUrl"],
      forbiddenClaims: ["XT6 已确认兼容"],
    }, {
      domain: "coremail-professional" as const,
      requirementId: "R2" as const,
      deliverableId: "D1",
      obligationId: "O2",
      order: 1,
      requiredConcepts: ["AccessTokenUrl"],
      forbiddenClaims: [],
    }];
    const action = {
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "complete" as const,
        answer: "用户先跳转 AuthorizeUrl [1]。",
        citations: [1],
      }, {
        id: "R2" as const,
        coverage: "complete" as const,
        answer: "系统随后调用 AccessTokenUrl；XT6 已确认兼容 [1]。",
        citations: [1],
      }],
      citations: [1],
    };
    expect(missingAnswerCardRequiredConcepts(action, bindings)).toEqual([]);
    expect(violatesAnswerCardForbiddenClaims(action, bindings)).toBe(true);
  });

  it("adds only a concept grounded in the binding's preferred evidence", () => {
    const binding = {
      domain: "presales-general" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["success criteria", "measurement"],
      preferredEvidencePaths: ["wiki/queries/value.md"],
    };
    const action = {
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "complete" as const,
        answer: "Discuss business value with the customer [1].",
        citations: [1],
      }],
      citations: [1],
    };
    const grounded = applyGroundedAnswerCardRequiredConcepts(action, [binding], [{
      requirementId: "R1",
      citation: 2,
      path: "wiki/queries/value.md",
      title: "Value discovery",
      content: "Agree on measurable success criteria before proposing a price.",
    }, {
      requirementId: "R1",
      citation: 3,
      path: "wiki/unreviewed.md",
      title: "Unreviewed",
      content: "measurement",
    }]);

    expect(grounded.requirements[0]?.answer).toContain("success criteria");
    expect(grounded.requirements[0]?.answer).toContain(
      "Agree on measurable success criteria before proposing a price [2]。",
    );
    expect(grounded.requirements[0]?.answer).not.toContain("处理原则包括");
    expect(grounded.requirements[0]?.answer).toContain("[2]");
    expect(grounded.requirements[0]?.citations).toEqual([1, 2]);
    expect(grounded.citations).toEqual([1, 2]);
    expect(missingAnswerCardRequiredConcepts(grounded, [binding])).toEqual([{
      requirementId: "R1",
      requiredConcepts: ["measurement"],
    }]);
  });

  it("reuses one complete evidence fact for multiple required concepts", () => {
    const binding = {
      domain: "presales-general" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["success criteria", "measurement"],
      preferredEvidencePaths: ["wiki/queries/value.md"],
    };
    const grounded = applyGroundedAnswerCardRequiredConcepts({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Discuss business value with the customer [1].",
        citations: [1],
      }],
      citations: [1],
    }, [binding], [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/queries/value.md",
      title: "Value discovery",
      content: "Agree on success criteria and a measurement before proposing a price.",
    }]);

    expect(grounded.requirements[0]?.answer).toContain(
      "Agree on success criteria and a measurement before proposing a price [1]。",
    );
    expect(grounded.requirements[0]?.answer).not.toContain("处理原则包括");
    expect(missingAnswerCardRequiredConcepts(grounded, [binding])).toEqual([]);
  });

  it("preserves the prohibition when a grounded concept comes from a common-error section", () => {
    const binding = {
      domain: "presales-general" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["供应商推断"],
      preferredEvidencePaths: ["wiki/concepts/channel.md"],
    };
    const grounded = applyGroundedAnswerCardRequiredConcepts({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "若只是供应商推测，应标记为待验证假设 [1]。",
        citations: [1],
      }],
      citations: [1],
    }, [binding], [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/concepts/channel.md",
      title: "渠道协同",
      content: "## 常见错误\n\n- 在没有客户证据时把供应商推断写成事实\n",
    }]);

    expect(grounded.requirements[0]?.answer).toContain(
      "不要在没有客户证据时把供应商推断写成事实 [1]。",
    );
    expect(missingAnswerCardRequiredConcepts(grounded, [binding])).toEqual([]);
  });

  it("does not repeat a complete fact when another requirement already covers it", () => {
    const bindings = ["R1", "R2"].map((requirementId, order) => ({
      domain: "presales-general" as const,
      requirementId,
      deliverableId: `D${order + 1}`,
      obligationId: `O${order + 1}`,
      order,
      requiredConcepts: ["success criteria"],
      preferredEvidencePaths: ["wiki/queries/value.md"],
    }));
    const grounded = applyGroundedAnswerCardRequiredConcepts({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Agree on measurable success criteria with the customer [1].",
        citations: [1],
      }, {
        id: "R2",
        coverage: "complete",
        answer: "Then confirm the commercial path [2].",
        citations: [2],
      }],
      citations: [1, 2],
    }, bindings, [{
      requirementId: "R2",
      citation: 2,
      path: "wiki/queries/value.md",
      title: "Value discovery",
      content: "Agree on measurable success criteria before proposing a price.",
    }]);

    expect(grounded.requirements[1]?.answer).toBe(
      "Then confirm the commercial path [2].",
    );
    expect(grounded.citations).toEqual([1, 2]);
  });

  it("does not invent a missing concept that preferred evidence does not contain", () => {
    const binding = {
      domain: "presales-general" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["success criteria", "measurement"],
      preferredEvidencePaths: ["wiki/queries/value.md"],
    };
    const grounded = applyGroundedAnswerCardRequiredConcepts({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Discuss measurable success criteria with the customer [1].",
        citations: [1],
      }],
      citations: [1],
    }, [binding], [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/queries/value.md",
      title: "Value discovery",
      content: "Agree on measurable success criteria before proposing a price.",
    }]);

    expect(grounded.requirements[0]?.answer).toBe(
      "Discuss measurable success criteria with the customer [1].",
    );
    expect(grounded.requirements[0]?.answer).not.toContain("处理原则包括");
    expect(missingAnswerCardRequiredConcepts(grounded, [binding])).toEqual([{
      requirementId: "R1",
      requiredConcepts: ["measurement"],
    }]);
  });

  it("enforces only concepts that can be checked against the read preferred evidence", () => {
    const binding = {
      domain: "coremail-professional" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["IMAP", "个人配置边界"],
      preferredEvidencePaths: ["wiki/queries/migration.md"],
      answerTemplate: "启用 IMAP 服务；资料未说明通讯录、日程和规则是否迁移。",
    };
    const action = {
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "complete" as const,
        answer: "启用客户端访问能力 [1]。",
        citations: [1],
      }],
      citations: [1],
    };
    const evidence = [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/queries/migration.md",
      title: "迁移设置",
      content: "请启用 IMAP 服务；资料未说明通讯录、日程和规则是否迁移。",
    }];

    expect(missingAnswerCardRequiredConcepts(action, [binding], evidence)).toEqual([{
      requirementId: "R1",
      requiredConcepts: ["IMAP"],
    }]);
    expect(answerCardRequirementsWithGroundedConcepts([binding], evidence)).toEqual([
      "R1",
    ]);
  });

  it("does not add an ungrounded concept or turn an uncovered answer into coverage", () => {
    const binding = {
      domain: "coremail-professional" as const,
      requirementId: "R1" as const,
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
      requiredConcepts: ["MigratePassword"],
      preferredEvidencePaths: ["wiki/queries/migration.md"],
    };
    const uncovered = {
      action: "final" as const,
      requirements: [{
        id: "R1" as const,
        coverage: "none" as const,
        answer: "The reviewed material does not cover this question.",
        citations: [],
      }],
      citations: [],
    };
    expect(applyGroundedAnswerCardRequiredConcepts(uncovered, [binding], [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/queries/migration.md",
      title: "Migration",
      content: "MigratePassword",
    }])).toBe(uncovered);

    const covered = {
      ...uncovered,
      requirements: [{
        id: "R1" as const,
        coverage: "complete" as const,
        answer: "Use the approved authentication path [1].",
        citations: [1],
      }],
      citations: [1],
    };
    expect(applyGroundedAnswerCardRequiredConcepts(covered, [binding], [{
      requirementId: "R1",
      citation: 1,
      path: "wiki/queries/migration.md",
      title: "Migration",
      content: "Only AD is described here.",
    }])).toBe(covered);
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
