import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AnswerStatus,
  CaseAssessability,
  Coverage,
  CoverageVerificationReason,
  HistoricalRejectionReason,
  KnowledgeCoverage,
  PolicyDisposition,
  Scope,
} from "./contracts.js";
import type { TaskSpecIssueCode } from "./task-spec.js";
import type { ModelRole } from "./model-client.js";
import type { TaskPlanAdapterInactiveReason } from "./task-plan-adapter.js";
import type { DomainPlanInactiveReason } from "./domain-plan.js";
import type {
  CoverageGapClass,
  CoverageGapReason,
} from "./coverage-gap.js";
import type { CoverageGateRiskReason } from "./deterministic-coverage-gate.js";
import type { ReliabilityStage } from "./stage-budget.js";

export type PseStopReason =
  | "seed_unavailable"
  | "routing_or_planning_unavailable"
  | "model_unavailable"
  | "invalid_model_payload"
  | "invalid_final"
  | "turn_budget_exhausted"
  | "evidence_review_unavailable"
  | "coverage_verifier_unavailable"
  | "coverage_verifier_invalid"
  | "domain_plan_invalid"
  | "domain_execution_unavailable"
  | "domain_merge_invalid";

export type HistoricalGateReason =
  | "eligible"
  | "question_not_explicit_coremail"
  | "formal_verification_incomplete"
  | "formal_support_present"
  | "structural_fallback";

