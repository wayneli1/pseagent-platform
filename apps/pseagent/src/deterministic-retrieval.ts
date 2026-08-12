import type { EvidenceAspect, Reference } from "./contracts.js";
import {
  rankRetrievalCandidates,
  type RankedRetrievalCandidate,
  type RetrievalRankingCandidate,
} from "./candidate-ranking.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import {
  finalizeEvidenceLedger,
  type EvidenceCandidateDraft,
  type EvidenceLedger,
  type EvidenceLedgerDraftUnit,
  type EvidenceQueryDraft,
  type EvidenceReadDraft,
  type EvidenceSourceBoundary,
} from "./evidence-ledger.js";
import type {
  KnowledgePage,
  KnowledgeSearchResult,
  KnowledgeSession,
  ProjectKey,
} from "./knowledge-session.js";
import { ReferenceRegistry } from "./references.js";
import type { KnowledgeDomain } from "./task-spec.js";

export interface RetrievedEvidence {
  readonly requirementId: string;
  readonly obligationId: string;
  readonly domain: KnowledgeDomain;
  readonly citation: number;
  readonly path: string;
  readonly title: string;
  readonly compactContent: string;
  readonly aspectIds: readonly string[];
  readonly aspectRequirements: readonly EvidenceAspect[];
  readonly sourceBoundary: EvidenceSourceBoundary;
}

export interface DeterministicRetrievalResult {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly evidence: readonly RetrievedEvidence[];
  readonly references: readonly Reference[];
  readonly evidenceLedger: EvidenceLedger;
}

interface SearchGroup {
  readonly query: string;
  readonly aspectIds: readonly string[];
  readonly plannedQueryIndexes: readonly number[];
}

interface MergedCandidate extends RetrievalRankingCandidate {
  readonly aspectIds: Set<string>;
  readonly matchedTerms: Set<string>;
  readonly sources: Set<"seed">;
  pageType?: string;
  reviewStatus?: string;
  rrfScore: number;
  obligationVariantRank?: number;
}

