import {
  coverageVerificationActionSchema,
  type Coverage,
  type CoverageVerificationAction,
  type FinalAction,
  type KnowledgePlan,
} from "./contracts.js";
import {
  InvalidModelPayloadError,
  type ModelClient,
} from "./model-client.js";
import { coverageVerificationMessages } from "./prompts.js";

export interface CoverageEvidenceDocument {
  readonly requirementId: string;
  readonly citation: number;
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface CoverageVerifierInput {
  readonly question: string;
  readonly plan: KnowledgePlan;
  readonly draft: FinalAction;
  readonly evidence: readonly CoverageEvidenceDocument[];
  readonly model: ModelClient;
  readonly signal?: AbortSignal;
}

export class InvalidCoverageVerificationError extends Error {
  constructor(readonly code = "invalid_coverage_verification") {
    super(code);
    this.name = "InvalidCoverageVerificationError";
  }
}

export async function verifyKnowledgeCoverage(
  input: CoverageVerifierInput,
): Promise<FinalAction> {
  const messages = coverageVerificationMessages({
    question: input.question,
    plan: input.plan,
    draft: input.draft,
    evidence: input.evidence,
  });
  const request = (repair: boolean) => input.model.completeJson({
    messages: repair
      ? [...messages, {
          role: "user" as const,
          content:
            "上一次输出不符合 Schema。只输出合法 verify JSON；逐项保持规划 ID，coverage 不得升级，citations 只能删减且顶层必须等于逐项并集。",
        }]
      : messages,
    schema: coverageVerificationActionSchema,
    schemaDescription: "pse_coverage_verification",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let verified: CoverageVerificationAction;
  try {
    verified = await request(false);
  } catch (error) {
    if (!(error instanceof InvalidModelPayloadError)) throw error;
    try {
      verified = await request(true);
    } catch (repairError) {
      if (repairError instanceof InvalidModelPayloadError) {
        throw new InvalidCoverageVerificationError("invalid_model_payload");
      }
      throw repairError;
    }
  }
  const invalidReason = validateVerification(input, verified);
  if (invalidReason !== undefined) {
    throw new InvalidCoverageVerificationError(invalidReason);
  }
  return {
    action: "final",
    requirements: verified.requirements.map((requirement) => ({
      id: requirement.id,
      coverage: requirement.coverage,
      answer: requirement.answer,
      citations: requirement.citations,
    })),
    citations: verified.citations,
  };
}

const COVERAGE_RANK: Readonly<Record<Coverage, number>> = {
  none: 0,
  partial: 1,
  complete: 2,
};

function validateVerification(
  input: CoverageVerifierInput,
  verified: CoverageVerificationAction,
): string | undefined {
  if (
    input.draft.requirements.length !== input.plan.requirements.length ||
    verified.requirements.length !== input.plan.requirements.length
  ) {
    return "requirement_count_mismatch";
  }

  for (let index = 0; index < input.plan.requirements.length; index += 1) {
    const planned = input.plan.requirements[index]!;
    const draft = input.draft.requirements[index]!;
    const audited = verified.requirements[index]!;
    if (draft.id !== planned.id || audited.id !== planned.id) {
      return "requirement_order_mismatch";
    }
    if (COVERAGE_RANK[audited.coverage] > COVERAGE_RANK[draft.coverage]) {
      return `coverage_upgrade:${audited.id}`;
    }
    if (stableUnique(audited.citations).length !== audited.citations.length) {
      return `duplicate_citation:${audited.id}`;
    }
    const draftCitations = new Set(draft.citations);
    const evidenceCitations = new Set(
      input.evidence
        .filter((document) => document.requirementId === audited.id)
        .map((document) => document.citation),
    );
    for (const citation of audited.citations) {
      if (!draftCitations.has(citation)) {
        return `citation_not_in_draft:${audited.id}:${citation}`;
      }
      if (!evidenceCitations.has(citation)) {
        return `citation_not_in_evidence:${audited.id}:${citation}`;
      }
    }
    const answerCitations = stableUnique(
      [...audited.answer.matchAll(/\[(\d+)\]/gu)]
        .map((match) => Number(match[1])),
    );
    if (!sameNumbers(answerCitations, audited.citations)) {
      return `answer_citation_mismatch:${audited.id}`;
    }
    if (audited.coverage === "none" && audited.citations.length > 0) {
      return `none_with_citation:${audited.id}`;
    }
    if (audited.coverage !== "none" && audited.citations.length === 0) {
      return `covered_without_citation:${audited.id}`;
    }
  }

  const expectedCitations = stableUnique(
    verified.requirements.flatMap((requirement) => requirement.citations),
  );
  if (!sameNumbers(expectedCitations, verified.citations)) {
    return "citation_union_mismatch";
  }
  return undefined;
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