export type DiagnosticEvent =
  | { readonly event: "route"; readonly scope: Scope }
  | {
      readonly event: "stage_budget";
      readonly stage: ReliabilityStage;
      readonly result: "completed" | "degraded" | "timeout" | "cancelled";
      readonly elapsedMs: number;
      readonly remainingMs: number;
    }
  | {
      readonly event: "question_resolution";
      readonly mode: "identity" | "contextual";
      readonly contextUsed: boolean;
      readonly entityCount: number;
      readonly correctionCount: number;
    }
  | {
      readonly event: "task_spec";
      readonly domainCount: number;
      readonly entityCount: number;
      readonly deliverableCount: number;
      readonly coverageUnitCount: number;
      readonly directUnitCount: number;
      readonly synthesisUnitCount: number;
      readonly customerInputUnitCount: number;
    }
  | {
      readonly event: "task_spec_guard";
      readonly ok: boolean;
      readonly issueCodes: readonly TaskSpecIssueCode[];
      readonly explicitEntityCount: number;
      readonly mappedExplicitEntityCount: number;
      readonly explicitRequestCount: number;
      readonly mappedExplicitRequestCount: number;
    }
  | {
      readonly event: "task_spec_shadow";
      readonly result: "completed" | "invalid" | "unavailable" | "timeout";
      readonly elapsedMs: number;
    }
  | {
      readonly event: "task_spec_recovery";
      readonly trigger:
        | "guard_rejected"
        | "analysis_unavailable"
        | "explicit_parallel_contract"
        | "deterministic_control_plane_contract";
      readonly result: "recovered" | "rejected";
      readonly issueCodes: readonly TaskSpecIssueCode[];
      readonly domainCount: number;
      readonly obligationCount: number;
    }
  | {
      readonly event: "task_spec_activation";
      readonly activated: boolean;
      readonly reason:
        | "activated"
        | "disabled"
        | "analysis_unavailable"
        | TaskPlanAdapterInactiveReason
        | DomainPlanInactiveReason;
      readonly requirementCount: number;
    }
  | {
      readonly event: "answer_card_match";
      readonly matchType: "exact" | "family" | "partial" | "none";
      readonly confidence: "deterministic" | "high" | "none";
      readonly candidateCount: number;
      readonly obligationCount: number;
      readonly cardIdHashes: readonly string[];
      readonly catalogHash: string;
      readonly reason?:
        | "no_exact_match"
        | "stale_catalog"
        | "scope_mismatch"
        | "applicability_mismatch"
        | "family_disabled"
        | "no_family_candidate"
        | "family_rejected"
        | "family_match_unavailable";
    }
  | {
      readonly event: "answer_card_activation";
      readonly activated: boolean;
      readonly reason:
        | "activated"
        | "shadow_only"
        | "analysis_unavailable"
        | "match_not_active"
        | "binding_unmapped"
        | "requirement_limit_exceeded"
        | "task_spec_contract_exceeded"
        | "guard_rejected";
      readonly obligationCount: number;
      readonly obligationIds?: readonly string[];
      readonly issueCodes?: readonly TaskSpecIssueCode[];
    }
  | {
      readonly event: "domain_execution";
      readonly domain?: "coremail-professional" | "presales-general";
      readonly phase: "session" | "agent";
      readonly result: "started" | "completed" | "verified" | "unavailable";
      readonly domainCount: number;
      readonly domainsUsed: readonly (
        "coremail-professional" | "presales-general"
      )[];
      readonly reason?:
        | "runner_missing"
        | "active_deadline_elapsed"
        | "domain_signal_aborted"
        | "session_snapshot_mismatch"
        | "agent_unavailable"
        | "domain_dependency_unavailable";
      /** Inner agent stop reason retained for root-cause attribution. */
      readonly rootReason?: PseStopReason;
    }
  | {
      readonly event: "domain_merge";
      readonly result: "completed" | "invalid";
      readonly domainCount: number;
      readonly requirementCount: number;
      readonly domainsUsed: readonly (
        "coremail-professional" | "presales-general"
      )[];
      readonly reason?: string;
    }
  | {
      readonly event: "plan";
      readonly requirementCount: number;
      readonly aspectCount: number;
      readonly queryCount: number;
      readonly directOnlyCount: number;
      readonly synthesisAllowedCount: number;
    }
  | {
      readonly event: "model_call";
      readonly role: ModelRole;
      readonly operation:
        | "route"
        | "normal_answer"
        | "normal_answer_repair"
        | "resolve"
        | "compile"
        | "plan"
        | "synthesize"
        | "verify"
        | "targeted_claim_revision"
        | "consensus_verify";
      readonly outcome: "completed" | "failed";
      readonly elapsedMs: number;
      readonly attemptCount?: number;
      readonly queueElapsedMs?: number;
      readonly executionElapsedMs?: number;
      readonly errorClass?:
        | "invalid_json"
        | "invalid_schema"
        | "invalid_payload"
        | "unavailable"
        | "aborted"
        | "unexpected";
    }
  | {
      readonly event: "model_call_budget";
      readonly maximumOpenEndedCalls: number;
      readonly usedOpenEndedCalls: number;
      readonly usedStructuredCalls: number;
    }
  | {
      readonly event: "high_risk_consensus";
      readonly mode: "independent_models" | "repeated_same_model";
      readonly claimCount: number;
      readonly retainedCount: number;
      readonly rejectedCount: number;
      readonly agreed: boolean;
    }
  | {
      readonly event: "qualified_cache";
      readonly result: "hit" | "miss" | "bypass" | "write" | "write_failed";
    }
  | {
      readonly event: "search";
      readonly requirementId: string;
      readonly phase: "seed" | "supplemental";
      readonly queryChars: number;
      readonly aspectIds: readonly string[];
    }
  | {
      /** Emitted before coverage-unit seed-unavailable early return. */
      readonly event: "coverage_unit_seed_snapshot";
      readonly reason: "all_seed_unavailable";
      readonly requirements: readonly {
        readonly id: string;
        readonly candidateCount: number;
        readonly readCandidateCount: number;
        readonly unreadCandidateCount: number;
        readonly remainingReads: number;
        readonly seedSearchStatus: "success" | "empty" | "unavailable";
      }[];
    }
  | {
      readonly event: "candidates";
      readonly requirementId: string;
      readonly source: "seed_search_result" | "supplemental_search_result" | "graph_result";
      readonly candidateCount: number;
      readonly rankedCandidates?: readonly {
        readonly pathHash: string;
        readonly position: number;
        readonly sourceTier: number;
        readonly titleCoverage: number;
        readonly obligationFit: number;
        readonly aspectCoverage: number;
        readonly directness: number;
        readonly freshness: number;
        readonly rrfMicros: number;
      }[];
      readonly aspects: readonly {
        readonly id: string;
        readonly candidateCount: number;
        readonly readCandidateCount: number;
      }[];
    }
  | {
      readonly event: "read";
      readonly requirementId: string;
      readonly citation: number;
      readonly sectionHeadingCount: number;
      readonly aspectIds: readonly string[];
    }
  | {
      readonly event: "evidence_shared";
      readonly fromRequirementId: string;
      readonly toRequirementId: string;
      readonly citation: number;
    }
  | {
      readonly event: "coverage";
      readonly stage: "draft" | "verified";
      readonly requirements: readonly {
        readonly id: string;
        readonly evidenceMode: "direct_only" | "synthesis_allowed";
        readonly coverage: Coverage;
        readonly citations: readonly number[];
        /** Retrieval ledger snapshot; optional for compatibility with external traces. */
        readonly candidateCount?: number;
        readonly readCandidateCount?: number;
        readonly unreadCandidateCount?: number;
        readonly remainingReads?: number;
        readonly seedSearchStatus?: "success" | "empty" | "unavailable";
        readonly retainedDirectSegmentCount?: number;
        readonly retainedSynthesizedSegmentCount?: number;
        readonly removedSegmentCount?: number;
        readonly coveredAspectCount?: number;
        readonly missingAspectCount?: number;
      }[];
      readonly reasons?: readonly {
        readonly id: string;
        readonly reason: CoverageVerificationReason;
      }[];
      readonly citations: readonly number[];
      readonly stopReason: "final" | "deadline";
    }
  | {
      readonly event: "coverage_gate";
      readonly disposition:
        | "deterministic_accept"
        | "semantic_required"
        | "reject";
      readonly risk: "low" | "high";
      readonly reasons: readonly CoverageGateRiskReason[];
      readonly missingInputCount: number;
      readonly knowledgeMissingCount: number;
    }
  | {
      /** Content-free attribution for a final answer rejected after repair. */
      readonly event: "final_guard";
      readonly result: "rejected";
      readonly reason:
        | "answer_card_concept_missing"
        | "direct_answer_missing"
        | "broken_collection_enumeration"
        | "coordinated_framework_component_missing"
        | "framework_boundary_missing"
        | "operational_condition_missing"
        | "citation_validation_failed";
      readonly repairAttempt: number;
    }
  | {
      /** Content-free attribution counters; never includes queries, paths, or answer text. */
      readonly event: "coverage_gaps";
      readonly domainCount: number;
      readonly gapCount: number;
      readonly gaps: readonly {
        readonly domain: "coremail-professional" | "presales-general";
        readonly gapClass: CoverageGapClass;
        readonly reason: CoverageGapReason;
        readonly affectsConclusion: boolean;
      }[];
    }
  | {
      readonly event: "validation";
      readonly result: "rejected";
      readonly reason: string;
      readonly repairAttempt: number;
    }
  | {
      readonly event: "model_payload";
      readonly result: "rejected";
      readonly reason: string;
      readonly repairAttempt: number;
      readonly rawPayloadLength?: number;
      readonly finishReason?: string;
    }
  | {
      readonly event: "fallback";
      readonly reason:
        | "invalid_model_payload"
        | "invalid_final"
        | "turn_budget_exhausted"
        | "coverage_verifier_invalid";
      readonly outcome: "temporarily_unavailable";
    }
  | {
      readonly event: "historical_gate";
      readonly eligible: boolean;
      readonly reason: HistoricalGateReason;
    }
  | {
      readonly event: "stop";
      readonly reason: PseStopReason;
    }
  | {
      readonly event: "finish";
      readonly scope: Scope;
      readonly status: AnswerStatus;
      readonly policyDisposition?: PolicyDisposition;
      readonly citationCount: number;
      readonly elapsedMs: number;
      readonly historicalAttempted: boolean;
      readonly historicalUsed: boolean;
      readonly knowledgeCoverage?: KnowledgeCoverage;
      readonly caseAssessability?: CaseAssessability;
      readonly historicalNoticeShown?: boolean;
      readonly historicalRejectedReason?: HistoricalRejectionReason;
    };

