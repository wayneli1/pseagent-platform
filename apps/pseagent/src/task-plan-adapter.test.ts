import { describe, expect, it } from "vitest";
import type { ResolvedQuestion } from "./question-resolver.js";
import type { TaskSpec, TaskSpecGuardResult } from "./task-spec.js";
import { adaptTaskSpecToKnowledgePlan } from "./task-plan-adapter.js";

const question = "平安参考华为和比亚迪的多节点案例，并形成架构建议";

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
  explicitEntityCount: 2,
  mappedExplicitEntityCount: 2,
  explicitRequestCount: 1,
  mappedExplicitRequestCount: 1,
};

function taskSpec(): TaskSpec {
  return {
    subject: "平安多节点架构参考",
    entities: [
      { id: "E1", label: "平安", role: "target", sourceText: "平安" },
      { id: "E2", label: "华为", role: "reference", sourceText: "华为" },
      { id: "E3", label: "比亚迪", role: "reference", sourceText: "比亚迪" },
    ],
    deliverables: [
      {
        id: "D1",
        label: "多节点案例",
        kind: "comparison",
        required: true,
        sourceText: "华为和比亚迪的多节点案例",
        obligations: [
          {
            id: "O1",
            label: "华为多节点方案",
            targetEntityIds: ["E2"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: "华为",
          },
          {
            id: "O2",
            label: "比亚迪多节点案例归纳",
            targetEntityIds: ["E3"],
            evidencePolicy: "synthesis",
            domains: ["coremail-professional"],
            required: true,
            sourceText: "比亚迪",
          },
          {
            id: "O3",
            label: "可选补充",
            targetEntityIds: ["E1"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: false,
            sourceText: "架构建议",
          },
        ],
      },
    ],
  };
}

describe("adaptTaskSpecToKnowledgePlan", () => {
  it("creates one requirement per applicable required obligation", () => {
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: taskSpec(),
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({
      activated: true,
      obligationIds: ["O1", "O2"],
      plan: {
        subject: "平安多节点架构参考",
        retrievalStrategy: "coverage_units",
        requirements: [
          { id: "R1", evidenceMode: "direct_only" },
          { id: "R2", evidenceMode: "synthesis_allowed" },
        ],
      },
    });
  });

  it("puts every target entity into the semantic query and aspect terms", () => {
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: taskSpec(),
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    expect(result.plan.requirements[0]?.queries[0]?.text).toContain("华为");
    expect(result.plan.requirements[0]?.evidenceAspects[0]?.terms).toContain("华为");
    expect(result.plan.requirements[1]?.queries[0]?.text).toContain("比亚迪");
    expect(result.plan.requirements[1]?.evidenceAspects[0]?.terms).toContain("比亚迪");
  });

  it("restores named comparison context when a split obligation only says two sides", () => {
    const comparisonQuestion =
      "客户已有共享存储双机热备，为什么还会考虑 Coremail 多活？两者关键差异和限制是什么？";
    const spec: TaskSpec = {
      subject: comparisonQuestion,
      entities: [
        { id: "E1", label: "共享存储双机热备", role: "reference", sourceText: "共享存储双机热备" },
        { id: "E2", label: "Coremail 多活", role: "product", sourceText: "Coremail 多活" },
      ],
      deliverables: [{
        id: "D1",
        label: "两者关键差异和限制",
        kind: "comparison",
        required: true,
        sourceText: "两者关键差异和限制是什么",
        obligations: [{
          id: "O1",
          label: "两者关键差异和限制",
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "两者关键差异和限制是什么",
        }],
      }, {
        id: "D2",
        label: "考虑 Coremail 多活的理由",
        kind: "recommendation",
        required: true,
        sourceText: "为什么还会考虑 Coremail 多活",
        obligations: [{
          id: "O2",
          label: "考虑 Coremail 多活的理由",
          targetEntityIds: ["E2"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "为什么还会考虑 Coremail 多活",
        }],
      }],
    };

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: comparisonQuestion,
        standaloneQuestion: comparisonQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    const requirement = result.plan.requirements[0]!;
    expect(requirement.queries[0]?.text).toContain("共享存储双机热备");
    expect(requirement.queries[0]?.text).toContain("Coremail 多活");
    expect(requirement.evidenceAspects[0]?.terms.join(" "))
      .toContain("共享存储双机热备");
    const selectionRequirement = result.plan.requirements[1]!;
    expect(selectionRequirement.question).toBe("为什么还会考虑 Coremail 多活");
    expect(selectionRequirement.queries[0]?.text).toContain("共享存储双机热备");
    expect(selectionRequirement.queries[0]?.text).toContain("两者关键差异和限制");
  });

  it("maps the current general scope to the general knowledge domain", () => {
    const spec = taskSpec();
    spec.deliverables[0]!.obligations[0]!.required = false;
    spec.deliverables[0]!.obligations[1]!.domains = ["presales-general"];
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "general",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({
      activated: true,
      obligationIds: ["O2"],
      plan: {
        requirements: [{ evidenceMode: "synthesis_allowed" }],
      },
    });
  });

  it("does not activate a task spec rejected by the guard", () => {
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: taskSpec(),
      guardResult: { ...passingGuard, ok: false },
    });

    expect(result).toEqual({
      activated: false,
      reason: "guard_rejected",
      applicableObligationCount: 0,
    });
  });

  it("returns an explicit inactive result when no obligation applies", () => {
    const spec = taskSpec();
    spec.deliverables[0]!.required = false;
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    });

    expect(result).toEqual({
      activated: false,
      reason: "no_applicable_obligations",
      applicableObligationCount: 0,
    });
  });

  it("keeps a required customer-input obligation active with a missing-input condition", () => {
    const spec = taskSpec();
    spec.deliverables[0]!.obligations = [
      {
        id: "O1",
        label: "判断当前机会赢率",
        targetEntityIds: ["E1"],
        evidencePolicy: "customer_input",
        domains: ["presales-general"],
        required: true,
        sourceText: "赢率如何",
      },
      {
        id: "O2",
        label: "提升赢率的行动建议",
        targetEntityIds: ["E1"],
        evidencePolicy: "synthesis",
        domains: ["presales-general"],
        required: true,
        sourceText: "怎样做才能提升赢率",
      },
    ];

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "general",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({
      activated: true,
      obligationIds: ["O1", "O2"],
      conditions: [
        { requirementId: "R1", inputState: "missing" },
        { requirementId: "R2", inputState: "not_applicable" },
      ],
      plan: {
        requirements: [
          { id: "R1", evidenceMode: "synthesis_allowed" },
          { id: "R2", evidenceMode: "synthesis_allowed" },
        ],
      },
    });
  });

  it("keeps customer-input condition binding invariant under obligation order", () => {
    const customerInput = {
      id: "O1",
      label: "判断当前机会赢率",
      targetEntityIds: ["E1"],
      evidencePolicy: "customer_input" as const,
      domains: ["presales-general" as const],
      required: true,
      sourceText: "赢率如何",
    };
    const synthesis = {
      id: "O2",
      label: "提升赢率的行动建议",
      targetEntityIds: ["E1"],
      evidencePolicy: "synthesis" as const,
      domains: ["presales-general" as const],
      required: true,
      sourceText: "怎样做才能提升赢率",
    };

    for (const obligations of [
      [customerInput, synthesis],
      [synthesis, customerInput],
    ]) {
      const spec = taskSpec();
      spec.deliverables[0]!.obligations = obligations;
      const result = adaptTaskSpecToKnowledgePlan({
        scope: "general",
        resolvedQuestion,
        taskSpec: spec,
        guardResult: passingGuard,
      });
      expect(result).toMatchObject({
        activated: true,
        conditions: obligations.map((obligation, index) => ({
          requirementId: `R${index + 1}`,
          inputState: obligation.evidencePolicy === "customer_input"
            ? "missing"
            : "not_applicable",
        })),
      });
    }
  });

  it("fails closed instead of partially activating required cross-domain work", () => {
    const spec = taskSpec();
    spec.deliverables[0]!.obligations[1]!.domains = ["presales-general"];

    expect(adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    })).toEqual({
      activated: false,
      reason: "multi_domain_required",
      applicableObligationCount: 2,
    });
  });

  it("ignores obligations under an optional deliverable", () => {
    const spec = taskSpec();
    spec.deliverables.push({
      id: "D2",
      label: "可选售前扩展",
      kind: "recommendation",
      required: false,
      sourceText: "架构建议",
      obligations: [{
        id: "O4",
        label: "可选跨域建议",
        targetEntityIds: ["E1"],
        evidencePolicy: "synthesis",
        domains: ["presales-general"],
        required: true,
        sourceText: "架构建议",
      }],
    });

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result).toMatchObject({
      activated: true,
      obligationIds: ["O1", "O2"],
    });
  });

  it("builds source-first scoped queries and never lets an unrelated label dominate", () => {
    const specificQuestion = "平安参考工行、华为、比亚迪的华南双中心多节点案例";
    const spec = taskSpec();
    spec.entities.push({
      id: "E4",
      label: "工行",
      role: "reference",
      sourceText: "工行",
    });
    spec.deliverables[0]!.sourceText = "工行、华为、比亚迪的华南双中心多节点案例";
    spec.deliverables[0]!.obligations = [{
      id: "O1",
      label: "高校邮件系统方案",
      targetEntityIds: ["E2"],
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
      required: true,
      sourceText: "华为",
    }];

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: specificQuestion,
        standaloneQuestion: specificQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    expect(result.plan.requirements[0]?.queries).toHaveLength(1);
    const primaryQuery = result.plan.requirements[0]?.queries[0]?.text ?? "";
    expect(primaryQuery).toContain("华为");
    expect(primaryQuery).toContain("华南双中心多节点");
    expect(primaryQuery).not.toMatch(/工行|比亚迪|高校/u);
    expect(result.plan.requirements[0]?.evidenceAspects[0]?.terms.join(" "))
      .not.toContain("高校");
  });

  it("removes other parallel entities even when an obligation source is broad", () => {
    const specificQuestion = "平安参考工行、华为、比亚迪的华南双中心多节点案例";
    const spec = taskSpec();
    spec.entities.push({
      id: "E4",
      label: "工行",
      role: "reference",
      sourceText: "工行",
    });
    spec.deliverables[0]!.sourceText = "工行、华为、比亚迪的华南双中心多节点案例";
    spec.deliverables[0]!.obligations = [{
      id: "O1",
      label: "华为多节点案例",
      targetEntityIds: ["E2"],
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
      required: true,
      sourceText: "工行、华为、比亚迪的华南双中心多节点案例",
    }];

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: specificQuestion,
        standaloneQuestion: specificQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    const primaryQuery = result.plan.requirements[0]?.queries[0]?.text ?? "";
    expect(primaryQuery).toContain("华为");
    expect(primaryQuery).toContain("华南双中心多节点");
    expect(primaryQuery).not.toMatch(/工行|比亚迪/u);
  });

  it("keeps the traceable question when a provider omits target bindings", () => {
    const question = "Coremail 是否已经支持 2035 年量子卫星邮件协议？";
    const spec = taskSpec();
    spec.subject = "Coremail 协议支持";
    spec.entities = [{
      id: "E1",
      label: "Coremail",
      role: "subject",
      sourceText: question,
    }];
    spec.deliverables = [{
      id: "D1",
      label: "确认协议支持",
      kind: "fact",
      required: true,
      sourceText: question,
      obligations: [{
        id: "O1",
        label: "确认协议支持",
        targetEntityIds: [],
        evidencePolicy: "direct",
        domains: ["coremail-professional"],
        required: true,
        sourceText: question,
      }],
    }];

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: question,
        standaloneQuestion: question,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    expect(result.plan.requirements[0]?.question).toContain("量子卫星邮件协议");
    expect(result.plan.requirements[0]?.queries[0]?.text).toContain("Coremail");
  });

  it("refuses more than six applicable obligations without truncating", () => {
    const spec = taskSpec();
    spec.deliverables[0]!.obligations = Array.from({ length: 7 }, (_, index) => ({
      id: `O${index + 1}`,
      label: `对象${index + 1}方案`,
      targetEntityIds: [index % 2 === 0 ? "E2" : "E3"],
      evidencePolicy: "direct" as const,
      domains: ["coremail-professional" as const],
      required: true,
      sourceText: index % 2 === 0 ? "华为" : "比亚迪",
    }));

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion,
      taskSpec: spec,
      guardResult: passingGuard,
    });

    expect(result).toEqual({
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: 7,
    });
  });
});
