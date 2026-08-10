import { describe, expect, it } from "vitest";
import {
  classifyEvidenceGap,
  summarizeEvidenceGapAudit,
  type EvidenceGapAuditObservation,
} from "./audit-reliability-evidence-gaps-contract.js";

describe("reliability evidence-gap audit contract", () => {
  it("allows source_absent only after exhaustive retrieval and human confirmation", () => {
    expect(classifyEvidenceGap(observation())).toMatchObject({
      classification: "source_absent",
      defectOwner: "knowledge",
      recommendedRepository: "coremail-professional",
    });
  });

  it.each([
    {
      name: "an unavailable search",
      patch: { queryStatuses: ["success", "unavailable"] as const },
      expected: "retrieval_unavailable",
    },
    {
      name: "an unread candidate",
      patch: { candidateCount: 2, unreadCandidateCount: 1 },
      expected: "candidate_not_read",
    },
    {
      name: "a failed read",
      patch: { candidateCount: 1, failedReadCount: 1 },
      expected: "read_unavailable",
    },
    {
      name: "ambiguous evidence",
      patch: { ambiguous: true },
      expected: "evidence_ambiguous",
    },
    {
      name: "conflicting evidence",
      patch: { conflictDetected: true },
      expected: "evidence_conflict",
    },
    {
      name: "missing customer input",
      patch: { inputState: "missing" as const },
      expected: "customer_input_required",
    },
    {
      name: "unknown human gold",
      patch: { humanGold: "unknown" as const },
      expected: "human_review_required",
    },
    {
      name: "human-confirmed source present but not retrieved",
      patch: { humanGold: "source_present" as const },
      expected: "candidate_not_recalled",
    },
  ])("does not call $name a knowledge gap", ({ patch, expected }) => {
    expect(classifyEvidenceGap(observation(patch))).toMatchObject({
      classification: expected,
      defectOwner: expected === "customer_input_required" ? "input" : "system",
    });
  });

  it("does not treat read but non-supporting candidates as absent source", () => {
    expect(classifyEvidenceGap(observation({
      candidateCount: 2,
      readCandidateCount: 2,
      humanGold: "source_absent",
    }))).toMatchObject({
      classification: "evidence_insufficient",
      defectOwner: "knowledge",
    });
  });

  it("summarizes owners and knowledge-repository recommendations separately", () => {
    const report = summarizeEvidenceGapAudit([
      observation(),
      observation({
        id: "N02/R1/A1",
        domain: "presales-general",
      }),
      observation({
        id: "N03/R1/A1",
        queryStatuses: ["unavailable"],
      }),
    ]);

    expect(report).toMatchObject({
      total: 3,
      sourceAbsentCount: 2,
      byOwner: { knowledge: 2, system: 1, input: 0, none: 0 },
      repositoryRecommendations: {
        "coremail-professional": 1,
        "presales-general": 1,
      },
    });
  });
});

function observation(
  patch: Partial<EvidenceGapAuditObservation> = {},
): EvidenceGapAuditObservation {
  return {
    id: "N01/R1/A1",
    caseId: "N01",
    domain: "coremail-professional",
    requirementId: "R1",
    obligationId: "O1",
    aspectId: "A1",
    queryStatuses: ["empty"],
    plannedQueryCount: 1,
    completedPlannedQueryCount: 1,
    candidateCount: 0,
    readCandidateCount: 0,
    unreadCandidateCount: 0,
    failedReadCount: 0,
    accessDeniedCount: 0,
    toolUnavailableCount: 0,
    retrievalBudgetExhausted: false,
    ambiguous: false,
    conflictDetected: false,
    staleOrUnconfirmed: false,
    inputState: "not_applicable",
    humanGold: "source_absent",
    ...patch,
  };
}
