import {
  knowledgePlanSchema,
  type KnowledgePlan,
  type Scope,
} from "./contracts.js";
import type { ResolvedQuestion } from "./question-resolver.js";
import type {
  KnowledgeDomain,
  TaskSpec,
  TaskSpecGuardResult,
} from "./task-spec.js";
import { taskEvidenceConditionFor } from "./task-spec.js";
import type { RequirementEvidenceCondition } from "./evidence-ledger.js";

export type TaskPlanAdapterInactiveReason =
  | "guard_rejected"
  | "customer_input_unhandled"
  | "multi_domain_required"
  | "no_applicable_obligations"
  | "requirement_limit_exceeded"
  | "knowledge_plan_contract_exceeded";

export type TaskPlanAdapterResult =
  | {
      readonly activated: true;
      readonly plan: KnowledgePlan;
      readonly obligationIds: readonly string[];
      readonly conditions: readonly RequirementEvidenceCondition[];
    }
  | {
      readonly activated: false;
      readonly reason: TaskPlanAdapterInactiveReason;
      readonly applicableObligationCount: number;
    };

export interface TaskPlanAdapterInput {
  readonly scope: Exclude<Scope, "normal">;
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
  readonly guardResult: TaskSpecGuardResult;
}

const DOMAIN_BY_SCOPE: Readonly<Record<
  TaskPlanAdapterInput["scope"],
  KnowledgeDomain
>> = {
  professional: "coremail-professional",
  general: "presales-general",
};

const MAX_REQUIREMENTS = 6;
const MAX_ASPECT_TERMS = 8;
const MAX_QUERY_CHARACTERS = 1_024;

export function adaptTaskSpecToKnowledgePlan(
  input: TaskPlanAdapterInput,
): TaskPlanAdapterResult {
  if (!input.guardResult.ok) {
    return {
      activated: false,
      reason: "guard_rejected",
      applicableObligationCount: 0,
    };
  }

  const domain = DOMAIN_BY_SCOPE[input.scope];
  const required = input.taskSpec.deliverables.flatMap((deliverable) =>
    !deliverable.required
      ? []
      : deliverable.obligations.flatMap((obligation) =>
          obligation.required ? [{ deliverable, obligation }] : [])
  );
  if (required.some(({ obligation }) =>
    obligation.domains.some((candidate) => candidate !== domain))) {
    return {
      activated: false,
      reason: "multi_domain_required",
      applicableObligationCount: required.length,
    };
  }
  const applicable = required.filter(({ obligation }) =>
    obligation.domains.includes(domain));

  if (applicable.length === 0) {
    return {
      activated: false,
      reason: "no_applicable_obligations",
      applicableObligationCount: 0,
    };
  }
  if (applicable.length > MAX_REQUIREMENTS) {
    return {
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: applicable.length,
    };
  }

  const entitiesById = new Map(
    input.taskSpec.entities.map((entity) => [entity.id, entity] as const),
  );
  const requirements: KnowledgePlan["requirements"][number][] = [];
  for (const [index, item] of applicable.entries()) {
    const targetEntityIds = new Set(item.obligation.targetEntityIds);
    const targetEntities = item.obligation.targetEntityIds.map(
      (entityId) => entitiesById.get(entityId)!,
    );
    const entitySourceTexts = targetEntities.map((entity) => entity.sourceText)
      .filter((value) => isTraceableText(
        input.resolvedQuestion.standaloneQuestion,
        value,
      ));
    const otherEntitySourceTexts = targetEntityIds.size === 0
      ? []
      : input.taskSpec.entities
          .filter((entity) => !targetEntityIds.has(entity.id))
          .map((entity) => entity.sourceText)
          .filter((value) => isTraceableText(
            input.resolvedQuestion.standaloneQuestion,
            value,
          ));
    const obligationSourceText = isTraceableText(
        input.resolvedQuestion.standaloneQuestion,
        item.obligation.sourceText,
      )
      ? scopedDeliverableSource(
        item.obligation.sourceText,
        otherEntitySourceTexts,
      )
      : "";
    const deliverableSourceText = scopedDeliverableSource(
      item.deliverable.sourceText,
      otherEntitySourceTexts,
    );
    const primaryQuery = buildSemanticQuery([
      ...entitySourceTexts,
      obligationSourceText,
      deliverableSourceText,
    ]);
    const safeLabel = safeLabelExpansion(
      item.obligation.label,
      entitySourceTexts,
      primaryQuery,
    );
    const terms = buildAspectTerms(
      entitySourceTexts,
      obligationSourceText,
      deliverableSourceText,
      safeLabel,
    );
    const queries = [primaryQuery];
    if (safeLabel !== "") {
      const expanded = buildSemanticQuery([primaryQuery, safeLabel]);
      if (
        normalizeSemanticText(expanded) !==
          normalizeSemanticText(primaryQuery) &&
        characterLength(expanded) <= MAX_QUERY_CHARACTERS
      ) {
        queries.push(expanded);
      }
    }
    const requirementQuestion = primaryQuery;
    if (
      terms === undefined ||
      characterLength(requirementQuestion) === 0 ||
      characterLength(requirementQuestion) > 1_024 ||
      characterLength(primaryQuery) > MAX_QUERY_CHARACTERS
    ) {
      return {
        activated: false,
        reason: "knowledge_plan_contract_exceeded",
        applicableObligationCount: applicable.length,
      };
    }
    requirements.push({
      id: `R${index + 1}` as KnowledgePlan["requirements"][number]["id"],
      question: requirementQuestion,
      evidenceMode: item.obligation.evidencePolicy === "direct"
        ? "direct_only"
        : "synthesis_allowed",
      evidenceAspects: [{
        id: "A1",
        label: aspectLabel(
          obligationSourceText,
          deliverableSourceText,
          entitySourceTexts,
        ),
        terms,
      }],
      queries: queries.map((query) => ({
        text: query,
        aspectIds: ["A1"],
      })),
    });
  }

  const parsed = knowledgePlanSchema.safeParse({
    subject: input.taskSpec.subject,
    requirements,
  });
  if (!parsed.success) {
    return {
      activated: false,
      reason: "knowledge_plan_contract_exceeded",
      applicableObligationCount: applicable.length,
    };
  }
  return {
    activated: true,
    plan: {
      ...parsed.data,
      retrievalStrategy: "coverage_units",
    },
    obligationIds: applicable.map(({ obligation }) => obligation.id),
    conditions: applicable.map(({ obligation }, index) => ({
      requirementId: `R${index + 1}`,
      ...taskEvidenceConditionFor(obligation),
    })),
  };
}