export type DiagnosticProgressEvent = {
  readonly event: "model_call_started";
  readonly role: ModelRole;
  readonly operation: Extract<
    DiagnosticEvent,
    { event: "model_call" }
  >["operation"];
};

export interface DiagnosticTrace {
  readonly requestId: string;
  record(event: DiagnosticEvent): void;
  progress?(event: DiagnosticProgressEvent): void;
}

export interface DiagnosticTraceFactory {
  start(): DiagnosticTrace;
}

export const NOOP_DIAGNOSTIC_TRACE: DiagnosticTrace = {
  requestId: "disabled",
  record() {},
};

export class JsonlDiagnosticTraceFactory implements DiagnosticTraceFactory {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  start(): DiagnosticTrace {
    const requestId = randomUUID();
    const filename = `pseagent-${new Date().toISOString().slice(0, 10)}-${requestId}.jsonl`;
    return new JsonlDiagnosticTrace(requestId, join(this.directory, filename));
  }
}

export function recordDiagnostic(
  trace: DiagnosticTrace | undefined,
  event: DiagnosticEvent,
): void {
  try {
    trace?.record(event);
  } catch {
    // Development diagnostics must never change the answer path.
  }
}

export function recordDiagnosticProgress(
  trace: DiagnosticTrace | undefined,
  event: DiagnosticProgressEvent,
): void {
  try {
    trace?.progress?.(event);
  } catch {
    // User-visible progress is best effort and must never change the answer path.
  }
}

class JsonlDiagnosticTrace implements DiagnosticTrace {
  constructor(
    readonly requestId: string,
    private readonly path: string,
  ) {}

  record(event: DiagnosticEvent): void {
    const allowlistedEvent = allowlistDiagnosticEvent(event);
    if (allowlistedEvent === undefined) return;
    const record = sanitizeRecord({
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      ...allowlistedEvent,
    });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  }
}

/**
 * Persistence boundary for diagnostic data. Reconstructing every event keeps
 * unknown properties out even when an untyped caller bypasses DiagnosticEvent.
 */
const UNKNOWN_DIAGNOSTIC_CATEGORY = "unknown";
const UNKNOWN_DIAGNOSTIC_IDENTIFIER = "UNKNOWN";
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 64;
const MAX_DIAGNOSTIC_COUNT = 1_000_000_000;

