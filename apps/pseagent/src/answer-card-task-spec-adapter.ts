import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type {
  AnswerCardMatch,
  AnswerCardMatchBinding,
} from "./answer-card-matcher.js";
import { analyzeObligationSource } from "./obligation-semantics.js";
import type { ResolvedQuestion } from "./question-resolver.js";
import { knowledgePlanSchema, type KnowledgePlan } from "./contracts.js";
import {
  DeterministicTaskSpecGuard,
  extractExplicitQuestionSignals,
  requiresMixedKnowledgeDomains,
  taskSpecSchema,
  type TaskSpec,
  type TaskSpecGuardResult,
  type TaskSpecIssueCode,
} from "./task-spec.js";

export interface AnswerCardObligationPolicy {
  readonly obligationId: string;
  readonly label: string;
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
        | "binding_unmapped"
        | "requirement_limit_exceeded"
        | "task_spec_contract_exceeded"
        | "guard_rejected";
      readonly issueCodes?: readonly TaskSpecIssueCode[];
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
  return compileSingleCardAnswerCardTaskSpec(input);
}

export function compileIndependentFamilyAnswerCardTaskSpec(input: {
  readonly match: Exclude<AnswerCardMatch, { matchType: "none" }>;
  readonly resolvedQuestion: ResolvedQuestion;
}): AnswerCardTaskSpecAdapterResult {
  if (!canCompileIndependentFamily(input.match, input.resolvedQuestion)) {
    return {
      activated: false,
      reason: "guard_rejected",
      issueCodes: ["explicit_request_unmapped"],
    };
  }
  return compileSingleCardAnswerCardTaskSpec(input);
}

function compileSingleCardAnswerCardTaskSpec(input: {
  readonly match: Exclude<AnswerCardMatch, { matchType: "none" }>;
  readonly resolvedQuestion: ResolvedQuestion;
}): AnswerCardTaskSpecAdapterResult {
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
        ...compiledCardObligationPolicy(
          binding,
          question,
          input.match.matchType === "family" && !input.resolvedQuestion.contextUsed,
        ),
        id: `O${index + 1}`,
        label: binding.label,
        targetEntityIds: ["E1"],
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
    label: binding.label,
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
  cardBindingIndex?: number;
}

interface DraftObligationLocation {
  readonly deliverableIndex: number;
  readonly obligationIndex: number;
  readonly obligation: DraftObligation;
}

