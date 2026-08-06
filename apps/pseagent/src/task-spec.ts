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

const strictTaskSpecSchema = z.object({
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

export const taskSpecSchema = z.preprocess(
  normalizeModelTaskSpecStructure,
  strictTaskSpecSchema,
);

export type KnowledgeDomain = z.infer<typeof knowledgeDomainSchema>;
export type TaskEvidenceCondition = z.infer<typeof taskEvidenceConditionSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;

function normalizeModelTaskSpecStructure(value: unknown): unknown {
  if (!isUnknownRecord(value)) return value;
  const fallbackSourceText = firstNestedSourceText(value.deliverables);
  const entities = Array.isArray(value.entities)
    ? value.entities.map((rawEntity) => {
        if (!isUnknownRecord(rawEntity)) return rawEntity;
        let normalized = moveCompatibleAlias(rawEntity, "label", "name");
        if (normalized.sourceText === undefined && fallbackSourceText !== undefined) {
          normalized = { ...normalized, sourceText: fallbackSourceText };
        }
        if (normalized.label === undefined) {
          const label = boundedSourceLabel(normalized.sourceText);
          if (label !== undefined) normalized = { ...normalized, label };
        }
        return normalized;
      })
    : value.entities;
  const deliverables = Array.isArray(value.deliverables)
    ? value.deliverables.map((rawDeliverable) => {
        if (!isUnknownRecord(rawDeliverable)) return rawDeliverable;
        const withLabel = moveCompatibleAlias(
          moveCompatibleAlias(
            moveCompatibleAlias(rawDeliverable, "label", "name"),
            "label",
            "title",
          ),
          "label",
          "description",
        );
        const deliverableEntityIds = stringArray(withLabel.entities);
        const obligations = Array.isArray(withLabel.obligations)
          ? withLabel.obligations.map((rawObligation) => {
              if (!isUnknownRecord(rawObligation)) return rawObligation;
              let normalized = moveCompatibleAlias(
                moveCompatibleAlias(
                  moveCompatibleAlias(rawObligation, "label", "name"),
                  "label",
                  "title",
                ),
                "label",
                "description",
              );
              normalized = moveCompatibleAlias(
                normalized,
                "targetEntityIds",
                "entities",
              );
              normalized = moveCompatibleAlias(
                moveCompatibleAlias(
                  normalized,
                  "targetEntityIds",
                  "targetEntityId",
                ),
                "targetEntityIds",
                "entity",
              );
              if (
                normalized.targetEntityIds === undefined &&
                deliverableEntityIds !== undefined
              ) {
                normalized = {
                  ...normalized,
                  targetEntityIds: deliverableEntityIds,
                };
              }
              if (typeof normalized.targetEntityIds === "string") {
                normalized = {
                  ...normalized,
                  targetEntityIds: [normalized.targetEntityIds],
                };
              }
              if (normalized.targetEntityIds === undefined) {
                normalized = { ...normalized, targetEntityIds: [] };
              }
              if (isUnknownRecord(normalized.evidenceCondition)) {
                const condition = normalized.evidenceCondition;
                if ([
                  "unknown",
                  "not_applicable",
                  "not_specified",
                ].includes(String(condition.freshness))) {
                  normalized = {
                    ...normalized,
                    evidenceCondition: {
                      ...condition,
                      freshness: "not_assessed",
                    },
                  };
                }
              }
              if (normalized.required === undefined) {
                normalized = { ...normalized, required: true };
              }
              if (normalized.label === undefined) {
                const label = boundedSourceLabel(normalized.sourceText);
                if (label !== undefined) normalized = { ...normalized, label };
              }
              return normalized;
            })
          : withLabel.obligations;
        const firstSourceText = Array.isArray(obligations)
          ? obligations.find((item) =>
              isUnknownRecord(item) && typeof item.sourceText === "string")
          : undefined;
        const {
          entities: _entities,
          ...withoutDeliverableEntities
        } = withLabel;
        const sourceText = withoutDeliverableEntities.sourceText === undefined &&
            isUnknownRecord(firstSourceText)
          ? firstSourceText.sourceText
          : withoutDeliverableEntities.sourceText;
        const label = withoutDeliverableEntities.label === undefined
          ? boundedSourceLabel(sourceText)
          : withoutDeliverableEntities.label;
        return {
          ...withoutDeliverableEntities,
          ...(withoutDeliverableEntities.required === undefined
            ? { required: true }
            : {}),
          ...(sourceText === undefined ? {} : { sourceText }),
          ...(label === undefined ? {} : { label }),
          obligations,
        };
      })
    : value.deliverables;
  return {
    ...value,
    entities,
    deliverables: repairUnambiguousModelTargetBindings(entities, deliverables),
  };
}

function repairUnambiguousModelTargetBindings(
  entities: unknown,
  deliverables: unknown,
): unknown {
  if (!Array.isArray(entities) || !Array.isArray(deliverables)) {
    return deliverables;
  }
  const validEntities = entities.flatMap((entity) => {
    if (
      !isUnknownRecord(entity) ||
      typeof entity.id !== "string" ||
      typeof entity.label !== "string" ||
      [...entity.label.trim()].length < 2
    ) {
      return [];
    }
    return [{ id: entity.id, label: entity.label.trim() }];
  });
  if (validEntities.length === 0) return deliverables;

  return deliverables.map((deliverable) => {
    if (!isUnknownRecord(deliverable) || !Array.isArray(deliverable.obligations)) {
      return deliverable;
    }
    const obligations = deliverable.obligations.map((obligation) => {
      if (
        !isUnknownRecord(obligation) ||
        !Array.isArray(obligation.targetEntityIds) ||
        obligation.targetEntityIds.length > 0
      ) {
        return obligation;
      }
      const bindingText = [deliverable.label, obligation.label]
        .filter((item): item is string => typeof item === "string")
        .join(" ");
      const matches = validEntities.filter((entity) =>
        containsSemanticText(bindingText, entity.label));
      return matches.length === 1
        ? { ...obligation, targetEntityIds: [matches[0]!.id] }
        : obligation;
    });
    return { ...deliverable, obligations };
  });
}

function moveCompatibleAlias(
  input: Record<string, unknown>,
  canonical: string,
  alias: string,
): Record<string, unknown> {
  if (!(alias in input)) return input;
  if (
    canonical in input &&
    JSON.stringify(input[canonical]) !== JSON.stringify(input[alias])
  ) {
    return input;
  }
  const { [alias]: aliasValue, ...rest } = input;
  return {
    ...rest,
    [canonical]: rest[canonical] ?? aliasValue,
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function firstNestedSourceText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const rawDeliverable of value) {
    if (!isUnknownRecord(rawDeliverable) || !Array.isArray(rawDeliverable.obligations)) {
      continue;
    }
    for (const rawObligation of rawDeliverable.obligations) {
      if (isUnknownRecord(rawObligation) && typeof rawObligation.sourceText === "string") {
        return rawObligation.sourceText;
      }
    }
  }
  return undefined;
}

function boundedSourceLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return [...trimmed].slice(0, 256).join("");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  readonly legacyPlan?: KnowledgePlan;
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
保留用户明确点名的全部并列对象、互不替代的全部交付目标和约束；每个明确对象必须被必答 obligation 覆盖，不能被另一个对象替代。比较任务允许同一 obligation 同时绑定多个比较对象，避免按“维度 × 对象”重复拆分。
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
          ...(input.legacyPlan === undefined ? {} : { legacyPlan: input.legacyPlan }),
          knowledgePurpose: input.knowledgeContext.purpose,
          knowledgeSchema: input.knowledgeContext.schema,
          planningOverview: input.knowledgeContext.planningOverview,
        }),
      },
    ];
    let repairInstruction = "上一次输出不符合 TaskSpec Schema。只重新输出合法 TaskSpec JSON，不要解释。";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const modelTaskSpec = await this.model.completeJson({
          messages: attempt === 1
            ? messages
            : [
                ...messages,
                {
                  role: "user" as const,
                  content: repairInstruction,
                },
              ],
          schema: taskSpecSchema,
          schemaDescription: "pse_task_spec",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const taskSpec = repairProfessionalDirectDomains(
          input.scopeHint,
          repairExplicitEvidenceConditions(
            input.resolvedQuestion.standaloneQuestion,
            repairNumericOpportunityForecastPolicy(
              input.resolvedQuestion.standaloneQuestion,
              repairComparisonObligationExpansion(
                input.scopeHint,
                input.resolvedQuestion.standaloneQuestion,
                repairProtectedEvidencePolicies(
                  repairUnambiguousCustomerInputSourceBinding(
                    input.resolvedQuestion.standaloneQuestion,
                    repairExplicitEntityObligationBindings(
                      repairTraceableTaskSources(
                        input.resolvedQuestion.standaloneQuestion,
                        modelTaskSpec,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        if (
          isConsolidationRequest(input.resolvedQuestion.rawQuestion) &&
          requiredObligationCount(taskSpec) > 6
        ) {
          repairInstruction = [
            "上一次 TaskSpec 把汇总、摘要或整理任务过度拆分。",
            "只保留当前问题明确要求的输出目标，把会话上下文中的相关事实作为同一输出目标的材料，不得把每个继承实体、历史问题或证据点升级为独立 obligation。",
            "必答 obligations 总数不得超过 6；不得丢失当前问题明确并列的输出目标。",
            "只重新输出合法 TaskSpec JSON，不要解释。",
          ].join("");
          throw new InvalidModelPayloadError(
            "task_spec_consolidation_overexpanded",
            undefined,
            "pse_task_spec",
          );
        }
        const missingCustomerInputClauses = findMissingCustomerInputClauses(
          input.resolvedQuestion.standaloneQuestion,
          taskSpec,
        );
        if (missingCustomerInputClauses.length > 0) {
          repairInstruction = [
            "上一次 TaskSpec 遗漏了当前个案预测义务。",
            "对每个要求判断当前商机或项目赢率、胜率、成交概率、机会质量或销售预测的独立请求，必须保留独立的 customer_input obligation；如果同时要求方法、清单或提升建议，另建 synthesis obligation，二者不能互相替代。",
            "只重新输出合法 TaskSpec JSON，不要解释。",
          ].join("");
          throw new InvalidModelPayloadError(
            "task_spec_customer_input_request_unmapped",
            undefined,
            "pse_task_spec",
          );
        }
        const guard = new DeterministicTaskSpecGuard().validate({
          resolvedQuestion: input.resolvedQuestion,
          taskSpec,
        });
        if (guard.issues.some((issue) => issue.code === "explicit_request_unmapped")) {
          return repairNumericOpportunityForecastPolicy(
            input.resolvedQuestion.standaloneQuestion,
            deterministicTaskSpecFallback(input),
          );
        }
        return taskSpec;
      } catch (error) {
        if (!(error instanceof InvalidModelPayloadError)) throw error;
        if (attempt === 3) {
          return repairNumericOpportunityForecastPolicy(
            input.resolvedQuestion.standaloneQuestion,
            deterministicTaskSpecFallback(input),
          );
        }
      }
    }
    throw new InvalidModelPayloadError(
      "invalid_task_spec_after_repair",
      undefined,
      "pse_task_spec",
    );
  }
}

const DETERMINISTIC_SYNTHESIS_OVERRIDE_PATTERN =
  /(?:结合客户现状|(?:如何|怎样|怎么|应该怎样).{0,24}设计|(?:重新)?评估(?:项目|商机|机会).*(?:下一步|建议|行动)|(?:^|[，,；;。])[^，,；;。]{0,12}(?:应该|应当)(?:如何|怎样|怎么)\S+)/u;
const DETERMINISTIC_GENERAL_DOMAIN_PATTERN =
  /(?:售前|销售|商机|赢率|胜率|成交|机会|项目评估|评估项目|下一步|预算|竞争|决策链|客户信息|采购|POC|沟通|表达|客户关系|需求发现|业务价值)/iu;
const DETERMINISTIC_PROFESSIONAL_DOMAIN_PATTERN =
  /(?:Coremail|Exchange|\bXT\d+(?:\.\d+)*\b|邮件|邮箱|电子信箱|网关|反垃圾|归档|迁移|部署|版本|兼容|授权|容灾|多活|镜像|AD|LDAP|RPO|RTO)/iu;
const EXPLICIT_CONFLICT_PATTERN = /(?:冲突|不一致|相互矛盾|口径差异|结论差异)/u;
const EXPLICIT_AMBIGUITY_PATTERN = /(?:不明确|不清楚|模糊|歧义|不确定)/u;
const EXPLICIT_FRESHNESS_PATTERN = /(?:过期|历史资料|旧案例|时效|现行|最新|昨天.*今天)/u;

function deterministicTaskSpecFallback(input: TaskCompilerInput): TaskSpec {
  const question = input.resolvedQuestion.standaloneQuestion.trim();
  const signals = extractExplicitQuestionSignals(question);
  const baseClauses = (signals.requestClauses.length === 0
    ? [question]
    : signals.requestClauses)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause, index, values) =>
      values.findIndex((candidate) => sameSemanticText(candidate, clause)) === index)
    .slice(0, 6);
  const clauses = baseClauses.length === 0 ? ["回答当前问题"] : baseClauses;
  const explicitEntityItems = stableUniqueText(
    signals.entityGroups.flatMap((group) => group.items),
  ).slice(0, 16);
  const entities = explicitEntityItems.length > 0
    ? explicitEntityItems.map((item, index) => ({
        id: `E${index + 1}`,
        label: takeTaskCharacters(item, 128),
        role: DETERMINISTIC_PROFESSIONAL_DOMAIN_PATTERN.test(item)
          ? "product" as const
          : "unknown" as const,
        sourceText: takeTaskCharacters(item, 256),
      }))
    : [{
        id: "E1",
        label: takeTaskCharacters(question, 128) || "当前问题",
        role: "subject" as const,
        sourceText: takeTaskCharacters(question, 256) || "当前问题",
      }];
  const bindEntityIds = explicitEntityItems.length > 0
    ? entities.map((entity) => entity.id)
    : clauses.length === 1 && [...question].length <= 128
      ? ["E1"]
      : [];
  const deliverables = clauses.map((clause, index) => {
    const sourceText = takeTaskCharacters(clause, 512);
    const analysis = analyzeObligationSource(clause);
    const evidencePolicy = analysis.customerInputEligible
      ? "customer_input" as const
      : !analysis.requiresDirectEvidence ||
          DETERMINISTIC_SYNTHESIS_OVERRIDE_PATTERN.test(clause)
        ? "synthesis" as const
        : "direct" as const;
    const domain = deterministicDomainFor(
      sourceText,
      evidencePolicy,
      input.scopeHint,
    );
    return {
      id: `D${index + 1}`,
      label: takeTaskCharacters(clause, 256),
      kind: deterministicDeliverableKind(clause),
      required: true,
      sourceText,
      obligations: [{
        id: `O${index + 1}`,
        label: takeTaskCharacters(clause, 256),
        targetEntityIds: bindEntityIds,
        evidencePolicy,
        evidenceCondition: explicitEvidenceCondition(
          sourceText,
          evidencePolicy === "customer_input",
        ),
        domains: [domain],
        required: true,
        sourceText,
      }],
    };
  });
  return taskSpecSchema.parse({
    subject: takeTaskCharacters(question, 1_024) || "当前问题",
    entities,
    deliverables,
  });
}

function deterministicDomainFor(
  sourceText: string,
  evidencePolicy: "direct" | "synthesis" | "customer_input",
  scopeHint: Exclude<Scope, "normal">,
): KnowledgeDomain {
  if (
    evidencePolicy === "customer_input" ||
    DETERMINISTIC_GENERAL_DOMAIN_PATTERN.test(sourceText)
  ) {
    return "presales-general";
  }
  if (
    DETERMINISTIC_PROFESSIONAL_DOMAIN_PATTERN.test(sourceText) ||
    scopeHint === "professional"
  ) {
    return "coremail-professional";
  }
  return "presales-general";
}

function repairProfessionalDirectDomains(
  scopeHint: Exclude<Scope, "normal">,
  taskSpec: TaskSpec,
): TaskSpec {
  if (scopeHint !== "professional") {
    return taskSpec;
  }
  return taskSpecSchema.parse({
    ...taskSpec,
    deliverables: taskSpec.deliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((obligation) =>
        obligation.evidencePolicy === "direct" ||
            (
              obligation.evidencePolicy === "synthesis" &&
              !DETERMINISTIC_GENERAL_DOMAIN_PATTERN.test(obligation.sourceText)
            )
          ? { ...obligation, domains: ["coremail-professional"] }
          : obligation),
    })),
  });
}

function deterministicDeliverableKind(
  clause: string,
): z.infer<typeof deliverableKindSchema> {
  if (/(?:对比|比较|差异|区别)/u.test(clause)) return "comparison";
  if (/(?:风险|评估|判断|赢率|胜率|成交概率)/u.test(clause)) {
    return "risk_assessment";
  }
  if (/(?:建议|推荐|下一步)/u.test(clause)) return "recommendation";
  if (/(?:如何|怎样|设计|步骤|清单|实施|迁移|切换)/u.test(clause)) {
    return "procedure";
  }
  return "fact";
}

function repairExplicitEvidenceConditions(
  question: string,
  taskSpec: TaskSpec,
): TaskSpec {
  const condition = explicitEvidenceCondition(question, false);
  if (
    !condition.conflictDetected &&
    !condition.ambiguous &&
    condition.freshness === "not_assessed"
  ) {
    return taskSpec;
  }
  return {
    ...taskSpec,
    deliverables: taskSpec.deliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((obligation) => ({
        ...obligation,
        evidenceCondition: {
          ...(obligation.evidenceCondition ?? defaultTaskEvidenceCondition(
            obligation.evidencePolicy === "customer_input",
          )),
          ambiguous: condition.ambiguous,
          conflictDetected: condition.conflictDetected,
          freshness: condition.freshness,
        },
      })),
    })),
  };
}

