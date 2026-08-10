import {
  coverageSchema,
  coverageVerificationReasonSchema,
  knowledgeRequirementSchema,
  type Coverage,
  type CoverageVerificationReason,
  type KnowledgeRequirement,
} from "./contracts.js";
import type { DomainRequirementBinding } from "./domain-plan.js";
import type { ProjectKey } from "./knowledge-session.js";

export type EvidenceQueryStatus =
  | "success"
  | "empty"
  | "unavailable"
  | "not_applicable";
export type EvidenceGraphStatus = "success" | "empty" | "unavailable";
export type EvidenceCandidateSource = "seed" | "supplemental" | "graph";
export type EvidenceReadStatus = "success" | "access_denied" | "unavailable";
export type EvidenceClaimStatus =
  | "retained_direct"
  | "retained_synthesized"
  | "removed";
export type EvidenceSourceBoundary = "formal" | "summary_only" | "external_only";
export type EvidenceFreshness = "not_assessed" | "current" | "stale_or_unconfirmed";
export type EvidenceInputState = "not_applicable" | "available" | "missing";

export interface RequirementEvidenceCondition {
  readonly requirementId: string;
  readonly conflictDetected: boolean;
  readonly freshness: EvidenceFreshness;
  readonly inputState: EvidenceInputState;
  readonly ambiguous: boolean;
}

export interface EvidenceQueryDraft {
  readonly phase: "seed" | "supplemental";
  readonly query: string;
  readonly aspectIds: readonly string[];
  readonly status: EvidenceQueryStatus;
  readonly plannedQueryIndexes: readonly number[];
}

export interface EvidenceCandidateDraft {
  readonly path: string;
  readonly title: string;
  readonly sources: readonly EvidenceCandidateSource[];
  readonly aspectIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly ranking?: EvidenceCandidateRanking;
}

export interface EvidenceCandidateRanking {
  readonly position: number;
  readonly titleCoverage: number;
  readonly obligationFit: number;
  readonly aspectCoverage: number;
  readonly directness: number;
  readonly sourceTier: number;
  readonly freshness: number;
  readonly rrf: number;
}

export interface EvidenceReadDraft {
  readonly path: string;
  readonly status: EvidenceReadStatus;
  readonly citation?: number;
  readonly pageType?: string;
  readonly sources?: readonly string[];
}

export interface EvidenceGraphDraft {
  readonly sourcePath: string;
  readonly status: EvidenceGraphStatus;
  readonly hitCount: number;
}

export interface EvidenceClaimRecord {
  readonly claimIndex: number;
  readonly status: EvidenceClaimStatus;
  readonly citations: readonly number[];
  readonly coveredAspectIds: readonly string[];
}

export interface EvidenceRetrievalBoundary {
  readonly deadlineReached: boolean;
  readonly searchBudgetExhausted: boolean;
  readonly readBudgetExhausted: boolean;
  readonly toolUnavailableCount: number;
  readonly accessDeniedCount: number;
}

export interface EvidenceVerificationDraft {
  readonly coverage: Coverage;
  readonly reason: CoverageVerificationReason;
  readonly coveredAspectIds: readonly string[];
  readonly missingAspectIds: readonly string[];
}

export interface EvidenceLedgerDraftUnit {
  readonly binding: DomainRequirementBinding;
  readonly subject: string;
  readonly requirement: KnowledgeRequirement;
  readonly queries: readonly EvidenceQueryDraft[];
  readonly candidates: readonly EvidenceCandidateDraft[];
  readonly reads: readonly EvidenceReadDraft[];
  readonly graphs: readonly EvidenceGraphDraft[];
  readonly claims: readonly EvidenceClaimRecord[];
  readonly retrieval: EvidenceRetrievalBoundary;
  readonly sourceBoundary: EvidenceSourceBoundary;
  readonly conflictDetected: boolean;
  readonly freshness: EvidenceFreshness;
  readonly inputState: EvidenceInputState;
  readonly ambiguous: boolean;
  readonly verification: EvidenceVerificationDraft;
}

