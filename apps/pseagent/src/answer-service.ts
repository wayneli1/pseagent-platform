import type {
  AnswerResult,
  Coverage,
  HistoricalRejectionReason,
  Scope,
} from "./contracts.js";
import { normalAnswerMessages } from "./prompts.js";
import type { ScopeRouter } from "./router.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgePlan } from "./contracts.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import {
  NOOP_DIAGNOSTIC_TRACE,
  recordDiagnostic,
  type DiagnosticEvent,
  type DiagnosticTrace,
  type DiagnosticTraceFactory,
  type HistoricalGateReason,
  type PseStopReason,
} from "./diagnostics.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";
import type {
  TaskAnalysisShadow,
  TaskAnalysisShadowResult,
} from "./task-analysis-shadow.js";
import { adaptTaskSpecToKnowledgePlan } from "./task-plan-adapter.js";
import type { KnowledgeAgentDetailedResult } from "./agent-loop.js";
import {
  deriveDomainKnowledgePlans,
  type DomainKnowledgePlan,
  type DomainPlanInactiveReason,
  type DomainRequirementBinding,
} from "./domain-plan.js";
import {
  DomainAnswerMergeError,
  mergeDetailedDomainResults,
  type DetailedDomainResult,
  type MergedDomainAnswer,
} from "./domain-answer-merge.js";
import { formatKnowledgeFinal } from "./response.js";
import type { KnowledgeDomain } from "./task-spec.js";
import type {
  EvidenceLedger,
  RequirementEvidenceCondition,
} from "./evidence-ledger.js";
import type { CoverageGap } from "./coverage-gap.js";
import type { CoverageVerificationReport } from "./coverage-verifier.js";

export const PSE_REQUEST_TIMEOUT_MS = 300_000;
export const PSE_ACTIVE_DEADLINE_MS = 270_000;

export interface KnowledgeSessionFactory {
  open(scope: Exclude<Scope, "normal">, signal?: AbortSignal): Promise<KnowledgeSession>;
}
export interface AgentRunnerInput {
  readonly scope: Exclude<Scope, "normal">;
  readonly question: string;
  readonly conversationContext?: string;
  readonly plan: KnowledgePlan;
  readonly requirementBindings?: readonly DomainRequirementBinding[];
  readonly requirementEvidenceConditions?: readonly RequirementEvidenceCondition[];
  readonly model: ModelClient;
  readonly session: KnowledgeSession;
  readonly deadlineAt: number;
  readonly trace: DiagnosticTrace;
  readonly signal?: AbortSignal;
}

export type AgentRunner = (input: AgentRunnerInput) => Promise<AnswerResult>;
export type DetailedAgentRunner = (
  input: AgentRunnerInput,
) => Promise<KnowledgeAgentDetailedResult>;

export interface PseAnswerExecution {
  readonly result: AnswerResult;
  readonly retryable: boolean;
  readonly stopReason: PseStopReason | "final" | "unknown_unavailable";
  readonly historicalAttempted: boolean;
  readonly historicalUsed: boolean;
  readonly draftCoverage?: readonly Coverage[];
  readonly verifiedCoverage?: readonly Coverage[];
  readonly retainedDirectSegmentCount?: number;
  readonly retainedSynthesizedSegmentCount?: number;
  readonly removedSegmentCount?: number;
  readonly historicalGateReason?: HistoricalGateReason;
  readonly historicalNoticeShown?: boolean;
  readonly historicalRejectedReason?: HistoricalRejectionReason;
  /** Internal execution metadata; never copied into the strict external AnswerResult. */
  readonly domainsUsed?: readonly KnowledgeDomain[];
  readonly verification?: CoverageVerificationReport;
  readonly domainEvidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
}

interface ExecutionEvidenceMetadata {
  readonly verification?: CoverageVerificationReport;
  readonly domainEvidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
}

export class AnswerService {
  constructor(private readonly dependencies: {
    readonly model: ModelClient;
    readonly router: Pick<ScopeRouter, "route">;
    readonly planner: KnowledgePlanner;
    readonly diagnostics?: DiagnosticTraceFactory;
    readonly knowledge: KnowledgeSessionFactory;
    readonly runAgent: AgentRunner;
    readonly runAgentDetailed?: DetailedAgentRunner;
    readonly historicalProvider?: HistoricalAnswerProvider;
    readonly requestTimeoutMs?: number;
    readonly activeDeadlineMs?: number;
    readonly taskAnalysisShadow?: TaskAnalysisShadow;
    readonly taskSpecShadowTimeoutMs?: number;
    readonly taskSpecActiveEnabled?: boolean;
    readonly multiDomainActiveEnabled?: boolean;
  }) {}

