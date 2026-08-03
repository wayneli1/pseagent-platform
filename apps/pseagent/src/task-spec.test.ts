import { describe, expect, it, vi } from "vitest";
import type { KnowledgePlan } from "./contracts.js";
import type { ModelClient } from "./model-client.js";
import {
  DeterministicTaskSpecGuard,
  extractExplicitQuestionSignals,
  ModelTaskCompiler,
  TASK_SPEC_SYSTEM_PROMPT,
  taskSpecSchema,
} from "./task-spec.js";

const plan: KnowledgePlan = {
  subject: "客户多节点案例",
  requirements: [{
    id: "R1",
    question: "参考客户的多节点案例",
    evidenceMode: "synthesis_allowed",
    evidenceAspects: [{ id: "A1", label: "客户案例", terms: ["多节点"] }],
    queries: [{ text: "客户 多节点 案例", aspectIds: ["A1"] }],
  }],
};

function parallelEntityTaskSpec(entityLabels = ["工行", "华为", "比亚迪"]) {
  const entities = ["平安", ...entityLabels].map((label, index) => ({
    id: `E${index + 1}`,
    label,
    role: index === 0 ? "target" : "reference",
    sourceText: label,
  }));
  return {
    subject: "平安多节点架构参考",
    entities,
    deliverables: [{
      id: "D1",
      label: "参考多节点案例",
      kind: "comparison",
      required: true,
      sourceText: `参考${entityLabels.join("、")}的多节点方案`,
      obligations: entityLabels.map((label, index) => ({
        id: `O${index + 1}`,
        label: `${label}多节点方案`,
        targetEntityIds: [`E${index + 2}`],
        evidencePolicy: "direct",
        domains: ["coremail-professional"],
        required: true,
        sourceText: label,
      })),
    }],
  };
}

