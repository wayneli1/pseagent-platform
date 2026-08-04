import { z } from "zod";
import type { KnowledgePlan, Scope } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { analyzeObligationSource } from "./obligation-semantics.js";
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
export const taskEvidenceConditionSchema = z.object({
  inputState: z.enum(["not_applicable", "available", "missing"]),
  ambiguous: z.boolean(),
  conflictDetected: z.boolean(),
  freshness: z.enum(["not_assessed", "current", "stale_or_unconfirmed"]),
}).strict();
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

const answerObligationSchema = z.preprocess((value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  const obligation = value as Record<string, unknown>;
  if (obligation.evidenceCondition !== undefined) return value;
  return {
    ...obligation,
    evidenceCondition: defaultTaskEvidenceCondition(
      obligation.evidencePolicy === "customer_input",
    ),
  };
}, z.object({
  id: z.string().regex(/^O[1-9]\d*$/u),
  label: z.string().trim().min(1).max(256),
  targetEntityIds: z.array(z.string().regex(/^E[1-9]\d*$/u)).max(16),
  evidencePolicy: taskEvidencePolicySchema,
  evidenceCondition: taskEvidenceConditionSchema.optional(),
  domains: z.array(knowledgeDomainSchema).min(1).max(2),
  required: z.boolean(),
  sourceText: z.string().trim().min(1).max(512),
}).strict().superRefine((obligation, context) => {
  const condition = obligation.evidenceCondition;
  if (condition === undefined) return;
  if (
    obligation.evidencePolicy === "customer_input" &&
    condition.inputState === "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceCondition", "inputState"],
      message: "customer_input_requires_input_state",
    });
  }
  if (
    obligation.evidencePolicy !== "customer_input" &&
    condition.inputState !== "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceCondition", "inputState"],
      message: "non_customer_input_requires_not_applicable",
    });
  }
}));

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
export type TaskEvidenceCondition = z.infer<typeof taskEvidenceConditionSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export function taskEvidenceConditionFor(obligation: {
  readonly evidencePolicy: z.infer<typeof taskEvidencePolicySchema>;
  readonly evidenceCondition?: TaskEvidenceCondition | undefined;
}): TaskEvidenceCondition {
  return obligation.evidenceCondition ?? defaultTaskEvidenceCondition(
    obligation.evidencePolicy === "customer_input",
  );
}

function defaultTaskEvidenceCondition(customerInput: boolean): TaskEvidenceCondition {
  return {
    inputState: customerInput ? "missing" : "not_applicable",
    ambiguous: false,
    conflictDetected: false,
    freshness: "not_assessed",
  };
}

const TASK_EVIDENCE_CONDITION_PROMPT = `每个 obligation 必须输出 evidenceCondition：
依赖本次客户事实的 customer_input，只有用户已经明确提供足够的当次事实时 inputState 才能是 available，否则必须是 missing；其他 evidencePolicy 的 inputState 必须是 not_applicable。
customer_input 只表示要形成当前个案的判断或预测；“需要收集哪些信息”“如何评估”“如何推进”等可由正式知识回答的方法、清单和建议必须使用 synthesis。一个问题同时要求个案结论与方法建议时，必须拆成互不替代的 customer_input 与 synthesis obligations。
ambiguous、conflictDetected 和 freshness 只按当前用户输入中明确出现的信息判断，不得猜测。不得因缺少客户输入而省略知识库可回答的方法、步骤或建议。`;

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
      {
        role: "system" as const,
        content: `${TASK_SPEC_SYSTEM_PROMPT}\n${TASK_EVIDENCE_CONDITION_PROMPT}`,
      },
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
  | "distributive_entity_group_unresolved"
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
  readonly unresolvedDistributiveGroups: readonly string[];
  readonly requestClauses: readonly string[];
}

