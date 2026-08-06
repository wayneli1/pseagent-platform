import { describe, expect, it } from "vitest";
import {
  normalizeQuestion,
  selectAcceptanceCases,
  validateAcceptanceMatrix,
  type AcceptanceCase,
} from "./enterprise-e2e-matrix.js";

const makeCase = (index: number): AcceptanceCase => ({
  id: `R2-${index}`,
  matrixType: "independent",
  question: `全新问题 ${index}？`,
  session: `R2-${index}`,
  expectedScope: "professional",
  expectedTarget: "ordinary_retrieval",
  expectedEvidence: [`wiki/${index}.md`],
  requiredFactGroups: [[`事实${index}`]],
  forbiddenClaims: [],
  expectedBehavior: "依据正式资料回答",
  expectedIssueCenter: false,
});

const matrix = {
  batchId: "E2E-20260807-002",
  userDisplayName: "Codex 自动测试 · E2E-20260807-002",
  model: "deepseek_v4_flash" as const,
  cases: Array.from({ length: 20 }, (_, index) => makeCase(index + 1)),
  supplementCases: [],
  postPublishCases: [],
};

describe("enterprise E2E matrix", () => {
  it("accepts a complete 20-case second-round matrix", () => {
    expect(validateAcceptanceMatrix(matrix, {
      phase1Count: 20,
      supplementCount: 0,
      postPublishCount: 0,
    }).cases).toHaveLength(20);
  });

  it("rejects normalized reuse of a first-round question", () => {
    expect(() => validateAcceptanceMatrix(matrix, {
      phase1Count: 20,
      supplementCount: 0,
      postPublishCount: 0,
      forbiddenQuestions: ["全新问题 1"],
    })).toThrow("enterprise_e2e_matrix_reuses_forbidden_question");
    expect(normalizeQuestion("全新问题 1？")).toBe(normalizeQuestion("全新问题１"));
  });

  it("requires and selects exactly one case in strict mode", () => {
    expect(() => selectAcceptanceCases(matrix, "phase1", undefined, { requireSingleCase: true }))
      .toThrow("enterprise_e2e_case_id_required");
    expect(selectAcceptanceCases(matrix, "phase1", "R2-7", { requireSingleCase: true }))
      .toEqual([matrix.cases[6]]);
  });
});
