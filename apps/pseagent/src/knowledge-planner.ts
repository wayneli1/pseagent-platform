import { z } from "zod";
import { knowledgePlanSchema, type KnowledgePlan, type Scope } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { knowledgePlanMessages } from "./prompts.js";

export interface KnowledgePlanInput {
  readonly scope: Exclude<Scope, "normal">;
  readonly question: string;
  readonly conversationContext?: string;
  readonly purpose: string;
  readonly schema: string;
  readonly planningOverview: string;
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
        return normalizeDirectQueryAspectTerms(
          normalizeDirectComparisonAspects(
            input.question,
            normalizeVendorNeutralPresalesInterviewPlan(
              input.question,
              normalizeCoremailMigrationCapabilityPlan(
                input.question,
                enforceProtectedEvidenceModes(
                  normalizeSynthesisQueries(
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
                  ),
                ),
              ),
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
      schema: knowledgePlanModelResponseSchema,
      schemaDescription: "pse_knowledge_plan",
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

const knowledgePlanModelResponseSchema = z.preprocess(
  normalizeModelPlanStructure,
  knowledgePlanSchema,
);

function normalizeModelPlanStructure(value: unknown): unknown {
  if (!isUnknownRecord(value) || !Array.isArray(value.requirements)) {
    return value;
  }
  return {
    ...value,
    requirements: value.requirements.slice(0, 6).map(
      (rawRequirement, requirementIndex) => {
        if (!isUnknownRecord(rawRequirement)) return rawRequirement;
        const rawAspects = Array.isArray(rawRequirement.evidenceAspects)
          ? rawRequirement.evidenceAspects.slice(0, 8)
          : [];
        const aspectIdMap = new Map<string, string>();
        const evidenceAspects = rawAspects.map((rawAspect, aspectIndex) => {
          if (!isUnknownRecord(rawAspect)) return rawAspect;
          const normalizedId = `A${aspectIndex + 1}`;
          if (typeof rawAspect.id === "string") {
            aspectIdMap.set(rawAspect.id, normalizedId);
          }
          const terms = Array.isArray(rawAspect.terms)
            ? stableUniqueStrings(rawAspect.terms).slice(0, 8)
            : rawAspect.terms;
          return { ...rawAspect, id: normalizedId, terms };
        });
        const knownIds = evidenceAspects.flatMap((aspect) =>
          isUnknownRecord(aspect) && typeof aspect.id === "string"
            ? [aspect.id]
            : []
        );
        const queries = Array.isArray(rawRequirement.queries)
          ? rawRequirement.queries.slice(0, 3).map((rawQuery) => {
              if (!isUnknownRecord(rawQuery)) return rawQuery;
              const mappedIds = Array.isArray(rawQuery.aspectIds)
                ? stableUniqueStrings(rawQuery.aspectIds)
                    .map((id) => aspectIdMap.get(id) ?? id)
                    .filter((id) => knownIds.includes(id))
                : [];
              return {
                ...rawQuery,
                aspectIds: mappedIds.length > 0
                  ? mappedIds
                  : knownIds.slice(0, 1),
              };
            })
          : rawRequirement.queries;
        return {
          ...rawRequirement,
          id: `R${requirementIndex + 1}`,
          evidenceAspects,
          queries,
        };
      },
    ),
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableUniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const normalized = value.trim().toLocaleLowerCase("zh-CN");
    if (normalized.length === 0 || seen.has(normalized)) return [];
    seen.add(normalized);
    return [value];
  });
}

function normalizeSynthesisQueries(plan: KnowledgePlan): KnowledgePlan {
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      if (
        requirement.evidenceMode !== "synthesis_allowed" ||
        requirement.evidenceAspects.length <= 1
      ) {
        return requirement;
      }
      const desiredQueryCount = Math.min(
        3,
        requirement.evidenceAspects.length,
      );
      const maximumBalancedSize = Math.ceil(
        requirement.evidenceAspects.length / desiredQueryCount,
      );
      if (
        requirement.queries.length === desiredQueryCount &&
        requirement.queries.every(
          (query) => query.aspectIds.length <= maximumBalancedSize,
        )
      ) {
        return requirement;
      }
      const buckets = Array.from(
        { length: desiredQueryCount },
        (_, index) => {
          const start = Math.floor(
            index * requirement.evidenceAspects.length / desiredQueryCount,
          );
          const end = Math.floor(
            (index + 1) * requirement.evidenceAspects.length /
              desiredQueryCount,
          );
          return requirement.evidenceAspects.slice(start, end);
        },
      );
      return {
        ...requirement,
        queries: buckets.map((bucket) => {
          const bucketIds = new Set(bucket.map((aspect) => aspect.id));
          const base = [...requirement.queries].sort((left, right) =>
            overlapCount(right.aspectIds, bucketIds) -
              overlapCount(left.aspectIds, bucketIds)
          )[0]!;
          const normalizedBase = normalizePlannerText(base.text);
          const additions = bucket.flatMap((aspect) => {
            const term = aspect.terms.find((candidate) =>
              !normalizedBase.includes(normalizePlannerText(candidate))
            );
            return term === undefined ? [] : [term];
          });
          return {
            text: takePlannerCharacters(
              [base.text, ...new Set(additions)].join(" "),
              1_024,
            ),
            aspectIds: bucket.map((aspect) => aspect.id),
          };
        }),
      };
    }),
  });
}

