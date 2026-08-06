import type { FinalAction } from "./contracts.js";
import type { DomainRequirementBinding } from "./domain-plan.js";

export interface MissingAnswerCardConcepts {
  readonly requirementId: string;
  readonly requiredConcepts: readonly string[];
}

export function missingAnswerCardRequiredConcepts(
  action: FinalAction,
  bindings: readonly DomainRequirementBinding[] = [],
): readonly MissingAnswerCardConcepts[] {
  const answerByRequirement = new Map(action.requirements.map((requirement) => [
    requirement.id,
    normalizePolicyText([
      requirement.answer,
      ...(requirement.relatedContext ?? []).map((item) => item.statement),
    ].join(" ")),
  ] as const));
  return bindings.flatMap((binding) => {
    const requiredConcepts = binding.requiredConcepts ?? [];
    if (requiredConcepts.length === 0) return [];
    const answer = answerByRequirement.get(binding.requirementId) ?? "";
    const covered = requiredConcepts.some((concept) => {
      const normalized = normalizePolicyText(concept);
      return normalized.length > 0 && answer.includes(normalized);
    });
    return covered ? [] : [{
      requirementId: binding.requirementId,
      requiredConcepts: Object.freeze([...requiredConcepts]),
    }];
  });
}

export function violatesAnswerCardForbiddenClaims(
  action: FinalAction,
  bindings: readonly DomainRequirementBinding[] = [],
): boolean {
  const bindingByRequirement = new Map(
    bindings.map((binding) => [binding.requirementId, binding] as const),
  );
  return action.requirements.some((requirement) => {
    const forbiddenClaims = bindingByRequirement.get(requirement.id)?.forbiddenClaims ?? [];
    if (forbiddenClaims.length === 0) return false;
    const answer = normalizePolicyText([
      requirement.answer,
      ...(requirement.relatedContext ?? []).map((item) => item.statement),
    ].join(" "));
    return forbiddenClaims.some((claim) => {
      const normalizedClaim = normalizePolicyText(claim);
      return normalizedClaim.length >= 4 &&
        containsUnnegatedClaim(answer, normalizedClaim);
    });
  });
}

function containsUnnegatedClaim(answer: string, claim: string): boolean {
  let index = answer.indexOf(claim);
  while (index >= 0) {
    const prefix = answer.slice(Math.max(0, index - 6), index);
    if (!/(?:不|未|无|无法|不能|并非|不代表|尚未)$/u.test(prefix)) return true;
    index = answer.indexOf(claim, index + claim.length);
  }
  return false;
}

export function answerCardPolicyObservations(
  bindings: readonly DomainRequirementBinding[] = [],
): readonly string[] {
  return bindings.flatMap((binding) => {
    if (
      (binding.requiredConcepts?.length ?? 0) === 0 &&
      (binding.forbiddenClaims?.length ?? 0) === 0
    ) {
      return [];
    }
    return [JSON.stringify({
      type: "answer_card_policy",
      requirementId: binding.requirementId,
      requiredConcepts: binding.requiredConcepts ?? [],
      forbiddenClaims: binding.forbiddenClaims ?? [],
      instruction: "覆盖必要概念；不得输出禁答 claim。仍须只使用已读正式证据。",
    })];
  });
}

function normalizePolicyText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}
