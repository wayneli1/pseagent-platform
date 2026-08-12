import { describe, expect, it } from "vitest";
import { identityResolvedQuestion, type ResolvedQuestion } from "./question-resolver.js";
import {
  compileDeterministicTaskSpecFallback,
  DeterministicTaskSpecGuard,
  type TaskSpec,
  type TaskSpecGuardResult,
} from "./task-spec.js";
import { deriveDomainKnowledgePlans } from "./domain-plan.js";
import { compileAtomicObligationContract } from "./atomic-obligation.js";
import type { AtomicObligationContract, AtomicObligationKind } from "./atomic-obligation.js";

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

function contractFromTaskSpec(taskSpec: TaskSpec): AtomicObligationContract {
  const obligations = taskSpec.deliverables.flatMap((deliverable) =>
    deliverable.required
      ? deliverable.obligations
        .filter((obligation) => obligation.required)
        .map((obligation) => ({ deliverable, obligation }))
      : []);
  return {
    subject: taskSpec.subject,
    sourceQuestion: question,
    obligations: obligations.map(({ deliverable, obligation }, index) => {
      const sourceStart = Math.max(0, question.indexOf(obligation.sourceText));
      return {
        id: `O${index + 1}`,
        sourceSpan: {
          start: sourceStart,
          end: sourceStart + obligation.sourceText.length,
        },
        sourceText: obligation.sourceText,
        kind: deliverable.kind as AtomicObligationKind,
        targetEntityIds: obligation.targetEntityIds,
        domains: obligation.domains,
        evidencePolicy: obligation.evidencePolicy,
        evidenceTypes: obligation.evidencePolicy === "direct"
          ? ["formal_page" as const]
          : obligation.evidencePolicy === "customer_input"
            ? ["customer_fact" as const]
            : ["method" as const],
        risk: "low" as const,
        completionCriteria: ["claim_supported"],
        required: true as const,
      };
    }),
  };
}

function deriveFor(
  taskSpec: TaskSpec,
  guardResult: TaskSpecGuardResult = passingGuard,
) {
  return deriveDomainKnowledgePlans({
    resolvedQuestion,
    taskSpec,
    obligationContract: contractFromTaskSpec(taskSpec),
    guardResult,
  });
}

