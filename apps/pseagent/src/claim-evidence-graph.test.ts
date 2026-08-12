import { describe, expect, it } from "vitest";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type {
  ClaimDraft,
  BoundClaim,
} from "./structured-claim.js";
import type { DeterministicRetrievalResult } from "./deterministic-retrieval.js";
import {
  bindClaimsToEvidence,
  mergeBoundDomainClaims,
} from "./claim-evidence-graph.js";

const reference = {
  index: 1,
  project: "coremail-professional" as const,
  revision: "a".repeat(40),
  title: "迁移能力",
  path: "wiki/queries/migration.md",
  contentHash: "b".repeat(64),
};

const contract: AtomicObligationContract = {
  subject: "迁移",
  sourceQuestion: "说明迁移能力和推进方法",
  obligations: [
    {
      id: "O1",
      sourceSpan: { start: 2, end: 6 },
      sourceText: "迁移能力",
      kind: "fact",
      targetEntityIds: [],
      domains: ["coremail-professional"],
      evidencePolicy: "direct",
      evidenceTypes: ["formal_page"],
      risk: "low",
      completionCriteria: ["claim_supported"],
      required: true,
    },
    {
      id: "O2",
      sourceSpan: { start: 7, end: 11 },
      sourceText: "推进方法",
      kind: "procedure",
      targetEntityIds: [],
      domains: ["presales-general"],
      evidencePolicy: "synthesis",
      evidenceTypes: ["method"],
      risk: "low",
      completionCriteria: ["claim_supported"],
      required: true,
    },
  ],
};

function retrieval(sourceBoundary: "formal" | "summary_only" = "formal"):
  DeterministicRetrievalResult {
  return {
    project: "coremail-professional",
    revision: reference.revision,
    evidence: [{
      requirementId: "R1",
      obligationId: "O1",
      domain: "coremail-professional",
      citation: 1,
      path: reference.path,
      title: reference.title,
      compactContent: "Coremail 迁移能力正式说明。",
      aspectIds: ["A1"],
      aspectRequirements: [{
        id: "A1",
        label: "migration capability",
        terms: ["migration", "capability"],
      }],
      sourceBoundary,
    }],
    references: [reference],
    evidenceLedger: {} as never,
  };
}

function claim(overrides: Partial<ClaimDraft> = {}): ClaimDraft {
  return {
    claimId: "CL1",
    obligationId: "O1",
    domain: "coremail-professional",
    text: "Coremail 支持迁移。",
    kind: "fact",
    citationIndexes: [1],
    coveredAspectIds: ["A1"],
    ...overrides,
  };
}

describe("claim evidence graph", () => {
  it.each([
    claim({ domain: "presales-general" }),
    claim({ citationIndexes: [2] }),
    claim({ obligationId: "O2" }),
    claim({ citationIndexes: [] }),
  ])("rejects a claim without local verified evidence", (draft) => {
    const result = bindClaimsToEvidence({
      claims: [draft],
      contract,
      retrievals: [retrieval()],
    });
    expect(result.retained).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects appendix-only evidence for a direct obligation", () => {
    const result = bindClaimsToEvidence({
      claims: [claim()],
      contract,
      retrievals: [retrieval("summary_only")],
    });
    expect(result.retained).toHaveLength(0);
  });

  it("accepts a claim bound to a read citation in the same obligation and domain", () => {
    const result = bindClaimsToEvidence({
      claims: [claim()],
      contract,
      retrievals: [retrieval()],
    });
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.evidenceIdentities[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds one deduplicated reference independently to multiple obligations", () => {
    const sharedContract: AtomicObligationContract = {
      ...contract,
      obligations: contract.obligations.map((obligation) => ({
        ...obligation,
        domains: ["coremail-professional"],
        evidencePolicy: "direct",
      })),
    };
    const first = retrieval();
    const sharedRetrieval: DeterministicRetrievalResult = {
      ...first,
      evidence: [
        first.evidence[0]!,
        {
          ...first.evidence[0]!,
          requirementId: "R2",
          obligationId: "O2",
        },
      ],
    };

    const result = bindClaimsToEvidence({
      claims: [
        claim(),
        claim({ claimId: "CL2", obligationId: "O2" }),
      ],
      contract: sharedContract,
      retrievals: [sharedRetrieval],
    });

    expect(result.rejected).toEqual([]);
    expect(result.retained.map((item) => item.obligationId)).toEqual(["O1", "O2"]);
  });

  it("remaps local domain citations to stable global references", () => {
    const first: BoundClaim = {
      ...claim(),
      support: "direct",
      evidenceIdentities: [reference.contentHash],
    };
    const second: BoundClaim = {
      ...first,
      claimId: "CL2",
    };
    const merged = mergeBoundDomainClaims({
      domains: [
        { claims: [first], references: [reference] },
        { claims: [second], references: [reference] },
      ],
    });
    expect(merged.references).toHaveLength(1);
    expect(merged.claims.flatMap((item) => item.citationIndexes)).toEqual([1, 1]);
  });
});
