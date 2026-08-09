import { randomUUID } from "node:crypto";
import {
  AnswerProgressTracker,
  type AnswerProgressObserver,
} from "./answer-progress.js";
import type {
  AnswerStatus,
  AnswerResult,
  Coverage,
  HistoricalRejectionReason,
  Scope,
} from "./contracts.js";
import { knowledgePlanSchema, type KnowledgePlan } from "./contracts.js";
import { normalAnswerMessages } from "./prompts.js";
import {
  isUnambiguouslyGeneralPresalesQuestion,
  isUnambiguouslyNormalQuestion,
  isUnambiguouslyProfessionalQuestion,
  type ScopeRouter,
} from "./router.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import {
  NOOP_DIAGNOSTIC_TRACE,
  recordDiagnostic,
  type DiagnosticEvent,
  type DiagnosticTrace,
  type DiagnosticTraceFactory,
  type DiagnosticProgressEvent,
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
import {
  extractExplicitQuestionSignals,
  type KnowledgeDomain,
  type TaskSpecIssueCode,
} from "./task-spec.js";
import { analyzeObligationSource } from "./obligation-semantics.js";
import type {
  EvidenceLedger,
  RequirementEvidenceCondition,
} from "./evidence-ledger.js";
import type { CoverageGap } from "./coverage-gap.js";
import type { CoverageVerificationReport } from "./coverage-verifier.js";
import { observeModelCall } from "./model-observability.js";
import type {
  AnswerCardMatch,
  AnswerCardMatcher,
} from "./answer-card-matcher.js";
import {
  adaptAnswerCardToTaskSpec,
  applyAnswerCardPoliciesToPlan,
  compileExactAnswerCardTaskSpec,
  type AnswerCardObligationPolicy,
} from "./answer-card-task-spec-adapter.js";
import {
  identityResolvedQuestion,
  requiresContextualRouteResolution,
  type QuestionResolver,
  type ResolvedQuestion,
} from "./question-resolver.js";
import { normalAnswerNeedsRepair, stripUnrequestedExamples } from "./normal-answer.js";

export const PSE_REQUEST_TIMEOUT_MS = 300_000;
export const PSE_ACTIVE_DEADLINE_MS = 270_000;
const DOMAIN_AGENT_RETRY_RESERVE_MS = 30_000;

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
  readonly verifierModel?: ModelClient;
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
  /** Opaque correlation id for opt-in feedback; never exposed inside AnswerResult. */
  readonly requestId: string;
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
  readonly answerCardMatch?: AnswerCardExecutionSummary;
  readonly answerCardActivation?: AnswerCardActivationSummary;
  readonly feedbackContext: FeedbackSafeExecutionContext;
  /** The explicit question interpretation used by retrieval and planning when available. */
  readonly questionResolution?: ResolvedQuestion;
}

export interface AnswerCardExecutionSummary {
  readonly matchType: "exact" | "family" | "partial" | "none";
  readonly confidence: "deterministic" | "high" | "none";
  readonly candidateCount: number;
  readonly obligationCount: number;
  readonly cardIdHashes: readonly string[];
  readonly catalogHash: string;
  readonly reason?: Extract<
    DiagnosticEvent,
    { event: "answer_card_match" }
  >["reason"];
}

export interface AnswerCardActivationSummary {
  readonly activated: boolean;
  readonly reason: Extract<
    DiagnosticEvent,
    { event: "answer_card_activation" }
  >["reason"];
  readonly obligationCount: number;
  readonly issueCodes?: readonly TaskSpecIssueCode[];
}

export interface FeedbackSafeExecutionContext {
  readonly scope: Scope;
  readonly status: AnswerStatus;
  readonly referenceCount: number;
  readonly historicalUsed: boolean;
  readonly domainsUsed?: readonly KnowledgeDomain[];
}

interface ExecutionEvidenceMetadata {
  readonly verification?: CoverageVerificationReport;
  readonly domainEvidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
}