describe("deriveDomainKnowledgePlans", () => {
  it("adds domain-specific retrieval queries for a shared mixed-domain obligation", () => {
    const sourceQuestion = "个人配置不能全部随邮件迁移时，怎样在售前向交付结构化移交可迁项、用户动作、风险和责任人？";
    const resolved = identityResolvedQuestion(sourceQuestion);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion: resolved,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: resolved,
      taskSpec,
    });
    const guard = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: resolved,
      taskSpec,
    });

    const result = deriveDomainKnowledgePlans({
      resolvedQuestion: resolved,
      taskSpec,
      obligationContract: contract,
      guardResult: guard,
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    const professional = result.plans.find((item) =>
      item.domain === "coremail-professional")!;
    const general = result.plans.find((item) => item.domain === "presales-general")!;
    expect(professional.plan.requirements[0]?.queries[0]?.text).toMatch(
      /个人配置.*邮件.*迁移/u,
    );
    expect(general.plan.requirements[0]?.queries[0]?.text).toMatch(
      /售前.*交付.*结构化移交.*风险.*责任人/u,
    );
    expect(professional.plan.requirements[0]?.evidenceAspects[0]?.terms)
      .toEqual(expect.arrayContaining(["个人配置", "邮件", "迁移"]));
    expect(general.plan.requirements[0]?.evidenceAspects[0]?.terms)
      .toEqual(expect.arrayContaining(["售前", "交付", "结构化移交", "风险", "责任人"]));
  });

  it.each([{
    question: "用 XT v6 审计材料回应 RFP 时，怎样同时限定报告版本与范围，并判断该证据是否足以支持参与？",
    scope: "professional" as const,
    domain: "coremail-professional" as const,
    expected: ["XT", "审计", "报告", "版本"],
  }, {
    question: "双轨图里跨系统日程不可用，只说明这项限制、用户替代动作和回退时如何通知。",
    scope: "professional" as const,
    domain: "coremail-professional" as const,
    expected: ["跨系统", "日程", "回退"],
  }, {
    question: "刚才把预算标成黄灯，现在给出一个减速核验动作和转绿或转红的证据。",
    scope: "general" as const,
    domain: "presales-general" as const,
    expected: ["预算", "黄灯", "减速核验", "转绿", "转红"],
  }])("preserves question-level retrieval anchors: $question", ({
    question: sourceQuestion,
    scope,
    domain,
    expected,
  }) => {
    const resolved = identityResolvedQuestion(sourceQuestion);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion: resolved,
      scopeHint: scope,
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: resolved,
      taskSpec,
    });
    const guard = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: resolved,
      taskSpec,
    });

    const result = deriveDomainKnowledgePlans({
      resolvedQuestion: resolved,
      taskSpec,
      obligationContract: contract,
      guardResult: guard,
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    const plan = result.plans.find((item) => item.domain === domain)!;
    expect(plan.plan.requirements[0]?.queries[0]?.text).toBeTruthy();
    expect(plan.plan.requirements[0]?.evidenceAspects[0]?.terms)
      .toEqual(expect.arrayContaining(expected));
  });

  it.each([{
    question: "用 XT v6 审计材料回应 RFP 时，怎样同时限定报告版本与范围，并判断该证据是否足以支持参与？",
    scope: "professional" as const,
    domain: "coremail-professional" as const,
    canonicalQuery: "Coremail XT v6.0 源代码审计 报告版本 适用边界",
  }, {
    question: "双轨图里跨系统日程不可用，只说明这项限制、用户替代动作和回退时如何通知。",
    scope: "professional" as const,
    domain: "coremail-professional" as const,
    canonicalQuery: "双轨并行 跨系统功能限制 日程 回退",
  }, {
    question: "刚才把预算标成黄灯，现在给出一个减速核验动作和转绿或转红的证据。",
    scope: "general" as const,
    domain: "presales-general" as const,
    canonicalQuery: "交通灯状态 黄灯 减速核验 绿灯 红灯 证据",
  }])("adds a canonical named-family retrieval query: $question", ({
    question: sourceQuestion,
    scope,
    domain,
    canonicalQuery,
  }) => {
    const resolved = identityResolvedQuestion(sourceQuestion);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion: resolved,
      scopeHint: scope,
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: resolved,
      taskSpec,
    });
    const guard = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: resolved,
      taskSpec,
    });

    const result = deriveDomainKnowledgePlans({
      resolvedQuestion: resolved,
      taskSpec,
      obligationContract: contract,
      guardResult: guard,
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    expect(result.plans.find((item) => item.domain === domain)
      ?.plan.requirements[0]?.queries[0]?.text).toBe(canonicalQuery);
  });

  it("uses obligation-specific canonical queries for a contextual dual-track list", () => {
    const sourceQuestion =
      "Exchange 与 Coremail 双轨并行，邮件路由已经验证；当前追问：双轨图里跨系统日程不可用，只说明这项限制、用户替代动作和回退时如何通知。";
    const resolved = identityResolvedQuestion(sourceQuestion);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion: resolved,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: resolved,
      taskSpec,
    });
    const guard = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: resolved,
      taskSpec,
    });

    const result = deriveDomainKnowledgePlans({
      resolvedQuestion: resolved,
      taskSpec,
      obligationContract: contract,
      guardResult: guard,
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    const requirements = result.plans[0]!.plan.requirements;
    const userActionIndex = contract.obligations.findIndex((item) =>
      item.sourceText.includes("用户替代动作"));
    const rollbackNoticeIndex = contract.obligations.findIndex((item) =>
      item.sourceText.includes("回退时如何通知"));
    const userAction = requirements[userActionIndex];
    const rollbackNotice = requirements[rollbackNoticeIndex];
    expect(userAction?.queries[0]?.text).toBe(
      "Exchange Coremail 双轨 用户替代 客户端切换 旧系统 新系统",
    );
    expect(rollbackNotice?.queries[0]?.text).toBe(
      "Exchange 替换 用户通知 培训 回退 旧系统",
    );
    expect(userAction?.evidenceAspects[0]?.terms).toEqual(expect.arrayContaining([
      "用户替代",
      "客户端切换",
      "旧系统",
      "新系统",
    ]));
    expect(rollbackNotice?.evidenceAspects[0]?.terms).toEqual(expect.arrayContaining([
      "回退",
      "用户通知",
      "培训",
      "问题受理路径",
    ]));
  });

  it("uses the required atomic-obligation domain union even when TaskSpec domains are stale", () => {
    const taskSpec = mixedTaskSpec();
    for (const deliverable of taskSpec.deliverables) {
      for (const obligation of deliverable.obligations) {
        obligation.domains = ["coremail-professional"];
      }
    }
    const obligationContract = compileAtomicObligationContract({
      resolvedQuestion,
      taskSpec,
    });

    const result = deriveDomainKnowledgePlans({
      resolvedQuestion,
      taskSpec,
      obligationContract,
      guardResult: passingGuard,
    });

    expect(result).toMatchObject({ activated: true });
    if (!result.activated) return;
    expect(result.plans.map((item) => item.domain)).toEqual([
      "coremail-professional",
      "presales-general",
    ]);
  });

  it("derives independent domain plans with stable obligation bindings", () => {
    const result = deriveFor(mixedTaskSpec());

    expect(result).toMatchObject({
      activated: true,
      plans: [
        {
          domain: "coremail-professional",
          scope: "professional",
          bindings: [
            { requirementId: "R1", deliverableId: "D1", obligationId: "O1", order: 0 },
            { requirementId: "R2", deliverableId: "D3", obligationId: "O3", order: 2 },
          ],
          plan: { requirements: [{ id: "R1" }, { id: "R2" }] },
        },
        {
          domain: "presales-general",
          scope: "general",
          bindings: [
            { requirementId: "R1", deliverableId: "D2", obligationId: "O2", order: 1 },
            { requirementId: "R2", deliverableId: "D3", obligationId: "O3", order: 2 },
          ],
          plan: { requirements: [{ id: "R1" }, { id: "R2" }] },
        },
      ],
    });
  });

  it("duplicates a dual-domain obligation without sharing a requirement id namespace", () => {
    const result = deriveFor(mixedTaskSpec());
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    const dualBindings = result.plans.flatMap((plan) =>
      plan.bindings.filter((binding) => binding.obligationId === "O3"));
    expect(dualBindings).toEqual([
      expect.objectContaining({ domain: "coremail-professional", requirementId: "R2" }),
      expect.objectContaining({ domain: "presales-general", requirementId: "R2" }),
    ]);
  });

  it("keeps product facts and POC governance in independent domain plans", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables = [
      {
        id: "D1",
        label: "确认 Coremail 归档接口",
        kind: "fact",
        required: true,
        sourceText: "Coremail 支持哪些归档接口",
        obligations: [{
          id: "O1",
          label: "确认 Coremail 归档接口",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "Coremail 支持哪些归档接口",
        }],
      },
      {
        id: "D2",
        label: "组织 POC 验收与角色分工",
        kind: "procedure",
        required: true,
        sourceText: "POC 验收流程和角色分工怎么组织",
        obligations: [{
          id: "O2",
          label: "组织 POC 验收与角色分工",
          targetEntityIds: ["E2"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "POC 验收流程和角色分工怎么组织",
        }],
      },
    ];

    const result = deriveFor(taskSpec);

    expect(result).toMatchObject({
      activated: true,
      plans: [
        { domain: "coremail-professional", bindings: [{ obligationId: "O1" }] },
        { domain: "presales-general", bindings: [{ obligationId: "O2" }] },
      ],
    });
  });

  it("does not open a domain for an optional deliverable", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables[1]!.required = false;
    const result = deriveFor(taskSpec);

    expect(result).toMatchObject({
      activated: true,
      plans: [{ domain: "coremail-professional", bindings: [{ obligationId: "O1" }] }],
    });
    if (result.activated) expect(result.plans).toHaveLength(1);
  });

  it("passes customer-input conditions into the affected domain plan", () => {
    const taskSpec = mixedTaskSpec();
    taskSpec.deliverables[1]!.obligations[0]!.evidencePolicy = "customer_input";
    const result = deriveFor(taskSpec);

    expect(result).toMatchObject({
      activated: true,
      plans: [
        { domain: "coremail-professional" },
        {
          domain: "presales-general",
          conditions: [
            { requirementId: "R1", inputState: "missing" },
            { requirementId: "R2", inputState: "not_applicable" },
          ],
        },
      ],
    });
  });

  it("does not activate a TaskSpec rejected by the guard", () => {
    expect(deriveFor(mixedTaskSpec(), { ...passingGuard, ok: false })).toEqual({
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

    expect(deriveFor(taskSpec)).toEqual({
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

    expect(deriveFor(taskSpec)).toEqual({
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: 7,
    });
  });
});
