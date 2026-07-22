import { describe, expect, it } from "vitest";
import type { FinalAction } from "./contracts.js";
import { ReferenceRegistry, ReferenceValidationError, type ReadEvidence } from "./references.js";

const revision = "a".repeat(40);
const contentHash = "b".repeat(64);

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

function final(coverage: FinalAction["coverage"], answer: string, citations: number[]): FinalAction {
  return { action: "final", coverage, answer, citations };
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

  it("rejects unknown citations and citation metadata mismatches", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);
    registry.register(readEvidence());

    expect(registry.validateFinal(final("complete", "结论[2]", [2])).ok).toBe(false);
    expect(registry.validateFinal(final("complete", "结论[1]", [])).ok).toBe(false);
    expect(registry.validateFinal(final("complete", "结论", [1])).ok).toBe(false);
  });

  it("rejects cross-project, cross-revision, and page identity mismatches", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);

    expect(() => registry.register(readEvidence("wiki/page.md", { project: "presales-general" }))).toThrow(ReferenceValidationError);
    expect(() => registry.register(readEvidence("wiki/page.md", { revision: "c".repeat(40) }))).toThrow(ReferenceValidationError);
    expect(() => registry.register(readEvidence("wiki/page.md", {
      page: { ...readEvidence("wiki/page.md").page, project: "presales-general" },
    }))).toThrow(ReferenceValidationError);
  });

  it("requires evidence for covered answers and permits only coverage explanations for none", () => {
    const registry = new ReferenceRegistry("coremail-professional", revision);

    expect(registry.validateFinal(final("complete", "答案", [])).ok).toBe(false);
    expect(registry.validateFinal(final("none", "Coremail 支持这个功能", [])).ok).toBe(false);
    expect(registry.validateFinal(final("none", "当前资料未覆盖该问题", [])).ok).toBe(true);
  });
});
