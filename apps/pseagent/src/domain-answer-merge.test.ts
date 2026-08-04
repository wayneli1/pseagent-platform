import { describe, expect, it } from "vitest";
import type { FinalAction, Reference } from "./contracts.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
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

describe("mergeDetailedDomainResults", () => {
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