function explicitEvidenceCondition(
  text: string,
  customerInput: boolean,
): TaskEvidenceCondition {
  return {
    inputState: customerInput ? "missing" : "not_applicable",
    ambiguous: EXPLICIT_AMBIGUITY_PATTERN.test(text),
    conflictDetected: EXPLICIT_CONFLICT_PATTERN.test(text),
    freshness: EXPLICIT_FRESHNESS_PATTERN.test(text)
      ? "stale_or_unconfirmed"
      : "not_assessed",
  };
}

function takeTaskCharacters(value: string, maximum: number): string {
  return [...value.trim()].slice(0, maximum).join("");
}

export type TaskSpecIssueCode =
  | "entity_source_not_found"
  | "deliverable_source_not_found"
  | "obligation_source_not_found"
  | "explicit_entity_unmapped"
  | "explicit_entity_without_required_obligation"
  | "distributive_entity_group_unresolved"
  | "explicit_request_unmapped"
  | "customer_input_request_unmapped"
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
  readonly independentRequestClauses: readonly string[];
}

export function extractExplicitQuestionSignals(
  question: string,
  options: { readonly anchoredEntitySourceTexts?: readonly string[] } = {},
): ExplicitQuestionSignals {
  const entityGroups: Array<{ sourceText: string; items: string[] }> = [];
  const unresolvedDistributiveGroups: string[] = [];
  const listPattern = /(?:参考(?:看看|一下)?|(?:分别|各自)?(?:对比|比较|说明|介绍|分析|检索|搜索|查找))(?<list>[\p{L}\p{N}A-Za-z·（）()、，,\s和与及.]{2,160}?)(?=(?:各自)?的|各自|分别|方案|案例|架构|差异|区别|[，,；;。！？!?]\s*(?:请|给出|列出|说明|分析)|$)/giu;
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
    /(?:^|[，,；;。！？!?])\s*(?<list>[\p{L}\p{N}A-Za-z·（）()、，,\s和与及.]{2,160}?)\s*(?=(?:各自|分别|逐一|逐个)(?!\s*(?:检索|搜索|查找|说明|介绍|分析|评估|对比|比较|列出|给出)))/gu;
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
  const independentRequestClauses: string[] = [];
  const coverageListPattern =
    /(?:请|需要|需|应|要)?(?:覆盖|涵盖)(?<list>[^。！？!?]{2,180}?)(?=(?:，|,)?\s*(?:并|同时|以及)?\s*(?:明确|说明|列出|给出|指出)|[。！？!?]|$)/gu;
  for (const match of question.matchAll(coverageListPattern)) {
    const list = match.groups?.list;
    if (!list) continue;
    for (const item of list.split(/[、，,]+/u)) {
      const clause = cleanRequestClause(item);
      if (clause) {
        requestClauses.push(clause);
        independentRequestClauses.push(clause);
      }
    }
  }
  const orderedListPattern =
    /(?:按|按照)\s*(?<list>[^。！？!?]{2,180}?)\s*(?:(?:的)?顺序)?(?:排序|排列|组织|展开)/gu;
  for (const match of question.matchAll(orderedListPattern)) {
    const list = match.groups?.list;
    if (!list) continue;
    for (const item of splitIndependentRequestItems(list)) {
      const clause = cleanRequestClause(item);
      if (clause) {
        requestClauses.push(clause);
        independentRequestClauses.push(clause);
      }
    }
  }
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
    independentRequestClauses: stableUniqueText(independentRequestClauses),
  };
}

