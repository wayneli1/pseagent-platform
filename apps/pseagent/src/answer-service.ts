import type { AnswerResult, Scope } from "./contracts.js";
import type { ModelClient } from "./model-client.js";
import { normalAnswerMessages } from "./prompts.js";
import type { ScopeRouter } from "./router.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import type { KnowledgePlan } from "./contracts.js";
import type { KnowledgePlanner } from "./knowledge-planner.js";
import {
  NOOP_DIAGNOSTIC_TRACE,
  recordDiagnostic,
  type DiagnosticTrace,
  type DiagnosticTraceFactory,
} from "./diagnostics.js";

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

  async answer(question: string, conversationContext?: string, signal?: AbortSignal): Promise<AnswerResult> {
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(PSE_REQUEST_TIMEOUT_MS);
    const requestSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
    const trace = startDiagnosticTrace(this.dependencies.diagnostics);
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
        recordFinished(trace, result, startedAt, false);
        return result;
      }
      const session = await this.dependencies.knowledge.open(scope, requestSignal);
      const plan = await this.dependencies.planner.plan({
        scope,
        question,
        schema: session.schema,
        overview: session.overview,
        ...(conversationContext === undefined ? {} : { conversationContext }),
        signal: requestSignal,
      });
      recordDiagnostic(trace, {
        event: "plan",
        subject: plan.subject,
        requirements: plan.requirements,
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
        recordFinished(trace, primary, startedAt, false);
        return primary;
      }
      try {
        const historicalAnswer =
          await this.dependencies.historicalProvider.answer(question, requestSignal);
        if (historicalAnswer === undefined) {
          recordFinished(trace, primary, startedAt, false);
          return primary;
        }
        const result = { ...primary, historicalAnswer };
        recordFinished(trace, result, startedAt, true);
        return result;
      } catch {
        recordFinished(trace, primary, startedAt, false);
        return primary;
      }
    } catch {
      const result = temporaryUnavailableResult(scope);
      recordDiagnostic(trace, { event: "stop", reason: "routing_or_planning_unavailable" });
      recordFinished(trace, result, startedAt, false);
      return result;
    }
  }
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
  historicalUsed: boolean,
): void {
  recordDiagnostic(trace, {
    event: "finish",
    scope: result.scope,
    status: result.status,
    citationCount: result.references.length,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    historicalUsed,
  });
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
