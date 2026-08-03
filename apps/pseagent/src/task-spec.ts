import { z } from "zod";
import type { KnowledgePlan, Scope } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import type { ResolvedQuestion } from "./question-resolver.js";

export const knowledgeDomainSchema = z.enum([
  "coremail-professional",
  "presales-general",
]);
export const deliverableKindSchema = z.enum([
  "fact",
  "comparison",
  "diagnosis",
  "recommendation",
  "procedure",
  "risk_assessment",
]);
export const taskEvidencePolicySchema = z.enum([
  "direct",
  "synthesis",
  "customer_input",
]);
export const taskEntityRoleSchema = z.enum([
  "subject",
  "target",
  "reference",
  "competitor",
  "product",
  "unknown",
]);

const taskEntitySchema = z.object({
  id: z.string().regex(/^E[1-9]\d*$/u),
  label: z.string().trim().min(1).max(128),
  role: taskEntityRoleSchema,
  sourceText: z.string().trim().min(1).max(256),
}).strict();

const answerObligationSchema = z.object({
  id: z.string().regex(/^O[1-9]\d*$/u),
  label: z.string().trim().min(1).max(256),
  targetEntityIds: z.array(z.string().regex(/^E[1-9]\d*$/u)).max(16),
  evidencePolicy: taskEvidencePolicySchema,
  domains: z.array(knowledgeDomainSchema).min(1).max(2),
  required: z.boolean(),
  sourceText: z.string().trim().min(1).max(512),
}).strict();

const taskDeliverableSchema = z.object({
  id: z.string().regex(/^D[1-9]\d*$/u),
  label: z.string().trim().min(1).max(256),
  kind: deliverableKindSchema,
  required: z.boolean(),
  sourceText: z.string().trim().min(1).max(512),
  obligations: z.array(answerObligationSchema).min(1).max(16),
}).strict();

export const taskSpecSchema = z.object({
  subject: z.string().trim().min(1).max(1_024),
  entities: z.array(taskEntitySchema).min(1).max(32),
  deliverables: z.array(taskDeliverableSchema).min(1).max(12),
}).strict().superRefine((spec, context) => {
  validateSequentialIds(spec.entities.map((item) => item.id), "E", ["entities"], context);
  validateSequentialIds(
    spec.deliverables.map((item) => item.id),
    "D",
    ["deliverables"],
    context,
  );
  const obligations = spec.deliverables.flatMap((item) => item.obligations);
  validateSequentialIds(obligations.map((item) => item.id), "O", ["deliverables"], context);

  const entityIds = new Set(spec.entities.map((item) => item.id));
  spec.deliverables.forEach((deliverable, deliverableIndex) => {
    if (
      deliverable.required &&
      !deliverable.obligations.some((obligation) => obligation.required)
    ) {
      context.addIssue({
        code: "custom",
        path: ["deliverables", deliverableIndex, "obligations"],
        message: "required_deliverable_requires_obligation",
      });
    }
    deliverable.obligations.forEach((obligation, obligationIndex) => {
      if (new Set(obligation.targetEntityIds).size !== obligation.targetEntityIds.length) {
        context.addIssue({
          code: "custom",
          path: ["deliverables", deliverableIndex, "obligations", obligationIndex, "targetEntityIds"],
          message: "duplicate_target_entity_ids",
        });
      }
      obligation.targetEntityIds.forEach((entityId, entityIndex) => {
        if (!entityIds.has(entityId)) {
          context.addIssue({
            code: "custom",
            path: ["deliverables", deliverableIndex, "obligations", obligationIndex, "targetEntityIds", entityIndex],
            message: "unknown_target_entity_id",
          });
        }
      });
      if (new Set(obligation.domains).size !== obligation.domains.length) {
        context.addIssue({
          code: "custom",
          path: ["deliverables", deliverableIndex, "obligations", obligationIndex, "domains"],
          message: "duplicate_knowledge_domains",
        });
      }
      if (
        obligation.evidencePolicy === "customer_input" &&
        !obligation.domains.includes("presales-general")
      ) {
        context.addIssue({
          code: "custom",
          path: ["deliverables", deliverableIndex, "obligations", obligationIndex, "domains"],
          message: "customer_input_requires_presales_domain",
        });
      }
    });
  });
});

