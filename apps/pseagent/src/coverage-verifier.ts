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
import {
  normalizeTrailingCitationPlacement,
  splitAnswerLineSegments,
} from "./references.js";
import { missingExplicitComparisonLabels } from "./comparison-question.js";

export interface CoverageEvidenceDocument {
  readonly requirementId: string;
  readonly citation: number;
  readonly title: string;
  readonly path: string;
  readonly content: string;
  readonly aspectIds?: readonly string[];
}

interface TargetSegment {
  readonly index: number;
  readonly text: string;
  readonly citations: readonly number[];
}

export const SYNTHESIS_DISCLOSURE =
  "根据正式知识库中多篇资料综合归纳：";

export interface CoverageVerificationClaimDecision {
  readonly claimIndex: number;
  readonly status:
    | "retained_direct"
    | "retained_synthesized"
    | "removed";
  readonly citations: readonly number[];
  readonly coveredAspectIds: readonly string[];
}

export interface CoverageVerificationSummary {
  readonly id: string;
  readonly reason: CoverageVerificationReason;
  readonly retainedDirectSegmentCount: number;
  readonly retainedSynthesizedSegmentCount: number;
  readonly removedSegmentCount: number;
  readonly coveredAspectCount?: number;
  readonly missingAspectCount?: number;
}

export interface CoverageVerificationDetail extends CoverageVerificationSummary {
  readonly coveredAspectIds: readonly string[];
  readonly missingAspectIds: readonly string[];
  readonly claimDecisions: readonly CoverageVerificationClaimDecision[];
}

export interface CoverageVerificationReport {
  readonly summaries: readonly CoverageVerificationDetail[];
  /** Partial obligations appear here because a supported portion was retained. */
  readonly coveredRequirementIds: readonly string[];
  /** Partial obligations also appear here because a required portion is still missing. */
  readonly missingRequirementIds: readonly string[];
  /** True only for the conservative compatibility report without verifier decisions. */
  readonly inferred?: boolean;
}

export interface CoverageVerifierInput {
  readonly question: string;
  readonly plan: KnowledgePlan;
  readonly draft: FinalAction;
  readonly evidence: readonly CoverageEvidenceDocument[];
  readonly model: ModelClient;
  readonly signal?: AbortSignal;
  readonly onVerified?: (
    summaries: readonly CoverageVerificationSummary[],
  ) => void;
  readonly onReport?: (report: CoverageVerificationReport) => void;
  readonly onInvalid?: (input: {
    readonly attempt: number;
    readonly reason: string;
    readonly rawPayloadLength?: number;
    readonly finishReason?: string;
  }) => void;
}

export class InvalidCoverageVerificationError extends Error {
  constructor(readonly code = "invalid_coverage_verification") {
    super(code);
    this.name = "InvalidCoverageVerificationError";
  }
}

export const NOT_COVERED_REQUIREMENT_ANSWER =
  "现有资料未覆盖该要求，无法根据正式知识库确认。";

export function notCoveredRequirementAnswer(question: string): string {
  const target = [...question.trim()].slice(0, 160).join("");
  if (!target) return NOT_COVERED_REQUIREMENT_ANSWER;
  if (/(?:是否|能否|有没有|是否具备|支不支持|支持|兼容|适配)/u.test(question)) {
    const capabilityTarget = question.match(
      /(?:(?:是否|能否|有没有|支不支持)\s*)?(?:已经|已|能够|可以)?\s*(?:支持|兼容|适配|具备)\s*([^？?。！!]{2,100})/u,
    )?.[1]?.trim();
    return capabilityTarget === undefined
      ? "正式知识库未提及所问的目标协议、功能或能力，无法根据正式知识库确认是否支持或兼容。"
      : `正式知识库未提及“${capabilityTarget}”，无法根据正式知识库确认是否支持或兼容。`;
  }
  return `现有资料未覆盖“${target}”，无法根据正式知识库确认。`;
}

