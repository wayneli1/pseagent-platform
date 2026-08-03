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
import { normalizeTrailingCitationPlacement } from "./references.js";

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

export interface CoverageVerificationSummary {
  readonly id: string;
  readonly reason: CoverageVerificationReason;
  readonly retainedDirectSegmentCount: number;
  readonly retainedSynthesizedSegmentCount: number;
  readonly removedSegmentCount: number;
  readonly coveredAspectCount?: number;
  readonly missingAspectCount?: number;
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
  return /(?:是否|能否|有没有|是否具备|支不支持|支持|兼容|适配)/u.test(
    question,
  )
    ? "正式知识库未提及用户询问的目标协议、功能或能力，无法根据正式知识库确认是否支持或兼容。"
    : NOT_COVERED_REQUIREMENT_ANSWER;
}

export async function verifyKnowledgeCoverage(
  input: CoverageVerifierInput,
): Promise<FinalAction> {
  const targetSegments = input.draft.requirements.map((requirement) => ({
    id: requirement.id,
    segments: splitTargetSegments(requirement.answer),
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
      const invalidReason = validateVerification(input, candidate, targetSegments);
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
  );
  input.onVerified?.(summaries);
  return materialized;
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
      if (
        Array.isArray(requirement.synthesizedTargetSegmentIndexes) &&
        requirement.synthesizedTargetSegmentIndexes.length > 0
      ) {
        return {
          ...requirement,
          reason: requirement.targetDecision === "retain_partial"
            ? "partial_support"
            : "synthesized_support",
        };
      }
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
      const unsupportedCitation = segment.citations.find(
        (citation) => !evidenceCitations.has(citation),
      );
      if (unsupportedCitation !== undefined) {
        return `target_segment_citation_not_in_evidence:${decision.id}:${unsupportedCitation}`;
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
): CoverageVerificationSummary[] {
  return verified.requirements.map((decision, index) => {
    const synthesized = new Set(
      decision.synthesizedTargetSegmentIndexes,
    );
    const retainedDirectSegmentCount =
      decision.retainedTargetSegmentIndexes.filter(
        (segmentIndex) => !synthesized.has(segmentIndex),
      ).length;
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
    const semanticallyCoveredAspectIds = new Set([
      ...(decision.coveredAspectIds ?? []),
      ...(plannedRequirement === undefined
        ? []
        : matchingPlannedAspectIds(plannedRequirement, coverageText)),
    ]);
    const coveredAspectIds = new Set(
      [...semanticallyCoveredAspectIds].filter(
        (aspectId) => supportedAspectIds.has(aspectId),
      ),
    );
    const coveredAspectCount = plannedAspectIds.filter(
      (aspectId) => coveredAspectIds.has(aspectId),
    ).length;
    return {
      id: decision.id,
      reason: decision.reason,
      retainedDirectSegmentCount,
      retainedSynthesizedSegmentCount: synthesized.size,
      removedSegmentCount:
        (targetSegments[index]?.segments.length ?? 0) -
        decision.retainedTargetSegmentIndexes.length,
      coveredAspectCount,
      missingAspectCount:
        plannedAspectIds.length - coveredAspectCount,
    };
  });
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
): FinalAction {
  const requirements = action.requirements.map((requirement, index) => {
    const plannedAspectCount =
      plan.requirements[index]?.evidenceAspects.length ?? 0;
    const summary = summaries[index];
    if (summary === undefined || plannedAspectCount === 0) {
      return requirement;
    }
    if (
      requirement.coverage === "partial" &&
      summary.removedSegmentCount > 0 &&
      summary.retainedDirectSegmentCount +
          summary.retainedSynthesizedSegmentCount > 0 &&
      summary.coveredAspectCount === plannedAspectCount &&
      summary.missingAspectCount === 0
    ) {
      return {
        ...requirement,
        coverage: "complete" as const,
      };
    }
    if (
      requirement.coverage !== "complete" ||
      plannedAspectCount <= 1 ||
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
    .flatMap((line) => line.match(/[^。！？；!?\n]+(?:[。！？；!?]+|$)/gu) ?? [])
    .map((piece) => piece.trim())
    .filter(Boolean);
  const segments: TargetSegment[] = [];
  for (const text of pieces) {
    const citations = stableUnique(
      [...text.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
    );
    if (citations.length === 0) continue;
    segments.push({
      index: segments.length,
      text,
      citations,
    });
  }
  return segments;
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