  async answer(
    question: string,
    conversationContext?: string,
    signal?: AbortSignal,
  ): Promise<AnswerResult> {
    return (await this.answerDetailed(question, conversationContext, signal)).result;
  }

  async answerDetailed(
    question: string,
    conversationContext?: string,
    signal?: AbortSignal,
  ): Promise<PseAnswerExecution> {
    const startedAt = Date.now();
    const deadlineAt =
      startedAt +
      (this.dependencies.activeDeadlineMs ?? PSE_ACTIVE_DEADLINE_MS);
    const timeoutSignal = AbortSignal.timeout(
      this.dependencies.requestTimeoutMs ?? PSE_REQUEST_TIMEOUT_MS,
    );
    const requestSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
    const trace = new OutcomeTrace(
      startDiagnosticTrace(this.dependencies.diagnostics),
    );
    let scope: Scope | undefined;
    try {
      scope = await this.dependencies.router.route(question, conversationContext, requestSignal);
      recordDiagnostic(trace, { event: "route", scope });
      if (scope === "normal") {
        const answer = await this.dependencies.model.completeText({
          messages: normalAnswerMessages(question, conversationContext),
          signal: requestSignal,
        });
        const result: AnswerResult = { scope, status: "answered", answer, references: [] };
        return finishExecution(trace, result, startedAt, false, false);
      }
      const session = await this.dependencies.knowledge.open(scope, requestSignal);
      const plan = await this.dependencies.planner.plan({
        scope,
        question,
        purpose: session.purpose,
        schema: session.schema,
        planningOverview: session.planningOverview,
        ...(conversationContext === undefined ? {} : { conversationContext }),
        signal: requestSignal,
      });
      recordDiagnostic(trace, {
        event: "plan",
        requirementCount: plan.requirements.length,
        aspectCount: plan.requirements.reduce(
          (count, requirement) => count + requirement.evidenceAspects.length,
          0,
        ),
        queryCount: plan.requirements.reduce(
          (count, requirement) => count + requirement.queries.length,
          0,
        ),
        directOnlyCount: plan.requirements.filter(
          (requirement) => requirement.evidenceMode === "direct_only",
        ).length,
        synthesisAllowedCount: plan.requirements.filter(
          (requirement) => requirement.evidenceMode === "synthesis_allowed",
        ).length,
      });
      const taskAnalysis = await observeTaskAnalysisShadow({
        ...(this.dependencies.taskAnalysisShadow === undefined
          ? {}
          : { analyzer: this.dependencies.taskAnalysisShadow }),
        question,
        ...(conversationContext === undefined ? {} : { conversationContext }),
        scope,
        legacyPlan: plan,
        knowledgeContext: {
          purpose: session.purpose,
          schema: session.schema,
          planningOverview: session.planningOverview,
        },
        trace,
        signal: requestSignal,
        timeoutMs: this.dependencies.taskSpecShadowTimeoutMs ?? 15_000,
      });
      let effectiveQuestion = question;
      let effectivePlan = plan;
      let effectiveConversationContext = conversationContext;
      let effectiveEvidenceConditions: readonly RequirementEvidenceCondition[] | undefined;
      if (taskAnalysis !== undefined) {
        if (this.dependencies.taskSpecActiveEnabled === true) {
          if (this.dependencies.multiDomainActiveEnabled === true) {
            const derived = deriveDomainKnowledgePlans({
              resolvedQuestion: taskAnalysis.resolvedQuestion,
              taskSpec: taskAnalysis.taskSpec,
              guardResult: taskAnalysis.guard,
            });
            if (derived.activated) {
              const requirementCount = derived.plans.reduce(
                (count, domainPlan) => count + domainPlan.plan.requirements.length,
                0,
              );
              recordDiagnostic(trace, {
                event: "task_spec_activation",
                activated: true,
                reason: "activated",
                requirementCount,
              });
              return await this.answerAcrossDomains({
                scope,
                question: taskAnalysis.resolvedQuestion.standaloneQuestion,
                plans: derived.plans,
                requestSignal,
                deadlineAt,
                trace,
                startedAt,
              });
            }
            recordDiagnostic(trace, {
              event: "task_spec_activation",
              activated: false,
              reason: derived.reason,
              requirementCount: 0,
            });
            if (domainPlanFailureMustFailClosed(derived.reason)) {
              recordDiagnostic(trace, { event: "stop", reason: "domain_plan_invalid" });
              return finishExecution(
                trace,
                temporaryUnavailableResult(scope),
                startedAt,
                false,
                false,
              );
            }
          } else {
            const adapted = adaptTaskSpecToKnowledgePlan({
              scope,
              resolvedQuestion: taskAnalysis.resolvedQuestion,
              taskSpec: taskAnalysis.taskSpec,
              guardResult: taskAnalysis.guard,
            });
            if (adapted.activated) {
              effectiveQuestion = taskAnalysis.resolvedQuestion.standaloneQuestion;
              effectivePlan = adapted.plan;
              effectiveConversationContext = undefined;
              effectiveEvidenceConditions = adapted.conditions;
              recordDiagnostic(trace, {
                event: "task_spec_activation",
                activated: true,
                reason: "activated",
                requirementCount: adapted.plan.requirements.length,
              });
            } else {
              recordDiagnostic(trace, {
                event: "task_spec_activation",
                activated: false,
                reason: adapted.reason,
                requirementCount: 0,
              });
            }
          }
        } else {
          recordDiagnostic(trace, {
            event: "task_spec_activation",
            activated: false,
            reason: "disabled",
            requirementCount: 0,
          });
        }
      } else if (this.dependencies.taskSpecActiveEnabled === true) {
        recordDiagnostic(trace, {
          event: "task_spec_activation",
          activated: false,
          reason: "analysis_unavailable",
          requirementCount: 0,
        });
      }
      const input = {
        scope,
        question: effectiveQuestion,
        plan: effectivePlan,
        ...(effectiveEvidenceConditions === undefined
          ? {}
          : { requirementEvidenceConditions: effectiveEvidenceConditions }),
        model: this.dependencies.model,
        session,
        deadlineAt,
        trace,
        ...(effectiveConversationContext === undefined
          ? {}
          : { conversationContext: effectiveConversationContext }),
        signal: requestSignal,
      };
      const primary = await this.dependencies.runAgent(input);
      return await this.finishPrimary({
        primary,
        question: effectiveQuestion,
        requestSignal,
        trace,
        startedAt,
      });
    } catch (error) {
      if (error instanceof InvalidModelPayloadError) {
        recordDiagnostic(trace, {
          event: "model_payload",
          result: "rejected",
          reason: error.code,
          repairAttempt: 0,
          ...(error.rawPayloadLength === undefined
            ? {}
            : { rawPayloadLength: error.rawPayloadLength }),
          ...(error.finishReason === undefined ? {} : { finishReason: error.finishReason }),
        });
        if (scope === "professional" || scope === "general") {
          recordDiagnostic(trace, {
            event: "fallback",
            reason: "invalid_model_payload",
            outcome: "temporarily_unavailable",
          });
        }
      }
      const result = temporaryUnavailableResult(scope);
      const reason: PseStopReason =
        error instanceof ModelUnavailableError
          ? "model_unavailable"
          : error instanceof InvalidModelPayloadError
            ? "invalid_model_payload"
            : "routing_or_planning_unavailable";
      recordDiagnostic(trace, { event: "stop", reason });
      return finishExecution(trace, result, startedAt, false, false);
    }
  }

