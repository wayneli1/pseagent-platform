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
      return normalizePlanRequirements(
        input.question,
        await this.complete(messages, input.signal),
      );
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      return normalizePlanRequirements(
        input.question,
        await this.complete([
          ...messages,
          {
            role: "user",
            content: "上一次输出不符合知识规划 Schema。只重新输出合法规划 JSON，不要解释。",
          },
        ], input.signal),
      );
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

function normalizePlanRequirements(question: string, plan: KnowledgePlan): KnowledgePlan {
  const scale = extractUserScale(question);
  if (
    scale === undefined ||
    plan.requirements.length >= 6 ||
    countInfrastructureAspects(question) < 2 ||
    hasStandaloneCapacityRequirement(plan, scale)
  ) {
    return plan;
  }
  const product = /coremail/iu.test(question)
    ? "Coremail 邮件系统"
    : plan.subject;
  const capacityRequirement = {
    id: "R1" as const,
    question: `${scale}规模的服务器数量、存储容量和硬件配置参考`,
    queries: [
      `${scale} ${product} 服务器数量 存储容量 硬件配置`,
      `${scale} ${product} 容量规划 资源配置`,
    ],
  };
  const requirements = [
    capacityRequirement,
    ...plan.requirements,
  ].map((requirement, index) => ({
    ...requirement,
    id: `R${index + 1}` as KnowledgePlan["requirements"][number]["id"],
  }));
  return knowledgePlanSchema.parse({ ...plan, requirements });
}

function extractUserScale(question: string): string | undefined {
  return question.match(
    /(?<scale>(?:\d+(?:\.\d+)?\s*(?:万|千)?|[零一二两三四五六七八九十百千万]+)\s*用户)/u,
  )?.groups?.scale?.replace(/\s+/gu, "");
}

function countInfrastructureAspects(question: string): number {
  return [
    /多活/u,
    /容灾|灾备/u,
    /镜像|同步/u,
    /架构|部署/u,
  ].filter((pattern) => pattern.test(question)).length;
}

function hasStandaloneCapacityRequirement(plan: KnowledgePlan, scale: string): boolean {
  const normalizedScale = scale.replace(/\s+/gu, "");
  return plan.requirements.some((requirement) => {
    const content = [requirement.question, ...requirement.queries]
      .join(" ")
      .replace(/\s+/gu, "");
    return content.includes(normalizedScale) &&
      /服务器|存储|容量|硬件|资源(?:需求|规划|配置)/u.test(content);
  });
}