export interface EvidenceQueryRecord extends EvidenceQueryDraft {
  readonly id: `Q${number}`;
}

export interface EvidenceCandidateRecord extends EvidenceCandidateDraft {
  readonly id: `C${number}`;
}

export interface EvidenceReadRecord extends EvidenceReadDraft {
  readonly candidateId: `C${number}`;
}

export interface EvidenceGraphRecord extends EvidenceGraphDraft {
  readonly id: `G${number}`;
  readonly candidateId: `C${number}`;
}

export interface EvidenceVerificationRecord extends EvidenceVerificationDraft {
  readonly covered: boolean;
  readonly missing: boolean;
}

export interface EvidenceLedgerUnit {
  readonly binding: DomainRequirementBinding;
  readonly subject: string;
  readonly requirement: KnowledgeRequirement;
  readonly queries: readonly EvidenceQueryRecord[];
  readonly candidates: readonly EvidenceCandidateRecord[];
  readonly reads: readonly EvidenceReadRecord[];
  readonly graphs: readonly EvidenceGraphRecord[];
  readonly claims: readonly EvidenceClaimRecord[];
  readonly retrieval: EvidenceRetrievalBoundary;
  readonly sourceBoundary: EvidenceSourceBoundary;
  readonly conflictDetected: boolean;
  readonly freshness: EvidenceFreshness;
  readonly inputState: EvidenceInputState;
  readonly ambiguous: boolean;
  readonly verification: EvidenceVerificationRecord;
}

export interface EvidenceLedger {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly units: readonly EvidenceLedgerUnit[];
}

export class EvidenceLedgerValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvidenceLedgerValidationError";
  }
}