export async function verifyKnowledgeCoverage(
  input: CoverageVerifierInput,
): Promise<FinalAction> {
  const targetSegments = input.draft.requirements.map((requirement) => ({
    id: requirement.id,
    segments: requirement.coverage === "none"
      ? []
      : splitTargetSegments(requirement.answer),
  }));
  const messages = coverageVerificationMessages({
    question: input.question,
    plan: input.plan,
    draft: input.draft,
    targetSegments,
    evidence: input.evidence,
  });
  const modelResponseSchema = coverageVerificationModelResponseSchema(input.draft);
  let verified: CoverageVerificationAction | undefined;
  let lastInvalidReason = "invalid_model_payload";
  let structuralFailureCount = 0;
  let recoverableDecisionFailureCount = 0;

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
      const normalizedCandidate = normalizeEvidenceModeDecisions(
        candidate,
        input.plan,
        targetSegments,
      );
      const invalidReason = validateVerification(
        input,
        normalizedCandidate,
        targetSegments,
      );
      if (invalidReason === undefined) {
        verified = normalizedCandidate;
        break;
      }
      lastInvalidReason = invalidReason;
      if (isRecoverableDecisionShapeReason(invalidReason)) {
        recoverableDecisionFailureCount += 1;
      }
      input.onInvalid?.({ attempt: attempt + 1, reason: invalidReason });
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      structuralFailureCount += 1;
      lastInvalidReason = error.code;
      input.onInvalid?.({
        attempt: attempt + 1,
        reason: error.code,
        ...(error.rawPayloadLength === undefined
          ? {}
          : { rawPayloadLength: error.rawPayloadLength }),
        ...(error.finishReason === undefined
          ? {}
          : { finishReason: error.finishReason }),
      });
    }
  }

  if (
    verified === undefined &&
    structuralFailureCount + recoverableDecisionFailureCount === 3
  ) {
    const wholeRequirementSchema = wholeRequirementVerificationSchema(input.draft);
    for (let fallbackAttempt = 1; fallbackAttempt <= 2; fallbackAttempt += 1) {
      try {
        const rawWhole = await input.model.completeJson({
          messages: [
            ...messages,
            {
              role: "user" as const,
              content: [
                "逐段校验的 JSON 或决策结构连续失败，现在只做每个义务的整体保守校验。",
                "只判断每个义务中带正式引用的片段：如果这些带引用片段整体受到已提供正文证据支持，输出 retain_cited；如果没有任何可保留的带引用片段，输出 not_covered。不要把无引用片段纳入判断。",
                '只输出 {"action":"verify","requirements":[{"id":"R1","decision":"retain_cited|not_covered"}]} 形式的 JSON，不要解释。',
              ].join(""),
            },
          ],
          schema: wholeRequirementSchema,
          schemaDescription: "pse_whole_requirement_verification",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const parsedWhole = wholeRequirementSchema.safeParse(rawWhole);
        if (!parsedWhole.success) {
          throw new InvalidModelPayloadError(
            "invalid_schema:whole_requirement_verification",
          );
        }
        const whole = parsedWhole.data;
        const fallback = materializeWholeRequirementVerification(
          whole,
          input.draft,
          input.plan,
        );
        const invalidReason = validateVerification(input, fallback, targetSegments);
        if (invalidReason === undefined) {
          verified = fallback;
          break;
        }
        lastInvalidReason = invalidReason;
        input.onInvalid?.({
          attempt: 3 + fallbackAttempt,
          reason: invalidReason,
        });
      } catch (error) {
        if (!(error instanceof InvalidModelPayloadError)) throw error;
        lastInvalidReason = error.code;
        input.onInvalid?.({
          attempt: 3 + fallbackAttempt,
          reason: error.code,
          ...(error.rawPayloadLength === undefined
            ? {}
            : { rawPayloadLength: error.rawPayloadLength }),
          ...(error.finishReason === undefined
            ? {}
            : { finishReason: error.finishReason }),
        });
      }
    }
  }

  if (verified === undefined) {
    const reasons = input.plan.requirements.map((requirement) => ({
      id: requirement.id,
      reason: "target_omitted" as const,
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount:
        targetSegments.find((target) => target.id === requirement.id)
          ?.segments.length ?? 0,
      ...(requirement.evidenceAspects.length <= 1
        ? {}
        : {
            coveredAspectCount: 0,
            missingAspectCount: requirement.evidenceAspects.length,
          }),
    }));
    input.onVerified?.(reasons);
    throw new InvalidCoverageVerificationError(lastInvalidReason);
  }

  const summaries = verificationSummaries(
    verified,
    targetSegments,
    input.plan,
    input.evidence,
    input.draft,
  );
  const materialized = enforceAspectCoverage(
    materializeVerification(
      input.draft,
      verified,
      targetSegments,
      input.plan,
      input.question,
    ),
    input.plan,
    summaries,
    input.draft,
  );
  input.onVerified?.(summaries.map(stripAspectIds));
  input.onReport?.(coverageVerificationReport(materialized, summaries));
  return materialized;
}

function normalizeEvidenceModeDecisions(
  candidate: CoverageVerificationAction,
  plan: KnowledgePlan,
  targetSegments: readonly {
    readonly id: string;
    readonly segments: readonly TargetSegment[];
  }[],
): CoverageVerificationAction {
  return {
    ...candidate,
    requirements: candidate.requirements.map((requirement, index) => {
      const segments = targetSegments[index]?.segments ?? [];
      const citedRetainedIndexes = requirement.retainedTargetSegmentIndexes
        .filter((segmentIndex) => {
          const segment = segments[segmentIndex];
          // Preserve an out-of-range index so strict validation still reports
          // the malformed decision instead of hiding it.
          return segment === undefined || segment.citations.length > 0;
        });
      const removedUncited = citedRetainedIndexes.length !==
        requirement.retainedTargetSegmentIndexes.length;
      const directOnly = plan.requirements[index]?.evidenceMode === "direct_only";
      const clearedDirectOnlySynthesis = directOnly &&
        requirement.synthesizedTargetSegmentIndexes.length > 0 &&
        requirement.reason !== "synthesized_support";
      const synthesizedTargetSegmentIndexes = clearedDirectOnlySynthesis
        ? []
        : removedUncited
          ? requirement.synthesizedTargetSegmentIndexes.filter((segmentIndex) =>
              citedRetainedIndexes.includes(segmentIndex))
          : requirement.synthesizedTargetSegmentIndexes;
      const targetDecision = removedUncited
        ? citedRetainedIndexes.length === 0
          ? "not_covered" as const
          : citedRetainedIndexes.length === segments.length
            ? "retain" as const
            : "retain_partial" as const
        : requirement.targetDecision;
      if (
        !removedUncited &&
        !clearedDirectOnlySynthesis
      ) return requirement;
      return {
        ...requirement,
        targetDecision,
        retainedTargetSegmentIndexes: citedRetainedIndexes,
        synthesizedTargetSegmentIndexes,
        ...(targetDecision === "not_covered" ? { coveredAspectIds: [] } : {}),
        reason: targetDecision === "not_covered"
          ? "unsupported_claim_removed"
          : targetDecision === "retain_partial"
            ? "partial_support"
            : synthesizedTargetSegmentIndexes.length > 0
              ? "synthesized_support"
              : "direct_support",
      };
    }),
  };
}

function isRecoverableDecisionShapeReason(reason: string): boolean {
  const safePrefixes = [
    "retained_target_requires_all_segments",
    "partial_target_requires_proper_segment_subset",
    "uncovered_target_cannot_retain_segments",
    "covered_aspect_not_in_plan",
    "not_covered_cannot_cover_aspects",
    "retained_target_segment_without_citation",
    "explicit_scenario_choice_omitted",
  ];
  return safePrefixes.some((prefix) =>
    reason === prefix || reason.startsWith(`${prefix}:`));
}

export function coverageVerificationReport(
  action: FinalAction,
  summaries: readonly CoverageVerificationDetail[],
): CoverageVerificationReport {
  if (
    summaries.length !== action.requirements.length ||
    new Set(summaries.map((summary) => summary.id)).size !== summaries.length
  ) {
    throw new InvalidCoverageVerificationError("verification_summary_mismatch");
  }
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const orderedSummaries = action.requirements.map((requirement) => {
    const summary = summaryById.get(requirement.id);
    if (summary === undefined) {
      throw new InvalidCoverageVerificationError("verification_summary_missing");
    }
    validateClaimDecisions(requirement, summary);
    return summary;
  });
  return {
    summaries: orderedSummaries,
    coveredRequirementIds: action.requirements.flatMap((requirement) =>
      requirement.coverage === "none" ? [] : [requirement.id]),
    missingRequirementIds: action.requirements.flatMap((requirement) =>
      requirement.coverage === "complete" ? [] : [requirement.id]),
  };
}

function validateClaimDecisions(
  requirement: FinalAction["requirements"][number],
  summary: CoverageVerificationDetail,
): void {
  const decisions = summary.claimDecisions;
  if (decisions === undefined) {
    throw new InvalidCoverageVerificationError(
      "verification_claim_index_invalid",
    );
  }
  if (decisions.some((decision, index) =>
    !Number.isInteger(decision.claimIndex) || decision.claimIndex !== index)) {
    throw new InvalidCoverageVerificationError(
      "verification_claim_index_invalid",
    );
  }

  const retainedCitations = new Set(requirement.citations);
  const coveredAspectIds = new Set(summary.coveredAspectIds);
  for (const decision of decisions) {
    if (![
      "retained_direct",
      "retained_synthesized",
      "removed",
    ].includes(decision.status)) {
      throw new InvalidCoverageVerificationError(
        "verification_claim_status_invalid",
      );
    }
    if (
      new Set(decision.citations).size !== decision.citations.length ||
      decision.citations.some((citation) =>
        !Number.isInteger(citation) || citation <= 0) ||
      (
        decision.status !== "removed" &&
        (
          decision.citations.length === 0 ||
          decision.citations.some((citation) => !retainedCitations.has(citation))
        )
      )
    ) {
      throw new InvalidCoverageVerificationError(
        "verification_claim_citation_invalid",
      );
    }
    if (
      new Set(decision.coveredAspectIds).size !==
        decision.coveredAspectIds.length ||
      decision.coveredAspectIds.some((aspectId) =>
        !coveredAspectIds.has(aspectId)) ||
      (
        decision.status === "removed" &&
        decision.coveredAspectIds.length > 0
      )
    ) {
      throw new InvalidCoverageVerificationError(
        "verification_claim_aspect_invalid",
      );
    }
  }

  const directCount = decisions.filter((decision) =>
    decision.status === "retained_direct").length;
  const synthesizedCount = decisions.filter((decision) =>
    decision.status === "retained_synthesized").length;
  const removedCount = decisions.filter((decision) =>
    decision.status === "removed").length;
  if (
    directCount !== summary.retainedDirectSegmentCount ||
    synthesizedCount !== summary.retainedSynthesizedSegmentCount ||
    removedCount !== summary.removedSegmentCount ||
    (
      requirement.coverage === "none" &&
      directCount + synthesizedCount > 0
    )
  ) {
    throw new InvalidCoverageVerificationError(
      "verification_claim_count_invalid",
    );
  }

  const claimCoveredAspectIds = new Set(
    decisions.flatMap((decision) => decision.coveredAspectIds),
  );
  if (
    claimCoveredAspectIds.size !== coveredAspectIds.size ||
    [...coveredAspectIds].some((aspectId) =>
      !claimCoveredAspectIds.has(aspectId))
  ) {
    throw new InvalidCoverageVerificationError(
      "verification_claim_aspect_invalid",
    );
  }
}

/**
 * Explicit compatibility helper for tests and adapters that need to construct a
 * conservative report. The agent loop never synthesizes this report implicitly:
 * production verification must emit its own claim-level decisions.
 */
export function inferCoverageVerificationReport(
  action: FinalAction,
  plan: KnowledgePlan,
): CoverageVerificationReport {
  const summaries: CoverageVerificationDetail[] = action.requirements.map(
    (requirement, index) => {
      const planned = plan.requirements[index];
      if (planned === undefined || planned.id !== requirement.id) {
        throw new InvalidCoverageVerificationError("verification_plan_mismatch");
      }
      const aspectIds = planned.evidenceAspects.map((aspect) => aspect.id);
      const coveredAspectIds = requirement.coverage === "complete"
        ? aspectIds
        : [];
      const missingAspectIds = requirement.coverage === "complete"
        ? []
        : aspectIds;
      const reason: CoverageVerificationReason =
        requirement.coverage === "complete"
          ? planned.evidenceMode === "direct_only"
            ? "direct_support"
            : "synthesized_support"
          : requirement.coverage === "partial"
            ? "partial_support"
            : "target_omitted";
      const aggregateStatus: CoverageVerificationClaimDecision["status"] =
        planned.evidenceMode === "synthesis_allowed"
          ? "retained_synthesized"
          : "retained_direct";
      const claimDecisions: CoverageVerificationClaimDecision[] =
        requirement.coverage === "none"
          ? []
          : [{
              claimIndex: 0,
              status: aggregateStatus,
              citations: [...requirement.citations],
              coveredAspectIds: [...coveredAspectIds],
            }];
      return {
        id: requirement.id,
        reason,
        retainedDirectSegmentCount:
          aggregateStatus === "retained_direct" && claimDecisions.length > 0
            ? 1
            : 0,
        retainedSynthesizedSegmentCount:
          aggregateStatus === "retained_synthesized" &&
            claimDecisions.length > 0
            ? 1
            : 0,
        removedSegmentCount: 0,
        coveredAspectCount: coveredAspectIds.length,
        missingAspectCount: missingAspectIds.length,
        coveredAspectIds,
        missingAspectIds,
        claimDecisions,
      };
    },
  );
  return {
    ...coverageVerificationReport(action, summaries),
    inferred: true,
  };
}

function coverageVerificationModelResponseSchema(draft: FinalAction) {
  return z.preprocess(
    (value) => normalizeModelReasons(value, draft),
    coverageVerificationActionSchema,
  );
}

const wholeRequirementDecisionSchema = z.object({
  id: z.string().regex(/^R[1-6]$/u),
  decision: z.enum(["retain_cited", "not_covered"]),
}).strict();

function wholeRequirementVerificationSchema(draft: FinalAction) {
  return z.preprocess((value) => {
    if (!isRecord(value) || !Array.isArray(value.requirements)) return value;
    const normalized: Record<string, unknown> = {
      ...value,
      action: value.action ?? "verify",
      requirements: value.requirements.map((requirement, index) => {
        if (!isRecord(requirement)) return requirement;
        const result: Record<string, unknown> = { ...requirement };
        result.id = requirement.id ?? requirement.requirementId ??
          draft.requirements[index]?.id;
        result.decision = normalizeWholeRequirementDecision(
          requirement.decision ?? requirement.targetDecision ?? requirement.coverage,
        );
        delete result.requirementId;
        delete result.targetDecision;
        delete result.coverage;
        return result;
      }),
    };
    if (normalized.type === "verify") delete normalized.type;
    return normalized;
  }, z.object({
    action: z.literal("verify"),
    requirements: z.array(wholeRequirementDecisionSchema)
      .length(draft.requirements.length),
  }).strict());
}

function normalizeWholeRequirementDecision(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if ([
    "retain_cited",
    "retain",
    "supported",
    "complete",
    "keep",
    "retain_all",
  ].includes(normalized)) {
    return "retain_cited";
  }
  if ([
    "not_covered",
    "none",
    "unsupported",
    "remove",
    "omit",
    "partial",
    "retain_partial",
    "partially_supported",
  ].includes(normalized)) {
    return "not_covered";
  }
  return value;
}

function materializeWholeRequirementVerification(
  whole: { readonly requirements: readonly { readonly id: string; readonly decision: "retain_cited" | "not_covered" }[] },
  draft: FinalAction,
  plan: KnowledgePlan,
): CoverageVerificationAction {
  return {
    action: "verify",
    requirements: whole.requirements.map((decision, index) => {
      const draftRequirement = draft.requirements[index]!;
      const plannedRequirement = plan.requirements[index]!;
      const retain = decision.decision === "retain_cited" &&
        draftRequirement.coverage !== "none";
      const allSegments = splitTargetSegments(draftRequirement.answer);
      const segmentIndexes = retain
        ? allSegments
            .filter((segment) => segment.citations.length > 0)
            .map((segment) => segment.index)
        : [];
      const targetDecision = !retain || segmentIndexes.length === 0
        ? "not_covered" as const
        : segmentIndexes.length === allSegments.length
          ? "retain" as const
          : "retain_partial" as const;
      const synthesized = retain && plannedRequirement.evidenceMode === "synthesis_allowed"
        ? segmentIndexes
        : [];
      return {
        id: decision.id,
        targetDecision,
        retainedTargetSegmentIndexes: segmentIndexes,
        synthesizedTargetSegmentIndexes: synthesized,
        retainedRelatedContextIndexes: [],
        reason: targetDecision !== "not_covered"
          ? draftRequirement.coverage === "partial"
            ? "partial_support"
            : targetDecision === "retain_partial"
              ? "partial_support"
            : synthesized.length > 0
              ? "synthesized_support"
              : "direct_support"
          : draftRequirement.coverage === "none"
            ? "target_omitted"
            : "unsupported_claim_removed",
      };
    }),
  };
}

function normalizeModelReasons(value: unknown, draft: FinalAction): unknown {
  if (!isRecord(value) || !Array.isArray(value.requirements)) return value;
  const normalizedRoot: Record<string, unknown> = {
    ...value,
    action: value.action ?? "verify",
    requirements: value.requirements.map((requirement, index) => {
      if (!isRecord(requirement)) return requirement;
      const matchingDraft = draft.requirements[index];
      const normalized: Record<string, unknown> = { ...requirement };
      const id = requirement.id ?? requirement.requirementId ?? matchingDraft?.id;
      const targetDecision = normalizeTargetDecision(
        requirement.targetDecision ?? requirement.decision ?? requirement.coverage,
      );
      const targetSegmentIndexes = targetDecision === "retain"
        ? splitTargetSegments(matchingDraft?.answer ?? "").map((segment) => segment.index)
        : [];
      normalized.id = id;
      normalized.targetDecision = targetDecision;
      normalized.retainedTargetSegmentIndexes = normalizeOrderedIndexes(
        requirement.retainedTargetSegmentIndexes ?? requirement.retainedSegmentIndexes,
        targetSegmentIndexes,
      );
      normalized.synthesizedTargetSegmentIndexes = normalizeOrderedIndexes(
        requirement.synthesizedTargetSegmentIndexes ?? requirement.synthesizedSegmentIndexes,
        [],
      );
      normalized.retainedRelatedContextIndexes = normalizeOrderedIndexes(
        requirement.retainedRelatedContextIndexes ?? requirement.relatedContextIndexes,
        [],
      );
      const coveredAspectIds = requirement.coveredAspectIds ?? requirement.aspectIds;
      if (coveredAspectIds !== undefined) {
        normalized.coveredAspectIds = normalizeOrderedAspectIds(coveredAspectIds);
      }
      for (const alias of [
        "requirementId",
        "decision",
        "coverage",
        "retainedSegmentIndexes",
        "synthesizedSegmentIndexes",
        "relatedContextIndexes",
        "aspectIds",
      ]) {
        delete normalized[alias];
      }
      if (
        Array.isArray(normalized.synthesizedTargetSegmentIndexes) &&
        normalized.synthesizedTargetSegmentIndexes.length > 0
      ) {
        if (coverageVerificationReasonSchema.safeParse(requirement.reason).success) {
          return normalized;
        }
        return {
          ...normalized,
          reason: targetDecision === "retain_partial"
            ? "partial_support"
            : "synthesized_support",
        };
      }
      if (coverageVerificationReasonSchema.safeParse(requirement.reason).success) {
        return normalized;
      }
      return {
        ...normalized,
        reason: deriveModelReason(normalized, matchingDraft),
      };
    }),
  };
  if (normalizedRoot.type === "verify") delete normalizedRoot.type;
  return normalizedRoot;
}

function normalizeTargetDecision(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["retain", "supported", "complete", "keep", "retain_all"].includes(normalized)) {
    return "retain";
  }
  if (["retain_partial", "partial", "partially_supported"].includes(normalized)) {
    return "retain_partial";
  }
  if (["not_covered", "none", "unsupported", "remove", "omit"].includes(normalized)) {
    return "not_covered";
  }
  return value;
}

