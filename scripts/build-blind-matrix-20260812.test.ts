import { describe, expect, it } from "vitest";
import { hashBlindQuestion, parseBlindAcceptanceDataset } from "./blind-acceptance-contract.js";
import {
  buildFourthMatrix,
  collectExcludedQuestionHashes,
  semanticNoveltyFingerprint,
} from "./build-blind-matrix-20260812.mjs";

const targetPath = "tests/e2e/enterprise-blind-acceptance-20260812-fourth.json";

describe("fourth blind matrix freeze", () => {
  it("contains exactly one hundred structurally valid and textually new cases", () => {
    const matrix = buildFourthMatrix();
    const excludedHashes = collectExcludedQuestionHashes(targetPath);
    const parsed = parseBlindAcceptanceDataset(matrix, excludedHashes);

    expect(parsed.cases).toHaveLength(100);
    expect(parsed.cases.some((item) =>
      excludedHashes.has(hashBlindQuestion(item.question)))).toBe(false);
  });

  it("has the frozen 20/20/15/15/15/15 layer distribution", () => {
    const matrix = buildFourthMatrix();
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

  it("rejects semantic duplicates even when their wording differs", () => {
    const matrix = buildFourthMatrix();
    const fingerprints = matrix.cases.map(semanticNoveltyFingerprint);
    expect(new Set(fingerprints).size).toBe(100);

    const first = matrix.cases[0]!;
    const paraphrase = { ...first, question: `换一种说法：${first.question}` };
    expect(semanticNoveltyFingerprint(paraphrase)).toBe(fingerprints[0]);
  });

  it("keeps multi-turn context and refusal policy labels auditable", () => {
    const matrix = buildFourthMatrix();
    expect(matrix.cases.filter((item) => item.layer === "multi_turn")
      .every((item) => typeof item.conversationContext === "string")).toBe(true);
    expect(matrix.cases.filter((item) =>
      item.layer === "insufficient_evidence" || item.layer === "safety_boundary")
      .every((item) => item.expectedDisposition === "partial_or_refuse")).toBe(true);
  });
});