const SCOPE_VALUES = ["professional", "general", "normal"] as const;
const DOMAIN_VALUES = ["coremail-professional", "presales-general"] as const;
const TASK_SPEC_ISSUE_VALUES = [
  "entity_source_not_found",
  "deliverable_source_not_found",
  "obligation_source_not_found",
  "explicit_entity_unmapped",
  "explicit_entity_without_required_obligation",
  "distributive_entity_group_unresolved",
  "explicit_request_unmapped",
  "customer_input_request_unmapped",
  "protected_fact_not_direct",
  "domain_policy_conflict",
] as const;
const TASK_SPEC_ACTIVATION_REASON_VALUES = [
  "activated",
  "disabled",
  "analysis_unavailable",
  "guard_rejected",
  "customer_input_unhandled",
  "multi_domain_required",
  "no_applicable_obligations",
  "requirement_limit_exceeded",
  "knowledge_plan_contract_exceeded",
  "invalid_domain_binding",
] as const;
const ANSWER_CARD_MATCH_REASON_VALUES = [
  "no_exact_match",
  "stale_catalog",
  "scope_mismatch",
  "applicability_mismatch",
  "family_disabled",
  "no_family_candidate",
  "family_rejected",
  "family_match_unavailable",
] as const;
const ANSWER_CARD_ACTIVATION_REASON_VALUES = [
  "activated",
  "shadow_only",
  "analysis_unavailable",
  "match_not_active",
  "binding_unmapped",
  "requirement_limit_exceeded",
  "task_spec_contract_exceeded",
  "guard_rejected",
] as const;
const DOMAIN_EXECUTION_REASON_VALUES = [
  "runner_missing",
  "active_deadline_elapsed",
  "domain_signal_aborted",
  "session_snapshot_mismatch",
  "agent_unavailable",
  "domain_dependency_unavailable",
] as const;
const DOMAIN_MERGE_REASON_VALUES = [
  "unexpected_error",
  "duplicate_domain_plan",
  "duplicate_domain_result",
  "domain_result_mismatch",
  "merged_requirement_limit_exceeded",
  "unknown_local_citation",
  "reference_metadata_conflict",
  "merged_action_contract_exceeded",
  "evidence_metadata_incomplete",
  "evidence_metadata_mismatch",
  "evidence_ledger_snapshot_mismatch",
  "evidence_ledger_binding_mismatch",
  "verification_citation_mismatch",
  "verification_metadata_mismatch",
  "coverage_gap_binding_mismatch",
  "snapshot_mismatch",
  "requirement_binding_mismatch",
  "invalid_local_action",
  "invalid_local_coverage",
  "citation_union_mismatch",
  "duplicate_local_citation",
  "citation_metadata_mismatch",
  "duplicate_obligation_binding",
  "binding_order_conflict",
] as const;
const COVERAGE_VERIFICATION_REASON_VALUES = [
  "direct_support",
  "explicit_negative_support",
  "synthesized_support",
  "partial_support",
  "related_only",
  "target_omitted",
  "unsupported_claim_removed",
] as const;
const COVERAGE_GAP_CLASS_VALUES = [
  "knowledge",
  "retrieval",
  "source",
  "input",
  "ambiguity",
  "conflict",
  "freshness",
] as const;
const COVERAGE_GAP_REASON_VALUES = [
  "no_matching_page",
  "read_pages_do_not_support",
  "summary_only",
  "external_source_only",
  "candidate_not_read",
  "retrieval_budget_exhausted",
  "access_denied",
  "tool_unavailable",
  "conflicting_sources",
  "stale_or_unconfirmed",
  "ambiguous_question",
  "required_customer_input_missing",
  "unsupported_claim_removed",
] as const;
const VALIDATION_REASON_VALUES = [
  "answer_card_required_concept_missing",
  "answer_card_forbidden_claim",
  "requirement_coverage_mismatch",
  "duplicate_requirement_coverage",
  "related_citation_count",
  "requirement_citation_union_mismatch",
  "unknown_citation",
  "duplicate_requirement_citation",
  "requirement_citation_metadata_mismatch",
  "related_context_requires_none_coverage",
  "duplicate_related_citation",
  "related_citation_metadata_mismatch",
  "covered_requirement_without_citation",
  "requirement_answer_delegates_to_citation",
  "none_requirement_with_citation",
] as const;
const MODEL_PAYLOAD_REASON_VALUES = [
  "invalid_model_payload",
  "invalid_json",
  "invalid_knowledge_plan_after_repair",
  "invalid_route_after_repair",
  "invalid_task_spec_after_repair",
] as const;
const MODEL_PAYLOAD_REASON_PREFIX_VALUES = [
  "invalid_schema",
  "requirement_count_mismatch",
  "requirement_order_mismatch",
  "none_target_cannot_be_retained",
  "none_target_cannot_be_partially_retained",
  "retained_target_requires_all_segments",
  "partial_target_requires_proper_segment_subset",
  "uncovered_target_cannot_retain_segments",
  "synthesized_segments_must_be_retained",
  "direct_only_cannot_synthesize",
  "not_covered_cannot_synthesize",
  "retained_target_cannot_have_related_context",
  "covered_aspect_not_in_plan",
  "not_covered_cannot_cover_aspects",
  "related_context_requires_none_coverage",
  "target_segment_index_out_of_range",
  "retained_target_segment_without_citation",
  "target_segment_citation_not_in_evidence",
  "related_context_index_out_of_range",
  "related_citation_not_in_evidence",
  "explicit_scenario_choice_omitted",
] as const;
const FINISH_REASON_VALUES = [
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
  "abort",
] as const;
const COVERAGE_GATE_RISK_REASON_VALUES = [
  "numeric_promise",
  "version_capability",
  "compatibility",
  "legal_or_contract",
  "conflicting_evidence",
  "ambiguous_evidence",
  "stale_or_unconfirmed_evidence",
  "uncited_claim",
  "evidence_aspect_unbound",
  "related_context_review",
  "citation_outside_evidence_envelope",
  "requirement_envelope_mismatch",
] as const;
const FINAL_GUARD_REASON_VALUES = [
  "answer_card_concept_missing",
  "direct_answer_missing",
  "broken_collection_enumeration",
  "coordinated_framework_component_missing",
  "framework_boundary_missing",
  "operational_condition_missing",
  "citation_validation_failed",
] as const;
const PSE_STOP_REASON_VALUES = [
  "seed_unavailable",
  "routing_or_planning_unavailable",
  "model_unavailable",
  "invalid_model_payload",
  "invalid_final",
  "turn_budget_exhausted",
  "evidence_review_unavailable",
  "coverage_verifier_unavailable",
  "coverage_verifier_invalid",
  "domain_plan_invalid",
  "domain_execution_unavailable",
  "domain_merge_invalid",
] as const;