export type KnowledgeDomain = z.infer<typeof knowledgeDomainSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export interface TaskCompilerInput {
  readonly resolvedQuestion: ResolvedQuestion;
  readonly scopeHint: Exclude<Scope, "normal">;
  readonly legacyPlan: KnowledgePlan;
  readonly knowledgeContext: {
    readonly purpose: string;
    readonly schema: string;
    readonly planningOverview: string;
  };
  readonly signal?: AbortSignal;
}

export interface TaskCompiler {
  compile(input: TaskCompilerInput): Promise<TaskSpec>;
}

export const TASK_SPEC_SYSTEM_PROMPT = `你是 PSEAgent 的任务契约编译器，只输出一个 JSON 对象。
输出必须符合 TaskSpec：subject、entities、deliverables；每个 deliverable 包含 obligations。
实体按 E1、E2 连续编号，交付项按 D1、D2 连续编号，所有 obligation 跨交付项按 O1、O2 连续编号。
entities 的 role 只能是 subject、target、reference、competitor、product、unknown。
deliverable kind 只能是 fact、comparison、diagnosis、recommendation、procedure、risk_assessment。
obligation evidencePolicy 只能是 direct、synthesis、customer_input；domains 只能是 coremail-professional、presales-general。
保留用户明确点名的全部并列对象、互不替代的全部交付目标和约束；每个明确对象必须有独立的必答 obligation，不能被另一个对象替代。
数字、版本、功能、存在性、支持性、兼容性、授权、认证和穷举结论必须使用 direct。
诊断与建议可以使用 synthesis；依赖当前客户事实才能判断的内容使用 customer_input，并归入 presales-general。
sourceText 必须逐字复制 standaloneQuestion 中能够追溯该实体、交付项或 obligation 的最短片段。
planningOverview 只能用于识别知识域和术语，不是事实证据。
不得套用历史测试问题的固定维度，不得写具体客户专用规则，不生成查询、答案、引用、页面路径或解释。
禁止输出 Markdown 或额外字段。`;

export class ModelTaskCompiler implements TaskCompiler {
  constructor(private readonly model: ModelClient) {}

  async compile(input: TaskCompilerInput): Promise<TaskSpec> {
    const messages = [
      { role: "system" as const, content: TASK_SPEC_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: JSON.stringify({
          resolvedQuestion: input.resolvedQuestion,
          scopeHint: input.scopeHint,
          legacyPlan: input.legacyPlan,
          knowledgePurpose: input.knowledgeContext.purpose,
          knowledgeSchema: input.knowledgeContext.schema,
          planningOverview: input.knowledgeContext.planningOverview,
        }),
      },
    ];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.model.completeJson({
          messages: attempt === 1
            ? messages
            : [
                ...messages,
                {
                  role: "user" as const,
                  content: "上一次输出不符合 TaskSpec Schema。只重新输出合法 TaskSpec JSON，不要解释。",
                },
              ],
          schema: taskSpecSchema,
          schemaDescription: "pse_task_spec",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (!(error instanceof InvalidModelPayloadError) || attempt === 3) throw error;
      }
    }
    throw new InvalidModelPayloadError(
      "invalid_task_spec_after_repair",
      undefined,
      "pse_task_spec",
    );
  }
}

export type TaskSpecIssueCode =
  | "entity_source_not_found"
  | "deliverable_source_not_found"
  | "obligation_source_not_found"
  | "explicit_entity_unmapped"
  | "explicit_entity_without_required_obligation"
  | "explicit_request_unmapped"
  | "protected_fact_not_direct"
  | "domain_policy_conflict";

export interface TaskSpecGuardIssue {
  readonly code: TaskSpecIssueCode;
  readonly severity: "error" | "warning";
  readonly entityId?: string;
  readonly deliverableId?: string;
  readonly obligationId?: string;
}

export interface TaskSpecGuardResult {
  readonly ok: boolean;
  readonly issues: readonly TaskSpecGuardIssue[];
  readonly explicitEntityCount: number;
  readonly mappedExplicitEntityCount: number;
  readonly explicitRequestCount: number;
  readonly mappedExplicitRequestCount: number;
}

export interface TaskSpecGuard {
  validate(input: {
    readonly resolvedQuestion: ResolvedQuestion;
    readonly taskSpec: TaskSpec;
  }): TaskSpecGuardResult;
}

