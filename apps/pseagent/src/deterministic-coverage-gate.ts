import type { FinalAction, KnowledgePlan } from "./contracts.js";
import type { CoverageEvidenceDocument } from "./coverage-verifier.js";
import type { RequirementEvidenceCondition } from "./evidence-ledger.js";
import {
  normalizeTrailingCitationPlacement,
  splitAnswerLineSegments,
} from "./references.js";

export type CoverageGateRiskReason =
  | "numeric_promise"
  | "version_capability"
  | "compatibility"
  | "legal_or_contract"
  | "conflicting_evidence"
  | "ambiguous_evidence"
  | "stale_or_unconfirmed_evidence"
  | "uncited_claim"
  | "evidence_aspect_unbound"
  | "related_context_review"
  | "citation_outside_evidence_envelope"
  | "requirement_envelope_mismatch";

export interface DeterministicCoverageGateInput {
  readonly question: string;
  readonly plan: KnowledgePlan;
  readonly draft: FinalAction;
  readonly evidence: readonly CoverageEvidenceDocument[];
  readonly conditions?: readonly RequirementEvidenceCondition[];
}

export interface DeterministicCoverageGateResult {
  readonly disposition:
    | "deterministic_accept"
    | "semantic_required"
    | "reject";
  readonly risk: "low" | "high";
  readonly reasons: readonly CoverageGateRiskReason[];
  readonly missingInputRequirementIds: readonly string[];
  readonly knowledgeMissingRequirementIds: readonly string[];
}

export function evaluateDeterministicCoverageGate(
  input: DeterministicCoverageGateInput,
): DeterministicCoverageGateResult {
  const conditionById = new Map(
    (input.conditions ?? []).map((condition) => [
      condition.requirementId,
      condition,
    ] as const),
  );
  const requirementIds = input.plan.requirements.map((item) => item.id);
  const draftIds = input.draft.requirements.map((item) => item.id);
  if (
    requirementIds.length !== draftIds.length ||
    requirementIds.some((id, index) => draftIds[index] !== id)
  ) {
    return result("reject", ["requirement_envelope_mismatch"], [], []);
  }

  const reasons = new Set<CoverageGateRiskReason>();
  const missingInputRequirementIds: string[] = [];
  const knowledgeMissingRequirementIds: string[] = [];

  for (const [index, requirement] of input.draft.requirements.entries()) {
    const planned = input.plan.requirements[index]!;
    const condition = conditionById.get(requirement.id);
    if (requirement.coverage === "none") {
      if (condition?.inputState === "missing") {
        missingInputRequirementIds.push(requirement.id);
      } else {
        knowledgeMissingRequirementIds.push(requirement.id);
      }
      if ((requirement.relatedContext?.length ?? 0) > 0) {
        reasons.add("related_context_review");
      }
      continue;
    }

    const ownedEvidence = input.evidence.filter((document) =>
      document.requirementId === requirement.id);
    const ownedCitations = new Set(ownedEvidence.map((document) =>
      document.citation));
    const declaredCitations = new Set([
      ...requirement.citations,
      ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
    ]);
    const citedSegments = splitAnswerLineSegments(
      normalizeTrailingCitationPlacement(requirement.answer),
    );
    for (const segment of citedSegments) {
      if (isStructuralSegment(segment)) continue;
      const citations = segmentCitations(segment);
      if (citations.length === 0) reasons.add("uncited_claim");
      if (citations.some((citation) => !ownedCitations.has(citation))) {
        reasons.add("citation_outside_evidence_envelope");
      }
    }
    if ([...declaredCitations].some((citation) => !ownedCitations.has(citation))) {
      reasons.add("citation_outside_evidence_envelope");
    }

    const citedAspectIds = new Set(
      ownedEvidence
        .filter((document) => declaredCitations.has(document.citation))
        .flatMap((document) => document.aspectIds ?? []),
    );
    if (
      requirement.coverage === "complete" &&
      citedAspectIds.size > 0 &&
      planned.evidenceAspects.some((aspect) => !citedAspectIds.has(aspect.id))
    ) {
      reasons.add("evidence_aspect_unbound");
    }

    for (const riskReason of textualRiskReasons(
      `${input.question}\n${planned.question}\n${requirement.answer}`,
    )) {
      reasons.add(riskReason);
    }
    if (condition?.conflictDetected === true) reasons.add("conflicting_evidence");
    if (condition?.ambiguous === true) reasons.add("ambiguous_evidence");
    if (condition?.freshness === "stale_or_unconfirmed") {
      reasons.add("stale_or_unconfirmed_evidence");
    }
  }

  if (reasons.has("citation_outside_evidence_envelope")) {
    return result(
      "reject",
      ["citation_outside_evidence_envelope"],
      missingInputRequirementIds,
      knowledgeMissingRequirementIds,
    );
  }
  const orderedReasons = orderReasons(reasons);
  return result(
    orderedReasons.length === 0
      ? "deterministic_accept"
      : "semantic_required",
    orderedReasons,
    missingInputRequirementIds,
    knowledgeMissingRequirementIds,
  );
}

