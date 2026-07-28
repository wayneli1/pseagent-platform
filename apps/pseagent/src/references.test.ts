import { describe, expect, it } from "vitest";
import type {
  FinalAction,
  KnowledgeRequirement,
  RequirementCoverage,
} from "./contracts.js";
import { ReferenceRegistry, ReferenceValidationError, type ReadEvidence } from "./references.js";

const revision = "a".repeat(40);
const contentHash = "b".repeat(64);
const requirements: KnowledgeRequirement[] = [
  { id: "R1", question: "功能", queries: ["功能查询"] },
  { id: "R2", question: "POC", queries: ["POC 查询"] },
];

function readEvidence(path = "wiki/concepts/coremail-ai助手.md", overrides: Partial<ReadEvidence> = {}): ReadEvidence {
  return {
    project: "coremail-professional",
    revision,
    page: {
      project: "coremail-professional",
      path,
      title: "Coremail AI 助手",
      type: "concept",
      tags: [],
      related: [],
      sources: [],
      body: "body",
      contentHash,
    },
    ...overrides,
  };
}

function final(
  requirementResults: Array<Omit<RequirementCoverage, "answer"> & { answer?: string }>,
  answer: string,
  citations: number[],
): FinalAction {
  return {
    action: "final",
    requirements: requirementResults.map((item) => ({
      ...item,
      answer: item.answer ?? [
        answer.replace(/\[\d+\]/gu, "").trim() || "当前资料未覆盖",
        ...item.citations.map((citation) => `[${citation}]`),
      ].join(" ").trim(),
    })),
    citations,
  };
}

function evidence(entries: Array<[string, number[]]>): ReadonlyMap<string, ReadonlySet<number>> {
  return new Map(entries.map(([id, citations]) => [id, new Set(citations)]));
}

describe("ReferenceRegistry", () => {
  it("registers only read pages and de-duplicates by project/revision/path/hash", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    const first = registry.register(readEvidence());
    const again = registry.register(readEvidence());

    expect(first.index).toBe(1);
    expect(again.index).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects cross-project, cross-revision, and page identity mismatches", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);

    expect(() => registry.register(readEvidence("wiki/page.md", { project: "presales-general" })))
      .toThrow(ReferenceValidationError);
    expect(() => registry.register(readEvidence("wiki/page.md", { revision: "c".repeat(40) })))
      .toThrow(ReferenceValidationError);
    expect(() => registry.register(readEvidence("wiki/page.md", {
      page: { ...readEvidence("wiki/page.md").page, project: "presales-general" },
    }))).toThrow(ReferenceValidationError);
  });

  it("accepts complete per-requirement coverage only with evidence read for each item", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence("wiki/feature.md"));
    registry.register(readEvidence("wiki/poc.md"));
    const action = final([
      { id: "R1", coverage: "complete", citations: [1] },
      { id: "R2", coverage: "complete", citations: [2] },
    ], "功能结论[1]；POC 结论[2]", [1, 2]);

    expect(registry.validateFinal(
      action,
      requirements,
      evidence([["R1", [1]], ["R2", [2]]]),
    )).toEqual({ ok: true });
  });

  it("accepts a different inline citation order when the supported citation set is identical", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence("wiki/feature.md"));
    registry.register(readEvidence("wiki/poc.md"));
    const action = final([
      { id: "R1", coverage: "complete", citations: [1] },
      { id: "R2", coverage: "complete", citations: [2] },
    ], "先说明 POC[2]，再说明功能[1]", [1, 2]);

    expect(registry.validateFinal(
      action,
      requirements,
      evidence([["R1", [1]], ["R2", [2]]]),
    )).toEqual({ ok: true });
  });

  it.each([
    {
      name: "遗漏 requirement",
      action: final(
        [{ id: "R1", coverage: "complete", citations: [1] }],
        "结论[1]",
        [1],
      ),
      evidence: evidence([["R1", [1]], ["R2", [2]]]),
    },
    {
      name: "跨 requirement 借用引用",
      action: final([
        { id: "R1", coverage: "complete", citations: [2] },
        { id: "R2", coverage: "complete", citations: [2] },
      ], "功能和 POC[2]", [2]),
      evidence: evidence([["R1", [1]], ["R2", [2]]]),
    },
    {
      name: "顶层引用不是逐项并集",
      action: final([
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "complete", citations: [2] },
      ], "功能[1]；POC[2]", [2, 1]),
      evidence: evidence([["R1", [1]], ["R2", [2]]]),
    },
    {
      name: "partial 未说明缺口",
      action: final([
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "partial", citations: [2] },
      ], "功能[1]；POC[2]", [1, 2]),
      evidence: evidence([["R1", [1]], ["R2", [2]]]),
    },
    {
      name: "none 携带引用",
      action: final([
        { id: "R1", coverage: "complete", citations: [1] },
        { id: "R2", coverage: "none", citations: [2] },
      ], "功能[1]；POC 尚未覆盖[2]", [1, 2]),
      evidence: evidence([["R1", [1]], ["R2", [2]]]),
    },
  ])("rejects invalid coverage: $name", ({ action, evidence: itemEvidence }) => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence("wiki/feature.md"));
    registry.register(readEvidence("wiki/poc.md"));

    expect(registry.validateFinal(action, requirements, itemEvidence).ok).toBe(false);
  });

  it("accepts a partial composite result when the missing item is explicit", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence("wiki/feature.md"));
    const action = final([
      { id: "R1", coverage: "complete", citations: [1] },
      { id: "R2", coverage: "none", citations: [] },
    ], "功能已确认[1]；POC 注意事项尚未覆盖，待确认。", [1]);

    expect(registry.validateFinal(
      action,
      requirements,
      evidence([["R1", [1]], ["R2", []]]),
    )).toEqual({ ok: true });
  });

  it("rejects unknown citations and citation metadata mismatches", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence());
    const singleRequirement = requirements.slice(0, 1);
    const singleEvidence = evidence([["R1", [1]]]);

    expect(registry.validateFinal(
      final([{ id: "R1", coverage: "complete", citations: [2] }], "结论[2]", [2]),
      singleRequirement,
      singleEvidence,
    ).ok).toBe(false);
    expect(registry.validateFinal(
      final([{ id: "R1", coverage: "complete", answer: "结论", citations: [1] }], "结论", [1]),
      singleRequirement,
      singleEvidence,
    ).ok).toBe(false);
  });

  it("identifies the requirement and citation when provenance validation fails", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence());

    expect(registry.validateFinal(
      final([{
        id: "R1",
        coverage: "complete",
        answer: "结论 [1]",
        citations: [1],
      }], "结论 [1]", [1]),
      requirements.slice(0, 1),
      evidence([["R1", []]]),
    )).toEqual({
      ok: false,
      reason: "citation_not_read_for_requirement:R1:1",
    });
  });

  it("rejects a requirement that delegates its conclusion to a citation", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence());

    expect(registry.validateFinal(
      final([{
        id: "R1",
        coverage: "complete",
        answer: "具体配置如 [1] 所列。",
        citations: [1],
      }], "具体配置如 [1] 所列。", [1]),
      requirements.slice(0, 1),
      evidence([["R1", [1]]]),
    )).toEqual({ ok: false, reason: "requirement_answer_delegates_to_citation" });
  });
});
