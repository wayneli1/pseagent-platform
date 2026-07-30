import type { Scope } from "./contracts.js";
import { routeActionSchema } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { routeMessages } from "./prompts.js";
import { isPseAgentSelfQuestion } from "./self-context.js";

export class ScopeRouter {
  constructor(private readonly model: ModelClient) {}

  async route(question: string, conversationContext?: string, signal?: AbortSignal): Promise<Scope> {
    if (isPseAgentSelfQuestion(question)) return "normal";
    const messages = routeMessages(question, conversationContext);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return (await this.model.completeJson({
          messages: attempt === 1
            ? messages
            : [...messages, {
                role: "user",
                content: "上一次输出不符合 Schema。只重新输出合法 route JSON，不要解释。",
              }],
          schema: routeActionSchema,
          schemaDescription: '{"action":"route","scope":"professional|general|normal"}',
          ...(signal === undefined ? {} : { signal }),
        })).scope;
      } catch (error) {
        if (!(error instanceof InvalidModelPayloadError) || attempt === 3) throw error;
      }
    }
    throw new InvalidModelPayloadError(
      "invalid_route_after_repair",
      undefined,
      '{"action":"route","scope":"professional|general|normal"}',
    );
  }
}
