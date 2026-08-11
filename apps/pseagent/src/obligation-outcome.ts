import type { AtomicObligationContract } from "./atomic-obligation.js";
import type {
  AnswerStatus,
  CaseAssessability,
  KnowledgeCoverage,
  PolicyDisposition,
  Reference,
} from "./contracts.js";
import type { BoundClaim } from "./structured-claim.js";

export type ObligationOutcomeState =
  | "complete"
  | "partial"
  | "not_covered"
  | "missing_input"
  | "policy_blocked"
  | "unavailable";

export interface ObligationOutcome {
  readonly obligationId: `O${number}`;
  readonly state: ObligationOutcomeState;
  readonly claims: readonly BoundClaim[];
  readonly gapReason?: string;
}

export interface ObligationAnswerAxes {
  readonly status: AnswerStatus;
  readonly knowledgeCoverage: KnowledgeCoverage;
  readonly caseAssessability: CaseAssessability;
  readonly policyDisposition: PolicyDisposition;
}

export function reduceObligationOutcomes(input: {
  readonly contract: AtomicObligationContract;
  readonly outcomes: readonly ObligationOutcome[];
  readonly policyDisposition?: PolicyDisposition;
}): ObligationAnswerAxes {
  const outcomes = validatedOutcomes(input.contract, input.outcomes);
  const states = outcomes.map((outcome) => outcome.state);
  const completedPolicyRefusal =
    states.every((state) => state === "policy_blocked") &&
    (input.policyDisposition === "refused" || input.policyDisposition === "needs_escalation");
  const status: AnswerStatus = completedPolicyRefusal
    ? "answered"
    : states.every((state) => state === "complete")
      ? "answered"
      : states.every((state) => state === "not_covered")
        ? "not_covered"
        : hasPartialUserValue(outcomes)
          ? "partially_answered"
          : "temporarily_unavailable";
  const knowledgeCoverage = deriveKnowledgeCoverage(outcomes);
  const caseAssessability = deriveCaseAssessability(input.contract, outcomes);
  return Object.freeze({
    status,
    knowledgeCoverage,
    caseAssessability,
    policyDisposition: input.policyDisposition ?? defaultPolicyDisposition(status),
  });
}

export function renderBoundClaims(input: {
  readonly contract: AtomicObligationContract;
  readonly outcomes: readonly ObligationOutcome[];
  readonly references: readonly Reference[];
}): string {
  const outcomes = validatedOutcomes(input.contract, input.outcomes);
  const references = new Map(input.references.map((reference) => [reference.index, reference]));
  const sections = input.contract.obligations.map((obligation, index) => {
    const outcome = outcomes[index]!;
    const lines = outcome.claims.map((claim) => {
      if (claim.obligationId !== obligation.id) {
        throw new Error(`bound_claim_obligation_mismatch:${claim.claimId}:${obligation.id}`);
      }
      const text = normalizeLine(claim.text);
      if (claim.kind === "gap" || claim.support === "gap") {
        if (claim.citationIndexes.length > 0) {
          throw new Error(`gap_claim_must_be_uncited:${claim.claimId}`);
        }
        return `- 资料缺口：${text}`;
      }
      if (claim.citationIndexes.length === 0) {
        throw new Error(`bound_claim_citation_missing:${claim.claimId}`);
      }
      const citationIndexes = stableUnique(claim.citationIndexes);
      for (const citationIndex of citationIndexes) {
        const reference = references.get(citationIndex);
        if (reference === undefined) {
          throw new Error(`bound_claim_reference_missing:${claim.claimId}:${citationIndex}`);
        }
        if (reference.project !== claim.domain) {
          throw new Error(`bound_claim_reference_domain_mismatch:${claim.claimId}:${citationIndex}`);
        }
        if (!claim.evidenceIdentities.includes(reference.contentHash)) {
          throw new Error(`bound_claim_evidence_identity_mismatch:${claim.claimId}:${citationIndex}`);
        }
      }
      return `- ${text}${citationIndexes.map((citation) => `[${citation}]`).join("")}`;
    });
    const gapLine = outcome.gapReason === undefined || outcome.gapReason.trim() === ""
      ? defaultGapLine(outcome.state, lines.length)
      : `- 资料缺口：${normalizeLine(outcome.gapReason)}`;
    if (gapLine !== "" && !lines.includes(gapLine)) lines.push(gapLine);
    if (lines.length === 0) return "";
    return [`### ${obligation.id} ${normalizeLine(obligation.sourceText)}`, ...lines].join("\n");
  });
  return sections.filter(Boolean).join("\n\n");
}