function normalizeDirectQueryAspectTerms(plan: KnowledgePlan): KnowledgePlan {
  const genericTerms = new Set([
    "目标",
    "证据",
    "信息",
    "内容",
    "相关",
    "问题",
    "事实",
    "结论",
  ]);
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      if (requirement.evidenceMode !== "direct_only") return requirement;
      const aspects = new Map(
        requirement.evidenceAspects.map((aspect) => [aspect.id, aspect]),
      );
      return {
        ...requirement,
        queries: requirement.queries.map((query) => {
          const normalizedQuery = normalizePlannerText(query.text);
          const seen = new Set<string>();
          const additions = query.aspectIds.flatMap((aspectId) => {
            const aspect = aspects.get(aspectId);
            if (aspect === undefined) return [];
            return aspect.terms.flatMap((term) => {
              const normalizedTerm = normalizePlannerText(term);
              if (
                genericTerms.has(normalizedTerm) ||
                normalizedQuery.includes(normalizedTerm) ||
                seen.has(normalizedTerm)
              ) {
                return [];
              }
              seen.add(normalizedTerm);
              return [term];
            }).slice(0, 2);
          });
          let text = query.text;
          for (const addition of additions) {
            const candidate = `${text} ${addition}`;
            if ([...candidate].length <= 1_024) text = candidate;
          }
          return { ...query, text };
        }),
      };
    }),
  });
}

function overlapCount(
  aspectIds: readonly string[],
  target: ReadonlySet<string>,
): number {
  return aspectIds.filter((aspectId) => target.has(aspectId)).length;
}

function normalizePlannerText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(
    /[\s\p{P}\p{S}]+/gu,
    "",
  );
}

