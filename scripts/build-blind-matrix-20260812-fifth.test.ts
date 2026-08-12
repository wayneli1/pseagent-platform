import { describe, expect, it } from "vitest";
import { hashBlindQuestion, parseBlindAcceptanceDataset } from "./blind-acceptance-contract.js";
import {
  buildFifthMatrix,
  collectExcludedQuestionHashes,
  collectPriorSemanticFingerprints,
  semanticNoveltyFingerprint,
} from "./build-blind-matrix-20260812-fifth.mjs";

const targetPath = "tests/e2e/enterprise-blind-acceptance-20260812-fifth.json";

describe("fifth blind matrix freeze", () => {
  it("contains exactly one hundred structurally valid cases absent from every old question set", () => {
    const matrix = buildFifthMatrix();
    const excludedHashes = collectExcludedQuestionHashes(targetPath);
    const parsed = parseBlindAcceptanceDataset(matrix, excludedHashes);

    expect(parsed.cases).toHaveLength(100);
    expect(parsed.cases.some((item) =>
      excludedHashes.has(hashBlindQuestion(item.question)))).toBe(false);
  });

  it("has the frozen 20/20/15/15/15/15 layer distribution", () => {
    const matrix = buildFifthMatrix();
    expect(Object.fromEntries([
      "professional", "general", "mixed", "multi_turn",
      "insufficient_evidence", "safety_boundary",
    ].map((layer) => [layer, matrix.cases.filter((item) => item.layer === layer).length])))
      .toEqual({
        professional: 20,
        general: 20,
        mixed: 15,
        multi_turn: 15,
        insufficient_evidence: 15,
        safety_boundary: 15,
      });
  });

  it("rejects internal and historical semantic duplicates, not only copied wording", () => {
    const matrix = buildFifthMatrix();
    const fingerprints = matrix.cases.map(semanticNoveltyFingerprint);
    const historical = collectPriorSemanticFingerprints(targetPath);

    expect(new Set(fingerprints).size).toBe(100);
    expect(fingerprints.some((fingerprint) => historical.has(fingerprint))).toBe(false);
    const first = matrix.cases[0]!;
    expect(semanticNoveltyFingerprint({
      ...first,
      question: `换一种说法：${first.question}`,
    })).toBe(fingerprints[0]);
  });

  it("keeps multi-turn contexts independent and every boundary case explicitly auditable", () => {
    const matrix = buildFifthMatrix();
    expect(matrix.cases.filter((item) => item.layer === "multi_turn")
      .every((item) => typeof item.conversationContext === "string" &&
        item.conversationContext.length > 0)).toBe(true);
    expect(matrix.cases.filter((item) =>
      item.layer === "insufficient_evidence" || item.layer === "safety_boundary")
      .every((item) => item.expectedDisposition === "partial_or_refuse" &&
        item.forbiddenPatterns.length > 0)).toBe(true);
  });
});
