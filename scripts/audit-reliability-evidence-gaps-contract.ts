export type EvidenceAuditDomain =
  | "coremail-professional"
  | "presales-general";
export type EvidenceAuditHumanGold =
  | "source_present"
  | "source_absent"
  | "unknown";
export type EvidenceAuditQueryStatus =
  | "success"
  | "empty"
  | "unavailable"
  | "not_applicable";

export interface EvidenceGapAuditObservation {
  readonly id: string;
  readonly caseId: string;
  readonly domain: EvidenceAuditDomain;
  readonly requirementId: string;
  readonly obligationId: string;
  readonly aspectId: string;
  readonly queryStatuses: readonly EvidenceAuditQueryStatus[];
  readonly plannedQueryCount: number;
  readonly completedPlannedQueryCount: number;
  readonly candidateCount: number;
  readonly readCandidateCount: number;
  readonly unreadCandidateCount: number;
  readonly failedReadCount: number;
  readonly accessDeniedCount: number;
  readonly toolUnavailableCount: number;
  readonly retrievalBudgetExhausted: boolean;
  readonly ambiguous: boolean;
  readonly conflictDetected: boolean;
  readonly staleOrUnconfirmed: boolean;
  readonly inputState: "not_applicable" | "available" | "missing";
  readonly humanGold: EvidenceAuditHumanGold;
}

export type EvidenceGapClassification =
  | "source_absent"
  | "candidate_not_recalled"
  | "candidate_not_read"
  | "read_unavailable"
  | "retrieval_unavailable"
  | "evidence_insufficient"
  | "evidence_ambiguous"
  | "evidence_conflict"
  | "evidence_stale"
  | "customer_input_required"
  | "human_review_required";

export interface EvidenceGapAuditDecision {
  readonly observation: EvidenceGapAuditObservation;
  readonly classification: EvidenceGapClassification;
  readonly defectOwner: "knowledge" | "system" | "input" | "none";
  readonly recommendedRepository?: EvidenceAuditDomain;
  readonly rationale: string;
}

export function classifyEvidenceGap(
  observation: EvidenceGapAuditObservation,
): EvidenceGapAuditDecision {
  validateObservation(observation);
  const decide = (
    classification: EvidenceGapClassification,
    defectOwner: EvidenceGapAuditDecision["defectOwner"],
    rationale: string,
    recommendedRepository?: EvidenceAuditDomain,
  ): EvidenceGapAuditDecision => ({
    observation,
    classification,
    defectOwner,
    rationale,
    ...(recommendedRepository === undefined ? {} : { recommendedRepository }),
  });

  if (observation.inputState === "missing") {
    return decide(
      "customer_input_required",
      "input",
      "The conclusion depends on case-specific customer input that was not supplied.",
    );
  }
  if (observation.ambiguous) {
    return decide(
      "evidence_ambiguous",
      "system",
      "The requirement or applicable evidence boundary is ambiguous.",
    );
  }
  if (observation.conflictDetected) {
    return decide(
      "evidence_conflict",
      "system",
      "Retrieved formal sources conflict and require an applicability decision.",
    );
  }
  if (observation.staleOrUnconfirmed) {
    return decide(
      "evidence_stale",
      "system",
      "The available source revision or applicability is stale or unconfirmed.",
    );
  }
  if (
    observation.queryStatuses.includes("unavailable") ||
    observation.toolUnavailableCount > 0 ||
    observation.retrievalBudgetExhausted ||
    observation.completedPlannedQueryCount < observation.plannedQueryCount
  ) {
    return decide(
      "retrieval_unavailable",
      "system",
      "At least one required retrieval layer did not complete successfully.",
    );
  }
  if (observation.failedReadCount > 0 || observation.accessDeniedCount > 0) {
    return decide(
      "read_unavailable",
      "system",
      "At least one candidate could not be read or access was denied.",
    );
  }
  if (
    observation.unreadCandidateCount > 0 ||
    observation.readCandidateCount < observation.candidateCount
  ) {
    return decide(
      "candidate_not_read",
      "system",
      "At least one recalled candidate was not read, so absence is unproven.",
    );
  }
  if (observation.humanGold === "unknown") {
    return decide(
      "human_review_required",
      "system",
      "No independent human decision confirms whether a formal source exists.",
    );
  }
  if (observation.humanGold === "source_present") {
    return decide(
      "candidate_not_recalled",
      "system",
      "Human gold confirms a formal source, but retrieval did not produce supporting evidence.",
    );
  }
  if (observation.candidateCount > 0) {
    return decide(
      "evidence_insufficient",
      "knowledge",
      "All recalled candidates were read but none directly supports the required aspect.",
    );
  }

  return decide(
    "source_absent",
    "knowledge",
    "All planned retrieval completed without candidates and human gold confirms no formal source.",
    observation.domain,
  );
}

export function summarizeEvidenceGapAudit(
  observations: readonly EvidenceGapAuditObservation[],
): {
  readonly total: number;
  readonly sourceAbsentCount: number;
  readonly byClassification: Readonly<Record<EvidenceGapClassification, number>>;
  readonly byOwner: Readonly<Record<EvidenceGapAuditDecision["defectOwner"], number>>;
  readonly repositoryRecommendations: Readonly<Record<EvidenceAuditDomain, number>>;
  readonly decisions: readonly EvidenceGapAuditDecision[];
} {
  const decisions = observations.map(classifyEvidenceGap);
  const classifications: EvidenceGapClassification[] = [
    "source_absent",
    "candidate_not_recalled",
    "candidate_not_read",
    "read_unavailable",
    "retrieval_unavailable",
    "evidence_insufficient",
    "evidence_ambiguous",
    "evidence_conflict",
    "evidence_stale",
    "customer_input_required",
    "human_review_required",
  ];
  const count = <T>(items: readonly T[], value: T): number =>
    items.filter((item) => item === value).length;
  return {
    total: decisions.length,
    sourceAbsentCount: decisions.filter((item) =>
      item.classification === "source_absent").length,
    byClassification: Object.fromEntries(classifications.map((classification) => [
      classification,
      decisions.filter((item) => item.classification === classification).length,
    ])) as Record<EvidenceGapClassification, number>,
    byOwner: Object.fromEntries((["knowledge", "system", "input", "none"] as const)
      .map((owner) => [owner, count(decisions.map((item) => item.defectOwner), owner)])) as
      Record<EvidenceGapAuditDecision["defectOwner"], number>,
    repositoryRecommendations: {
      "coremail-professional": decisions.filter((item) =>
        item.recommendedRepository === "coremail-professional").length,
      "presales-general": decisions.filter((item) =>
        item.recommendedRepository === "presales-general").length,
    },
    decisions,
  };
}

function validateObservation(observation: EvidenceGapAuditObservation): void {
  const counts = [
    observation.plannedQueryCount,
    observation.completedPlannedQueryCount,
    observation.candidateCount,
    observation.readCandidateCount,
    observation.unreadCandidateCount,
    observation.failedReadCount,
    observation.accessDeniedCount,
    observation.toolUnavailableCount,
  ];
  if (
    !observation.id.trim() ||
    !observation.caseId.trim() ||
    !/^R[1-6]$/u.test(observation.requirementId) ||
    !/^O[1-9]\d*$/u.test(observation.obligationId) ||
    !/^A[1-9]\d*$/u.test(observation.aspectId) ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    observation.completedPlannedQueryCount > observation.plannedQueryCount ||
    observation.readCandidateCount > observation.candidateCount
  ) {
    throw new Error("invalid_evidence_gap_audit_observation");
  }
}
