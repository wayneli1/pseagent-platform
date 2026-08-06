import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type {
  AnswerCardMatch,
  AnswerCardMatchBinding,
} from "./answer-card-matcher.js";
import type { ResolvedQuestion } from "./question-resolver.js";
import { knowledgePlanSchema, type KnowledgePlan } from "./contracts.js";
import {
  DeterministicTaskSpecGuard,
  taskSpecSchema,
  type TaskSpec,
  type TaskSpecGuardResult,
} from "./task-spec.js";

export interface AnswerCardObligationPolicy {
  readonly obligationId: string;
  readonly cardId: string;
  readonly cardObligationId: string;
  readonly requiredConcepts: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly preferredEvidencePaths: readonly string[];
  readonly answerTemplate?: string;
}

export type AnswerCardTaskSpecAdapterResult =
  | {
      readonly activated: true;
      readonly taskSpec: TaskSpec;
      readonly guard: TaskSpecGuardResult;
      readonly policies: readonly AnswerCardObligationPolicy[];
    }
  | {
      readonly activated: false;
      readonly reason:
        | "match_not_active"
        | "requirement_limit_exceeded"
        | "task_spec_contract_exceeded"
        | "guard_rejected";
    };

/**
 * Compile an approved exact answer card without depending on model-authored
 * entities or obligations. Exact aliases are part of the reviewed catalog, so
 * the catalog bindings are the authoritative contract for this request.
 */
export function compileExactAnswerCardTaskSpec(input: {
  readonly match: Exclude<AnswerCardMatch, { matchType: "none" }>;
  readonly resolvedQuestion: ResolvedQuestion;
}): AnswerCardTaskSpecAdapterResult {
  if (input.match.matchType !== "exact") {
    return { activated: false, reason: "match_not_active" };
  }
  if (input.match.bindings.length === 0 || input.match.bindings.length > 6) {
    return { activated: false, reason: "requirement_limit_exceeded" };
  }

  const question = boundedText(
    input.resolvedQuestion.standaloneQuestion,
    512,
    "当前问题",
  );
  const candidate = {
    subject: boundedText(question, 1_024, "当前问题"),
    entities: [{
      id: "E1",
      label: boundedText(question, 128, "当前问题"),
      role: "subject" as const,
      sourceText: boundedText(question, 256, "当前问题"),
    }],
    deliverables: [{
      id: "D1",
      label: boundedText(question, 256, "受治理答案"),
      kind: "recommendation" as const,
      required: true,
      sourceText: question,
      obligations: input.match.bindings.map((binding, index) => ({
        id: `O${index + 1}`,
        label: binding.label,
        targetEntityIds: ["E1"],
        evidencePolicy: binding.evidencePolicy,
        evidenceCondition: binding.evidencePolicy === "customer_input"
          ? {
              inputState: "missing" as const,
              ambiguous: false,
              conflictDetected: false,
              freshness: "not_assessed" as const,
            }
          : {
              inputState: "not_applicable" as const,
              ambiguous: false,
              conflictDetected: false,
              freshness: "not_assessed" as const,
            },
        domains: taskDomainsForBinding(binding),
        required: binding.required,
        sourceText: question,
      })),
    }],
  };
  const parsed = taskSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return { activated: false, reason: "task_spec_contract_exceeded" };
  }

  const policies = input.match.bindings.map((binding, index) => Object.freeze({
    obligationId: `O${index + 1}`,
    cardId: binding.cardId,
    cardObligationId: binding.cardObligationId,
    requiredConcepts: Object.freeze([...binding.requiredConcepts]),
    forbiddenClaims: Object.freeze([...binding.forbiddenClaims]),
    preferredEvidencePaths: Object.freeze([...binding.preferredEvidencePaths]),
    ...(binding.answerTemplate === undefined
      ? {}
      : { answerTemplate: binding.answerTemplate }),
  }));
  const guard: TaskSpecGuardResult = Object.freeze({
    ok: true,
    issues: Object.freeze([]),
    explicitEntityCount: 0,
    mappedExplicitEntityCount: 0,
    explicitRequestCount: 0,
    mappedExplicitRequestCount: 0,
  });
  return {
    activated: true,
    taskSpec: parsed.data,
    guard,
    policies: Object.freeze(policies),
  };
}

