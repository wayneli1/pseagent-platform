import type { Scope } from "./contracts.js";
import { routeActionSchema } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { routeMessages } from "./prompts.js";
import { isPseAgentSelfQuestion } from "./self-context.js";

export class ScopeRouter {
  constructor(private readonly model: ModelClient) {}

  async route(question: string, conversationContext?: string, signal?: AbortSignal): Promise<Scope> {
    if (isPseAgentSelfQuestion(question)) return "normal";
    if (isUnambiguouslyGeneralPresalesQuestion(question)) return "general";
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

const PRODUCT_BOUNDARY_PATTERN =
  /(?:coremail|exchange|邮件|邮箱|电子信箱|网关|反垃圾|归档|部署|迁移|版本|兼容|授权|报价|交付周期|产品功能)/iu;
const GENERAL_PRESALES_ACTIVITY_PATTERN =
  /(?:职责|工作|方法|需求|访谈|话术|方案组织|价值表达|异议|沟通|冲突|演示|机会管理|项目推进|可信顾问)/u;

export function isUnambiguouslyGeneralPresalesQuestion(
  question: string,
): boolean {
  return /售前/u.test(question) &&
    GENERAL_PRESALES_ACTIVITY_PATTERN.test(question) &&
    !PRODUCT_BOUNDARY_PATTERN.test(question);
}