export function extractExplicitQuestionSignals(
  question: string,
  options: { readonly anchoredEntitySourceTexts?: readonly string[] } = {},
): ExplicitQuestionSignals {
  const entityGroups: Array<{ sourceText: string; items: string[] }> = [];
  const unresolvedDistributiveGroups: string[] = [];
  const listPattern = /(?:参考(?:看看|一下)?|(?:分别|各自)?(?:对比|比较|说明|介绍|分析))(?<list>[\p{L}\p{N}A-Za-z·（）()、，,\s和与及.]{2,160}?)(?=(?:各自)?的|各自|分别|方案|案例|架构|差异|区别|$)/giu;
  for (const match of question.matchAll(listPattern)) {
    const sourceText = match.groups?.list?.trim();
    if (!sourceText) continue;
    const items = parallelEntityItems(sourceText, false);
    if (items.length >= 2) entityGroups.push({ sourceText, items: [...items] });
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
    const distribution = distributiveEntityItems(
      sourceText,
      options.anchoredEntitySourceTexts,
    );
    const items = distribution.items;
    if (items.length >= 2) entityGroups.push({ sourceText, items: [...items] });
    else if (distribution.unresolved) unresolvedDistributiveGroups.push(sourceText);
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
    unresolvedDistributiveGroups: stableUniqueText(unresolvedDistributiveGroups),
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

function parallelEntityItems(
  sourceText: string,
  allowConjoinedEntities: boolean,
): string[] {
  const strongSeparated = sourceText.split(/(?:、|，|,)/u);
  return (strongSeparated.length > 1 || !allowConjoinedEntities
    ? strongSeparated
    : strongSeparated.flatMap(splitConjoinedEntitySegment))
    .map(cleanExplicitEntity)
    .filter((item) => isPlausibleExplicitEntity(item));
}

function distributiveEntityItems(
  sourceText: string,
  anchoredEntitySourceTexts: readonly string[] | undefined,
): { readonly items: readonly string[]; readonly unresolved: boolean } {
  const strongSeparated = sourceText.split(/(?:、|，|,)/u);
  if (strongSeparated.length > 1) {
    const items = strongSeparated.map(cleanExplicitEntity).filter(isPlausibleExplicitEntity);
    if (items.length < 2) return { items, unresolved: true };
    if (anchoredEntitySourceTexts === undefined) return { items, unresolved: false };
    const anchors = anchoredEntitySourceTexts.map((anchor) => anchor.trim());
    const isFullyAnchored = items.every((item) =>
      anchors.filter((anchor) => sameSemanticText(anchor, item)).length === 1);
    return { items: isFullyAnchored ? items : [], unresolved: !isFullyAnchored };
  }
  if (anchoredEntitySourceTexts === undefined) {
    return { items: parallelEntityItems(sourceText, true), unresolved: false };
  }

  const foldedSourceText = sourceText.toLocaleLowerCase("zh-CN");
  const anchoredCandidates = anchoredEntitySourceTexts
    .filter((candidate) => isPlausibleExplicitEntity(candidate))
    .map((candidate) => candidate.trim())
    .filter((candidate) => foldedSourceText.includes(candidate.toLocaleLowerCase("zh-CN")));
  const normalizedCandidates = anchoredCandidates.map(normalizeSemanticText);
  if (new Set(normalizedCandidates).size !== normalizedCandidates.length) {
    return { items: [], unresolved: true };
  }
  const candidates = anchoredCandidates
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const selected: Array<{ text: string; index: number }> = [];
  for (const candidate of candidates) {
    const index = foldedSourceText.indexOf(candidate.toLocaleLowerCase("zh-CN"));
    if (index < 0) continue;
    const end = index + candidate.length;
    if (selected.every((item) => end <= item.index || index >= item.index + item.text.length)) {
      selected.push({ text: candidate, index });
    }
  }
  selected.sort((left, right) => left.index - right.index);
  if (selected.length < 2) return { items: [], unresolved: true };
  const first = selected[0]!;
  const last = selected[selected.length - 1]!;
  if (
    sourceText.slice(0, first.index).trim() ||
    sourceText.slice(last.index + last.text.length).trim()
  ) {
    return { items: [], unresolved: true };
  }
  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1]!;
    const next = selected[index]!;
    const between = sourceText.slice(previous.index + previous.text.length, next.index);
    if (!/^\s*(?:和|与|及|vs\.?)\s*$/iu.test(between)) {
      return { items: [], unresolved: true };
    }
  }
  return { items: selected.map((item) => item.text), unresolved: false };
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
        if (requiresDirectEvidence(obligation)) {
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

    const signals = extractExplicitQuestionSignals(question, {
      anchoredEntitySourceTexts: spec.entities.map((entity) => entity.sourceText),
    });
    for (const sourceText of signals.unresolvedDistributiveGroups) {
      issues.push({
        code: "distributive_entity_group_unresolved",
        severity: "error",
      });
    }
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

function requiresDirectEvidence(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): boolean {
  if (obligation.evidencePolicy === "direct") return false;
  const sourceText = obligation.sourceText;
  const analysis = analyzeObligationSource(sourceText);
  if (
    obligation.evidencePolicy === "customer_input" && analysis.customerInputEligible
  ) {
    return false;
  }
  return analysis.requiresDirectEvidence;
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
