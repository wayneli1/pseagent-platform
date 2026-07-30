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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return enforceProtectedEvidenceModes(
          normalizePlanRequirements(
            input.question,
            await this.complete(
              attempt === 1
                ? messages
                : [
                    ...messages,
                    {
                      role: "user",
                      content: "上一次输出不符合知识规划 Schema。只重新输出合法规划 JSON，不要解释。",
                    },
                  ],
              input.signal,
            ),
          ),
        );
      } catch (error) {
        if (!(error instanceof InvalidModelPayloadError) || attempt === 3) throw error;
      }
    }
    throw new InvalidModelPayloadError(
      "invalid_knowledge_plan_after_repair",
      undefined,
      "pse_knowledge_plan",
    );
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
    evidenceMode: "direct_only" as const,
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

function enforceProtectedEvidenceModes(plan: KnowledgePlan): KnowledgePlan {
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => ({
      ...requirement,
      evidenceMode: requiresDirectEvidence(requirement)
        ? "direct_only"
        : requirement.evidenceMode,
    })),
  });
}

const PROTECTED_EVIDENCE_PATTERNS = [
  /(?:是否|能否|有没有|是否具备|是否兼容|是否适配|支不支持|支持哪些)/u,
  /(?:协议|功能|能力|产品).{0,8}(?:支持|兼容|适配)|(?:支持|兼容|适配).{0,8}(?:协议|功能|能力|产品)/u,
  /(?:不支持|尚未提供|已经下线|版本|补丁|发布日期|生命周期|兼容|适配)/u,
  /(?:授权|报价|费用|采购|许可证|认证)/u,
  /(?:全部|仅有|仅支持|完整清单|最高|最低|最大|最小)/u,
  /(?:RTO|RPO|吞吐|时延|容量|性能|并发)/iu,
  /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|%)/iu,
];

function requiresDirectEvidence(
  requirement: KnowledgePlan["requirements"][number],
): boolean {
  const content = [requirement.question, ...requirement.queries].join(" ");
  return PROTECTED_EVIDENCE_PATTERNS.some((pattern) => pattern.test(content));
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