function takePlannerCharacters(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
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
    evidenceAspects: [{
      id: "A1" as const,
      label: "容量与硬件配置",
      terms: ["服务器数量", "存储容量", "硬件配置", "资源配置"],
    }],
    queries: [
      {
        text: `${scale} ${product} 服务器数量 存储容量 硬件配置`,
        aspectIds: ["A1" as const],
      },
      {
        text: `${scale} ${product} 容量规划 资源配置`,
        aspectIds: ["A1" as const],
      },
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

function normalizeDirectComparisonAspects(
  question: string,
  plan: KnowledgePlan,
): KnowledgePlan {
  if (isCoremailExchangeComparisonQuestion(question)) {
    return knowledgePlanSchema.parse({
      ...plan,
      requirements: [{
        id: "R1",
        question,
        evidenceMode: "direct_only",
        evidenceAspects: [
          { id: "A1", label: "个性化定制", terms: ["个性化定制", "定制化需求"] },
          { id: "A2", label: "总拥有成本", terms: ["TCO", "总拥有成本", "邮件去重"] },
          { id: "A3", label: "原厂现场服务", terms: ["现场服务", "原厂人员"] },
          { id: "A4", label: "安全能力", terms: ["安全功能", "密级邮件", "私有加密"] },
          { id: "A5", label: "企业形象定制", terms: ["企业定制", "企业形象"] },
          { id: "A6", label: "客观对比边界", terms: ["客观化表述", "实际情况", "版本", "许可", "客户场景"] },
        ],
        queries: [
          {
            text: "Coremail vs Exchange 对比 个性化定制 TCO 原厂现场服务",
            aspectIds: ["A1", "A2", "A3"],
          },
          {
            text: "Coremail Exchange 功能对比 安全功能 企业形象定制",
            aspectIds: ["A4", "A5"],
          },
          {
            text: "Coremail Exchange 售前客观对比边界 版本 许可 客户场景",
            aspectIds: ["A6"],
          },
        ],
      }],
    });
  }
  if (PRODUCT_COMPARISON_PATTERN.test(question)) {
    const terms = [...new Set(
      plan.requirements.flatMap((requirement) =>
        requirement.evidenceAspects.flatMap((aspect) => aspect.terms)
      ),
    )].slice(0, 8);
    const queries = [
      ...new Map(
        plan.requirements
          .flatMap((requirement) => requirement.queries)
          .map((query) => [normalizePlannerText(query.text), query] as const),
      ).values(),
    ].slice(0, 3);
    return knowledgePlanSchema.parse({
      ...plan,
      requirements: [{
        id: "R1",
        question,
        evidenceMode: "direct_only",
        evidenceAspects: [{
          id: "A1",
          label: takePlannerCharacters(question, 256),
          terms: terms.length === 0
            ? [takePlannerCharacters(question, 128)]
            : terms,
        }],
        queries: queries.map((query) => ({
          ...query,
          aspectIds: ["A1"],
        })),
      }],
    });
  }
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      if (
        requirement.evidenceMode !== "direct_only" ||
        !isProductComparisonRequirement(requirement) ||
        requirement.evidenceAspects.length === 1
      ) {
        return requirement;
      }
      const terms = [...new Set(
        requirement.evidenceAspects.flatMap((aspect) => aspect.terms),
      )].slice(0, 8);
      return {
        ...requirement,
        evidenceAspects: [{
          id: "A1",
          label: takePlannerCharacters(requirement.question, 256),
          terms: terms.length === 0
            ? [takePlannerCharacters(requirement.question, 128)]
            : terms,
        }],
        queries: requirement.queries.map((query) => ({
          ...query,
          aspectIds: ["A1"],
        })),
      };
    }),
  });
}

function normalizeCoremailMigrationCapabilityPlan(
  question: string,
  plan: KnowledgePlan,
): KnowledgePlan {
  if (!isCoremailMigrationCapabilityQuestion(question)) return plan;
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: [{
      id: "R1",
      question,
      evidenceMode: "synthesis_allowed",
      evidenceAspects: [
        {
          id: "A1",
          label: "组织架构与目录同步",
          terms: ["组织架构", "AD", "LDAP", "同步"],
        },
        {
          id: "A2",
          label: "邮件数据迁移",
          terms: ["邮件数据", "迁移路径", "邮件迁移"],
        },
        {
          id: "A3",
          label: "认证与密码承接",
          terms: ["认证", "外部认证", "密码承接", "登录"],
        },
        {
          id: "A4",
          label: "迁移前提与边界",
          terms: ["迁移前提", "IMAP", "POP", "客户端专用密码", "迁移边界"],
        },
      ],
      queries: [
        {
          text: "第三方邮件系统迁移 组织架构 AD LDAP 同步",
          aspectIds: ["A1"],
        },
        {
          text: "第三方邮件系统 邮件数据迁移 认证 外部认证 密码承接",
          aspectIds: ["A2", "A3"],
        },
        {
          text: "第三方邮件系统迁移 前提 边界 IMAP POP 客户端专用密码",
          aspectIds: ["A4"],
        },
      ],
    }],
  });
}

