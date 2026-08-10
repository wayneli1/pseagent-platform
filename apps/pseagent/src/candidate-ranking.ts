export interface RetrievalRankingCandidate {
  readonly id?: string;
  readonly path: string;
  readonly title: string;
  readonly pageType?: string;
  readonly aspectIds: readonly string[] | ReadonlySet<string>;
  readonly rrfScore: number;
  readonly requirementSpecificMatch: boolean;
  readonly reviewStatus?: string;
  readonly obligationVariantRank?: number;
}

export interface CandidateScore {
  readonly titleCoverage: number;
  readonly obligationFit: number;
  readonly aspectCoverage: number;
  readonly directness: number;
  readonly sourceTier: number;
  readonly freshness: number;
  readonly rrf: number;
  readonly total: number;
}

export interface RankedRetrievalCandidate<T extends RetrievalRankingCandidate> {
  readonly candidate: T;
  readonly score: CandidateScore;
}

export function rankRetrievalCandidates<T extends RetrievalRankingCandidate>(input: {
  readonly question: string;
  readonly queries: readonly string[];
  readonly evidenceMode: "direct_only" | "synthesis_allowed";
  readonly missingAspectIds: readonly string[];
  readonly candidates: readonly T[];
}): RankedRetrievalCandidate<T>[] {
  const ranked = input.candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate({
      candidate,
      question: input.question,
      queries: input.queries,
      missingAspectIds: input.missingAspectIds,
    }),
  }));
  return ranked.sort((left, right) => {
    const byObligationFit = right.score.obligationFit - left.score.obligationFit;
    const byAspect = right.score.aspectCoverage - left.score.aspectCoverage;
    const byTitle = right.score.titleCoverage - left.score.titleCoverage;
    const byDirectness = right.score.directness - left.score.directness;
    const bySourceTier = left.score.sourceTier - right.score.sourceTier;
    const byFreshness = right.score.freshness - left.score.freshness;
    const byRrf = right.score.rrf - left.score.rrf;
    return input.evidenceMode === "direct_only"
      ? byObligationFit || byAspect || byTitle || byDirectness || bySourceTier || byFreshness ||
        byRrf || left.candidate.path.localeCompare(right.candidate.path)
      : byObligationFit || byAspect || byDirectness || byTitle || bySourceTier || byFreshness ||
        byRrf || left.candidate.path.localeCompare(right.candidate.path);
  });
}

function scoreCandidate(input: {
  readonly candidate: RetrievalRankingCandidate;
  readonly question: string;
  readonly queries: readonly string[];
  readonly missingAspectIds: readonly string[];
}): CandidateScore {
  const titleCoverage = titleCoverageScore(
    input.candidate.title,
    [input.question, ...input.queries],
  );
  const obligationVariantRank = input.candidate.obligationVariantRank;
  const obligationFit = typeof obligationVariantRank === "number" &&
      Number.isSafeInteger(obligationVariantRank) &&
      obligationVariantRank > 0 &&
      obligationVariantRank <= 10
    ? 11 - obligationVariantRank
    : 0;
  const missing = new Set(input.missingAspectIds);
  const aspectCoverage = [...input.candidate.aspectIds].filter((id) =>
    missing.has(id)).length;
  const directness = input.candidate.requirementSpecificMatch ? 1 : 0;
  const sourceTier = candidateSourceTier(
    input.candidate.path,
    input.candidate.pageType,
  );
  const freshness = /^(?:approved|current|verified)$/iu.test(
    input.candidate.reviewStatus ?? "",
  ) ? 1 : 0;
  const rrf = Number.isFinite(input.candidate.rrfScore)
    ? input.candidate.rrfScore
    : 0;
  return {
    titleCoverage,
    obligationFit,
    aspectCoverage,
    directness,
    sourceTier,
    freshness,
    rrf,
    total:
      obligationFit * 10_000 +
      aspectCoverage * 1_000 +
      titleCoverage * 10 +
      directness * 5 +
      (6 - sourceTier) +
      freshness +
      rrf,
  };
}

export function candidateSourceTier(path: string, pageType?: string): number {
  const normalizedPath = path.toLocaleLowerCase("zh-CN");
  const normalizedType = pageType?.toLocaleLowerCase("zh-CN") ?? "";
  if (
    ["query", "concept", "entity", "comparison"].includes(normalizedType) ||
    /^wiki\/(?:queries|query|concepts?|entities?|comparisons?)\//u.test(normalizedPath)
  ) {
    return 0;
  }
  if (
    ["synthesis", "guide", "overview"].includes(normalizedType) ||
    /^wiki\/(?:synthesis|syntheses|guides?)\//u.test(normalizedPath) ||
    /^wiki\/(?:overview|index)\.md$/u.test(normalizedPath)
  ) {
    return 1;
  }
  if (
    ["source", "raw"].includes(normalizedType) ||
    /^wiki\/(?:sources?|raw)\//u.test(normalizedPath)
  ) {
    return 2;
  }
  if (
    ["pricing", "quote"].includes(normalizedType) ||
    /(?:报价|价格|pricing|quote)/iu.test(normalizedPath)
  ) {
    return 4;
  }
  if (
    ["finding", "case", "historical"].includes(normalizedType) ||
    /^wiki\/(?:findings?|cases?|history)\//u.test(normalizedPath)
  ) {
    return 3;
  }
  return 2;
}

function titleCoverageScore(title: string, values: readonly string[]): number {
  const titleTerms = semanticTerms(title);
  if (titleTerms.size === 0) return 0;
  const expectedTerms = new Set(values.flatMap((value) => [...semanticTerms(value)]));
  let score = 0;
  for (const term of titleTerms) {
    if (expectedTerms.has(term)) score += term.length > 2 ? 2 : 1;
  }
  return score;
}

function semanticTerms(value: string): Set<string> {
  const terms = new Set<string>();
  for (const token of value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(token)) {
      if (token.length <= 2) terms.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    } else if (token.length >= 2) {
      terms.add(token);
    }
  }
  return terms;
}
