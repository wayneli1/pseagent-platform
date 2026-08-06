import type { FinalAction } from "./contracts.js";
import type { DomainRequirementBinding } from "./domain-plan.js";

export interface AnswerCardPolicyEvidence {
  readonly requirementId: string;
  readonly citation: number;
  readonly path: string;
  readonly title: string;
  readonly content: string;
}

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
    {
      coverage: requirement.coverage,
      text: normalizePolicyText([
        requirement.answer,
        ...(requirement.relatedContext ?? []).map((item) => item.statement),
      ].join(" ")),
    },
  ] as const));
  return bindings.flatMap((binding) => {
    const requiredConcepts = binding.requiredConcepts ?? [];
    if (requiredConcepts.length === 0) return [];
    const requirement = answerByRequirement.get(binding.requirementId);
    // A not-covered obligation must remain evidence-safe. Requiring a governed
    // concept here would force the final answer to imply support that the
    // verifier explicitly did not retain.
    if (requirement?.coverage === "none") return [];
    const answer = requirement?.text ?? "";
    // The catalog may still contain legacy labels that are not literal evidence
    // terms. Ground every verifiable concept below, while this final liveness
    // gate rejects only an obligation for which no governed concept survived.
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

/**
 * Preserve an approved answer-card concept without asking the model to rewrite
 * the whole answer again. A concept is added only when it occurs verbatim in a
 * preferred evidence page that was actually read for the same requirement.
 * The coverage verifier still audits the resulting claim and may remove it.
 */
export function applyGroundedAnswerCardRequiredConcepts(
  action: FinalAction,
  bindings: readonly DomainRequirementBinding[] = [],
  evidence: readonly AnswerCardPolicyEvidence[] = [],
): FinalAction {
  const bindingsByRequirement = new Map<string, DomainRequirementBinding[]>();
  for (const binding of bindings) {
    const current = bindingsByRequirement.get(binding.requirementId) ?? [];
    current.push(binding);
    bindingsByRequirement.set(binding.requirementId, current);
  }
  const evidenceByRequirement = new Map<string, AnswerCardPolicyEvidence[]>();
  for (const document of evidence) {
    const current = evidenceByRequirement.get(document.requirementId) ?? [];
    current.push(document);
    evidenceByRequirement.set(document.requirementId, current);
  }

  let changed = false;
  const requirements = action.requirements.map((requirement) => {
    if (requirement.coverage === "none") return requirement;
    let answer = requirement.answer;
    let citations = [...requirement.citations];
    const relatedText = (requirement.relatedContext ?? [])
      .map((item) => item.statement)
      .join(" ");
    for (const binding of bindingsByRequirement.get(requirement.id) ?? []) {
      const preferredPaths = new Set(binding.preferredEvidencePaths ?? []);
      if (preferredPaths.size === 0) continue;
      const grounded = groundedConcepts(
        binding.requiredConcepts ?? [],
        (evidenceByRequirement.get(requirement.id) ?? [])
          .filter((document) => preferredPaths.has(document.path)),
      );
      for (const item of grounded) {
        const sentence = groundedSentence(item.concept, item.citation);
        // The verifier may conservatively remove a model-written segment even
        // when that segment happened to contain the required concept. Keep one
        // canonical, directly cited sentence for every governed concept so
        // concept survival never depends on the model's phrasing.
        if (normalizePolicyText(`${answer} ${relatedText}`).includes(normalizePolicyText(sentence))) {
          continue;
        }
        answer = `${answer.trim()} ${sentence}`;
        if (!citations.includes(item.citation)) citations.push(item.citation);
        changed = true;
      }
    }
    return answer === requirement.answer
      ? requirement
      : { ...requirement, answer, citations };
  });
  if (!changed) return action;
  return {
    ...action,
    requirements,
    citations: stableUnique(requirements.flatMap((requirement) => [
      ...requirement.citations,
      ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
    ])),
  };
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

function groundedConcepts(
  concepts: readonly string[],
  evidence: readonly AnswerCardPolicyEvidence[],
): readonly { readonly concept: string; readonly citation: number }[] {
  const seen = new Set<string>();
  return concepts.flatMap((concept) => {
    const normalizedConcept = normalizePolicyText(concept);
    if (normalizedConcept.length === 0 || seen.has(normalizedConcept)) return [];
    seen.add(normalizedConcept);
    const candidates = evidence.flatMap((document) => {
      const normalizedEvidence = normalizePolicyText(
        `${document.title}\n${document.content}`,
      );
      return normalizedEvidence.includes(normalizedConcept)
        ? [{ concept, citation: document.citation }]
        : [];
    });
    candidates.sort((left, right) => left.citation - right.citation);
    return candidates.slice(0, 1);
  });
}

function groundedSentence(concept: string, citation: number): string {
  return `处理原则包括“${concept}”[${citation}]。`;
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
