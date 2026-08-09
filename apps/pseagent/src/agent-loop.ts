import {
  agentActionSchema,
  finalOnlyActionSchema,
  type AnswerResult,
  type FinalAction,
  type KnowledgePlan,
  type KnowledgeRequirement,
  type Reference,
  type ToolAction,
} from "./contracts.js";
import type {
  KnowledgeGraphResult,
  KnowledgePage,
  KnowledgeSearchResult,
  ProjectKey,
} from "./knowledge-session.js";
import {
  InvalidCoverageVerificationError,
  coverageVerificationReport,
  inferCoverageVerificationReport,
  notCoveredRequirementAnswer,
  verifyKnowledgeCoverage,
  type CoverageEvidenceDocument,
  type CoverageVerificationReport,
  type CoverageVerificationSummary,
  type CoverageVerifierInput,
} from "./coverage-verifier.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";
import { knowledgeAgentMessages } from "./prompts.js";
import {
  normalizeTrailingCitationPlacement,
  ReferenceRegistry,
  splitAnswerLineSegments,
} from "./references.js";
import { formatKnowledgeFinal, unavailableResult } from "./response.js";
import {
  recordDiagnostic,
  type DiagnosticTrace,
} from "./diagnostics.js";
import {
  finalizeEvidenceLedger,
  type EvidenceCandidateDraft,
  type EvidenceCandidateSource,
  type EvidenceClaimRecord,
  type EvidenceGraphDraft,
  type EvidenceLedger,
  type EvidenceLedgerDraftUnit,
  type EvidenceQueryDraft,
  type EvidenceReadDraft,
  type EvidenceSourceBoundary,
  type RequirementEvidenceCondition,
} from "./evidence-ledger.js";
import { analyzeCoverageGaps, type CoverageGap } from "./coverage-gap.js";
import type { DomainRequirementBinding } from "./domain-plan.js";
import { observeModelCall } from "./model-observability.js";
import {
  applyGroundedAnswerCardRequiredConcepts,
  answerCardRequirementsWithGroundedConcepts,
  answerCardPolicyObservations,
  missingAnswerCardRequiredConcepts,
  violatesAnswerCardForbiddenClaims,
} from "./answer-card-policy.js";
import {
  isDirectComparisonQuestion,
  missingExplicitComparisonLabels,
} from "./comparison-question.js";
import { hasDanglingCollectionEnumeration } from "./answer-structure.js";

export const MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT = 3;
export const DIRECT_ONLY_READ_LIMIT = 3;
export const SYNTHESIS_ALLOWED_READ_LIMIT = 6;
export const MAX_BATCH_READS_PER_REQUIREMENT = 2;
export const MAX_GRAPH_ACTIONS_PER_REQUIREMENT = 1;
export const MAX_AGENT_TURNS_PER_REQUIREMENT = 7;
const MAX_CITATION_REPAIR_ATTEMPTS = 2;
const RRF_K = 60;
const SEED_TOP_K = 10;
const SYNTHESIS_SEED_TOP_K_LIMIT = 20;

export function readLimitFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? Math.max(
        SYNTHESIS_ALLOWED_READ_LIMIT,
        requirement.evidenceAspects.length,
      )
    : DIRECT_ONLY_READ_LIMIT;
}

export interface KnowledgeAgentSession {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly purpose: string;
  readonly schema: string;
  authorizeGovernedPaths?(paths: readonly string[]): void;
  search(query: string, topK: number, signal?: AbortSignal): Promise<KnowledgeSearchResult>;
  graph(path: string, topK: number, signal?: AbortSignal): Promise<KnowledgeGraphResult>;
  readPage(path: string, signal?: AbortSignal): Promise<KnowledgePage>;
  compactPage(page: KnowledgePage, matchedTerms: string[]): string;
}

export interface KnowledgeAgentInput {
  readonly scope: "professional" | "general";
  readonly question: string;
  readonly conversationContext?: string;
  readonly plan: KnowledgePlan;
  readonly requirementBindings?: readonly DomainRequirementBinding[];
  readonly requirementEvidenceConditions?: readonly RequirementEvidenceCondition[];
  readonly model: ModelClient;
  readonly verifierModel?: ModelClient;
  readonly session: KnowledgeAgentSession;
  readonly deadlineAt?: number;
  readonly trace?: DiagnosticTrace;
  readonly signal?: AbortSignal;
  readonly verifyCoverage?: (
    input: CoverageVerifierInput,
  ) => Promise<FinalAction>;
}

export type KnowledgeAgentDetailedResult =
  | {
      readonly outcome: "verified";
      readonly project: ProjectKey;
      readonly revision: string;
      readonly action: FinalAction;
      readonly references: readonly Reference[];
      readonly verification?: CoverageVerificationReport;
      readonly evidenceLedger?: EvidenceLedger;
      readonly coverageGaps?: readonly CoverageGap[];
    }
  | {
      readonly outcome: "unavailable";
      readonly result: AnswerResult;
    };

type Candidate = {
  readonly path: string;
  title: string;
  rrfScore: number;
  readonly sourceQueries: Set<string>;
  readonly rankings: Array<{ query: string; rank: number; score: number }>;
  readonly matchedTerms: Set<string>;
  readonly snippets: Set<string>;
  readonly graphRelations: Set<string>;
  readonly aspectIds: Set<string>;
  readonly ledgerSources: Set<EvidenceCandidateSource>;
  requirementSpecificMatch: boolean;
};

type RequirementState = {
  readonly subject: string;
  readonly requirement: KnowledgeRequirement;
  readonly queries: Set<string>;
  readonly candidatePaths: Map<string, Candidate>;
  readonly seedCandidatePaths: Set<string>;
  readonly readPaths: Set<string>;
  readonly directReadPaths: Set<string>;
  readonly citationIndexes: Set<number>;
  readonly readAspectIds: Set<string>;
  readonly queryRecords: EvidenceQueryDraft[];
  readonly readRecords: EvidenceReadDraft[];
  readonly graphRecords: EvidenceGraphDraft[];
  successfulSeedSearches: number;
  failedSeedSearches: number;
  supplementalSearches: number;
  graphActions: number;
  noGainRounds: number;
  searchStopped: boolean;
  searchBudgetExhausted: boolean;
  evidenceReviewExhausted: boolean;
  toolUnavailableCount: number;
  accessDeniedCount: number;
};

type AgentState = {
  readonly actionFingerprints: Set<string>;
  readonly requirements: Map<string, RequirementState>;
  readonly references: ReferenceRegistry;
  readonly evidenceDocuments: Map<
    string,
    Map<number, Omit<CoverageEvidenceDocument, "requirementId" | "citation">>
  >;
  readonly observations: string[];
  readonly evidenceConditions: ReadonlyMap<string, RequirementEvidenceCondition>;
  readonly readProvenanceByCitation: Map<
    number,
    {
      readonly path: string;
      readonly pageType: string;
      readonly sources: readonly string[];
    }
  >;
  citationRepairAttempts: number;
  directAnswerRepairAttempts: number;
  comparisonSubjectRepairAttempts: number;
  structuredCoverageRepairAttempts: number;
  answerCardConceptRepairAttempts: number;
  invalidPayloadTurnRetries: number;
  forceFinal: boolean;
  successfulSeedSearches: number;
};

export async function runKnowledgeAgent(
  input: KnowledgeAgentInput,
): Promise<AnswerResult> {
  const detailed = await runKnowledgeAgentDetailed(input);
  return detailed.outcome === "unavailable"
    ? detailed.result
    : formatKnowledgeFinal(input.scope, detailed.action, detailed.references, {
        question: input.question,
        ...(detailed.evidenceLedger === undefined
          ? {}
          : { evidenceLedgers: [detailed.evidenceLedger] }),
        ...(detailed.coverageGaps === undefined
          ? {}
          : { coverageGaps: detailed.coverageGaps }),
        ...(detailed.verification === undefined
          ? {}
          : { verification: detailed.verification }),
        ...(input.requirementBindings === undefined
          ? {}
          : {
              requirementBindings: input.requirementBindings.map((binding) => ({
                ...binding,
                globalRequirementId: binding.requirementId,
              })),
            }),
      });
}

export async function runKnowledgeAgentDetailed(
  input: KnowledgeAgentInput,
): Promise<KnowledgeAgentDetailedResult> {
  const result = await runKnowledgeAgentCore(input);
  return "outcome" in result
    ? result
    : { outcome: "unavailable", result };
}

