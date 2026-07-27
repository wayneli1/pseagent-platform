import { knowledgePlanSchema, type KnowledgePlan, type Scope } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { knowledgePlanMessages } from "./prompts.js";

export interface KnowledgePlanInput {
  readonly scope: Exclude<Scope, "normal">;
  readonly question: string;
  readonly conversationContext?: string;
  readonly schema: string;
  readonly overview: string;
  readonly signal?: AbortSignal;
}

export interface KnowledgePlanner {
  plan(input: KnowledgePlanInput): Promise<KnowledgePlan>;
}

export class ModelKnowledgePlanner implements KnowledgePlanner {
  constructor(private readonly model: ModelClient) {}

  async plan(input: KnowledgePlanInput): Promise<KnowledgePlan> {
    const messages = knowledgePlanMessages(input);
    try {
      return await this.complete(messages, input.signal);
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      return this.complete([
        ...messages,
        {
          role: "user",
          content: "上一次输出不符合知识规划 Schema。只重新输出合法规划 JSON，不要解释。",
        },
      ], input.signal);
    }
  }

  private complete(
    messages: ReturnType<typeof knowledgePlanMessages>,
    signal?: AbortSignal,
  ): Promise<KnowledgePlan> {
    return this.model.completeJson({
      messages,
      schema: knowledgePlanSchema,
      schemaDescription: "pse_knowledge_plan",
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