function normalizeOrderedIndexes(value: unknown, fallback: readonly number[]): unknown {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) =>
    !Number.isInteger(item) || Number(item) < 0)) {
    return value;
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

function normalizeOrderedAspectIds(value: unknown): unknown {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "string" || !/^A[1-8]$/u.test(item))) {
    return value;
  }
  return [...new Set(value as string[])].sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
  );
}

function deriveModelReason(
  decision: Readonly<Record<string, unknown>>,
  draft: FinalAction["requirements"][number] | undefined,
): CoverageVerificationReason {
  if (decision.targetDecision === "retain") {
    if (draft?.coverage === "complete") return "direct_support";
    if (draft?.coverage === "partial") return "partial_support";
  }
  if (decision.targetDecision === "retain_partial") return "partial_support";
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
  targetSegments: readonly {
    readonly id: string;
    readonly segments: readonly TargetSegment[];
  }[],
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
    const segments = targetSegments[index]?.segments ?? [];
    const allSegmentIndexes = segments.map((segment) => segment.index);
    if (draft.id !== planned.id || decision.id !== planned.id) {
      return "requirement_order_mismatch";
    }
    if (decision.targetDecision === "retain" && draft.coverage === "none") {
      return `none_target_cannot_be_retained:${decision.id}`;
    }
    if (
      decision.targetDecision === "retain" &&
      !sameNumbers(decision.retainedTargetSegmentIndexes, allSegmentIndexes)
    ) {
      return `retained_target_requires_all_segments:${decision.id}`;
    }
    if (
      decision.targetDecision === "retain_partial" &&
      draft.coverage === "none"
    ) {
      return `none_target_cannot_be_partially_retained:${decision.id}`;
    }
    if (
      decision.targetDecision === "retain_partial" &&
      (
        decision.retainedTargetSegmentIndexes.length === 0 ||
        decision.retainedTargetSegmentIndexes.length >= allSegmentIndexes.length
      )
    ) {
      return `partial_target_requires_proper_segment_subset:${decision.id}`;
    }
    if (
      decision.targetDecision === "not_covered" &&
      decision.retainedTargetSegmentIndexes.length > 0
    ) {
      return `uncovered_target_cannot_retain_segments:${decision.id}`;
    }
    const retainedTargetIndexes = new Set(
      decision.retainedTargetSegmentIndexes,
    );
    if (
      decision.synthesizedTargetSegmentIndexes.some(
        (segmentIndex) => !retainedTargetIndexes.has(segmentIndex),
      )
    ) {
      return `synthesized_segments_must_be_retained:${decision.id}`;
    }
    if (
      planned.evidenceMode === "direct_only" &&
      decision.synthesizedTargetSegmentIndexes.length > 0
    ) {
      return `direct_only_cannot_synthesize:${decision.id}`;
    }
    if (
      decision.targetDecision === "not_covered" &&
      decision.synthesizedTargetSegmentIndexes.length > 0
    ) {
      return `not_covered_cannot_synthesize:${decision.id}`;
    }
    if (
      decision.targetDecision !== "not_covered" &&
      decision.retainedRelatedContextIndexes.length > 0
    ) {
      return `retained_target_cannot_have_related_context:${decision.id}`;
    }
    const plannedAspectIds = new Set(
      planned.evidenceAspects.map((aspect) => aspect.id),
    );
    const unknownCoveredAspectId = decision.coveredAspectIds?.find(
      (aspectId) => !plannedAspectIds.has(aspectId),
    );
    if (unknownCoveredAspectId !== undefined) {
      return `covered_aspect_not_in_plan:${decision.id}:${unknownCoveredAspectId}`;
    }
    if (
      decision.targetDecision === "not_covered" &&
      (decision.coveredAspectIds?.length ?? 0) > 0
    ) {
      return `not_covered_cannot_cover_aspects:${decision.id}`;
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
    for (const targetIndex of decision.retainedTargetSegmentIndexes) {
      const segment = segments[targetIndex];
      if (segment === undefined) {
        return `target_segment_index_out_of_range:${decision.id}:${targetIndex}`;
      }
      if (segment.citations.length === 0) {
        return `retained_target_segment_without_citation:${decision.id}:${targetIndex}`;
      }
      const unsupportedCitation = segment.citations.find(
        (citation) => !evidenceCitations.has(citation),
      );
      if (unsupportedCitation !== undefined) {
        return `target_segment_citation_not_in_evidence:${decision.id}:${unsupportedCitation}`;
      }
    }
    if (decision.targetDecision !== "not_covered") {
      const retainedAnswer = decision.retainedTargetSegmentIndexes
        .map((targetIndex) => segments[targetIndex]?.text ?? "")
        .join("\n");
      const missingChoiceLabels = missingExplicitComparisonLabels(
        planned.question,
        retainedAnswer,
      );
      if (missingChoiceLabels.length > 0) {
        return `explicit_scenario_choice_omitted:${decision.id}:${missingChoiceLabels.join(",")}`;
      }
    }
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
  targetSegments: readonly {
    readonly id: string;
    readonly segments: readonly TargetSegment[];
  }[],
  plan: KnowledgePlan,
  originalQuestion: string,
): FinalAction {
  const requirements = verified.requirements.map((decision, index) => {
    const draftRequirement = draft.requirements[index]!;
    const hasSynthesis =
      decision.synthesizedTargetSegmentIndexes.length > 0;
    if (decision.targetDecision === "retain") {
      const retained = cloneRequirement(draftRequirement);
      return hasSynthesis
        ? {
            ...retained,
            answer: addSynthesisDisclosure(retained.answer),
          }
        : retained;
    }
    if (decision.targetDecision === "retain_partial") {
      const segments = targetSegments[index]?.segments ?? [];
      const retained = decision.retainedTargetSegmentIndexes.map(
        (segmentIndex) => segments[segmentIndex]!,
      );
      return {
        id: draftRequirement.id,
        coverage: "partial" as const,
        answer: addSynthesisDisclosureIfNeeded(
          materializeRetainedTargetSegments(
            segments,
            decision.retainedTargetSegmentIndexes,
          ),
          hasSynthesis,
        ),
        citations: stableUnique(retained.flatMap((segment) => segment.citations)),
      };
    }
    const question = plan.requirements[index]?.question ?? "";
    const relatedContext = decision.retainedRelatedContextIndexes
      .map((relatedIndex) => draftRequirement.relatedContext![relatedIndex]!)
      .filter((related) =>
        !repeatsProtectedTarget(question, related.statement) &&
        !repeatsProtectedTarget(originalQuestion, related.statement));
    return {
      id: draftRequirement.id,
      coverage: "none" as const,
      answer: notCoveredRequirementAnswer(question),
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

function repeatsProtectedTarget(question: string, statement: string): boolean {
  if (!/(?:支持|兼容|适配)/u.test(question)) return false;
  const target = question.match(
    /(?:支持|兼容|适配)\s*([^？?。！!]+)/u,
  )?.[1]
    ?.replace(/\s+/gu, "")
    .replace(/^[：:，,]+|[：:，,]+$/gu, "");
  if (!target || target.length < 2) return false;
  const terms = new Set([target]);
  const withoutYear = target.replace(/^\d{4}年?/u, "");
  if (withoutYear.length >= 2) terms.add(withoutYear);
  const coreTarget = withoutYear.replace(
    /(?:邮件)?(?:协议|功能|能力|产品)$/u,
    "",
  );
  if (coreTarget.length >= 2) terms.add(coreTarget);
  const normalizedStatement = statement.replace(/\s+/gu, "");
  return [...terms].some((term) => normalizedStatement.includes(term));
}

function verificationSummaries(
  verified: CoverageVerificationAction,
  targetSegments: readonly {
    readonly id: string;
    readonly segments: readonly TargetSegment[];
  }[],
  plan: KnowledgePlan,
  evidence: readonly CoverageEvidenceDocument[],
  draft: FinalAction,
): CoverageVerificationDetail[] {
  return verified.requirements.map((decision, index) => {
    const plannedRequirement = plan.requirements[index];
    const plannedAspectIds =
      plannedRequirement?.evidenceAspects.map((aspect) => aspect.id) ?? [];
    const retainedSegments = decision.retainedTargetSegmentIndexes.flatMap(
      (segmentIndex) => {
        const segment = targetSegments[index]?.segments[segmentIndex];
        return segment === undefined ? [] : [segment];
      },
    );
    const retainedCitations = new Set(
      retainedSegments.flatMap((segment) => segment.citations),
    );
    const supportedAspectIds = new Set(
      evidence
        .filter((document) =>
          document.requirementId === decision.id &&
          retainedCitations.has(document.citation))
        .flatMap((document) => document.aspectIds ?? []),
    );
    const allCitedSegmentsRetained =
      decision.retainedTargetSegmentIndexes.length ===
        (targetSegments[index]?.segments.length ?? 0);
    const coverageText = allCitedSegmentsRetained
      ? draft.requirements[index]?.answer ?? ""
      : materializeRetainedTargetSegments(
          targetSegments[index]?.segments ?? [],
          decision.retainedTargetSegmentIndexes,
        );
    const lexicallyCoveredAspectIds = plannedRequirement === undefined
      ? []
      : matchingPlannedAspectIds(plannedRequirement, coverageText).filter(
        (aspectId) => supportedAspectIds.has(aspectId),
      );
    const coveredAspectIdSet = new Set(
      decision.coveredAspectIds === undefined
        ? lexicallyCoveredAspectIds
        : decision.coveredAspectIds,
    );
    const coveredAspectIds = plannedAspectIds.filter((aspectId) =>
      coveredAspectIdSet.has(aspectId));
    const missingAspectIds = plannedAspectIds.filter((aspectId) =>
      !coveredAspectIdSet.has(aspectId));
    const claimDecisions = verificationClaimDecisions({
      decision,
      segments: targetSegments[index]?.segments ?? [],
      coveredAspectIds,
      plannedRequirement,
      evidence,
    });
    const retainedDirectSegmentCount = claimDecisions.filter((claim) =>
      claim.status === "retained_direct").length;
    const retainedSynthesizedSegmentCount = claimDecisions.filter((claim) =>
      claim.status === "retained_synthesized").length;
    const removedSegmentCount = claimDecisions.filter((claim) =>
      claim.status === "removed").length;
    return {
      id: decision.id,
      reason: decision.reason,
      retainedDirectSegmentCount,
      retainedSynthesizedSegmentCount,
      removedSegmentCount,
      coveredAspectCount: coveredAspectIds.length,
      missingAspectCount: missingAspectIds.length,
      coveredAspectIds,
      missingAspectIds,
      claimDecisions,
    };
  });
}

function verificationClaimDecisions(input: {
  readonly decision: CoverageVerificationAction["requirements"][number];
  readonly segments: readonly TargetSegment[];
  readonly coveredAspectIds: readonly string[];
  readonly plannedRequirement:
    | KnowledgePlan["requirements"][number]
    | undefined;
  readonly evidence: readonly CoverageEvidenceDocument[];
}): CoverageVerificationClaimDecision[] {
  const retainedIndexes = new Set(
    input.decision.retainedTargetSegmentIndexes,
  );
  const synthesizedIndexes = new Set(
    input.decision.synthesizedTargetSegmentIndexes,
  );
  const retainedSegments = input.segments.filter((segment) =>
    retainedIndexes.has(segment.index));
  const aspectIdsByClaimIndex = new Map<number, string[]>();

  for (const aspectId of input.coveredAspectIds) {
    const matchingSegment = retainedSegments.find((segment) =>
      input.evidence.some((document) =>
        document.requirementId === input.decision.id &&
        segment.citations.includes(document.citation) &&
        document.aspectIds?.includes(aspectId))) ??
      (
        input.plannedRequirement === undefined
          ? undefined
          : retainedSegments.find((segment) =>
              matchingPlannedAspectIds(
                input.plannedRequirement!,
                segment.text,
              ).includes(aspectId))
      ) ?? retainedSegments[0];
    if (matchingSegment === undefined) continue;
    const assigned = aspectIdsByClaimIndex.get(matchingSegment.index) ?? [];
    assigned.push(aspectId);
    aspectIdsByClaimIndex.set(matchingSegment.index, assigned);
  }

  return input.segments.map((segment) => {
    const retained = retainedIndexes.has(segment.index);
    return {
      claimIndex: segment.index,
      status: !retained
        ? "removed" as const
        : synthesizedIndexes.has(segment.index)
          ? "retained_synthesized" as const
          : "retained_direct" as const,
      citations: [...segment.citations],
      coveredAspectIds: retained
        ? [...(aspectIdsByClaimIndex.get(segment.index) ?? [])]
        : [],
    };
  });
}

function stripAspectIds(
  detail: CoverageVerificationDetail,
): CoverageVerificationSummary {
  const {
    coveredAspectIds: _coveredAspectIds,
    missingAspectIds: _missingAspectIds,
    claimDecisions: _claimDecisions,
    ...summary
  } = detail;
  return summary;
}

function matchingPlannedAspectIds(
  requirement: KnowledgePlan["requirements"][number],
  value: string,
): string[] {
  const normalizedValue = normalizeCoverageText(value);
  return requirement.evidenceAspects
    .filter((aspect) =>
      [aspect.label, ...aspect.terms].some((term) => {
        const normalizedTerm = normalizeCoverageText(term);
        return normalizedTerm.length >= 2 &&
          normalizedValue.includes(normalizedTerm);
      }))
    .map((aspect) => aspect.id);
}

function normalizeCoverageText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(
    /[\s\p{P}\p{S}]+/gu,
    "",
  );
}

function enforceAspectCoverage(
  action: FinalAction,
  plan: KnowledgePlan,
  summaries: readonly CoverageVerificationSummary[],
  draft: FinalAction,
): FinalAction {
  const requirements = action.requirements.map((requirement, index) => {
    const plannedAspectCount =
      plan.requirements[index]?.evidenceAspects.length ?? 0;
    const summary = summaries[index];
    if (summary === undefined || plannedAspectCount === 0) {
      return requirement;
    }
    const retainedSegmentCount = summary.retainedDirectSegmentCount +
      summary.retainedSynthesizedSegmentCount;
    const allPlannedAspectsCovered = retainedSegmentCount > 0 &&
      summary.coveredAspectCount === plannedAspectCount &&
      summary.missingAspectCount === 0;
    const allClaimsRetained = summary.removedSegmentCount === 0;
    const onlyUnsupportedExtrasRemoved = summary.removedSegmentCount > 0 &&
      summary.removedSegmentCount <= retainedSegmentCount &&
      (
        draft.requirements[index]?.coverage === "partial" ||
        !/(?:认证流程|处理流程|操作流程|关键步骤|完整步骤|关键配置|配置项|配置参数)/u.test(
          plan.requirements[index]?.question ?? "",
        )
      );
    if (
      requirement.coverage === "partial" &&
      allPlannedAspectsCovered &&
      (allClaimsRetained || onlyUnsupportedExtrasRemoved)
    ) {
      return {
        ...requirement,
        coverage: "complete" as const,
      };
    }
    if (
      requirement.coverage !== "complete" ||
      summary.missingAspectCount === 0
    ) {
      return requirement;
    }
    return {
      ...requirement,
      coverage: "partial" as const,
      answer: [
        requirement.answer,
        "部分规划证据面尚未获得已引用正文支持，需进一步确认。",
      ].join("\n"),
    };
  });
  return {
    ...action,
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

function addSynthesisDisclosureIfNeeded(
  answer: string,
  hasSynthesis: boolean,
): string {
  return hasSynthesis ? addSynthesisDisclosure(answer) : answer;
}

function addSynthesisDisclosure(answer: string): string {
  return answer.startsWith(SYNTHESIS_DISCLOSURE)
    ? answer
    : `${SYNTHESIS_DISCLOSURE}\n${answer}`;
}

function materializeRetainedTargetSegments(
  segments: readonly TargetSegment[],
  retainedSegmentIndexes: readonly number[],
): string {
  const retainedIndexes = new Set(retainedSegmentIndexes);
  return retainedSegmentIndexes
    .map((segmentIndex) => {
      const segment = segments[segmentIndex];
      if (segment === undefined) return "";
      if (segmentIndex === 0 || retainedIndexes.has(segmentIndex - 1)) {
        return segment.text;
      }

      const standaloneText = stripDanglingConnector(segment.text);
      if (startsWithStructuralMarker(standaloneText)) return standaloneText;
      const structuralPrefix = extractStructuralPrefix(
        segments[segmentIndex - 1]?.text ?? "",
      );
      return structuralPrefix === undefined
        ? standaloneText
        : `${structuralPrefix} ${standaloneText}`;
    })
    .filter(Boolean)
    .join("\n");
}

function stripDanglingConnector(text: string): string {
  const stripped = text.replace(
    /^\s*(?:并且|并|同时|此外|另外|而且|也|还)[，,、]?\s*/u,
    "",
  );
  return stripped.length === 0 ? text : stripped;
}

function extractStructuralPrefix(text: string): string | undefined {
  const match = text.match(
    /^\s*(\*\*)?((?:#{1,6}\s+)?(?:(?:\d{1,2}|[一二三四五六七八九十百]+)[.、．]\s*|[（(](?:\d{1,2}|[一二三四五六七八九十百]+)[）)]\s*)[^：:\n*]{1,40}[：:])(?:\*\*)?/u,
  );
  if (match?.[2] === undefined) return undefined;
  return match[1] === undefined ? match[2] : `**${match[2]}**`;
}

function startsWithStructuralMarker(text: string): boolean {
  return /^\s*(?:\*\*)?(?:#{1,6}\s+)?(?:(?:\d{1,2}|[一二三四五六七八九十百]+)[.、．]|[（(](?:\d{1,2}|[一二三四五六七八九十百]+)[）)])/u
    .test(text);
}

function splitTargetSegments(answer: string): TargetSegment[] {
  const pieces = normalizeTrailingCitationPlacement(answer)
    .split(/\r?\n+/u)
    .flatMap(splitTargetLine);
  const segments: TargetSegment[] = [];
  const pendingStructuralHeadings: string[] = [];
  for (const piece of pieces) {
    const { text } = piece;
    if (isPureStructuralHeading(text)) {
      pendingStructuralHeadings.push(text);
      continue;
    }
    const materializedText = pendingStructuralHeadings.length === 0
      ? text
      : `${pendingStructuralHeadings.join("\n")}\n${text}`;
    pendingStructuralHeadings.length = 0;
    segments.push({
      index: segments.length,
      text: materializedText,
      citations: piece.citations,
    });
  }
  return segments;
}

function splitTargetLine(line: string): Array<{
  readonly text: string;
  readonly citations: readonly number[];
}> {
  const pieces = splitAnswerLineSegments(line)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      citations: stableUnique(
        [...text.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      ),
    }));
  return pieces.map((piece, index) => {
    if (piece.citations.length > 0) return piece;
    const inheritedCitations = followingLineCitationScope(pieces, index);
    if (inheritedCitations.length === 0) return piece;
    return {
      text: piece.text.replace(
        /([。！？；!?]+)\s*$/u,
        ` ${inheritedCitations.map((citation) => `[${citation}]`).join("")}$1`,
      ),
      citations: inheritedCitations,
    };
  });
}

function followingLineCitationScope(
  pieces: readonly { readonly text: string; readonly citations: readonly number[] }[],
  index: number,
): readonly number[] {
  for (let cursor = index + 1; cursor < pieces.length; cursor += 1) {
    const candidate = pieces[cursor];
    if (candidate === undefined) return [];
    if (candidate.citations.length > 0) return candidate.citations;
  }
  return [];
}

function isPureStructuralHeading(text: string): boolean {
  return /^(?:#{1,6}\s+\S[^\n]*|\*\*[^*\n]+\*\*[:：]?)$/u.test(text) &&
    !/\[\d+\]/u.test(text);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
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