async function runKnowledgeAgentCore(
  input: KnowledgeAgentInput,
): Promise<AnswerResult | Extract<KnowledgeAgentDetailedResult, { outcome: "verified" }>> {
  const state = createAgentState(input);
  prepareGovernedEvidenceCandidates(input, state);
  await executeSeedSearches(input, state);
  await preloadGovernedEvidence(input, state);
  const governedEvidencePreloaded = governedEvidenceReady(input, state);
  const hasRetrievalRequirement = [...state.requirements.keys()].some(
    (requirementId) =>
      state.evidenceConditions.get(requirementId)?.inputState !== "missing",
  );
  const hasGovernedEvidence = [...state.requirements.values()].some(
    (requirementState) => requirementState.directReadPaths.size > 0,
  );
  if (
    hasRetrievalRequirement &&
    state.successfulSeedSearches === 0 &&
    !hasGovernedEvidence
  ) {
    if (input.plan.retrievalStrategy === "coverage_units") {
      recordDiagnostic(input.trace, {
        event: "coverage_unit_seed_snapshot",
        reason: "all_seed_unavailable",
        requirements: input.plan.requirements.map((requirement) => ({
          id: requirement.id,
          ...coverageRetrievalDiagnostics(state.requirements.get(requirement.id)),
        })),
      });
    }
    recordDiagnostic(input.trace, { event: "stop", reason: "seed_unavailable" });
    return unavailableResult(input.scope);
  }
  if (!governedEvidencePreloaded) {
    if (input.plan.retrievalStrategy === "coverage_units") {
      await preloadCoverageUnitEvidence(input, state);
    } else {
      await preloadBroadSynthesisEvidence(input, state);
    }
  }
  if (governedEvidencePreloaded || governedEvidenceReady(input, state)) {
    state.forceFinal = true;
    observe(state, { type: "governed_answer_card_evidence_ready" });
  }

  const actionTurnBudget = Math.min(
    40,
    2 + input.plan.requirements.length * MAX_AGENT_TURNS_PER_REQUIREMENT,
  );
  const maxTurns = actionTurnBudget + 4;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (deadlineReached(input)) state.forceFinal = true;
    const finalOnly = state.forceFinal || turn > actionTurnBudget ||
      !hasAvailableToolAction(state);
    let action;
    try {
      action = await requestAgentAction(input, state, turn, maxTurns, finalOnly);
    } catch (error) {
      if (error instanceof InvalidModelPayloadError) {
        const recoveryAction = finalOnly
          ? undefined
          : recoveryReadAction(state);
        if (recoveryAction === undefined) {
          const hasReadEvidence = [...state.requirements.values()].some(
            (requirementState) =>
              requirementState.directReadPaths.size > 0,
          );
          if (
            hasReadEvidence &&
            state.invalidPayloadTurnRetries === 0 &&
            turn < maxTurns &&
            !deadlineReached(input)
          ) {
            state.invalidPayloadTurnRetries += 1;
            state.forceFinal = true;
            observe(state, {
              type: "invalid_model_payload_recovered_with_final_retry",
            });
            continue;
          }
          return fallbackUnavailable(input, "invalid_model_payload");
        }
        action = recoveryAction;
        observe(state, {
          type: "invalid_model_payload_recovered_with_seed_read",
          pages: recoveryAction.input.pages,
        });
      } else {
        recordDiagnostic(input.trace, { event: "stop", reason: "model_unavailable" });
        return unavailableResult(input.scope);
      }
    }

    if (action.action === "final") {
      let normalizedAction = enforceMissingInputConditions(
        dropUnsupportedRelatedContext(
          normalizeFinalCitationMetadata(action, input.plan),
          state,
        ),
        input.plan,
        state.evidenceConditions,
      );
      shareFinalAnswerEvidence(input, state, normalizedAction);
      normalizedAction = dropUnsupportedRequirementCitationSegments(
        normalizedAction,
        input.plan,
        state,
      );
      const missingDraftCardConcepts = missingAnswerCardRequiredConcepts(
        normalizedAction,
        input.requirementBindings,
        readEvidence(state),
      );
      if (
        missingDraftCardConcepts.length > 0 &&
        state.answerCardConceptRepairAttempts < 2 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.answerCardConceptRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "answer_card_concept_repair_required",
          requirements: missingDraftCardConcepts,
        });
        continue;
      }
      if (missingDraftCardConcepts.length > 0) {
        normalizedAction = applyGroundedAnswerCardRequiredConcepts(
          normalizedAction,
          input.requirementBindings,
          readEvidence(state),
        );
        const remainingDraftCardConcepts = missingAnswerCardRequiredConcepts(
          normalizedAction,
          input.requirementBindings,
          readEvidence(state),
        );
        if (remainingDraftCardConcepts.length > 0) {
          return fallbackUnavailable(input, "invalid_final");
        }
        observe(state, {
          type: "answer_card_grounded_fact_projection",
          requirements: missingDraftCardConcepts,
        });
      }
      const comparisonSubjectRepairs = pendingComparisonSubjectRepairs(
        normalizedAction,
        state,
      );
      if (
        comparisonSubjectRepairs.length > 0 &&
        state.comparisonSubjectRepairAttempts === 0 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.comparisonSubjectRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "comparison_subject_repair_required",
          requirements: comparisonSubjectRepairs,
        });
        continue;
      }
      const directAnswerRepairs = pendingDirectAnswerRepairs(
        normalizedAction,
        state,
      );
      if (
        directAnswerRepairs.length > 0 &&
        state.directAnswerRepairAttempts === 0 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.directAnswerRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "direct_answer_repair_required",
          requirements: directAnswerRepairs,
        });
        continue;
      }
      if (directAnswerRepairs.length > 0) {
        return fallbackUnavailable(input, "invalid_final");
      }
      const danglingCollectionRepairs = pendingDanglingCollectionRepairs(
        normalizedAction,
      );
      if (danglingCollectionRepairs.length > 0) {
        if (
          state.structuredCoverageRepairAttempts < 2 &&
          turn < maxTurns &&
          !deadlineReached(input)
        ) {
          state.structuredCoverageRepairAttempts += 1;
          state.forceFinal = true;
          observe(state, {
            type: "structured_coverage_repair_required",
            reason: "dangling_collection_enumeration",
            requirements: danglingCollectionRepairs,
          });
          continue;
        }
        return fallbackUnavailable(input, "invalid_final");
      }
      const pendingReviews = pendingEvidenceReviews(normalizedAction, state);
      if (pendingReviews.length > 0 && !deadlineReached(input)) {
        observe(state, {
          type: "coverage_gate_requires_read",
          requirements: pendingReviews,
        });
        const forcedRead = recoveryReadAction(state, pendingReviews);
        if (forcedRead === undefined) {
          normalizedAction = closeEvidenceReviewAtRetrievalBoundary(
            normalizedAction,
            pendingReviews,
            state,
          );
        } else {
          const readsBefore = directReadCount(state, pendingReviews);
          try {
            await executeToolAction(forcedRead, input, state);
          } catch {
            // A failed forced review is represented as a retrieval gap below.
          }
          const readsAfter = directReadCount(state, pendingReviews);
          if (readsAfter <= readsBefore) {
            normalizedAction = closeEvidenceReviewAtRetrievalBoundary(
              normalizedAction,
              pendingReviews,
              state,
            );
          } else {
            state.forceFinal = true;
            observe(state, {
              type: "coverage_gate_forced_read",
              pages: forcedRead.input.pages,
            });
            if (turn < maxTurns) continue;
            normalizedAction = closeEvidenceReviewAtRetrievalBoundary(
              normalizedAction,
              pendingReviews,
              state,
            );
          }
        }
      }
      const validation = state.references.validateFinal(
        normalizedAction,
        input.plan.requirements,
        evidenceByRequirement(state),
      );
      if (!validation.ok) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: validation.reason,
          repairAttempt: state.citationRepairAttempts + 1,
        });
        if (
          state.citationRepairAttempts < MAX_CITATION_REPAIR_ATTEMPTS &&
          turn < maxTurns
        ) {
          state.citationRepairAttempts += 1;
          state.forceFinal = true;
          observe(state, { type: "invalid_citations", reason: validation.reason });
          continue;
        }
        return fallbackUnavailable(input, "invalid_final");
      }
      recordCoverage(
        input,
        state,
        normalizedAction,
        "draft",
        deadlineReached(input) ? "deadline" : "final",
      );
      if (deadlineReached(input)) {
        recordDiagnostic(input.trace, {
          event: "stop",
          reason: "coverage_verifier_unavailable",
        });
        return unavailableResult(input.scope);
      }
      let auditedAction: FinalAction;
      let verificationSummaries:
        readonly CoverageVerificationSummary[] | undefined;
      let verificationReport: CoverageVerificationReport | undefined;
      try {
        const activeSignal = toolSignal(input);
        auditedAction = await observeModelCall({
          trace: input.trace,
          role: "verifier",
          operation: "verify",
          ...(activeSignal === undefined ? {} : { signal: activeSignal }),
          call: () => (input.verifyCoverage ?? verifyKnowledgeCoverage)({
            question: input.question,
            plan: input.plan,
            draft: normalizedAction,
            evidence: coverageEvidence(normalizedAction, state),
            model: input.verifierModel ?? input.model,
            ...(activeSignal === undefined ? {} : { signal: activeSignal }),
            onVerified(summaries) {
              verificationSummaries = summaries;
            },
            onReport(report) {
              verificationReport = report;
            },
            onInvalid(invalid) {
              recordDiagnostic(input.trace, {
                event: "model_payload",
                result: "rejected",
                reason: invalid.reason,
                repairAttempt: invalid.attempt,
                ...(invalid.rawPayloadLength === undefined
                  ? {}
                  : { rawPayloadLength: invalid.rawPayloadLength }),
                ...(invalid.finishReason === undefined
                  ? {}
                  : { finishReason: invalid.finishReason }),
              });
            },
          }),
        });
      } catch (error) {
        if (!(error instanceof ModelUnavailableError)) {
          if (error instanceof InvalidCoverageVerificationError) {
            recordDiagnostic(input.trace, {
              event: "model_payload",
              result: "rejected",
              reason: error.code,
              repairAttempt: 3,
            });
          }
          return fallbackUnavailable(input, "coverage_verifier_invalid");
        }
        recordDiagnostic(input.trace, {
          event: "stop",
          reason: "coverage_verifier_unavailable",
        });
        return unavailableResult(input.scope);
      }
      const missingAuditedCardConcepts = missingAnswerCardRequiredConcepts(
        auditedAction,
        input.requirementBindings,
        readEvidence(state),
      );
      if (
        missingAuditedCardConcepts.length > 0 &&
        state.answerCardConceptRepairAttempts < 2 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.answerCardConceptRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "answer_card_concept_repair_required",
          requirements: missingAuditedCardConcepts,
        });
        continue;
      }
      let projectedAfterVerification = false;
      if (missingAuditedCardConcepts.length > 0) {
        const projected = applyGroundedAnswerCardRequiredConcepts(
          auditedAction,
          input.requirementBindings,
          readEvidence(state),
        );
        projectedAfterVerification = projected !== auditedAction;
        auditedAction = projected;
      }
      const auditedComparisonSubjectRepairs = pendingComparisonSubjectRepairs(
        auditedAction,
        state,
      );
      if (
        auditedComparisonSubjectRepairs.length > 0 &&
        state.comparisonSubjectRepairAttempts < 2 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.comparisonSubjectRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "comparison_subject_repair_required",
          requirements: auditedComparisonSubjectRepairs,
        });
        continue;
      }
      if (auditedComparisonSubjectRepairs.length > 0) {
        return fallbackUnavailable(input, "coverage_verifier_invalid");
      }
      const structuredCoverageRepairs = pendingStructuredCoverageRepairs(
        normalizedAction,
        auditedAction,
        input.plan,
      );
      if (
        structuredCoverageRepairs.length > 0 &&
        state.structuredCoverageRepairAttempts < 2 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.structuredCoverageRepairAttempts += 1;
        state.forceFinal = true;
        observe(state, {
          type: "structured_coverage_repair_required",
          requirements: structuredCoverageRepairs,
        });
        continue;
      }
      const auditedValidation = state.references.validateFinal(
        auditedAction,
        input.plan.requirements,
        evidenceByRequirement(state),
      );
      if (!auditedValidation.ok) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: auditedValidation.reason,
          repairAttempt: 1,
        });
        return fallbackUnavailable(input, "coverage_verifier_invalid");
      }
      const missingCardConcepts = missingAnswerCardRequiredConcepts(
        auditedAction,
        input.requirementBindings,
        readEvidence(state),
      );
      const reconciledAction = reconcileAnswerCardCoverage(
        auditedAction,
        missingCardConcepts,
        answerCardRequirementsWithGroundedConcepts(
          input.requirementBindings,
          readEvidence(state),
        ),
        verificationReport,
      );
      if (reconciledAction !== auditedAction || projectedAfterVerification) {
        auditedAction = reconciledAction;
        if (projectedAfterVerification) {
          try {
            verificationReport = inferCoverageVerificationReport(
              auditedAction,
              input.plan,
            );
            verificationSummaries = verificationReport.summaries;
          } catch {
            return fallbackUnavailable(input, "coverage_verifier_invalid");
          }
        } else if (verificationReport !== undefined) {
          try {
            verificationReport = coverageVerificationReport(
              auditedAction,
              verificationReport.summaries,
            );
          } catch {
            return fallbackUnavailable(input, "coverage_verifier_invalid");
          }
        }
        observe(state, {
          type: "answer_card_coverage_reconciled",
          partialRequirements: missingCardConcepts.map((item) => item.requirementId),
          groundedProjection: projectedAfterVerification,
        });
      }
      if (violatesAnswerCardForbiddenClaims(
        auditedAction,
        input.requirementBindings,
      )) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: "answer_card_forbidden_claim",
          repairAttempt: 1,
        });
        return fallbackUnavailable(input, "coverage_verifier_invalid");
      }
      if (verificationReport === undefined) {
        return fallbackUnavailable(input, "coverage_verifier_invalid");
      }
      let evidenceLedger: EvidenceLedger;
      let coverageGaps: readonly CoverageGap[];
      try {
        evidenceLedger = buildEvidenceLedger(
          input,
          state,
          auditedAction,
          verificationReport,
        );
        coverageGaps = analyzeCoverageGaps(evidenceLedger);
      } catch (error) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: `evidence_metadata_invalid:${
            error instanceof Error ? error.message : "unexpected_error"
          }`,
          repairAttempt: 1,
        });
        recordCoverage(
          input,
          state,
          auditedAction,
          "verified",
          "final",
          verificationSummaries ?? verificationReport.summaries,
        );
        return {
          outcome: "verified",
          project: input.session.project,
          revision: input.session.revision,
          action: auditedAction,
          references: state.references.resolve(auditedAction.citations),
        };
      }
      recordCoverage(
        input,
        state,
        auditedAction,
        "verified",
        deadlineReached(input) ? "deadline" : "final",
        verificationSummaries ?? verificationReport.summaries,
      );
      recordCoverageGapDiagnostics(input, evidenceLedger, coverageGaps);
      return {
        outcome: "verified",
        project: input.session.project,
        revision: input.session.revision,
        action: auditedAction,
        references: state.references.resolve(auditedAction.citations),
        verification: verificationReport,
        evidenceLedger,
        coverageGaps,
      };
    }
    if (finalOnly) {
      observe(state, { type: "tool_not_allowed" });
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (state.actionFingerprints.has(fingerprint)) {
      const requirementIds = actionRequirementIds(action);
      observe(state, {
        type: "duplicate_action",
        requirementIds,
        action: fingerprint,
      });
      for (const requirementId of requirementIds) {
        stopSearchAfterNoGain(state.requirements.get(requirementId));
      }
      continue;
    }
    state.actionFingerprints.add(fingerprint);

    try {
      await executeToolAction(action, input, state);
    } catch {
      state.actionFingerprints.delete(fingerprint);
      const requirementIds = actionRequirementIds(action);
      observe(state, {
        type: "tool_unavailable",
        requirementIds,
        tool: action.tool,
      });
      if (action.tool !== "kb.search") {
        for (const requirementId of requirementIds) {
          stopSearchAfterNoGain(state.requirements.get(requirementId));
        }
      }
    }
  }
  return fallbackUnavailable(input, "turn_budget_exhausted");
}

async function preloadCoverageUnitEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  const action = recoveryReadAction(
    state,
    input.plan.requirements.map((requirement) => requirement.id),
  );
  if (action === undefined) return;
  await executeToolAction(action, input, state);
}

function prepareGovernedEvidenceCandidates(
  input: KnowledgeAgentInput,
  state: AgentState,
): void {
  for (const binding of input.requirementBindings ?? []) {
    const paths = binding.preferredEvidencePaths ?? [];
    if (paths.length === 0) continue;
    input.session.authorizeGovernedPaths?.(paths);
    const requirementState = state.requirements.get(binding.requirementId);
    if (requirementState === undefined) {
      throw new Error("governed_evidence_requirement_missing");
    }
    for (const path of paths) {
      if (requirementState.candidatePaths.has(path)) continue;
      requirementState.candidatePaths.set(path, {
        path,
        title: path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path,
        rrfScore: 1,
        sourceQueries: new Set(["answer-card"]),
        rankings: [],
        matchedTerms: new Set(binding.requiredConcepts ?? []),
        snippets: new Set(),
        graphRelations: new Set(),
        aspectIds: new Set(
          requirementState.requirement.evidenceAspects.map((aspect) => aspect.id),
        ),
        ledgerSources: new Set(["seed"]),
        requirementSpecificMatch: true,
      });
    }
  }
}

async function preloadGovernedEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  for (const binding of input.requirementBindings ?? []) {
    const requirementState = state.requirements.get(binding.requirementId);
    if (requirementState === undefined) continue;
    for (const path of binding.preferredEvidencePaths ?? []) {
      if (!hasRemainingReadCapacity(requirementState)) break;
      try {
        await executeRead(
          {
            action: "tool",
            tool: "kb.read_page",
            input: { requirementId: binding.requirementId, path },
          },
          input,
          state,
          requirementState,
        );
      } catch {
        observe(state, {
          type: "tool_unavailable",
          requirementId: binding.requirementId,
          tool: "kb.read_page",
        });
      }
    }
  }
}

function governedEvidenceReady(
  input: KnowledgeAgentInput,
  state: AgentState,
): boolean {
  const bindings = input.requirementBindings ?? [];
  if (bindings.length === 0) return false;
  const bindingsByRequirement = new Map<string, DomainRequirementBinding[]>();
  for (const binding of bindings) {
    const current = bindingsByRequirement.get(binding.requirementId) ?? [];
    current.push(binding);
    bindingsByRequirement.set(binding.requirementId, current);
  }
  return input.plan.requirements.every((requirement) => {
    if (state.evidenceConditions.get(requirement.id)?.inputState === "missing") {
      return true;
    }
    const requirementState = state.requirements.get(requirement.id);
    const requirementBindings = bindingsByRequirement.get(requirement.id) ?? [];
    return requirementState !== undefined &&
      requirementBindings.length > 0 &&
      requirementBindings.every((binding) => {
        const preferredPaths = binding.preferredEvidencePaths ?? [];
        return preferredPaths.length > 0 &&
          preferredPaths.some((path) => requirementState.directReadPaths.has(path));
      });
  });
}