  private async answerAcrossDomains(input: {
    readonly scope: Exclude<Scope, "normal">;
    readonly question: string;
    readonly plans: readonly DomainKnowledgePlan[];
    readonly requestSignal: AbortSignal;
    readonly deadlineAt: number;
    readonly trace: OutcomeTrace;
    readonly startedAt: number;
  }): Promise<PseAnswerExecution> {
    const domainsUsed = input.plans.map((plan) => plan.domain);
    const runner = this.dependencies.runAgentDetailed;
    if (runner === undefined || Date.now() >= input.deadlineAt) {
      recordDiagnostic(input.trace, {
        event: "domain_execution",
        phase: "agent",
        result: "unavailable",
        domainCount: input.plans.length,
        domainsUsed,
        reason: runner === undefined ? "runner_missing" : "active_deadline_elapsed",
      });
      recordDiagnostic(input.trace, { event: "stop", reason: "domain_execution_unavailable" });
      return finishExecution(
        input.trace,
        temporaryUnavailableResult(input.scope),
        input.startedAt,
        false,
        false,
        domainsUsed,
      );
    }

    const siblingController = new AbortController();
    const activeDeadlineSignal = AbortSignal.timeout(
      Math.max(1, input.deadlineAt - Date.now()),
    );
    const sharedSignal = AbortSignal.any([
      input.requestSignal,
      activeDeadlineSignal,
      siblingController.signal,
    ]);
    const tasks = input.plans.map(async (domainPlan): Promise<DetailedDomainResult> => {
      let phase: "session" | "agent" = "session";
      recordDiagnostic(input.trace, {
        event: "domain_execution",
        domain: domainPlan.domain,
        phase,
        result: "started",
        domainCount: input.plans.length,
        domainsUsed,
      });
      try {
        const session = await this.dependencies.knowledge.open(
          domainPlan.scope,
          sharedSignal,
        );
        if (sharedSignal.aborted) {
          throw new DomainExecutionError(
            activeDeadlineSignal.aborted || Date.now() >= input.deadlineAt
              ? "active_deadline_elapsed"
              : "domain_signal_aborted",
          );
        }
        if (session.project !== domainPlan.domain || !session.revision.trim()) {
          throw new DomainExecutionError("session_snapshot_mismatch");
        }
        recordDiagnostic(input.trace, {
          event: "domain_execution",
          domain: domainPlan.domain,
          phase,
          result: "completed",
          domainCount: input.plans.length,
          domainsUsed,
        });
        phase = "agent";
        recordDiagnostic(input.trace, {
          event: "domain_execution",
          domain: domainPlan.domain,
          phase,
          result: "started",
          domainCount: input.plans.length,
          domainsUsed,
        });
        const detailed = await runner({
          scope: domainPlan.scope,
          question: input.question,
          plan: domainPlan.plan,
          requirementBindings: domainPlan.bindings,
          ...(domainPlan.conditions === undefined
            ? {}
            : { requirementEvidenceConditions: domainPlan.conditions }),
          model: this.dependencies.model,
          session,
          deadlineAt: input.deadlineAt,
          trace: input.trace,
          signal: sharedSignal,
        });
        if (sharedSignal.aborted || Date.now() >= input.deadlineAt) {
          throw new DomainExecutionError(
            activeDeadlineSignal.aborted || Date.now() >= input.deadlineAt
              ? "active_deadline_elapsed"
              : "domain_signal_aborted",
          );
        }
        if (detailed.outcome === "unavailable") {
          throw new DomainExecutionError("agent_unavailable");
        }
        if (
          detailed.project !== session.project ||
          detailed.revision !== session.revision
        ) {
          throw new DomainExecutionError("session_snapshot_mismatch");
        }
        recordDiagnostic(input.trace, {
          event: "domain_execution",
          domain: domainPlan.domain,
          phase,
          result: "verified",
          domainCount: input.plans.length,
          domainsUsed,
        });
        return { ...detailed, domain: domainPlan.domain };
      } catch (error) {
        const failure = error instanceof DomainExecutionError
          ? error
          : new DomainExecutionError("domain_dependency_unavailable");
        recordDiagnostic(input.trace, {
          event: "domain_execution",
          domain: domainPlan.domain,
          phase,
          result: "unavailable",
          domainCount: input.plans.length,
          domainsUsed,
          reason: failure.code,
        });
        if (!siblingController.signal.aborted) siblingController.abort();
        throw failure;
      }
    });
    const settled = await Promise.allSettled(tasks);
    if (settled.some((result) => result.status === "rejected")) {
      recordDiagnostic(input.trace, { event: "stop", reason: "domain_execution_unavailable" });
      return finishExecution(
        input.trace,
        temporaryUnavailableResult(input.scope),
        input.startedAt,
        false,
        false,
        domainsUsed,
      );
    }

    let merged: MergedDomainAnswer;
    try {
      merged = mergeDetailedDomainResults({
        plans: input.plans,
        results: settled.map((result) =>
          (result as PromiseFulfilledResult<DetailedDomainResult>).value),
      });
    } catch (error) {
      recordDiagnostic(input.trace, {
        event: "domain_merge",
        result: "invalid",
        domainCount: input.plans.length,
        requirementCount: input.plans.reduce(
          (count, plan) => count + plan.plan.requirements.length,
          0,
        ),
        domainsUsed,
        reason: error instanceof DomainAnswerMergeError ? error.code : "unexpected_error",
      });
      recordDiagnostic(input.trace, { event: "stop", reason: "domain_merge_invalid" });
      return finishExecution(
        input.trace,
        temporaryUnavailableResult(input.scope),
        input.startedAt,
        false,
        false,
        domainsUsed,
      );
    }
    recordDiagnostic(input.trace, {
      event: "domain_merge",
      result: "completed",
      domainCount: merged.domainsUsed.length,
      requirementCount: merged.action.requirements.length,
      domainsUsed: merged.domainsUsed,
    });
    recordMergedCoverage(input.trace, input.plans, merged);
    if (merged.coverageGaps !== undefined) {
      recordDiagnostic(input.trace, {
        event: "coverage_gaps",
        domainCount: merged.domainsUsed.length,
        gapCount: merged.coverageGaps.length,
        gaps: merged.coverageGaps.map((gap) => ({
          domain: gap.domain,
          gapClass: gap.gapClass,
          reason: gap.reason,
          affectsConclusion: gap.affectsConclusion,
        })),
      });
    }
    const primary = formatKnowledgeFinal(
      input.scope,
      merged.action,
      merged.references,
      {
        ...(merged.domainEvidenceLedgers === undefined
          ? {}
          : { evidenceLedgers: merged.domainEvidenceLedgers }),
        ...(merged.coverageGaps === undefined
          ? {}
          : { coverageGaps: merged.coverageGaps }),
      },
    );
    return await this.finishPrimary({
      primary,
      question: input.question,
      requestSignal: input.requestSignal,
      trace: input.trace,
      startedAt: input.startedAt,
      domainsUsed: merged.domainsUsed,
      evidenceMetadata: merged,
    });
  }

