import type { KnowledgePlan, Scope } from "./contracts.js";
import type {
  QuestionResolver,
  ResolvedQuestion,
} from "./question-resolver.js";
import type {
  TaskCompiler,
  TaskSpec,
  TaskSpecGuard,
  TaskSpecGuardResult,
} from "./task-spec.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import { observeModelCall } from "./model-observability.js";

export type { QuestionResolver } from "./question-resolver.js";
export type { TaskCompiler, TaskSpecGuard } from "./task-spec.js";

export interface TaskAnalysisShadowInput {
  readonly question: string;
  readonly conversationContext?: string;
  readonly scope: Exclude<Scope, "normal">;
  readonly legacyPlan: KnowledgePlan;
  readonly knowledgeContext: {
    readonly purpose: string;
    readonly schema: string;
    readonly planningOverview: string;
  };
  readonly signal?: AbortSignal;
  readonly trace?: DiagnosticTrace;
}

export interface TaskAnalysisShadowResult {
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
  readonly guard: TaskSpecGuardResult;
  readonly elapsedMs: number;
}

export interface TaskAnalysisShadow {
  analyze(input: TaskAnalysisShadowInput): Promise<TaskAnalysisShadowResult>;
}

export class DefaultTaskAnalysisShadow implements TaskAnalysisShadow {
  constructor(
    private readonly resolver: QuestionResolver,
    private readonly compiler: TaskCompiler,
    private readonly guard: TaskSpecGuard,
  ) {}

  async analyze(input: TaskAnalysisShadowInput): Promise<TaskAnalysisShadowResult> {
    const startedAt = Date.now();
    const resolvedQuestion = await observeModelCall({
      trace: input.trace,
      role: "resolver",
      operation: "resolve",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      call: () => this.resolver.resolve({
        question: input.question,
        ...(input.conversationContext === undefined
          ? {}
          : { conversationContext: input.conversationContext }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    });
    const taskSpec = await observeModelCall({
      trace: input.trace,
      role: "planner",
      operation: "compile",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      call: () => this.compiler.compile({
        resolvedQuestion,
        scopeHint: input.scope,
        legacyPlan: input.legacyPlan,
        knowledgeContext: input.knowledgeContext,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    });
    const guard = this.guard.validate({ resolvedQuestion, taskSpec });
    return {
      resolvedQuestion,
      taskSpec,
      guard,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
