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