function allowlistDiagnosticEvent(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.event !== "string") return undefined;
  const event = value;
  switch (event.event) {
    case "stage_budget":
      return {
        event: event.event,
        stage: safeEnum(event.stage, [
          "preflight_cache",
          "obligation_compile",
          "retrieval",
          "claim_draft",
          "verification_consensus",
          "targeted_revision",
          "finalization",
        ] as const),
        result: safeEnum(
          event.result,
          ["completed", "degraded", "timeout", "cancelled"] as const,
        ),
        elapsedMs: safeCount(event.elapsedMs),
        remainingMs: safeCount(event.remainingMs),
      };
    case "route":
      return {
        event: event.event,
        scope: safeEnum(event.scope, SCOPE_VALUES),
      };
    case "question_resolution":
      return {
        event: event.event,
        mode: safeEnum(event.mode, ["identity", "contextual"] as const),
        contextUsed: safeBoolean(event.contextUsed),
        entityCount: safeCount(event.entityCount),
        correctionCount: safeCount(event.correctionCount),
      };
    case "task_spec":
      return {
        event: event.event,
        domainCount: safeCount(event.domainCount),
        entityCount: safeCount(event.entityCount),
        deliverableCount: safeCount(event.deliverableCount),
        coverageUnitCount: safeCount(event.coverageUnitCount),
        directUnitCount: safeCount(event.directUnitCount),
        synthesisUnitCount: safeCount(event.synthesisUnitCount),
        customerInputUnitCount: safeCount(event.customerInputUnitCount),
      };
    case "task_spec_guard":
      return {
        event: event.event,
        ok: safeBoolean(event.ok),
        issueCodes: safeArray(event.issueCodes, (item) =>
          safeEnum(item, TASK_SPEC_ISSUE_VALUES)),
        explicitEntityCount: safeCount(event.explicitEntityCount),
        mappedExplicitEntityCount: safeCount(event.mappedExplicitEntityCount),
        explicitRequestCount: safeCount(event.explicitRequestCount),
        mappedExplicitRequestCount: safeCount(event.mappedExplicitRequestCount),
      };
    case "task_spec_shadow":
      return {
        event: event.event,
        result: safeEnum(
          event.result,
          ["completed", "invalid", "unavailable", "timeout"] as const,
        ),
        elapsedMs: safeCount(event.elapsedMs),
      };
    case "task_spec_recovery":
      return {
        event: event.event,
        trigger: safeEnum(
          event.trigger,
          [
            "guard_rejected",
            "analysis_unavailable",
            "explicit_parallel_contract",
            "deterministic_control_plane_contract",
          ] as const,
        ),
        result: safeEnum(event.result, ["recovered", "rejected"] as const),
        issueCodes: safeArray(event.issueCodes, (item) =>
          safeEnum(item, TASK_SPEC_ISSUE_VALUES)),
        domainCount: safeCount(event.domainCount),
        obligationCount: safeCount(event.obligationCount),
      };
    case "task_spec_activation":
      return {
        event: event.event,
        activated: safeBoolean(event.activated),
        reason: safeEnum(event.reason, TASK_SPEC_ACTIVATION_REASON_VALUES),
        requirementCount: safeCount(event.requirementCount),
      };
    case "answer_card_match":
      return {
        event: event.event,
        matchType: safeEnum(
          event.matchType,
          ["exact", "family", "partial", "none"] as const,
        ),
        confidence: safeEnum(
          event.confidence,
          ["deterministic", "high", "none"] as const,
        ),
        candidateCount: safeCount(event.candidateCount),
        obligationCount: safeCount(event.obligationCount),
        cardIdHashes: safeArray(event.cardIdHashes, safeSha256, 12),
        catalogHash: safeSha256(event.catalogHash),
        ...safeOptionalEnumField(
          "reason",
          event.reason,
          ANSWER_CARD_MATCH_REASON_VALUES,
        ),
      };
    case "answer_card_activation":
      return {
        event: event.event,
        activated: safeBoolean(event.activated),
        reason: safeEnum(
          event.reason,
          ANSWER_CARD_ACTIVATION_REASON_VALUES,
        ),
        obligationCount: safeCount(event.obligationCount),
        ...(event.obligationIds === undefined
          ? {}
          : { obligationIds: safeArray(event.obligationIds, safeRequirementId, 12) }),
        ...(event.issueCodes === undefined
          ? {}
          : {
              issueCodes: safeArray(
                event.issueCodes,
                (item) => safeEnum(item, TASK_SPEC_ISSUE_VALUES),
              ),
            }),
      };
    case "domain_execution":
      return {
        event: event.event,
        ...safeOptionalEnumField("domain", event.domain, DOMAIN_VALUES),
        phase: safeEnum(event.phase, ["session", "agent"] as const),
        result: safeEnum(
          event.result,
          ["started", "completed", "verified", "unavailable"] as const,
        ),
        domainCount: safeCount(event.domainCount),
        domainsUsed: safeArray(event.domainsUsed, (item) =>
          safeEnum(item, DOMAIN_VALUES), 2),
        ...safeOptionalEnumField(
          "reason",
          event.reason,
          DOMAIN_EXECUTION_REASON_VALUES,
        ),
        ...safeOptionalEnumField(
          "rootReason",
          event.rootReason,
          PSE_STOP_REASON_VALUES,
        ),
      };
    case "domain_merge":
      return {
        event: event.event,
        result: safeEnum(event.result, ["completed", "invalid"] as const),
        domainCount: safeCount(event.domainCount),
        requirementCount: safeCount(event.requirementCount),
        domainsUsed: safeArray(event.domainsUsed, (item) =>
          safeEnum(item, DOMAIN_VALUES), 2),
        ...safeOptionalReasonField(
          "reason",
          event.reason,
          DOMAIN_MERGE_REASON_VALUES,
        ),
      };
    case "plan":
      return {
        event: event.event,
        requirementCount: safeCount(event.requirementCount),
        aspectCount: safeCount(event.aspectCount),
        queryCount: safeCount(event.queryCount),
        directOnlyCount: safeCount(event.directOnlyCount),
        synthesisAllowedCount: safeCount(event.synthesisAllowedCount),
      };
    case "model_call":
      return {
        event: event.event,
        role: safeEnum(
          event.role,
          ["resolver", "planner", "synthesizer", "verifier", "consensus_verifier"] as const,
        ),
        operation: safeEnum(
          event.operation,
          [
            "route",
            "normal_answer",
            "normal_answer_repair",
            "resolve",
            "compile",
            "plan",
            "synthesize",
            "verify",
            "targeted_claim_revision",
            "consensus_verify",
          ] as const,
        ),
        outcome: safeEnum(event.outcome, ["completed", "failed"] as const),
        elapsedMs: safeCount(event.elapsedMs),
        ...safeOptionalCountField("attemptCount", event.attemptCount),
        ...safeOptionalCountField("queueElapsedMs", event.queueElapsedMs),
        ...safeOptionalCountField("executionElapsedMs", event.executionElapsedMs),
        ...safeOptionalEnumField(
          "errorClass",
          event.errorClass,
          [
            "invalid_json",
            "invalid_schema",
            "invalid_payload",
            "unavailable",
            "aborted",
            "unexpected",
          ] as const,
        ),
      };
    case "model_call_budget":
      return {
        event: event.event,
        maximumOpenEndedCalls: safeCount(event.maximumOpenEndedCalls),
        usedOpenEndedCalls: safeCount(event.usedOpenEndedCalls),
        usedStructuredCalls: safeCount(event.usedStructuredCalls),
      };
    case "high_risk_consensus":
      return {
        event: event.event,
        mode: safeEnum(
          event.mode,
          ["independent_models", "repeated_same_model"] as const,
        ),
        claimCount: safeCount(event.claimCount),
        retainedCount: safeCount(event.retainedCount),
        rejectedCount: safeCount(event.rejectedCount),
        agreed: safeBoolean(event.agreed),
      };
    case "qualified_cache":
      return {
        event: event.event,
        result: safeEnum(
          event.result,
          ["hit", "miss", "bypass", "write", "write_failed"] as const,
        ),
      };
    case "search":
      return {
        event: event.event,
        requirementId: safeRequirementId(event.requirementId),
        phase: safeEnum(event.phase, ["seed", "supplemental"] as const),
        queryChars: safeCount(event.queryChars),
        aspectIds: safeArray(event.aspectIds, safeAspectId),
      };
    case "coverage_unit_seed_snapshot":
      return {
        event: event.event,
        reason: safeEnum(event.reason, ["all_seed_unavailable"] as const),
        requirements: safeArray(event.requirements, (item) => {
          const requirement = safeRecord(item);
          return {
            id: safeRequirementId(requirement.id),
            candidateCount: safeCount(requirement.candidateCount),
            readCandidateCount: safeCount(requirement.readCandidateCount),
            unreadCandidateCount: safeCount(requirement.unreadCandidateCount),
            remainingReads: safeCount(requirement.remainingReads),
            seedSearchStatus: safeEnum(
              requirement.seedSearchStatus,
              ["success", "empty", "unavailable"] as const,
            ),
          };
        }),
      };
    case "candidates":
      return {
        event: event.event,
        requirementId: safeRequirementId(event.requirementId),
        source: safeEnum(
          event.source,
          [
            "seed_search_result",
            "supplemental_search_result",
            "graph_result",
          ] as const,
        ),
        candidateCount: safeCount(event.candidateCount),
        ...(event.rankedCandidates === undefined
          ? {}
          : {
              rankedCandidates: safeArray(event.rankedCandidates, (item) => {
                const candidate = safeRecord(item);
                return {
                  pathHash: safeSha256(candidate.pathHash),
                  position: safePositiveInteger(candidate.position),
                  sourceTier: safeCount(candidate.sourceTier),
                  titleCoverage: safeCount(candidate.titleCoverage),
                  obligationFit: safeCount(candidate.obligationFit),
                  aspectCoverage: safeCount(candidate.aspectCoverage),
                  directness: safeCount(candidate.directness),
                  freshness: safeCount(candidate.freshness),
                  rrfMicros: safeCount(candidate.rrfMicros),
                };
              }, 5),
            }),
        aspects: safeArray(event.aspects, (item) => {
          const aspect = safeRecord(item);
          return {
            id: safeAspectId(aspect.id),
            candidateCount: safeCount(aspect.candidateCount),
            readCandidateCount: safeCount(aspect.readCandidateCount),
          };
        }),
      };
    case "read":
      return {
        event: event.event,
        requirementId: safeRequirementId(event.requirementId),
        citation: safePositiveInteger(event.citation),
        sectionHeadingCount: safeCount(event.sectionHeadingCount),
        aspectIds: safeArray(event.aspectIds, safeAspectId),
      };
    case "evidence_shared":
      return {
        event: event.event,
        fromRequirementId: safeRequirementId(event.fromRequirementId),
        toRequirementId: safeRequirementId(event.toRequirementId),
        citation: safePositiveInteger(event.citation),
      };
    case "coverage":
      return {
        event: event.event,
        stage: safeEnum(event.stage, ["draft", "verified"] as const),
        requirements: safeArray(event.requirements, (item) => {
          const requirement = safeRecord(item);
          return {
            id: safeRequirementId(requirement.id),
            evidenceMode: safeEnum(
              requirement.evidenceMode,
              ["direct_only", "synthesis_allowed"] as const,
            ),
            coverage: safeEnum(
              requirement.coverage,
              ["complete", "partial", "none"] as const,
            ),
            citations: safeArray(
              requirement.citations,
              safePositiveInteger,
              20,
            ),
            ...safeOptionalCountField("candidateCount", requirement.candidateCount),
            ...safeOptionalCountField(
              "readCandidateCount",
              requirement.readCandidateCount,
            ),
            ...safeOptionalCountField(
              "unreadCandidateCount",
              requirement.unreadCandidateCount,
            ),
            ...safeOptionalCountField("remainingReads", requirement.remainingReads),
            ...safeOptionalEnumField(
              "seedSearchStatus",
              requirement.seedSearchStatus,
              ["success", "empty", "unavailable"] as const,
            ),
            ...safeOptionalCountField(
              "retainedDirectSegmentCount",
              requirement.retainedDirectSegmentCount,
            ),
            ...safeOptionalCountField(
              "retainedSynthesizedSegmentCount",
              requirement.retainedSynthesizedSegmentCount,
            ),
            ...safeOptionalCountField(
              "removedSegmentCount",
              requirement.removedSegmentCount,
            ),
            ...safeOptionalCountField(
              "coveredAspectCount",
              requirement.coveredAspectCount,
            ),
            ...safeOptionalCountField(
              "missingAspectCount",
              requirement.missingAspectCount,
            ),
          };
        }),
        ...(event.reasons === undefined
          ? {}
          : {
              reasons: safeArray(event.reasons, (item) => {
                const reason = safeRecord(item);
                return {
                  id: safeRequirementId(reason.id),
                  reason: safeEnum(
                    reason.reason,
                    COVERAGE_VERIFICATION_REASON_VALUES,
                  ),
                };
              }),
            }),
        citations: safeArray(event.citations, safePositiveInteger, 20),
        stopReason: safeEnum(event.stopReason, ["final", "deadline"] as const),
      };
    case "coverage_gate":
      return {
        event: event.event,
        disposition: safeEnum(
          event.disposition,
          ["deterministic_accept", "semantic_required", "reject"] as const,
        ),
        risk: safeEnum(event.risk, ["low", "high"] as const),
        reasons: safeArray(event.reasons, (item) =>
          safeEnum(item, COVERAGE_GATE_RISK_REASON_VALUES)),
        missingInputCount: safeCount(event.missingInputCount),
        knowledgeMissingCount: safeCount(event.knowledgeMissingCount),
      };
    case "coverage_gaps":
      return {
        event: event.event,
        domainCount: safeCount(event.domainCount),
        gapCount: safeCount(event.gapCount),
        gaps: safeArray(event.gaps, (item) => {
          const gap = safeRecord(item);
          return {
            domain: safeEnum(gap.domain, DOMAIN_VALUES),
            gapClass: safeEnum(gap.gapClass, COVERAGE_GAP_CLASS_VALUES),
            reason: safeEnum(gap.reason, COVERAGE_GAP_REASON_VALUES),
            affectsConclusion: safeBoolean(gap.affectsConclusion),
          };
        }),
      };
    case "validation":
      return {
        event: event.event,
        result: safeEnum(event.result, ["rejected"] as const),
        reason: safeReason(
          event.reason,
          VALIDATION_REASON_VALUES,
          ["citation_not_read_for_requirement"] as const,
        ),
        repairAttempt: safeCount(event.repairAttempt),
      };
    case "final_guard":
      return {
        event: event.event,
        result: safeEnum(event.result, ["rejected"] as const),
        reason: safeEnum(event.reason, FINAL_GUARD_REASON_VALUES),
        repairAttempt: safeCount(event.repairAttempt),
      };
    case "model_payload":
      return {
        event: event.event,
        result: safeEnum(event.result, ["rejected"] as const),
        reason: safeReason(
          event.reason,
          MODEL_PAYLOAD_REASON_VALUES,
          MODEL_PAYLOAD_REASON_PREFIX_VALUES,
        ),
        repairAttempt: safeCount(event.repairAttempt),
        ...safeOptionalCountField("rawPayloadLength", event.rawPayloadLength),
        ...safeOptionalEnumField(
          "finishReason",
          event.finishReason,
          FINISH_REASON_VALUES,
        ),
      };
    case "fallback":
      return {
        event: event.event,
        reason: safeEnum(
          event.reason,
          [
            "invalid_model_payload",
            "invalid_final",
            "turn_budget_exhausted",
            "coverage_verifier_invalid",
          ] as const,
        ),
        outcome: safeEnum(event.outcome, ["temporarily_unavailable"] as const),
      };
    case "historical_gate":
      return {
        event: event.event,
        eligible: safeBoolean(event.eligible),
        reason: safeEnum(
          event.reason,
          [
            "eligible",
            "question_not_explicit_coremail",
            "formal_verification_incomplete",
            "formal_support_present",
            "structural_fallback",
          ] as const,
        ),
      };
    case "stop":
      return {
        event: event.event,
        reason: safeEnum(event.reason, PSE_STOP_REASON_VALUES),
      };
    case "finish":
      return {
        event: event.event,
        scope: safeEnum(event.scope, SCOPE_VALUES),
        status: safeEnum(
          event.status,
          [
            "answered",
            "partially_answered",
            "not_covered",
            "temporarily_unavailable",
          ] as const,
        ),
        citationCount: safeCount(event.citationCount),
        elapsedMs: safeCount(event.elapsedMs),
        historicalAttempted: safeBoolean(event.historicalAttempted),
        historicalUsed: safeBoolean(event.historicalUsed),
        ...safeOptionalEnumField(
          "knowledgeCoverage",
          event.knowledgeCoverage,
          ["complete", "partial", "none"] as const,
        ),
        ...safeOptionalEnumField(
          "caseAssessability",
          event.caseAssessability,
          ["sufficient", "insufficient", "conflicting", "not_applicable"] as const,
        ),
        ...safeOptionalBooleanField(
          "historicalNoticeShown",
          event.historicalNoticeShown,
        ),
        ...safeOptionalEnumField(
          "historicalRejectedReason",
          event.historicalRejectedReason,
          ["topic_mismatch", "low_confidence", "no_reliable_source"] as const,
        ),
      };
    default:
      return undefined;
  }
}

function safeEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | typeof UNKNOWN_DIAGNOSTIC_CATEGORY {
  return typeof value === "string" && allowed.some((item) => item === value)
    ? value as T[number]
    : UNKNOWN_DIAGNOSTIC_CATEGORY;
}

function safeReason(
  value: unknown,
  exact: readonly string[],
  prefixes: readonly string[] = [],
): string {
  if (typeof value !== "string") return UNKNOWN_DIAGNOSTIC_CATEGORY;
  if (exact.includes(value)) return value;
  return prefixes.find((prefix) =>
    value === prefix || value.startsWith(`${prefix}:`)) ??
    UNKNOWN_DIAGNOSTIC_CATEGORY;
}

function safeRequirementId(value: unknown): string {
  return typeof value === "string" && /^(?:GLOBAL|R[1-6])$/u.test(value)
    ? value
    : UNKNOWN_DIAGNOSTIC_IDENTIFIER;
}

function safeAspectId(value: unknown): string {
  return typeof value === "string" && /^A[1-8]$/u.test(value)
    ? value
    : UNKNOWN_DIAGNOSTIC_IDENTIFIER;
}

function safeSha256(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value
    : UNKNOWN_DIAGNOSTIC_IDENTIFIER;
}

function safeBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function safeCount(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 &&
      (value as number) <= MAX_DIAGNOSTIC_COUNT
    ? value as number
    : 0;
}

function safePositiveInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 &&
      (value as number) <= MAX_DIAGNOSTIC_COUNT
    ? value as number
    : 0;
}

function safeArray<T>(
  value: unknown,
  mapper: (item: unknown) => T,
  limit = MAX_DIAGNOSTIC_ARRAY_ITEMS,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map(mapper);
}

function safeRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeOptionalCountField(
  key: string,
  value: unknown,
): Record<string, number> {
  return value === undefined ? {} : { [key]: safeCount(value) };
}

function safeOptionalBooleanField(
  key: string,
  value: unknown,
): Record<string, boolean> {
  return value === undefined ? {} : { [key]: safeBoolean(value) };
}

function safeOptionalEnumField<const T extends readonly string[]>(
  key: string,
  value: unknown,
  allowed: T,
): Record<string, T[number] | typeof UNKNOWN_DIAGNOSTIC_CATEGORY> {
  return value === undefined ? {} : { [key]: safeEnum(value, allowed) };
}

function safeOptionalReasonField(
  key: string,
  value: unknown,
  exact: readonly string[],
): Record<string, string> {
  return value === undefined ? {} : { [key]: safeReason(value, exact) };
}

function sanitizeRecord(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeRecord);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeRecord(item)]),
    );
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(password|passwd|token|cookie|sid|api[_-]?key)\b(?:\s*[:=：]\s*|\s+)[^\s,，;；]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/(密码|口令|令牌|会话)(?:\s*[:=：]\s*|\s*)[^\s,，;；]+/gu, "$1=[REDACTED]")
    .slice(0, 1_024);
}