  private async finishPrimary(input: {
    readonly primary: AnswerResult;
    readonly question: string;
    readonly requestSignal: AbortSignal;
    readonly trace: OutcomeTrace;
    readonly startedAt: number;
    readonly domainsUsed?: readonly KnowledgeDomain[];
    readonly evidenceMetadata?: ExecutionEvidenceMetadata;
  }): Promise<PseAnswerExecution> {
    if (
      input.primary.status !== "not_covered" ||
      this.dependencies.historicalProvider === undefined ||
      (input.domainsUsed !== undefined && !isPureProfessional(input.domainsUsed))
    ) {
      return finishExecution(
        input.trace,
        input.primary,
        input.startedAt,
        false,
        false,
        input.domainsUsed,
        input.evidenceMetadata,
      );
    }
    const historicalGate = evaluateHistoricalGate(input.question, input.trace);
    recordDiagnostic(input.trace, {
      event: "historical_gate",
      eligible: historicalGate === "eligible",
      reason: historicalGate,
    });
    if (historicalGate !== "eligible") {
      return finishExecution(
        input.trace,
        input.primary,
        input.startedAt,
        false,
        false,
        input.domainsUsed,
        input.evidenceMetadata,
      );
    }
    try {
      const historicalAttempted = true;
      const historicalLookup = await this.dependencies.historicalProvider.answer(
        input.question,
        input.requestSignal,
      );
      if (historicalLookup.outcome === "unavailable") {
        return finishExecution(
          input.trace,
          input.primary,
          input.startedAt,
          historicalAttempted,
          false,
          input.domainsUsed,
          input.evidenceMetadata,
        );
      }
      if (historicalLookup.outcome === "hidden") {
        const result: AnswerResult = {
          ...input.primary,
          historicalNotice: {
            provider: "coremail_mcp",
            searched: true,
            displayed: false,
            reason: historicalLookup.reason,
          },
        };
        return finishExecution(
          input.trace,
          result,
          input.startedAt,
          historicalAttempted,
          false,
          input.domainsUsed,
          input.evidenceMetadata,
        );
      }
      const result = { ...input.primary, historicalAnswer: historicalLookup.answer };
      return finishExecution(
        input.trace,
        result,
        input.startedAt,
        historicalAttempted,
        true,
        input.domainsUsed,
        input.evidenceMetadata,
      );
    } catch {
      return finishExecution(
        input.trace,
        input.primary,
        input.startedAt,
        true,
        false,
        input.domainsUsed,
        input.evidenceMetadata,
      );
    }
  }
}

