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

export function answerCardRequirementsWithGroundedConcepts(
  bindings: readonly DomainRequirementBinding[] = [],
  evidence: readonly AnswerCardPolicyEvidence[] = [],
): readonly string[] {
  const requirementIds = new Set<string>();
  for (const binding of bindings) {
    const preferredPaths = new Set(binding.preferredEvidencePaths ?? []);
    if (preferredPaths.size === 0) continue;
    const grounded = groundedConcepts(
      binding.requiredConcepts ?? [],
      evidence.filter((document) =>
        document.requirementId === binding.requirementId &&
        preferredPaths.has(document.path)),
    );
    if (grounded.length > 0) requirementIds.add(binding.requirementId);
  }
  return Object.freeze([...requirementIds]);
}

export function missingAnswerCardRequiredConcepts(
  action: FinalAction,
  bindings: readonly DomainRequirementBinding[] = [],
  evidence?: readonly AnswerCardPolicyEvidence[],
): readonly MissingAnswerCardConcepts[] {
  const requirementById = new Map(action.requirements.map((requirement) => [
    requirement.id,
    requirement,
  ] as const));
  const finalAnswer = normalizePolicyText(action.requirements
    .filter((requirement) => requirement.coverage !== "none")
    .flatMap((requirement) => [
      requirement.answer,
      ...(requirement.relatedContext ?? []).map((item) => item.statement),
    ])
    .join(" "));
  return bindings.flatMap((binding) => {
    const declaredConcepts = binding.requiredConcepts ?? [];
    const grounded = evidence === undefined
      ? []
      : groundedConcepts(
          declaredConcepts,
          evidence.filter((document) =>
            document.requirementId === binding.requirementId &&
            (binding.preferredEvidencePaths ?? []).includes(document.path)),
        ).map((item) => normalizePolicyText(item.concept));
    const requiredConcepts = evidence === undefined || binding.answerTemplate === undefined
      ? declaredConcepts
      : declaredConcepts.filter((concept) =>
          grounded.includes(normalizePolicyText(concept)));
    if (requiredConcepts.length === 0) return [];
    const requirement = requirementById.get(binding.requirementId);
    // A not-covered obligation must remain evidence-safe. Requiring a governed
    // concept here would force the final answer to imply support that the
    // verifier explicitly did not retain.
    if (requirement?.coverage === "none") return [];
    const missing = requiredConcepts.filter((concept) => {
      const normalized = normalizePolicyText(concept);
      return normalized.length > 0 && !finalAnswer.includes(normalized);
    });
    return missing.length === 0 ? [] : [{
      requirementId: binding.requirementId,
      requiredConcepts: Object.freeze(missing),
    }];
  });
}