export function adaptAnswerCardToTaskSpec(input: {
  readonly match: AnswerCardMatch;
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
}): AnswerCardTaskSpecAdapterResult {
  if (input.match.matchType === "none") {
    return { activated: false, reason: "match_not_active" };
  }
  if (input.match.matchType === "exact") {
    return compileExactAnswerCardTaskSpec({
      match: input.match,
      resolvedQuestion: input.resolvedQuestion,
    });
  }
  if (canCompileWholeFamily(input.match, input.resolvedQuestion, input.taskSpec)) {
    return compileSingleCardAnswerCardTaskSpec({
      match: input.match,
      resolvedQuestion: input.resolvedQuestion,
    });
  }
  const draftDeliverables = input.taskSpec.deliverables.map((deliverable) => ({
    ...deliverable,
    obligations: deduplicateEquivalentModelObligations(deliverable.obligations)
      .map((obligation): DraftObligation => ({ value: obligation })),
  }));
  const requiredLocations = draftDeliverables.flatMap((deliverable, deliverableIndex) =>
    !deliverable.required
      ? []
      : deliverable.obligations.flatMap((obligation, obligationIndex) =>
          obligation.value.required
            ? [{ deliverableIndex, obligationIndex, obligation }]
            : []));
  const contextualBindingIndexes = selectContextualBindingIndexes(
    input.match,
    input.resolvedQuestion,
    requiredLocations,
  );
  const used = new Set<DraftObligation>();
  const requiredBindingCount = input.match.bindings.filter((binding, index) =>
    binding.required &&
    (contextualBindingIndexes === undefined || contextualBindingIndexes.has(index))).length;
  const singleRequiredBinding = requiredBindingCount === 1;

  for (const [bindingIndex, binding] of input.match.bindings.entries()) {
    if (
      !binding.required ||
      (contextualBindingIndexes !== undefined && !contextualBindingIndexes.has(bindingIndex))
    ) continue;
    const overlayLocations = requiredLocations.filter((location) =>
      !used.has(location.obligation) &&
      bindingCanOverlay(binding, location.obligation.value));
    const selected = selectBindingLocation(binding, overlayLocations) ??
      (requiredLocations.length === 1 ? overlayLocations[0] : undefined);
    if (selected !== undefined) {
      if (!bindingPolicyMatches(binding, selected.obligation.value)) {
        selected.obligation.value = createCardObligation(
          selected.obligation.value,
          binding,
        );
      }
      selected.obligation.cardBinding = binding;
      selected.obligation.cardBindingIndex = bindingIndex;
      used.add(selected.obligation);
      continue;
    }

    const source = selectBindingLocation(binding, requiredLocations) ??
      (requiredLocations.length === 1 ? requiredLocations[0] : undefined) ??
      (input.match.matchType === "family" && input.match.confidence === "high" && requiredBindingCount > 1
        ? selectSingleDeliverableGovernedAnchor(binding, requiredLocations)
        : undefined);
    if (source === undefined) {
      if (canCompileContextualFamily(input.match, input.resolvedQuestion)) {
        return compileSingleCardAnswerCardTaskSpec({
          match: input.match,
          resolvedQuestion: input.resolvedQuestion,
        });
      }
      return { activated: false, reason: "binding_unmapped" };
    }
    if (
      singleRequiredBinding &&
      !used.has(source.obligation) &&
      binding.evidencePolicy !== "customer_input" &&
      source.obligation.value.evidencePolicy !== "customer_input"
    ) {
      source.obligation.value = createCardObligation(source.obligation.value, binding);
      source.obligation.cardBinding = binding;
      source.obligation.cardBindingIndex = bindingIndex;
      used.add(source.obligation);
      continue;
    }
    const targetDeliverable = draftDeliverables[source.deliverableIndex]!;
    targetDeliverable.obligations.push({
      value: createCardObligation(source.obligation.value, binding),
      cardBinding: binding,
      cardBindingIndex: bindingIndex,
    });
  }

  const governedDeliverables = draftDeliverables;
  const requiredCount = governedDeliverables.reduce((count, deliverable) =>
    count + (deliverable.required
      ? deliverable.obligations.filter((obligation) => obligation.value.required).length
      : 0), 0);
  if (requiredCount === 0 || requiredCount > 6) {
    if (canCompileContextualFamily(input.match, input.resolvedQuestion)) {
      return compileSingleCardAnswerCardTaskSpec({ match: input.match, resolvedQuestion: input.resolvedQuestion });
    }
    return { activated: false, reason: "requirement_limit_exceeded" };
  }

  const policyEntries: Array<{
    readonly bindingIndex: number;
    readonly policy: AnswerCardObligationPolicy;
  }> = [];
  let obligationIndex = 0;
  const candidate = {
    ...input.taskSpec,
    deliverables: governedDeliverables.map((deliverable) => ({
      ...deliverable,
      obligations: deliverable.obligations.map((draft) => {
        obligationIndex += 1;
        const id = `O${obligationIndex}`;
        if (draft.cardBinding !== undefined) {
          policyEntries.push({
            bindingIndex: draft.cardBindingIndex ?? Number.MAX_SAFE_INTEGER,
            policy: Object.freeze({
              obligationId: id,
              label: contextualBindingIndexes === undefined
                ? draft.cardBinding.label
                : draft.value.label,
              cardId: draft.cardBinding.cardId,
              cardObligationId: draft.cardBinding.cardObligationId,
              requiredConcepts: Object.freeze([...draft.cardBinding.requiredConcepts]),
              forbiddenClaims: Object.freeze([...draft.cardBinding.forbiddenClaims]),
              preferredEvidencePaths: Object.freeze([
                ...draft.cardBinding.preferredEvidencePaths,
              ]),
              ...(contextualBindingIndexes !== undefined ||
                  draft.cardBinding.answerTemplate === undefined
                ? {}
                : { answerTemplate: draft.cardBinding.answerTemplate }),
            }),
          });
        }
        return { ...draft.value, id };
      }),
    })),
  };
  const parsed = taskSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    if (canCompileContextualFamily(input.match, input.resolvedQuestion)) {
      return compileSingleCardAnswerCardTaskSpec({ match: input.match, resolvedQuestion: input.resolvedQuestion });
    }
    return { activated: false, reason: "task_spec_contract_exceeded" };
  }
  const rawGuard = new DeterministicTaskSpecGuard().validate({
    resolvedQuestion: input.resolvedQuestion,
    taskSpec: parsed.data,
  });
  const governedPolicyByObligationId = new Map(
    policyEntries.map((entry) => [entry.policy.obligationId, entry.policy] as const),
  );
  const governedObligationIds = new Set(governedPolicyByObligationId.keys());
  const rawTrustedIssues = rawGuard.issues.filter((issue) =>
    issue.code !== "protected_fact_not_direct" ||
    issue.obligationId === undefined ||
    !governedObligationIds.has(issue.obligationId));
  const rawUnmappedRequestCount = rawTrustedIssues.filter((issue) =>
    issue.code === "explicit_request_unmapped").length;
  const explicitRequestClauses = rawUnmappedRequestCount === 0
    ? []
    : extractExplicitQuestionSignals(input.resolvedQuestion.rawQuestion).requestClauses;
  // The assisted pass may only replace explicit-request mapping issues. Entity,
  // source, evidence, and protected-fact decisions always remain from rawGuard.
  const labelAssistedGuard = rawUnmappedRequestCount === 0
    ? undefined
    : new DeterministicTaskSpecGuard().validate({
        resolvedQuestion: input.resolvedQuestion,
        taskSpec: {
          ...parsed.data,
          deliverables: parsed.data.deliverables.map((deliverable) => ({
            ...deliverable,
            obligations: deliverable.obligations.map((obligation) => {
              const policy = governedPolicyByObligationId.get(obligation.id);
              const trustedClauses = policy === undefined
                ? []
                : explicitRequestClauses.filter((clause) =>
                    trustedCardClauseMatches(clause, policy));
              return policy !== undefined
                ? {
                    ...obligation,
                    sourceText: trustedCardSourceText(
                      obligation.sourceText,
                      policy,
                      trustedClauses,
                    ),
                  }
                : obligation;
            }),
          })),
        },
      });
  const assistedUnmappedRequestIssues = labelAssistedGuard?.issues.filter((issue) =>
    issue.code === "explicit_request_unmapped") ?? [];
  const usedLabelAssistance = labelAssistedGuard !== undefined &&
    assistedUnmappedRequestIssues.length < rawUnmappedRequestCount;
  const trustedIssues = usedLabelAssistance
    ? [
        ...rawTrustedIssues.filter((issue) => issue.code !== "explicit_request_unmapped"),
        ...assistedUnmappedRequestIssues,
      ]
    : rawTrustedIssues;
  const guardMetrics = usedLabelAssistance ? labelAssistedGuard : rawGuard;
  const guard: TaskSpecGuardResult = trustedIssues.length === rawGuard.issues.length &&
      !usedLabelAssistance
    ? rawGuard
    : Object.freeze({
        ...rawGuard,
        explicitRequestCount: guardMetrics.explicitRequestCount,
        mappedExplicitRequestCount: guardMetrics.mappedExplicitRequestCount,
        ok: !trustedIssues.some((issue) => issue.severity === "error"),
        issues: Object.freeze(trustedIssues),
      });
  if (!guard.ok) {
    if (canCompileContextualFamily(input.match, input.resolvedQuestion)) {
      return compileSingleCardAnswerCardTaskSpec({ match: input.match, resolvedQuestion: input.resolvedQuestion });
    }
    return {
      activated: false,
      reason: "guard_rejected",
      issueCodes: Object.freeze([...new Set(guard.issues.map((issue) => issue.code))]),
    };
  }
  const policies = policyEntries
    .sort((left, right) => left.bindingIndex - right.bindingIndex)
    .map((entry) => entry.policy);
  return {
    activated: true,
    taskSpec: parsed.data,
    guard,
    policies: Object.freeze(policies),
  };
}

