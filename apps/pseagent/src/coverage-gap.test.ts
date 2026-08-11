import { describe, expect, it } from "vitest";
import { analyzeCoverageGaps } from "./coverage-gap.js";
import {
  finalizeEvidenceLedger,
  type EvidenceLedgerDraftUnit,
} from "./evidence-ledger.js";

const revision = "c".repeat(40);

function missingUnit(
  overrides: Partial<EvidenceLedgerDraftUnit> = {},
): EvidenceLedgerDraftUnit {
  return {
    binding: {
      domain: "coremail-professional",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      order: 0,
    },
    subject: "目标系统",
    requirement: {
      id: "R1",
      question: "确认目标系统的目标能力",
      evidenceMode: "direct_only",
      evidenceAspects: [{ id: "A1", label: "目标能力", terms: ["目标能力"] }],
      queries: [{ text: "目标系统 目标能力", aspectIds: ["A1"] }],
    },
    queries: [{
      phase: "seed",
      query: "目标系统 目标能力",
      aspectIds: ["A1"],
      status: "empty",
      plannedQueryIndexes: [0],
    }],
    candidates: [],
    reads: [],
    graphs: [],
    claims: [],
    retrieval: {
      deadlineReached: false,
      searchBudgetExhausted: false,
      readBudgetExhausted: false,
      toolUnavailableCount: 0,
      accessDeniedCount: 0,
    },
    sourceBoundary: "formal",
    conflictDetected: false,
    freshness: "not_assessed",
    inputState: "not_applicable",
    ambiguous: false,
    verification: {
      coverage: "none",
      reason: "target_omitted",
      coveredAspectIds: [],
      missingAspectIds: ["A1"],
    },
    ...overrides,
  };
}

function gaps(draft: EvidenceLedgerDraftUnit) {
  return analyzeCoverageGaps(finalizeEvidenceLedger({
    project: "coremail-professional",
    revision,
    units: [draft],
  }));
}

