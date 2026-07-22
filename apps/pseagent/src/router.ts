import type { Scope } from "./contracts.js";
import { routeActionSchema } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { routeMessages } from "./prompts.js";

export class ScopeRouter {
  constructor(private readonly model: ModelClient) {}

  async route(question: string, conversationContext?: string, signal?: AbortSignal): Promise<Scope> {
    const messages = routeMessages(question, conversationContext);
    try {
      return (await this.model.completeJson({
        messages,
        schema: routeActionSchema,
        schemaDescription: '{"action":"route","scope":"professional|general|normal"}',
        ...(signal === undefined ? {} : { signal }),
      })).scope;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      return (await this.model.completeJson({
        messages: [...messages, {
          role: "user",
          content: "上一次输出不符合 Schema。只重新输出合法 route JSON，不要解释。",
        }],
        schema: routeActionSchema,
        schemaDescription: '{"action":"route","scope":"professional|general|normal"}',
        ...(signal === undefined ? {} : { signal }),
      })).scope;
    }
  }
}
