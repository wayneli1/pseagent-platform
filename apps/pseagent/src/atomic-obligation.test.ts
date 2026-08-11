import { describe, expect, it } from "vitest";
import { identityResolvedQuestion } from "./question-resolver.js";
import { taskSpecSchema } from "./task-spec.js";
import {
  compileAtomicObligationContract,
  materializeGuardedTaskSpec,
  validateAtomicObligationContract,
  type AtomicObligationContract,
} from "./atomic-obligation.js";

describe("atomic obligation contract", () => {
  it("restores a source-backed case judgement omitted by the model task spec", () => {
    const question = "说明如何评估当前商机，并判断这个项目现在是否值得推进。";
    const taskSpec = taskSpecSchema.parse({
      subject: "当前商机评估",
      entities: [{
        id: "E1",
        label: "当前商机",
        role: "subject",
        sourceText: "当前商机",
      }],
      deliverables: [{
        id: "D1",
        label: "评估当前商机的方法",
        kind: "procedure",
        required: true,
        sourceText: "说明如何评估当前商机",
        obligations: [{
          id: "O1",
          label: "评估当前商机的方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "说明如何评估当前商机",
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations.map((item) => item.kind)).toEqual([
      "procedure",
      "case_judgement",
    ]);
    expect(contract.obligations.map((item) => item.evidencePolicy)).toEqual([
      "synthesis",
      "customer_input",
    ]);
    expect(contract.obligations.every((item) =>
      question.slice(item.sourceSpan.start, item.sourceSpan.end) === item.sourceText
    )).toBe(true);
    expect(validateAtomicObligationContract(contract)).toEqual({
      ok: true,
      issueCodes: [],
    });
  });

  it("classifies independent technical and governance obligations into different domains", () => {
    const question = "请说明 Coremail 归档能力，并给出 POC 验收流程。";
    const taskSpec = taskSpecSchema.parse({
      subject: "Coremail 归档 POC",
      entities: [{
        id: "E1",
        label: "Coremail",
        role: "product",
        sourceText: "Coremail",
      }],
      deliverables: [{
        id: "D1",
        label: "Coremail 归档能力",
        kind: "fact",
        required: true,
        sourceText: "请说明 Coremail 归档能力",
        obligations: [{
          id: "O1",
          label: "Coremail 归档能力",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "请说明 Coremail 归档能力",
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations.map((item) => item.domains)).toEqual([
      ["coremail-professional"],
      ["presales-general"],
    ]);
    expect(contract.obligations.map((item) => item.evidenceTypes)).toEqual([
      ["formal_page"],
      ["method"],
    ]);
  });

  it("reports overlapping and untraceable source spans", () => {
    const contract: AtomicObligationContract = {
      subject: "测试",
      sourceQuestion: "先核验版本，再说明流程。",
      obligations: [
        obligation({ id: "O1", start: 0, end: 5, sourceText: "先核验版本" }),
        obligation({ id: "O2", start: 4, end: 10, sourceText: "错误原文" }),
      ],
    };

    const validation = validateAtomicObligationContract(contract);

    expect(validation.ok).toBe(false);
    expect(validation.issueCodes).toContain("obligation_source_span_overlap");
    expect(validation.issueCodes).toContain("obligation_source_text_mismatch");
  });

  it("materializes one required deliverable per atomic obligation", () => {
    const question = "请说明 Coremail 归档能力，并给出 POC 验收流程。";
    const original = taskSpecSchema.parse({
      subject: "Coremail 归档 POC",
      entities: [{
        id: "E1",
        label: "Coremail",
        role: "product",
        sourceText: "Coremail",
      }],
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
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec: original,
    });

    const guarded = materializeGuardedTaskSpec({ original, contract });

    expect(guarded.deliverables).toHaveLength(2);
    expect(guarded.deliverables.map((item) => item.id)).toEqual(["D1", "D2"]);
    expect(guarded.deliverables.flatMap((item) => item.obligations)
      .map((item) => item.id)).toEqual(["O1", "O2"]);
    expect(guarded.deliverables.flatMap((item) => item.obligations)
      .map((item) => item.sourceText)).toEqual(contract.obligations
        .map((item) => item.sourceText));
  });
});

function obligation(input: {
  readonly id: `O${number}`;
  readonly start: number;
  readonly end: number;
  readonly sourceText: string;
}): AtomicObligationContract["obligations"][number] {
  return {
    id: input.id,
    sourceSpan: { start: input.start, end: input.end },
    sourceText: input.sourceText,
    kind: "fact",
    targetEntityIds: [],
    domains: ["coremail-professional"],
    evidencePolicy: "direct",
    evidenceTypes: ["formal_page"],
    risk: "low",
    completionCriteria: ["claim_supported", "all_required_aspects_covered"],
    required: true,
  };
}
