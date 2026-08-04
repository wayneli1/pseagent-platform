import { z } from "zod";
import type {
  EvidenceLedger,
  EvidenceLedgerUnit,
  EvidenceQueryRecord,
  EvidenceReadRecord,
  EvidenceSourceBoundary,
} from "./evidence-ledger.js";

export const coverageGapClassSchema = z.enum([
  "knowledge",
  "retrieval",
  "source",
  "input",
  "ambiguity",
  "conflict",
  "freshness",
]);

export const coverageGapReasonSchema = z.enum([
  "no_matching_page",
  "read_pages_do_not_support",
  "summary_only",
  "external_source_only",
  "candidate_not_read",
  "retrieval_budget_exhausted",
  "access_denied",
  "tool_unavailable",
  "conflicting_sources",
  "stale_or_unconfirmed",
  "ambiguous_question",
  "required_customer_input_missing",
  "unsupported_claim_removed",
]);

export const coverageGapSchema = z.object({
  id: z.string().regex(/^G[1-9]\d*$/u),
  requirementId: z.string().regex(/^R[1-6]$/u),
  deliverableId: z.string().regex(/^D[1-9]\d*$/u),
  obligationId: z.string().regex(/^O[1-9]\d*$/u),
  domain: z.enum(["coremail-professional", "presales-general"]),
  gapClass: coverageGapClassSchema,
  reason: coverageGapReasonSchema,
  subject: z.string().trim().min(1).max(1_024),
  missingAspect: z.string().trim().min(1).max(1_024),
  affectsConclusion: z.boolean(),
  confirmedBoundary: z.string().trim().min(1).max(2_048).optional(),
  nextAction: z.string().trim().min(1).max(2_048).optional(),
}).strict();

export type CoverageGapClass = z.infer<typeof coverageGapClassSchema>;
export type CoverageGapReason = z.infer<typeof coverageGapReasonSchema>;
export type CoverageGap = z.infer<typeof coverageGapSchema>;

interface GapAttribution {
  readonly gapClass: CoverageGapClass;
  readonly reason: CoverageGapReason;
}

export function analyzeCoverageGaps(ledger: EvidenceLedger): readonly CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const missingInputSubjects = new Set(
    ledger.units
      .filter((unit) => unit.inputState === "missing")
      .map((unit) => normalizeGapSubject(unit.subject)),
  );
  for (const unit of ledger.units) {
    for (const missingAspect of missingAspects(unit)) {
      const attribution = classifyGap(unit, missingAspect.id);
      if (attribution === undefined) continue;
      if (
        unit.inputState !== "missing" &&
        missingInputSubjects.has(normalizeGapSubject(unit.subject)) &&
        ["knowledge", "retrieval", "source"].includes(attribution.gapClass)
      ) {
        continue;
      }
      const text = gapGuidance(attribution, missingAspect);
      gaps.push(coverageGapSchema.parse({
        id: `G${gaps.length + 1}`,
        requirementId: unit.binding.requirementId,
        deliverableId: unit.binding.deliverableId,
        obligationId: unit.binding.obligationId,
        domain: unit.binding.domain,
        gapClass: attribution.gapClass,
        reason: attribution.reason,
        subject: unit.subject,
        missingAspect: missingAspect.label,
        affectsConclusion: true,
        confirmedBoundary: text.confirmedBoundary,
        nextAction: text.nextAction,
      }));
    }
  }
  return Object.freeze(gaps.map((gap) => Object.freeze(gap)));
}

