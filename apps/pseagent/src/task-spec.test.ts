import { describe, expect, it, vi } from "vitest";
import type { KnowledgePlan } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
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
  obligationSourceText = question,
  deliverableLabel = question,
  entityLabel = question,
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
      entities: [{ id: "E1", label: entityLabel, role, sourceText: question }],
      deliverables: [{
        id: "D1",
        label: deliverableLabel,
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
          sourceText: obligationSourceText,
        }],
      }],
    }),
  });
}

function guardIndependentParallelObligations(
  question: string,
  entities: readonly string[],
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
        obligations: entities.map((entity, index) => ({
          id: `O${index + 1}`,
          label: entity,
          targetEntityIds: [`E${index + 1}`],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: entity,
        })),
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
  it("normalizes bounded provider aliases without accepting unknown structure", () => {
    const parsed = taskSpecSchema.parse({
      subject: "当前项目判断与建议",
      entities: [{
        id: "E1",
        name: "当前项目",
        role: "subject",
        sourceText: "当前项目",
      }],
      deliverables: [{
        id: "D1",
        kind: "diagnosis",
        description: "判断当前项目",
        entities: ["E1"],
        obligations: [{
          id: "O1",
          description: "判断当前项目",
          evidencePolicy: "customer_input",
          domains: ["presales-general"],
          sourceText: "当前项目",
        }],
      }],
    });
    expect(parsed).toMatchObject({
      entities: [{ label: "当前项目" }],
      deliverables: [{
        label: "判断当前项目",
        required: true,
        sourceText: "当前项目",
        obligations: [{
          label: "判断当前项目",
          targetEntityIds: ["E1"],
          required: true,
        }],
      }],
    });
  });

  it("normalizes a provider task contract with name labels and omitted trace fields", () => {
    const sourceText = "目前客户在 POC 阶段，但销售获取不到客户侧的信息。在这种情况下我们的赢率如何";
    const parsed = taskSpecSchema.parse({
      subject: "POC 阶段赢率评估与提升",
      entities: [
        { id: "E1", name: "当前 POC 项目", role: "subject" },
        { id: "E2", name: "销售团队", role: "subject" },
      ],
      deliverables: [
        {
          id: "D1",
          kind: "diagnosis",
          name: "赢率评估",
          obligations: [{
            id: "O1",
            name: "评估当前赢率",
            evidencePolicy: "customer_input",
            domains: ["presales-general"],
            sourceText,
            evidenceCondition: {
              inputState: "missing",
              ambiguous: false,
              conflictDetected: false,
              freshness: "current",
            },
          }],
        },
        {
          id: "D2",
          kind: "recommendation",
          name: "提升赢率的措施",
          obligations: [{
            id: "O2",
            name: "提供提升赢率的方法",
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            sourceText: "要怎样做才能提升赢率？",
            evidenceCondition: {
              inputState: "not_applicable",
              ambiguous: false,
              conflictDetected: false,
              freshness: "current",
            },
          }],
        },
      ],
    });
    expect(parsed.entities).toEqual([
      expect.objectContaining({ label: "当前 POC 项目", sourceText }),
      expect.objectContaining({ label: "销售团队", sourceText }),
    ]);
    expect(parsed.deliverables).toEqual([
      expect.objectContaining({
        label: "赢率评估",
        required: true,
        sourceText,
        obligations: [expect.objectContaining({
          label: "评估当前赢率",
          targetEntityIds: [],
          required: true,
        })],
      }),
      expect.objectContaining({
        label: "提升赢率的措施",
        required: true,
        obligations: [expect.objectContaining({
          targetEntityIds: [],
          required: true,
        })],
      }),
    ]);
  });

  it("normalizes singular entity bindings and source-derived labels", () => {
    const sourceText = "目前客户在 POC 阶段，销售获取不到客户侧信息时应如何判断并推进";
    const parsed = taskSpecSchema.parse({
      subject: "POC",
      entities: [{ id: "E1", name: "POC", role: "subject" }],
      deliverables: [{
        id: "D1",
        kind: "procedure",
        title: "POC 推进方法",
        obligations: [{
          id: "O1",
          entity: "E1",
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          sourceText,
          evidenceCondition: {
            inputState: "not_applicable",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_specified",
          },
        }],
      }],
    });

    expect(parsed).toMatchObject({
      entities: [{ label: "POC", sourceText }],
      deliverables: [{
        label: "POC 推进方法",
        sourceText,
        required: true,
        obligations: [{
          label: sourceText,
          targetEntityIds: ["E1"],
          required: true,
          evidenceCondition: { freshness: "not_assessed" },
        }],
      }],
    });
  });

  it("rejects conflicting aliases and unrelated provider fields", () => {
    expect(taskSpecSchema.safeParse({
      subject: "冲突别名",
      entities: [{
        id: "E1",
        label: "甲",
        name: "乙",
        role: "subject",
        sourceText: "甲",
      }],
      deliverables: [],
    }).success).toBe(false);
  });

  it("binds an empty target only when one entity label matches the obligation", () => {
    const sourceText = "甲公司和乙公司的项目金额分别是多少？";
    const parsed = taskSpecSchema.parse({
      subject: "项目金额",
      entities: [
        { id: "E1", label: "甲公司", role: "target", sourceText },
        { id: "E2", label: "乙公司", role: "target", sourceText },
      ],
      deliverables: [
        {
          id: "D1",
          label: "甲公司项目金额",
          kind: "fact",
          required: true,
          sourceText,
          obligations: [{
            id: "O1",
            label: "查明甲公司项目金额",
            targetEntityIds: [],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText,
          }],
        },
        {
          id: "D2",
          label: "乙公司项目金额",
          kind: "fact",
          required: true,
          sourceText,
          obligations: [{
            id: "O2",
            label: "查明乙公司项目金额",
            targetEntityIds: [],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText,
          }],
        },
      ],
    });

    expect(parsed.deliverables.map((deliverable) =>
      deliverable.obligations[0]?.targetEntityIds)).toEqual([["E1"], ["E2"]]);
  });
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
  it("does not promote entities inherited only for a consolidation request", () => {
    const rawQuestion = "把前面的内容整理成一页式摘要。";
    const standaloneQuestion = "基于华为和比亚迪相关内容，整理成一页式摘要。";
    const taskSpec = taskSpecSchema.parse({
      subject: "一页式摘要",
      entities: [
        { id: "E1", label: "华为", role: "reference", sourceText: "华为" },
        { id: "E2", label: "比亚迪", role: "reference", sourceText: "比亚迪" },
      ],
      deliverables: [{
        id: "D1",
        label: "一页式摘要",
        kind: "recommendation",
        required: true,
        sourceText: "整理成一页式摘要",
        obligations: [{
          id: "O1",
          label: "整理摘要",
          targetEntityIds: [],
          evidencePolicy: "synthesis",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "整理成一页式摘要",
        }],
      }],
    });

    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion,
        standaloneQuestion,
        contextUsed: true,
        inheritedSubjects: ["华为", "比亚迪"],
        corrections: [],
      },
      taskSpec,
    });

    expect(result.explicitEntityCount).toBe(0);
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "explicit_entity_without_required_obligation",
    }));
  });

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

  it("normalizes customer-input evidence conditions conservatively", () => {
    const parsed = taskSpecSchema.parse({
      subject: "当前机会判断",
      entities: [{ id: "E1", label: "当前机会", role: "target", sourceText: "当前机会" }],
      deliverables: [{
        id: "D1",
        label: "判断赢率",
        kind: "diagnosis",
        required: true,
        sourceText: "当前机会赢率如何",
        obligations: [{
          id: "O1",
          label: "判断当前机会赢率",
          targetEntityIds: ["E1"],
          evidencePolicy: "customer_input",
          domains: ["presales-general"],
          required: true,
          sourceText: "当前机会赢率",
        }],
      }],
    });

    expect(parsed.deliverables[0]?.obligations[0]?.evidenceCondition).toEqual({
      inputState: "missing",
      ambiguous: false,
      conflictDetected: false,
      freshness: "not_assessed",
    });
  });

  it("rejects a non-customer-input obligation marked as missing customer input", () => {
    expect(() => taskSpecSchema.parse({
      subject: "产品能力",
      entities: [{ id: "E1", label: "产品", role: "product", sourceText: "产品" }],
      deliverables: [{
        id: "D1",
        label: "确认能力",
        kind: "fact",
        required: true,
        sourceText: "确认产品能力",
        obligations: [{
          id: "O1",
          label: "确认产品能力",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          evidenceCondition: {
            inputState: "missing",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_assessed",
          },
          domains: ["coremail-professional"],
          required: true,
          sourceText: "产品能力",
        }],
      }],
    })).toThrow();
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

  it.each([
    "产品报价对应赢率50%",
    "产品型号影响成交概率50%",
  ])("does not let a single-atom customer-input forecast bypass a mixed fact: %s", (sourceText) => {
    const result = guardSingleObligation(sourceText, "customer_input", "unknown");
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

  it.each([
    "赢率如何",
    "评估机会质量",
    "预测成交概率",
    "赢率可能是50%",
    "当前商机赢率可能是50%",
    "当前机会赢率可能是50%",
    "评估当前商机赢率",
    "判断当前机会赢率",
    "评估 当前 商机 赢率",
    "这个商机的赢率如何",
    "我们的赢率如何",
    "该项目的成交概率怎么样",
  ])("allows a pure opportunity forecast to use customer input: %s", (sourceText) => {
    const result = guardSingleObligation(sourceText, "customer_input", "unknown");
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
    expect(result.ok).toBe(true);
  });

  it.each([
    "产品版本对应赢率",
    "部署架构影响机会质量",
    "确认接口后预测成交概率",
    "赢率如何，并说明当前版本",
    "当前版本影响赢率如何",
    "赢率如何，同时核实当前版本",
    "评估当前商机赢率并确认产品版本",
    "评估 当前 商机 赢率 并确认当前版本",
    "这个商机的赢率与产品报价",
    "我们的赢率如何，同时核实报价",
  ])("rejects customer input when any independent fact is mixed in: %s", (sourceText) => {
    const result = guardSingleObligation(sourceText, "customer_input", "unknown");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
    expect(result.ok).toBe(false);
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

  it.each([
    ["评估团队条件并梳理系统功能", false],
    ["团队能力提升建议同时核查平台能力", false],
    ["提升团队能力", true],
    ["团队能力改进建议", true],
  ] as const)(
    "scopes organizational capability suppression to its own occurrence: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["所有并发规格", false],
    ["当前并发上限", false],
    ["确认系统并发能力", false],
    ["给出并行部署优化建议", true],
    ["提升系统功能并梳理系统功能边界", false],
    ["确认产品版本并改造部署方案", false],
    ["核实授权并制定优化建议", false],
    ["版本优化方案并升级建议", true],
  ] as const)(
    "treats single 并 as a boundary only when it introduces an independent request: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["确认产品版本并给出升级建议", false],
    ["给出升级建议并确认产品版本", false],
    ["核实授权模式同时提出优化方案", false],
    ["确认认证状态和改进建议", false],
    ["确认认证状态及改进建议", false],
    ["确认产品版本并评估团队条件", false],
    ["团队条件评估并确认产品版本", false],
    ["确认协议兼容性并给出优化建议", false],
    ["给出优化建议并核实容量", false],
    ["确认报价，评估团队条件", false],
    ["说明当前产品型号并给出建议", false],
    ["版本升级建议", true],
    ["所有版本升级建议", true],
    ["授权优化方案", true],
    ["团队能力提升建议", true],
    ["确认版本升级建议有哪些", true],
  ] as const)(
    "keeps independent attribute facts local when advice or organization text shares a source: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(
        question,
        "synthesis",
        "unknown",
        "团队提升建议",
        question,
        "产品优化方案",
        "客户推进",
      );
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["所有可升级版本", false],
    ["所有支持升级的版本", false],
    ["列出所有可升级版本", false],
    ["给出所有版本升级建议", true],
    ["完整迁移改造方案", true],
    ["全部接口优化行动", true],
    ["当前版本升级建议", true],
    ["当前可升级版本", false],
    ["给出改造方案并确认当前可升级版本", false],
    ["说明当前产品型号并给出版本升级建议", false],
    ["当前产品型号及版本升级建议", false],
    ["确认现有补丁级别并制定升级方案", false],
    ["列出所有加密算法并给出升级建议", false],
  ] as const)(
    "uses the quantified phrase head rather than any change word: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["客户支持团队支持S/MIME邮件加密吗", false],
    ["内部支持者支持双活吗", false],
    ["客户支持团队支持项目推进", true],
    ["内部支持者支持机会推进", true],
    ["内部支持者支持双活并支持项目推进", false],
    ["客户支持团队支持项目推进并支持高可用部署", false],
    ["技术团队支持项目部署吗", false],
    ["运维团队支持项目级高可用吗", false],
    ["技术团队支持机会管理模块吗", false],
    ["安全团队支持客户身份认证吗", false],
    ["客户支持团队支持项目化归档吗", false],
  ] as const)(
    "does not let a supporter noun consume a following technical support occurrence: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["提升系统功能并梳理系统功能边界", false],
    ["优化平台功能继而摸清系统功能边界", false],
    ["改造系统功能随后清点系统功能", false],
    ["提升系统功能同时调查系统功能边界", false],
    ["梳理系统功能边界并提升系统功能", false],
    ["优化系统功能，梳理系统功能边界", false],
    ["系统功能改造建议", true],
  ] as const)(
    "ends a change governor at strong parallel and temporal boundaries: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["技术团队支持高可用部署吗", false],
    ["售前团队支持客户推进", true],
    ["团队支持项目推进并确认是否支持量子安全算法", false],
    ["是否支持量子安全算法并由团队支持项目推进", false],
  ] as const)(
    "keeps only explicit organizational support local: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["盘点系统功能", false],
    ["提升系统功能", true],
    ["优化系统功能", true],
    ["改造系统功能", true],
    ["提升系统功能并盘点系统功能", false],
  ] as const)(
    "treats product attributes as facts unless directly governed by a change objective: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["列出所有加密算法", false],
    ["全部灾备模式", false],
    ["所有审计机制", false],
    ["完整迁移改造建议", true],
    ["给出所有版本升级建议", true],
    ["给出改进建议并说明当前产品型号", false],
    ["当前设备型号", false],
  ] as const)(
    "uses quantified and state-modified noun phrases without an object whitelist: %s",
    (question, expectedOk) => {
      const result = guardSingleObligation(question, "synthesis", "unknown");
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["如何提升销售能力", "产品版本和全部接口", "product", true],
    ["支持IPv6吗", "普通标签", "unknown", false],
    ["支持双活吗", "普通标签", "unknown", false],
    ["支持高可用部署吗", "普通标签", "unknown", false],
    ["支持项目推进", "普通标签", "unknown", false],
    ["团队支持项目推进", "普通标签", "unknown", true],
    ["系统有哪些功能", "普通标签", "target", false],
    ["团队有哪些能力需要提升", "普通标签", "target", true],
    ["销售能力现状", "普通标签", "target", false],
  ] as const)(
    "does not let entity role or label control fact protection: %s",
    (sourceText, entityLabel, role, expectedOk) => {
      const result = guardSingleObligation(
        sourceText,
        "synthesis",
        role,
        sourceText,
        sourceText,
        sourceText,
        entityLabel,
      );
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    ["系统有哪些功能", "如何提升销售能力", "给出销售建议", "product", false],
    ["识别客户支持者", "邮件系统支持现状", "确认产品支持", "target", true],
  ] as const)(
    "uses only obligation source text for protected-fact judgment: %s",
    (sourceText, obligationLabel, deliverableLabel, role, expectedOk) => {
      const result = guardSingleObligation(
        sourceText,
        "synthesis",
        role,
        obligationLabel,
        sourceText,
        deliverableLabel,
      );
      expect(result.ok).toBe(expectedOk);
      expect(result.issues.some((issue) =>
        issue.code === "protected_fact_not_direct",
      )).toBe(!expectedOk);
    },
  );

  it.each([
    "随后摸清系统功能现状并继而筹划销售建议",
    "继而筹划销售建议并随后摸清系统功能现状",
    "如何提升销售能力随后摸清系统有哪些功能",
    "系统有哪些功能继而筹划提升建议",
  ])("protects a local fact regardless of unlisted surrounding action wording: %s", (question) => {
    const result = guardSingleObligation(question, "synthesis", "unknown");
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "protected_fact_not_direct",
    }));
  });

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
    ["客户支持团队支持项目，并了解邮件系统现状", "product", false],
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
    ["系统有哪些功能及提出销售提升方案", "unknown", false],
    ["给出销售能力提升建议和系统功能现状", "unknown", false],
    ["确认系统功能如何提升销售能力", "unknown", false],
    ["如何优化销售能力和系统功能", "unknown", false],
  ] as const)(
    "uses local fact windows without action-name or connector-length boundaries: %s",
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
    ["给出所有部署优化建议", "unknown", true],
    ["制定全部接口改造建议", "unknown", true],
    ["列出所有部署方式", "unknown", false],
    ["全部接口", "unknown", false],
    ["所有客户案例", "unknown", false],
    ["全量产品清单", "unknown", false],
    ["列出所有部署方式，并给出优化建议", "unknown", false],
  ] as const)(
    "keeps exhaustive facts local instead of treating suggestion collections as facts: %s",
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

  it("uses anchored source text for conjunction-only distributive entities", () => {
    const question = "天地和科技与乙公司各自采用方案";
    const correct = guardIndependentParallelObligations(question, ["天地和科技", "乙公司"]);
    const omitted = guardIndependentParallelObligations(question, ["天地", "乙公司"]);
    const wrong = guardIndependentParallelObligations(question, ["天地", "和科技", "乙公司"]);

    expect(correct.ok).toBe(true);
    expect(correct.mappedExplicitEntityCount).toBe(2);
    expect(omitted.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
    expect(wrong.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
  });

  it("keeps source anchoring semantic and accepts legal conjunction-leading names", () => {
    expect(guardIndependentParallelObligations(
      "Coremail与Exchange各自采用方案",
      ["coremail", "Exchange"],
    ).ok).toBe(true);
    expect(guardIndependentParallelObligations(
      "和利时与乙公司各自采用方案",
      ["和利时", "乙公司"],
    ).ok).toBe(true);
  });

  it("requires anchors to cover both ends of a conjunction-only distributive list", () => {
    const question = "和利时与乙公司各自采用方案";
    const incomplete = guardIndependentParallelObligations(question, ["利时", "乙公司"]);
    const complete = guardIndependentParallelObligations(question, ["和利时", "乙公司"]);

    expect(incomplete.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
    expect(complete.ok).toBe(true);
  });

  it("accepts a shared noun phrase after fully anchored distributive entities", () => {
    const result = guardIndependentParallelObligations(
      "甲公司和乙公司的邮件项目合同金额分别是多少？",
      ["甲公司", "乙公司"],
    );

    expect(result.ok).toBe(true);
    expect(result.mappedExplicitEntityCount).toBe(2);
  });

  it("derives entity anchors when parallel labels repeat a shared descriptor", () => {
    const question = "甲公司和乙公司相关项目的具体金额分别是多少？";
    const taskSpec = taskSpecSchema.parse({
      subject: "项目金额",
      entities: [
        { id: "E1", label: "甲公司相关项目", role: "target", sourceText: question },
        { id: "E2", label: "乙公司相关项目", role: "target", sourceText: question },
      ],
      deliverables: [
        {
          id: "D1",
          label: "甲公司项目金额",
          kind: "fact",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O1",
            label: "查明甲公司项目金额",
            targetEntityIds: ["E1"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: question,
          }],
        },
        {
          id: "D2",
          label: "乙公司项目金额",
          kind: "fact",
          required: true,
          sourceText: question,
          obligations: [{
            id: "O2",
            label: "查明乙公司项目金额",
            targetEntityIds: ["E2"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: question,
          }],
        },
      ],
    });

    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec,
    });

    expect(result.ok).toBe(true);
    expect(result.mappedExplicitEntityCount).toBe(2);
  });

  it("preserves conjunctions inside strongly separated anchored entity names", () => {
    const result = guardIndependentParallelObligations(
      "研发与创新中心、甲公司分别采用方案",
      ["研发与创新中心", "甲公司"],
    );
    expect(result.ok).toBe(true);
    expect(result.mappedExplicitEntityCount).toBe(2);
  });

  it.each([
    ["和利时、乙公司各自采用方案", ["利时", "乙公司"]],
    ["甲公司、乙公司分别采用方案", ["公司", "乙公司"]],
    ["甲公司、乙公司分别采用方案", ["甲公司", "乙公"]],
  ] as const)(
    "fails closed for partial anchors in strongly separated distributive lists: %s",
    (question, entities) => {
      const result = guardIndependentParallelObligations(question, entities);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "distributive_entity_group_unresolved",
      }));
    },
  );

  it("fails closed when a strongly separated distributive list cannot form two entities", () => {
    const result = guardIndependentParallelObligations(
      "甲公司、方案各自采用方案",
      ["甲公司", "方案"],
    );
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
  });

  it("fails closed for duplicate, ambiguous, or only-wide anchored entity sources", () => {
    const question = "天地和科技与乙公司各自采用方案";
    const duplicate = guardIndependentParallelObligations(question, ["天地和科技", "乙公司", "乙公司"]);
    const wideOnly = guardIndependentParallelObligations(question, ["天地和科技与乙公司"]);
    const longestWins = guardIndependentParallelObligations(question, ["天地", "天地和科技", "乙公司"]);

    expect(duplicate.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
    expect(wideOnly.issues).toContainEqual(expect.objectContaining({
      code: "distributive_entity_group_unresolved",
    }));
    expect(longestWins.ok).toBe(true);
    expect(longestWins.mappedExplicitEntityCount).toBe(2);
  });

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

  it("recognizes colloquial how-to and what-to-check requests", () => {
    const signals = extractExplicitQuestionSignals(
      "我们只知道客户口头说有兴趣，领导却要我今天报 80% 赢率；我该怎么汇报，接下来核验什么？",
    );

    expect(signals.requestClauses).toEqual([
      "我该怎么汇报",
      "接下来核验什么",
    ]);
  });

  it("does not duplicate direct comparison dimensions as colloquial requests", () => {
    const signals = extractExplicitQuestionSignals(
      "找一下 AIHUB 和 Coremail AI系统的功能区别：两者分别解决什么问题，主要功能、部署依赖和适用场景怎么对比？",
    );

    expect(signals.requestClauses).toEqual([]);
  });

  it("keeps timing requests and removes a duplicated parallel parent clause", () => {
    const signals = extractExplicitQuestionSignals(
      "Coremail 归档检索异常时，什么时候可以重建索引，执行前后需要哪些检查和风险控制？",
    );

    expect(signals.requestClauses).toEqual([
      "哪些检查",
      "风险控制",
      "什么时候可以重建索引",
    ]);
    expect(signals.requiredParallelGroups).toEqual([{
      sourceText: "执行前后需要哪些检查和风险控制",
      items: ["哪些检查", "风险控制"],
    }]);
  });

  it("keeps every ordered checklist dimension as an independent obligation", () => {
    const question = "请给出客户信息清单，按决策、预算、竞争、技术和时间排序。";
    const signals = extractExplicitQuestionSignals(question);
    expect(signals.independentRequestClauses).toEqual([
      "决策",
      "预算",
      "竞争",
      "技术",
      "时间",
    ]);
    const broad = taskSpecSchema.parse({
      subject: "客户信息清单",
      entities: [{
        id: "E1",
        label: "客户信息清单",
        role: "subject",
        sourceText: "客户信息清单",
      }],
      deliverables: [{
        id: "D1",
        label: "按要求整理清单",
        kind: "recommendation",
        required: true,
        sourceText: "按决策、预算、竞争、技术和时间排序",
        obligations: [{
          id: "O1",
          label: "整理全部维度",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["presales-general"],
          required: true,
          sourceText: "按决策、预算、竞争、技术和时间排序",
        }],
      }],
    });
    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: broad,
    });
    expect(result.ok).toBe(false);
    expect(result.mappedExplicitRequestCount).toBe(1);
    expect(result.issues.filter((issue) =>
      issue.code === "explicit_request_unmapped")).toHaveLength(
        result.explicitRequestCount - result.mappedExplicitRequestCount,
      );
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

  it("does not treat named sections of a previous comparison as parallel entities", () => {
    const signals = extractExplicitQuestionSignals(
      "只看刚才对比中的安全和信创两部分，给出可核验的能力、限制和 POC 验证项。",
    );
    expect(signals.entityGroups).toEqual([]);
    expect(signals.unresolvedDistributiveGroups).toEqual([]);
  });

  it("extracts entities after a distributive search verb without treating the prefix as a list", () => {
    const signals = extractExplicitQuestionSignals(
      "某客户准备调整架构，请分别检索甲公司、乙公司、丙公司的实践，并说明可借鉴边界。",
    );
    expect(signals.entityGroups).toContainEqual({
      sourceText: "甲公司、乙公司、丙公司",
      items: ["甲公司", "乙公司", "丙公司"],
    });
    expect(signals.unresolvedDistributiveGroups).toEqual([]);
    expect(signals.requestClauses).toContain(
      "请分别检索甲公司、乙公司、丙公司的实践",
    );
  });

  it("keeps every explicitly required parallel aspect as an independent obligation", () => {
    const question =
      "集团共用一套 Coremail，但各子公司要独立域名、用户别名和管理员权限，方案设计与验收边界是什么？";
    const signals = extractExplicitQuestionSignals(question);
    expect(signals.independentRequestClauses).toEqual([
      "独立域名",
      "用户别名",
      "管理员权限",
    ]);
    expect(signals.requiredParallelGroups).toEqual([{
      sourceText: "但各子公司要独立域名、用户别名和管理员权限",
      items: ["独立域名", "用户别名", "管理员权限"],
    }]);

    const result = guardSingleObligation(question, "direct");
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) =>
      issue.code === "explicit_request_unmapped")).toHaveLength(2);
  });

  it.each([
    ["项目需要评估容量、制定方案和说明回退边界", ["评估容量", "制定方案", "说明回退边界"]],
    ["客户主要关注价格、交付和服务，应该怎么回应？", []],
    ["客户和合作伙伴需要共同推进机会", []],
    ["不需要迁移历史邮件、通讯录和日程", []],
  ] as const)(
    "only treats affirmative governed lists as required parallel aspects: %s",
    (question, expected) => {
      expect(extractExplicitQuestionSignals(question).independentRequestClauses)
        .toEqual([...expected]);
    },
  );

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
  it("falls back when a model drops explicitly required parallel aspects", async () => {
    const question =
      "集团共用一套 Coremail，但各子公司要独立域名、用户别名和管理员权限，方案设计与验收边界是什么？";
    const incompleteTaskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{
        id: "E1",
        label: "集团 Coremail 方案",
        role: "product",
        sourceText: "集团共用一套 Coremail",
      }],
      deliverables: [{
        id: "D1",
        label: "集团 Coremail 方案设计与验收",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "设计并验收集团 Coremail 方案",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const completeJson = vi.fn(async () => incompleteTaskSpec as never);
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "多组织、多域名、别名和管理员权限资料",
      },
    });

    const sources = result.deliverables.flatMap((deliverable) =>
      deliverable.obligations.map((obligation) => obligation.sourceText));
    expect(sources).toEqual([
      "独立域名",
      "用户别名",
      "管理员权限",
      "方案设计与验收边界是什么",
    ]);
    expect(new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: result,
    }).ok).toBe(true);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to a bounded deterministic contract after repeated invalid model payloads", async () => {
    const question = "对比 Exchange 与 Coremail，请覆盖部署与迁移、国产化适配、安全、运维和服务、成本边界，并明确哪些结论需要结合客户现状确认。";
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError("invalid_schema:task_spec");
    });
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "产品、架构与服务资料",
      },
    });

    const obligations = result.deliverables.flatMap((item) => item.obligations);
    expect(obligations).toHaveLength(6);
    expect(obligations.map((item) => item.sourceText).join(" ")).toMatch(/部署与迁移/u);
    expect(obligations.map((item) => item.sourceText).join(" ")).toMatch(/国产化适配/u);
    expect(obligations.map((item) => item.sourceText).join(" ")).toMatch(/安全/u);
    expect(obligations.map((item) => item.sourceText).join(" ")).toMatch(/运维和服务/u);
    expect(obligations.map((item) => item.sourceText).join(" ")).toMatch(/成本边界/u);
    expect(new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec: result,
    }).ok).toBe(true);
    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it("keeps case input and knowledge method separate in a numeric forecast fallback", async () => {
    const question = "销售坚持让我先报一个百分比给领导，我应该报多少？";
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_schema:task_spec");
      }),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: true,
        inheritedSubjects: ["当前 POC 商机赢率"],
        corrections: [],
      },
      scopeHint: "general",
      knowledgeContext: {
        purpose: "售前知识边界",
        schema: "知识结构",
        planningOverview: "机会判断与客户证据",
      },
    });

    const obligations = result.deliverables.flatMap((deliverable) =>
      deliverable.obligations);
    expect(obligations.map((obligation) => obligation.evidencePolicy)).toEqual(
      expect.arrayContaining(["direct", "customer_input"]),
    );
    expect(new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: true,
        inheritedSubjects: ["当前 POC 商机赢率"],
        corrections: [],
      },
      taskSpec: result,
    }).ok).toBe(true);
  });

  it("routes a product-context commercial assessment fallback to presales knowledge", async () => {
    const question = "已知客户现网是 Exchange、约 1.5 万用户、计划 Q4 采购、预算未批、竞争对手已进场，请重新评估项目并给出下一步。";
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_schema:task_spec");
      }),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "企业售前知识边界",
        schema: "知识结构",
        planningOverview: "产品和商机资料",
      },
    });

    expect(result.deliverables[0]?.obligations[0]).toMatchObject({
      evidencePolicy: "synthesis",
      domains: ["presales-general"],
      sourceText: "请重新评估项目并给出下一步",
      targetEntityIds: ["E1"],
    });
  });

  it("keeps a structured technical capability fallback in professional knowledge", async () => {
    const question = "客户提出 DLP 要扫描正文附件并支持 OCR、移动端审核，售前该如何核验而不是直接承诺？";
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_schema:task_spec");
      }),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "产品安全、内容扫描和集成资料",
      },
    });

    expect(result.deliverables.flatMap((deliverable) =>
      deliverable.obligations).every((obligation) =>
        obligation.domains.includes("coremail-professional"))).toBe(true);
  });

  it("repairs direct product facts in a contextual follow-up to professional knowledge", async () => {
    const question = "只看刚才对比 Exchange 与 Coremail 中的安全和信创两部分，给出可核验的能力、限制和 POC 验证项。";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "安全与信创验证",
      entities: [{
        id: "E1",
        label: "安全和信创两部分",
        role: "subject",
        sourceText: "安全和信创两部分",
      }],
      deliverables: [{
        id: "D1",
        label: "可核验能力、限制和 POC 验证项",
        kind: "comparison",
        required: true,
        sourceText: "给出可核验的能力、限制和 POC 验证项",
        obligations: [{
          id: "O1",
          label: "可核验能力、限制和 POC 验证项",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["presales-general"],
          required: true,
          sourceText: "给出可核验的能力、限制和 POC 验证项",
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: "只看刚才对比中的安全和信创两部分，给出可核验的能力、限制和 POC 验证项。",
        standaloneQuestion: "只看刚才对比中的安全和信创两部分，给出可核验的能力、限制和 POC 验证项。",
        contextUsed: true,
        inheritedSubjects: ["Exchange 与 Coremail 对比"],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "产品安全和信创资料",
      },
    });

    expect(result.deliverables.flatMap((deliverable) =>
      deliverable.obligations).every((obligation) =>
        obligation.evidencePolicy !== "direct" ||
        obligation.domains.includes("coremail-professional"))).toBe(true);
  });

  it("keeps product-selection synthesis in the routed professional domain", async () => {
    const question = "客户要做第三方系统集成，三种接口方案应如何选？";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "第三方系统集成接口选型",
      entities: [{ id: "E1", label: "接口方案", role: "product", sourceText: "三种接口方案" }],
      deliverables: [{
        id: "D1",
        label: "给出接口方案选择建议",
        kind: "recommendation",
        required: true,
        sourceText: "三种接口方案应如何选",
        obligations: [{
          id: "O1",
          label: "根据开发主体和能力边界选择接口方案",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "三种接口方案应如何选",
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "产品接口与集成资料",
      },
    });

    expect(result.deliverables[0]?.obligations[0]?.domains)
      .toEqual(["coremail-professional"]);
  });

  it("keeps structured technical capability verification in professional knowledge", async () => {
    const question = "客户提出 DLP 要扫描正文附件并支持 OCR、移动端审核，售前该如何核验而不是直接承诺？";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "DLP 能力核验",
      entities: [{ id: "E1", label: "DLP", role: "product", sourceText: "DLP" }],
      deliverables: [{
        id: "D1",
        label: "核验 DLP 扫描和审核能力",
        kind: "procedure",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "核验扫描范围、高级能力和移动端集成",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "产品安全、内容扫描和集成资料",
      },
    });

    expect(result.deliverables[0]?.obligations[0]?.domains)
      .toEqual(["coremail-professional"]);
  });

  it("keeps a customer premise plus actor-prefixed procedure in synthesis", async () => {
    const question = "客户在 POC 中不断要求免费增加非标项，售前应该怎样控制范围又不伤害关系？";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "POC 范围与客户关系",
      entities: [{ id: "E1", label: "客户", role: "subject", sourceText: "客户" }],
      deliverables: [{
        id: "D1",
        label: "控制范围又不伤害关系",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "控制范围又不伤害关系",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "general",
      knowledgeContext: {
        purpose: "售前知识边界",
        schema: "知识结构",
        planningOverview: "范围控制与客户沟通",
      },
    });

    expect(result.deliverables[0]?.obligations[0]?.evidencePolicy).toBe("synthesis");
  });

  it("derives explicit conflict state without client-specific rules", async () => {
    const question = "两份正式资料结论冲突时，应该怎样设计分批切换？";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: "正式资料", role: "subject", sourceText: "正式资料" }],
      deliverables: [{
        id: "D1",
        label: "设计分批切换",
        kind: "procedure",
        required: true,
        sourceText: "怎样设计分批切换",
        obligations: [{
          id: "O1",
          label: "设计分批切换",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "怎样设计分批切换",
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "迁移与升级资料",
      },
    });

    const obligations = result.deliverables.flatMap((item) => item.obligations);
    expect(obligations[0]?.evidenceCondition).toMatchObject({ conflictDetected: true });
    expect(obligations).toHaveLength(1);
  });

  it("uses resolved input and the bounded knowledge context", async () => {
    const taskSpec = taskSpecSchema.parse(parallelEntityTaskSpec());
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
      expect(input.schemaDescription).toBe("pse_task_spec");
      expect(input.messages[0]?.content).toContain(TASK_SPEC_SYSTEM_PROMPT);
      expect(input.messages[0]?.content).toContain("每个 obligation 必须输出 evidenceCondition");
      expect(input.messages[0]?.content).toContain("必须拆成互不替代的 customer_input 与 synthesis obligations");
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

  it("repairs a missing current-case forecast without merging the method advice", async () => {
    const question = "目前客户信息不足。在这种情况下我们的赢率如何，要怎样做才能提升赢率？";
    const synthesisOnly = taskSpecSchema.parse({
      subject: "当前项目赢率",
      entities: [{ id: "E1", label: "当前项目", role: "target", sourceText: "客户" }],
      deliverables: [{
        id: "D1",
        label: "提升赢率建议",
        kind: "recommendation",
        required: true,
        sourceText: "怎样做才能提升赢率",
        obligations: [{
          id: "O1",
          label: "提升赢率方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "怎样做才能提升赢率",
        }],
      }],
    });
    const repaired = taskSpecSchema.parse({
      subject: "当前项目赢率",
      entities: [{ id: "E1", label: "当前项目", role: "target", sourceText: "客户" }],
      deliverables: [
        {
          id: "D1",
          label: "当前赢率判断",
          kind: "diagnosis",
          required: true,
          sourceText: "在这种情况下我们的赢率如何",
          obligations: [{
            id: "O1",
            label: "判断当前赢率",
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
            sourceText: "在这种情况下我们的赢率如何",
          }],
        },
        {
          id: "D2",
          label: "提升赢率建议",
          kind: "recommendation",
          required: true,
          sourceText: "怎样做才能提升赢率",
          obligations: [{
            id: "O2",
            label: "提升赢率方法",
            targetEntityIds: ["E1"],
            evidencePolicy: "synthesis",
            domains: ["presales-general"],
            required: true,
            sourceText: "怎样做才能提升赢率",
          }],
        },
      ],
    });
    const completeJson = vi
      .fn<NonNullable<ModelClient["completeJson"]>>()
      .mockResolvedValueOnce(synthesisOnly)
      .mockImplementationOnce(async (input) => {
        expect(input.messages.at(-1)?.content).toContain("当前个案预测义务");
        expect(input.messages.at(-1)?.content).toContain("不能互相替代");
        return repaired as never;
      });
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      scopeHint: "general",
      legacyPlan: plan,
      knowledgeContext: {
        purpose: "售前知识边界",
        schema: "知识结构",
        planningOverview: "机会判断与推进方法",
      },
    })).resolves.toEqual(repaired);
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("repairs a numeric opportunity forecast follow-up into a missing customer input", async () => {
    const question = "销售坚持让我先报一个百分比给领导，我应该报多少？";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "向领导汇报比例",
      entities: [{
        id: "E1",
        label: "领导汇报",
        role: "target",
        sourceText: "给领导",
      }],
      deliverables: [{
        id: "D1",
        label: "向领导汇报比例",
        kind: "diagnosis",
        required: true,
        sourceText: "我应该报多少",
        obligations: [{
          id: "O1",
          label: "判断应汇报的比例",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "我应该报多少",
        }],
      }],
    });
    const completeJson = vi.fn(async () => modelTaskSpec as never);
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: true,
        inheritedSubjects: ["当前 POC 商机赢率"],
        corrections: [],
      },
      scopeHint: "general",
      legacyPlan: plan,
      knowledgeContext: {
        purpose: "售前知识边界",
        schema: "知识结构",
        planningOverview: "机会判断与客户证据",
      },
    });

    const obligations = result.deliverables.flatMap((deliverable) =>
      deliverable.obligations);
    expect(obligations).toContainEqual(expect.objectContaining({
      evidencePolicy: "customer_input",
      evidenceCondition: expect.objectContaining({ inputState: "missing" }),
    }));
    expect(obligations.some((obligation) =>
      obligation.evidencePolicy !== "customer_input")).toBe(true);
    const guard = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: true,
        inheritedSubjects: ["当前 POC 商机赢率"],
        corrections: [],
      },
      taskSpec: result,
    });
    expect(guard).toMatchObject({ ok: true, issues: [] });
    expect(completeJson).toHaveBeenCalledTimes(1);
  });

  it("repairs protected factual obligations to direct evidence without regenerating the task", async () => {
    const question = "请对比两套方案，并明确哪些结论需要结合客户现状确认。";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "企业方案对比",
      entities: [{
        id: "E1",
        label: "两套方案",
        role: "subject",
        sourceText: "两套方案",
      }],
      deliverables: [{
        id: "D1",
        label: "待客户确认的结论",
        kind: "comparison",
        required: true,
        sourceText: "明确哪些结论需要结合客户现状确认",
        obligations: [{
          id: "O1",
          label: "列出待确认结论",
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
          sourceText: "明确哪些结论需要结合客户现状确认",
        }],
      }],
    });
    const completeJson = vi.fn(async () => modelTaskSpec as never);
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
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
        planningOverview: "企业方案",
      },
    });

    expect(result.deliverables[0]?.obligations[0]).toMatchObject({
      evidencePolicy: "direct",
      evidenceCondition: { inputState: "not_applicable" },
    });
    expect(completeJson).toHaveBeenCalledTimes(1);
  });

  it("anchors provider-paraphrased source fields to the resolved question", async () => {
    const question = "请给出可核验的能力、限制和 POC 验证项。";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "能力验证",
      entities: [{
        id: "E1",
        label: "能力验证",
        role: "subject",
        sourceText: "针对目标能力开展验证",
      }],
      deliverables: [{
        id: "D1",
        label: "可核验能力与限制",
        kind: "fact",
        required: true,
        sourceText: "输出可验证的产品能力边界",
        obligations: [{
          id: "O1",
          label: "列出能力限制与验证项",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "梳理产品限制并设计验证步骤",
        }],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
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
        planningOverview: "能力资料",
      },
    });

    expect(result.entities[0]?.sourceText).toContain("给出可核验的能力");
    expect(result.deliverables[0]?.sourceText).toContain("给出可核验的能力");
    expect(result.deliverables[0]?.obligations[0]?.sourceText)
      .toContain("给出可核验的能力");
  });

  it("compacts a routed comparison dimension across both targets", async () => {
    const question = "对比产品甲与产品乙，请覆盖部署边界。";
    const modelTaskSpec = taskSpecSchema.parse({
      subject: "产品部署比较",
      entities: [
        { id: "E1", label: "产品甲", role: "product", sourceText: "产品甲" },
        { id: "E2", label: "产品乙", role: "product", sourceText: "产品乙" },
      ],
      deliverables: [{
        id: "D1",
        label: "部署边界比较",
        kind: "comparison",
        required: true,
        sourceText: "覆盖部署边界",
        obligations: [
          {
            id: "O1",
            label: "产品甲部署边界",
            targetEntityIds: ["E1"],
            evidencePolicy: "direct",
            domains: ["coremail-professional"],
            required: true,
            sourceText: "部署边界",
          },
          {
            id: "O2",
            label: "产品乙部署边界",
            targetEntityIds: ["E2"],
            evidencePolicy: "direct",
            domains: ["presales-general"],
            required: true,
            sourceText: "部署边界",
          },
        ],
      }],
    });
    const compiler = new ModelTaskCompiler({
      completeJson: vi.fn(async () => modelTaskSpec as never),
      completeText: vi.fn(),
    } as unknown as ModelClient);

    const result = await compiler.compile({
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
        purpose: "产品事实",
        schema: "产品结构",
        planningOverview: "产品比较资料",
      },
    });

    expect(result.deliverables[0]?.obligations).toEqual([
      expect.objectContaining({
        id: "O1",
        label: "部署边界比较",
        targetEntityIds: ["E1", "E2"],
        domains: ["coremail-professional"],
        sourceText: "覆盖部署边界",
      }),
    ]);
  });

  it("repairs an over-expanded consolidation task without fixed summary dimensions", async () => {
    const question = "把前面的内容整理成一页式摘要：讲优势、边界、风险和下一步。";
    const expanded = taskSpecSchema.parse({
      subject: "一页式摘要",
      entities: [{ id: "E1", label: "摘要", role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: "一页式摘要",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: Array.from({ length: 7 }, (_, index) => ({
          id: `O${index + 1}`,
          label: `上下文材料${index + 1}`,
          targetEntityIds: [],
          evidencePolicy: "synthesis",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        })),
      }],
    });
    const repaired = taskSpecSchema.parse({
      subject: "一页式摘要",
      entities: [{ id: "E1", label: "摘要", role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: "一页式摘要",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: ["优势", "边界", "风险", "下一步"].map((sourceText, index) => ({
          id: `O${index + 1}`,
          label: sourceText,
          targetEntityIds: [],
          evidencePolicy: "synthesis",
          domains: ["coremail-professional"],
          required: true,
          sourceText,
        })),
      }],
    });
    const completeJson = vi.fn()
      .mockResolvedValueOnce(expanded)
      .mockImplementationOnce(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
        expect(input.messages.at(-1)?.content).toContain("过度拆分");
        expect(input.messages.at(-1)?.content).toContain("不得超过 6");
        return repaired as never;
      });
    const compiler = new ModelTaskCompiler({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(compiler.compile({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: true,
        inheritedSubjects: ["前面的内容"],
        corrections: [],
      },
      scopeHint: "professional",
      knowledgeContext: {
        purpose: "专业知识边界",
        schema: "知识结构",
        planningOverview: "历史对话材料",
      },
    })).resolves.toEqual(repaired);
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("guard rejects a model that silently maps a current-case forecast to advice", () => {
    const question = "在这种情况下我们的赢率如何，要怎样做才能提升赢率？";
    const taskSpec = taskSpecSchema.parse({
      subject: "提升赢率",
      entities: [{ id: "E1", label: "当前项目", role: "target", sourceText: "我们" }],
      deliverables: [{
        id: "D1",
        label: "提升赢率建议",
        kind: "recommendation",
        required: true,
        sourceText: "怎样做才能提升赢率",
        obligations: [{
          id: "O1",
          label: "提升赢率方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "怎样做才能提升赢率",
        }],
      }],
    });

    const result = new DeterministicTaskSpecGuard().validate({
      resolvedQuestion: {
        rawQuestion: question,
        standaloneQuestion: question,
        contextUsed: false,
        inheritedSubjects: [],
        corrections: [],
      },
      taskSpec,
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "customer_input_request_unmapped",
    }));
  });
});