export class DeterministicRetrievalCoordinator {
  async retrieve(input: {
    readonly plan: DomainKnowledgePlan;
    readonly session: KnowledgeSession;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
    readonly trace: DiagnosticTrace;
  }): Promise<DeterministicRetrievalResult> {
    const registry = new ReferenceRegistry(
      input.session.project,
      input.session.revision,
    );
    const evidence: RetrievedEvidence[] = [];
    const units: EvidenceLedgerDraftUnit[] = [];

    for (const [unitIndex, requirement] of input.plan.plan.requirements.entries()) {
      const binding = input.plan.bindings[unitIndex];
      if (binding === undefined || binding.requirementId !== requirement.id) {
        throw new Error("deterministic_retrieval_binding_mismatch");
      }
      const condition = input.plan.conditions?.find((item) =>
        item.requirementId === requirement.id);
      const groups = groupSeedQueries(requirement.queries);
      const queryDrafts: EvidenceQueryDraft[] = [];
      const merged = new Map<string, MergedCandidate>();
      let toolUnavailableCount = 0;
      const inputMissing = condition?.inputState === "missing";

      for (const group of groups) {
        recordDiagnostic(input.trace, {
          event: "search",
          requirementId: requirement.id,
          phase: "seed",
          queryChars: [...group.query].length,
          aspectIds: group.aspectIds,
        });
        if (inputMissing) {
          queryDrafts.push({
            phase: "seed",
            query: group.query,
            aspectIds: group.aspectIds,
            status: "not_applicable",
            plannedQueryIndexes: group.plannedQueryIndexes,
          });
          continue;
        }
        if (deadlineReached(input)) {
          queryDrafts.push({
            phase: "seed",
            query: group.query,
            aspectIds: group.aspectIds,
            status: "unavailable",
            plannedQueryIndexes: group.plannedQueryIndexes,
          });
          toolUnavailableCount += 1;
          continue;
        }
        try {
          const result = await input.session.search(group.query, 10, input.signal);
          mergeSearchHits(merged, result, group);
          queryDrafts.push({
            phase: "seed",
            query: group.query,
            aspectIds: group.aspectIds,
            status: result.hits.length === 0 ? "empty" : "success",
            plannedQueryIndexes: group.plannedQueryIndexes,
          });
        } catch {
          toolUnavailableCount += 1;
          queryDrafts.push({
            phase: "seed",
            query: group.query,
            aspectIds: group.aspectIds,
            status: "unavailable",
            plannedQueryIndexes: group.plannedQueryIndexes,
          });
        }
      }

      const allAspectIds = requirement.evidenceAspects.map((aspect) => aspect.id);
      const ranked = preferGovernedEvidencePaths(rankRetrievalCandidates({
        question: requirement.question,
        queries: groups.map((group) => group.query),
        evidenceMode: requirement.evidenceMode,
        missingAspectIds: allAspectIds,
        candidates: [...merged.values()],
      }), binding);
      recordCandidateDiagnostics(input.trace, requirement.id, allAspectIds, ranked);

      const reads: EvidenceReadDraft[] = [];
      const coveredAspectIds = new Set<string>();
      let consecutiveNoGain = 0;
      for (const item of ranked.slice(0, 3)) {
        if (deadlineReached(input) || consecutiveNoGain >= 2) break;
        const before = coveredAspectIds.size;
        try {
          const page = await input.session.readPage(item.candidate.path, input.signal);
          const reference = registry.register({
            project: input.session.project,
            revision: input.session.revision,
            page,
          });
          for (const aspectId of item.candidate.aspectIds) {
            coveredAspectIds.add(aspectId);
          }
          const sourceBoundary = pageSourceBoundary(page);
          evidence.push({
            requirementId: requirement.id,
            obligationId: binding.obligationId,
            domain: binding.domain,
            citation: reference.index,
            path: page.path,
            title: page.title,
            compactContent: input.session.compactPage(
              page,
              [...item.candidate.matchedTerms],
            ),
            aspectIds: stableInOrder(allAspectIds, item.candidate.aspectIds),
            aspectRequirements: requirement.evidenceAspects
              .filter((aspect) => item.candidate.aspectIds.has(aspect.id))
              .map((aspect) => ({
                ...aspect,
                terms: [...aspect.terms],
              })),
            sourceBoundary,
          });
          reads.push({
            path: page.path,
            status: "success",
            citation: reference.index,
            pageType: page.type,
            sources: page.sources,
          });
          recordDiagnostic(input.trace, {
            event: "read",
            requirementId: requirement.id,
            citation: reference.index,
            sectionHeadingCount: page.body.match(/^#{1,6}\s+/gmu)?.length ?? 0,
            aspectIds: stableInOrder(allAspectIds, item.candidate.aspectIds),
          });
        } catch {
          toolUnavailableCount += 1;
          reads.push({ path: item.candidate.path, status: "unavailable" });
        }
        consecutiveNoGain = coveredAspectIds.size === before
          ? consecutiveNoGain + 1
          : 0;
        if (allAspectIds.every((aspectId) => coveredAspectIds.has(aspectId))) break;
      }

      const complete = allAspectIds.every((aspectId) => coveredAspectIds.has(aspectId));
      const unitBoundary = combinedSourceBoundary(reads);
      units.push({
        binding,
        subject: input.plan.plan.subject,
        requirement,
        queries: queryDrafts,
        candidates: ranked.map((item, index) => candidateDraft(item, index)),
        reads,
        graphs: [],
        claims: [],
        retrieval: {
          deadlineReached: Date.now() >= input.deadlineAt,
          searchBudgetExhausted: requirement.queries.length > 3,
          readBudgetExhausted: !complete && ranked.length > reads.length && reads.length >= 3,
          toolUnavailableCount,
          accessDeniedCount: 0,
        },
        sourceBoundary: unitBoundary,
        conflictDetected: condition?.conflictDetected ?? false,
        freshness: condition?.freshness ?? "not_assessed",
        inputState: condition?.inputState ?? "not_applicable",
        ambiguous: condition?.ambiguous ?? false,
        verification: complete
          ? {
              coverage: "complete",
              reason: requirement.evidenceMode === "direct_only"
                ? "direct_support"
                : "synthesized_support",
              coveredAspectIds: allAspectIds,
              missingAspectIds: [],
            }
          : {
              coverage: "none",
              reason: "target_omitted",
              coveredAspectIds: [],
              missingAspectIds: allAspectIds,
            },
      });
    }

    return {
      project: input.session.project,
      revision: input.session.revision,
      evidence: Object.freeze(evidence),
      references: registry.list(),
      evidenceLedger: finalizeEvidenceLedger({
        project: input.session.project,
        revision: input.session.revision,
        units,
      }),
    };
  }
}

function preferGovernedEvidencePaths<T extends RetrievalRankingCandidate>(
  ranked: readonly RankedRetrievalCandidate<T>[],
  binding: DomainKnowledgePlan["bindings"][number],
): readonly RankedRetrievalCandidate<T>[] {
  if (binding.cardId === undefined || (binding.preferredEvidencePaths?.length ?? 0) === 0) {
    return ranked;
  }
  const preference = new Map(binding.preferredEvidencePaths!.map((path, index) => [
    path,
    index,
  ] as const));
  return Object.freeze(ranked
    .map((item, rank) => ({ item, rank, preferred: preference.get(item.candidate.path) }))
    .sort((left, right) => {
      if (left.preferred !== undefined && right.preferred !== undefined) {
        return left.preferred - right.preferred || left.rank - right.rank;
      }
      if (left.preferred !== undefined) return -1;
      if (right.preferred !== undefined) return 1;
      return left.rank - right.rank;
    })
    .map(({ item }) => item));
}

function groupSeedQueries(
  queries: readonly { readonly text: string; readonly aspectIds: readonly string[] }[],
): SearchGroup[] {
  const groups = queries.slice(0, 3).map((query, index): SearchGroup => ({
    query: query.text,
    aspectIds: [...query.aspectIds],
    plannedQueryIndexes: [index],
  }));
  if (queries.length > 3) {
    const last = groups[2]!;
    const remainder = queries.slice(3);
    groups[2] = {
      ...last,
      aspectIds: [...new Set([
        ...last.aspectIds,
        ...remainder.flatMap((query) => query.aspectIds),
      ])],
      plannedQueryIndexes: queries.slice(2).map((_query, index) => index + 2),
    };
  }
  return groups;
}

function mergeSearchHits(
  merged: Map<string, MergedCandidate>,
  result: KnowledgeSearchResult,
  group: SearchGroup,
): void {
  for (const [rank, hit] of result.hits.entries()) {
    const existing = merged.get(hit.path);
    if (existing === undefined) {
      merged.set(hit.path, {
        path: hit.path,
        title: hit.title,
        ...(hit.pageType === undefined ? {} : { pageType: hit.pageType }),
        ...(hit.reviewStatus === undefined
          ? {}
          : { reviewStatus: hit.reviewStatus }),
        aspectIds: new Set(group.aspectIds),
        matchedTerms: new Set(hit.matchedTerms),
        sources: new Set(["seed"]),
        rrfScore: 1 / (60 + rank + 1),
        requirementSpecificMatch: true,
        obligationVariantRank: rank + 1,
      });
      continue;
    }
    for (const aspectId of group.aspectIds) existing.aspectIds.add(aspectId);
    for (const term of hit.matchedTerms) existing.matchedTerms.add(term);
    existing.rrfScore += 1 / (60 + rank + 1);
    existing.obligationVariantRank = Math.min(
      existing.obligationVariantRank ?? rank + 1,
      rank + 1,
    );
  }
}

function candidateDraft(
  item: RankedRetrievalCandidate<MergedCandidate>,
  index: number,
): EvidenceCandidateDraft {
  return {
    path: item.candidate.path,
    title: item.candidate.title,
    sources: [...item.candidate.sources],
    aspectIds: [...item.candidate.aspectIds],
    reviewRequired: !/^(?:approved|current|verified)$/iu.test(
      item.candidate.reviewStatus ?? "",
    ),
    ranking: {
      position: index + 1,
      titleCoverage: item.score.titleCoverage,
      obligationFit: item.score.obligationFit,
      aspectCoverage: item.score.aspectCoverage,
      directness: item.score.directness,
      sourceTier: item.score.sourceTier,
      freshness: item.score.freshness,
      rrf: item.score.rrf,
    },
  };
}

function recordCandidateDiagnostics(
  trace: DiagnosticTrace,
  requirementId: string,
  aspectIds: readonly string[],
  ranked: readonly RankedRetrievalCandidate<MergedCandidate>[],
): void {
  recordDiagnostic(trace, {
    event: "candidates",
    requirementId,
    source: "seed_search_result",
    candidateCount: ranked.length,
    aspects: aspectIds.map((id) => ({
      id,
      candidateCount: ranked.filter((item) => item.candidate.aspectIds.has(id)).length,
      readCandidateCount: 0,
    })),
  });
}

function pageSourceBoundary(page: KnowledgePage): EvidenceSourceBoundary {
  const type = page.type.toLocaleLowerCase("zh-CN");
  if (["summary", "overview", "entity", "index", "navigation"].includes(type)) {
    return "summary_only";
  }
  if (
    ["external", "external_reference"].includes(type) &&
    page.sources.length > 0 &&
    page.sources.every((source) => /^https?:\/\//iu.test(source))
  ) {
    return "external_only";
  }
  return "formal";
}

function combinedSourceBoundary(reads: readonly EvidenceReadDraft[]): EvidenceSourceBoundary {
  const successful = reads.filter((read) => read.status === "success");
  if (successful.length === 0) return "formal";
  const types = successful.map((read) => read.pageType?.toLocaleLowerCase("zh-CN"));
  if (types.every((type) => type !== undefined &&
    ["summary", "overview", "entity", "index", "navigation"].includes(type))) {
    return "summary_only";
  }
  if (types.every((type) => type === "external" || type === "external_reference")) {
    return "external_only";
  }
  return "formal";
}

function deadlineReached(input: {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}): boolean {
  return input.signal.aborted || Date.now() >= input.deadlineAt;
}

function stableInOrder(
  order: readonly string[],
  values: ReadonlySet<string>,
): string[] {
  return order.filter((value) => values.has(value));
}
