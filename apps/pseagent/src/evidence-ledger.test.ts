import { describe, expect, it } from "vitest";
import {
  EvidenceLedgerValidationError,
  finalizeEvidenceLedger,
  type EvidenceLedgerDraftUnit,
} from "./evidence-ledger.js";

const revision = "a".repeat(40);

function unit(
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
      question: "确认目标系统的部署边界",
      evidenceMode: "direct_only",
      evidenceAspects: [{
        id: "A1",
        label: "部署边界",
        terms: ["部署", "边界"],
      }],
      queries: [{ text: "目标系统 部署边界", aspectIds: ["A1"] }],
    },
    queries: [{
      phase: "seed",
      query: "目标系统 部署边界",
      aspectIds: ["A1"],
      status: "success",
      plannedQueryIndexes: [0],
    }],
    candidates: [{
      path: "wiki/deployment.md",
      title: "部署说明",
      sources: ["seed"],
      aspectIds: ["A1"],
      reviewRequired: true,
    }],
    reads: [{
      path: "wiki/deployment.md",
      status: "success",
      citation: 1,
      pageType: "guide",
      sources: [],
    }],
    graphs: [{
      sourcePath: "wiki/deployment.md",
      status: "success",
      hitCount: 2,
    }],
    claims: [{
      claimIndex: 0,
      status: "retained_direct",
      citations: [1],
      coveredAspectIds: ["A1"],
    }],
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
      coverage: "complete",
      reason: "direct_support",
      coveredAspectIds: ["A1"],
      missingAspectIds: [],
    },
    ...overrides,
  };
}