function splitIndependentRequestItems(value: string): string[] {
  return value
    .split(/\s*(?:、|，|,|以及|和|与|及)\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function taskSpecEntityAnchors(
  entities: TaskSpec["entities"],
  question: string,
): readonly string[] {
  const labels = entities.map((entity) => entity.label.trim());
  if (labels.length >= 2) {
    const characterLabels = labels.map((label) => [...label]);
    const maximumSuffixLength = Math.min(
      ...characterLabels.map((label) => Math.max(0, label.length - 2)),
    );
    for (let suffixLength = maximumSuffixLength; suffixLength >= 1; suffixLength -= 1) {
      const suffix = characterLabels[0]!.slice(-suffixLength).join("");
      if (!characterLabels.every((label) =>
        label.slice(-suffixLength).join("") === suffix)) {
        continue;
      }
      const cores = characterLabels.map((label) =>
        label.slice(0, -suffixLength).join("").trim());
      if (
        cores.some((core) => [...core].length < 2) ||
        new Set(cores.map(normalizeSemanticText)).size !== cores.length
      ) {
        continue;
      }
      const connected = new RegExp(
        cores.map(escapeRegularExpression).join(
          "\\s*(?:、|，|,|以及|和|与|及)\\s*",
        ),
        "iu",
      );
      if (connected.test(question)) return cores;
    }
  }
  return entities.map((entity) =>
    containsSemanticText(entity.sourceText, entity.label)
      ? entity.label
      : entity.sourceText);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const REQUEST_INTERROGATIVE_PATTERN =
  /(?:如何|怎样|为什么|哪些|多少|是否|能否|有没有|是什么|怎么办|怎么做|怎么提升|如何提升)/gu;
const REQUEST_ACTION_PATTERN =
  /(?:^|请|帮我|需要|还要|以及|同时|然后|并且|并|再|且|要)\s*(?:(?:分别|逐一|逐个|各自)\s*)?(?:检索|搜索|查找|分析|评估|介绍|说明|列出|总结|建议|推荐|给出|制定|设计|判断|排查)/gu;

function requestClauseBoundaries(segment: string): number[] {
  const actionMatches = [...segment.matchAll(REQUEST_ACTION_PATTERN)];
  const positions = [
    ...[...segment.matchAll(REQUEST_INTERROGATIVE_PATTERN)]
      .filter((match) => !actionMatches.some((action) => {
        const actionStart = action.index;
        const actionEnd = actionStart + action[0].length;
        return match.index >= actionStart && match.index <= actionEnd + 2;
      }))
      .map((match) => match.index),
    ...actionMatches.map((match) => match.index),
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
  const leadingRemainder = sourceText.slice(0, first.index).trim();
  const trailingSharedDescriptor = sourceText
    .slice(last.index + last.text.length)
    .trim();
  if (
    leadingRemainder ||
    trailingSharedDescriptor.length > 64 ||
    /(?:、|，|,|；|;|以及|和|与|及)/u.test(trailingSharedDescriptor)
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
        if (requiresDirectEvidence(
          obligation,
          isConsolidationRequest(spec.subject) ||
            isConsolidationRequest(deliverable.sourceText),
        )) {
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

    const signals = extractExplicitQuestionSignals(
      input.resolvedQuestion.rawQuestion,
      {
        anchoredEntitySourceTexts: taskSpecEntityAnchors(
          spec.entities,
          input.resolvedQuestion.rawQuestion,
        ),
      },
    );
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
      const matchingEntities = spec.entities.filter((candidate) =>
        sameSemanticText(candidate.label, explicitEntity) ||
        sameSemanticText(candidate.sourceText, explicitEntity) ||
        containsSemanticText(candidate.label, explicitEntity));
      const entity = matchingEntities.length === 1
        ? matchingEntities[0]
        : undefined;
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
    const independentRequestKeys = new Set(
      signals.independentRequestClauses.map(normalizeSemanticText),
    );
    const usedIndependentObligations = new Set<string>();
    for (const clause of signals.requestClauses) {
      const independent = independentRequestKeys.has(normalizeSemanticText(clause));
      const matchingObligations = spec.deliverables.flatMap((deliverable) =>
        !deliverable.required
          ? []
          : deliverable.obligations.flatMap((obligation) =>
              obligation.required && (
                semanticOverlap(clause, obligation.sourceText) ||
                semanticOverlap(clause, deliverable.sourceText)
              )
                ? [{ key: `${deliverable.id}:${obligation.id}` }]
                : []));
      const available = independent
        ? matchingObligations.find((candidate) =>
            !usedIndependentObligations.has(candidate.key))
        : matchingObligations[0];
      const mapped = available !== undefined;
      if (independent && available !== undefined) {
        usedIndependentObligations.add(available.key);
      }
      if (mapped) mappedExplicitRequestCount += 1;
      else issues.push({ code: "explicit_request_unmapped", severity: "error" });
    }
    for (const _clause of findMissingCustomerInputClauses(question, spec)) {
      issues.push({
        code: "customer_input_request_unmapped",
        severity: "error",
      });
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

function isConsolidationRequest(question: string): boolean {
  return /(?:摘要|总结|汇总|归纳|概括|整理|一页式|一页纸)/u.test(question);
}

function requiredObligationCount(taskSpec: TaskSpec): number {
  return taskSpec.deliverables.reduce(
    (count, deliverable) => count + (
      deliverable.required
        ? deliverable.obligations.filter((obligation) => obligation.required).length
        : 0
    ),
    0,
  );
}

function findMissingCustomerInputClauses(
  question: string,
  taskSpec: TaskSpec,
): readonly string[] {
  const requiredCustomerInput = taskSpec.deliverables.flatMap((deliverable) =>
    !deliverable.required
      ? []
      : deliverable.obligations.filter((obligation) =>
          obligation.required && obligation.evidencePolicy === "customer_input"));
  return extractExplicitQuestionSignals(question).requestClauses.filter((clause) => {
    if (!analyzeObligationSource(clause).customerInputEligible) return false;
    return !requiredCustomerInput.some((obligation) =>
      semanticOverlap(clause, obligation.sourceText));
  });
}

function repairUnambiguousCustomerInputSourceBinding(
  question: string,
  taskSpec: TaskSpec,
): TaskSpec {
  const forecastClauses = extractExplicitQuestionSignals(question).requestClauses
    .filter((clause) => analyzeObligationSource(clause).customerInputEligible);
  const customerInputs = taskSpec.deliverables.flatMap((deliverable, deliverableIndex) =>
    deliverable.obligations.flatMap((obligation, obligationIndex) =>
      deliverable.required && obligation.required &&
          obligation.evidencePolicy === "customer_input"
        ? [{ deliverableIndex, obligationIndex }]
        : []));
  if (forecastClauses.length !== 1 || customerInputs.length !== 1) {
    return taskSpec;
  }
  const clause = forecastClauses[0]!;
  const binding = customerInputs[0]!;
  const obligation = taskSpec.deliverables[binding.deliverableIndex]
    ?.obligations[binding.obligationIndex];
  if (
    obligation === undefined ||
    (
      semanticOverlap(clause, obligation.sourceText) &&
      analyzeObligationSource(obligation.sourceText).customerInputEligible
    )
  ) {
    return taskSpec;
  }
  return taskSpecSchema.parse({
    ...taskSpec,
    deliverables: taskSpec.deliverables.map((deliverable, deliverableIndex) =>
      deliverableIndex !== binding.deliverableIndex
        ? deliverable
        : {
            ...deliverable,
            obligations: deliverable.obligations.map((candidate, obligationIndex) =>
              obligationIndex === binding.obligationIndex
                ? { ...candidate, sourceText: clause }
                : candidate),
          }),
  });
}

function repairTraceableTaskSources(
  question: string,
  taskSpec: TaskSpec,
): TaskSpec {
  const requestClauses = extractExplicitQuestionSignals(question).requestClauses;
  const traceableSource = (sourceText: string, label: string): string => {
    if (
      containsSemanticText(question, label) &&
      !containsSemanticText(sourceText, label)
    ) {
      return label;
    }
    if (containsSemanticText(question, sourceText)) return sourceText;
    if (containsSemanticText(question, label)) return label;
    const matches = requestClauses.filter((clause) =>
      semanticOverlap(label, clause) || semanticOverlap(sourceText, clause));
    if (matches.length === 1) return matches[0]!;
    if (requestClauses.length === 1) return requestClauses[0]!;
    return question;
  };
  return taskSpecSchema.parse({
    ...taskSpec,
    entities: taskSpec.entities.map((entity) => ({
      ...entity,
      sourceText: traceableSource(entity.sourceText, entity.label),
    })),
    deliverables: taskSpec.deliverables.map((deliverable) => ({
      ...deliverable,
      sourceText: traceableSource(deliverable.sourceText, deliverable.label),
      obligations: deliverable.obligations.map((obligation) => {
        const sourceRequestMatches = requestClauses.filter((clause) =>
          semanticOverlap(obligation.sourceText, clause));
        const requestMatches = requestClauses.filter((clause) =>
          semanticOverlap(obligation.label, clause) ||
          semanticOverlap(obligation.sourceText, clause));
        const safeSynthesisRequests = requestMatches.filter((clause) =>
          !analyzeObligationSource(clause).requiresDirectEvidence);
        const synthesisRequestSource = obligation.evidencePolicy === "synthesis"
          ? sourceRequestMatches.length === 0
            ? requestMatches.length === 1
              ? requestMatches[0]
              : requestMatches.length === 0 && requestClauses.length === 1
                ? requestClauses[0]
                : undefined
            : requiresDirectEvidence(obligation) && safeSynthesisRequests.length > 0
              ? safeSynthesisRequests[0]
              : undefined
          : undefined;
        return {
          ...obligation,
          sourceText: synthesisRequestSource ??
            traceableSource(obligation.sourceText, obligation.label),
        };
      }),
    })),
  });
}

function repairExplicitEntityObligationBindings(taskSpec: TaskSpec): TaskSpec {
  return taskSpecSchema.parse({
    ...taskSpec,
    deliverables: taskSpec.deliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((obligation) => {
        const targetEntityIds = taskSpec.entities.flatMap((entity) =>
          semanticOverlap(obligation.label, entity.label) ||
              sameSemanticText(obligation.sourceText, entity.label) ||
              sameSemanticText(obligation.sourceText, entity.sourceText)
            ? [entity.id]
            : []);
        return targetEntityIds.length === 0 ||
            (targetEntityIds.length > 1 && obligation.targetEntityIds.length > 0)
          ? obligation
          : { ...obligation, targetEntityIds };
      }),
    })),
  });
}

function repairComparisonObligationExpansion(
  scopeHint: Exclude<Scope, "normal">,
  question: string,
  taskSpec: TaskSpec,
): TaskSpec {
  const routedDomain: KnowledgeDomain = scopeHint === "professional"
    ? "coremail-professional"
    : "presales-general";
  let obligationIndex = 0;
  const explicitEntities = new Set(
    extractExplicitQuestionSignals(question).entityGroups
      .flatMap((group) => group.items)
      .map(normalizeSemanticText),
  );
  const deliverables = taskSpec.deliverables.map((deliverable) => {
    const required = deliverable.obligations.filter((obligation) => obligation.required);
    const targetIds = required.flatMap((obligation) => obligation.targetEntityIds);
    const distinctTargetIds = [...new Set(targetIds)];
    const policies = new Set(required.map((obligation) => obligation.evidencePolicy));
    const canMerge =
      !distinctTargetIds.some((entityId) => {
        const entity = taskSpec.entities.find((candidate) => candidate.id === entityId);
        return entity !== undefined && (
          explicitEntities.has(normalizeSemanticText(entity.label)) ||
          explicitEntities.has(normalizeSemanticText(entity.sourceText))
        );
      }) &&
      required.length >= 2 &&
      required.length === deliverable.obligations.length &&
      distinctTargetIds.length >= 2 &&
      policies.size === 1 &&
      required.some((obligation) => obligation.domains.includes(routedDomain));
    const obligations = canMerge
      ? [{
          ...required[0]!,
          label: deliverable.label,
          targetEntityIds: distinctTargetIds,
          domains: [routedDomain],
          sourceText: deliverable.sourceText,
        }]
      : deliverable.obligations;
    return {
      ...deliverable,
      obligations: obligations.map((obligation) => ({
        ...obligation,
        id: `O${++obligationIndex}`,
      })),
    };
  });
  return taskSpecSchema.parse({ ...taskSpec, deliverables });
}

function repairNumericOpportunityForecastPolicy(
  question: string,
  taskSpec: TaskSpec,
): TaskSpec {
  const asksForNumericJudgment =
    /(?:报|给|估|评估|预测|判断).{0,12}(?:百分比|概率|几成|成数)/u.test(question) ||
    /(?:应该|应当|该|需要).{0,8}报多少/u.test(question);
  if (!asksForNumericJudgment) return taskSpec;

  const semanticContext = [
    question,
    taskSpec.subject,
    ...taskSpec.entities.flatMap((entity) => [entity.label, entity.sourceText]),
    ...taskSpec.deliverables.flatMap((deliverable) => [
      deliverable.label,
      deliverable.sourceText,
      ...deliverable.obligations.flatMap((obligation) => [
        obligation.label,
        obligation.sourceText,
      ]),
    ]),
  ].join(" ");
  if (!/(?:销售|商机|机会|项目|赢率|胜率|成交|POC)/iu.test(semanticContext)) {
    return taskSpec;
  }

  const requiredObligations = taskSpec.deliverables.flatMap((deliverable, deliverableIndex) =>
    deliverable.required
      ? deliverable.obligations.flatMap((obligation, obligationIndex) =>
          obligation.required ? [{ deliverableIndex, obligationIndex, obligation }] : [])
      : []);
  const hasCustomerInput = requiredObligations.some(({ obligation }) =>
    obligation.evidencePolicy === "customer_input");
  const hasKnowledgeMethod = requiredObligations.some(({ obligation }) =>
    obligation.evidencePolicy !== "customer_input");
  let repaired = taskSpec;
  if (!hasCustomerInput) {
    repaired = appendNumericForecastObligation(
      repaired,
      question,
      "customer_input",
    );
  }
  if (!hasKnowledgeMethod) {
    repaired = appendNumericForecastObligation(repaired, question, "direct");
  }
  return repaired;
}

function appendNumericForecastObligation(
  taskSpec: TaskSpec,
  question: string,
  evidencePolicy: "direct" | "customer_input",
): TaskSpec {
  if (taskSpec.deliverables.length >= 6) return taskSpec;
  const obligationCount = taskSpec.deliverables.reduce(
    (count, deliverable) => count + deliverable.obligations.length,
    0,
  );
  const sourceText = takeTaskCharacters(question, 512);
  const customerInput = evidencePolicy === "customer_input";
  return taskSpecSchema.parse({
    ...taskSpec,
    deliverables: [
      ...taskSpec.deliverables,
      {
        id: `D${taskSpec.deliverables.length + 1}`,
        label: customerInput
          ? "当前个案判断所需输入"
          : "证据不足时的判断与汇报方法",
        kind: customerInput ? "diagnosis" : "recommendation",
        required: true,
        sourceText,
        obligations: [{
          id: `O${obligationCount + 1}`,
          label: customerInput
            ? "形成当前个案判断"
            : "说明安全的判断方法与待补信息",
          targetEntityIds: taskSpec.entities.length === 1
            ? [taskSpec.entities[0]!.id]
            : [],
          evidencePolicy,
          evidenceCondition: explicitEvidenceCondition(sourceText, customerInput),
          domains: ["presales-general"],
          required: true,
          sourceText,
        }],
      },
    ],
  });
}

function requiresDirectEvidence(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
  allowDefaultFactSynthesis = false,
): boolean {
  if (obligation.evidencePolicy === "direct") return false;
  const sourceText = obligation.sourceText;
  const analysis = analyzeObligationSource(sourceText);
  if (
    obligation.evidencePolicy === "synthesis" &&
    DETERMINISTIC_SYNTHESIS_OVERRIDE_PATTERN.test(sourceText) &&
    !analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" && atom.reason !== "default_fact")
  ) {
    return false;
  }
  if (
    allowDefaultFactSynthesis &&
    obligation.evidencePolicy === "synthesis" &&
    analysis.atoms.length > 0 &&
    analysis.atoms.every((atom) =>
      atom.kind === "synthesis" ||
      (atom.kind === "protected_fact" && atom.reason === "default_fact"))
  ) {
    return false;
  }
  if (
    obligation.evidencePolicy === "customer_input" &&
    (
      analysis.customerInputEligible ||
      isNumericOpportunityForecastObligation(obligation)
    )
  ) {
    return false;
  }
  return analysis.requiresDirectEvidence;
}

function isNumericOpportunityForecastObligation(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): boolean {
  const semanticText = `${obligation.label} ${obligation.sourceText}`;
  const sourceAnalysis = analyzeObligationSource(obligation.sourceText);
  const containsIndependentProtectedFact = sourceAnalysis.atoms.some((atom) =>
    atom.kind === "protected_fact" && atom.reason !== "default_fact");
  return !containsIndependentProtectedFact &&
    /(?:销售|商机|机会|项目|赢率|胜率|成交|POC)/iu.test(semanticText) &&
    (
      /(?:报|给|估|评估|预测|判断).{0,16}(?:百分比|概率|几成|成数)/u.test(semanticText) ||
      /(?:应该|应当|该|需要).{0,8}报多少/u.test(semanticText)
    );
}

function repairProtectedEvidencePolicies(taskSpec: TaskSpec): TaskSpec {
  return {
    ...taskSpec,
    deliverables: taskSpec.deliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((obligation) =>
        obligation.evidencePolicy !== "direct" && requiresDirectEvidence(
          obligation,
          isConsolidationRequest(taskSpec.subject) ||
            isConsolidationRequest(deliverable.sourceText),
        )
          ? {
              ...obligation,
              evidencePolicy: "direct" as const,
              evidenceCondition: {
                ...(obligation.evidenceCondition ?? defaultTaskEvidenceCondition(false)),
                inputState: "not_applicable" as const,
              },
            }
          : obligation),
    })),
  };
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
