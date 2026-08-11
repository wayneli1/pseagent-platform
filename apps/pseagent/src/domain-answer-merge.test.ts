import { describe, expect, it } from "vitest";
import type { FinalAction, Reference } from "./contracts.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import type { CoverageVerificationReport } from "./coverage-verifier.js";
import { analyzeCoverageGaps } from "./coverage-gap.js";
import { finalizeEvidenceLedger } from "./evidence-ledger.js";
import {
  DomainAnswerMergeError,
  mergeDetailedDomainResults,
  type DetailedDomainResult,
} from "./domain-answer-merge.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function plan(
  domain: DomainKnowledgePlan["domain"],
  obligationId: string,
  order: number,
): DomainKnowledgePlan {
  const scope = domain === "coremail-professional" ? "professional" : "general";
  return {
    domain,
    scope,
    plan: {
      subject: "联合问题",
      retrievalStrategy: "coverage_units",
      requirements: [{
        id: "R1",
        question: `${domain} question`,
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [{ id: "A1", label: "目标", terms: ["目标"] }],
        queries: [{ text: "目标", aspectIds: ["A1"] }],
      }],
    },
    bindings: [{
      domain,
      requirementId: "R1",
      deliverableId: `D${order + 1}`,
      obligationId,
      order,
    }],
  };
}

function reference(
  project: Reference["project"],
  revision: string,
  path: string,
  contentHash: string,
  index = 1,
): Reference {
  return { index, project, revision, path, contentHash, title: path };
}

function result(
  domain: DetailedDomainResult["domain"],
  action: FinalAction,
  references: readonly Reference[],
): DetailedDomainResult {
  const revision = references[0]?.revision ?? `${domain}-revision`;
  return { domain, project: domain, revision, action, references };
}

const complete = (answer: string): FinalAction => ({
  action: "final",
  requirements: [{ id: "R1", coverage: "complete", answer, citations: [1] }],
  citations: [1],
});