function textualRiskReasons(value: string): CoverageGateRiskReason[] {
  const reasons: CoverageGateRiskReason[] = [];
  if (/(?:\d+(?:\.\d+)?\s*%|\bSLA\b|\bRTO\b|\bRPO\b|零风险|绝对保证|承诺)/iu.test(value)) {
    reasons.push("numeric_promise");
  }
  if (
    /(?:\bV?\d+(?:\.\d+){1,3}\b|版本).{0,40}(?:支持|具备|兼容|提供)|(?:支持|具备|兼容|提供).{0,40}(?:\bV?\d+(?:\.\d+){1,3}\b|版本)/iu.test(
      value,
    )
  ) {
    reasons.push("version_capability");
  }
  if (/(?:兼容|适配|互操作|协议支持|支持.{0,30}(?:协议|系统|客户端|数据库|操作系统))/u.test(value)) {
    reasons.push("compatibility");
  }
  if (/(?:合同|法律|法务|赔偿|违约|责任主体|责任由|监管承诺)/u.test(value)) {
    reasons.push("legal_or_contract");
  }
  return reasons;
}

function isStructuralSegment(segment: string): boolean {
  const normalized = segment.trim();
  return /^(?:#{1,6}\s+.+|\*\*[^*]+\*\*[:：]?)$/u.test(normalized) &&
    !/\[\d+\]/u.test(normalized);
}

function segmentCitations(value: string): number[] {
  return [...value.matchAll(/\[(\d+)\]/gu)].map((match) =>
    Number.parseInt(match[1]!, 10));
}

const REASON_ORDER: readonly CoverageGateRiskReason[] = [
  "requirement_envelope_mismatch",
  "citation_outside_evidence_envelope",
  "uncited_claim",
  "evidence_aspect_unbound",
  "related_context_review",
  "numeric_promise",
  "version_capability",
  "compatibility",
  "legal_or_contract",
  "conflicting_evidence",
  "ambiguous_evidence",
  "stale_or_unconfirmed_evidence",
];

function orderReasons(
  reasons: ReadonlySet<CoverageGateRiskReason>,
): CoverageGateRiskReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function result(
  disposition: DeterministicCoverageGateResult["disposition"],
  reasons: readonly CoverageGateRiskReason[],
  missingInputRequirementIds: readonly string[],
  knowledgeMissingRequirementIds: readonly string[],
): DeterministicCoverageGateResult {
  return Object.freeze({
    disposition,
    risk: disposition === "deterministic_accept" ? "low" : "high",
    reasons: Object.freeze([...reasons]),
    missingInputRequirementIds: Object.freeze([...missingInputRequirementIds]),
    knowledgeMissingRequirementIds: Object.freeze([
      ...knowledgeMissingRequirementIds,
    ]),
  });
}