function normalizeGapSubject(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function classifyGap(
  unit: EvidenceLedgerUnit,
  aspectId: string,
): GapAttribution | undefined {
  if (unit.inputState === "missing") {
    return { gapClass: "input", reason: "required_customer_input_missing" };
  }
  if (unit.ambiguous) {
    return { gapClass: "ambiguity", reason: "ambiguous_question" };
  }
  if (!unit.verification.missing) return undefined;

  const relevantCandidates = unit.candidates.filter((candidate) =>
    appliesToAspect(candidate.aspectIds, aspectId));
  const relevantCandidatePaths = new Set(
    relevantCandidates.map((candidate) => candidate.path),
  );
  const reviewCandidates = relevantCandidates.filter((candidate) =>
    candidate.reviewRequired);
  const successfulReadPaths = new Set(
    unit.reads.filter((read) => read.status === "success").map((read) => read.path),
  );
  const relevantReads = unit.reads.filter((read) =>
    relevantCandidatePaths.has(read.path));
  const hasAccessFailure = hasUnboundAccessFailure(unit) ||
    relevantReads.some((read) =>
      read.status === "access_denied" &&
      !successfulReadPaths.has(read.path));
  if (hasAccessFailure) {
    return { gapClass: "retrieval", reason: "access_denied" };
  }
  const relevantQueries = unit.queries.filter((query) =>
    queryAppliesToAspect(unit, query, aspectId));
  const hasQueryFailure = relevantQueries.some((query) =>
    query.status === "unavailable" && !queryWasRecovered(unit.queries, query));
  const hasGraphFailure = unit.graphs.some((graph) =>
    relevantCandidatePaths.has(graph.sourcePath) &&
    graph.status === "unavailable" &&
    !unit.graphs.some((later) =>
      later.sourcePath === graph.sourcePath && later.status !== "unavailable"));
  const hasReadFailure = relevantReads.some((read) =>
      read.status === "unavailable" &&
      !successfulReadPaths.has(read.path));
  const hasToolFailure = hasUnboundToolFailure(unit) ||
    hasQueryFailure || hasGraphFailure || hasReadFailure;
  if (hasToolFailure) {
    return { gapClass: "retrieval", reason: "tool_unavailable" };
  }
  if (
    unit.retrieval.deadlineReached ||
    unit.retrieval.searchBudgetExhausted ||
    unit.retrieval.readBudgetExhausted
  ) {
    return { gapClass: "retrieval", reason: "retrieval_budget_exhausted" };
  }
  if (reviewCandidates.some((candidate) => !successfulReadPaths.has(candidate.path))) {
    return { gapClass: "retrieval", reason: "candidate_not_read" };
  }

  const sourceBoundary = sourceBoundaryForAspect(relevantReads);
  if (sourceBoundary === "summary_only") {
    return { gapClass: "source", reason: "summary_only" };
  }
  if (sourceBoundary === "external_only") {
    return { gapClass: "source", reason: "external_source_only" };
  }
  if (unit.conflictDetected) {
    return { gapClass: "conflict", reason: "conflicting_sources" };
  }
  if (unit.freshness === "stale_or_unconfirmed") {
    return { gapClass: "freshness", reason: "stale_or_unconfirmed" };
  }
  if (unit.verification.reason === "unsupported_claim_removed") {
    return { gapClass: "knowledge", reason: "unsupported_claim_removed" };
  }

  const allPlannedQueriesCompleted = plannedQueriesCompleted(unit, aspectId);
  if (allPlannedQueriesCompleted && reviewCandidates.length === 0) {
    return { gapClass: "knowledge", reason: "no_matching_page" };
  }
  if (
    allPlannedQueriesCompleted &&
    reviewCandidates.length > 0 &&
    reviewCandidates.every((candidate) => successfulReadPaths.has(candidate.path))
  ) {
    return { gapClass: "knowledge", reason: "read_pages_do_not_support" };
  }
  return { gapClass: "retrieval", reason: "tool_unavailable" };
}

function missingAspects(
  unit: EvidenceLedgerUnit,
): readonly { readonly id: string; readonly label: string }[] {
  const labelById = new Map(
    unit.requirement.evidenceAspects.map((aspect) => [aspect.id, aspect.label] as const),
  );
  return unit.verification.missingAspectIds.flatMap((aspectId) => {
    const label = labelById.get(aspectId)?.trim();
    return label === undefined || label.length === 0
      ? []
      : [{ id: aspectId, label }];
  });
}

function appliesToAspect(
  aspectIds: readonly string[],
  aspectId: string,
): boolean {
  return aspectIds.length === 0 || aspectIds.includes(aspectId);
}

function queryAppliesToAspect(
  unit: EvidenceLedgerUnit,
  query: EvidenceQueryRecord,
  aspectId: string,
): boolean {
  return appliesToAspect(query.aspectIds, aspectId) ||
    query.plannedQueryIndexes.some((plannedIndex) =>
      unit.requirement.queries[plannedIndex]?.aspectIds.includes(aspectId) === true);
}

function queryWasRecovered(
  queries: readonly EvidenceQueryRecord[],
  failed: EvidenceQueryRecord,
): boolean {
  const failedQuery = normalizeQuery(failed.query);
  return queries.some((query) =>
    query.status !== "unavailable" && normalizeQuery(query.query) === failedQuery);
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");
}

function plannedQueriesCompleted(
  unit: EvidenceLedgerUnit,
  aspectId: string,
): boolean {
  const relevantPlannedIndexes = unit.requirement.queries.flatMap((query, index) =>
    query.aspectIds.includes(aspectId) ? [index] : []);
  return relevantPlannedIndexes.length > 0 &&
    relevantPlannedIndexes.every((plannedIndex) => {
      const execution = unit.queries.find((query) =>
        query.plannedQueryIndexes.includes(plannedIndex));
      return execution !== undefined &&
        (
          execution.status !== "unavailable" ||
          queryWasRecovered(unit.queries, execution)
        );
    });
}

function sourceBoundaryForAspect(
  reads: readonly EvidenceReadRecord[],
): EvidenceSourceBoundary {
  const successful = reads.filter((read) => read.status === "success");
  if (successful.length === 0) return "formal";
  const pageTypes = successful.map((read) => read.pageType?.toLowerCase());
  if (
    pageTypes.every((pageType) => pageType !== undefined && [
      "summary",
      "overview",
      "entity",
      "index",
      "navigation",
    ].includes(pageType))
  ) {
    return "summary_only";
  }
  if (
    pageTypes.every((pageType) =>
      pageType === "external" || pageType === "external_reference") &&
    successful.every((read) =>
      (read.sources?.length ?? 0) > 0 &&
      read.sources?.every((source) => /^https?:\/\//iu.test(source)))
  ) {
    return "external_only";
  }
  return "formal";
}

function hasUnboundAccessFailure(unit: EvidenceLedgerUnit): boolean {
  const recordedFailures = unit.reads.filter((read) =>
    read.status === "access_denied").length;
  return unit.retrieval.accessDeniedCount > recordedFailures;
}

function hasUnboundToolFailure(unit: EvidenceLedgerUnit): boolean {
  const recordedFailures =
    unit.queries.filter((query) => query.status === "unavailable").length +
    unit.graphs.filter((graph) => graph.status === "unavailable").length +
    unit.reads.filter((read) => read.status === "unavailable").length;
  return unit.retrieval.toolUnavailableCount > recordedFailures;
}

function gapGuidance(
  attribution: GapAttribution,
  missingAspect: { readonly label: string },
): { readonly confirmedBoundary: string; readonly nextAction: string } {
  const label = missingAspect.label;
  switch (attribution.reason) {
    case "required_customer_input_missing":
      return {
        confirmedBoundary: `缺少判断“${label}”所必需的当次客户输入，因此当前无法可靠判断。`,
        nextAction: `向客户或项目团队补齐与“${label}”直接相关的事实后再判断。`,
      };
    case "ambiguous_question":
      return {
        confirmedBoundary: `当前表述不足以唯一确定“${label}”的判断对象或范围。`,
        nextAction: `先澄清“${label}”的对象、范围或时间边界。`,
      };
    case "access_denied":
      return {
        confirmedBoundary: `与“${label}”相关的候选资料存在访问失败，尚未完成核验。`,
        nextAction: "恢复正式资料访问后继续核验，当前不能据此声明知识不存在。",
      };
    case "tool_unavailable":
      return {
        confirmedBoundary: `“${label}”的必要检索或读页未完整成功。`,
        nextAction: "恢复检索链路后重试，当前不能据此声明知识不存在。",
      };
    case "candidate_not_read":
      return {
        confirmedBoundary: `仍有与“${label}”相关的候选资料尚未完成核验。`,
        nextAction: `继续读取并核验“${label}”的未读候选。`,
      };
    case "retrieval_budget_exhausted":
      return {
        confirmedBoundary: `“${label}”的检索或读页预算已结束，核验尚未完整。`,
        nextAction: `在新的检索预算内继续核验“${label}”。`,
      };
    case "summary_only":
      return {
        confirmedBoundary: `当前仅有“${label}”的摘要或导航信息，不能替代正式正文。`,
        nextAction: `补充或读取“${label}”对应的正式源文档。`,
      };
    case "external_source_only":
      return {
        confirmedBoundary: `“${label}”目前仅指向尚未接入的外部来源。`,
        nextAction: `接入并核验“${label}”对应的外部正式来源。`,
      };
    case "conflicting_sources":
      return {
        confirmedBoundary: `“${label}”存在相互冲突的正式资料，当前不能合成为单一结论。`,
        nextAction: `确认适用版本、时间和权威来源后再形成“${label}”结论。`,
      };
    case "stale_or_unconfirmed":
      return {
        confirmedBoundary: `“${label}”的现有资料时效或适用版本尚未确认。`,
        nextAction: `补充当前版本或有效期证据后再确认“${label}”。`,
      };
    case "read_pages_do_not_support":
      return {
        confirmedBoundary: `相关候选已完成核验，但已读正式正文仍未支持“${label}”。`,
        nextAction: `补充“${label}”的正式知识资料，或确认该项确实不在当前知识边界内。`,
      };
    case "unsupported_claim_removed":
      return {
        confirmedBoundary: `关于“${label}”的草稿结论未通过正式证据复核，已被移除。`,
        nextAction: `补充能够直接支持“${label}”的正式正文后再回答。`,
      };
    case "no_matching_page":
      return {
        confirmedBoundary: `已完成“${label}”的必要查询，但未发现匹配的正式知识页面。`,
        nextAction: `补充“${label}”的正式知识页面，或确认该项不在当前知识边界内。`,
      };
  }
}
