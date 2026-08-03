import { describe, expect, it, vi } from "vitest";
import type { KnowledgePlan } from "./contracts.js";
import {
  DefaultTaskAnalysisShadow,
  type QuestionResolver,
  type TaskCompiler,
  type TaskSpecGuard,
} from "./task-analysis-shadow.js";
import { taskSpecSchema } from "./task-spec.js";

const plan: KnowledgePlan = {
  subject: "Coremail",
  requirements: [{
    id: "R1",
    question: "部署方式",
    evidenceMode: "direct_only",
    evidenceAspects: [{ id: "A1", label: "部署", terms: ["部署"] }],
    queries: [{ text: "Coremail 部署方式", aspectIds: ["A1"] }],
  }],
};

describe("DefaultTaskAnalysisShadow", () => {
  it("runs resolver, compiler and guard in order without mutating the legacy plan", async () => {
    const calls: string[] = [];
    const resolvedQuestion = {
      rawQuestion: "还有华为呢？",
      standaloneQuestion: "华为有哪些多节点方案？",
      contextUsed: true,
      inheritedSubjects: ["多节点方案"],
      corrections: [],
    } as const;
    const taskSpec = taskSpecSchema.parse({
      subject: "华为多节点方案",
      entities: [{ id: "E1", label: "华为", role: "reference", sourceText: "华为" }],
      deliverables: [{
        id: "D1",
        label: "华为多节点方案",
        kind: "fact",
        required: true,
        sourceText: "华为有哪些多节点方案",
        obligations: [{
          id: "O1",
          label: "华为多节点方案",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "华为",
        }],
      }],
    });
    const guardResult = {
      ok: true,
      issues: [],
      explicitEntityCount: 1,
      mappedExplicitEntityCount: 1,
      explicitRequestCount: 1,
      mappedExplicitRequestCount: 1,
    } as const;
    const resolver = {
      resolve: vi.fn(async () => {
        calls.push("resolver");
        return resolvedQuestion;
      }),
    } satisfies QuestionResolver;
    const compiler = {
      compile: vi.fn(async () => {
        calls.push("compiler");
        return taskSpec;
      }),
    } satisfies TaskCompiler;
    const guard = {
      validate: vi.fn(() => {
        calls.push("guard");
        return guardResult;
      }),
    } satisfies TaskSpecGuard;
    const legacyBefore = structuredClone(plan);
    const analyzer = new DefaultTaskAnalysisShadow(resolver, compiler, guard);

    await expect(analyzer.analyze({
      question: "还有华为呢？",
      conversationContext: "用户：比较客户多节点方案",
      scope: "professional",
      legacyPlan: plan,
      knowledgeContext: {
        purpose: "专业知识",
        schema: "schema",
        planningOverview: "overview",
      },
    })).resolves.toMatchObject({ resolvedQuestion, taskSpec, guard: guardResult });
    expect(calls).toEqual(["resolver", "compiler", "guard"]);
    expect(plan).toEqual(legacyBefore);
  });
});