export interface ExplicitQuestionSignals {
  readonly entityGroups: readonly {
    readonly sourceText: string;
    readonly items: readonly string[];
  }[];
  readonly requestClauses: readonly string[];
}

export function extractExplicitQuestionSignals(question: string): ExplicitQuestionSignals {
  const entityGroups: Array<{ sourceText: string; items: string[] }> = [];
  const listPattern = /(?:参考(?:看看|一下)?|(?:分别|各自)?(?:对比|比较|说明|介绍|分析))(?<list>[\p{L}\p{N}A-Za-z·（）()、，,\s和与及.]{2,160}?)(?=(?:各自)?的|各自|分别|方案|案例|架构|差异|区别|$)/giu;
  for (const match of question.matchAll(listPattern)) {
    const sourceText = match.groups?.list?.trim();
    if (!sourceText) continue;
    const items = parallelEntityItems(sourceText);
    if (items.length >= 2) entityGroups.push({ sourceText, items });
  }
  const comparisonPattern = /(?<left>[\p{L}\p{N}·（）()._-]{2,64}?)\s*(?:vs\.?|versus|与|和)\s*(?<right>[\p{L}\p{N}·（）()._-]{2,64}?)(?=\s*(?:的)?(?:差异|区别|对比|比较))/giu;
  for (const match of question.matchAll(comparisonPattern)) {
    const items = [match.groups?.left ?? "", match.groups?.right ?? ""]
      .map(cleanExplicitEntity)
      .filter((item) => isPlausibleExplicitEntity(item));
    if (items.length === 2) {
      entityGroups.push({
        sourceText: match[0],
        items,
      });
    }
  }
  const distributiveParallelListPattern =
    /(?:^|[，,；;。！？!?])\s*(?<list>[\p{L}\p{N}A-Za-z·（）()、，,\s和与及.]{2,160}?)\s*(?=(?:各自|分别|逐一|逐个))/gu;
  for (const match of question.matchAll(distributiveParallelListPattern)) {
    const sourceText = match.groups?.list?.trim();
    if (!sourceText) continue;
    const items = parallelEntityItems(sourceText);
    if (items.length >= 2) entityGroups.push({ sourceText, items });
  }

  const requestClauses: string[] = [];
  for (const rawSegment of question.split(/[，,；;。！？!?]+/u)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const boundaries = requestClauseBoundaries(segment);
    if (boundaries.length === 0) continue;
    const starts = [0, ...boundaries.slice(1)];
    for (let index = 0; index < starts.length; index += 1) {
      const next = starts[index + 1] ?? segment.length;
      const clause = cleanRequestClause(segment.slice(starts[index], next));
      if (clause) requestClauses.push(clause);
    }
  }
  return {
    entityGroups,
    requestClauses: stableUniqueText(requestClauses),
  };
}

const REQUEST_INTERROGATIVE_PATTERN =
  /(?:如何|怎样|为什么|哪些|多少|是否|能否|有没有|是什么|怎么办|怎么做|怎么提升|如何提升)/gu;
const REQUEST_ACTION_PATTERN =
  /(?:^|请|帮我|需要|还要|以及|同时|然后|并且|并|再|且|要)\s*(?:分析|评估|介绍|说明|列出|总结|建议|推荐|给出|制定|设计|判断|排查)/gu;

function requestClauseBoundaries(segment: string): number[] {
  const positions = [
    ...[...segment.matchAll(REQUEST_INTERROGATIVE_PATTERN)]
      .map((match) => match.index),
    ...[...segment.matchAll(REQUEST_ACTION_PATTERN)]
      .map((match) => match.index),
  ].sort((left, right) => left - right);
  return positions.filter((position, index) =>
    index === 0 || position !== positions[index - 1]);
}

function cleanRequestClause(value: string): string {
  return value
    .replace(/^\s*(?:并且|并|以及|同时|然后|再|且|还要)\s*/u, "")
    .replace(/\s*(?:并且|并|以及|同时|然后|再|且|还要)\s*$/u, "")
    .trim();
}

function cleanExplicitEntity(value: string): string {
  return value
    .trim()
    .replace(/^(?:请|分别|各自)*(?:分析|评估|介绍|说明|对比|比较)?/u, "")
    .replace(/(?:各自|分别)$/u, "")
    .trim();
}