interface DraftObligation {
  value: TaskSpec["deliverables"][number]["obligations"][number];
  cardBinding?: AnswerCardMatchBinding;
}

export function adaptAnswerCardToTaskSpec(input: {
  readonly match: AnswerCardMatch;
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
}): AnswerCardTaskSpecAdapterResult {
  if (input.match.matchType === "none") {
    return { activated: false, reason: "match_not_active" };
  }

  const draftDeliverables = input.taskSpec.deliverables.map((deliverable) => ({
    ...deliverable,
    obligations: deliverable.obligations.map((obligation): DraftObligation => ({
      value: obligation,
    })),
  }));
  const requiredLocations = draftDeliverables.flatMap((deliverable, deliverableIndex) =>
    !deliverable.required
      ? []
      : deliverable.obligations.flatMap((obligation, obligationIndex) =>
          obligation.value.required
            ? [{ deliverableIndex, obligationIndex, obligation }]
            : []));
  const used = new Set<DraftObligation>();

  for (const binding of input.match.bindings) {
    const ranked = requiredLocations
      .filter((location) => !used.has(location.obligation))
      .map((location) => ({
        ...location,
        score: obligationSimilarity(binding, location.obligation.value),
      }))
      .sort((left, right) =>
        right.score - left.score ||
        left.deliverableIndex - right.deliverableIndex ||
        left.obligationIndex - right.obligationIndex);
    const selected = binding.required
      ? ranked.find((candidate) => candidate.score > 0) ??
        (input.match.matchType === "partial" ? undefined : ranked[0])
      : undefined;
    if (selected !== undefined) {
      selected.obligation.value = applyBinding(selected.obligation.value, binding);
      selected.obligation.cardBinding = binding;
      used.add(selected.obligation);
      continue;
    }

    const targetDeliverable = draftDeliverables.find((deliverable) => deliverable.required);
    const base = requiredLocations[0]?.obligation.value;
    if (targetDeliverable === undefined || base === undefined) {
      return { activated: false, reason: "task_spec_contract_exceeded" };
    }
    const sourceText = boundedSourceText(
      targetDeliverable.sourceText,
      input.resolvedQuestion.standaloneQuestion,
    );
    targetDeliverable.obligations.push({
      value: applyBinding({
        ...base,
        sourceText,
      }, binding),
      cardBinding: binding,
    });
  }

  const governedDeliverables = input.match.matchType === "exact"
    ? draftDeliverables
        .map((deliverable) => ({
          ...deliverable,
          obligations: deliverable.obligations.filter((draft) =>
            draft.cardBinding !== undefined),
        }))
        .filter((deliverable) => deliverable.obligations.length > 0)
    : draftDeliverables;
  const requiredCount = governedDeliverables.reduce((count, deliverable) =>
    count + (deliverable.required
      ? deliverable.obligations.filter((obligation) => obligation.value.required).length
      : 0), 0);
  if (requiredCount === 0 || requiredCount > 6) {
    return { activated: false, reason: "requirement_limit_exceeded" };
  }

  const policies: AnswerCardObligationPolicy[] = [];
  let obligationIndex = 0;
  const candidate = {
    ...input.taskSpec,
    deliverables: governedDeliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((draft) => {
        obligationIndex += 1;
        const id = `O${obligationIndex}`;
        if (draft.cardBinding !== undefined) {
          policies.push(Object.freeze({
            obligationId: id,
            cardId: draft.cardBinding.cardId,
            cardObligationId: draft.cardBinding.cardObligationId,
            requiredConcepts: Object.freeze([...draft.cardBinding.requiredConcepts]),
            forbiddenClaims: Object.freeze([...draft.cardBinding.forbiddenClaims]),
            preferredEvidencePaths: Object.freeze([
              ...draft.cardBinding.preferredEvidencePaths,
            ]),
            ...(draft.cardBinding.answerTemplate === undefined
              ? {}
              : { answerTemplate: draft.cardBinding.answerTemplate }),
          }));
        }
        return { ...draft.value, id };
      }),
    })),
  };
  const parsed = taskSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return { activated: false, reason: "task_spec_contract_exceeded" };
  }
  const guard = new DeterministicTaskSpecGuard().validate({
    resolvedQuestion: input.resolvedQuestion,
    taskSpec: parsed.data,
  });
  if (!guard.ok) return { activated: false, reason: "guard_rejected" };
  return {
    activated: true,
    taskSpec: parsed.data,
    guard,
    policies: Object.freeze(policies),
  };
}