type DomainExecutionFailureCode =
  | "runner_missing"
  | "active_deadline_elapsed"
  | "domain_signal_aborted"
  | "session_snapshot_mismatch"
  | "agent_unavailable"
  | "domain_dependency_unavailable";

class DomainExecutionError extends Error {
  constructor(readonly code: DomainExecutionFailureCode) {
    super(code);
    this.name = "DomainExecutionError";
  }
}

function domainPlanFailureMustFailClosed(reason: DomainPlanInactiveReason): boolean {
  return reason !== "guard_rejected" && reason !== "no_applicable_obligations";
}

function isPureProfessional(domains: readonly KnowledgeDomain[]): boolean {
  return domains.length === 1 && domains[0] === "coremail-professional";
}

function recordMergedCoverage(
  trace: DiagnosticTrace,
  plans: readonly DomainKnowledgePlan[],
  merged: MergedDomainAnswer,
): void {
  const localRequirementByBinding = new Map(
    plans.flatMap((plan) => plan.bindings.map((binding, index) => [
      `${binding.domain}\u0000${binding.requirementId}`,
      plan.plan.requirements[index]!,
    ] as const)),
  );
  recordDiagnostic(trace, {
    event: "coverage",
    stage: "verified",
    requirements: merged.bindings.map((binding, index) => ({
      id: binding.globalRequirementId,
      evidenceMode: localRequirementByBinding.get(
        `${binding.domain}\u0000${binding.requirementId}`,
      )!.evidenceMode,
      coverage: merged.action.requirements[index]!.coverage,
      citations: merged.action.requirements[index]!.citations,
    })),
    citations: merged.action.citations,
    stopReason: "final",
  });
}