describe("analyzeCoverageGaps", () => {
  it.each([
    {
      name: "required customer input",
      draft: missingUnit({ inputState: "missing", ambiguous: true }),
      expected: ["input", "required_customer_input_missing"],
    },
    {
      name: "ambiguity before retrieval",
      draft: missingUnit({
        ambiguous: true,
        queries: [{
          phase: "seed",
          query: "目标系统 目标能力",
          aspectIds: ["A1"],
          status: "unavailable",
          plannedQueryIndexes: [0],
        }],
      }),
      expected: ["ambiguity", "ambiguous_question"],
    },
    {
      name: "access failure",
      draft: missingUnit({
        candidates: [{
          path: "wiki/target.md",
          title: "目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
        reads: [{ path: "wiki/target.md", status: "access_denied" }],
        retrieval: {
          ...missingUnit().retrieval,
          accessDeniedCount: 1,
        },
      }),
      expected: ["retrieval", "access_denied"],
    },
    {
      name: "tool failure before knowledge",
      draft: missingUnit({
        queries: [{
          phase: "seed",
          query: "目标系统 目标能力",
          aspectIds: ["A1"],
          status: "unavailable",
          plannedQueryIndexes: [0],
        }],
        retrieval: {
          ...missingUnit().retrieval,
          toolUnavailableCount: 1,
        },
      }),
      expected: ["retrieval", "tool_unavailable"],
    },
    {
      name: "graph lookup failure before knowledge",
      draft: missingUnit({
        candidates: [{
          path: "wiki/target.md",
          title: "目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: false,
        }],
        graphs: [{
          sourcePath: "wiki/target.md",
          status: "unavailable",
          hitCount: 0,
        }],
      }),
      expected: ["retrieval", "tool_unavailable"],
    },
    {
      name: "candidate recalled for another aspect",
      draft: missingUnit({
        requirement: {
          ...missingUnit().requirement,
          evidenceAspects: [
            ...missingUnit().requirement.evidenceAspects,
            { id: "A2", label: "鍏朵粬鑳藉姏", terms: ["鍏朵粬鑳藉姏"] },
          ],
          queries: [
            ...missingUnit().requirement.queries,
            { text: "鐩爣绯荤粺 鍏朵粬鑳藉姏", aspectIds: ["A2"] },
          ],
        },
        queries: [
          ...missingUnit().queries,
          {
            phase: "seed",
            query: "鐩爣绯荤粺 鍏朵粬鑳藉姏",
            aspectIds: ["A2"],
            status: "success",
            plannedQueryIndexes: [1],
          },
        ],
        candidates: [{
          path: "wiki/other.md",
          title: "鍏朵粬璧勬枡",
          sources: ["seed"],
          aspectIds: ["A2"],
          reviewRequired: false,
        }],
        verification: {
          coverage: "partial",
          reason: "target_omitted",
          coveredAspectIds: ["A2"],
          missingAspectIds: ["A1"],
        },
      }),
      expected: ["retrieval", "candidate_not_recalled"],
    },
    {
      name: "relevant candidate not ranked into the review budget",
      draft: missingUnit({
        candidates: [{
          path: "wiki/target.md",
          title: "鐩爣璧勬枡",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: false,
        }],
      }),
      expected: ["retrieval", "candidate_not_ranked"],
    },
    {
      name: "lower ranked relevant candidate remains after reviewed evidence is insufficient",
      draft: missingUnit({
        candidates: [
          {
            path: "wiki/reviewed.md",
            title: "宸叉牳楠岃祫鏂?",
            sources: ["seed"],
            aspectIds: ["A1"],
            reviewRequired: true,
          },
          {
            path: "wiki/unranked.md",
            title: "鏈繘鍏ヨ椤甸绠楃殑璧勬枡",
            sources: ["seed"],
            aspectIds: ["A1"],
            reviewRequired: false,
          },
        ],
        reads: [{
          path: "wiki/reviewed.md",
          status: "success",
          citation: 1,
          pageType: "guide",
          sources: [],
        }],
      }),
      expected: ["retrieval", "candidate_not_ranked"],
    },
    {
      name: "unread candidate",
      draft: missingUnit({
        candidates: [{
          path: "wiki/target.md",
          title: "目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
      }),
      expected: ["retrieval", "candidate_not_read"],
    },
    {
      name: "read budget",
      draft: missingUnit({
        candidates: [{
          path: "wiki/target.md",
          title: "目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
        retrieval: {
          ...missingUnit().retrieval,
          readBudgetExhausted: true,
        },
      }),
      expected: ["retrieval", "retrieval_budget_exhausted"],
    },
    {
      name: "summary boundary before conflict",
      draft: missingUnit({
        queries: [{
          phase: "seed",
          query: "目标系统 目标能力",
          aspectIds: ["A1"],
          status: "success",
          plannedQueryIndexes: [0],
        }],
        candidates: [{
          path: "wiki/summary.md",
          title: "目标资料摘要",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
        reads: [{
          path: "wiki/summary.md",
          status: "success",
          citation: 1,
          pageType: "summary",
          sources: [],
        }],
        sourceBoundary: "summary_only",
        conflictDetected: true,
      }),
      expected: ["source", "summary_only"],
    },
    {
      name: "external source boundary",
      draft: missingUnit({
        queries: [{
          phase: "seed",
          query: "目标系统 目标能力",
          aspectIds: ["A1"],
          status: "success",
          plannedQueryIndexes: [0],
        }],
        candidates: [{
          path: "wiki/external.md",
          title: "外部目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
        reads: [{
          path: "wiki/external.md",
          status: "success",
          citation: 1,
          pageType: "external",
          sources: ["https://example.test/source"],
        }],
        sourceBoundary: "external_only",
      }),
      expected: ["source", "external_source_only"],
    },
    {
      name: "conflicting sources",
      draft: missingUnit({ conflictDetected: true }),
      expected: ["conflict", "conflicting_sources"],
    },
    {
      name: "freshness",
      draft: missingUnit({ freshness: "stale_or_unconfirmed" }),
      expected: ["freshness", "stale_or_unconfirmed"],
    },
    {
      name: "true no matching page",
      draft: missingUnit(),
      expected: ["knowledge", "source_absent"],
    },
    {
      name: "all candidate pages read without support",
      draft: missingUnit({
        queries: [{
          phase: "seed",
          query: "目标系统 目标能力",
          aspectIds: ["A1"],
          status: "success",
          plannedQueryIndexes: [0],
        }],
        candidates: [{
          path: "wiki/target.md",
          title: "目标资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        }],
        reads: [{
          path: "wiki/target.md",
          status: "success",
          citation: 1,
          pageType: "guide",
          sources: [],
        }],
      }),
      expected: ["knowledge", "evidence_insufficient"],
    },
  ])("classifies $name with deterministic priority", ({ draft, expected }) => {
    expect(gaps(draft)).toEqual([
      expect.objectContaining({
        id: "G1",
        domain: "coremail-professional",
        deliverableId: "D1",
        obligationId: "O1",
        subject: "目标系统",
        missingAspect: "目标能力",
        gapClass: expected[0],
        reason: expected[1],
        affectsConclusion: true,
      }),
    ]);
  });

  it("does not create a knowledge gap for a fully covered obligation", () => {
    expect(gaps(missingUnit({
      verification: {
        coverage: "complete",
        reason: "direct_support",
        coveredAspectIds: ["A1"],
        missingAspectIds: [],
      },
    }))).toEqual([]);
  });

  it("attributes a partial with no missing aspect to a removed unsupported claim", () => {
    expect(gaps(missingUnit({
      claims: [{
        claimIndex: 0,
        status: "removed",
        citations: [],
        coveredAspectIds: [],
      }],
      verification: {
        coverage: "partial",
        reason: "partial_support",
        coveredAspectIds: ["A1"],
        missingAspectIds: [],
      },
    }))).toMatchObject([{
      gapClass: "knowledge",
      reason: "unsupported_claim_removed",
      missingAspect: "核验中删除的无证据主张",
    }]);
  });

  it("does not let a recovered read failure shadow the completed evidence review", () => {
    expect(gaps(missingUnit({
      queries: [{
        phase: "seed",
        query: "目标系统 目标能力",
        aspectIds: ["A1"],
        status: "success",
        plannedQueryIndexes: [0],
      }],
      candidates: [{
        path: "wiki/target.md",
        title: "目标资料",
        sources: ["seed"],
        aspectIds: ["A1"],
        reviewRequired: true,
      }],
      reads: [
        { path: "wiki/target.md", status: "unavailable" },
        {
          path: "wiki/target.md",
          status: "success",
          citation: 1,
          pageType: "guide",
          sources: [],
        },
      ],
    }))).toMatchObject([{
      gapClass: "knowledge",
      reason: "evidence_insufficient",
    }]);
  });

  it("keeps partial missing aspects specific and ordered", () => {
    const draft = missingUnit({
      requirement: {
        ...missingUnit().requirement,
        evidenceAspects: [
          { id: "A1", label: "部署方式", terms: ["部署"] },
          { id: "A2", label: "容量边界", terms: ["容量"] },
          { id: "A3", label: "高可用边界", terms: ["高可用"] },
        ],
        queries: [{
          text: "目标系统 部署 容量 高可用",
          aspectIds: ["A1", "A2", "A3"],
        }],
      },
      queries: [{
        phase: "seed",
        query: "目标系统 部署 容量 高可用",
        aspectIds: ["A1", "A2", "A3"],
        status: "empty",
        plannedQueryIndexes: [0],
      }],
      verification: {
        coverage: "partial",
        reason: "partial_support",
        coveredAspectIds: ["A1"],
        missingAspectIds: ["A2", "A3"],
      },
    });

    expect(gaps(draft).map((gap) => [gap.id, gap.missingAspect])).toEqual([
      ["G1", "容量边界"],
      ["G2", "高可用边界"],
    ]);
  });

  it("attributes retrieval, source, and knowledge gaps independently per missing aspect", () => {
    const draft = missingUnit({
      requirement: {
        ...missingUnit().requirement,
        evidenceAspects: [
          { id: "A1", label: "未读候选方面", terms: ["未读候选"] },
          { id: "A2", label: "仅摘要方面", terms: ["摘要"] },
          { id: "A3", label: "无匹配页面方面", terms: ["无匹配"] },
        ],
        queries: [
          { text: "目标系统 未读候选", aspectIds: ["A1"] },
          { text: "目标系统 摘要", aspectIds: ["A2"] },
          { text: "目标系统 无匹配", aspectIds: ["A3"] },
        ],
      },
      queries: [
        {
          phase: "seed",
          query: "目标系统 未读候选",
          aspectIds: ["A1"],
          status: "success",
          plannedQueryIndexes: [0],
        },
        {
          phase: "seed",
          query: "目标系统 摘要",
          aspectIds: ["A2"],
          status: "success",
          plannedQueryIndexes: [1],
        },
        {
          phase: "seed",
          query: "目标系统 无匹配",
          aspectIds: ["A3"],
          status: "empty",
          plannedQueryIndexes: [2],
        },
      ],
      candidates: [
        {
          path: "wiki/unread.md",
          title: "尚未读取的正式资料",
          sources: ["seed"],
          aspectIds: ["A1"],
          reviewRequired: true,
        },
        {
          path: "wiki/summary.md",
          title: "已读摘要资料",
          sources: ["seed"],
          aspectIds: ["A2"],
          reviewRequired: true,
        },
      ],
      reads: [{
        path: "wiki/summary.md",
        status: "success",
        citation: 1,
        pageType: "summary",
        sources: [],
      }],
      sourceBoundary: "summary_only",
      verification: {
        coverage: "none",
        reason: "target_omitted",
        coveredAspectIds: [],
        missingAspectIds: ["A1", "A2", "A3"],
      },
    });

    expect(gaps(draft).map((gap) => [
      gap.id,
      gap.missingAspect,
      gap.gapClass,
      gap.reason,
    ])).toEqual([
      ["G1", "未读候选方面", "retrieval", "candidate_not_read"],
      ["G2", "仅摘要方面", "source", "summary_only"],
      ["G3", "无匹配页面方面", "retrieval", "candidate_not_recalled"],
    ]);
  });

  it("limits an unrecovered query failure to its associated aspect", () => {
    const draft = missingUnit({
      requirement: {
        ...missingUnit().requirement,
        evidenceAspects: [
          { id: "A1", label: "检索失败方面", terms: ["失败"] },
          { id: "A2", label: "正常检索方面", terms: ["正常"] },
        ],
        queries: [
          { text: "目标系统 失败", aspectIds: ["A1"] },
          { text: "目标系统 正常", aspectIds: ["A2"] },
        ],
      },
      queries: [
        {
          phase: "seed",
          query: "目标系统 失败",
          aspectIds: ["A1"],
          status: "unavailable",
          plannedQueryIndexes: [0],
        },
        {
          phase: "seed",
          query: "目标系统 正常",
          aspectIds: ["A2"],
          status: "empty",
          plannedQueryIndexes: [1],
        },
      ],
      retrieval: {
        ...missingUnit().retrieval,
        toolUnavailableCount: 1,
      },
      verification: {
        coverage: "none",
        reason: "target_omitted",
        coveredAspectIds: [],
        missingAspectIds: ["A1", "A2"],
      },
    });

    expect(gaps(draft).map((gap) => [gap.missingAspect, gap.gapClass, gap.reason]))
      .toEqual([
        ["检索失败方面", "retrieval", "tool_unavailable"],
        ["正常检索方面", "knowledge", "source_absent"],
      ]);
  });

  it("treats a later successful terminal state for the same normalized query as recovery", () => {
    const draft = missingUnit({
      requirement: {
        ...missingUnit().requirement,
        evidenceAspects: [
          { id: "A1", label: "恢复检索方面", terms: ["恢复"] },
          { id: "A2", label: "正常检索方面", terms: ["正常"] },
        ],
        queries: [
          { text: "TARGET 恢复", aspectIds: ["A1"] },
          { text: "目标系统 正常", aspectIds: ["A2"] },
        ],
      },
      queries: [
        {
          phase: "seed",
          query: "ＴＡＲＧＥＴ　恢复",
          aspectIds: ["A1"],
          status: "unavailable",
          plannedQueryIndexes: [0],
        },
        {
          phase: "supplemental",
          query: " target   恢复 ",
          aspectIds: ["A1"],
          status: "empty",
          plannedQueryIndexes: [],
        },
        {
          phase: "seed",
          query: "目标系统 正常",
          aspectIds: ["A2"],
          status: "empty",
          plannedQueryIndexes: [1],
        },
      ],
      retrieval: {
        ...missingUnit().retrieval,
        toolUnavailableCount: 1,
      },
      verification: {
        coverage: "none",
        reason: "target_omitted",
        coveredAspectIds: [],
        missingAspectIds: ["A1", "A2"],
      },
    });

    expect(gaps(draft).map((gap) => [gap.missingAspect, gap.gapClass, gap.reason]))
      .toEqual([
        ["恢复检索方面", "knowledge", "source_absent"],
        ["正常检索方面", "knowledge", "source_absent"],
      ]);
  });

  it("applies an unrecovered global query failure to every aspect", () => {
    const draft = missingUnit({
      requirement: {
        ...missingUnit().requirement,
        evidenceAspects: [
          { id: "A1", label: "第一方面", terms: ["第一"] },
          { id: "A2", label: "第二方面", terms: ["第二"] },
        ],
        queries: [{ text: "目标系统 第一 第二", aspectIds: ["A1", "A2"] }],
      },
      queries: [
        {
          phase: "seed",
          query: "目标系统 第一 第二",
          aspectIds: ["A1", "A2"],
          status: "empty",
          plannedQueryIndexes: [0],
        },
        {
          phase: "seed",
          query: "全局问题检索",
          aspectIds: [],
          status: "unavailable",
          plannedQueryIndexes: [],
        },
      ],
      retrieval: {
        ...missingUnit().retrieval,
        toolUnavailableCount: 1,
      },
      verification: {
        coverage: "none",
        reason: "target_omitted",
        coveredAspectIds: [],
        missingAspectIds: ["A1", "A2"],
      },
    });

    expect(gaps(draft).map((gap) => [gap.missingAspect, gap.reason])).toEqual([
      ["第一方面", "tool_unavailable"],
      ["第二方面", "tool_unavailable"],
    ]);
  });

  it("lets the input root cause dominate a duplicate knowledge-method unit", () => {
    const subject = "当前机会应汇报多少赢率";
    const knowledge = missingUnit({
      subject,
      retrieval: {
        ...missingUnit().retrieval,
        readBudgetExhausted: true,
      },
    });
    const input = missingUnit({
      binding: {
        domain: "coremail-professional",
        requirementId: "R2",
        deliverableId: "D2",
        obligationId: "O2",
        order: 1,
      },
      subject,
      requirement: {
        ...missingUnit().requirement,
        id: "R2",
      },
      inputState: "missing",
    });

    const result = analyzeCoverageGaps(finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [knowledge, input],
    }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      requirementId: "R2",
      gapClass: "input",
      reason: "required_customer_input_missing",
    });
  });
});