function canCompileContextualFamily(
  match: Exclude<AnswerCardMatch, { matchType: "none" }>,
  resolvedQuestion: ResolvedQuestion,
): boolean {
  if (!(match.matchType === "family" &&
    match.confidence === "high" &&
    resolvedQuestion.contextUsed &&
    new Set(match.bindings.map((binding) => binding.cardId)).size === 1)) return false;
  if (match.contextual === true) return true;
  const requestClauses=extractExplicitQuestionSignals(
    resolvedQuestion.standaloneQuestion,
  ).requestClauses;
  return requestClauses.every((clause) =>
    match.bindings.some((binding) => trustedCardClauseMatches(clause, binding)));
}

function canCompileWholeFamily(
  match: Exclude<AnswerCardMatch, { matchType: "none" }>,
  resolvedQuestion: ResolvedQuestion,
  taskSpec: TaskSpec,
): boolean {
  if (requiresMixedKnowledgeDomains(resolvedQuestion.standaloneQuestion)) return false;
  if (canCompileIndependentFamily(match, resolvedQuestion)) return true;
  if (!(match.matchType === "family" &&
    match.confidence === "high" &&
    !resolvedQuestion.contextUsed &&
    new Set(match.bindings.map((binding) => binding.cardId)).size === 1)) return false;
  const requestClauses = extractExplicitQuestionSignals(
    resolvedQuestion.standaloneQuestion,
  ).requestClauses;
  // Keep the old overlay check only for questions from which no explicit
  // request clause can be recovered.
  if (requestClauses.length > 0) return false;
  return taskSpec.deliverables.every((deliverable) =>
    !deliverable.required || deliverable.obligations.every((obligation) =>
      !obligation.required || match.bindings.some((binding) =>
        bindingCanOverlay(binding, obligation) &&
        obligationSimilarity(binding, obligation) > 0)));
}

