import { z } from "zod";
import {
  coverageVerificationActionSchema,
  coverageVerificationReasonSchema,
  type CoverageVerificationAction,
  type CoverageVerificationReason,
  type FinalAction,
  type KnowledgePlan,
  type RequirementCoverage,
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

const NOT_COVERED_REQUIREMENT_ANSWER =
  "现有资料未覆盖该要求，无法根据正式知识库确认。";

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
  let verified: CoverageVerificationAction | undefined;
  let lastInvalidReason = "invalid_model_payload";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const candidate = await input.model.completeJson({
        messages: attempt === 0
          ? messages
          : [...messages, {
              role: "user" as const,
              content: `上一次输出未通过严格 Schema 或确定性校验。
错误：${lastInvalidReason}
只输出合法 verify JSON。
${COVERAGE_VERIFICATION_REPAIR_INSTRUCTION}`,
            }],
        schema: modelResponseSchema,
        schemaDescription: "pse_coverage_verification_decision",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const invalidReason = validateVerification(input, candidate);
      if (invalidReason === undefined) {
        verified = candidate;
        break;
      }
      lastInvalidReason = invalidReason;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      lastInvalidReason = error.code;
    }
  }

  if (verified === undefined) {
    const reasons = input.plan.requirements.map((requirement) => ({
      id: requirement.id,
      reason: "target_omitted" as const,
    }));
    input.onVerified?.(reasons);
    return conservativeNotCovered(input);
  }

  input.onVerified?.(verified.requirements.map((requirement) => ({
    id: requirement.id,
    reason: requirement.reason,
  })));
  return materializeVerification(input.draft, verified);
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
  decision: Readonly<Record<string, unknown>>,
  draft: FinalAction["requirements"][number] | undefined,
): CoverageVerificationReason {
  if (decision.targetDecision === "retain") {
    if (draft?.coverage === "complete") return "direct_support";
    if (draft?.coverage === "partial") return "partial_support";
  }
  if (
    Array.isArray(decision.retainedRelatedContextIndexes) &&
    decision.retainedRelatedContextIndexes.length > 0
  ) {
    return "related_only";
  }
  if (decision.targetDecision === "not_covered" && draft?.coverage !== "none") {
    return "unsupported_claim_removed";
  }
  return "target_omitted";
}

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
    const decision = verified.requirements[index]!;
    if (draft.id !== planned.id || decision.id !== planned.id) {
      return "requirement_order_mismatch";
    }
    if (decision.targetDecision === "retain" && draft.coverage === "none") {
      return `none_target_cannot_be_retained:${decision.id}`;
    }
    if (
      decision.targetDecision === "retain" &&
      decision.retainedRelatedContextIndexes.length > 0
    ) {
      return `retained_target_cannot_have_related_context:${decision.id}`;
    }
    const relatedContext = draft.relatedContext ?? [];
    if (
      decision.retainedRelatedContextIndexes.length > 0 &&
      draft.coverage !== "none"
    ) {
      return `related_context_requires_none_coverage:${decision.id}`;
    }
    const evidenceCitations = new Set(
      input.evidence
        .filter((document) => document.requirementId === decision.id)
        .map((document) => document.citation),
    );
    for (const relatedIndex of decision.retainedRelatedContextIndexes) {
      const related = relatedContext[relatedIndex];
      if (related === undefined) {
        return `related_context_index_out_of_range:${decision.id}:${relatedIndex}`;
      }
      const unsupportedCitation = related.citations.find(
        (citation) => !evidenceCitations.has(citation),
      );
      if (unsupportedCitation !== undefined) {
        return `related_citation_not_in_evidence:${decision.id}:${unsupportedCitation}`;
      }
    }
  }
  return undefined;
}

function materializeVerification(
  draft: FinalAction,
  verified: CoverageVerificationAction,
): FinalAction {
  const requirements = verified.requirements.map((decision, index) => {
    const draftRequirement = draft.requirements[index]!;
    if (decision.targetDecision === "retain") {
      return cloneRequirement(draftRequirement);
    }
    const relatedContext = decision.retainedRelatedContextIndexes.map(
      (relatedIndex) => draftRequirement.relatedContext![relatedIndex]!,
    );
    return {
      id: draftRequirement.id,
      coverage: "none" as const,
      answer: NOT_COVERED_REQUIREMENT_ANSWER,
      citations: [],
      ...(relatedContext.length === 0
        ? {}
        : {
            relatedContext: relatedContext.map((related) => ({
              statement: related.statement,
              citations: [...related.citations],
            })),
          }),
    };
  });
  return {
    action: "final",
    requirements,
    citations: stableUnique(
      requirements.flatMap((requirement) => [
        ...requirement.citations,
        ...(requirement.relatedContext ?? []).flatMap(
          (related) => related.citations,
        ),
      ]),
    ),
  };
}

function conservativeNotCovered(input: CoverageVerifierInput): FinalAction {
  return {
    action: "final",
    requirements: input.plan.requirements.map((requirement) => ({
      id: requirement.id,
      coverage: "none",
      answer: NOT_COVERED_REQUIREMENT_ANSWER,
      citations: [],
    })),
    citations: [],
  };
}

function cloneRequirement(
  requirement: FinalAction["requirements"][number],
): RequirementCoverage {
  return {
    id: requirement.id,
    coverage: requirement.coverage,
    answer: requirement.answer,
    citations: [...requirement.citations],
    ...(requirement.relatedContext === undefined
      ? {}
      : {
          relatedContext: requirement.relatedContext.map((related) => ({
            statement: related.statement,
            citations: [...related.citations],
          })),
        }),
  };
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