function guardSingleObligation(
  question: string,
  evidencePolicy: "direct" | "synthesis" | "customer_input",
  role: "product" | "target" | "unknown" = "product",
  obligationLabel = question,
) {
  return new DeterministicTaskSpecGuard().validate({
    resolvedQuestion: {
      rawQuestion: question,
      standaloneQuestion: question,
      contextUsed: false,
      inheritedSubjects: [],
      corrections: [],
    },
    taskSpec: taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: question, role, sourceText: question }],
      deliverables: [{
        id: "D1",
        label: question,
        kind: "diagnosis",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: obligationLabel,
          targetEntityIds: ["E1"],
          evidencePolicy,
          domains: [evidencePolicy === "customer_input"
            ? "presales-general"
            : "coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    }),
  });
}

function guardBroadParallelObligation(question: string, entities: readonly string[]) {
  return new DeterministicTaskSpecGuard().validate({
    resolvedQuestion: {
      rawQuestion: question,
      standaloneQuestion: question,
      contextUsed: false,
      inheritedSubjects: [],
      corrections: [],
    },
    taskSpec: taskSpecSchema.parse({
      subject: question,
      entities: entities.map((entity, index) => ({
        id: `E${index + 1}`,
        label: entity,
        role: "reference",
        sourceText: entity,
      })),
      deliverables: [{
        id: "D1",
        label: question,
        kind: "comparison",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: question,
          targetEntityIds: entities.map((_, index) => `E${index + 1}`),
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    }),
  });
}

describe("taskSpecSchema", () => {
  it("accepts sequential entities, deliverables and obligations", () => {
    expect(taskSpecSchema.parse(parallelEntityTaskSpec())).toMatchObject({
      subject: "平安多节点架构参考",
    });
  });

  it.each([
    () => ({ ...parallelEntityTaskSpec(), entities: [] }),
    () => {
      const value = parallelEntityTaskSpec();
      value.deliverables[0]!.obligations[0]!.targetEntityIds = ["E99"];
      return value;
    },
    () => {
      const value = parallelEntityTaskSpec();
      value.deliverables[0]!.obligations[0]!.domains = ["normal"];
      return value;
    },
  ])("rejects structurally unsafe task specs", (fixture) => {
    expect(taskSpecSchema.safeParse(fixture()).success).toBe(false);
  });
});

describe("DeterministicTaskSpecGuard", () => {
  it.each([
    ["工行", "华为", "比亚迪"],
    ["甲公司", "乙公司", "丙公司"],
  ])("preserves arbitrary explicit parallel entities: %s/%s/%s", (...entities) => {
    const question = `平安想调整架构，参考${entities.join("、")}的多节点方案`;
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse(parallelEntityTaskSpec(entities)),
    });

    expect(result.ok).toBe(true);
    expect(result.explicitEntityCount).toBe(3);
    expect(result.mappedExplicitEntityCount).toBe(3);
  });

  it("reports a missing entity without adding company-specific rules", () => {
    const question = "平安想调整架构，参考甲公司、乙公司、丙公司的多节点方案";
    const incomplete = parallelEntityTaskSpec(["甲公司", "丙公司"]);
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse(incomplete),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "explicit_entity_unmapped",
    }));
  });

  it("requires an independent required obligation for every explicit entity", () => {
    const question = "平安想调整架构，参考甲公司、乙公司、丙公司的多节点方案";
    const broad = parallelEntityTaskSpec(["甲公司", "乙公司", "丙公司"]);
    broad.deliverables[0]!.obligations = [{
      id: "O1",
      label: "三家公司多节点方案",
      targetEntityIds: ["E2", "E3", "E4"],
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
      required: true,
      sourceText: "甲公司、乙公司、丙公司",
    }];
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse(broad),
    });

    expect(result.ok).toBe(false);
    expect(result.mappedExplicitEntityCount).toBe(0);
    expect(result.issues.filter(
      (issue) => issue.code === "explicit_entity_without_required_obligation",
    )).toHaveLength(3);
  });

  it("does not treat customer support or an internal supporter as a product support fact", () => {
    const question = "如何获得客户支持并识别内部支持者？";
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "客户支持关系",
        entities: [{ id: "E1", label: "客户", role: "target", sourceText: "客户" }],
        deliverables: [{
          id: "D1",
          label: "获得支持并识别支持者",
          kind: "recommendation",
          required: true,
          sourceText: "如何获得客户支持并识别内部支持者",
          obligations: [{
            id: "O1",
            label: "获得客户支持并识别内部支持者",
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: "获得客户支持并识别内部支持者",
          }],
        }],
      }),
    });

    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
    expect(result.ok).toBe(true);
  });

  it("does not treat an interrogative customer-support relationship as a product fact", () => {
    const question = "是否有客户支持并识别内部支持者？";
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "客户支持关系",
        entities: [{ id: "E1", label: "客户", role: "target", sourceText: "客户" }],
        deliverables: [{
          id: "D1",
          label: question,
          kind: "recommendation",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: question,
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: question,
          }],
        }],
      }),
    });

    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
    expect(result.ok).toBe(true);
  });

  it("allows customer-input opportunity forecasts even when a percentage is mentioned", () => {
    const question = "当前机会赢率可能是50%，需要哪些客户信息才能判断？";
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "机会赢率判断",
        entities: [{ id: "E1", label: "当前机会", role: "target", sourceText: "当前机会" }],
        deliverables: [{
          id: "D1",
          label: "评估机会赢率",
          kind: "diagnosis",
          required: true,
          sourceText: "当前机会赢率可能是50%，需要哪些客户信息才能判断",
          obligations: [{
            id: "O1",
            label: "机会赢率50%的客户信息前提",
            targetEntityIds: ["E1"],
            evidencePolicy: "customer_input",
            domains: ["presales-general"],
            required: true,
            sourceText: "赢率可能是50%",
          }],
        }],
      }),
    });

    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["支持 IPv6 吗", "IPv6"],
    ["有没有双活能力", "双活能力"],
  ])("rejects synthesis for protected product facts: %s", (question, entityText) => {
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: entityText,
        entities: [{ id: "E1", label: entityText, role: "product", sourceText: entityText }],
        deliverables: [{
          id: "D1",
          label: question,
          kind: "fact",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: question,
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["coremail-professional"],
            required: true,
            sourceText: question,
          }],
        }],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

  it("does not let a customer-input forecast bypass a product version fact", () => {
    const question = "当前机会赢率50%，并确认产品版本";
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "当前机会",
        entities: [{ id: "E1", label: "当前机会", role: "target", sourceText: "当前机会" }],
        deliverables: [{
          id: "D1",
          label: question,
          kind: "diagnosis",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: question,
            targetEntityIds: ["E1"],
            evidencePolicy: "customer_input",
            domains: ["presales-general"],
            required: true,
            sourceText: question,
          }],
        }],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

  it("does not let a customer-support relationship suppress a version fact", () => {
    const question = "如何获得客户支持并确认产品版本";
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "产品版本",
        entities: [{ id: "E1", label: "产品", role: "product", sourceText: "产品" }],
        deliverables: [{
          id: "D1",
          label: question,
          kind: "fact",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: question,
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["coremail-professional"],
            required: true,
            sourceText: question,
          }],
        }],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

  it.each([
    ["产品具备哪些功能", "synthesis", "product", false],
    ["系统有什么能力", "synthesis", "product", false],
    ["支持哪些协议", "synthesis", "product", false],
    ["产品是否兼容目标环境", "synthesis", "product", false],
    ["产品适配哪些终端", "synthesis", "product", false],
    ["产品版本是什么", "synthesis", "product", false],
    ["版本信息是否最新", "synthesis", "target", false],
    ["目标环境兼容性如何", "synthesis", "target", false],
    ["机会赢率50%，并确认产品功能", "customer_input", "product", false],
    ["是否应该继续推进这个机会", "synthesis", "target", true],
    ["是否具备继续推进条件", "synthesis", "target", true],
    ["销售能力如何提升", "synthesis", "target", true],
    ["团队能力是否足够", "synthesis", "target", true],
    ["下一步行动建议是什么", "synthesis", "target", true],
    ["如何获得客户支持", "synthesis", "target", true],
  ] as const)(
    "classifies direct product facts without rejecting %s as a diagnostic request",
    (question, evidencePolicy, role, expectedOk) => {
      const result = guardSingleObligation(question, evidencePolicy, role);

      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it("does not let a trailing recommendation suppress an earlier product fact", () => {
    const question = "系统有哪些功能并给出提升建议";
    const result = guardSingleObligation(
      question,
      "synthesis",
      "unknown",
      "确认任务",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

  it.each([
    ["如何提升销售能力，并确认系统有哪些功能", "unknown", false],
    ["如何提升销售能力并确认系统有哪些功能", "unknown", false],
    ["系统有哪些功能并给出提升建议", "unknown", false],
    ["客户支持团队支持项目，并了解邮件系统现状", "product", true],
  ] as const)(
    "keeps contextual product evidence scoped to its own clause: %s",
    (question, role, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", role);
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["识别客户支持者并确认系统是否支持IPv6", "unknown", false],
    ["识别客户支持者并联系客户支持团队", "target", true],
    ["客户支持团队支持项目，邮件系统支持IPv6", "unknown", false],
  ] as const)(
    "keeps relationship support local while protecting product support: %s",
    (question, role, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", role);
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["列出全部接口", "unknown", false],
    ["列出产品全部接口", "product", false],
    ["列出所有协议", "unknown", false],
    ["提供全量版本", "unknown", false],
    ["给出产品功能完整列表", "product", false],
    ["列出所有客户案例", "unknown", false],
    ["列出全部部署方式", "unknown", false],
    ["提供全量产品清单", "unknown", false],
    ["给出全部建议", "target", true],
    ["完成所有行动", "target", true],
  ] as const)(
    "protects exhaustive facts without treating actions as facts: %s",
    (question, role, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", role);
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["如何提升售前服务能力", "target", true],
    ["客户服务团队有哪些能力需要提升", "target", true],
    ["邮件服务支持哪些协议", "unknown", false],
    ["客户服务系统具备哪些功能", "unknown", false],
    ["产品能力如何提升", "product", true],
    ["如何提升销售能力", "product", true],
  ] as const)(
    "distinguishes organizational service recommendations from product facts: %s",
    (question, role, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", role);
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it("finds separate explicit requests in a diagnosis and action question", () => {
    const signals = extractExplicitQuestionSignals(
      "目前客户在POC阶段，但销售获取不到客户侧的信息，我们的赢率如何，要怎样做才能提升赢率？",
    );
    expect(signals.requestClauses.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["请分别对比甲公司、乙公司、丙公司的多节点方案", ["甲公司", "乙公司", "丙公司"]],
    ["请分析甲公司 vs 乙公司的差异", ["甲公司", "乙公司"]],
    ["Coremail 与 Exchange 差异", ["Coremail", "Exchange"]],
    ["分别说明甲公司、乙公司各自的方案", ["甲公司", "乙公司"]],
  ])("finds common parallel entity syntax in %s", (value, expected) => {
    const entities = extractExplicitQuestionSignals(value).entityGroups
      .flatMap((group) => group.items);
    expect(entities).toEqual(expect.arrayContaining(expected));
  });

  it("detects a bare parallel list and rejects a broad multi-target obligation", () => {
    const question = "甲公司、乙公司各自采用什么方案";
    const signals = extractExplicitQuestionSignals(question);
    expect(signals.entityGroups.flatMap((group) => group.items)).toEqual(
      expect.arrayContaining(["甲公司", "乙公司"]),
    );
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: taskSpecSchema.parse({
        subject: "并列方案",
        entities: [
          { id: "E1", label: "甲公司", role: "reference", sourceText: "甲公司" },
          { id: "E2", label: "乙公司", role: "reference", sourceText: "乙公司" },
        ],
        deliverables: [{
          id: "D1",
          label: question,
          kind: "comparison",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: question,
            targetEntityIds: ["E1", "E2"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: question,
          }],
        }],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.mappedExplicitEntityCount).toBe(0);
    expect(result.issues.filter((issue) =>
      issue.code === "explicit_entity_without_required_obligation",
    )).toHaveLength(2);
  });

  it.each([
    ["甲公司、乙公司分别采用什么方案", ["甲公司", "乙公司"]],
    ["甲公司与乙公司各自采用什么方案", ["甲公司", "乙公司"]],
    ["甲公司、乙公司各自部署哪种产品", ["甲公司", "乙公司"]],
    ["甲公司、乙公司、丙公司逐一采用什么方案", ["甲公司", "乙公司", "丙公司"]],
    ["请分别说明甲公司、乙公司各自采用什么方案", ["甲公司", "乙公司"]],
    ["太和医院、甲公司分别采用什么方案", ["太和医院", "甲公司"]],
  ] as const)(
    "detects distributive parallel entities and fails closed for a broad obligation: %s",
    (question, expectedEntities) => {
      const extracted = extractExplicitQuestionSignals(question).entityGroups
        .flatMap((group) => group.items);
      expect(extracted).toEqual(expect.arrayContaining([...expectedEntities]));

      const result = guardBroadParallelObligation(question, expectedEntities);
      expect(result.ok).toBe(false);
      expect(result.mappedExplicitEntityCount).toBe(0);
      expect(result.issues.filter((issue) =>
        issue.code === "explicit_entity_without_required_obligation",
      )).toHaveLength(expectedEntities.length);
    },
  );

  it("does not infer parallel entities from an ordinary conjunction without a distributive marker", () => {
    const signals = extractExplicitQuestionSignals("客户和合作伙伴需要共同推进机会");
    expect(signals.entityGroups).toEqual([]);
  });

  it.each([
    ["请分析交付与售前协同问题", []],
    ["天地和科技、甲公司分别部署邮件系统", ["天地和科技", "甲公司"]],
    ["研发与创新中心、甲公司逐个核定预算", ["研发与创新中心", "甲公司"]],
    ["甲公司与乙公司各自采用什么方案", ["甲公司", "乙公司"]],
  ] as const)(
    "uses conjunction splitting only for confirmed distributive structures: %s",
    (question, expectedEntities) => {
      const entities = extractExplicitQuestionSignals(question).entityGroups
        .flatMap((group) => group.items);
      expect(entities).toEqual(expect.arrayContaining([...expectedEntities]));
      expect(entities).toHaveLength(expectedEntities.length);
    },
  );

  it("splits independent action verbs without treating their wording as fixed dimensions", () => {
    const signals = extractExplicitQuestionSignals(
      "请分析客户现状，并评估机会质量，同时给出提升建议，再制定下一步计划。",
    );
    expect(signals.requestClauses).toHaveLength(4);
    expect(signals.requestClauses.join(" ")).toMatch(/分析/u);
    expect(signals.requestClauses.join(" ")).toMatch(/评估/u);
    expect(signals.requestClauses.join(" ")).toMatch(/给出/u);
    expect(signals.requestClauses.join(" ")).toMatch(/制定/u);
  });
});

describe("ModelTaskCompiler", () => {
  it("uses resolved input and the bounded knowledge context", async () => {
    const taskSpec = taskSpecSchema.parse(parallelEntityTaskSpec());
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
      expect(input.schemaDescription).toBe("pse_task_spec");
      expect(input.messages[0]?.content).toBe(TASK_SPEC_SYSTEM_PROMPT);
      expect(input.messages[0]?.content).toContain("不得套用历史测试问题的固定维度");
      expect(input.messages[1]?.content).toContain('"standaloneQuestion"');
      expect(input.messages[1]?.content).toContain('"legacyPlan"');
      return input.schema.parse(taskSpec);
    });
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);
    const question = "平安想调整架构，参考工行、华为、比亚迪的多节点方案";

    await expect(compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      legacyPlan: plan,
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "客户案例与架构资料",
      },
    })).resolves.toEqual(taskSpec);
  });
});
