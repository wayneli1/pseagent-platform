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
  it("turns an enumerated shared action into independently verifiable evidence aspects", () => {
    const enumeratedQuestion =
      "信创邮件系统暂不建设多活时，上线方案应怎样覆盖备份、重建、恢复演练和恢复时间边界？";
    const enumeratedResolved: ResolvedQuestion = {
      rawQuestion: enumeratedQuestion,
      standaloneQuestion: enumeratedQuestion,
      contextUsed: false,
      inheritedSubjects: [],
      corrections: [],
    };
    const sourceText = "上线方案应怎样覆盖备份、重建、恢复演练和恢复时间边界";
    const spec: TaskSpec = {
      subject: enumeratedQuestion,
      entities: [{
        id: "E1",
        label: "信创邮件系统",
        role: "product",
        sourceText: "信创邮件系统",
      }],
      deliverables: [{
        id: "D1",
        label: sourceText,
        kind: "procedure",
        required: true,
        sourceText,
        obligations: [{
          id: "O1",
          label: sourceText,
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText,
        }],
      }],
    };

    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: enumeratedResolved,
      taskSpec: spec,
      guardResult: { ...passingGuard, explicitEntityCount: 0, mappedExplicitEntityCount: 0 },
    });

    expect(result.activated).toBe(true);
    if (!result.activated) return;
    expect(result.plan.requirements[0]?.evidenceAspects.map((aspect) => aspect.label))
      .toEqual(["备份", "重建", "恢复演练", "恢复时间边界"]);
  });

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

  it("adds shared acceptance context without diluting each required parallel aspect", () => {
    const parallelQuestion =
      "集团共用一套 Coremail，但各子公司要独立域名、用户别名和管理员权限，方案设计与验收边界是什么？";
    const aspects = ["独立域名", "用户别名", "管理员权限"];
    const spec: TaskSpec = {
      subject: parallelQuestion,
      entities: [{
        id: "E1",
        label: "集团独立域名方案",
        role: "subject",
        sourceText: "集团共用一套 Coremail，但各子公司要独立域名",
      }],
      deliverables: aspects.map((aspect, index) => ({
        id: `D${index + 1}`,
        label: aspect,
        kind: "fact",
        required: true,
        sourceText: aspect,
        obligations: [{
          id: `O${index + 1}`,
          label: aspect,
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: aspect,
        }],
      })),
    };
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: parallelQuestion,
        standaloneQuestion: parallelQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    const adminQueries = result.plan.requirements[2]?.queries.map((query) =>
      query.text) ?? [];
    expect(adminQueries).toEqual([
      "管理员权限",
      "管理员权限 方案设计与验收边界是什么",
    ]);
    expect(adminQueries.join(" ")).not.toMatch(/独立域名|用户别名/u);
    expect(result.plan.requirements[2]?.evidenceAspects[0]?.label)
      .toBe("管理员权限 方案设计与验收边界是什么");
  });

  it("uses distinct atomic labels when the model reuses one broad source for parallel obligations", () => {
    const capacityQuestion =
      "规划 2 万用户 Coremail 时，存储、索引和带宽应怎样估算？";
    const broadSource = "存储、索引和带宽应怎样估算";
    const labels = [
      "说明存储容量的估算方法",
      "说明索引容量的估算方法",
      "说明带宽的估算方法",
    ];
    const spec: TaskSpec = {
      subject: capacityQuestion,
      entities: [{
        id: "E1",
        label: "2 万用户 Coremail",
        role: "subject",
        sourceText: "2 万用户 Coremail",
      }],
      deliverables: labels.map((label, index) => ({
        id: `D${index + 1}`,
        label,
        kind: "fact",
        required: true,
        sourceText: broadSource,
        obligations: [{
          id: `O${index + 1}`,
          label,
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: broadSource,
        }],
      })),
    };
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: capacityQuestion,
        standaloneQuestion: capacityQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    expect(result.plan.requirements.map((requirement) => requirement.question))
      .toEqual(labels.map((label) => `规划 2 万用户 Coremail 时 ${label}`));
    expect(result.plan.requirements.map((requirement) =>
      requirement.evidenceAspects[0]?.label))
      .toEqual(labels.map((label) => `规划 2 万用户 Coremail 时 ${label}`));
    expect(result.plan.requirements[0]?.queries[0]?.text)
      .toBe("规划 2 万用户 Coremail 时 存储 索引和带宽应怎样估算");
    expect(result.plan.requirements[0]?.queries.some((query) =>
      query.text.includes("说明存储容量的估算方法")))
      .toBe(true);
  });

  it("removes earlier dimensions from cumulative model sources", () => {
    const question =
      "金融客户想先小范围上线 Coremail AI，灰度拓扑 用户控制 故障隔离 验收指标 不能直接承诺的数字应该怎么设计？";
    const sources = [
      "灰度拓扑",
      "灰度拓扑 用户控制",
      "灰度拓扑 用户控制 故障隔离",
      "灰度拓扑 用户控制 故障隔离 验收指标",
      "灰度拓扑 用户控制 故障隔离 验收指标 不能直接承诺的数字",
    ];
    const labels = [
      "设计灰度拓扑",
      "设计用户控制机制",
      "设计故障隔离方案",
      "设计验收指标",
      "识别不能直接承诺的数字",
    ];
    const spec: TaskSpec = {
      subject: "Coremail AI 小范围上线方案",
      entities: [],
      deliverables: labels.map((label, index) => ({
        id: `D${index + 1}`,
        label,
        kind: "fact",
        required: true,
        sourceText: sources[index]!,
        obligations: [{
          id: `O${index + 1}`,
          label,
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: sources[index]!,
        }],
      })),
    };

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
    const topology = result.plan.requirements[0]!;
    expect(topology.question).toContain("灰度拓扑");
    expect(topology.question).not.toMatch(/用户控制|故障隔离|验收指标/u);
    const acceptance = result.plan.requirements[3]!;
    expect(acceptance.question).toContain("Coremail AI");
    expect(acceptance.question).toContain("设计验收指标");
    expect(acceptance.queries.map((query) => query.text).join(" "))
      .not.toMatch(/灰度拓扑|用户控制|故障隔离/u);
    expect(acceptance.queries.map((query) => query.text).join(" "))
      .toContain("试用效果评估");
    expect(acceptance.evidenceAspects[0]?.terms.join(" "))
      .not.toMatch(/灰度拓扑|用户控制|故障隔离/u);
    const promises = result.plan.requirements[4]!;
    expect(promises.queries.map((query) => query.text).join(" "))
      .toContain("不能直接承诺的数字");
    expect(promises.queries.map((query) => query.text).join(" "))
      .not.toMatch(/灰度拓扑|用户控制|故障隔离|验收指标/u);
    expect(promises.queries.map((query) => query.text).join(" "))
      .toContain("统计口径");
  });

  it("keeps leading topic context for required parallel items without a trailing request", () => {
    const question =
      "Coremail 归档检索异常时，什么时候可以重建索引，执行前后需要哪些检查和风险控制？";
    const aspects = ["哪些检查", "风险控制"];
    const spec: TaskSpec = {
      subject: question,
      entities: [],
      deliverables: aspects.map((aspect, index) => ({
        id: `D${index + 1}`,
        label: aspect,
        kind: "fact",
        required: true,
        sourceText: aspect,
        obligations: [{
          id: `O${index + 1}`,
          label: aspect,
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: aspect,
        }],
      })),
    };
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

    for (const requirement of result.plan.requirements) {
      expect(requirement.question).toContain("Coremail 归档检索异常时");
      expect(requirement.queries.some((query) =>
        query.text.includes("Coremail 归档检索异常时"))).toBe(true);
    }
    expect(result.plan.requirements[0]?.question).toContain("哪些检查");
    expect(result.plan.requirements[1]?.question).toContain("风险控制");
  });

  it("keeps a traceable leading incident premise when the request has no bound entity", () => {
    const incidentQuestion =
      "用户说外部邮件没收到，怎样沿接收、过滤、路由、投递和信筒建立完整证据链？";
    const request = "怎样沿接收、过滤、路由、投递和信筒建立完整证据链";
    const spec: TaskSpec = {
      subject: incidentQuestion,
      entities: [{
        id: "E1",
        label: "邮件证据链",
        role: "subject",
        sourceText: incidentQuestion,
      }],
      deliverables: [{
        id: "D1",
        label: request,
        kind: "diagnosis",
        required: true,
        sourceText: request,
        obligations: [{
          id: "O1",
          label: request,
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: request,
        }],
      }],
    };
    const result = adaptTaskSpecToKnowledgePlan({
      scope: "professional",
      resolvedQuestion: {
        ...resolvedQuestion,
        rawQuestion: incidentQuestion,
        standaloneQuestion: incidentQuestion,
      },
      taskSpec: spec,
      guardResult: passingGuard,
    });
    expect(result.activated).toBe(true);
    if (!result.activated) return;

    expect(result.plan.requirements[0]?.question)
      .toBe("用户说外部邮件没收到 怎样沿接收 过滤 路由 投递和信筒建立完整证据链");
    expect(result.plan.requirements[0]?.queries.map((query) => query.text))
      .toEqual([
        "用户说外部邮件没收到 怎样沿接收 过滤 路由 投递和信筒建立完整证据链",
      ]);
  });

  it("anchors an unbound dependent subrequest to its traceable topic", () => {
    const question =
      "Webadmin 同时配置了全局密码策略和某组织的密码策略，用户最终按哪套执行，实施前还要确认什么？";
    const spec: TaskSpec = {
      subject: "Webadmin 密码策略",
      entities: [
        {
          id: "E1",
          label: "全局密码策略",
          role: "subject",
          sourceText: "全局密码策略",
        },
        {
          id: "E2",
          label: "组织密码策略",
          role: "subject",
          sourceText: "某组织的密码策略",
        },
      ],
      deliverables: [{
        id: "D1",
        label: "密码策略优先级",
        kind: "fact",
        required: true,
        sourceText: "用户最终按哪套执行",
        obligations: [{
          id: "O1",
          label: "说明密码策略优先级",
          targetEntityIds: ["E1", "E2"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "用户最终按哪套执行",
        }],
      }, {
        id: "D2",
        label: "实施确认事项",
        kind: "fact",
        required: true,
        sourceText: "实施前还要确认什么",
        obligations: [{
          id: "O2",
          label: "列出实施前需要确认的事项清单",
          targetEntityIds: [],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "实施前还要确认什么",
        }],
      }],
    };

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

    const requirement = result.plan.requirements[1]!;
    expect(requirement.question).toContain("Webadmin");
    expect(requirement.question).toContain("密码策略");
    expect(requirement.question).toContain("实施前还要确认什么");
    expect(requirement.evidenceAspects[0]?.terms.join(" ")).toContain("Webadmin");
    expect(requirement.queries.length).toBeGreaterThan(0);
    expect(requirement.queries.every((query) =>
      query.text.includes("Webadmin") && query.text.includes("密码策略")))
      .toBe(true);
    expect(requirement.queries.map((query) => query.text))
      .not.toContain("实施前还要确认什么");
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

  it("keeps explicitly requested comparison dimensions as separate evidence aspects", () => {
    const question =
      "Exchange 和 Domino 在接口、权限、运行环境、可迁数据上有什么区别？";
    const spec: TaskSpec = {
      subject: "迁移方式对比",
      entities: [
        { id: "E1", label: "Exchange", role: "reference", sourceText: "Exchange" },
        { id: "E2", label: "Domino", role: "reference", sourceText: "Domino" },
      ],
      deliverables: [{
        id: "D1",
        label: "迁移方式区别",
        kind: "comparison",
        required: true,
        sourceText: question.replace(/？$/u, ""),
        obligations: [{
          id: "O1",
          label: "迁移方式区别",
          targetEntityIds: ["E1", "E2"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question.replace(/？$/u, ""),
        }],
      }],
    };

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

    expect(result.plan.requirements[0]?.evidenceAspects.map((aspect) => aspect.label))
      .toEqual(["接口", "权限", "运行环境", "可迁数据"]);
    expect(result.plan.requirements[0]?.queries[0]?.aspectIds)
      .toEqual(["A1", "A2", "A3", "A4"]);
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