function canCompileIndependentFamily(
  match: Exclude<AnswerCardMatch, { matchType: "none" }>,
  resolvedQuestion: ResolvedQuestion,
): boolean {
  if (requiresMixedKnowledgeDomains(resolvedQuestion.standaloneQuestion)) return false;
  if (!(match.matchType === "family" &&
    match.confidence === "high" &&
    !resolvedQuestion.contextUsed &&
    new Set(match.bindings.map((binding) => binding.cardId)).size === 1)) return false;
  const requestClauses = extractExplicitQuestionSignals(
    resolvedQuestion.standaloneQuestion,
  ).requestClauses;
  return requestClauses.length > 0 && requestClauses.every((clause) =>
    match.bindings.some((binding) => trustedCardClauseMatches(clause, binding)) ||
    isGenericCardRequestClause(clause) ||
    isTrustedCardSituationClause(clause));
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
      const governedQuestion = boundedText(
        policy.label,
        1_024,
        requirement.question,
      );
      const evidenceAspects = requirement.evidenceAspects.map((aspect, aspectIndex) =>
        aspectIndex !== 0
          ? aspect
          : {
              ...aspect,
              label: boundedText(policy.label, 256, aspect.label),
              terms: stableSemanticText([
                policy.label,
                ...policy.requiredConcepts,
                ...aspect.terms,
              ]).filter((term) => [...term].length <= 128).slice(0, 8),
            });
      const expandedQuery = [
        requirement.question,
        policy.label,
        ...policy.requiredConcepts,
      ]
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
      return {
        ...requirement,
        question: governedQuestion,
        evidenceAspects,
        queries,
      };
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

function selectContextualBindingIndexes(
  match: Exclude<AnswerCardMatch, { matchType: "none" }>,
  resolvedQuestion: ResolvedQuestion,
  locations: readonly DraftObligationLocation[],
): ReadonlySet<number> | undefined {
  if (!resolvedQuestion.contextUsed || match.matchType !== "family") return undefined;
  if (asksForWholeCardContract(resolvedQuestion.standaloneQuestion)) return undefined;
  const resolvedFocus = resolvedQuestion.standaloneQuestion;
  const selected = new Set<number>();
  for (const [index, binding] of match.bindings.entries()) {
    if (!binding.required) continue;
    if (
      trustedCardClauseMatches(resolvedFocus, binding) ||
      locations.some((location) => trustedCardClauseMatches(
        `${location.obligation.value.label}；${location.obligation.value.sourceText}`,
        binding,
      ))
    ) selected.add(index);
  }
  // If the compiler did not preserve enough semantic detail to select a safe
  // subset, retain the existing whole-card fallback instead of guessing.
  return selected.size === 0 ? undefined : selected;
}

function asksForWholeCardContract(question: string): boolean {
  if (/(?:第[一二三四五六七八九十\d]+(?:项|点|条)|这一项|该项|某一项|单项)/u.test(question)) {
    return false;
  }
  return /(?:哪些|什么|全部|所有|完整).{0,8}(?:条件|标准|步骤|要求)|具备资格.{0,16}(?:进入|开始|推进)/u
    .test(question);
}

function createCardObligation(
  source: TaskSpec["deliverables"][number]["obligations"][number],
  binding: AnswerCardMatchBinding,
): TaskSpec["deliverables"][number]["obligations"][number] {
  return {
    ...source,
    label: binding.label,
    required: binding.required,
    evidencePolicy: binding.evidencePolicy,
    evidenceCondition: binding.evidencePolicy === "customer_input"
      ? source.evidenceCondition?.inputState === "available"
        ? source.evidenceCondition
        : {
            inputState: "missing",
            ambiguous: false,
            conflictDetected: false,
            freshness: "not_assessed",
          }
      : {
          inputState: "not_applicable",
          ambiguous: source.evidenceCondition?.ambiguous ?? false,
          conflictDetected: source.evidenceCondition?.conflictDetected ?? false,
          freshness: source.evidenceCondition?.freshness ?? "not_assessed",
        },
    domains: taskDomainsForBinding(binding),
  };
}

function compiledCardObligationPolicy(
  binding: AnswerCardMatchBinding,
  sourceText: string,
  allowAdvisorySynthesis: boolean,
): Pick<
  TaskSpec["deliverables"][number]["obligations"][number],
  "evidencePolicy" | "evidenceCondition" | "domains"
> {
  const currentCaseInputRequested = binding.evidencePolicy === "customer_input" &&
    analyzeObligationSource(sourceText).customerInputEligible;
  if (
    allowAdvisorySynthesis &&
    binding.evidencePolicy === "customer_input" &&
    !currentCaseInputRequested
  ) {
    return {
      evidencePolicy: "synthesis",
      evidenceCondition: {
        inputState: "not_applicable",
        ambiguous: false,
        conflictDetected: false,
        freshness: "not_assessed",
      },
      domains: [...binding.domains] as KnowledgeDomain[],
    };
  }
  return {
    evidencePolicy: binding.evidencePolicy,
    evidenceCondition: {
      inputState: binding.evidencePolicy === "customer_input"
        ? "missing"
        : "not_applicable",
      ambiguous: false,
      conflictDetected: false,
      freshness: "not_assessed",
    },
    domains: taskDomainsForBinding(binding),
  };
}

function bindingCanOverlay(
  binding: AnswerCardMatchBinding,
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): boolean {
  const bindingDomains = taskDomainsForBinding(binding);
  return binding.evidencePolicy === obligation.evidencePolicy &&
    bindingDomains.every((domain) => obligation.domains.includes(domain));
}

function bindingPolicyMatches(
  binding: AnswerCardMatchBinding,
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): boolean {
  const bindingDomains = taskDomainsForBinding(binding);
  return binding.evidencePolicy === obligation.evidencePolicy &&
    bindingDomains.length === obligation.domains.length &&
    bindingDomains.every((domain) => obligation.domains.includes(domain));
}

function selectBindingLocation(
  binding: AnswerCardMatchBinding,
  locations: readonly DraftObligationLocation[],
): DraftObligationLocation | undefined {
  const ranked = locations.map((location) => ({
    location,
    semanticScore: obligationSimilarity(binding, location.obligation.value),
    evidenceRoleScore: evidenceRoleSimilarity(binding, location.obligation.value),
    domainScore: domainSimilarity(binding, location.obligation.value),
  })).sort((left, right) =>
    right.semanticScore - left.semanticScore ||
    right.evidenceRoleScore - left.evidenceRoleScore ||
    right.domainScore - left.domainScore);
  const first = ranked[0];
  if (first === undefined) return undefined;
  if (first.semanticScore > 0) {
    const second = ranked[1];
    return second !== undefined &&
        second.semanticScore === first.semanticScore &&
        second.evidenceRoleScore === first.evidenceRoleScore &&
        second.domainScore === first.domainScore
      ? undefined
      : first.location;
  }
  const roleCompatible = ranked.filter((candidate) =>
    candidate.evidenceRoleScore >= 2 && candidate.domainScore > 0);
  return roleCompatible.length === 1 ? roleCompatible[0]!.location : undefined;
}

function selectSingleDeliverableGovernedAnchor(
  binding: AnswerCardMatchBinding,
  locations: readonly DraftObligationLocation[],
): DraftObligationLocation | undefined {
  if (binding.evidencePolicy === "customer_input") return undefined;
  const bindingDomains = taskDomainsForBinding(binding);
  const eligible = locations.filter((location) =>
    location.obligation.value.evidencePolicy !== "customer_input" &&
    bindingDomains.some((domain) => location.obligation.value.domains.includes(domain)));
  if (eligible.length === 0 || new Set(eligible.map((item) => item.deliverableIndex)).size !== 1) {
    return undefined;
  }
  return eligible[0];
}

function deduplicateEquivalentModelObligations(
  obligations: readonly TaskSpec["deliverables"][number]["obligations"][number][],
): TaskSpec["deliverables"][number]["obligations"][number][] {
  const seenRequired = new Set<string>();
  return obligations.filter((obligation) => {
    if (!obligation.required) return true;
    const key = JSON.stringify({
      sourceText: normalizeText(obligation.sourceText),
      evidencePolicy: obligation.evidencePolicy,
      domains: [...obligation.domains].sort(),
      targetEntityIds: [...obligation.targetEntityIds].sort(),
    });
    if (seenRequired.has(key)) return false;
    seenRequired.add(key);
    return true;
  });
}

function evidenceRoleSimilarity(
  binding: AnswerCardMatchBinding,
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): number {
  if (binding.evidencePolicy === obligation.evidencePolicy) return 2;
  return binding.evidencePolicy === "direct" &&
      obligation.evidencePolicy === "customer_input"
    ? 1
    : 0;
}

function domainSimilarity(
  binding: AnswerCardMatchBinding,
  obligation: TaskSpec["deliverables"][number]["obligations"][number],
): number {
  const domains = taskDomainsForBinding(binding);
  if (domains.every((domain) => obligation.domains.includes(domain))) return 2;
  return domains.some((domain) => obligation.domains.includes(domain)) ? 1 : 0;
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
  return terms.reduce((score, term) => {
    if (candidate.includes(term) || term.includes(candidate)) {
      return score + term.length * 2;
    }
    const candidateBigrams = meaningfulBigrams(candidate);
    const termBigrams = meaningfulBigrams(term);
    const overlap = [...termBigrams].filter((item) => candidateBigrams.has(item)).length;
    return score + overlap;
  }, 0);
}

const GENERIC_SEMANTIC_BIGRAMS = new Set([
  "如何",
  "什么",
  "哪些",
  "说明",
  "给出",
  "当前",
  "问题",
  "相关",
]);

function meaningfulBigrams(value: string): ReadonlySet<string> {
  const characters = [...value];
  if (characters.length < 2) return new Set();
  return new Set(characters.slice(0, -1)
    .map((character, index) => `${character}${characters[index + 1] ?? ""}`)
    .filter((bigram) => !GENERIC_SEMANTIC_BIGRAMS.has(bigram)));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function trustedCardSourceText(
  sourceText: string,
  policy: Pick<AnswerCardObligationPolicy, "label" | "requiredConcepts">,
  trustedClauses: readonly string[],
): string {
  const trustedTerms = stableSemanticText([
    ...trustedClauses,
    policy.label,
    ...policy.requiredConcepts,
    sourceText,
  ]);
  return [...trustedTerms.join("；")].slice(0, 512).join("");
}

const TRUSTED_REQUEST_SCAFFOLD_PATTERN =
  /(?:哪些|什么|如何|怎么|怎样|接下来|还要|需要|后续|对齐|确认|判断|检查|核对|说明|给出|列出)/gu;

const GENERIC_CARD_REQUEST_CLAUSE_PATTERN =
  /^(?:我(?:们)?|你(?:们)?|该|应该|应当|可以|能否|是否|怎么|如何|怎样|办|接下来|后续|然后|再|要|需要|汇报|核验|确认|检查|处理|安排|推进|说明|给出|列出|什么|哪些)+$/u;

function isGenericCardRequestClause(clause: string): boolean {
  const core = normalizeText(clause).replace(
    /^(?:(?:这种|上述|当前|该)(?:情况|情形|场景|问题)(?:之?下)?)/u,
    "",
  );
  return GENERIC_CARD_REQUEST_CLAUSE_PATTERN.test(core);
}

function isTrustedCardSituationClause(clause: string): boolean {
  return /^(?:但|可是|不过|而且)?(?:什么|任何|相关)?(?:客户)?(?:背景|信息|资料|事实|证据)(?:都|也)?(?:没有|缺少|不足|不全|未知|拿不到|获取不到)$/u
    .test(normalizeText(clause));
}

function trustedCardClauseMatches(
  clause: string,
  policy: Pick<AnswerCardObligationPolicy, "label" | "requiredConcepts">,
): boolean {
  const core = normalizeText(clause).replace(TRUSTED_REQUEST_SCAFFOLD_PATTERN, "");
  if ([...core].length < 2) return false;
  return [policy.label, ...policy.requiredConcepts].some((term) =>
    trustedSemanticOverlap(core, term));
}

function trustedSemanticOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const leftBigrams = meaningfulBigrams(normalizedLeft);
  const rightBigrams = meaningfulBigrams(normalizedRight);
  const smallerSize = Math.min(leftBigrams.size, rightBigrams.size);
  if (smallerSize === 0) return false;
  const intersection = [...leftBigrams].filter((item) => rightBigrams.has(item)).length;
  return intersection >= Math.min(2, smallerSize) && intersection / smallerSize >= 0.5;
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

function boundedText(value: string, limit: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  return [...normalized].slice(0, limit).join("");
}