/**
 * Project a complete fact from governed evidence after natural rewrite attempts
 * are exhausted. A fact is added only when the missing concept occurs in a
 * preferred evidence page that was actually read for the same requirement.
 * Before verification, callers run the verifier over the resulting draft. If
 * a verifier later removes one of these facts, callers may restore the same
 * evidence-identical line and rebuild deterministic verification metadata.
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
  let combinedAnswer = normalizePolicyText(action.requirements
    .filter((requirement) => requirement.coverage !== "none")
    .flatMap((requirement) => [
      requirement.answer,
      ...(requirement.relatedContext ?? []).map((item) => item.statement),
    ])
    .join(" "));
  const appendedFacts = new Set<string>();
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
        if (combinedAnswer.includes(normalizePolicyText(item.concept))) continue;
        const normalizedFact = normalizePolicyText(item.fact);
        if (normalizedFact.length === 0 || appendedFacts.has(normalizedFact)) continue;
        const sentence = groundedSentence(item.fact, item.citation);
        if (sentence === undefined) continue;
        answer = `${answer.trim()} ${sentence}`;
        if (!citations.includes(item.citation)) citations.push(item.citation);
        combinedAnswer += normalizePolicyText(` ${sentence}`);
        appendedFacts.add(normalizedFact);
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
  const answer = action.requirements.flatMap((requirement) => [
      requirement.answer,
      ...(requirement.relatedContext ?? []).map((item) => item.statement),
    ]).join(" ");
  return bindings.some((binding) =>
    (binding.forbiddenClaims ?? []).some((claim) => {
      const normalizedClaim = normalizePolicyText(claim);
      return normalizedClaim.length >= 4 &&
        containsUnnegatedClaim(answer, normalizedClaim);
    }));
}

function containsUnnegatedClaim(answer: string, claim: string): boolean {
  const clauses = answer
    .split(/[。！？!?；;\n]|(?:但|但是|然而|不过)/u)
    .map(normalizePolicyText)
    .filter(Boolean);
  for (const clause of clauses) {
    let index = clause.indexOf(claim);
    while (index >= 0) {
      const prefix = clause.slice(Math.max(0, index - 32), index);
      if (!hasClaimNegationPrefix(prefix)) return true;
      index = clause.indexOf(claim, index + claim.length);
    }
  }
  return false;
}

function hasClaimNegationPrefix(prefix: string): boolean {
  const match = prefix.match(
    /(?:不|未|无|无法|不能|不可|不应|不得|不宜|并非|不代表|尚未|没有)(?:(?:充分|正式|直接|对外|无依据|在合同中|在合同里|任何)*)?(?:(?:证据|资料)(?:能够)?)?(?:承诺|保证|宣称|确认|认定|视为|答应|写死|写入合同|声称|说明|证明|表明|意味着|代表|支持|适用)?$|(?:禁止|拒绝|避免|切勿|勿)(?:直接|对外)?(?:承诺|保证|宣称|确认|认定|视为|答应|写死|写入合同|声称)?$/u,
  );
  if (match === null || match.index === undefined) return false;
  const before = prefix.slice(0, match.index);
  return !/(?:不是|并非|未必)$/u.test(before);
}

export function answerCardPolicyObservations(
  bindings: readonly DomainRequirementBinding[] = [],
): readonly string[] {
  const templates = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.cardId !== undefined && binding.answerTemplate !== undefined) {
      templates.set(binding.cardId, binding.answerTemplate);
    }
  }
  const templateObservations = [...templates].map(([cardId, answerTemplate]) => JSON.stringify({
    type: "answer_card_answer_template",
    cardId,
    answerTemplate,
    instruction: "这是已审批标准答案的组织基线。只使用 readEvidence 正文支持的内容，按当前 requirement 拆分相关段落并重新标注引用；不得遗漏模板中的主流程、关键配置或证据边界。",
  }));
  const policyObservations = bindings.flatMap((binding) => {
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
  return [...templateObservations, ...policyObservations];
}

function normalizePolicyText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function groundedConcepts(
  concepts: readonly string[],
  evidence: readonly AnswerCardPolicyEvidence[],
): readonly { readonly concept: string; readonly citation: number; readonly fact: string }[] {
  const seen = new Set<string>();
  return concepts.flatMap((concept) => {
    const normalizedConcept = normalizePolicyText(concept);
    if (normalizedConcept.length === 0 || seen.has(normalizedConcept)) return [];
    seen.add(normalizedConcept);
    const candidates = evidence.flatMap((document) => {
      const normalizedEvidence = normalizePolicyText(
        `${document.title}\n${document.content}`,
      );
      if (!normalizedEvidence.includes(normalizedConcept)) return [];
      const fact = evidenceFactForConcept(document.content, normalizedConcept);
      return fact === undefined ? [] : [{ concept, citation: document.citation, fact }];
    });
    candidates.sort((left, right) => left.citation - right.citation);
    return candidates.slice(0, 1);
  });
}

function evidenceFactForConcept(content: string, normalizedConcept: string): string | undefined {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  let sectionHeading = "";
  for (const rawLine of lines) {
    const heading = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*$/u)?.[1];
    if (heading !== undefined) {
      sectionHeading = normalizePolicyText(heading);
      continue;
    }
    if (!normalizePolicyText(rawLine).includes(normalizedConcept)) continue;
    const fact = rawLine
      .replace(/^\s*(?:#{1,6}|>|[-*+]\s+|\d+[.)]\s+)/u, "")
      .replace(/^\s*\|?\s*/u, "")
      .replace(/\s*\|?\s*$/u, "")
      .replace(/\s*\|\s*/gu, "；")
      .trim();
    if (fact.length < 4 || /^[-:;；|\s]+$/u.test(fact)) continue;
    const bounded = fact.slice(0, 500);
    return isProhibitedEvidenceSection(sectionHeading) && !startsWithProhibition(bounded)
      ? `不要${bounded}`
      : bounded;
  }
  return undefined;
}

function isProhibitedEvidenceSection(heading: string): boolean {
  return /(?:常见错误|错误做法|错误示例|禁止事项|禁忌|反例|commonmistakes?|antipatterns?)/iu.test(heading);
}

function startsWithProhibition(value: string): boolean {
  return /^(?:不|不要|不得|不能|严禁|禁止|避免|切勿|不可|勿|并非|不应|do\s+not|don't|never|must\s+not)/iu.test(value.trim());
}

function groundedSentence(fact: string, citation: number): string | undefined {
  const clean = fact.replace(/\s+/gu, " ").trim();
  if (clean.length < 4) return undefined;
  return `${clean.replace(/[。！？!?.]$/u, "")} [${citation}]。`;
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
