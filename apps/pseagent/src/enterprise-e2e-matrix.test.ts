import { describe, expect, it } from "vitest";
import {
  acceptanceFactGroupCovered,
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
  it("accepts an optional Chinese possessive particle between semantic words", () => {
    expect(acceptanceFactGroupCovered(
      "不同元素可能映射到相同的位置。",
      "为什么会有假阳性？",
      ["相同位置"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "不同元素会映射到不同位置。",
      "为什么会有假阳性？",
      ["相同位置"],
    )).toBe(false);
  });

  it("accepts a two-action inversion only when the user question uses that wording", () => {
    expect(acceptanceFactGroupCovered(
      "应先修复异常发信，再提交申请解除流程。",
      "邮件出口 IP 进了 RBL，怎么检测、申请解除并防止再次被拉黑？",
      ["解除申请"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "先梳理关系客户，再安排拜访。",
      "客户关系应该怎样分层管理？",
      ["客户关系"],
    )).toBe(false);
  });

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