async function preloadBroadSynthesisEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  for (const requirementState of state.requirements.values()) {
    if (
      requirementState.requirement.evidenceMode !== "synthesis_allowed" ||
      requirementState.requirement.evidenceAspects.length < 4
    ) {
      continue;
    }
    while (
      requirementState.directReadPaths.size <
        readLimitFor(requirementState.requirement)
    ) {
      const selected: Candidate[] = [];
      const provisionallyCovered = new Set(requirementState.readAspectIds);
      for (const candidate of sortedCandidates(requirementState)) {
        if (
          requirementState.readPaths.has(candidate.path) ||
          hasUnresolvedReadFailure(requirementState, candidate.path) ||
          selected.length >= MAX_BATCH_READS_PER_REQUIREMENT
        ) {
          continue;
        }
        const gain = [...candidate.aspectIds].filter(
          (aspectId) => !provisionallyCovered.has(aspectId),
        );
        if (gain.length === 0) continue;
        selected.push(candidate);
        for (const aspectId of gain) provisionallyCovered.add(aspectId);
      }
      if (selected.length === 0) break;
      const before = requirementState.readAspectIds.size;
      const outcomes = await Promise.allSettled(selected.map((candidate) =>
        executeRead(
          {
            action: "tool",
            tool: "kb.read_page",
            input: {
              requirementId: requirementState.requirement.id,
              path: candidate.path,
            },
          },
          input,
          state,
          requirementState,
        )
      ));
      outcomes.forEach((outcome, index) => {
        if (outcome.status !== "rejected") return;
        observe(state, {
          type: "tool_unavailable",
          requirementId: requirementState.requirement.id,
          tool: "kb.read_page",
          candidateIndex: index,
        });
      });
      if (requirementState.readAspectIds.size === before) break;
      if (
        requirementState.requirement.evidenceAspects.every(
          (aspect) => requirementState.readAspectIds.has(aspect.id),
        )
      ) {
        break;
      }
    }
  }
}

function recoveryReadAction(
  state: AgentState,
  requirementIds?: readonly string[],
): Extract<ToolAction, { tool: "kb.read_pages" }> | undefined {
  const selectedRequirementIds = requirementIds === undefined
    ? undefined
    : new Set(requirementIds);
  const pages = [...state.requirements.values()].flatMap((requirementState) => {
    if (
      selectedRequirementIds !== undefined &&
      !selectedRequirementIds.has(requirementState.requirement.id)
    ) {
      return [];
    }
    if (
      !hasRemainingReadCapacity(requirementState)
    ) {
      return [];
    }
    const preferredPath = preferredUnreadDirectComparisonPath(
      requirementState,
    );
    const path = preferredPath ?? sortedCandidates(requirementState)
      .find((item) =>
        !requirementState.readPaths.has(item.path) &&
        !hasUnresolvedReadFailure(requirementState, item.path))?.path;
    return path === undefined
      ? []
      : [{
          requirementId: requirementState.requirement.id,
          path,
        }];
  });
  if (pages.length === 0) return undefined;
  return {
    action: "tool",
    tool: "kb.read_pages",
    input: { pages },
  };
}

function fallbackUnavailable(
  input: KnowledgeAgentInput,
  reason:
    | "invalid_model_payload"
    | "invalid_final"
    | "turn_budget_exhausted"
    | "coverage_verifier_invalid",
): AnswerResult {
  recordDiagnostic(input.trace, {
    event: "fallback",
    reason,
    outcome: "temporarily_unavailable",
  });
  recordDiagnostic(input.trace, { event: "stop", reason });
  return unavailableResult(input.scope);
}

function createAgentState(input: KnowledgeAgentInput): AgentState {
  return {
    actionFingerprints: new Set(),
    requirements: new Map(input.plan.requirements.map((requirement) => [
      requirement.id,
      {
        subject: input.plan.subject,
        requirement,
        queries: new Set([
          ...requirement.queries.map((query) => normalizeQuery(query.text)),
          ...(input.plan.retrievalStrategy === "coverage_units"
            ? []
            : [normalizeQuery(input.question)]),
        ]),
        candidatePaths: new Map(),
        seedCandidatePaths: new Set(),
        readPaths: new Set(),
        directReadPaths: new Set(),
        citationIndexes: new Set(),
        readAspectIds: new Set(),
        queryRecords: [],
        readRecords: [],
        graphRecords: [],
        successfulSeedSearches: 0,
        failedSeedSearches: 0,
        supplementalSearches: 0,
        graphActions: 0,
        noGainRounds: 0,
        searchStopped: false,
        searchBudgetExhausted: false,
        evidenceReviewExhausted: false,
        toolUnavailableCount: 0,
        accessDeniedCount: 0,
      },
    ])),
    references: new ReferenceRegistry(input.session.project, input.session.revision),
    evidenceDocuments: new Map(input.plan.requirements.map((requirement) => [
      requirement.id,
      new Map(),
    ])),
    observations: [...answerCardPolicyObservations(input.requirementBindings)],
    evidenceConditions: requirementEvidenceConditions(input),
    readProvenanceByCitation: new Map(),
    citationRepairAttempts: 0,
    directAnswerRepairAttempts: 0,
    comparisonSubjectRepairAttempts: 0,
    structuredCoverageRepairAttempts: 0,
    answerCardConceptRepairAttempts: 0,
    invalidPayloadTurnRetries: 0,
    forceFinal: false,
    successfulSeedSearches: 0,
  };
}

async function executeSeedSearches(input: KnowledgeAgentInput, state: AgentState): Promise<void> {
  const globalQuery = input.question.trim();
  type ExpandedSeedQuery = ReturnType<typeof expandSeedQueries>[number];
  type PhysicalSeedQuery = {
    readonly text: string;
    readonly consumers: Map<string, ExpandedSeedQuery>;
    readonly aspectIds: Set<string>;
    topK: number;
    global: boolean;
  };
  type PhysicalSeedResult = {
    readonly query: string;
    readonly status: "success" | "empty" | "unavailable";
    readonly result?: KnowledgeSearchResult;
  };

  const expandedByRequirement = new Map<string, readonly ExpandedSeedQuery[]>();
  const physicalQueries = new Map<string, PhysicalSeedQuery>();
  for (const requirementState of state.requirements.values()) {
    if (
      state.evidenceConditions.get(requirementState.requirement.id)?.inputState ===
        "missing"
    ) {
      expandedByRequirement.set(requirementState.requirement.id, []);
      continue;
    }
    const seedQueries = expandSeedQueries(requirementState.requirement);
    expandedByRequirement.set(requirementState.requirement.id, seedQueries);
    const topK = seedTopKFor(requirementState.requirement);
    for (const query of seedQueries) {
      requirementState.queries.add(normalizeQuery(query.text));
      const normalized = normalizeQuery(query.text);
      const physical = physicalQueries.get(normalized) ?? {
        text: query.text,
        consumers: new Map<string, ExpandedSeedQuery>(),
        aspectIds: new Set<string>(),
        topK,
        global: false,
      };
      physical.consumers.set(requirementState.requirement.id, query);
      physical.topK = Math.max(physical.topK, topK);
      for (const aspectId of query.aspectIds) physical.aspectIds.add(aspectId);
      physicalQueries.set(normalized, physical);
    }
  }
  const globalEnabled = input.plan.retrievalStrategy !== "coverage_units";
  const normalizedGlobalQuery = normalizeQuery(globalQuery);
  if (globalEnabled) {
    const physical = physicalQueries.get(normalizedGlobalQuery) ?? {
      text: globalQuery,
      consumers: new Map<string, ExpandedSeedQuery>(),
      aspectIds: new Set<string>(),
      topK: SEED_TOP_K,
      global: false,
    };
    physical.global = true;
    physical.topK = Math.max(physical.topK, SEED_TOP_K);
    physicalQueries.set(normalizedGlobalQuery, physical);
  }

  const physicalResults = new Map<string, PhysicalSeedResult>();
  await Promise.all([...physicalQueries.entries()].map(async ([normalized, physical]) => {
    const consumerIds = [...physical.consumers.keys()];
    const diagnosticRequirementId = physical.global || consumerIds.length !== 1
      ? "GLOBAL"
      : consumerIds[0]!;
    recordDiagnostic(input.trace, {
      event: "search",
      requirementId: diagnosticRequirementId,
      phase: "seed",
      queryChars: physical.text.length,
      aspectIds: [...physical.aspectIds],
    });
    try {
      const result = await input.session.search(
        physical.text,
        physical.topK,
        toolSignal(input),
      );
      state.successfulSeedSearches += 1;
      physicalResults.set(normalized, {
        query: physical.text,
        status: result.hits.length > 0 ? "success" : "empty",
        result,
      });
    } catch {
      physicalResults.set(normalized, {
        query: physical.text,
        status: "unavailable",
      });
    }
  }));

  for (const requirementState of state.requirements.values()) {
    if (
      state.evidenceConditions.get(requirementState.requirement.id)?.inputState ===
        "missing"
    ) {
      requirementState.searchStopped = true;
      requirementState.noGainRounds = 1;
      requirementState.queryRecords.push(
        ...requirementState.requirement.queries.map((query, plannedQueryIndex) => ({
          phase: "seed" as const,
          query: query.text,
          aspectIds: [...query.aspectIds],
          status: "not_applicable" as const,
          plannedQueryIndexes: [plannedQueryIndex],
        })),
      );
      observeCandidates(state, requirementState, "seed_search_result", input.trace);
      continue;
    }
    let gained = false;
    const seedQueries = expandedByRequirement.get(
      requirementState.requirement.id,
    ) ?? [];
    const handledPhysicalQueries = new Set<string>();
    for (const query of seedQueries) {
      const normalized = normalizeQuery(query.text);
      const execution = physicalResults.get(normalized);
      if (execution === undefined) throw new Error("seed_execution_missing");
      handledPhysicalQueries.add(normalized);
      requirementState.queryRecords.push({
        phase: "seed",
        query: execution.query,
        aspectIds: [...query.aspectIds],
        status: execution.status,
        plannedQueryIndexes: [...query.plannedQueryIndexes],
      });
      if (execution.status === "unavailable" || execution.result === undefined) {
        requirementState.failedSeedSearches += 1;
        requirementState.toolUnavailableCount += 1;
        observe(state, {
          type: "seed_search_unavailable",
          requirementId: requirementState.requirement.id,
          query: execution.query,
        });
        continue;
      }
      requirementState.successfulSeedSearches += 1;
      for (const hit of execution.result.hits) {
        requirementState.seedCandidatePaths.add(hit.path);
      }
      gained = mergeSearchResults(requirementState, [{
        query: execution.query,
        aspectIds: query.aspectIds,
        result: limitSearchResult(
          execution.result,
          seedTopKFor(requirementState.requirement),
        ),
      }]) || gained;
    }

    if (globalEnabled && !handledPhysicalQueries.has(normalizedGlobalQuery)) {
      const execution = physicalResults.get(normalizedGlobalQuery);
      if (execution === undefined) throw new Error("global_seed_execution_missing");
      const aspectIds = matchingAspectIds(
        requirementState.requirement,
        globalQuery,
      );
      requirementState.queryRecords.push({
        phase: "seed",
        query: execution.query,
        aspectIds,
        status: execution.status,
        plannedQueryIndexes: [],
      });
      if (execution.status === "unavailable" || execution.result === undefined) {
        requirementState.toolUnavailableCount += 1;
        observe(state, {
          type: "global_question_search_unavailable",
          requirementId: requirementState.requirement.id,
        });
      } else {
        gained = mergeSearchResults(requirementState, [{
          query: execution.query,
          aspectIds,
          result: limitSearchResult(execution.result, SEED_TOP_K),
        }], false) || gained;
      }
    }
    if (!gained) requirementState.noGainRounds = 1;
    observeCandidates(state, requirementState, "seed_search_result", input.trace);
  }
}

async function requestAgentAction(
  input: KnowledgeAgentInput,
  state: AgentState,
  turn: number,
  maxTurns: number,
  finalOnly: boolean,
) {
  const messages = knowledgeAgentMessages({
      question: input.question,
      ...(input.conversationContext === undefined ? {} : { conversationContext: input.conversationContext }),
      purpose: input.session.purpose,
      schema: input.session.schema,
      plan: input.plan,
      requirementEvidence: requirementEvidence(state),
      readEvidence: readEvidence(state),
      observations: state.observations,
      references: state.references.list(),
      remainingTurns: maxTurns - turn + 1,
      remainingRetrievalActions: countRemainingToolActions(state),
      finalOnly,
    });
  const request = (repairReason?: string) => {
    const activeSignal = toolSignal(input);
    return observeModelCall({
      trace: input.trace,
      role: "synthesizer",
      operation: "synthesize",
      ...(activeSignal === undefined ? {} : { signal: activeSignal }),
      call: () => input.model.completeJson({
        messages: repairReason !== undefined
          ? [...messages, {
              role: "user" as const,
              content: finalOnly
                ? `上一次输出不符合 Schema：${repairReason}。只输出合法 final JSON；必须完整列出规划中的每个 requirement 及其 coverage/citations，不要解释。`
                : `上一次输出不符合 Schema：${repairReason}。只输出一个合法 JSON 动作；单页/搜索/图谱工具输入必须包含 requirementId，批量读页必须使用 pages 数组且每项包含 requirementId/path，final 必须完整列出逐项 requirements，不要解释。`,
            }]
          : messages,
        schema: finalOnly ? finalOnlyActionSchema : agentActionSchema,
        schemaDescription: finalOnly ? "pse_final_action" : "pse_agent_action",
        ...(activeSignal === undefined ? {} : { signal: activeSignal }),
      }),
    });
  };
  let repairReason: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request(repairReason);
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      recordRejectedModelPayload(input, error, attempt);
      if (attempt === 3) throw error;
      repairReason = modelPayloadRepairReason(error);
    }
  }
  throw new InvalidModelPayloadError();
}