function buildAspectTerms(
  entitySourceTexts: readonly string[],
  ...optionalTerms: readonly string[]
): string[] | undefined {
  const requiredEntityTerms = stableUniqueText(entitySourceTexts);
  if (
    requiredEntityTerms.length > MAX_ASPECT_TERMS ||
    requiredEntityTerms.some((term) => characterLength(term) > 128)
  ) {
    return undefined;
  }
  const terms = [...requiredEntityTerms];
  for (const term of optionalTerms) {
    if (terms.length >= MAX_ASPECT_TERMS) break;
    if (characterLength(term) > 128) continue;
    addUniqueText(terms, term);
  }
  return terms.length === 0 ? undefined : terms;
}

function scopedDeliverableSource(
  sourceText: string,
  excludedEntityTexts: readonly string[],
): string {
  let scoped = sourceText;
  for (const entityText of [...excludedEntityTexts].sort(
    (left, right) => right.length - left.length,
  )) {
    scoped = scoped.replaceAll(entityText, " ");
  }
  return scoped
    .replace(/[、，,；;|/]+/gu, " ")
    .replace(/\s*(?:和|与|及)\s*(?=的|\s|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^\s*(?:和|与|及)\s*|\s*(?:和|与|及)\s*$/gu, "")
    .trim();
}

function safeLabelExpansion(
  label: string,
  entitySourceTexts: readonly string[],
  primaryQuery: string,
): string {
  const normalizedLabel = normalizeSemanticText(label);
  if (!normalizedLabel) return "";
  if (entitySourceTexts.length > 0) {
    return entitySourceTexts.some((sourceText) =>
        normalizedLabel.includes(normalizeSemanticText(sourceText)))
      ? label
      : "";
  }
  return hasSemanticOverlap(label, primaryQuery) ? label : "";
}

function aspectLabel(
  obligationSourceText: string,
  deliverableSourceText: string,
  entitySourceTexts: readonly string[],
): string {
  const combined = buildSemanticQuery([
    obligationSourceText,
    deliverableSourceText,
    ...entitySourceTexts,
  ]);
  if (characterLength(combined) <= 256) return combined;
  return [obligationSourceText, ...entitySourceTexts]
    .find((value) => characterLength(value) > 0 && characterLength(value) <= 256) ??
    "知识要求";
}

function isTraceableText(container: string, value: string): boolean {
  const normalized = normalizeSemanticText(value);
  return normalized.length > 0 &&
    normalizeSemanticText(container).includes(normalized);
}

function hasSemanticOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeSemanticText(left);
  const normalizedRight = normalizeSemanticText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const rightBigrams = bigrams(normalizedRight);
  const shared = [...bigrams(normalizedLeft)].filter((item) =>
    rightBigrams.has(item)).length;
  return shared >= 2;
}

function bigrams(value: string): Set<string> {
  const characters = [...value];
  if (characters.length < 2) return new Set(characters);
  return new Set(characters.slice(0, -1).map(
    (character, index) => `${character}${characters[index + 1] ?? ""}`,
  ));
}

function buildSemanticQuery(values: readonly string[]): string {
  const selected: string[] = [];
  for (const value of values) {
    const normalized = normalizeSemanticText(value);
    if (!normalized) continue;
    if (selected.some((item) =>
      normalizeSemanticText(item).includes(normalized))) {
      continue;
    }
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (normalized.includes(normalizeSemanticText(selected[index]!))) {
        selected.splice(index, 1);
      }
    }
    selected.push(value.trim());
  }
  return selected.join(" ");
}

function stableUniqueText(values: readonly string[]): string[] {
  const selected: string[] = [];
  for (const value of values) addUniqueText(selected, value);
  return selected;
}

function addUniqueText(target: string[], value: string): void {
  const normalized = normalizeSemanticText(value);
  if (!normalized) return;
  if (target.some((item) => normalizeSemanticText(item) === normalized)) return;
  target.push(value.trim());
}

function normalizeSemanticText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function characterLength(value: string): number {
  return [...value].length;
}
