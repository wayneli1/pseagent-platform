import { z } from "zod";
import {
  coverageVerificationActionSchema,
  coverageVerificationReasonSchema,
  type Coverage,
  type CoverageVerificationAction,
  type CoverageVerificationReason,
  type FinalAction,
  type KnowledgePlan,
} from "./contracts.js";
import {
  InvalidModelPayloadError,
  type ModelClient,
} from "./model-client.js";
import {
  COVERAGE_VERIFICATION_REPAIR_INSTRUCTION,
  coverageVerificationMessages,
} from "./prompts.js";

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
  readonly onVerified?: (
    reasons: readonly {
      readonly id: string;
      readonly reason: CoverageVerificationReason;
    }[],
  ) => void;
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
  const modelResponseSchema = coverageVerificationModelResponseSchema(input.draft);
  const request = (repair: boolean) => input.model.completeJson({
    messages: repair
      ? [...messages, {
          role: "user" as const,
          content: `上一次输出未通过严格 Schema 或确定性校验。只输出合法 verify JSON。
${COVERAGE_VERIFICATION_REPAIR_INSTRUCTION}
逐项保持规划 ID，coverage 不得升级，目标和相关 citations 都只能删减。`,
        }]
      : messages,
    schema: modelResponseSchema,
    schemaDescription: "pse_coverage_verification",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let verified: CoverageVerificationAction | undefined;
  let lastInvalidReason = "invalid_model_payload";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const candidate = await request(attempt > 0);
      const invalidReason = validateVerification(input, candidate);
      if (invalidReason === undefined) {
        verified = candidate;
        break;
      }
      lastInvalidReason = invalidReason;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      lastInvalidReason = "invalid_model_payload";
    }
  }
  if (verified === undefined) {
    throw new InvalidCoverageVerificationError(lastInvalidReason);
  }
  input.onVerified?.(verified.requirements.map((requirement) => ({
    id: requirement.id,
    reason: requirement.reason,
  })));
  return {
    action: "final",
    requirements: verified.requirements.map((requirement) => ({
      id: requirement.id,
      coverage: requirement.coverage,
      answer: requirement.answer,
      citations: requirement.citations,
      ...(requirement.relatedContext === undefined
        ? {}
        : { relatedContext: requirement.relatedContext }),
    })),
    citations: verified.citations,
  };
}

function coverageVerificationModelResponseSchema(draft: FinalAction) {
  return z.preprocess(
    (value) => normalizeModelReasons(value, draft),
    coverageVerificationActionSchema,
  );
}

function normalizeModelReasons(value: unknown, draft: FinalAction): unknown {
  if (!isRecord(value) || !Array.isArray(value.requirements)) return value;
  return {
    ...value,
    requirements: value.requirements.map((requirement) => {
      if (!isRecord(requirement)) return requirement;
      if (coverageVerificationReasonSchema.safeParse(requirement.reason).success) {
        return requirement;
      }
      const matchingDraft = typeof requirement.id === "string"
        ? draft.requirements.find((candidate) => candidate.id === requirement.id)
        : undefined;
      return {
        ...requirement,
        reason: deriveModelReason(requirement, matchingDraft),
      };
    }),
  };
}

function deriveModelReason(
  audited: Readonly<Record<string, unknown>>,
  draft: FinalAction["requirements"][number] | undefined,
): CoverageVerificationReason {
  if (audited.coverage === "complete") return "direct_support";
  if (audited.coverage === "partial") return "partial_support";
  if (
    audited.coverage === "none" &&
    Array.isArray(audited.relatedContext) &&
    audited.relatedContext.length > 0
  ) {
    return "related_only";
  }
  if (audited.coverage === "none" && draft?.coverage !== "none") {
    return "unsupported_claim_removed";
  }
  return "target_omitted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (audited.relatedContext !== undefined && audited.coverage !== "none") {
      return `related_context_requires_none_coverage:${audited.id}`;
    }
    let lastDraftRelatedIndex = -1;
    for (const related of audited.relatedContext ?? []) {
      if (related.citations.length < 1 || related.citations.length > 4) {
        return `related_citation_count:${audited.id}`;
      }
      if (stableUnique(related.citations).length !== related.citations.length) {
        return `duplicate_related_citation:${audited.id}`;
      }
      const draftRelated = draft.relatedContext ?? [];
      const matchingDraftIndex = draftRelated.findIndex(
        (candidate) => normalizedStatement(candidate.statement) === normalizedStatement(related.statement),
      );
      if (matchingDraftIndex < 0 || matchingDraftIndex <= lastDraftRelatedIndex) {
        return `related_fact_not_in_draft:${audited.id}`;
      }
      lastDraftRelatedIndex = matchingDraftIndex;
      const matchingDraft = draftRelated[matchingDraftIndex]!;
      const draftRelatedCitations = new Set(matchingDraft.citations);
      for (const citation of related.citations) {
        if (!draftRelatedCitations.has(citation)) {
          return `related_citation_not_in_draft:${audited.id}:${citation}`;
        }
        if (!evidenceCitations.has(citation)) {
          return `related_citation_not_in_evidence:${audited.id}:${citation}`;
        }
      }
      const inlineCitations = stableUnique(
        [...related.statement.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      );
      if (!sameNumberSet(inlineCitations, related.citations)) {
        return `related_citation_metadata_mismatch:${audited.id}`;
      }
    }
  }

  const expectedCitations = stableUnique(
    verified.requirements.flatMap((requirement) => [
      ...requirement.citations,
      ...(requirement.relatedContext ?? []).flatMap((related) => related.citations),
    ]),
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

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function normalizedStatement(statement: string): string {
  return statement
    .replace(/\[\d+\]/gu, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ")
    .trim();
}
