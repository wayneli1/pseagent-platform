import { describe, expect, it } from "vitest";
import type { ResolvedQuestion } from "./question-resolver.js";
import type { TaskSpec, TaskSpecGuardResult } from "./task-spec.js";
import { deriveDomainKnowledgePlans } from "./domain-plan.js";

const question = "客户需要确认Coremail当前版本、获得售前推进建议，并形成联合验证方案";

const resolvedQuestion: ResolvedQuestion = {
  rawQuestion: question,
  standaloneQuestion: question,
  contextUsed: false,
  inheritedSubjects: [],
  corrections: [],
};

const passingGuard: TaskSpecGuardResult = {
  ok: true,
  issues: [],
  explicitEntityCount: 1,
  mappedExplicitEntityCount: 1,
  explicitRequestCount: 3,
  mappedExplicitRequestCount: 3,
};

function mixedTaskSpec(): TaskSpec {
  return {
    subject: "Coremail 联合验证",
    entities: [
      { id: "E1", label: "Coremail", role: "product", sourceText: "Coremail" },
      { id: "E2", label: "客户", role: "target", sourceText: "客户" },
    ],
    deliverables: [
      {
        id: "D1",
        label: "确认版本",
        kind: "fact",
        required: true,
        sourceText: "确认Coremail当前版本",
        obligations: [{
          id: "O1",
          label: "确认 Coremail 当前版本",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "Coremail当前版本",
        }],
      },
      {
        id: "D2",
        label: "推进与验证",
        kind: "recommendation",
        required: true,
        sourceText: "售前推进建议，并形成联合验证方案",
        obligations: [
          {
            id: "O2",
            label: "售前推进建议",
            targetEntityIds: ["E2"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: "售前推进建议",
          },
          {
            id: "O3",
            label: "联合验证方案",
            targetEntityIds: ["E1", "E2"],
            evidencePolicy: "synthesis",
            domains: ["coremail-professional", "presales-general"],
            required: true,
            sourceText: "联合验证方案",
          },
          {
            id: "O4",
            label: "可选补充",
            targetEntityIds: ["E2"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: false,
            sourceText: "售前推进建议",
          },
        ],
      },
    ],
  };
}

describe("deriveDomainKnowledgePlans", () => {
  it("derives independent domain plans with stable obligation bindings", () => {
    const result = deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec: mixedTaskSpec(),
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({
      activated: true,
      plans: [
        {
          domain: "coremail-professional",
          scope: "professional",
          bindings: [
            { requirementId: "R1", deliverableId: "D1", obligationId: "O1", order: 0 },
            { requirementId: "R2", deliverableId: "D2", obligationId: "O3", order: 2 },
          ],
          plan: { requirements: [{ id: "R1" }, { id: "R2" }] },
        },
        {
          domain: "presales-general",
          scope: "general",
          bindings: [
            { requirementId: "R1", deliverableId: "D2", obligationId: "O2", order: 1 },
            { requirementId: "R2", deliverableId: "D2", obligationId: "O3", order: 2 },
          ],
          plan: { requirements: [{ id: "R1" }, { id: "R2" }] },
        },
      ],
    });
  });

  it("duplicates a dual-domain obligation without sharing a requirement id namespace", () => {
    const result = deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec: mixedTaskSpec(),
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    const dualBindings = result.plans.flatMap((plan) =>
      plan.bindings.filter((binding) => binding.obligationId === "O3"));
    expect(dualBindings).toEqual([
      expect.objectContaining({ domain: "coremail-professional", requirementId: "R2" }),
      expect.objectContaining({ domain: "presales-general", requirementId: "R2" }),
    ]);
  });

  it("does not open a domain for an optional deliverable", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables[1]!.required = false;
    const result = deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec,
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({
      activated: true,
      plans: [{ domain: "coremail-professional", bindings: [{ obligationId: "O1" }] }],
    });
    if (result.activated) expect(result.plans).toHaveLength(1);
  });

  it("fails closed before domain execution when customer input is required", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables[1]!.obligations[0]!.evidencePolicy = "customer_input";
    expect(deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec,
      guardResult: passingGuard,
    })).toEqual({
      activated: false,
      reason: "customer_input_unhandled",
      applicableObligationCount: 3,
    });
  });

  it("does not activate a TaskSpec rejected by the guard", () => {
    expect(deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec: mixedTaskSpec(),
      guardResult: { ...passingGuard, ok: false },
    })).toEqual({
      activated: false,
      reason: "guard_rejected",
      applicableObligationCount: 0,
    });
  });

  it("fails closed when any single domain exceeds the requirement contract", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables = [{
      ...taskSpec.deliverables[0]!,
      obligations: Array.from({ length: 7 }, (_, index) => ({
        id: `O${index + 1}`,
        label: `售前建议${index + 1}`,
        targetEntityIds: ["E2"],
        evidencePolicy: "synthesis" as const,
        domains: ["presales-general" as const],
        required: true,
        sourceText: "售前推进建议",
      })),
    }];

    expect(deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec,
      guardResult: passingGuard,
    })).toEqual({
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: 7,
    });
  });

  it("fails closed before execution when the merged cross-domain claim count exceeds the contract", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables = [{
      ...taskSpec.deliverables[0]!,
      obligations: Array.from({ length: 7 }, (_, index) => ({
        id: `O${index + 1}`,
        label: `联合要求${index + 1}`,
        targetEntityIds: [index < 4 ? "E1" : "E2"],
        evidencePolicy: index < 4 ? "direct" as const : "synthesis" as const,
        domains: [index < 4
          ? "coremail-professional" as const
          : "presales-general" as const],
        required: true,
        sourceText: index < 4 ? "Coremail当前版本" : "售前推进建议",
      })),
    }];

    expect(deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec,
      guardResult: passingGuard,
    })).toEqual({
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: 7,
    });
  });
});
