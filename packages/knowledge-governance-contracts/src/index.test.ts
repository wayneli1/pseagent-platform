import { describe, expect, it } from "vitest";
import {
  answerCardSchema,
  feedbackCaseSchema,
  feedbackClassificationSchema,
  questionFamilySchema,
  releaseManifestSchema,
} from "./index.js";

describe("knowledge governance contracts", () => {
  it("accepts an approved domain answer card with governed obligations", () => {
    const card = answerCardSchema.parse({
      cardSchemaVersion: 1,
      cardId: "CM-POC-001",
      domain: "coremail-professional",
      title: "POC范围控制",
      canonicalQuestion: "未购买功能是否应纳入POC测试？",
      questionFamily: "poc_scope_control",
      aliases: ["POC是否测试未采购模块"],
      applicability: { products: ["Coremail"], versions: ["*"] },
      obligations: [{
        id: "O1",
        label: "给出范围判断",
        domains: ["coremail-professional"],
        evidencePolicy: "synthesis",
      }],
      owner: "professional-owner",
      reviewers: ["professional-reviewer"],
      reviewStatus: "approved",
      regressionCaseIds: ["RC-CM-POC-001"],
    });

    expect(card.obligations[0]?.required).toBe(true);
    expect(card.applicability.scenarios).toEqual([]);
  });

  it("rejects a domain card whose obligation belongs only to another domain", () => {
    const result = answerCardSchema.safeParse({
      cardSchemaVersion: 1,
      cardId: "CM-INVALID-001",
      domain: "coremail-professional",
      title: "错误跨域卡",
      canonicalQuestion: "如何处理？",
      questionFamily: "invalid_cross_domain",
      aliases: [],
      applicability: {},
      obligations: [{
        id: "O1",
        label: "通用方法",
        domains: ["presales-general"],
        evidencePolicy: "synthesis",
      }],
      owner: "owner",
      reviewStatus: "approved",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a cross-domain family without turning it into a fact source", () => {
    const family = questionFamilySchema.parse({
      schemaVersion: 1,
      familyId: "MIXED-MIGRATION-001",
      title: "迁移方案与沟通",
      canonicalQuestion: "如何设计迁移并沟通风险？",
      aliases: [],
      bindings: [
        {
          obligationId: "O1",
          cardObligationId: "O1",
          label: "迁移能力",
          domain: "coremail-professional",
          cardId: "CM-MIGRATION-001",
        },
        {
          obligationId: "O2",
          cardObligationId: "O1",
          label: "风险沟通",
          domain: "presales-general",
          cardId: "PS-RISK-001",
        },
      ],
      reviewStatus: "approved",
    });

    expect(family.bindings.map((item) => item.domain)).toEqual([
      "coremail-professional",
      "presales-general",
    ]);
  });

  it("keeps feedback and release records strict and revision-bound", () => {
    expect(feedbackCaseSchema.safeParse({
      caseId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00f8",
      requestId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00f9",
      pseudonymousUserId: "a".repeat(64),
      classification: "incorrect",
      status: "new",
      createdAt: "2026-08-05T00:00:00+08:00",
    }).success).toBe(true);
    expect(feedbackClassificationSchema.safeParse("correction").success)
      .toBe(true);
    expect(releaseManifestSchema.safeParse({
      schemaVersion: 1,
      releaseId: "KR-2026-08-001",
      professionalRevision: "a".repeat(40),
      generalRevision: "b".repeat(40),
      answerContractRevision: "c".repeat(40),
      cardCatalogHash: "d".repeat(64),
      regressionRunId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00fa",
      approvedBy: ["release-manager"],
      createdAt: "2026-08-05T00:00:00+08:00",
    }).success).toBe(true);
  });
});
