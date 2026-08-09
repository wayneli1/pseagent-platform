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

  it("accepts short Chinese modifiers between ordered concept words", () => {
    expect(acceptanceFactGroupCovered(
      "具体容量和权限边界必须按目标版本正文资料核实。",
      "需要核对哪些边界？",
      ["版本资料"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "资料只描述产品能力，未说明适用版本。",
      "需要核对哪些边界？",
      ["版本资料"],
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

  it("accepts general semantic equivalents without requiring keyword stuffing", () => {
    expect(acceptanceFactGroupCovered(
      "请客户用具体事实描述当前面临的问题。",
      "如何确认关键业务问题？",
      ["具体场景", "最近一次", "现状"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "对每一条有向边，起点都必须排在终点之前。",
      "为什么拓扑排序只适用于有向无环图？",
      ["所有边"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "请笼统描述未来设想。",
      "如何确认关键业务问题？",
      ["具体场景", "最近一次", "现状"],
    )).toBe(false);
    expect(acceptanceFactGroupCovered(
      "请客户描述解决问题后的预期收益或差距。",
      "如何确认关键业务问题？",
      ["影响", "结果"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "算法每次取出当前距离最小的节点；只有图中没有负权边时该结论才成立。",
      "为什么算法不能处理负权边？",
      ["当前最短", "最小暂定距离"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "只有图中没有负权边时，贪心确定性才成立。",
      "为什么算法不能处理负权边？",
      ["非负权", "边权非负"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "系统定义的优先级并非在所有场景下都绝对有效。",
      "能不能直接套用一套固定优先级？",
      ["不能", "无法"],
    )).toBe(true);
    expect(acceptanceFactGroupCovered(
      "可以直接套用一套固定优先级。",
      "能不能直接套用一套固定优先级？",
      ["不能", "无法"],
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
