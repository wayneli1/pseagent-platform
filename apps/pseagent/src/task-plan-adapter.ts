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
import {
  extractExplicitQuestionSignals,
  taskEvidenceConditionFor,
} from "./task-spec.js";
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
const DEICTIC_COMPARISON_PATTERN =
  /(?:两者|二者|这两(?:个|种|类|项|套)?|前者.{0,16}后者|后者.{0,16}前者|它们|各自).{0,32}(?:差异|区别|对比|限制|优劣|异同)/u;
const CONTEXT_DEPENDENT_SELECTION_PATTERN =
  /(?:(?:为什么|为何|何以).{0,32}(?:考虑|选择|采用|推荐)|(?:考虑|选择|采用|推荐).{0,32}(?:原因|理由|动因))/u;

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
    const requiredParallelScope = findRequiredParallelScope(
      input.resolvedQuestion.standaloneQuestion,
      item.obligation.sourceText,
    );
    const entitySourceTexts = targetEntities.map((entity) => entity.sourceText)
      .filter((value) => isTraceableText(
        input.resolvedQuestion.standaloneQuestion,
        value,
      ))
      .filter((value) => isRelevantParallelEntitySource(
        value,
        requiredParallelScope,
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
    const obligationContext =
      `${item.obligation.sourceText} ${item.deliverable.sourceText}`;
    const comparisonContext = DEICTIC_COMPARISON_PATTERN.test(obligationContext)
      ? input.resolvedQuestion.standaloneQuestion
      : "";
    const selectionContext = CONTEXT_DEPENDENT_SELECTION_PATTERN.test(
        obligationContext,
      )
      ? input.resolvedQuestion.standaloneQuestion
      : "";
    const leadingQuestionContext = requiredParallelScope === undefined
      ? traceableLeadingQuestionContext(
        input.resolvedQuestion.standaloneQuestion,
        item.obligation.sourceText,
        otherEntitySourceTexts,
      )
      : "";
    const requiredParallelContext = requiredParallelScope?.sharedRequest ?? "";
    const baseRequirementQuestion = buildSemanticQuery([
      ...entitySourceTexts,
      obligationSourceText,
      deliverableSourceText,
      comparisonContext,
    ]);
    const requirementQuestion = buildSemanticQuery([
      baseRequirementQuestion,
      requiredParallelContext,
    ]);
    const primaryQuery = buildSemanticQuery([
      ...entitySourceTexts,
      leadingQuestionContext,
      obligationSourceText,
      deliverableSourceText,
      comparisonContext,
      selectionContext,
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
      comparisonContext,
      selectionContext,
      safeLabel,
      requiredParallelContext,
    );
    const comparisonDimensions = explicitComparisonDimensions(
      obligationContext,
    );
    const evidenceAspects = comparisonDimensions.length >= 2
      ? comparisonDimensions.map((dimension, dimensionIndex) => ({
          id: `A${dimensionIndex + 1}` as KnowledgePlan["requirements"][number]["evidenceAspects"][number]["id"],
          label: dimension,
          terms: buildAspectTerms(entitySourceTexts, dimension) ?? [dimension],
        }))
      : terms === undefined
        ? undefined
        : [{
            id: "A1" as const,
            label: requiredParallelContext || aspectLabel(
              obligationSourceText,
              deliverableSourceText,
              entitySourceTexts,
            ),
            terms,
          }];
    const aspectIds = evidenceAspects?.map((aspect) => aspect.id) ?? [];
    const queries = [primaryQuery];
    if (requiredParallelContext !== "") {
      const contextual = buildSemanticQuery([
        primaryQuery,
        requiredParallelContext,
      ]);
      if (
        normalizeSemanticText(contextual) !==
          normalizeSemanticText(primaryQuery) &&
        characterLength(contextual) <= MAX_QUERY_CHARACTERS
      ) {
        queries.push(contextual);
      }
    }
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
    if (
      evidenceAspects === undefined ||
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
      evidenceAspects,
      queries: queries.map((query) => ({
        text: query,
        aspectIds,
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

interface RequiredParallelScope {
  readonly currentItem: string;
  readonly otherItems: readonly string[];
  readonly sharedRequest: string;
}

function findRequiredParallelScope(
  question: string,
  obligationSourceText: string,
): RequiredParallelScope | undefined {
  const normalizedObligation = normalizeSemanticText(obligationSourceText);
  if (!normalizedObligation) return undefined;
  const signals = extractExplicitQuestionSignals(question);
  const group = signals.requiredParallelGroups
    .find((candidate) => candidate.items.some((item) =>
      normalizeSemanticText(item) === normalizedObligation));
  if (group === undefined || !question.includes(group.sourceText)) return undefined;
  const currentItem = group.items.find((item) =>
    normalizeSemanticText(item) === normalizedObligation)!;
  const groupEnd = question.indexOf(group.sourceText) + group.sourceText.length;
  const independentKeys = new Set(
    signals.independentRequestClauses.map(normalizeSemanticText),
  );
  const shared = signals.requestClauses.filter((clause) =>
    !independentKeys.has(normalizeSemanticText(clause)) &&
    question.indexOf(clause) >= groupEnd,
  ).slice(0, 2);
  return {
    currentItem,
    otherItems: group.items.filter((item) => item !== currentItem),
    sharedRequest: shared.length === 0
      ? ""
      : buildSemanticQuery([currentItem, ...shared]),
  };
}

function isRelevantParallelEntitySource(
  sourceText: string,
  scope: RequiredParallelScope | undefined,
): boolean {
  if (scope === undefined) return true;
  const normalizedSource = normalizeSemanticText(sourceText);
  return !scope.otherItems.some((item) =>
    normalizedSource.includes(normalizeSemanticText(item)));
}

function traceableLeadingQuestionContext(
  question: string,
  requestSourceText: string,
  excludedEntityTexts: readonly string[],
): string {
  const requestIndex = question.indexOf(requestSourceText);
  if (requestIndex <= 0) return "";
  const prefix = question.slice(0, requestIndex);
  const lastBoundary = Math.max(
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("；"),
    prefix.lastIndexOf(";"),
  );
  const context = scopedDeliverableSource(
    prefix.slice(lastBoundary + 1),
    excludedEntityTexts,
  )
    .replace(/^[，,\s]+|[，,\s]+$/gu, "")
    .trim();
  return characterLength(context) >= 4 && characterLength(context) <= 128
    ? context
    : "";
}

function explicitComparisonDimensions(value: string): string[] {
  const list = value.match(
    /在(?<list>[^？?。！!]{2,180}?)(?:上|方面)(?:有|存在)?(?:什么|哪些|何种)?(?:区别|差异|不同)/u,
  )?.groups?.list;
  if (list === undefined) return [];
  const dimensions = stableUniqueText(
    list.split(/[、，,；;]|\s+(?:和|与|及)\s+/u)
      .map((dimension) => dimension.trim())
      .filter((dimension) =>
        dimension.length > 0 &&
        characterLength(dimension) <= 64
      ),
  );
  return dimensions.length >= 2 && dimensions.length <= 8 ? dimensions : [];
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
