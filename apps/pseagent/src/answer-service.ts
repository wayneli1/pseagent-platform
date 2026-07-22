import type { AnswerResult, Scope } from "./contracts.js";
import type { ModelClient } from "./model-client.js";
import { normalAnswerMessages } from "./prompts.js";
import type { ScopeRouter } from "./router.js";
import type { KnowledgeSession } from "./knowledge-session.js";

export interface KnowledgeSessionFactory {
  open(scope: Exclude<Scope, "normal">, signal?: AbortSignal): Promise<KnowledgeSession>;
}
export type AgentRunner = (input: {
  scope: Exclude<Scope, "normal">;
  question: string;
  conversationContext?: string;
  model: ModelClient;
  session: KnowledgeSession;
  signal?: AbortSignal;
}) => Promise<AnswerResult>;

export class AnswerService {
  constructor(private readonly dependencies: {
    readonly model: ModelClient;
    readonly router: Pick<ScopeRouter, "route">;
    readonly knowledge: KnowledgeSessionFactory;
    readonly runAgent: AgentRunner;
  }) {}

  async answer(question: string, conversationContext?: string, signal?: AbortSignal): Promise<AnswerResult> {
    let scope: Scope | undefined;
    try {
      scope = await this.dependencies.router.route(question, conversationContext, signal);
      if (scope === "normal") {
        const answer = await this.dependencies.model.completeText({
          messages: normalAnswerMessages(question, conversationContext),
          ...(signal === undefined ? {} : { signal }),
        });
        return { scope, status: "answered", answer, references: [] };
      }
      const session = await this.dependencies.knowledge.open(scope, signal);
      try {
        const input = {
          scope,
          question,
          model: this.dependencies.model,
          session,
          ...(conversationContext === undefined ? {} : { conversationContext }),
          ...(signal === undefined ? {} : { signal }),
        };
        return await this.dependencies.runAgent(input);
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch {
      return temporaryUnavailableResult(scope);
    }
  }
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