async function observeTaskAnalysisShadow(input: {
  readonly analyzer?: TaskAnalysisShadow;
  readonly question: string;
  readonly conversationContext?: string;
  readonly scope: Exclude<Scope, "normal">;
  readonly legacyPlan: KnowledgePlan;
  readonly knowledgeContext: {
    readonly purpose: string;
    readonly schema: string;
    readonly planningOverview: string;
  };
  readonly trace: DiagnosticTrace;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<TaskAnalysisShadowResult | undefined> {
  if (input.analyzer === undefined) return undefined;
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = AbortSignal.any([input.signal, timeoutSignal]);
  try {
    const result = await input.analyzer.analyze({
      question: input.question,
      ...(input.conversationContext === undefined
        ? {}
        : { conversationContext: input.conversationContext }),
      scope: input.scope,
      legacyPlan: input.legacyPlan,
      knowledgeContext: input.knowledgeContext,
      signal,
    });
    const obligations = result.taskSpec.deliverables.flatMap(
      (deliverable) => deliverable.obligations,
    );
    const domains = new Set(obligations.flatMap((obligation) => obligation.domains));
    recordDiagnostic(input.trace, {
      event: "question_resolution",
      mode: result.resolvedQuestion.contextUsed ? "contextual" : "identity",
      contextUsed: result.resolvedQuestion.contextUsed,
      entityCount: result.taskSpec.entities.length,
      correctionCount: result.resolvedQuestion.corrections.length,
    });
    recordDiagnostic(input.trace, {
      event: "task_spec",
      domainCount: domains.size,
      entityCount: result.taskSpec.entities.length,
      deliverableCount: result.taskSpec.deliverables.length,
      coverageUnitCount: obligations.length,
      directUnitCount: obligations.filter((item) => item.evidencePolicy === "direct").length,
      synthesisUnitCount: obligations.filter((item) => item.evidencePolicy === "synthesis").length,
      customerInputUnitCount: obligations.filter(
        (item) => item.evidencePolicy === "customer_input",
      ).length,
    });
    recordDiagnostic(input.trace, {
      event: "task_spec_guard",
      ok: result.guard.ok,
      issueCodes: stableUniqueIssueCodes(result.guard.issues.map((issue) => issue.code)),
      explicitEntityCount: result.guard.explicitEntityCount,
      mappedExplicitEntityCount: result.guard.mappedExplicitEntityCount,
      explicitRequestCount: result.guard.explicitRequestCount,
      mappedExplicitRequestCount: result.guard.mappedExplicitRequestCount,
    });
    recordDiagnostic(input.trace, {
      event: "task_spec_shadow",
      result: "completed",
      elapsedMs: result.elapsedMs,
    });
    return result;
  } catch (error) {
    recordDiagnostic(input.trace, {
      event: "task_spec_shadow",
      result: timeoutSignal.aborted && !input.signal.aborted
        ? "timeout"
        : error instanceof InvalidModelPayloadError
          ? "invalid"
          : "unavailable",
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
    return undefined;
  }
}

function stableUniqueIssueCodes<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

class OutcomeTrace implements DiagnosticTrace {
  stopReason?: PseStopReason;
  formalCoverageVerified = false;
  verifiedHasFormalSupport = false;
  structuralFallback = false;
  draftCoverage?: readonly Coverage[];
  verifiedCoverage?: readonly Coverage[];
  retainedDirectSegmentCount?: number;
  retainedSynthesizedSegmentCount?: number;
  removedSegmentCount?: number;
  historicalGateReason?: HistoricalGateReason;

  constructor(private readonly delegate: DiagnosticTrace) {}

  get requestId(): string {
    return this.delegate.requestId;
  }

  record(event: DiagnosticEvent): void {
    if (event.event === "stop") this.stopReason = event.reason;
    if (event.event === "fallback") this.structuralFallback = true;
    if (event.event === "coverage") {
      const coverage = event.requirements.map(
        (requirement) => requirement.coverage,
      );
      if (event.stage === "draft") {
        this.draftCoverage = coverage;
      } else {
        this.formalCoverageVerified = true;
        this.verifiedCoverage = coverage;
        delete this.retainedDirectSegmentCount;
        delete this.retainedSynthesizedSegmentCount;
        delete this.removedSegmentCount;
        this.verifiedHasFormalSupport = false;
        const hasSegmentCounts = event.requirements.some((requirement) =>
          requirement.retainedDirectSegmentCount !== undefined ||
          requirement.retainedSynthesizedSegmentCount !== undefined ||
          requirement.removedSegmentCount !== undefined
        );
        if (hasSegmentCounts) {
          this.retainedDirectSegmentCount = sumRequirementCounts(
            event.requirements,
            "retainedDirectSegmentCount",
          );
          this.retainedSynthesizedSegmentCount = sumRequirementCounts(
            event.requirements,
            "retainedSynthesizedSegmentCount",
          );
          this.removedSegmentCount = sumRequirementCounts(
            event.requirements,
            "removedSegmentCount",
          );
          this.verifiedHasFormalSupport =
            this.retainedDirectSegmentCount > 0 ||
            this.retainedSynthesizedSegmentCount > 0;
        }
      }
    }
    if (event.event === "historical_gate") {
      this.historicalGateReason = event.reason;
    }
    this.delegate.record(event);
  }
}

function sumRequirementCounts(
  requirements: Extract<
    DiagnosticEvent,
    { event: "coverage" }
  >["requirements"],
  key:
    | "retainedDirectSegmentCount"
    | "retainedSynthesizedSegmentCount"
    | "removedSegmentCount",
): number {
  return requirements.reduce(
    (total, requirement) => total + (requirement[key] ?? 0),
    0,
  );
}

function evaluateHistoricalGate(
  question: string,
  trace: OutcomeTrace,
): Extract<DiagnosticEvent, { event: "historical_gate" }>["reason"] {
  if (trace.structuralFallback) return "structural_fallback";
  if (!trace.formalCoverageVerified) return "formal_verification_incomplete";
  if (trace.verifiedHasFormalSupport) return "formal_support_present";
  if (!/coremail/iu.test(question)) return "question_not_explicit_coremail";
  return "eligible";
}

function startDiagnosticTrace(factory: DiagnosticTraceFactory | undefined): DiagnosticTrace {
  try {
    return factory?.start() ?? NOOP_DIAGNOSTIC_TRACE;
  } catch {
    return NOOP_DIAGNOSTIC_TRACE;
  }
}

function recordFinished(
  trace: DiagnosticTrace,
  result: AnswerResult,
  startedAt: number,
  historicalAttempted: boolean,
  historicalUsed: boolean,
): void {
  recordDiagnostic(trace, {
    event: "finish",
    scope: result.scope,
    status: result.status,
    citationCount: result.references.length,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    historicalAttempted,
    historicalUsed,
    ...(result.knowledgeCoverage === undefined
      ? {}
      : { knowledgeCoverage: result.knowledgeCoverage }),
    ...(result.caseAssessability === undefined
      ? {}
      : { caseAssessability: result.caseAssessability }),
    ...(result.historicalNotice === undefined
      ? {}
      : {
          historicalNoticeShown: true,
          historicalRejectedReason: result.historicalNotice.reason,
        }),
  });
}

function finishExecution(
  trace: OutcomeTrace,
  result: AnswerResult,
  startedAt: number,
  historicalAttempted: boolean,
  historicalUsed: boolean,
  domainsUsed?: readonly KnowledgeDomain[],
  evidenceMetadata?: ExecutionEvidenceMetadata,
): PseAnswerExecution {
  recordFinished(trace, result, startedAt, historicalAttempted, historicalUsed);
  const coverageMetadata = executionCoverageMetadata(trace);
  const historicalNoticeMetadata = result.historicalNotice === undefined
    ? {}
    : {
        historicalNoticeShown: true as const,
        historicalRejectedReason: result.historicalNotice.reason,
      };
  if (result.status !== "temporarily_unavailable") {
    return {
      result,
      retryable: false,
      stopReason: "final",
      historicalAttempted,
      historicalUsed,
      ...coverageMetadata,
      ...historicalNoticeMetadata,
      ...(domainsUsed === undefined ? {} : { domainsUsed }),
      ...(evidenceMetadata ?? {}),
    };
  }
  const stopReason = trace.stopReason ?? "unknown_unavailable";
  return {
    result,
    retryable:
      stopReason === "model_unavailable" ||
      stopReason === "seed_unavailable" ||
      stopReason === "invalid_model_payload" ||
      stopReason === "invalid_final" ||
      stopReason === "evidence_review_unavailable" ||
      stopReason === "coverage_verifier_unavailable" ||
      stopReason === "coverage_verifier_invalid" ||
      stopReason === "domain_execution_unavailable",
    stopReason,
    historicalAttempted,
    historicalUsed,
    ...coverageMetadata,
    ...historicalNoticeMetadata,
    ...(domainsUsed === undefined ? {} : { domainsUsed }),
    ...(evidenceMetadata ?? {}),
  };
}

function executionCoverageMetadata(
  trace: OutcomeTrace,
): Omit<
  PseAnswerExecution,
  | "result"
  | "retryable"
  | "stopReason"
  | "historicalAttempted"
  | "historicalUsed"
  | "historicalNoticeShown"
  | "historicalRejectedReason"
  | "domainsUsed"
> {
  return {
    ...(trace.draftCoverage === undefined
      ? {}
      : { draftCoverage: trace.draftCoverage }),
    ...(trace.verifiedCoverage === undefined
      ? {}
      : { verifiedCoverage: trace.verifiedCoverage }),
    ...(trace.retainedDirectSegmentCount === undefined
      ? {}
      : {
          retainedDirectSegmentCount:
            trace.retainedDirectSegmentCount,
        }),
    ...(trace.retainedSynthesizedSegmentCount === undefined
      ? {}
      : {
          retainedSynthesizedSegmentCount:
            trace.retainedSynthesizedSegmentCount,
        }),
    ...(trace.removedSegmentCount === undefined
      ? {}
      : { removedSegmentCount: trace.removedSegmentCount }),
    ...(trace.historicalGateReason === undefined
      ? {}
      : { historicalGateReason: trace.historicalGateReason }),
  };
}

export function temporaryUnavailableResult(scope?: Scope): AnswerResult {
  const knowledge = scope === "professional" || scope === "general";
  return {
    scope: scope ?? "normal",
    status: "temporarily_unavailable",
    answer: knowledge ? "知识问答服务暂时不可用，请稍后重试。" : "问答服务暂时不可用，请稍后重试。",
    references: [],
  };
}