describe("finalizeEvidenceLedger", () => {
  it("creates an immutable, independently bound snapshot with stable record ids", () => {
    const professional = unit();
    const general: EvidenceLedgerDraftUnit = {
      ...unit(),
      binding: {
        domain: "presales-general",
        requirementId: "R1",
        deliverableId: "D2",
        obligationId: "O2",
        order: 1,
      },
      requirement: {
        ...unit().requirement,
        id: "R1",
        question: "形成项目推进建议",
        evidenceMode: "synthesis_allowed",
      },
      queries: [{
        phase: "seed",
        query: "项目推进建议",
        aspectIds: ["A1"],
        status: "empty",
        plannedQueryIndexes: [0],
      }],
      candidates: [],
      reads: [],
      graphs: [],
      claims: [],
      verification: {
        coverage: "none",
        reason: "target_omitted",
        coveredAspectIds: [],
        missingAspectIds: ["A1"],
      },
    };

    const ledger = finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [professional],
    });
    const generalLedger = finalizeEvidenceLedger({
      project: "presales-general",
      revision: "b".repeat(40),
      units: [general],
    });

    expect(ledger.units[0]).toMatchObject({
      binding: { obligationId: "O1", domain: "coremail-professional" },
      queries: [{ id: "Q1", status: "success" }],
      candidates: [{ id: "C1", path: "wiki/deployment.md" }],
      reads: [{ candidateId: "C1", status: "success", citation: 1 }],
      graphs: [{ id: "G1", sourcePath: "wiki/deployment.md", hitCount: 2 }],
      verification: { covered: true, missing: false },
    });
    expect(generalLedger.units[0]).toMatchObject({
      binding: { obligationId: "O2", domain: "presales-general" },
      verification: { covered: false, missing: true },
    });
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.units[0]?.queries)).toBe(true);
    expect(Object.isFrozen(ledger.units[0]?.queries[0]?.plannedQueryIndexes)).toBe(true);
    expect(Object.isFrozen(ledger.units[0]?.graphs)).toBe(true);
    expect(ledger.units[0]?.queries).not.toBe(professional.queries);
  });

  it("requires every planned query index to reach exactly one terminal seed record", () => {
    const twoQueryRequirement = {
      ...unit().requirement,
      queries: [
        { text: "部署方式", aspectIds: ["A1"] },
        { text: "部署边界", aspectIds: ["A1"] },
      ],
    };

    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        requirement: twoQueryRequirement,
        queries: [{
          phase: "seed",
          query: "部署方式",
          aspectIds: ["A1"],
          status: "success",
          plannedQueryIndexes: [0],
        }],
      })],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({
      code: "missing_planned_query_execution",
    }));

    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        requirement: twoQueryRequirement,
        queries: [
          {
            phase: "seed",
            query: "部署方式与边界",
            aspectIds: ["A1"],
            status: "success",
            plannedQueryIndexes: [0, 1],
          },
          {
            phase: "seed",
            query: "部署边界",
            aspectIds: ["A1"],
            status: "empty",
            plannedQueryIndexes: [1],
          },
        ],
      })],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({
      code: "duplicate_planned_query_execution",
    }));
  });

  it.each([
    {
      name: "an out-of-range planned query index",
      queries: [{
        phase: "seed" as const,
        query: "部署边界",
        aspectIds: ["A1"],
        status: "success" as const,
        plannedQueryIndexes: [1],
      }],
    },
    {
      name: "a duplicated planned query index within one record",
      queries: [{
        phase: "seed" as const,
        query: "部署边界",
        aspectIds: ["A1"],
        status: "success" as const,
        plannedQueryIndexes: [0, 0],
      }],
    },
    {
      name: "planned query indexes outside plan order",
      requirementQueries: [
        { text: "部署方式", aspectIds: ["A1"] },
        { text: "部署边界", aspectIds: ["A1"] },
      ],
      queries: [{
        phase: "seed" as const,
        query: "部署方式与边界",
        aspectIds: ["A1"],
        status: "success" as const,
        plannedQueryIndexes: [1, 0],
      }],
    },
    {
      name: "planned query provenance on a supplemental query",
      queries: [{
        phase: "supplemental" as const,
        query: "部署边界",
        aspectIds: ["A1"],
        status: "success" as const,
        plannedQueryIndexes: [0],
      }],
    },
    {
      name: "missing planned query provenance",
      queries: [{
        phase: "seed" as const,
        query: "部署边界",
        aspectIds: ["A1"],
        status: "success" as const,
        plannedQueryIndexes: undefined as unknown as readonly number[],
      }],
    },
  ])("rejects $name", ({ queries, requirementQueries }) => {
    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        queries,
        ...(requirementQueries === undefined
          ? {}
          : {
              requirement: {
                ...unit().requirement,
                queries: requirementQueries,
              },
            }),
      })],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({
      code: "invalid_planned_query_index",
    }));
  });

  it("accepts an unplanned seed query and requires supplemental provenance to stay empty", () => {
    const ledger = finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        queries: [
          ...unit().queries,
          {
            phase: "seed",
            query: "当前问题宽泛搜索",
            aspectIds: ["A1"],
            status: "empty",
            plannedQueryIndexes: [],
          },
          {
            phase: "supplemental",
            query: "部署补充搜索",
            aspectIds: ["A1"],
            status: "empty",
            plannedQueryIndexes: [],
          },
        ],
      })],
    });

    expect(ledger.units[0]?.queries.map((query) => query.plannedQueryIndexes)).toEqual([
      [0],
      [],
      [],
    ]);
  });

  it.each([
    {
      name: "none coverage omits a planned missing aspect",
      verification: {
        coverage: "none" as const,
        reason: "target_omitted" as const,
        coveredAspectIds: [],
        missingAspectIds: ["A1"],
      },
    },
    {
      name: "partial coverage omits a planned aspect",
      verification: {
        coverage: "partial" as const,
        reason: "partial_support" as const,
        coveredAspectIds: ["A1"],
        missingAspectIds: ["A2"],
      },
    },
    {
      name: "covered aspects are not in plan order",
      verification: {
        coverage: "partial" as const,
        reason: "partial_support" as const,
        coveredAspectIds: ["A2", "A1"],
        missingAspectIds: ["A3"],
      },
    },
    {
      name: "partial coverage has no missing aspect",
      verification: {
        coverage: "partial" as const,
        reason: "partial_support" as const,
        coveredAspectIds: ["A1", "A2", "A3"],
        missingAspectIds: [],
      },
    },
  ])("rejects an incomplete or inconsistent aspect partition when $name", ({ verification }) => {
    const threeAspectRequirement = {
      ...unit().requirement,
      evidenceAspects: [
        { id: "A1", label: "部署方式", terms: ["部署"] },
        { id: "A2", label: "容量边界", terms: ["容量"] },
        { id: "A3", label: "高可用边界", terms: ["高可用"] },
      ],
      queries: [{ text: "部署 容量 高可用", aspectIds: ["A1", "A2", "A3"] }],
    };

    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        requirement: threeAspectRequirement,
        queries: [{
          phase: "seed",
          query: "部署 容量 高可用",
          aspectIds: ["A1", "A2", "A3"],
          status: "empty",
          plannedQueryIndexes: [0],
        }],
        verification,
      })],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({
      code: "verification_aspect_partition_invalid",
    }));
  });

  it("accepts partial coverage with a complete ordered partition even when nothing was covered", () => {
    const ledger = finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({
        verification: {
          coverage: "partial",
          reason: "partial_support",
          coveredAspectIds: [],
          missingAspectIds: ["A1"],
        },
      })],
    });

    expect(ledger.units[0]?.verification).toMatchObject({
      coverage: "partial",
      coveredAspectIds: [],
      missingAspectIds: ["A1"],
      covered: true,
      missing: true,
    });
  });

  it.each([
    {
      name: "a graph source outside candidates",
      graphs: [{ sourcePath: "wiki/unknown.md", status: "empty" as const, hitCount: 0 }],
      code: "graph_candidate_missing",
    },
    {
      name: "a successful graph lookup without hits",
      graphs: [{ sourcePath: "wiki/deployment.md", status: "success" as const, hitCount: 0 }],
      code: "invalid_graph_record",
    },
    {
      name: "an empty graph lookup with hits",
      graphs: [{ sourcePath: "wiki/deployment.md", status: "empty" as const, hitCount: 1 }],
      code: "invalid_graph_record",
    },
    {
      name: "an unavailable graph lookup with hits",
      graphs: [{ sourcePath: "wiki/deployment.md", status: "unavailable" as const, hitCount: 1 }],
      code: "invalid_graph_record",
    },
  ])("rejects $name", ({ graphs, code }) => {
    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [unit({ graphs })],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({ code }));
  });

  it.each([
    {
      name: "cross-domain project",
      draft: unit({
        binding: {
          ...unit().binding,
          domain: "presales-general",
        },
      }),
      code: "project_domain_mismatch",
    },
    {
      name: "read outside candidates",
      draft: unit({
        reads: [{ path: "wiki/unknown.md", status: "unavailable" }],
      }),
      code: "read_candidate_missing",
    },
    {
      name: "claim citation outside successful reads",
      draft: unit({
        claims: [{
          claimIndex: 0,
          status: "retained_direct",
          citations: [2],
          coveredAspectIds: ["A1"],
        }],
      }),
      code: "claim_citation_not_read",
    },
    {
      name: "incomplete aspect partition",
      draft: unit({
        verification: {
          coverage: "partial",
          reason: "partial_support",
          coveredAspectIds: [],
          missingAspectIds: [],
        },
      }),
      code: "verification_aspect_partition_invalid",
    },
    {
      name: "candidate without execution provenance",
      draft: unit({
        candidates: [{
          ...unit().candidates[0]!,
          sources: [],
        }],
      }),
      code: "invalid_candidate",
    },
    {
      name: "negative retrieval counters",
      draft: unit({
        retrieval: {
          ...unit().retrieval,
          toolUnavailableCount: -1,
        },
      }),
      code: "invalid_boundary_metadata",
    },
  ])("fails closed for $name", ({ draft, code }) => {
    expect(() => finalizeEvidenceLedger({
      project: "coremail-professional",
      revision,
      units: [draft],
    })).toThrowError(expect.objectContaining<Partial<EvidenceLedgerValidationError>>({
      code,
    }));
  });
});
