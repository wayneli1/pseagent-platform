export type RetrievalGoldProject = "coremail-professional" | "presales-general";

export interface CurrentRetrievalGoldCase {
  readonly id: string;
  readonly project: RetrievalGoldProject;
  readonly category: string;
  readonly query: string;
  readonly expectedPaths: readonly string[];
}

export interface CurrentRetrievalGoldDataset {
  readonly schemaVersion: 1;
  readonly frozenAt: string;
  readonly knowledgeRevisions: Readonly<Record<RetrievalGoldProject, string>>;
  readonly topK: 10;
  readonly minimumRecall: number;
  readonly cases: readonly CurrentRetrievalGoldCase[];
}

export interface CurrentRetrievalGoldObservation {
  readonly caseId: string;
  readonly project: RetrievalGoldProject;
  readonly revision: string;
  readonly hits: readonly { readonly path: string; readonly score: number }[];
  readonly latencyMs: number;
  readonly failure?: string;
}

export function parseCurrentRetrievalGoldDataset(
  value: unknown,
): CurrentRetrievalGoldDataset {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    typeof value.frozenAt !== "string" || Number.isNaN(Date.parse(value.frozenAt)) ||
    value.topK !== 10 || typeof value.minimumRecall !== "number" ||
    value.minimumRecall < 0.95 || value.minimumRecall > 1 ||
    !isRecord(value.knowledgeRevisions) || !Array.isArray(value.cases) ||
    value.cases.length !== 60) {
    throw new Error("invalid_current_retrieval_gold_dataset");
  }
  const knowledgeRevisions = parseRevisions(value.knowledgeRevisions);
  const cases = value.cases.map((item, index) => parseCase(item, index));
  for (const project of ["coremail-professional", "presales-general"] as const) {
    if (cases.filter((item) => item.project === project).length !== 30) {
      throw new Error("current_retrieval_gold_project_balance_invalid");
    }
  }
  if (new Set(cases.map((item) => normalizeQuery(item.query))).size !== cases.length) {
    throw new Error("current_retrieval_gold_duplicate_query");
  }
  if (new Set(cases.flatMap((item) => item.expectedPaths)).size !==
    cases.reduce((sum, item) => sum + item.expectedPaths.length, 0)) {
    throw new Error("current_retrieval_gold_duplicate_expected_path");
  }
  return {
    schemaVersion: 1,
    frozenAt: value.frozenAt,
    knowledgeRevisions,
    topK: 10,
    minimumRecall: value.minimumRecall,
    cases,
  };
}

export function buildCurrentRetrievalGoldReport(
  dataset: CurrentRetrievalGoldDataset,
  observations: readonly CurrentRetrievalGoldObservation[],
) {
  validateObservations(dataset, observations);
  const caseById = new Map(dataset.cases.map((item) => [item.id, item] as const));
  const scored = observations.map((observation) => {
    const testCase = caseById.get(observation.caseId)!;
    const available = observation.failure === undefined;
    const rank = available
      ? firstExpectedRank(testCase.expectedPaths, observation.hits.map((item) => item.path))
      : undefined;
    return {
      id: testCase.id,
      project: testCase.project,
      category: testCase.category,
      available,
      recalled: rank !== undefined,
      ...(rank === undefined ? {} : { rank }),
      latencyMs: observation.latencyMs,
      ...(observation.failure === undefined ? {} : { failure: observation.failure }),
      observedPaths: observation.hits.map((item) => item.path),
    };
  });
  const summarize = (items: typeof scored) => {
    const total = items.length;
    const available = items.filter((item) => item.available).length;
    const recalled = items.filter((item) => item.recalled).length;
    return {
      total,
      available,
      availabilityRate: rate(available, total),
      recalled,
      recallRate: rate(recalled, total),
    };
  };
  const overall = summarize(scored);
  const perProject = Object.fromEntries(
    (["coremail-professional", "presales-general"] as const).map((project) => [
      project,
      summarize(scored.filter((item) => item.project === project)),
    ]),
  ) as Record<RetrievalGoldProject, ReturnType<typeof summarize>>;
  const qualified = overall.available === overall.total &&
    overall.recallRate >= dataset.minimumRecall &&
    Object.values(perProject).every((item) =>
      item.recallRate >= dataset.minimumRecall);
  return {
    schemaVersion: 1 as const,
    qualified,
    minimumRecall: dataset.minimumRecall,
    overall,
    perProject,
    cases: scored,
    failures: scored.filter((item) => !item.recalled),
  };
}

function validateObservations(
  dataset: CurrentRetrievalGoldDataset,
  observations: readonly CurrentRetrievalGoldObservation[],
): void {
  if (observations.length !== dataset.cases.length) {
    throw new Error("current_retrieval_gold_observation_count_invalid");
  }
  const caseById = new Map(dataset.cases.map((item) => [item.id, item] as const));
  const seen = new Set<string>();
  for (const observation of observations) {
    const testCase = caseById.get(observation.caseId);
    if (testCase === undefined || seen.has(observation.caseId) ||
      observation.project !== testCase.project ||
      observation.revision !== dataset.knowledgeRevisions[testCase.project] ||
      !Number.isSafeInteger(observation.latencyMs) || observation.latencyMs < 0 ||
      observation.hits.length > dataset.topK ||
      observation.hits.some((hit) => !safePath(hit.path) || !Number.isFinite(hit.score))) {
      throw new Error("invalid_current_retrieval_gold_observation");
    }
    seen.add(observation.caseId);
  }
}

function parseRevisions(
  value: Record<string, unknown>,
): Record<RetrievalGoldProject, string> {
  const professional = value["coremail-professional"];
  const general = value["presales-general"];
  if (!revision(professional) || !revision(general) || Object.keys(value).length !== 2) {
    throw new Error("invalid_current_retrieval_gold_revisions");
  }
  return {
    "coremail-professional": professional,
    "presales-general": general,
  };
}

function parseCase(value: unknown, index: number): CurrentRetrievalGoldCase {
  const expectedId = `RG${String(index + 1).padStart(3, "0")}`;
  if (!isRecord(value) || value.id !== expectedId ||
    (value.project !== "coremail-professional" && value.project !== "presales-general") ||
    typeof value.category !== "string" || value.category.trim().length < 2 ||
    typeof value.query !== "string" || value.query.trim().length < 6 ||
    !Array.isArray(value.expectedPaths) || value.expectedPaths.length !== 1 ||
    value.expectedPaths.some((path) => !safePath(path))) {
    throw new Error(`invalid_current_retrieval_gold_case_${expectedId}`);
  }
  return {
    id: value.id,
    project: value.project,
    category: value.category.trim(),
    query: value.query.trim(),
    expectedPaths: [...value.expectedPaths] as string[],
  };
}

function firstExpectedRank(
  expectedPaths: readonly string[],
  observedPaths: readonly string[],
): number | undefined {
  const expected = new Set(expectedPaths);
  const index = observedPaths.findIndex((path) => expected.has(path));
  return index < 0 ? undefined : index + 1;
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("wiki/") &&
    value.endsWith(".md") && !value.includes("\\") && !value.split("/").includes("..");
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function rate(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