function recordRejectedModelPayload(
  input: KnowledgeAgentInput,
  error: InvalidModelPayloadError,
  attempt: number,
): void {
  recordDiagnostic(input.trace, {
    event: "model_payload",
    result: "rejected",
    reason: error.code,
    repairAttempt: attempt,
    ...(error.rawPayloadLength === undefined
      ? {}
      : { rawPayloadLength: error.rawPayloadLength }),
    ...(error.finishReason === undefined
      ? {}
      : { finishReason: error.finishReason }),
  });
}

function modelPayloadRepairReason(error: InvalidModelPayloadError): string {
  const details = [
    error.code,
    ...(error.finishReason === undefined
      ? []
      : [`finish_reason=${error.finishReason}`]),
    ...(error.rawPayloadLength === undefined
      ? []
      : [`raw_length=${error.rawPayloadLength}`]),
  ];
  if (error.finishReason === "abort" || error.finishReason === "length") {
    details.push(
      "上一次 JSON 在闭合前被服务中止；删除重复说明，每个 requirement.answer 控制在 600 个汉字以内，优先完整输出全部字段并闭合 JSON",
    );
  }
  return details.join(";");
}

async function executeToolAction(
  action: ToolAction,
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  if (action.tool === "kb.read_pages") {
    await executeBatchReads(action, input, state);
    return;
  }
  const requirementState = state.requirements.get(action.input.requirementId);
  if (!requirementState) {
    observe(state, {
      type: "unknown_requirement",
      requirementId: action.input.requirementId,
    });
    return;
  }
  switch (action.tool) {
    case "kb.search":
      if (!hasOnlyKnownAspectIds(
        requirementState.requirement,
        action.input.aspectIds,
      )) {
        observe(state, {
          type: "unknown_search_aspect",
          requirementId: requirementState.requirement.id,
          aspectIds: action.input.aspectIds,
        });
        return;
      }
      await executeSupplementalSearch(action, input, state, requirementState);
      return;
    case "kb.read_page":
      {
        const preferredPath =
          preferredUnreadDirectComparisonPath(requirementState);
        if (
          preferredPath !== undefined &&
          !isExactDirectComparisonCandidate(
            requirementState,
            action.input.path,
          )
        ) {
          observe(state, {
            type: "direct_comparison_read_redirected",
            requirementId: action.input.requirementId,
            requestedPath: action.input.path,
            selectedPath: preferredPath,
          });
          await executeRead(
            {
              action: "tool",
              tool: "kb.read_page",
              input: {
                requirementId: action.input.requirementId,
                path: preferredPath,
              },
            },
            input,
            state,
            requirementState,
          );
          return;
        }
      }
      if (
        shouldDeferAdjacentComparisonRead(
          requirementState,
          action.input.path,
          false,
        )
      ) {
        observe(state, {
          type: "adjacent_comparison_page_deferred",
          requirementId: action.input.requirementId,
          path: action.input.path,
        });
        return;
      }
      await executeRead(action, input, state, requirementState);
      return;
    case "kb.graph":
      await executeGraph(action, input, state, requirementState);
      return;
    default:
      assertNever(action);
  }
}