export function finalizeEvidenceLedger(input: {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly units: readonly EvidenceLedgerDraftUnit[];
}): EvidenceLedger {
  if (![
    "coremail-professional",
    "presales-general",
  ].includes(input.project)) {
    throw new EvidenceLedgerValidationError("invalid_project");
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.revision)) {
    throw new EvidenceLedgerValidationError("invalid_revision");
  }
  if (input.units.length === 0 || input.units.length > 6) {
    throw new EvidenceLedgerValidationError("invalid_unit_count");
  }

  const seenRequirements = new Set<string>();
  const seenBindings = new Set<string>();
  let previousOrder = -1;
  const units = input.units.map((draft, unitIndex): EvidenceLedgerUnit => {
    if (draft.binding.domain !== input.project) {
      throw new EvidenceLedgerValidationError("project_domain_mismatch");
    }
    if (
      !/^D[1-9]\d*$/u.test(draft.binding.deliverableId) ||
      !/^O[1-9]\d*$/u.test(draft.binding.obligationId) ||
      !Number.isInteger(draft.binding.order) ||
      draft.binding.order < 0
    ) {
      throw new EvidenceLedgerValidationError("invalid_binding");
    }
    if (
      draft.requirement.id !== draft.binding.requirementId ||
      draft.requirement.id !== `R${unitIndex + 1}`
    ) {
      throw new EvidenceLedgerValidationError("requirement_binding_mismatch");
    }
    if (draft.binding.order <= previousOrder) {
      throw new EvidenceLedgerValidationError("binding_order_invalid");
    }
    previousOrder = draft.binding.order;
    const bindingKey = [
      draft.binding.domain,
      draft.binding.deliverableId,
      draft.binding.obligationId,
    ].join("\u0000");
    if (
      seenRequirements.has(draft.requirement.id) ||
      seenBindings.has(bindingKey)
    ) {
      throw new EvidenceLedgerValidationError("duplicate_unit_binding");
    }
    seenRequirements.add(draft.requirement.id);
    seenBindings.add(bindingKey);
    if (!draft.subject.trim() || draft.subject.trim().length > 1_024) {
      throw new EvidenceLedgerValidationError("empty_subject");
    }
    if (!knowledgeRequirementSchema.safeParse(draft.requirement).success) {
      throw new EvidenceLedgerValidationError("invalid_requirement");
    }

    const aspectIds = draft.requirement.evidenceAspects.map((aspect) => aspect.id);
    const knownAspectIds = new Set(aspectIds);
    validateAspectIds(
      draft.verification.coveredAspectIds,
      knownAspectIds,
      "verification_aspect_partition_invalid",
    );
    validateAspectIds(
      draft.verification.missingAspectIds,
      knownAspectIds,
      "verification_aspect_partition_invalid",
    );
    if (
      !isOrderedPartition(
        aspectIds,
        draft.verification.coveredAspectIds,
        draft.verification.missingAspectIds,
      ) ||
      (
        draft.verification.coverage === "complete" &&
        (
          draft.verification.missingAspectIds.length > 0 ||
          !sameStrings(draft.verification.coveredAspectIds, aspectIds)
        )
      ) ||
      (
        draft.verification.coverage === "none" &&
        (
          draft.verification.coveredAspectIds.length > 0 ||
          !sameStrings(draft.verification.missingAspectIds, aspectIds)
        )
      ) ||
      (
        draft.verification.coverage === "partial" &&
        draft.verification.missingAspectIds.length === 0 &&
        !draft.claims.some((claim) => claim.status === "removed")
      )
    ) {
      throw new EvidenceLedgerValidationError("verification_aspect_partition_invalid");
    }

    const assignedPlannedQueryIndexes = new Set<number>();
    const queries: EvidenceQueryRecord[] = draft.queries.map((query, index) => {
      if (
        !query.query.trim() ||
        !["seed", "supplemental"].includes(query.phase) ||
        !["success", "empty", "unavailable", "not_applicable"].includes(
          query.status,
        )
      ) {
        throw new EvidenceLedgerValidationError("empty_query_record");
      }
      validateAspectIds(query.aspectIds, knownAspectIds, "query_aspect_invalid");
      if (
        !Array.isArray(query.plannedQueryIndexes) ||
        new Set(query.plannedQueryIndexes).size !== query.plannedQueryIndexes.length ||
        query.plannedQueryIndexes.some((plannedIndex, plannedOffset) =>
          !Number.isInteger(plannedIndex) ||
          plannedIndex < 0 ||
          plannedIndex >= draft.requirement.queries.length ||
          (plannedOffset > 0 &&
            plannedIndex <= query.plannedQueryIndexes[plannedOffset - 1]!)
        ) ||
        (query.phase === "supplemental" && query.plannedQueryIndexes.length > 0)
      ) {
        throw new EvidenceLedgerValidationError("invalid_planned_query_index");
      }
      for (const plannedIndex of query.plannedQueryIndexes) {
        if (assignedPlannedQueryIndexes.has(plannedIndex)) {
          throw new EvidenceLedgerValidationError("duplicate_planned_query_execution");
        }
        assignedPlannedQueryIndexes.add(plannedIndex);
      }
      return {
        id: `Q${index + 1}`,
        phase: query.phase,
        query: query.query,
        aspectIds: [...query.aspectIds],
        status: query.status,
        plannedQueryIndexes: [...query.plannedQueryIndexes],
      };
    });
    if (queries.length === 0) {
      throw new EvidenceLedgerValidationError("missing_query_records");
    }
    if (
      draft.requirement.queries.some((_, plannedIndex) =>
        !assignedPlannedQueryIndexes.has(plannedIndex))
    ) {
      throw new EvidenceLedgerValidationError("missing_planned_query_execution");
    }

    const candidateIdByPath = new Map<string, `C${number}`>();
    const candidates: EvidenceCandidateRecord[] = draft.candidates.map(
      (candidate, index) => {
        if (
          !isSafeKnowledgePath(candidate.path) ||
          !candidate.title.trim() ||
          candidate.sources.length === 0 ||
          candidate.sources.some((source) =>
            !["seed", "supplemental", "graph"].includes(source))
        ) {
          throw new EvidenceLedgerValidationError("invalid_candidate");
        }
        if (candidateIdByPath.has(candidate.path)) {
          throw new EvidenceLedgerValidationError("duplicate_candidate");
        }
        validateAspectIds(candidate.aspectIds, knownAspectIds, "candidate_aspect_invalid");
        if (candidate.ranking !== undefined && !validCandidateRanking(candidate.ranking)) {
          throw new EvidenceLedgerValidationError("candidate_ranking_invalid");
        }
        const id = `C${index + 1}` as const;
        candidateIdByPath.set(candidate.path, id);
        return {
          id,
          path: candidate.path,
          title: candidate.title,
          sources: stableUnique(candidate.sources),
          aspectIds: stableUnique(candidate.aspectIds),
          reviewRequired: candidate.reviewRequired,
          ...(candidate.ranking === undefined
            ? {}
            : { ranking: { ...candidate.ranking } }),
        };
      },
    );

    const successfulCitations = new Set<number>();
    const reads: EvidenceReadRecord[] = draft.reads.map((read) => {
      const candidateId = candidateIdByPath.get(read.path);
      if (candidateId === undefined) {
        throw new EvidenceLedgerValidationError("read_candidate_missing");
      }
      if (
        !["success", "access_denied", "unavailable"].includes(read.status) ||
        (read.status === "success" && read.citation === undefined) ||
        (read.status !== "success" && read.citation !== undefined) ||
        (read.citation !== undefined &&
          (!Number.isInteger(read.citation) || read.citation <= 0))
      ) {
        throw new EvidenceLedgerValidationError("read_citation_invalid");
      }
      if (read.citation !== undefined) successfulCitations.add(read.citation);
      return {
        candidateId,
        path: read.path,
        status: read.status,
        ...(read.citation === undefined ? {} : { citation: read.citation }),
        ...(read.pageType === undefined ? {} : { pageType: read.pageType }),
        ...(read.sources === undefined ? {} : { sources: [...read.sources] }),
      };
    });

    const graphs: EvidenceGraphRecord[] = draft.graphs.map((graph, index) => {
      const candidateId = candidateIdByPath.get(graph.sourcePath);
      if (candidateId === undefined) {
        throw new EvidenceLedgerValidationError("graph_candidate_missing");
      }
      if (
        !["success", "empty", "unavailable"].includes(graph.status) ||
        !Number.isInteger(graph.hitCount) ||
        graph.hitCount < 0 ||
        (graph.status === "success" && graph.hitCount === 0) ||
        (graph.status !== "success" && graph.hitCount !== 0)
      ) {
        throw new EvidenceLedgerValidationError("invalid_graph_record");
      }
      return {
        id: `G${index + 1}`,
        candidateId,
        sourcePath: graph.sourcePath,
        status: graph.status,
        hitCount: graph.hitCount,
      };
    });

    const claims = draft.claims.map((claim) => {
      if (
        ![
          "retained_direct",
          "retained_synthesized",
          "removed",
        ].includes(claim.status) ||
        !Number.isInteger(claim.claimIndex) ||
        claim.claimIndex < 0 ||
        claim.citations.some((citation) => !successfulCitations.has(citation))
      ) {
        throw new EvidenceLedgerValidationError("claim_citation_not_read");
      }
      validateAspectIds(claim.coveredAspectIds, knownAspectIds, "claim_aspect_invalid");
      return {
        claimIndex: claim.claimIndex,
        status: claim.status,
        citations: stableUnique(claim.citations),
        coveredAspectIds: stableUnique(claim.coveredAspectIds),
      };
    });
    if (new Set(claims.map((claim) => claim.claimIndex)).size !== claims.length) {
      throw new EvidenceLedgerValidationError("duplicate_claim_index");
    }

    if (
      !validRetrievalBoundary(draft.retrieval) ||
      !["formal", "summary_only", "external_only"].includes(
        draft.sourceBoundary,
      ) ||
      typeof draft.conflictDetected !== "boolean" ||
      !["not_assessed", "current", "stale_or_unconfirmed"].includes(
        draft.freshness,
      ) ||
      !["not_applicable", "available", "missing"].includes(draft.inputState) ||
      typeof draft.ambiguous !== "boolean" ||
      !coverageSchema.safeParse(draft.verification.coverage).success ||
      !coverageVerificationReasonSchema.safeParse(
        draft.verification.reason,
      ).success
    ) {
      throw new EvidenceLedgerValidationError("invalid_boundary_metadata");
    }

    return {
      binding: { ...draft.binding },
      subject: draft.subject.trim(),
      requirement: cloneRequirement(draft.requirement),
      queries,
      candidates,
      reads,
      graphs,
      claims,
      retrieval: { ...draft.retrieval },
      sourceBoundary: draft.sourceBoundary,
      conflictDetected: draft.conflictDetected,
      freshness: draft.freshness,
      inputState: draft.inputState,
      ambiguous: draft.ambiguous,
      verification: {
        coverage: draft.verification.coverage,
        reason: draft.verification.reason,
        coveredAspectIds: [...draft.verification.coveredAspectIds],
        missingAspectIds: [...draft.verification.missingAspectIds],
        covered: draft.verification.coverage !== "none",
        missing: draft.verification.coverage !== "complete",
      },
    };
  });

  return deepFreeze({
    project: input.project,
    revision: input.revision,
    units,
  });
}