function missingResultWithMetadata(
  domainPlan: DomainKnowledgePlan,
  revision: string,
): DetailedDomainResult {
  const requirement = domainPlan.plan.requirements[0]!;
  const action: FinalAction = {
    action: "final",
    requirements: [{
      id: "R1",
      coverage: "none",
      answer: "当前正式资料未覆盖该项。",
      citations: [],
    }],
    citations: [],
  };
  const evidenceLedger = finalizeEvidenceLedger({
    project: domainPlan.domain,
    revision,
    units: [{
      binding: domainPlan.bindings[0]!,
      subject: domainPlan.plan.subject,
      requirement,
      queries: [{
        phase: "seed",
        query: requirement.queries[0]!.text,
        aspectIds: requirement.queries[0]!.aspectIds,
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
    }],
  });
  const verification: CoverageVerificationReport = {
    summaries: [{
      id: "R1",
      reason: "target_omitted",
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 0,
      coveredAspectCount: 0,
      missingAspectCount: 1,
      coveredAspectIds: [],
      missingAspectIds: ["A1"],
      claimDecisions: [],
    }],
    coveredRequirementIds: [],
    missingRequirementIds: ["R1"],
  };
  return {
    domain: domainPlan.domain,
    project: domainPlan.domain,
    revision,
    action,
    references: [],
    verification,
    evidenceLedger,
    coverageGaps: analyzeCoverageGaps(evidenceLedger),
  };
}

function completeResultWithMetadata(
  domainPlan: DomainKnowledgePlan,
  revision: string,
  path: string,
  contentHash: string,
): DetailedDomainResult {
  const requirement = domainPlan.plan.requirements[0]!;
  const action = complete("已核验事实[1]。");
  const evidenceLedger = finalizeEvidenceLedger({
    project: domainPlan.domain,
    revision,
    units: [{
      binding: domainPlan.bindings[0]!,
      subject: domainPlan.plan.subject,
      requirement,
      queries: requirement.queries.map((query, plannedQueryIndex) => ({
        phase: "seed" as const,
        query: query.text,
        aspectIds: query.aspectIds,
        status: "success" as const,
        plannedQueryIndexes: [plannedQueryIndex],
      })),
      candidates: [{
        path,
        title: path,
        sources: ["seed"],
        aspectIds: ["A1"],
        reviewRequired: false,
      }],
      reads: [{
        path,
        status: "success",
        citation: 1,
        pageType: "guide",
        sources: [],
      }],
      graphs: [],
      claims: [{
        claimIndex: 0,
        status: "retained_synthesized",
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
        reason: "synthesized_support",
        coveredAspectIds: ["A1"],
        missingAspectIds: [],
      },
    }],
  });
  return {
    domain: domainPlan.domain,
    project: domainPlan.domain,
    revision,
    action,
    references: [reference(domainPlan.domain, revision, path, contentHash)],
    verification: {
      summaries: [{
        id: "R1",
        reason: "synthesized_support",
        retainedDirectSegmentCount: 0,
        retainedSynthesizedSegmentCount: 1,
        removedSegmentCount: 0,
        coveredAspectCount: 1,
        missingAspectCount: 0,
        coveredAspectIds: ["A1"],
        missingAspectIds: [],
        claimDecisions: [{
          claimIndex: 0,
          status: "retained_synthesized",
          citations: [1],
          coveredAspectIds: ["A1"],
        }],
      }],
      coveredRequirementIds: ["R1"],
      missingRequirementIds: [],
    },
    evidenceLedger,
    coverageGaps: [],
  };
}

describe("mergeDetailedDomainResults", () => {
  it("merges evidence metadata by global obligation order without mixing snapshots", () => {
    const professionalPlan = plan("coremail-professional", "O2", 1);
    const generalPlan = plan("presales-general", "O1", 0);
    const professional = missingResultWithMetadata(
      professionalPlan,
      "a".repeat(40),
    );
    const general = missingResultWithMetadata(generalPlan, "b".repeat(40));

    const merged = mergeDetailedDomainResults({
      plans: [professionalPlan, generalPlan],
      results: [general, professional],
    });

    expect(merged.domainEvidenceLedgers?.map((ledger) => ledger.project)).toEqual([
      "coremail-professional",
      "presales-general",
    ]);
    expect(merged.coverageGaps).toMatchObject([
      {
        id: "G1",
        requirementId: "R1",
        obligationId: "O1",
        domain: "presales-general",
      },
      {
        id: "G2",
        requirementId: "R2",
        obligationId: "O2",
        domain: "coremail-professional",
      },
    ]);
    expect(merged.verification).toMatchObject({
      coveredRequirementIds: [],
      missingRequirementIds: ["R1", "R2"],
      summaries: [{ id: "R1" }, { id: "R2" }],
    });
  });

  it("rewrites verification claim citations into the merged global reference space", () => {
    const professionalPlan = plan("coremail-professional", "O1", 0);
    const generalPlan = plan("presales-general", "O2", 1);
    const merged = mergeDetailedDomainResults({
      plans: [professionalPlan, generalPlan],
      results: [
        completeResultWithMetadata(
          professionalPlan,
          "a".repeat(40),
          "wiki/professional.md",
          HASH_A,
        ),
        completeResultWithMetadata(
          generalPlan,
          "b".repeat(40),
          "wiki/general.md",
          HASH_B,
        ),
      ],
    });

    expect(merged.references.map((item) => item.index)).toEqual([1, 2]);
    expect(merged.verification?.summaries.map((summary) =>
      summary.claimDecisions[0]?.citations)).toEqual([[1], [2]]);
  });

  it("is deterministic by obligation and domain order, not completion order", () => {
    const plans = [
      plan("coremail-professional", "O1", 0),
      plan("presales-general", "O2", 1),
    ];
    const professional = result(
      "coremail-professional",
      complete("专业事实[1]。"),
      [reference("coremail-professional", "p-rev", "wiki/p.md", HASH_A)],
    );
    const general = result(
      "presales-general",
      {
        action: "final",
        requirements: [{
          id: "R1",
          coverage: "none",
          answer: "正式售前库未覆盖客户当前决策链。",
          citations: [],
          relatedContext: [{ statement: "通用资料仅说明访谈方法[1]。", citations: [1] }],
        }],
        citations: [1],
      },
      [reference("presales-general", "g-rev", "wiki/g.md", HASH_B)],
    );

    const first = mergeDetailedDomainResults({ plans, results: [general, professional] });
    const second = mergeDetailedDomainResults({ plans, results: [professional, general] });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      domainsUsed: ["coremail-professional", "presales-general"],
      action: {
        requirements: [
          { id: "R1", answer: "专业事实[1]。", citations: [1] },
          {
            id: "R2",
            coverage: "none",
            answer: "正式售前库未覆盖客户当前决策链。",
            relatedContext: [{ statement: "通用资料仅说明访谈方法[2]。", citations: [2] }],
          },
        ],
        citations: [1, 2],
      },
      references: [
        { index: 1, project: "coremail-professional" },
        { index: 2, project: "presales-general" },
      ],
    });
  });

  it("preserves a verified domain and exposes an explicit gap when its sibling is unavailable", () => {
    const professionalPlan = plan("coremail-professional", "O1", 0);
    const generalPlan = plan("presales-general", "O2", 1);
    const general = result(
      "presales-general",
      complete("已核验通用治理方法[1]。"),
      [reference("presales-general", "g-rev", "wiki/governance.md", HASH_B)],
    );

    const merged = mergeDetailedDomainResults({
      plans: [professionalPlan, generalPlan],
      results: [general],
      failures: [{
        domain: "coremail-professional",
        reason: "agent_unavailable",
        rootReason: "model_unavailable",
      }],
    });

    expect(merged.domainsUsed).toEqual([
      "coremail-professional",
      "presales-general",
    ]);
    expect(merged.action).toMatchObject({
      requirements: [
        { id: "R1", coverage: "none", citations: [] },
        { id: "R2", coverage: "complete", answer: "已核验通用治理方法[1]。" },
      ],
      citations: [1],
    });
    expect(merged.references).toMatchObject([{
      index: 1,
      project: "presales-general",
    }]);
    expect(merged.coverageGaps).toMatchObject([{
      id: "G1",
      requirementId: "R1",
      deliverableId: "D1",
      obligationId: "O1",
      domain: "coremail-professional",
      gapClass: "retrieval",
      reason: "tool_unavailable",
      affectsConclusion: true,
    }]);
    expect(merged.verification).toBeUndefined();
    expect(merged.domainEvidenceLedgers).toBeUndefined();
  });

  it("accepts sparse local registry indexes and rewrites them densely", () => {
    const domainPlan = plan("presales-general", "O1", 0);
    const merged = mergeDetailedDomainResults({
      plans: [domainPlan],
      results: [result(
        "presales-general",
        {
          action: "final",
          requirements: [{
            id: "R1",
            coverage: "complete",
            answer: "已核验的方法[3]。",
            citations: [3],
          }],
          citations: [3],
        },
        [reference(
          "presales-general",
          "g-rev",
          "wiki/sparse.md",
          HASH_A,
          3,
        )],
      )],
    });

    expect(merged.action).toMatchObject({
      requirements: [{ answer: "已核验的方法[1]。", citations: [1] }],
      citations: [1],
    });
    expect(merged.references).toMatchObject([{
      index: 1,
      project: "presales-general",
      path: "wiki/sparse.md",
    }]);
  });

  it("deduplicates only an exact project revision path and hash identity", () => {
    const domainPlan: DomainKnowledgePlan = {
      ...plan("coremail-professional", "O1", 0),
      plan: {
        ...plan("coremail-professional", "O1", 0).plan,
        requirements: [
          plan("coremail-professional", "O1", 0).plan.requirements[0]!,
          { ...plan("coremail-professional", "O1", 0).plan.requirements[0]!, id: "R2" },
        ],
      },
      bindings: [
        plan("coremail-professional", "O1", 0).bindings[0]!,
        {
          domain: "coremail-professional",
          requirementId: "R2",
          deliverableId: "D2",
          obligationId: "O2",
          order: 1,
        },
      ],
    };
    const duplicateReferences = [
      reference("coremail-professional", "rev", "wiki/same.md", HASH_A, 1),
      reference("coremail-professional", "rev", "wiki/same.md", HASH_A, 2),
    ];
    const merged = mergeDetailedDomainResults({
      plans: [domainPlan],
      results: [result("coremail-professional", {
        action: "final",
        requirements: [
          { id: "R1", coverage: "complete", answer: "第一项[1]。", citations: [1] },
          { id: "R2", coverage: "complete", answer: "第二项[2]。", citations: [2] },
        ],
        citations: [1, 2],
      }, duplicateReferences)],
    });
    expect(merged.references).toHaveLength(1);
    expect(merged.action.requirements[1]).toMatchObject({ answer: "第二项[1]。", citations: [1] });

    const distinct = mergeDetailedDomainResults({
      plans: [domainPlan],
      results: [result("coremail-professional", {
        action: "final",
        requirements: [
          { id: "R1", coverage: "complete", answer: "第一项[1]。", citations: [1] },
          { id: "R2", coverage: "complete", answer: "第二项[2]。", citations: [2] },
        ],
        citations: [1, 2],
      }, [
        duplicateReferences[0]!,
        reference("coremail-professional", "rev", "wiki/same.md", HASH_B, 2),
      ])],
    });
    expect(distinct.references).toHaveLength(2);
  });

  it("keeps same-path evidence separate across projects and rejects revision drift", () => {
    const professional = result(
      "coremail-professional",
      complete("专业事实[1]。"),
      [reference("coremail-professional", "p-rev", "wiki/same.md", HASH_A)],
    );
    const general = result(
      "presales-general",
      complete("通用方法[1]。"),
      [reference("presales-general", "g-rev", "wiki/same.md", HASH_A)],
    );
    const merged = mergeDetailedDomainResults({
      plans: [
        plan("coremail-professional", "O1", 0),
        plan("presales-general", "O2", 1),
      ],
      results: [professional, general],
    });
    expect(merged.references).toMatchObject([
      { index: 1, project: "coremail-professional", revision: "p-rev" },
      { index: 2, project: "presales-general", revision: "g-rev" },
    ]);

    expect(() => mergeDetailedDomainResults({
      plans: [plan("coremail-professional", "O1", 0)],
      results: [{
        ...professional,
        references: [{ ...professional.references[0]!, revision: "other-rev" }],
      }],
    })).toThrowError(expect.objectContaining<Partial<DomainAnswerMergeError>>({
      code: "snapshot_mismatch",
    }));
  });

  it.each([
    {
      name: "unknown local citation",
      mutate: (domainResult: DetailedDomainResult) => ({
        ...domainResult,
        action: {
          action: "final" as const,
          requirements: [{
            id: "R1" as const,
            coverage: "complete" as const,
            answer: "不存在的引用[2]。",
            citations: [2],
          }],
          citations: [2],
        },
      }),
      code: "unknown_local_citation",
    },
    {
      name: "project mismatch",
      mutate: (domainResult: DetailedDomainResult) => ({
        ...domainResult,
        references: [{ ...domainResult.references[0]!, project: "presales-general" as const }],
      }),
      code: "snapshot_mismatch",
    },
    {
      name: "missing obligation binding",
      mutate: (domainResult: DetailedDomainResult) => ({
        ...domainResult,
        action: {
          ...domainResult.action,
          requirements: [{ ...domainResult.action.requirements[0]!, id: "R2" as const }],
        },
      }),
      code: "requirement_binding_mismatch",
    },
  ])("fails closed for $name", ({ mutate, code }) => {
    const professional = result(
      "coremail-professional",
      complete("专业事实[1]。"),
      [reference("coremail-professional", "p-rev", "wiki/p.md", HASH_A)],
    );
    expect(() => mergeDetailedDomainResults({
      plans: [plan("coremail-professional", "O1", 0)],
      results: [mutate(professional)],
    })).toThrowError(expect.objectContaining<Partial<DomainAnswerMergeError>>({ code }));
  });

  it("fails closed when answer and citation metadata diverge", () => {
    expect(() => mergeDetailedDomainResults({
      plans: [plan("coremail-professional", "O1", 0)],
      results: [result(
        "coremail-professional",
        complete("缺少正文引用。"),
        [reference("coremail-professional", "p-rev", "wiki/p.md", HASH_A)],
      )],
    })).toThrowError(expect.objectContaining<Partial<DomainAnswerMergeError>>({
      code: "citation_metadata_mismatch",
    }));
  });
});