export function applyAnswerCardPoliciesToPlan(input: {
  readonly plan: KnowledgePlan;
  readonly obligationIds: readonly string[];
  readonly policies: readonly AnswerCardObligationPolicy[];
}): KnowledgePlan {
  const policyByObligation = new Map(
    input.policies.map((policy) => [policy.obligationId, policy] as const),
  );
  const candidate = {
    subject: input.plan.subject,
    requirements: input.plan.requirements.map((requirement, index) => {
      const policy = policyByObligation.get(input.obligationIds[index] ?? "");
      if (policy === undefined || policy.requiredConcepts.length === 0) {
        return requirement;
      }
      const evidenceAspects = requirement.evidenceAspects.map((aspect, aspectIndex) =>
        aspectIndex !== 0
          ? aspect
          : {
              ...aspect,
              terms: stableSemanticText([
                ...aspect.terms,
                ...policy.requiredConcepts,
              ]).filter((term) => [...term].length <= 128).slice(0, 8),
            });
      const expandedQuery = [requirement.question, ...policy.requiredConcepts]
        .join(" ")
        .trim();
      const queries = [...requirement.queries];
      if (
        [...expandedQuery].length <= 1_024 &&
        !queries.some((query) => normalizeText(query.text) === normalizeText(expandedQuery)) &&
        queries.length < 3
      ) {
        queries.push({ text: expandedQuery, aspectIds: ["A1"] });
      }
      return { ...requirement, evidenceAspects, queries };
    }),
  };
  const parsed = knowledgePlanSchema.safeParse(candidate);
  return parsed.success
    ? {
        ...parsed.data,
        ...(input.plan.retrievalStrategy === undefined
          ? {}
          : { retrievalStrategy: input.plan.retrievalStrategy }),
      }
    : input.plan;
}

function applyBinding(
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
  binding: AnswerCardMatchBinding,
): TaskSpec["deliverables"][number]["obligations"][number] {
  return {
    ...obligation,
    label: binding.label,
    required: binding.required,
    evidencePolicy: binding.evidencePolicy,
    evidenceCondition: binding.evidencePolicy === "customer_input"
      ? obligation.evidenceCondition?.inputState === "available"
        ? obligation.evidenceCondition
        : {
            inputState: "missing",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_assessed",
          }
      : {
          inputState: "not_applicable",
          ambiguous: obligation.evidenceCondition?.ambiguous ?? false,
          conflictDetected: obligation.evidenceCondition?.conflictDetected ?? false,
          freshness: obligation.evidenceCondition?.freshness ?? "not_assessed",
        },
    domains: taskDomainsForBinding(binding),
  };
}

function taskDomainsForBinding(
  binding: AnswerCardMatchBinding,
): KnowledgeDomain[] {
  // Customer-specific facts are never retrieved as product facts. They are
  // collected through the general presales input boundary even when the card
  // itself belongs to the professional product domain.
  return binding.evidencePolicy === "customer_input"
    ? ["presales-general"]
    : [...binding.domains] as KnowledgeDomain[];
}

function obligationSimilarity(
  binding: AnswerCardMatchBinding,
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): number {
  const candidate = normalizeText(`${obligation.label}${obligation.sourceText}`);
  const terms = [binding.label, ...binding.requiredConcepts]
    .map(normalizeText)
    .filter((term) => term.length >= 2);
  return terms.reduce((score, term) =>
    score + (candidate.includes(term) || term.includes(candidate) ? term.length : 0), 0);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function stableSemanticText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedSourceText(primary: string, fallback: string): string {
  const value = primary.trim() || fallback.trim();
  return [...value].slice(0, 512).join("");
}

function boundedText(value: string, limit: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  return [...normalized].slice(0, limit).join("");
}