async function executeBatchReads(
  action: Extract<ToolAction, { tool: "kb.read_pages" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  const reserved = new Map<string, number>();
  const exactRequestedByRequirement = new Set(
    action.input.pages.flatMap((page) => {
      const requirementState = state.requirements.get(page.requirementId);
      return requirementState !== undefined &&
          isExactDirectComparisonCandidate(requirementState, page.path)
        ? [page.requirementId]
        : [];
    }),
  );
  const redirectedRequirements = new Set<string>();
  const requestedPages = action.input.pages.map((page) => {
    const requirementState = state.requirements.get(page.requirementId);
    if (
      requirementState === undefined ||
      exactRequestedByRequirement.has(page.requirementId) ||
      redirectedRequirements.has(page.requirementId) ||
      isExactDirectComparisonCandidate(requirementState, page.path)
    ) {
      return page;
    }
    const preferredPath =
      preferredUnreadDirectComparisonPath(requirementState);
    if (preferredPath === undefined) return page;
    redirectedRequirements.add(page.requirementId);
    observe(state, {
      type: "direct_comparison_read_redirected",
      requirementId: page.requirementId,
      requestedPath: page.path,
      selectedPath: preferredPath,
    });
    return { ...page, path: preferredPath };
  });
  const requestedExactComparisons = new Set(
    requestedPages.flatMap((page) => {
      const requirementState = state.requirements.get(page.requirementId);
      return requirementState !== undefined &&
          isExactDirectComparisonCandidate(requirementState, page.path)
        ? [page.requirementId]
        : [];
    }),
  );
  const accepted: Array<{
    page: { requirementId: string; path: string };
    requirementState: RequirementState;
  }> = [];
  for (const page of requestedPages) {
    const requirementState = state.requirements.get(page.requirementId);
    if (!requirementState) {
      observe(state, {
        type: "unknown_requirement",
        requirementId: page.requirementId,
      });
      continue;
    }
    if (!requirementState.candidatePaths.has(page.path)) {
      observe(state, {
        type: "path_not_candidate_for_requirement",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    if (
      shouldDeferAdjacentComparisonRead(
        requirementState,
        page.path,
        requestedExactComparisons.has(page.requirementId),
      )
    ) {
      observe(state, {
        type: "adjacent_comparison_page_deferred",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    const pending = reserved.get(page.requirementId) ?? 0;
    if (pending >= MAX_BATCH_READS_PER_REQUIREMENT) {
      observe(state, {
        type: "batch_read_deferred_for_requirement",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    if (
      requirementState.readPaths.has(page.path) ||
      !canReadEvidencePath(requirementState, page.path, pending)
    ) {
      observe(state, {
        type: "requirement_read_budget_exhausted",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    reserved.set(page.requirementId, pending + 1);
    accepted.push({ page, requirementState });
  }
  const distinctReads = new Map<
    string,
    {
      page: { requirementId: string; path: string };
      requirementState: RequirementState;
      consumers: Array<{
        page: { requirementId: string; path: string };
        requirementState: RequirementState;
      }>;
    }
  >();
  for (const acceptedRead of accepted) {
    const existing = distinctReads.get(acceptedRead.page.path);
    if (existing === undefined) {
      distinctReads.set(acceptedRead.page.path, {
        ...acceptedRead,
        consumers: [acceptedRead],
      });
    } else {
      existing.consumers.push(acceptedRead);
    }
  }
  await Promise.all([...distinctReads.values()].map(async ({
    page,
    requirementState,
    consumers,
  }) => {
    try {
      const executed = await executeRead(
        {
          action: "tool",
          tool: "kb.read_page",
          input: page,
        },
        input,
        state,
        requirementState,
      );
      if (executed !== undefined) {
        for (const consumer of consumers) {
          if (consumer.requirementState === requirementState) continue;
          shareReadEvidenceToRequirement(
            input,
            state,
            requirementState.requirement.id,
            consumer.page.requirementId,
            executed.page,
            executed.citation,
            executed.content,
            true,
          );
        }
      }
    } catch (error) {
      for (const consumer of consumers) {
        if (consumer.requirementState !== requirementState) {
          recordReadFailure(
            consumer.requirementState,
            page.path,
            error,
          );
        }
        observe(state, {
          type: "tool_unavailable",
          requirementId: consumer.page.requirementId,
          tool: "kb.read_page",
        });
        stopSearchAfterNoGain(consumer.requirementState);
      }
    }
  }));
}

async function executeSupplementalSearch(
  action: Extract<ToolAction, { tool: "kb.search" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<void> {
  const query = normalizeQuery(action.input.query);
  if (
    requirementState.searchStopped ||
    requirementState.supplementalSearches >= MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT
  ) {
    if (
      requirementState.supplementalSearches >=
        MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT
    ) {
      requirementState.searchBudgetExhausted = true;
    }
    observe(state, {
      type: "requirement_search_budget_exhausted",
      requirementId: requirementState.requirement.id,
    });
    return;
  }
  if (
    requirementState.queries.has(query) &&
    !hasUnrecoveredQueryFailure(requirementState, query)
  ) {
    observe(state, {
      type: "duplicate_query",
      requirementId: requirementState.requirement.id,
      query: action.input.query,
    });
    stopSearchAfterNoGain(requirementState);
    return;
  }
  requirementState.queries.add(query);
  requirementState.supplementalSearches += 1;
  recordDiagnostic(input.trace, {
    event: "search",
    requirementId: requirementState.requirement.id,
    phase: "supplemental",
    queryChars: action.input.query.length,
    aspectIds: action.input.aspectIds,
  });
  let result: KnowledgeSearchResult;
  try {
    result = await input.session.search(
      action.input.query,
      action.input.topK,
      toolSignal(input),
    );
    requirementState.queryRecords.push({
      phase: "supplemental",
      query: action.input.query,
      aspectIds: [...action.input.aspectIds],
      status: result.hits.length > 0 ? "success" : "empty",
      plannedQueryIndexes: [],
    });
  } catch (error) {
    requirementState.toolUnavailableCount += 1;
    requirementState.queryRecords.push({
      phase: "supplemental",
      query: action.input.query,
      aspectIds: [...action.input.aspectIds],
      status: "unavailable",
      plannedQueryIndexes: [],
    });
    throw error;
  }
  const gained = mergeSearchResults(requirementState, [{
    query: action.input.query,
    aspectIds: action.input.aspectIds,
    result,
  }], true, "supplemental");
  requirementState.noGainRounds = gained ? 0 : requirementState.noGainRounds + 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
  observeCandidates(state, requirementState, "supplemental_search_result", input.trace);
}

function hasUnrecoveredQueryFailure(
  requirementState: RequirementState,
  normalizedQuery: string,
): boolean {
  const matching = requirementState.queryRecords.filter((record) =>
    normalizeQuery(record.query) === normalizedQuery);
  return matching.some((record) => record.status === "unavailable") &&
    !matching.some((record) => record.status !== "unavailable");
}

async function executeRead(
  action: Extract<ToolAction, { tool: "kb.read_page" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<{
  readonly page: KnowledgePage;
  readonly citation: number;
  readonly content: string;
} | undefined> {
  if (!requirementState.candidatePaths.has(action.input.path)) {
    observe(state, {
      type: "path_not_candidate_for_requirement",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  if (
    requirementState.readPaths.has(action.input.path) ||
    !canReadEvidencePath(requirementState, action.input.path)
  ) {
    observe(state, {
      type: "requirement_read_budget_exhausted",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  let page: KnowledgePage;
  try {
    page = await input.session.readPage(action.input.path, toolSignal(input));
  } catch (error) {
    recordReadFailure(requirementState, action.input.path, error);
    throw error;
  }
  if (
    requirementState.readPaths.has(page.path) ||
    !canReadEvidencePath(requirementState, page.path)
  ) {
    return;
  }
  const reference = state.references.register({
    project: input.session.project,
    revision: input.session.revision,
    page,
  });
  const candidate = requirementState.candidatePaths.get(page.path);
  if (candidate !== undefined) candidate.title = page.title;
  recordSuccessfulRead(state, requirementState, {
    path: page.path,
    pageType: page.type,
    sources: [...page.sources],
  }, reference.index, true);
  const terms = [
    requirementState.requirement.question,
    ...requirementState.requirement.queries.map((query) => query.text),
    ...requirementState.requirement.evidenceAspects.flatMap(
      (aspect) => [aspect.label, ...aspect.terms],
    ),
    ...(candidate === undefined ? [] : candidate.matchedTerms),
  ];
  const content = input.session.compactPage(page, terms);
  const resolvedAspectIds = [
    ...new Set([
      ...(candidate?.aspectIds ?? []),
      ...matchingAspectIds(
        requirementState.requirement,
        `${page.title}\n${content}`,
      ),
    ]),
  ];
  for (const aspectId of resolvedAspectIds) {
    candidate?.aspectIds.add(aspectId);
    requirementState.readAspectIds.add(aspectId);
  }
  state.evidenceDocuments.get(requirementState.requirement.id)?.set(
    reference.index,
    {
      title: page.title,
      path: page.path,
      content,
      aspectIds: resolvedAspectIds,
    },
  );
  observe(state, {
    type: "read_page",
    requirementId: requirementState.requirement.id,
    reference: reference.index,
    path: page.path,
    aspectIds: resolvedAspectIds,
  });
  recordDiagnostic(input.trace, {
    event: "read",
    requirementId: requirementState.requirement.id,
    citation: reference.index,
    sectionHeadingCount: markdownHeadings(content).length,
    aspectIds: resolvedAspectIds,
  });
  shareReadEvidence(
    input,
    state,
    requirementState.requirement.id,
    page,
    reference.index,
    content,
  );
  return { page, citation: reference.index, content };
}

function recordReadFailure(
  requirementState: RequirementState,
  path: string,
  error: unknown,
): void {
  const accessDenied = isAccessDeniedError(error);
  if (accessDenied) {
    requirementState.accessDeniedCount += 1;
  } else {
    requirementState.toolUnavailableCount += 1;
  }
  requirementState.readRecords.push({
    path,
    status: accessDenied ? "access_denied" : "unavailable",
  });
}

function hasUnresolvedReadFailure(
  requirementState: RequirementState,
  path: string,
): boolean {
  return !requirementState.readPaths.has(path) &&
    requirementState.readRecords.some((read) =>
      read.path === path && read.status !== "success");
}

function recordSuccessfulRead(
  state: AgentState,
  requirementState: RequirementState,
  provenance: {
    readonly path: string;
    readonly pageType: string;
    readonly sources: readonly string[];
  },
  citation: number,
  direct: boolean,
): boolean {
  if (requirementState.readRecords.some((read) =>
    read.path === provenance.path && read.status === "success")) {
    requirementState.readPaths.add(provenance.path);
    requirementState.citationIndexes.add(citation);
    if (direct) requirementState.directReadPaths.add(provenance.path);
    state.readProvenanceByCitation.set(citation, {
      path: provenance.path,
      pageType: provenance.pageType,
      sources: [...provenance.sources],
    });
    return false;
  }
  const resolvedFailures = requirementState.readRecords.filter((read) =>
    read.path === provenance.path && read.status !== "success");
  requirementState.accessDeniedCount = Math.max(
    0,
    requirementState.accessDeniedCount -
      resolvedFailures.filter((read) => read.status === "access_denied").length,
  );
  requirementState.toolUnavailableCount = Math.max(
    0,
    requirementState.toolUnavailableCount -
      resolvedFailures.filter((read) => read.status === "unavailable").length,
  );
  requirementState.readPaths.add(provenance.path);
  if (direct) requirementState.directReadPaths.add(provenance.path);
  requirementState.citationIndexes.add(citation);
  requirementState.readRecords.push({
    path: provenance.path,
    status: "success",
    citation,
    pageType: provenance.pageType,
    sources: [...provenance.sources],
  });
  state.readProvenanceByCitation.set(citation, {
    path: provenance.path,
    pageType: provenance.pageType,
    sources: [...provenance.sources],
  });
  return true;
}

function shareReadEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
  fromRequirementId: string,
  page: KnowledgePage,
  citation: number,
  content: string,
): void {
  const path = page.path;
  for (const [toRequirementId, requirementState] of state.requirements) {
    const targetCandidate = requirementState.candidatePaths.get(path);
    if (
      toRequirementId === fromRequirementId ||
      state.evidenceConditions.get(toRequirementId)?.inputState === "missing" ||
      !targetCandidate?.requirementSpecificMatch ||
      requirementState.readPaths.has(path)
    ) {
      continue;
    }
    shareReadEvidenceToRequirement(
      input,
      state,
      fromRequirementId,
      toRequirementId,
      page,
      citation,
      content,
      false,
    );
  }
}

function shareReadEvidenceToRequirement(
  input: KnowledgeAgentInput,
  state: AgentState,
  fromRequirementId: string,
  toRequirementId: string,
  page: KnowledgePage,
  citation: number,
  content: string,
  direct: boolean,
): void {
  const requirementState = state.requirements.get(toRequirementId);
  const targetCandidate = requirementState?.candidatePaths.get(page.path);
  if (requirementState === undefined || targetCandidate === undefined) return;
  const newlyRecorded = recordSuccessfulRead(state, requirementState, {
    path: page.path,
    pageType: page.type,
    sources: page.sources,
  }, citation, direct);
  if (!newlyRecorded) return;
  const path = page.path;
    const resolvedAspectIds = [
      ...new Set([
        ...targetCandidate.aspectIds,
        ...matchingAspectIds(requirementState.requirement, content),
      ]),
    ];
    for (const aspectId of resolvedAspectIds) {
      targetCandidate.aspectIds.add(aspectId);
      requirementState.readAspectIds.add(aspectId);
    }
    const reference = state.references.resolve([citation])[0];
    if (reference !== undefined) {
      state.evidenceDocuments.get(toRequirementId)?.set(citation, {
        title: reference.title,
        path: reference.path,
        content,
        aspectIds: resolvedAspectIds,
      });
    }
    observe(state, {
      type: "evidence_shared",
      fromRequirementId,
      toRequirementId,
      path,
      citation,
    });
    recordDiagnostic(input.trace, {
      event: "evidence_shared",
      fromRequirementId,
      toRequirementId,
      citation,
    });
}

function shareFinalAnswerEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
  action: FinalAction,
): void {
  for (const requirement of action.requirements) {
    if (state.evidenceConditions.get(requirement.id)?.inputState === "missing") {
      continue;
    }
    const targetState = state.requirements.get(requirement.id);
    const targetDocuments = state.evidenceDocuments.get(requirement.id);
    if (targetState === undefined || targetDocuments === undefined) continue;
    for (const citation of requirement.citations) {
      if (targetState.citationIndexes.has(citation)) continue;
      const source = [...state.evidenceDocuments.entries()].find(
        ([sourceRequirementId, documents]) =>
          sourceRequirementId !== requirement.id && documents.has(citation),
      );
      const document = source?.[1].get(citation);
      const provenance = state.readProvenanceByCitation.get(citation);
      if (
        source === undefined ||
        document === undefined ||
        provenance === undefined ||
        provenance.path !== document.path
      ) {
        continue;
      }
      const targetCandidate = targetState.candidatePaths.get(document.path);
      const semanticAspectIds = matchingAspectIds(
        targetState.requirement,
        `${document.title}\n${document.content}`,
      );
      if (
        input.plan.retrievalStrategy === "coverage_units" &&
        !targetCandidate?.requirementSpecificMatch &&
        semanticAspectIds.length === 0
      ) {
        continue;
      }
      recordSuccessfulRead(
        state,
        targetState,
        provenance,
        citation,
        false,
      );
      const resolvedAspectIds = [
        ...new Set([
          ...(targetCandidate?.aspectIds ?? []),
          ...semanticAspectIds,
        ]),
      ];
      for (const aspectId of resolvedAspectIds) {
        targetState.readAspectIds.add(aspectId);
      }
      targetDocuments.set(citation, {
        ...document,
        aspectIds: resolvedAspectIds,
      });
      observe(state, {
        type: "evidence_shared",
        fromRequirementId: source[0],
        toRequirementId: requirement.id,
        path: document.path,
        citation,
      });
      recordDiagnostic(input.trace, {
        event: "evidence_shared",
        fromRequirementId: source[0],
        toRequirementId: requirement.id,
        citation,
      });
    }
  }
}

async function executeGraph(
  action: Extract<ToolAction, { tool: "kb.graph" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<void> {
  const sourceCandidate = requirementState.candidatePaths.get(action.input.path);
  if (
    requirementState.graphActions >= MAX_GRAPH_ACTIONS_PER_REQUIREMENT ||
    sourceCandidate === undefined
  ) {
    observe(state, {
      type: "requirement_graph_action_rejected",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  if (
    input.plan.retrievalStrategy === "coverage_units" &&
    !sourceCandidate.requirementSpecificMatch
  ) {
    observe(state, {
      type: "graph_source_not_requirement_specific",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  requirementState.graphActions += 1;
  let result: KnowledgeGraphResult;
  try {
    result = await input.session.graph(
      action.input.path,
      action.input.topK,
      toolSignal(input),
    );
  } catch (error) {
    requirementState.toolUnavailableCount += 1;
    requirementState.graphRecords.push({
      sourcePath: action.input.path,
      status: "unavailable",
      hitCount: 0,
    });
    throw error;
  }
  requirementState.graphRecords.push({
    sourcePath: action.input.path,
    status: result.hits.length > 0 ? "success" : "empty",
    hitCount: result.hits.length,
  });
  const gained = mergeGraphResult(requirementState, action.input.path, result);
  requirementState.noGainRounds = gained ? 0 : requirementState.noGainRounds + 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
  observeCandidates(state, requirementState, "graph_result", input.trace);
}

function mergeSearchResults(
  requirementState: RequirementState,
  searches: readonly {
    query: string;
    aspectIds: readonly string[];
    result: KnowledgeSearchResult;
  }[],
  requirementSpecific = true,
  ledgerSource: EvidenceCandidateSource = "seed",
): boolean {
  let gained = false;
  for (const { query, aspectIds, result } of searches) {
    result.hits.forEach((hit, index) => {
      const existing = requirementState.candidatePaths.get(hit.path);
      if (!existing) gained = true;
      const candidate = existing ?? {
        path: hit.path,
        title: hit.title,
        rrfScore: 0,
        sourceQueries: new Set<string>(),
        rankings: [],
        matchedTerms: new Set<string>(),
        snippets: new Set<string>(),
        graphRelations: new Set<string>(),
        aspectIds: new Set<string>(),
        ledgerSources: new Set<EvidenceCandidateSource>(),
        requirementSpecificMatch: false,
      };
      candidate.title = hit.title;
      candidate.requirementSpecificMatch ||= requirementSpecific;
      candidate.ledgerSources.add(ledgerSource);
      candidate.rrfScore += 1 / (RRF_K + index + 1);
      candidate.sourceQueries.add(query);
      for (const aspectId of attributedSearchAspectIds(
        requirementState.requirement,
        aspectIds,
        [
          hit.title,
          ...hit.matchedTerms,
          hit.snippet ?? "",
        ].join(" "),
      )) {
        candidate.aspectIds.add(aspectId);
      }
      candidate.rankings.push({ query, rank: index + 1, score: hit.score });
      for (const term of hit.matchedTerms) candidate.matchedTerms.add(term);
      if (hit.snippet) candidate.snippets.add(hit.snippet.slice(0, 500));
      requirementState.candidatePaths.set(hit.path, candidate);
    });
  }
  return gained;
}

function mergeGraphResult(
  requirementState: RequirementState,
  sourcePath: string,
  result: KnowledgeGraphResult,
): boolean {
  let gained = false;
  result.hits.forEach((hit, index) => {
    const existing = requirementState.candidatePaths.get(hit.path);
    if (!existing) gained = true;
    const candidate = existing ?? {
      path: hit.path,
      title: hit.title,
      rrfScore: 0,
      sourceQueries: new Set<string>(),
      rankings: [],
      matchedTerms: new Set<string>(),
      snippets: new Set<string>(),
      graphRelations: new Set<string>(),
      aspectIds: new Set<string>(),
      ledgerSources: new Set<EvidenceCandidateSource>(),
      requirementSpecificMatch: true,
    };
    candidate.title = hit.title;
    candidate.requirementSpecificMatch = true;
    candidate.ledgerSources.add("graph");
    candidate.rrfScore += 1 / (RRF_K + index + 1);
    candidate.sourceQueries.add(`graph:${sourcePath}`);
    candidate.graphRelations.add(hit.relation);
    const sourceAspectIds = [
      ...(requirementState.candidatePaths.get(sourcePath)?.aspectIds ?? []),
    ];
    const matchedAspectIds = matchingAspectIds(
      requirementState.requirement,
      hit.title,
    );
    for (const aspectId of (
      sourceAspectIds.length <= 1
        ? [...new Set([...sourceAspectIds, ...matchedAspectIds])]
        : matchedAspectIds
    )) {
      candidate.aspectIds.add(aspectId);
    }
    requirementState.candidatePaths.set(hit.path, candidate);
  });
  return gained;
}

function observeCandidates(
  state: AgentState,
  requirementState: RequirementState,
  type: "seed_search_result" | "supplemental_search_result" | "graph_result",
  trace?: DiagnosticTrace,
): void {
  observe(state, {
    type,
    requirementId: requirementState.requirement.id,
    candidateCount: requirementState.candidatePaths.size,
  });
  recordDiagnostic(trace, {
    event: "candidates",
    requirementId: requirementState.requirement.id,
    source: type,
    candidateCount: requirementState.candidatePaths.size,
    aspects: aspectStatuses(requirementState).map((aspect) => ({
      id: aspect.id,
      candidateCount: aspect.candidateCount,
      readCandidateCount: aspect.readCandidateCount,
    })),
  });
}

function requirementEvidence(state: AgentState) {
  return [...state.requirements.values()].map((requirementState) => ({
    id: requirementState.requirement.id,
    question: requirementState.requirement.question,
    evidenceCondition: state.evidenceConditions.get(requirementState.requirement.id) ?? {
      requirementId: requirementState.requirement.id,
      conflictDetected: false,
      freshness: "not_assessed" as const,
      inputState: "not_applicable" as const,
      ambiguous: false,
    },
    aspects: aspectStatuses(requirementState),
    candidates: sortedCandidates(requirementState).slice(0, 10).map((candidate) => {
      const read = requirementState.readPaths.has(candidate.path);
      return {
      path: candidate.path,
      title: candidate.title,
      rrfScore: roundedScore(candidate.rrfScore),
      sourceQueries: [...candidate.sourceQueries].slice(0, 3),
      rankings: candidate.rankings.slice(0, 3),
      matchedTerms: [...candidate.matchedTerms].slice(0, 8),
      snippets: read
        ? []
        : [...candidate.snippets].slice(0, 1).map((snippet) => snippet.slice(0, 240)),
      graphRelations: [...candidate.graphRelations].slice(0, 3),
      aspectIds: [...candidate.aspectIds],
      read,
    };
    }),
    citationIndexes: [...requirementState.citationIndexes],
    remainingSearches: requirementState.searchStopped
      ? 0
      : MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT - requirementState.supplementalSearches,
    remainingReads:
      readLimitFor(requirementState.requirement) -
      requirementState.directReadPaths.size,
  }));
}

function readEvidence(state: AgentState) {
  return [...state.evidenceDocuments.entries()].flatMap(
    ([requirementId, documents]) =>
      [...documents.entries()].map(([citation, document]) => ({
        requirementId,
        citation,
        ...document,
      })),
  );
}

function evidenceByRequirement(state: AgentState): ReadonlyMap<string, ReadonlySet<number>> {
  return new Map([...state.requirements].map(([id, requirementState]) => [
    id,
    requirementState.citationIndexes,
  ]));
}

function reconcileAnswerCardCoverage(
  action: FinalAction,
  gaps: readonly { readonly requirementId: string }[],
  groundedRequirementIds: readonly string[],
  report: CoverageVerificationReport | undefined,
): FinalAction {
  const missing = new Set(gaps.map((gap) => gap.requirementId));
  const grounded = new Set(groundedRequirementIds);
  const summaryById = new Map(
    report?.summaries.map((summary) => [summary.id, summary] as const),
  );
  let changed = false;
  const requirements = action.requirements.map((requirement) => {
    if (missing.has(requirement.id)) {
      if (requirement.coverage !== "complete") return requirement;
      changed = true;
      return { ...requirement, coverage: "partial" as const };
    }
    if (
      requirement.coverage === "partial" &&
      grounded.has(requirement.id) &&
      summaryById.get(requirement.id)?.missingAspectCount === 0
    ) {
      changed = true;
      return { ...requirement, coverage: "complete" as const };
    }
    return requirement;
  });
  return changed ? { ...action, requirements } : action;
}

function coverageEvidence(
  draft: FinalAction,
  state: AgentState,
): CoverageEvidenceDocument[] {
  return draft.requirements.flatMap((requirement) =>
    requirementEvidenceCitations(requirement).flatMap((citation) => {
      const document = state.evidenceDocuments.get(requirement.id)?.get(citation);
      return document === undefined
        ? []
        : [{
            requirementId: requirement.id,
            citation,
            ...document,
          }];
    }));
}

function recordCoverage(
  input: KnowledgeAgentInput,
  state: AgentState,
  action: FinalAction,
  stage: "draft" | "verified",
  stopReason: "final" | "deadline",
  summaries?: readonly CoverageVerificationSummary[],
): void {
  const summaryById = new Map(
    summaries?.map((summary) => [summary.id, summary]),
  );
  recordDiagnostic(input.trace, {
    event: "coverage",
    stage,
    requirements: action.requirements.map((requirement) => {
      const planned = input.plan.requirements.find(
        (candidate) => candidate.id === requirement.id,
      );
      const summary = summaryById.get(requirement.id);
      const retrieval = coverageRetrievalDiagnostics(
        state.requirements.get(requirement.id),
      );
      return {
        id: requirement.id,
        evidenceMode: planned?.evidenceMode ?? "direct_only",
        coverage: requirement.coverage,
        citations: requirementEvidenceCitations(requirement),
        ...retrieval,
        ...(summary === undefined
          ? {}
          : {
              retainedDirectSegmentCount:
                summary.retainedDirectSegmentCount,
              retainedSynthesizedSegmentCount:
                summary.retainedSynthesizedSegmentCount,
              removedSegmentCount: summary.removedSegmentCount,
              ...(summary.coveredAspectCount === undefined
                ? {}
                : {
                    coveredAspectCount: summary.coveredAspectCount,
                  }),
              ...(summary.missingAspectCount === undefined
                ? {}
                : {
                    missingAspectCount: summary.missingAspectCount,
                  }),
            }),
      };
    }),
    ...(summaries === undefined
      ? {}
      : {
          reasons: summaries.map(({ id, reason }) => ({ id, reason })),
        }),
    citations: action.citations,
    stopReason,
  });
}

function buildEvidenceLedger(
  input: KnowledgeAgentInput,
  state: AgentState,
  action: FinalAction,
  report: CoverageVerificationReport,
): EvidenceLedger {
  const actionById = new Map(
    action.requirements.map((requirement) => [requirement.id, requirement] as const),
  );
  const verificationById = new Map(
    report.summaries.map((summary) => [summary.id, summary] as const),
  );
  const bindings = evidenceBindings(input);
  const bindingById = new Map(
    bindings.map((binding) => [binding.requirementId, binding] as const),
  );
  const units: EvidenceLedgerDraftUnit[] = input.plan.requirements.map(
    (requirement) => {
      const requirementState = state.requirements.get(requirement.id);
      const result = actionById.get(requirement.id);
      const verification = verificationById.get(requirement.id);
      const binding = bindingById.get(requirement.id);
      if (
        requirementState === undefined ||
        result === undefined ||
        verification === undefined ||
        binding === undefined
      ) {
        throw new Error("evidence_ledger_binding_missing");
      }

      const missingAspectIds = new Set(verification.missingAspectIds);
      const candidates: EvidenceCandidateDraft[] = sortedCandidates(
        requirementState,
      ).map((candidate) => {
        const overlapsMissingAspect = [...candidate.aspectIds].some((id) =>
          missingAspectIds.has(id));
        const relevantToMissingEvidence = missingAspectIds.size === 0
          ? candidate.requirementSpecificMatch
          : overlapsMissingAspect || candidate.aspectIds.size === 0;
        return {
          path: candidate.path,
          title: candidate.title,
          sources: [...candidate.ledgerSources],
          aspectIds: [...candidate.aspectIds],
          reviewRequired:
            result.coverage !== "complete" &&
            relevantToMissingEvidence &&
            !shouldDeferAdjacentComparisonRead(
              requirementState,
              candidate.path,
              false,
            ),
        };
      });
      const knownCandidatePaths = new Set(
        candidates.map((candidate) => candidate.path),
      );
      const sharedOnlyPaths = [...requirementState.readPaths]
        .filter((path) => !knownCandidatePaths.has(path))
        .sort((left, right) => left.localeCompare(right));
      for (const path of sharedOnlyPaths) {
        const sourceCandidate = [...state.requirements.values()]
          .map((sourceState) => sourceState.candidatePaths.get(path))
          .find((candidate) => candidate !== undefined);
        const document = [...(
          state.evidenceDocuments.get(requirement.id)?.values() ?? []
        )].find((candidate) => candidate.path === path);
        if (sourceCandidate === undefined || document === undefined) {
          throw new Error("shared_evidence_provenance_missing");
        }
        candidates.push({
          path,
          title: document.title,
          sources: [...sourceCandidate.ledgerSources],
          aspectIds: document.aspectIds ?? [],
          reviewRequired: false,
        });
        knownCandidatePaths.add(path);
      }
      const reads = materializeEvidenceReads(
        state,
        requirementState,
        candidates.map((candidate) => candidate.path),
      );
      const successfulReadPaths = new Set(
        reads.flatMap((read) => read.status === "success" ? [read.path] : []),
      );
      const hasUnreadReviewCandidate = candidates.some((candidate) =>
        candidate.reviewRequired && !successfulReadPaths.has(candidate.path));
      const claims = evidenceClaims(result, verification);
      const conditions = state.evidenceConditions.get(requirement.id) ?? {
        requirementId: requirement.id,
        conflictDetected: false,
        freshness: "not_assessed" as const,
        inputState: "not_applicable" as const,
        ambiguous: false,
      };

      return {
        binding,
        subject: input.plan.subject,
        requirement,
        queries: requirementState.queryRecords,
        candidates,
        reads,
        graphs: requirementState.graphRecords,
        claims,
        retrieval: {
          deadlineReached: deadlineReached(input),
          searchBudgetExhausted:
            requirementState.searchBudgetExhausted ||
            (
              result.coverage !== "complete" &&
              requirementState.supplementalSearches >=
                MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT
            ),
          readBudgetExhausted:
            requirementState.evidenceReviewExhausted ||
            (
              result.coverage !== "complete" &&
              hasUnreadReviewCandidate &&
              !hasRemainingReadCapacity(requirementState)
            ),
          toolUnavailableCount: requirementState.toolUnavailableCount,
          accessDeniedCount: requirementState.accessDeniedCount,
        },
        sourceBoundary: evidenceSourceBoundary(reads),
        conflictDetected: conditions.conflictDetected,
        freshness: conditions.freshness,
        inputState: conditions.inputState,
        ambiguous: conditions.ambiguous,
        verification: {
          coverage: result.coverage,
          reason: verification.reason,
          coveredAspectIds: verification.coveredAspectIds,
          missingAspectIds: verification.missingAspectIds,
        },
      };
    },
  );
  return finalizeEvidenceLedger({
    project: input.session.project,
    revision: input.session.revision,
    units,
  });
}

function requirementEvidenceConditions(
  input: KnowledgeAgentInput,
): ReadonlyMap<string, RequirementEvidenceCondition> {
  const knownRequirementIds = new Set(
    input.plan.requirements.map((requirement) => requirement.id),
  );
  const conditions = new Map<string, RequirementEvidenceCondition>();
  for (const condition of input.requirementEvidenceConditions ?? []) {
    if (
      !knownRequirementIds.has(condition.requirementId) ||
      conditions.has(condition.requirementId) ||
      typeof condition.conflictDetected !== "boolean" ||
      !["not_assessed", "current", "stale_or_unconfirmed"].includes(
        condition.freshness,
      ) ||
      !["not_applicable", "available", "missing"].includes(
        condition.inputState,
      ) ||
      typeof condition.ambiguous !== "boolean"
    ) {
      throw new Error("requirement_evidence_condition_invalid");
    }
    conditions.set(condition.requirementId, { ...condition });
  }
  return conditions;
}

function evidenceBindings(
  input: KnowledgeAgentInput,
): readonly DomainRequirementBinding[] {
  const bindings = input.requirementBindings ?? input.plan.requirements.map(
    (requirement, index) => ({
      domain: input.session.project,
      requirementId: requirement.id,
      deliverableId: `D${index + 1}`,
      obligationId: `O${index + 1}`,
      order: index,
    }),
  );
  if (
    bindings.length !== input.plan.requirements.length ||
    bindings.some((binding, index) =>
      binding.requirementId !== input.plan.requirements[index]?.id ||
      binding.domain !== input.session.project)
  ) {
    throw new Error("evidence_binding_mismatch");
  }
  return bindings;
}

function materializeEvidenceReads(
  state: AgentState,
  requirementState: RequirementState,
  candidatePaths: readonly string[],
): EvidenceReadDraft[] {
  const reads = [...requirementState.readRecords];
  const successfulReadPaths = new Set(
    reads.flatMap((read) => read.status === "success" ? [read.path] : []),
  );
  const documents = state.evidenceDocuments.get(
    requirementState.requirement.id,
  );
  for (const path of requirementState.readPaths) {
    if (successfulReadPaths.has(path)) continue;
    const citation = [...(documents?.entries() ?? [])].find(
      ([, document]) => document.path === path,
    )?.[0];
    if (citation !== undefined) {
      const provenance = state.readProvenanceByCitation.get(citation);
      if (provenance === undefined || provenance.path !== path) {
        throw new Error("shared_read_provenance_missing");
      }
      reads.push({
        path,
        status: "success",
        citation,
        pageType: provenance.pageType,
        sources: [...provenance.sources],
      });
      successfulReadPaths.add(path);
    }
  }
  return candidatePaths.flatMap((path) => {
    return reads.filter((read) => read.path === path);
  });
}

function evidenceClaims(
  _requirement: FinalAction["requirements"][number],
  verification: CoverageVerificationReport["summaries"][number],
): EvidenceClaimRecord[] {
  if (verification.claimDecisions === undefined) {
    throw new Error("coverage_claim_decisions_missing");
  }
  return verification.claimDecisions.map((decision) => ({
    claimIndex: decision.claimIndex,
    status: decision.status,
    citations: [...decision.citations],
    coveredAspectIds: [...decision.coveredAspectIds],
  }));
}

function evidenceSourceBoundary(
  reads: readonly EvidenceReadDraft[],
): EvidenceSourceBoundary {
  const successful = reads.filter((read) => read.status === "success");
  if (successful.length === 0) return "formal";
  const pageTypes = successful.map((read) => read.pageType?.toLowerCase());
  if (
    pageTypes.every((pageType) => pageType !== undefined && [
      "summary",
      "overview",
      "entity",
      "index",
      "navigation",
    ].includes(pageType))
  ) {
    return "summary_only";
  }
  if (
    pageTypes.every((pageType) =>
      pageType === "external" || pageType === "external_reference") &&
    successful.every((read) =>
      (read.sources?.length ?? 0) > 0 &&
      read.sources?.every((source) => /^https?:\/\//iu.test(source)))
  ) {
    return "external_only";
  }
  return "formal";
}

function recordCoverageGapDiagnostics(
  input: KnowledgeAgentInput,
  ledger: EvidenceLedger,
  gaps: readonly CoverageGap[],
): void {
  recordDiagnostic(input.trace, {
    event: "coverage_gaps",
    domainCount: new Set(ledger.units.map((unit) => unit.binding.domain)).size,
    gapCount: gaps.length,
    gaps: gaps.map((gap) => ({
      domain: gap.domain,
      gapClass: gap.gapClass,
      reason: gap.reason,
      affectsConclusion: gap.affectsConclusion,
    })),
  });
}

function coverageRetrievalDiagnostics(
  requirementState: RequirementState | undefined,
): {
  readonly candidateCount: number;
  readonly readCandidateCount: number;
  readonly unreadCandidateCount: number;
  readonly remainingReads: number;
  readonly seedSearchStatus: "success" | "empty" | "unavailable";
} {
  if (requirementState === undefined) {
    return {
      candidateCount: 0,
      readCandidateCount: 0,
      unreadCandidateCount: 0,
      remainingReads: 0,
      seedSearchStatus: "unavailable",
    };
  }
  const candidatePaths = [...requirementState.candidatePaths.keys()];
  const readCandidateCount = candidatePaths.filter((path) =>
    requirementState.readPaths.has(path)).length;
  return {
    candidateCount: candidatePaths.length,
    readCandidateCount,
    unreadCandidateCount: candidatePaths.length - readCandidateCount,
    remainingReads: Math.max(
      0,
      readLimitFor(requirementState.requirement) -
        requirementState.directReadPaths.size,
    ),
    seedSearchStatus: requirementState.seedCandidatePaths.size > 0
      ? "success"
      : requirementState.successfulSeedSearches > 0
        ? "empty"
        : "unavailable",
  };
}

function normalizeFinalCitationMetadata(
  action: FinalAction,
  plan: KnowledgePlan,
): FinalAction {
  const requirements = action.requirements.map((requirement, index) => ({
    ...requirement,
    ...(requirement.coverage === "none"
      ? {
          answer: notCoveredRequirementAnswer(
            plan.requirements[index]?.question ?? "",
          ),
          citations: [],
        }
      : {
          citations: stableUniqueNumbers(
            [...requirement.answer.matchAll(/\[(\d+)\]/gu)]
              .map((match) => Number(match[1])),
          ),
        }),
    ...(requirement.relatedContext === undefined
      ? {}
      : {
          relatedContext: requirement.relatedContext.map((related) => ({
            ...related,
            citations: stableUniqueNumbers(
              [...related.statement.matchAll(/\[(\d+)\]/gu)]
                .map((match) => Number(match[1])),
            ),
          })),
        }),
  }));
  return {
    ...action,
    requirements,
    citations: stableUniqueNumbers(
      requirements.flatMap((requirement) => requirementEvidenceCitations(requirement)),
    ),
  };
}

function dropUnsupportedRelatedContext(
  action: FinalAction,
  state: AgentState,
): FinalAction {
  const requirements = action.requirements.map((requirement) => {
    if (requirement.relatedContext === undefined) return requirement;
    const evidence = state.requirements.get(requirement.id)?.citationIndexes ??
      new Set<number>();
    const relatedContext = requirement.relatedContext.filter((related) =>
      related.citations.every((citation) => evidence.has(citation)));
    const { relatedContext: _relatedContext, ...rest } = requirement;
    return relatedContext.length === 0
      ? rest
      : { ...rest, relatedContext };
  });
  return {
    ...action,
    requirements,
    citations: stableUniqueNumbers(
      requirements.flatMap((requirement) =>
        requirementEvidenceCitations(requirement)),
    ),
  };
}

function dropUnsupportedRequirementCitationSegments(
  action: FinalAction,
  plan: KnowledgePlan,
  state: AgentState,
): FinalAction {
  const questionById = new Map(
    plan.requirements.map((requirement) => [requirement.id, requirement.question] as const),
  );
  const globallyReadCitations = new Set(
    [...state.requirements.values()].flatMap((requirementState) =>
      [...requirementState.citationIndexes]),
  );
  const requirements = action.requirements.map((requirement) => {
    if (requirement.coverage === "none") return requirement;
    const allowedCitations = state.requirements.get(requirement.id)?.citationIndexes ??
      new Set<number>();
    const pieces = normalizeTrailingCitationPlacement(requirement.answer)
      .split(/\r?\n+/u)
      .flatMap(splitAnswerLineSegments)
      .map((piece) => piece.trim())
      .filter(Boolean);
    const retainedSegments: string[] = [];
    const pendingHeadings: string[] = [];
    let removedSegment = false;

    for (const piece of pieces) {
      if (isPureStructuralAnswerHeading(piece)) {
        pendingHeadings.push(piece);
        continue;
      }
      const materialized = pendingHeadings.length === 0
        ? piece
        : `${pendingHeadings.join("\n")}\n${piece}`;
      pendingHeadings.length = 0;
      const citations = stableUniqueNumbers(
        [...materialized.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      );
      const unsupportedCitations = citations.filter(
        (citation) => !allowedCitations.has(citation),
      );
      if (
        unsupportedCitations.length > 0 &&
        unsupportedCitations.every((citation) => globallyReadCitations.has(citation))
      ) {
        removedSegment = true;
        continue;
      }
      retainedSegments.push(materialized);
    }

    if (!removedSegment) return requirement;
    if (retainedSegments.length === 0) {
      return {
        ...requirement,
        coverage: "none" as const,
        answer: notCoveredRequirementAnswer(
          questionById.get(requirement.id) ?? "当前问题",
        ),
        citations: [],
      };
    }
    const answer = retainedSegments.join("\n");
    return {
      ...requirement,
      coverage: requirement.coverage === "complete" ? "partial" as const : requirement.coverage,
      answer,
      citations: stableUniqueNumbers(
        [...answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      ),
    };
  });

  return {
    ...action,
    requirements,
    citations: stableUniqueNumbers(
      requirements.flatMap((requirement) => requirementEvidenceCitations(requirement)),
    ),
  };
}

function isPureStructuralAnswerHeading(text: string): boolean {
  return /^(?:#{1,6}\s+\S[^\n]*|\*\*[^*\n]+\*\*[:：]?)$/u.test(text) &&
    !/\[\d+\]/u.test(text);
}

function enforceMissingInputConditions(
  action: FinalAction,
  plan: KnowledgePlan,
  conditions: ReadonlyMap<string, RequirementEvidenceCondition>,
): FinalAction {
  const questionById = new Map(
    plan.requirements.map((requirement) => [requirement.id, requirement.question] as const),
  );
  const requirements = action.requirements.map((requirement) => {
    if (conditions.get(requirement.id)?.inputState !== "missing") {
      return requirement;
    }
    const question = questionById.get(requirement.id) ?? "当前个案结论";
    return {
      id: requirement.id,
      coverage: "none" as const,
      answer: `缺少判断“${question}”所需的当次客户输入，暂不形成当前个案结论。`,
      citations: [],
    };
  });
  return {
    action: "final",
    requirements,
    citations: stableUniqueNumbers(requirements.flatMap((requirement) => [
      ...requirement.citations,
      ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
    ])),
  };
}

function requirementEvidenceCitations(
  requirement: FinalAction["requirements"][number],
): number[] {
  return stableUniqueNumbers([
    ...requirement.citations,
    ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
  ]);
}

function stableUniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function pendingEvidenceReviews(
  action: FinalAction,
  state: AgentState,
): string[] {
  const pending: string[] = [];
  for (const result of action.requirements) {
    const requirementState = state.requirements.get(result.id);
    if (
      !requirementState ||
      !hasRemainingReadCapacity(requirementState)
    ) {
      continue;
    }
    const hasUnreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) =>
        !requirementState.readPaths.has(path) &&
        !hasUnresolvedReadFailure(requirementState, path) &&
        !shouldDeferAdjacentComparisonRead(requirementState, path, false)
      );
    const hasUnreadAspectCandidate = [...requirementState.candidatePaths.values()]
      .some((candidate) =>
        !requirementState.readPaths.has(candidate.path) &&
        !hasUnresolvedReadFailure(requirementState, candidate.path) &&
        !shouldDeferAdjacentComparisonRead(
          requirementState,
          candidate.path,
          false,
        ) &&
        [...candidate.aspectIds].some(
          (aspectId) => !requirementState.readAspectIds.has(aspectId),
        ));
    if (
      hasUnreadCandidate &&
      (result.coverage !== "complete" || hasUnreadAspectCandidate)
    ) {
      pending.push(result.id);
    }
  }
  return pending;
}

function directReadCount(
  state: AgentState,
  requirementIds: readonly string[],
): number {
  return requirementIds.reduce(
    (count, requirementId) =>
      count +
      (state.requirements.get(requirementId)?.directReadPaths.size ?? 0),
    0,
  );
}

function closeEvidenceReviewAtRetrievalBoundary(
  action: FinalAction,
  requirementIds: readonly string[],
  state: AgentState,
): FinalAction {
  const pending = new Set(requirementIds);
  const requirements = action.requirements.map((requirement) => {
    if (!pending.has(requirement.id)) return requirement;
    const requirementState = state.requirements.get(requirement.id);
    if (requirementState !== undefined) {
      requirementState.evidenceReviewExhausted = true;
    }
    return requirement.coverage === "complete"
      ? { ...requirement, coverage: "partial" as const }
      : requirement;
  });
  observe(state, {
    type: "coverage_gate_closed_at_retrieval_boundary",
    requirements: [...requirementIds],
  });
  return {
    action: "final",
    requirements,
    citations: stableUniqueNumbers(requirements.flatMap((requirement) => [
      ...requirement.citations,
      ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
    ])),
  };
}

function isDirectComparisonRequirement(
  requirement: KnowledgeRequirement,
): boolean {
  return requirement.evidenceMode === "direct_only" &&
    isDirectComparisonQuestion(requirement.question);
}

function isExactDirectComparisonCandidate(
  requirementState: RequirementState,
  path: string,
): boolean {
  const candidate = requirementState.candidatePaths.get(path);
  return candidate !== undefined &&
    directQuestionTitleCoverageScore(
      candidate.title,
      requirementState.requirement,
    ) > 0;
}

function preferredUnreadDirectComparisonPath(
  requirementState: RequirementState,
): string | undefined {
  if (!isDirectComparisonRequirement(requirementState.requirement)) {
    return undefined;
  }
  return [...requirementState.candidatePaths.values()]
    .filter((candidate) =>
      !requirementState.readPaths.has(candidate.path) &&
      !hasUnresolvedReadFailure(requirementState, candidate.path) &&
      isExactDirectComparisonCandidate(requirementState, candidate.path)
    )
    .sort((left, right) =>
      directQuestionTitleCoverageScore(
        right.title,
        requirementState.requirement,
      ) -
        directQuestionTitleCoverageScore(
          left.title,
          requirementState.requirement,
        ) ||
      normalizeTitleText(left.title).length -
        normalizeTitleText(right.title).length ||
      right.rrfScore - left.rrfScore ||
      left.path.localeCompare(right.path)
    )[0]?.path;
}

function hasRemainingReadCapacity(
  requirementState: RequirementState,
): boolean {
  return requirementState.directReadPaths.size <
      readLimitFor(requirementState.requirement) ||
    preferredUnreadDirectComparisonPath(requirementState) !== undefined;
}

function canReadEvidencePath(
  requirementState: RequirementState,
  path: string,
  pendingReads = 0,
): boolean {
  if (
    requirementState.directReadPaths.size + pendingReads <
      readLimitFor(requirementState.requirement)
  ) {
    return true;
  }
  return isExactDirectComparisonCandidate(requirementState, path) &&
    ![...requirementState.directReadPaths].some((readPath) =>
      isExactDirectComparisonCandidate(requirementState, readPath)
    );
}

function shouldDeferAdjacentComparisonRead(
  requirementState: RequirementState,
  path: string,
  exactCandidateRequested: boolean,
): boolean {
  if (
    !isDirectComparisonRequirement(requirementState.requirement) ||
    isExactDirectComparisonCandidate(requirementState, path)
  ) {
    return false;
  }
  return exactCandidateRequested ||
    [...requirementState.directReadPaths].some((readPath) =>
      isExactDirectComparisonCandidate(requirementState, readPath)
    );
}

function pendingDirectAnswerRepairs(
  action: FinalAction,
  state: AgentState,
): Array<{ requirementId: string; citationIndexes: number[] }> {
  return action.requirements.flatMap((result) => {
    const requirementState = state.requirements.get(result.id);
    if (
      requirementState === undefined ||
      result.coverage !== "none" ||
      !isDirectComparisonRequirement(requirementState.requirement)
    ) {
      return [];
    }
    const documents = state.evidenceDocuments.get(result.id) ?? new Map();
    const exactCitations = [...documents.entries()]
      .filter(([, document]) =>
        directQuestionTitleCoverageScore(
          document.title,
          requirementState.requirement,
        ) > 0
      )
      .map(([citation]) => citation);
    return exactCitations.length === 0
      ? []
      : [{
          requirementId: result.id,
          citationIndexes: exactCitations,
        }];
  });
}

const AMBIGUOUS_COMPARISON_CLAIM_PATTERN =
  /^(?:(?:[-*•]|\d+[.)、])\s*)?(?:\*\*)?(?:(?:其|它(?:们)?|该(?:方案|产品|系统|架构|机制)|这种(?:方案|产品|系统|架构|机制)|前者|后者)(?:\*\*)?(?:[：:，,\s]|$)|(?:不支持|不具备|不提供|不允许|无法|仅支持|只支持|依赖|采用|切换粒度|资源利用率|存在(?:限制|风险)))/u;

function pendingComparisonSubjectRepairs(
  action: FinalAction,
  state: AgentState,
): string[] {
  return action.requirements.flatMap((result) => {
    const requirementState = state.requirements.get(result.id);
    if (
      requirementState === undefined ||
      result.coverage === "none" ||
      !isDirectComparisonRequirement(requirementState.requirement)
    ) {
      return [];
    }
    return hasAmbiguousComparisonClaim(result.answer) ||
        missingExplicitComparisonLabels(
          requirementState.requirement.question,
          result.answer,
        ).length > 0
      ? [result.id]
      : [];
  });
}

const STRUCTURED_COMPLETENESS_QUESTION_PATTERN =
  /(?:认证流程|处理流程|操作流程|关键步骤|完整步骤|关键配置|配置项|配置参数)/u;

function pendingDanglingCollectionRepairs(action: FinalAction): string[] {
  return action.requirements.flatMap((requirement) =>
    requirement.coverage !== "none" &&
      hasDanglingCollectionEnumeration(requirement.answer)
      ? [requirement.id]
      : []
  );
}

function pendingStructuredCoverageRepairs(
  draft: FinalAction,
  audited: FinalAction,
  plan: KnowledgePlan,
): string[] {
  const draftById = new Map(
    draft.requirements.map((requirement) => [requirement.id, requirement] as const),
  );
  return audited.requirements.flatMap((requirement, index) => {
    const planned = plan.requirements[index];
    const original = draftById.get(requirement.id);
    return planned?.evidenceMode === "direct_only" &&
        original?.coverage === "complete" &&
        requirement.coverage === "partial" &&
        STRUCTURED_COMPLETENESS_QUESTION_PATTERN.test(planned.question)
      ? [requirement.id]
      : [];
  });
}

function hasAmbiguousComparisonClaim(answer: string): boolean {
  let hasExplicitHeadingContext = false;
  for (const rawLine of normalizeTrailingCitationPlacement(answer).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      hasExplicitHeadingContext = false;
      continue;
    }
    const withoutMarker = line
      .replace(/^(?:#{1,6}\s+|[-*•]\s+|\d+[.)、]\s*)/u, "")
      .replace(/^\*\*|\*\*$/gu, "")
      .trim();
    if (
      !/\[\d+\]/u.test(line) &&
      /[：:]$/u.test(withoutMarker) &&
      withoutMarker.replace(/[：:]$/u, "").trim().length > 0
    ) {
      hasExplicitHeadingContext = true;
      continue;
    }
    const pieces = splitAnswerLineSegments(line);
    for (const piece of pieces) {
      if (
        !hasExplicitHeadingContext &&
        /\[\d+\]/u.test(piece) &&
        AMBIGUOUS_COMPARISON_CLAIM_PATTERN.test(piece.trim())
      ) {
        return true;
      }
    }
  }
  return false;
}

function sortedCandidates(requirementState: RequirementState): Candidate[] {
  return [...requirementState.candidatePaths.values()]
    .sort((left, right) => {
      const pathPriority =
        candidatePathPriority(left, requirementState.requirement) -
        candidatePathPriority(right, requirementState.requirement);
      const questionTitlePriority =
        directQuestionTitleCoverageScore(
          right.title,
          requirementState.requirement,
        ) -
        directQuestionTitleCoverageScore(
          left.title,
          requirementState.requirement,
        );
      const subjectTitlePriority =
        titleCoverageScoreForValues(right.title, [requirementState.subject]) -
        titleCoverageScoreForValues(left.title, [requirementState.subject]);
      const titlePriority =
        titleCoverageScore(
          right.title,
          requirementState.requirement,
          requirementState.queries,
        ) -
        titleCoverageScore(
          left.title,
          requirementState.requirement,
          requirementState.queries,
        );
      const relevancePriority = right.rrfScore - left.rrfScore;
      const aspectPriority =
        candidateAspectGain(right, requirementState) -
        candidateAspectGain(left, requirementState);
      return requirementState.requirement.evidenceMode === "direct_only"
        ? pathPriority ||
          questionTitlePriority ||
          subjectTitlePriority ||
          titlePriority ||
          relevancePriority ||
          aspectPriority ||
          left.path.localeCompare(right.path)
        : aspectPriority ||
          pathPriority ||
          titlePriority ||
          relevancePriority ||
          left.path.localeCompare(right.path);
    });
}

function candidatePathPriority(candidate: Candidate, requirement: KnowledgeRequirement): number {
  const path = candidate.path;
  if (
    path.startsWith("wiki/entities/") &&
    /核心(?:能力|功能)|有哪些(?:能力|功能)|功能清单|详细介绍.*功能|是什么/u
      .test(requirement.question)
  ) {
    return -1;
  }
  if (
    path.startsWith("wiki/queries/") &&
    directQuestionTitleCoverageScore(candidate.title, requirement) > 0
  ) {
    return 0;
  }
  const curatedPrefixes = [
    "wiki/concepts/",
    "wiki/synthesis/",
    "wiki/comparisons/",
    "wiki/comparison/",
    "wiki/findings/",
    "wiki/entities/",
  ];
  if (curatedPrefixes.some((prefix) => path.startsWith(prefix))) return 0;
  if (path.startsWith("wiki/sources/")) return 2;
  return 1;
}

const TITLE_TERM_STOPWORDS = new Set([
  "coremail",
  "邮件",
  "系统",
  "规划",
  "方案",
  "场景",
  "实现",
  "如何",
  "用户",
  "规模",
]);

function titleCoverageScore(
  title: string,
  requirement: KnowledgeRequirement,
  executedQueries: ReadonlySet<string>,
): number {
  return titleCoverageScoreForValues(title, [
    requirement.question,
    ...requirement.queries.map((query) => query.text),
    ...executedQueries,
  ]);
}

function directQuestionTitleCoverageScore(
  title: string,
  requirement: KnowledgeRequirement,
): number {
  return titleCoverageScoreForValues(
    title,
    [requirement.question],
    true,
  );
}

function titleCoverageScoreForValues(
  title: string,
  values: readonly string[],
  preserveProductTerms = false,
): number {
  const normalizedTitle = normalizeTitleText(title);
  const terms = new Set(
    values.flatMap((value) => titleTerms(value, preserveProductTerms)),
  );
  const matches = [...terms].filter((term) => normalizedTitle.includes(term));
  if (matches.length === 1 && matches[0] === normalizedTitle) {
    return Math.min(matches[0].length, 4);
  }
  if (matches.length < 2) return 0;
  return matches.reduce((score, term) => score + Math.min(term.length, 4), 0);
}

function titleTerms(value: string, preserveProductTerms = false): string[] {
  return (value.toLocaleLowerCase("zh-CN")
    .match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu) ?? [])
    .flatMap((part) => {
      if (!/^\p{Script=Han}+$/u.test(part) || part.length <= 4) return [part];
      return Array.from({ length: part.length - 1 }, (_, index) =>
        part.slice(index, index + 2));
    })
    .map(normalizeTitleText)
    .filter((term) =>
      term.length >= 2 &&
      (
        !TITLE_TERM_STOPWORDS.has(term) ||
        (preserveProductTerms && /[a-z0-9]/iu.test(term))
      )
    );
}

function normalizeTitleText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasAvailableToolAction(state: AgentState): boolean {
  return [...state.requirements.values()].some((requirementState) => {
    const unreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) =>
        !requirementState.readPaths.has(path) &&
        !hasUnresolvedReadFailure(requirementState, path));
    return (
      (!requirementState.searchStopped &&
        requirementState.supplementalSearches < MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT) ||
      (unreadCandidate &&
        hasRemainingReadCapacity(requirementState)) ||
      (requirementState.candidatePaths.size > 0 &&
        requirementState.graphActions < MAX_GRAPH_ACTIONS_PER_REQUIREMENT)
    );
  });
}

function countRemainingToolActions(state: AgentState): number {
  let remaining = 0;
  for (const requirementState of state.requirements.values()) {
    if (!requirementState.searchStopped) {
      remaining += MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT - requirementState.supplementalSearches;
    }
    const unreadCandidates = [...requirementState.candidatePaths.keys()]
      .filter((path) =>
        !requirementState.readPaths.has(path) &&
        !hasUnresolvedReadFailure(requirementState, path)).length;
    const standardReadCapacity = Math.max(
      0,
      readLimitFor(requirementState.requirement) -
        requirementState.directReadPaths.size,
    );
    const exactComparisonReserve =
        preferredUnreadDirectComparisonPath(requirementState) === undefined
      ? 0
      : 1;
    remaining += Math.min(
      unreadCandidates,
      standardReadCapacity + exactComparisonReserve,
    );
    if (
      requirementState.candidatePaths.size > 0 &&
      requirementState.graphActions < MAX_GRAPH_ACTIONS_PER_REQUIREMENT
    ) {
      remaining += 1;
    }
  }
  return remaining;
}

function stopSearchAfterNoGain(requirementState: RequirementState | undefined): void {
  if (!requirementState) return;
  requirementState.noGainRounds += 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
}

function actionFingerprint(action: ToolAction): string {
  if (action.tool === "kb.search") {
    return JSON.stringify([
      action.tool,
      action.input.requirementId,
      normalizeQuery(action.input.query),
      [...action.input.aspectIds].sort(),
      action.input.topK,
    ]);
  }
  return JSON.stringify([action.tool, action.input]);
}

function actionRequirementIds(action: ToolAction): string[] {
  return action.tool === "kb.read_pages"
    ? action.input.pages.map((page) => page.requirementId)
    : [action.input.requirementId];
}

function normalizeQuery(query: string): string {
  return query.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function expandSeedQueries(
  requirement: KnowledgeRequirement,
): Array<{
  text: string;
  aspectIds: string[];
  plannedQueryIndexes: number[];
}> {
  const expanded = new Map<string, {
    text: string;
    aspectIds: Set<string>;
    plannedQueryIndexes: Set<number>;
  }>();
  for (const [plannedQueryIndex, query] of requirement.queries.entries()) {
    const queryText = enrichSynthesisQuery(
      requirement,
      query.text,
      query.aspectIds,
    );
    addExpandedQuery(
      expanded,
      queryText,
      query.aspectIds,
      [plannedQueryIndex],
    );
    const variants = [
      queryText.replaceAll("注意事项", "要点"),
      queryText.replaceAll("关键注意", "重点"),
      queryText.replaceAll("操作步骤", "操作流程"),
    ];
    for (const variant of variants) {
      const normalized = normalizeQuery(variant);
      if (normalized !== normalizeQuery(queryText)) {
        addExpandedQuery(expanded, variant, query.aspectIds, []);
      }
    }
    if (
      /poc/iu.test(queryText) &&
      (
        queryText.includes("注意事项") ||
        queryText.includes("关键注意") ||
        queryText.includes("要点")
      )
    ) {
      addExpandedQuery(expanded, "POC测试要点", query.aspectIds, []);
    }
    if (
      queryText.includes("迁移") &&
      /(?:执行步骤|操作步骤|操作流程|流程|方法)/u.test(queryText)
    ) {
      const toolFocus = `${queryText
        .replace(/(?:执行步骤|操作步骤|操作流程|流程|方法)/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()} 工具`;
      addExpandedQuery(expanded, toolFocus, query.aspectIds, []);
    }
  }
  return [...expanded.values()].map((query) => ({
    text: query.text,
    aspectIds: [...query.aspectIds],
    plannedQueryIndexes: [...query.plannedQueryIndexes],
  }));
}

function enrichSynthesisQuery(
  requirement: KnowledgeRequirement,
  queryText: string,
  aspectIds: readonly string[],
): string {
  if (
    requirement.evidenceMode !== "synthesis_allowed" ||
    aspectIds.length <= 1
  ) {
    return queryText;
  }
  const normalizedQuery = normalizeTitleText(queryText);
  const additions = aspectIds.flatMap((aspectId) => {
    const aspect = requirement.evidenceAspects.find(
      (candidate) => candidate.id === aspectId,
    );
    if (aspect === undefined) return [];
    const term = aspect.terms.find((candidate) => {
      const normalizedTerm = normalizeTitleText(candidate);
      return normalizedTerm.length >= 2 &&
        !normalizedQuery.includes(normalizedTerm);
    });
    return term === undefined ? [] : [term];
  });
  return additions.length === 0
    ? queryText
    : `${queryText} ${[...new Set(additions)].join(" ")}`;
}

function addExpandedQuery(
  expanded: Map<string, {
    text: string;
    aspectIds: Set<string>;
    plannedQueryIndexes: Set<number>;
  }>,
  text: string,
  aspectIds: readonly string[],
  plannedQueryIndexes: readonly number[],
): void {
  const normalized = normalizeQuery(text);
  const entry = expanded.get(normalized) ?? {
    text,
    aspectIds: new Set<string>(),
    plannedQueryIndexes: new Set<number>(),
  };
  for (const aspectId of aspectIds) entry.aspectIds.add(aspectId);
  for (const plannedQueryIndex of plannedQueryIndexes) {
    entry.plannedQueryIndexes.add(plannedQueryIndex);
  }
  expanded.set(normalized, entry);
}

function matchingAspectIds(
  requirement: KnowledgeRequirement,
  value: string,
): string[] {
  const normalized = normalizeTitleText(value);
  return requirement.evidenceAspects
    .filter((aspect) =>
      [aspect.label, ...aspect.terms].some((term) => {
        const normalizedTerm = normalizeTitleText(term);
        return normalizedTerm.length >= 2 && normalized.includes(normalizedTerm);
      }))
    .map((aspect) => aspect.id);
}

function seedTopKFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? Math.min(
        SYNTHESIS_SEED_TOP_K_LIMIT,
        Math.max(SEED_TOP_K, requirement.evidenceAspects.length * 3),
      )
    : SEED_TOP_K;
}

function limitSearchResult(
  result: KnowledgeSearchResult,
  topK: number,
): KnowledgeSearchResult {
  return result.hits.length <= topK
    ? result
    : { ...result, hits: result.hits.slice(0, topK) };
}

function attributedSearchAspectIds(
  requirement: KnowledgeRequirement,
  queryAspectIds: readonly string[],
  hitMetadata: string,
): string[] {
  const matched = matchingAspectIds(requirement, hitMetadata);
  return queryAspectIds.length <= 1
    ? [...new Set([...queryAspectIds, ...matched])]
    : matched;
}

function hasOnlyKnownAspectIds(
  requirement: KnowledgeRequirement,
  aspectIds: readonly string[],
): boolean {
  const known = new Set(
    requirement.evidenceAspects.map((aspect) => aspect.id),
  );
  return aspectIds.every((aspectId) => known.has(aspectId));
}

function candidateAspectGain(
  candidate: Candidate,
  requirementState: RequirementState,
): number {
  return [...candidate.aspectIds].filter(
    (aspectId) => !requirementState.readAspectIds.has(aspectId),
  ).length;
}

function aspectStatuses(
  requirementState: RequirementState,
): Array<{
  id: string;
  label: string;
  candidateCount: number;
  readCandidateCount: number;
}> {
  return requirementState.requirement.evidenceAspects.map((aspect) => ({
    id: aspect.id,
    label: aspect.label,
    candidateCount: [...requirementState.candidatePaths.values()]
      .filter((candidate) => candidate.aspectIds.has(aspect.id)).length,
    readCandidateCount: [...requirementState.candidatePaths.values()]
      .filter((candidate) =>
        candidate.aspectIds.has(aspect.id) &&
        requirementState.readPaths.has(candidate.path))
      .length,
  }));
}

function deadlineReached(input: KnowledgeAgentInput): boolean {
  return input.deadlineAt !== undefined && Date.now() >= input.deadlineAt;
}

const activeSignalByInput = new WeakMap<KnowledgeAgentInput, AbortSignal | null>();

function toolSignal(input: KnowledgeAgentInput): AbortSignal | undefined {
  if (activeSignalByInput.has(input)) {
    return activeSignalByInput.get(input) ?? undefined;
  }
  const signal = input.deadlineAt === undefined
    ? input.signal
    : input.signal === undefined
      ? AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now()))
      : AbortSignal.any([
          input.signal,
          AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now())),
        ]);
  activeSignalByInput.set(input, signal ?? null);
  return signal;
}

function observe(state: AgentState, value: unknown): void {
  const serialized = JSON.stringify(value);
  state.observations.push(serialized.length <= 10_000 ? serialized : serialized.slice(0, 10_000));
  if (state.observations.length > 30) state.observations.shift();
}

function roundedScore(score: number): number {
  return Number(score.toFixed(6));
}

function markdownHeadings(content: string): string[] {
  return [...content.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .slice(0, 4);
}

function assertNever(value: never): never {
  throw new Error(`unhandled_tool_action:${String(value)}`);
}

function isAccessDeniedError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const response = record.response;
  const responseStatus = response !== null && typeof response === "object"
    ? (response as Record<string, unknown>).status
    : undefined;
  return [record.code, record.status, record.statusCode, responseStatus]
    .some((value) =>
      value === 401 || value === 403 ||
      value === "401" || value === "403" || value === "EACCES");
}