function parallelEntityItems(sourceText: string): string[] {
  return sourceText
    .split(/(?:、|，|,)/u)
    .flatMap(splitConjoinedEntitySegment)
    .map(cleanExplicitEntity)
    .filter((item) => isPlausibleExplicitEntity(item));
}

function splitConjoinedEntitySegment(segment: string): string[] {
  const parts = segment.split(/(?:\s*(?:和|与|及)\s*|\s+vs\.?\s*)/iu);
  return parts.length > 1 && parts.every((part) => [...part.trim()].length >= 2)
    ? parts
    : [segment];
}

export class DeterministicTaskSpecGuard implements TaskSpecGuard {
  validate(input: {
    readonly resolvedQuestion: ResolvedQuestion;
    readonly taskSpec: TaskSpec;
  }): TaskSpecGuardResult {
    const issues: TaskSpecGuardIssue[] = [];
    const question = input.resolvedQuestion.standaloneQuestion;
    const spec = input.taskSpec;
    const entitiesById = new Map(
      spec.entities.map((entity) => [entity.id, entity] as const),
    );

    for (const entity of spec.entities) {
      if (!containsSemanticText(question, entity.sourceText)) {
        issues.push({
          code: "entity_source_not_found",
          severity: "error",
          entityId: entity.id,
        });
      }
    }
    for (const deliverable of spec.deliverables) {
      if (!containsSemanticText(question, deliverable.sourceText)) {
        issues.push({
          code: "deliverable_source_not_found",
          severity: "error",
          deliverableId: deliverable.id,
        });
      }
      for (const obligation of deliverable.obligations) {
        if (!containsSemanticText(question, obligation.sourceText)) {
          issues.push({
            code: "obligation_source_not_found",
            severity: "error",
            deliverableId: deliverable.id,
            obligationId: obligation.id,
          });
        }
        const obligationText = `${obligation.label} ${obligation.sourceText}`;
        const targetEntities = obligation.targetEntityIds.flatMap((entityId) => {
          const entity = entitiesById.get(entityId);
          return entity === undefined ? [] : [entity];
        });
        if (requiresDirectEvidence(obligation, obligationText, targetEntities)) {
          issues.push({
            code: "protected_fact_not_direct",
            severity: "error",
            deliverableId: deliverable.id,
            obligationId: obligation.id,
          });
        }
        if (
          obligation.evidencePolicy === "customer_input" &&
          !obligation.domains.includes("presales-general")
        ) {
          issues.push({
            code: "domain_policy_conflict",
            severity: "error",
            deliverableId: deliverable.id,
            obligationId: obligation.id,
          });
        }
      }
    }

    const signals = extractExplicitQuestionSignals(question);
    const explicitEntities = stableUniqueText(
      signals.entityGroups.flatMap((group) => group.items),
    );
    let mappedExplicitEntityCount = 0;
    for (const explicitEntity of explicitEntities) {
      const entity = spec.entities.find((candidate) =>
        sameSemanticText(candidate.label, explicitEntity) ||
        sameSemanticText(candidate.sourceText, explicitEntity));
      if (entity === undefined) {
        issues.push({ code: "explicit_entity_unmapped", severity: "error" });
        continue;
      }
      const hasRequiredObligation = spec.deliverables.some((deliverable) =>
        deliverable.required && deliverable.obligations.some((obligation) =>
          obligation.required &&
          obligation.targetEntityIds.length === 1 &&
          obligation.targetEntityIds[0] === entity.id));
      if (!hasRequiredObligation) {
        issues.push({
          code: "explicit_entity_without_required_obligation",
          severity: "error",
          entityId: entity.id,
        });
      } else {
        mappedExplicitEntityCount += 1;
      }
    }

    let mappedExplicitRequestCount = 0;
    for (const clause of signals.requestClauses) {
      const mapped = spec.deliverables.some((deliverable) =>
        deliverable.required && (
          semanticOverlap(clause, deliverable.sourceText) ||
          deliverable.obligations.some((obligation) =>
            obligation.required && semanticOverlap(clause, obligation.sourceText))
        ));
      if (mapped) mappedExplicitRequestCount += 1;
      else issues.push({ code: "explicit_request_unmapped", severity: "error" });
    }

    return {
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      explicitEntityCount: explicitEntities.length,
      mappedExplicitEntityCount,
      explicitRequestCount: signals.requestClauses.length,
      mappedExplicitRequestCount,
    };
  }
}