function validCandidateRanking(value: EvidenceCandidateRanking): boolean {
  return Number.isSafeInteger(value.position) && value.position > 0 &&
    [
      value.titleCoverage,
      value.obligationFit,
      value.aspectCoverage,
      value.directness,
      value.sourceTier,
      value.freshness,
      value.rrf,
    ].every((item) => Number.isFinite(item) && item >= 0) &&
    Number.isSafeInteger(value.sourceTier);
}

function cloneRequirement(requirement: KnowledgeRequirement): KnowledgeRequirement {
  return {
    id: requirement.id,
    question: requirement.question,
    evidenceMode: requirement.evidenceMode,
    evidenceAspects: requirement.evidenceAspects.map((aspect) => ({
      id: aspect.id,
      label: aspect.label,
      terms: [...aspect.terms],
    })),
    queries: requirement.queries.map((query) => ({
      text: query.text,
      aspectIds: [...query.aspectIds],
    })),
  };
}

function validRetrievalBoundary(value: EvidenceRetrievalBoundary): boolean {
  return typeof value.deadlineReached === "boolean" &&
    typeof value.searchBudgetExhausted === "boolean" &&
    typeof value.readBudgetExhausted === "boolean" &&
    Number.isInteger(value.toolUnavailableCount) &&
    value.toolUnavailableCount >= 0 &&
    Number.isInteger(value.accessDeniedCount) &&
    value.accessDeniedCount >= 0;
}

function validateAspectIds(
  values: readonly string[],
  known: ReadonlySet<string>,
  code: string,
): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value) => !known.has(value))
  ) {
    throw new EvidenceLedgerValidationError(code);
  }
}

function isSafeKnowledgePath(value: string): boolean {
  return value.startsWith("wiki/") && value.endsWith(".md") &&
    !value.includes("\\") && !value.split("/").includes("..");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isOrderedPartition(
  planned: readonly string[],
  covered: readonly string[],
  missing: readonly string[],
): boolean {
  const coveredSet = new Set(covered);
  const missingSet = new Set(missing);
  return covered.length + missing.length === planned.length &&
    planned.every((id) => coveredSet.has(id) !== missingSet.has(id)) &&
    sameStrings(covered, planned.filter((id) => coveredSet.has(id))) &&
    sameStrings(missing, planned.filter((id) => missingSet.has(id)));
}

function stableUnique<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