function validatedOutcomes(
  contract: AtomicObligationContract,
  outcomes: readonly ObligationOutcome[],
): readonly ObligationOutcome[] {
  const byId = new Map<string, ObligationOutcome>();
  for (const outcome of outcomes) {
    if (byId.has(outcome.obligationId)) {
      throw new Error(`obligation_outcome_duplicate:${outcome.obligationId}`);
    }
    byId.set(outcome.obligationId, outcome);
  }
  const knownIds = new Set(contract.obligations.map((obligation) => obligation.id));
  for (const outcome of outcomes) {
    if (!knownIds.has(outcome.obligationId)) {
      throw new Error(`obligation_outcome_unknown:${outcome.obligationId}`);
    }
  }
  return Object.freeze(contract.obligations.map((obligation) => {
    const outcome = byId.get(obligation.id);
    if (outcome === undefined) {
      throw new Error(`obligation_outcome_missing:${obligation.id}`);
    }
    for (const claim of outcome.claims) {
      if (claim.obligationId !== obligation.id) {
        throw new Error(`bound_claim_obligation_mismatch:${claim.claimId}:${obligation.id}`);
      }
    }
    return outcome;
  }));
}

function hasPartialUserValue(outcomes: readonly ObligationOutcome[]): boolean {
  return outcomes.some((outcome) =>
    outcome.claims.length > 0 ||
    outcome.state === "complete" ||
    outcome.state === "partial" ||
    outcome.state === "missing_input" ||
    outcome.state === "policy_blocked");
}

function deriveKnowledgeCoverage(
  outcomes: readonly ObligationOutcome[],
): KnowledgeCoverage {
  if (outcomes.every((outcome) => outcome.state === "complete")) return "complete";
  if (outcomes.some((outcome) =>
    outcome.state === "complete" ||
    outcome.state === "partial" ||
    outcome.claims.some((claim) => claim.kind !== "gap" && claim.support !== "gap"))) {
    return "partial";
  }
  return "none";
}

function deriveCaseAssessability(
  contract: AtomicObligationContract,
  outcomes: readonly ObligationOutcome[],
): CaseAssessability {
  const customerInputIds = new Set(contract.obligations
    .filter((obligation) => obligation.evidencePolicy === "customer_input")
    .map((obligation) => obligation.id));
  if (customerInputIds.size === 0) return "not_applicable";
  const customerOutcomes = outcomes.filter((outcome) => customerInputIds.has(outcome.obligationId));
  if (customerOutcomes.some((outcome) => outcome.state === "missing_input")) return "insufficient";
  if (customerOutcomes.some((outcome) =>
    outcome.state === "complete" || outcome.state === "partial")) return "sufficient";
  return "not_applicable";
}

function defaultPolicyDisposition(status: AnswerStatus): PolicyDisposition {
  if (status === "answered") return "allowed";
  if (status === "partially_answered") return "limited";
  if (status === "not_covered") return "refused";
  return "needs_escalation";
}

function defaultGapLine(state: ObligationOutcomeState, claimCount: number): string {
  if (state === "not_covered") return "- 资料缺口：正式知识暂未覆盖该义务。";
  if (state === "missing_input") return "- 资料缺口：缺少完成判断所需的客户输入。";
  if (state === "unavailable") return "- 暂时不可用：该义务的处理阶段未能完成。";
  if (state === "policy_blocked") return "- 策略边界：该义务受安全策略限制。";
  if (state === "partial" && claimCount === 0) return "- 资料缺口：该义务只完成了部分处理。";
  return "";
}

function normalizeLine(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function stableUnique(values: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