const STRONG_PRODUCT_FACT_PATTERN =
  /(?:协议|兼容|适配|版本|补丁|授权|报价|费用|认证|完整清单|最高|最低|最大|最小|RTO|RPO|吞吐|时延|容量|性能|并发)/iu;

const CONTEXTUAL_PRODUCT_FACT_PATTERN = /(?:功能|能力)/u;

const PRODUCT_SUPPORT_FACT_PATTERN = /支持/iu;

const PRODUCT_FACT_CONTEXT_PATTERN =
  /(?:产品|系统|平台|协议|接口|服务|组件|模块|软件|应用|终端|环境|双活)/iu;

const PROTECTED_NUMERIC_FACT_PATTERN =
  /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|%)/iu;

const CUSTOMER_RELATIONSHIP_SUPPORT_PATTERN =
  /(?:客户支持|内部支持者|客户侧支持|业务支持者)/u;

const OPPORTUNITY_FORECAST_PATTERN =
  /(?:赢率|胜率|成交概率|成功概率|机会(?:质量|预测|判断)|销售预测|预测(?:结果|概率))/u;

function requiresDirectEvidence(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
  value: string,
  targetEntities: readonly TaskSpec["entities"][number][],
): boolean {
  if (obligation.evidencePolicy === "direct") return false;
  const customerRelationshipSupport =
    CUSTOMER_RELATIONSHIP_SUPPORT_PATTERN.test(value);
  const productFactContext =
    targetEntities.some((entity) => entity.role === "product") ||
    PRODUCT_FACT_CONTEXT_PATTERN.test(value);
  if (
    STRONG_PRODUCT_FACT_PATTERN.test(value) ||
    (productFactContext && CONTEXTUAL_PRODUCT_FACT_PATTERN.test(value)) ||
    (
      productFactContext &&
      PRODUCT_SUPPORT_FACT_PATTERN.test(value) &&
      !customerRelationshipSupport
    )
  ) {
    return true;
  }
  return PROTECTED_NUMERIC_FACT_PATTERN.test(value) &&
    !isCustomerInputOpportunityForecast(obligation, value);
}

function isCustomerInputOpportunityForecast(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
  value: string,
): boolean {
  return obligation.evidencePolicy === "customer_input" &&
    OPPORTUNITY_FORECAST_PATTERN.test(value) &&
    /\d+(?:\.\d+)?\s*%/u.test(value);
}

function validateSequentialIds(
  ids: readonly string[],
  prefix: "E" | "D" | "O",
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: [...path], message: `duplicate_${prefix}_ids` });
  }
  ids.forEach((id, index) => {
    if (id !== `${prefix}${index + 1}`) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "id"],
        message: `${prefix}_ids_must_be_sequential`,
      });
    }
  });
}

function isPlausibleExplicitEntity(value: string): boolean {
  return value.length >= 2 &&
    value.length <= 64 &&
    !/(?:如何|怎样|为什么|哪些|多少|是否|能否|方案|案例|架构)/u.test(value);
}

function normalizeSemanticText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function containsSemanticText(container: string, part: string): boolean {
  const normalizedPart = normalizeSemanticText(part);
  return normalizedPart.length > 0 &&
    normalizeSemanticText(container).includes(normalizedPart);
}

function sameSemanticText(left: string, right: string): boolean {
  return normalizeSemanticText(left) === normalizeSemanticText(right);
}

function semanticOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeSemanticText(left);
  const normalizedRight = normalizeSemanticText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }
  const leftBigrams = bigrams(normalizedLeft);
  const rightBigrams = bigrams(normalizedRight);
  const intersection = [...leftBigrams].filter((item) => rightBigrams.has(item)).length;
  return intersection >= 2 &&
    intersection / Math.min(leftBigrams.size, rightBigrams.size) >= 0.5;
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set([value]);
  return new Set([...value].slice(0, -1).map((character, index) =>
    `${character}${[...value][index + 1] ?? ""}`));
}

function stableUniqueText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeSemanticText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
