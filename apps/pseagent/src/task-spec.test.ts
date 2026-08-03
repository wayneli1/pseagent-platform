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

  it("finds separate explicit requests in a diagnosis and action question", () => {
    const signals = extractExplicitQuestionSignals(
      "目前客户在POC阶段，但销售获取不到客户侧的信息，我们的赢率如何，要怎样做才能提升赢率？",
    );
    expect(signals.requestClauses.length).toBeGreaterThanOrEqual(2);
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