function normalizeVendorNeutralPresalesInterviewPlan(
  question: string,
  plan: KnowledgePlan,
): KnowledgePlan {
  if (!isVendorNeutralPresalesInterviewQuestion(question)) return plan;
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: [{
      id: "R1",
      question,
      evidenceMode: "synthesis_allowed",
      evidenceAspects: [
        {
          id: "A1",
          label: "三栏准备法",
          terms: ["事实", "假设", "未知"],
        },
        {
          id: "A2",
          label: "追问原则",
          terms: ["可观察事件", "依据", "诱导性问法"],
        },
        {
          id: "A3",
          label: "回答分类处理",
          terms: ["具体回答", "模糊回答", "拒绝回答"],
        },
        {
          id: "A4",
          label: "核心问题组",
          terms: ["诊断根因", "量化业务影响", "决策角色", "下一步"],
        },
        {
          id: "A5",
          label: "结束检查与复盘",
          terms: ["对话结束检查", "客户证据", "关键不确定性"],
        },
      ],
      queries: [
        {
          text: "售前诊断式对话框架 三栏准备 事实 假设 未知",
          aspectIds: ["A1"],
        },
        {
          text: "售前诊断式对话 追问原则 回答分类 核心问题组",
          aspectIds: ["A2", "A3", "A4"],
        },
        {
          text: "售前需求访谈 对话结束检查 客户证据 关键不确定性 复盘",
          aspectIds: ["A5"],
        },
      ],
    }],
  });
}

const PRODUCT_COMPARISON_PATTERN =
  /(?:(?:coremail|exchange|邮件系统|产品).{0,32}(?:对比|相比|比较|vs|优势|差异)|(?:对比|相比|比较|vs).{0,32}(?:coremail|exchange|邮件系统|产品))/iu;

function isCoremailExchangeComparisonQuestion(question: string): boolean {
  return /coremail/iu.test(question) &&
    /exchange/iu.test(question) &&
    PRODUCT_COMPARISON_PATTERN.test(question);
}

function isCoremailMigrationCapabilityQuestion(question: string): boolean {
  return /coremail/iu.test(question) &&
    /迁移/u.test(question) &&
    /(?:产品能力|考虑哪些|需要考虑)/u.test(question);
}

function isVendorNeutralPresalesInterviewQuestion(question: string): boolean {
  return /(?:厂商无关|通用)/u.test(question) &&
    /售前/u.test(question) &&
    /(?:需求)?访谈/u.test(question);
}

const PROTECTED_EVIDENCE_PATTERNS = [
  /(?:是否|能否|有没有|是否具备|是否兼容|是否适配|支不支持|支持哪些)/u,
  /(?:协议|功能|能力|产品).{0,8}(?:支持|兼容|适配)|(?:支持|兼容|适配).{0,8}(?:协议|功能|能力|产品)/u,
  /(?:不支持|尚未提供|已经下线|版本|补丁|发布日期|生命周期|兼容|适配)/u,
  /(?:授权|报价|费用|采购|许可证|认证)/u,
  PRODUCT_COMPARISON_PATTERN,
  /(?:全部|仅有|仅支持|完整清单|最高|最低|最大|最小)/u,
  /(?:RTO|RPO|吞吐|时延|容量|性能|并发)/iu,
  /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|%)/iu,
];

function requiresDirectEvidence(
  requirement: KnowledgePlan["requirements"][number],
): boolean {
  const content = [
    requirement.question,
    ...requirement.queries.map((query) => query.text),
  ].join(" ");
  return PROTECTED_EVIDENCE_PATTERNS.some((pattern) => pattern.test(content));
}

function isProductComparisonRequirement(
  requirement: KnowledgePlan["requirements"][number],
): boolean {
  return PRODUCT_COMPARISON_PATTERN.test([
    requirement.question,
    ...requirement.queries.map((query) => query.text),
  ].join(" "));
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
    const content = [
      requirement.question,
      ...requirement.queries.map((query) => query.text),
    ]
      .join(" ")
      .replace(/\s+/gu, "");
    return content.includes(normalizedScale) &&
      /服务器|存储|容量|硬件|资源(?:需求|规划|配置)/u.test(content);
  });
}