export class AnswerService {
  constructor(private readonly dependencies: {
    readonly model: ModelClient;
    readonly verifierModel?: ModelClient;
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
    readonly answerCardMatcher?: AnswerCardMatcher;
    readonly answerCardExactActiveEnabled?: boolean;
    readonly answerCardFamilyActiveEnabled?: boolean;
    readonly questionResolver?: QuestionResolver;
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
    progressObserver?: AnswerProgressObserver,
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
      progressObserver,
    );
    let scope: Scope | undefined;
    let questionResolution = identityResolvedQuestion(question);
    const withQuestionResolution = (execution:PseAnswerExecution):PseAnswerExecution => ({...execution,questionResolution});
    try {
      const exactRoute = (
        this.dependencies.answerCardExactActiveEnabled === true &&
        this.dependencies.taskSpecActiveEnabled === true
      )
        ? this.dependencies.answerCardMatcher?.routeExact?.(question)
        : undefined;
      scope = exactRoute === undefined
        ? await observeModelCall({
            trace,
            role: "resolver",
            operation: "route",
            signal: requestSignal,
            call: () => this.dependencies.router.route(
              question,
              conversationContext,
              requestSignal,
            ),
          })
        : scopeForDomain(exactRoute.domain);
      if (
        scope === "normal" &&
        exactRoute === undefined &&
        this.dependencies.questionResolver !== undefined &&
        requiresContextualRouteResolution(question, conversationContext)
      ) {
        try {
          const resolved = await observeModelCall({
            trace,
            role: "resolver",
            operation: "resolve",
            signal: requestSignal,
            call: () => this.dependencies.questionResolver!.resolve({
              question,
              ...(conversationContext === undefined ? {} : { conversationContext }),
              signal: requestSignal,
            }),
          });
          if (
            resolved.contextUsed &&
            resolved.standaloneQuestion.trim() !== question.trim()
          ) {
            questionResolution = resolved;
            const explicitScope = explicitScopeForResolvedQuestion(
              resolved.standaloneQuestion,
            );
            const inheritedScope = latestConversationKnowledgeScope(
              conversationContext,
            );
            scope = explicitScope ?? inheritedScope ?? await observeModelCall({
              trace,
              role: "resolver",
              operation: "route",
              signal: requestSignal,
              call: () => this.dependencies.router.route(
                resolved.standaloneQuestion,
                undefined,
                requestSignal,
              ),
            });
          }
        } catch (error) {
          if (
            !(error instanceof InvalidModelPayloadError) &&
            !(error instanceof ModelUnavailableError)
          ) throw error;
        }
      }
      recordDiagnostic(trace, { event: "route", scope });
      if (scope === "normal") {
        const normalQuestion = questionResolution.contextUsed
          ? questionResolution.standaloneQuestion
          : question;
        const normalConversationContext = questionResolution.contextUsed
          ? undefined
          : conversationContext;
        const draft = await observeModelCall({
          trace,
          role: "synthesizer",
          operation: "normal_answer",
          signal: requestSignal,
          call: () => this.dependencies.model.completeText({
            messages: normalAnswerMessages(normalQuestion, normalConversationContext),
            signal: requestSignal,
          }),
        });
        let answer = stripUnrequestedExamples(normalQuestion, draft);
        if (normalAnswerNeedsRepair(answer)) {
          const repaired = await observeModelCall({
            trace,
            role: "synthesizer",
            operation: "normal_answer_repair",
            signal: requestSignal,
            call: () => this.dependencies.model.completeText({
              messages: [
                ...normalAnswerMessages(normalQuestion, normalConversationContext),
                { role: "assistant", content: answer },
                { role: "user", content: "上一次回答存在未闭合标点、截断清单或未完成句子。请完整重写答案，保留正确结论，补全关键机制与适用边界，不要解释修订过程。" },
              ],
              signal: requestSignal,
            }),
          });
          answer = stripUnrequestedExamples(normalQuestion, repaired);
        }
        const result: AnswerResult = { scope, status: "answered", answer, references: [] };
        return withQuestionResolution(finishExecution(trace, result, startedAt, false, false));
      }
      if (scope !== "professional" && scope !== "general") {
        throw new Error("invalid_routed_scope");
      }
      const knowledgeScope = scope;
      const routedQuestion = questionResolution.contextUsed
        ? questionResolution.standaloneQuestion
        : question;
      const routedConversationContext = questionResolution.contextUsed
        ? undefined
        : conversationContext;
      const session = await this.dependencies.knowledge.open(knowledgeScope, requestSignal);
      const loadLegacyPlan = async (): Promise<KnowledgePlan> => {
        const legacyPlan = await observeModelCall({
          trace,
          role: "planner",
          operation: "plan",
          signal: requestSignal,
          call: () => this.dependencies.planner.plan({
            scope: knowledgeScope,
            question: routedQuestion,
            purpose: session.purpose,
            schema: session.schema,
            planningOverview: session.planningOverview,
            ...(routedConversationContext === undefined
              ? {}
              : { conversationContext: routedConversationContext }),
            signal: requestSignal,
          }),
        });
        recordPlanDiagnostics(trace, legacyPlan);
        return legacyPlan;
      };
      const taskSpecActive = this.dependencies.taskSpecActiveEnabled === true &&
        (this.dependencies.taskAnalysisShadow !== undefined || exactRoute !== undefined);
      let legacyPlan = taskSpecActive ? undefined : await loadLegacyPlan();
      let taskAnalysis = exactRoute === undefined
        ? await observeTaskAnalysisShadow({
            ...(this.dependencies.taskAnalysisShadow === undefined
              ? {}
              : { analyzer: this.dependencies.taskAnalysisShadow }),
            question,
            ...(conversationContext === undefined ? {} : { conversationContext }),
            ...(questionResolution.contextUsed
              ? { resolvedQuestion: questionResolution }
              : {}),
            scope,
            ...(legacyPlan === undefined ? {} : { legacyPlan }),
            knowledgeContext: {
              purpose: session.purpose,
              schema: session.schema,
              planningOverview: session.planningOverview,
            },
            trace,
            signal: requestSignal,
            timeoutMs: this.dependencies.taskSpecShadowTimeoutMs ?? 15_000,
          })
        : undefined;
      if(taskAnalysis!==undefined)questionResolution=taskAnalysis.resolvedQuestion;
      const answerCardMatch = await this.matchAnswerCard({
        question: exactRoute === undefined
          ? taskAnalysis?.resolvedQuestion.standaloneQuestion ?? routedQuestion
          : question,
        currentDomain: session.project,
        currentRevision: session.revision,
        requestSignal,
        trace,
      });
      let answerCardPolicies: readonly AnswerCardObligationPolicy[] | undefined;
      let activeAnswerCardMatch: Exclude<AnswerCardMatch, { matchType: "none" }> | undefined;
      if (answerCardMatch !== undefined && answerCardMatch.matchType !== "none") {
        const activationEnabled = answerCardMatch.matchType === "exact"
          ? this.dependencies.answerCardExactActiveEnabled === true &&
            this.dependencies.taskSpecActiveEnabled === true
          : this.dependencies.answerCardFamilyActiveEnabled === true &&
            this.dependencies.taskSpecActiveEnabled === true &&
            this.dependencies.multiDomainActiveEnabled === true;
        if (!activationEnabled) {
          recordDiagnostic(trace, {
            event: "answer_card_activation",
            activated: false,
            reason: "shadow_only",
            obligationCount: answerCardMatch.bindings.length,
          });
        } else {
          const adapted = answerCardMatch.matchType === "exact"
            ? compileExactAnswerCardTaskSpec({
                match: answerCardMatch,
                resolvedQuestion: taskAnalysis?.resolvedQuestion ??
                  identityResolvedQuestion(question),
              })
            : taskAnalysis === undefined
              ? { activated: false as const, reason: "match_not_active" as const }
              : adaptAnswerCardToTaskSpec({
                  match: answerCardMatch,
                  resolvedQuestion: taskAnalysis.resolvedQuestion,
                  taskSpec: taskAnalysis.taskSpec,
                });
          recordDiagnostic(trace, {
            event: "answer_card_activation",
            activated: adapted.activated,
            reason: adapted.activated
              ? "activated"
              : taskAnalysis === undefined && answerCardMatch.matchType !== "exact"
                ? "analysis_unavailable"
                : adapted.reason,
            obligationCount: adapted.activated ? adapted.policies.length : 0,
            ...(adapted.activated || adapted.issueCodes === undefined
              ? {}
              : { issueCodes: adapted.issueCodes }),
          });
          if (adapted.activated) {
            taskAnalysis = {
              resolvedQuestion: taskAnalysis?.resolvedQuestion ??
                identityResolvedQuestion(question),
              taskSpec: adapted.taskSpec,
              guard: adapted.guard,
              elapsedMs: taskAnalysis?.elapsedMs ?? 0,
            };
            answerCardPolicies = adapted.policies;
            activeAnswerCardMatch = answerCardMatch;
          }
        }
      }
      let effectiveQuestion = routedQuestion;
      let effectivePlan = legacyPlan;
      let effectiveConversationContext = routedConversationContext;
      let effectiveEvidenceConditions: readonly RequirementEvidenceCondition[] | undefined;
      let effectiveRequirementBindings: readonly DomainRequirementBinding[] | undefined;
      if (taskAnalysis !== undefined) {
        if (this.dependencies.taskSpecActiveEnabled === true) {
          if (this.dependencies.multiDomainActiveEnabled === true) {
            const derived = deriveDomainKnowledgePlans({
              resolvedQuestion: taskAnalysis.resolvedQuestion,
              taskSpec: taskAnalysis.taskSpec,
              guardResult: taskAnalysis.guard,
              ...(answerCardPolicies === undefined
                ? {}
                : { cardPolicies: answerCardPolicies }),
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
              return withQuestionResolution(await this.answerAcrossDomains({
                scope,
                question: taskAnalysis.resolvedQuestion.standaloneQuestion,
                plans: derived.plans,
                requestSignal,
                deadlineAt,
                trace,
                startedAt,
                ...(activeAnswerCardMatch === undefined
                  ? {}
                  : { expectedRevisions: activeAnswerCardMatch.expectedRevisions }),
              }));
            }
            recordDiagnostic(trace, {
              event: "task_spec_activation",
              activated: false,
              reason: derived.reason,
              requirementCount: 0,
            });
            if (domainPlanFailureMustFailClosed(derived.reason)) {
              recordDiagnostic(trace, { event: "stop", reason: "domain_plan_invalid" });
              return withQuestionResolution(finishExecution(
                trace,
                temporaryUnavailableResult(scope),
                startedAt,
                false,
                false,
              ));
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
              effectivePlan = applyAnswerCardPoliciesToPlan({
                plan: adapted.plan,
                obligationIds: adapted.obligationIds,
                policies: answerCardPolicies ?? [],
              });
              effectiveConversationContext = undefined;
              effectiveEvidenceConditions = adapted.conditions;
              effectiveRequirementBindings = singleDomainBindings({
                domain: session.project,
                taskSpec: taskAnalysis.taskSpec,
                plan: effectivePlan,
                obligationIds: adapted.obligationIds,
                cardPolicies: answerCardPolicies ?? [],
              });
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
      if (effectivePlan === undefined) {
        legacyPlan = await loadLegacyPlan();
        effectivePlan = legacyPlan;
      }
      if (effectiveEvidenceConditions === undefined) {
        const fallbackForecast = deriveMissingForecastPlan(
          effectiveQuestion,
          effectivePlan,
          effectiveConversationContext,
        );
        if (fallbackForecast !== undefined) {
          effectivePlan = fallbackForecast.plan;
          effectiveEvidenceConditions = fallbackForecast.conditions;
        }
      }
      const input = {
        scope,
        question: effectiveQuestion,
        plan: effectivePlan,
        ...(effectiveEvidenceConditions === undefined
          ? {}
          : { requirementEvidenceConditions: effectiveEvidenceConditions }),
        ...(effectiveRequirementBindings === undefined
          ? {}
          : { requirementBindings: effectiveRequirementBindings }),
        model: this.dependencies.model,
        ...(this.dependencies.verifierModel === undefined
          ? {}
          : { verifierModel: this.dependencies.verifierModel }),
        session,
        deadlineAt,
        trace,
        ...(effectiveConversationContext === undefined
          ? {}
          : { conversationContext: effectiveConversationContext }),
        signal: requestSignal,
      };
      const primary = await this.dependencies.runAgent(input);
      return withQuestionResolution(await this.finishPrimary({
        primary,
        question: effectiveQuestion,
        requestSignal,
        trace,
        startedAt,
      }));
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
      return withQuestionResolution(finishExecution(trace, result, startedAt, false, false));
    }
  }

  private async matchAnswerCard(input: {
    readonly question: string;
    readonly currentDomain: KnowledgeDomain;
    readonly currentRevision: string;
    readonly requestSignal: AbortSignal;
    readonly trace: DiagnosticTrace;
  }): Promise<AnswerCardMatch | undefined> {
    const matcher = this.dependencies.answerCardMatcher;
    if (matcher === undefined) return undefined;
    let match: AnswerCardMatch;
    try {
      match = await matcher.match({
        question: input.question,
        currentDomain: input.currentDomain,
        currentRevision: input.currentRevision,
        familyEnabled: true,
        signal: input.requestSignal,
      });
    } catch {
      match = {
        matchType: "none",
        confidence: "none",
        reason: "family_match_unavailable",
        catalogHash: "0".repeat(64),
        candidateCount: 0,
      };
    }
    recordDiagnostic(input.trace, {
      event: "answer_card_match",
      matchType: match.matchType,
      confidence: match.confidence,
      candidateCount: match.candidateCount,
      obligationCount: match.matchType === "none" ? 0 : match.bindings.length,
      cardIdHashes: match.matchType === "none" ? [] : match.cardIdHashes,
      catalogHash: match.catalogHash,
      ...(match.matchType === "none" ? { reason: match.reason } : {}),
    });
    return match;
  }

  private async answerAcrossDomains(input: {
    readonly scope: Exclude<Scope, "normal">;
    readonly question: string;
    readonly plans: readonly DomainKnowledgePlan[];
    readonly requestSignal: AbortSignal;
    readonly deadlineAt: number;
    readonly trace: OutcomeTrace;
    readonly startedAt: number;
    readonly expectedRevisions?: Readonly<Partial<Record<KnowledgeDomain, string>>>;
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
        const expectedRevision = input.expectedRevisions?.[domainPlan.domain];
        if (
          session.project !== domainPlan.domain ||
          !session.revision.trim() ||
          (expectedRevision !== undefined && session.revision !== expectedRevision)
        ) {
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
        const runnerInput = {
          scope: domainPlan.scope,
          question: input.question,
          plan: domainPlan.plan,
          requirementBindings: domainPlan.bindings,
          ...(domainPlan.conditions === undefined
            ? {}
            : { requirementEvidenceConditions: domainPlan.conditions }),
          model: this.dependencies.model,
          ...(this.dependencies.verifierModel === undefined
            ? {}
            : { verifierModel: this.dependencies.verifierModel }),
          session,
          deadlineAt: input.deadlineAt,
          trace: input.trace,
          signal: sharedSignal,
        };
        let detailed = await runner(runnerInput);
        if (
          detailed.outcome === "unavailable" &&
          input.plans.length === 1 &&
          !sharedSignal.aborted &&
          Date.now() + DOMAIN_AGENT_RETRY_RESERVE_MS < input.deadlineAt
        ) {
          // A complete verified attempt is still required. Retry one isolated
          // domain once for transient model/verifier failures; never retry
          // snapshot mismatches or cross-domain sibling failures.
          delete input.trace.stopReason;
          recordDiagnostic(input.trace, {
            event: "domain_execution",
            domain: domainPlan.domain,
            phase,
            result: "started",
            domainCount: input.plans.length,
            domainsUsed,
          });
          detailed = await runner(runnerInput);
        }
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
        question: input.question,
        ...(merged.domainEvidenceLedgers === undefined
          ? {}
          : { evidenceLedgers: merged.domainEvidenceLedgers }),
        ...(merged.coverageGaps === undefined
          ? {}
          : { coverageGaps: merged.coverageGaps }),
        requirementBindings: merged.bindings,
        ...(merged.verification === undefined
          ? {}
          : { verification: merged.verification }),
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

function explicitScopeForResolvedQuestion(question: string): Scope | undefined {
  if (isUnambiguouslyNormalQuestion(question)) return "normal";
  if (isUnambiguouslyGeneralPresalesQuestion(question)) return "general";
  if (isUnambiguouslyProfessionalQuestion(question)) return "professional";
  return undefined;
}

function latestConversationKnowledgeScope(
  conversationContext: string | undefined,
): Exclude<Scope, "normal"> | undefined {
  if (conversationContext === undefined) return undefined;
  try {
    const parsed = JSON.parse(conversationContext) as {
      version?: unknown;
      recentTurns?: unknown;
    };
    if (parsed.version !== 3 || !Array.isArray(parsed.recentTurns)) return undefined;
    for (let index = parsed.recentTurns.length - 1; index >= 0; index -= 1) {
      const scope = (parsed.recentTurns[index] as { scope?: unknown }).scope;
      if (scope === "professional" || scope === "general") return scope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function scopeForDomain(domain: KnowledgeDomain): Exclude<Scope, "normal"> {
  return domain === "coremail-professional" ? "professional" : "general";
}

function singleDomainBindings(input: {
  readonly domain: KnowledgeDomain;
  readonly taskSpec: TaskAnalysisShadowResult["taskSpec"];
  readonly plan: KnowledgePlan;
  readonly obligationIds: readonly string[];
  readonly cardPolicies: readonly AnswerCardObligationPolicy[];
}): readonly DomainRequirementBinding[] {
  const required = input.taskSpec.deliverables.flatMap((deliverable) =>
    !deliverable.required
      ? []
      : deliverable.obligations.flatMap((obligation) =>
          obligation.required ? [{ deliverable, obligation }] : []));
  const applicable = required.filter(({ obligation }) =>
    obligation.domains.includes(input.domain));
  const policyByObligation = new Map(
    input.cardPolicies.map((policy) => [policy.obligationId, policy] as const),
  );
  if (
    applicable.length !== input.plan.requirements.length ||
    applicable.length !== input.obligationIds.length ||
    applicable.some(({ obligation }, index) => obligation.id !== input.obligationIds[index])
  ) {
    throw new Error("single_domain_answer_card_binding_mismatch");
  }
  return applicable.map(({ deliverable, obligation }, index) => {
    const policy = policyByObligation.get(obligation.id);
    return {
      domain: input.domain,
      requirementId: input.plan.requirements[index]!.id,
      deliverableId: deliverable.id,
      obligationId: obligation.id,
      order: required.findIndex((item) => item.obligation.id === obligation.id),
      ...(policy === undefined
        ? {}
        : {
            cardId: policy.cardId,
            cardObligationId: policy.cardObligationId,
            requiredConcepts: policy.requiredConcepts,
            forbiddenClaims: policy.forbiddenClaims,
            preferredEvidencePaths: policy.preferredEvidencePaths,
          }),
    };
  });
}

function deriveMissingForecastPlan(
  question: string,
  plan: KnowledgePlan,
  conversationContext?: string,
): {
  readonly plan: KnowledgePlan;
  readonly conditions: readonly RequirementEvidenceCondition[];
} | undefined {
  const contextualQuestion = conversationContext === undefined
    ? question
    : `${conversationContext}\n${question}`;
  const hasExplicitMissingCustomerFacts =
    /(?:获取不到|无法获取|拿不到|缺少|没有|信息不足|信息不全|不清楚|未知|尚未确认|未确认).{0,20}(?:客户|信息|事实|证据)/u.test(contextualQuestion) ||
    /(?:客户|信息|事实|证据).{0,20}(?:获取不到|无法获取|拿不到|缺少|没有|不足|不全|不清楚|未知|尚未确认|未确认)/u.test(contextualQuestion);
  if (!hasExplicitMissingCustomerFacts) return undefined;

  const forecastClauses = extractExplicitQuestionSignals(question)
    .requestClauses.filter((clause) =>
      analyzeObligationSource(clause).customerInputEligible ||
      (
        /(?:当前|本次|这个|该|我们|我方).{0,8}(?:赢率|胜率|成交概率|成功概率|机会质量|销售预测)/u.test(
          clause,
        ) &&
        !/(?:提升|提高|改善|优化|方法|建议|措施|怎样做|怎么做|如何做)/u.test(clause)
      ));
  if (
    forecastClauses.length === 0 &&
    /(?:报|给|估|评估|预测|判断).{0,12}(?:百分比|概率|几成|成数)|(?:应该|应当|该|需要).{0,8}报多少/u.test(
      question,
    ) &&
    /(?:销售|商机|机会|项目|赢率|胜率|成交|POC)/iu.test(
      `${contextualQuestion} ${plan.subject}`,
    )
  ) {
    forecastClauses.push(question);
  }
  if (forecastClauses.length === 0) return undefined;

  const forecastRequirements = plan.requirements.filter((requirement) => {
    if (analyzeObligationSource(requirement.question).customerInputEligible) {
      return true;
    }
    return /(?:赢率|胜率|成交概率|成功概率|机会质量|销售预测)/u.test(
      requirement.question,
    ) &&
      !/(?:提升|提高|改善|优化|方法|建议|措施|清单|行动|下一步|怎样做|怎么做|如何做)/u.test(
        requirement.question,
      );
  });
  if (forecastRequirements.length > 0) {
    return {
      plan,
      conditions: forecastRequirements.map((requirement) => ({
        requirementId: requirement.id,
        inputState: "missing",
        ambiguous: false,
        conflictDetected: false,
        freshness: "not_assessed",
      })),
    };
  }
  if (plan.requirements.length >= 6) return undefined;

  const forecastClause = forecastClauses[0]!;
  const augmentedPlan = knowledgePlanSchema.parse({
    ...plan,
    subject: plan.subject,
    requirements: [
      {
        id: "R1",
        question: forecastClause,
        evidenceMode: "synthesis_allowed",
        evidenceAspects: [{
          id: "A1",
          label: forecastClause,
          terms: [forecastClause],
        }],
        queries: [{ text: forecastClause, aspectIds: ["A1"] }],
      },
      ...plan.requirements.map((requirement, index) => ({
        ...requirement,
        id: `R${index + 2}`,
      })),
    ],
  });
  return {
    plan: augmentedPlan,
    conditions: [{
      requirementId: "R1",
      inputState: "missing",
      ambiguous: false,
      conflictDetected: false,
      freshness: "not_assessed",
    }],
  };
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
  readonly legacyPlan?: KnowledgePlan;
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
      ...(input.legacyPlan === undefined ? {} : { legacyPlan: input.legacyPlan }),
      knowledgeContext: input.knowledgeContext,
      signal,
      trace: input.trace,
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

function recordPlanDiagnostics(
  trace: DiagnosticTrace,
  plan: KnowledgePlan,
): void {
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
  answerCardMatch?: AnswerCardExecutionSummary;
  answerCardActivation?: AnswerCardActivationSummary;

  private readonly progressTracker: AnswerProgressTracker | undefined;

  constructor(
    private readonly delegate: DiagnosticTrace,
    progressObserver?: AnswerProgressObserver,
  ) {
    this.progressTracker = progressObserver === undefined
      ? undefined
      : new AnswerProgressTracker(progressObserver);
  }

  get requestId(): string {
    return this.delegate.requestId;
  }

  record(event: DiagnosticEvent): void {
    if (event.event === "stop") this.stopReason = event.reason;
    if (event.event === "fallback") this.structuralFallback = true;
    if (event.event === "answer_card_match") {
      this.answerCardMatch = {
        matchType: event.matchType,
        confidence: event.confidence,
        candidateCount: event.candidateCount,
        obligationCount: event.obligationCount,
        cardIdHashes: [...event.cardIdHashes],
        catalogHash: event.catalogHash,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    }
    if (event.event === "answer_card_activation") {
      this.answerCardActivation = {
        activated: event.activated,
        reason: event.reason,
        obligationCount: event.obligationCount,
        ...(event.issueCodes === undefined
          ? {}
          : { issueCodes: [...event.issueCodes] }),
      };
    }
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
    try {
      this.delegate.record(event);
    } finally {
      this.progressTracker?.record(event);
    }
  }

  progress(event: DiagnosticProgressEvent): void {
    try {
      this.delegate.progress?.(event);
    } finally {
      this.progressTracker?.recordProgress(event);
    }
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
  let delegate: DiagnosticTrace;
  try {
    delegate = factory?.start() ?? NOOP_DIAGNOSTIC_TRACE;
  } catch {
    delegate = NOOP_DIAGNOSTIC_TRACE;
  }
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(delegate.requestId)
    ? delegate.requestId
    : randomUUID();
  return {
    requestId,
    record(event) {
      delegate.record(event);
    },
  };
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
  const safeExecutionMetadata = {
    requestId: trace.requestId,
    ...(trace.answerCardMatch === undefined
      ? {}
      : { answerCardMatch: trace.answerCardMatch }),
    ...(trace.answerCardActivation === undefined
      ? {}
      : { answerCardActivation: trace.answerCardActivation }),
    feedbackContext: {
      scope: result.scope,
      status: result.status,
      referenceCount:
        result.references.length +
        (result.historicalAnswer?.references.length ?? 0),
      historicalUsed,
      ...(domainsUsed === undefined ? {} : { domainsUsed }),
    },
  };
  if (result.status !== "temporarily_unavailable") {
    return {
      ...safeExecutionMetadata,
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
    ...safeExecutionMetadata,
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
  | "requestId"
  | "answerCardMatch"
  | "answerCardActivation"
  | "feedbackContext"
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
