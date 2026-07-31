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
import { formatAnswerResult } from "./response.js";

export const PSE_REQUEST_TIMEOUT_MS = 300_000;
export const PSE_ACTIVE_DEADLINE_MS = 270_000;

export interface KnowledgeSessionFactory {
  open(scope: Exclude<Scope, "normal">, signal?: AbortSignal): Promise<KnowledgeSession>;
}
export type AgentRunner = (input: {
  scope: Exclude<Scope, "normal">;
  question: string;
  conversationContext?: string;
  plan: KnowledgePlan;
  model: ModelClient;
  session: KnowledgeSession;
  deadlineAt: number;
  trace: DiagnosticTrace;
  signal?: AbortSignal;
}) => Promise<AnswerResult>;

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
}

export class AnswerService {
  constructor(private readonly dependencies: {
    readonly model: ModelClient;
    readonly router: Pick<ScopeRouter, "route">;
    readonly planner: KnowledgePlanner;
    readonly diagnostics?: DiagnosticTraceFactory;
    readonly knowledge: KnowledgeSessionFactory;
    readonly runAgent: AgentRunner;
    readonly historicalProvider?: HistoricalAnswerProvider;
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
    const timeoutSignal = AbortSignal.timeout(PSE_REQUEST_TIMEOUT_MS);
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
      const input = {
        scope,
        question,
        plan,
        model: this.dependencies.model,
        session,
        deadlineAt: startedAt + PSE_ACTIVE_DEADLINE_MS,
        trace,
        ...(conversationContext === undefined ? {} : { conversationContext }),
        signal: requestSignal,
      };
      const primary = await this.dependencies.runAgent(input);
      if (
        primary.status !== "not_covered" ||
        this.dependencies.historicalProvider === undefined
      ) {
        return finishExecution(trace, primary, startedAt, false, false);
      }
      const historicalGate = evaluateHistoricalGate(question, trace);
      recordDiagnostic(trace, {
        event: "historical_gate",
        eligible: historicalGate === "eligible",
        reason: historicalGate,
      });
      if (historicalGate !== "eligible") {
        return finishExecution(trace, primary, startedAt, false, false);
      }
      try {
        const historicalAttempted = true;
        const historicalLookup =
          await this.dependencies.historicalProvider.answer(question, requestSignal);
        if (historicalLookup.outcome === "unavailable") {
          return finishExecution(trace, primary, startedAt, historicalAttempted, false);
        }
        if (historicalLookup.outcome === "hidden") {
          const result: AnswerResult = {
            ...primary,
            historicalNotice: {
              provider: "coremail_mcp",
              searched: true,
              displayed: false,
              reason: historicalLookup.reason,
            },
          };
          return finishExecution(trace, result, startedAt, historicalAttempted, false);
        }
        const result = { ...primary, historicalAnswer: historicalLookup.answer };
        return finishExecution(trace, result, startedAt, historicalAttempted, true);
      } catch {
        return finishExecution(trace, primary, startedAt, true, false);
      }
    } catch (error) {
      if (error instanceof InvalidModelPayloadError) {
        recordDiagnostic(trace, {
          event: "model_payload",
          result: "rejected",
          reason: error.code,
          repairAttempt: 0,
          ...(error.schemaDescription === undefined
            ? {}
            : { schemaDescription: error.schemaDescription }),
          ...(error.rawPayload === undefined ? {} : { rawPayload: error.rawPayload }),
          ...(error.rawPayloadLength === undefined
            ? {}
            : { rawPayloadLength: error.rawPayloadLength }),
          ...(error.finishReason === undefined ? {} : { finishReason: error.finishReason }),
        });
        if (scope === "professional" || scope === "general") {
          recordDiagnostic(trace, {
            event: "fallback",
            reason: "invalid_model_payload",
            outcome: "not_covered",
          });
          return finishExecution(
            trace,
            formatAnswerResult({
              scope,
              status: "not_covered",
              answer: "",
              references: [],
            }),
            startedAt,
            false,
            false,
          );
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
    };
  }
  const stopReason = trace.stopReason ?? "unknown_unavailable";
  return {
    result,
    retryable:
      stopReason === "model_unavailable" ||
      stopReason === "seed_unavailable" ||
      stopReason === "coverage_verifier_unavailable",
    stopReason,
    historicalAttempted,
    historicalUsed,
    ...coverageMetadata,
    ...historicalNoticeMetadata,
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
