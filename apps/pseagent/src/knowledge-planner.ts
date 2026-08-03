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
            pruneUnrequestedDirectNeighborAspects(
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

const DIRECT_NEIGHBOR_INTENT_GROUPS = [
  {
    aspect: /(?:客户(?!端)|项目|案例|实例)/u,
    question: /(?:客户(?!端)|项目|案例|实例)/u,
  },
  {
    aspect: /(?:部署|安装|启用|使用方式)/u,
    question: /(?:部署|安装|启用|使用方式)/u,
  },
  {
    aspect: /(?:安全|反垃圾|防护|合规|审计)/u,
    question: /(?:安全|反垃圾|防护|合规|审计)/u,
  },
  {
    aspect: /(?:对接|集成|认证|同步)/u,
    question: /(?:对接|集成|认证|同步)/u,
  },
  {
    aspect: /(?:迁移|升级)/u,
    question: /(?:迁移|升级)/u,
  },
  {
    aspect: /(?:版本|授权|价格|报价|费用|资质|许可证|认证证书)/u,
    question: /(?:版本|授权|价格|报价|费用|资质|许可证|认证证书)/u,
  },
] as const;

function pruneUnrequestedDirectNeighborAspects(
  question: string,
  plan: KnowledgePlan,
): KnowledgePlan {
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      if (
        requirement.evidenceMode !== "direct_only" ||
        requirement.evidenceAspects.length <= 1
      ) {
        return requirement;
      }
      const retainedAspects = requirement.evidenceAspects.filter((aspect) => {
        const aspectText = [aspect.label, ...aspect.terms].join(" ");
        return !DIRECT_NEIGHBOR_INTENT_GROUPS.some((group) =>
          group.aspect.test(aspectText) && !group.question.test(question)
        );
      });
      if (
        retainedAspects.length === 0 ||
        retainedAspects.length === requirement.evidenceAspects.length
      ) {
        return requirement;
      }

      const aspectIdMap = new Map(
        retainedAspects.map((aspect, index) => [
          aspect.id,
          `A${index + 1}` as KnowledgePlan["requirements"][number]["evidenceAspects"][number]["id"],
        ]),
      );
      const retainedTermKeys = new Set(
        retainedAspects.flatMap((aspect) =>
          aspect.terms.map((term) => normalizePlannerText(term))
        ),
      );
      const removedTerms = requirement.evidenceAspects
        .filter((aspect) => !aspectIdMap.has(aspect.id))
        .flatMap((aspect) => aspect.terms)
        .filter((term) => !retainedTermKeys.has(normalizePlannerText(term)));
      const queryMap = new Map<
        string,
        { text: string; aspectIds: Set<string> }
      >();
      for (const query of requirement.queries) {
        const mappedIds = query.aspectIds.flatMap((aspectId) => {
          const mapped = aspectIdMap.get(aspectId);
          return mapped === undefined ? [] : [mapped];
        });
        if (mappedIds.length === 0) continue;
        const text = removeExactPlannerTerms(query.text, removedTerms) ||
          requirement.question;
        const normalized = normalizePlannerText(text);
        const entry = queryMap.get(normalized) ?? {
          text,
          aspectIds: new Set<string>(),
        };
        for (const aspectId of mappedIds) entry.aspectIds.add(aspectId);
        queryMap.set(normalized, entry);
      }
      const retainedIds = [...aspectIdMap.values()];
      const queries = [...queryMap.values()].map((query) => ({
        text: query.text,
        aspectIds: [...query.aspectIds],
      }));
      if (queries.length === 0) {
        queries.push({
          text: requirement.question,
          aspectIds: retainedIds,
        });
      } else {
        const coveredIds = new Set(
          queries.flatMap((query) => query.aspectIds),
        );
        queries[0] = {
          ...queries[0]!,
          aspectIds: [
            ...queries[0]!.aspectIds,
            ...retainedIds.filter((aspectId) => !coveredIds.has(aspectId)),
          ],
        };
      }
      return {
        ...requirement,
        evidenceAspects: retainedAspects.map((aspect, index) => ({
          ...aspect,
          id: `A${index + 1}`,
        })),
        queries,
      };
    }),
  });
}

function removeExactPlannerTerms(
  value: string,
  terms: readonly string[],
): string {
  return [...terms]
    .sort((left, right) => [...right].length - [...left].length)
    .reduce(
      (text, term) => text.replace(
        new RegExp(escapeRegExp(term), "giu"),
        " ",
      ),
      value,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeDirectComparisonAspects(
  question: string,
  plan: KnowledgePlan,
): KnowledgePlan {
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

const PRODUCT_COMPARISON_PATTERN =
  /(?:(?:coremail|exchange|邮件系统|产品).{0,32}(?:对比|相比|比较|vs|优势|差异)|(?:对比|相比|比较|vs).{0,32}(?:coremail|exchange|邮件系统|产品))/iu;

const PROTECTED_EVIDENCE_PATTERNS = [
  /(?:是否|能否|有没有|是否具备|是否兼容|是否适配|支不支持|支持哪些)/u,
  /(?:协议|功能|能力|产品).{0,8}(?:支持|兼容|适配)|(?:支持|兼容|适配).{0,8}(?:协议|功能|能力|产品)/u,
  /(?:(?:功能|能力|特性).{0,8}(?:有哪些|有什么|能做什么)|(?:有哪些|有什么).{0,8}(?:功能|能力|特性)|能做什么|(?:功能|能力|特性)(?:列表|清单)|(?:列出|罗列).{0,16}(?:功能|能力|特性))/u,
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
