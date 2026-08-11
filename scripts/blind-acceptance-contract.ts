import { createHash } from "node:crypto";
import type { ReliabilityDiagnosticSummary } from "./reliability-diagnostics.ts";

export const blindAcceptanceLayers = [
  "professional",
  "general",
  "mixed",
  "multi_turn",
  "insufficient_evidence",
  "safety_boundary",
] as const;
export type BlindAcceptanceLayer = typeof blindAcceptanceLayers[number];
export type BlindScope = "professional" | "general" | "normal";
export type BlindProject = "coremail-professional" | "presales-general";

export const enterpriseLatencyThresholds = Object.freeze({
  p95Ms: 120_000,
  p99Ms: 180_000,
});

export interface BlindAcceptanceCase {
  readonly id: string;
  readonly layer: BlindAcceptanceLayer;
  readonly question: string;
  readonly conversationContext?: string;
  readonly expectedScope: BlindScope;
  readonly expectedDomains: readonly BlindProject[];
  readonly expectedDisposition: "answer" | "partial_or_refuse";
  readonly highRisk: boolean;
  readonly requiredConcepts: readonly {
    readonly id: string;
    readonly anyOf: readonly string[];
  }[];
  readonly forbiddenPatterns: readonly string[];
  readonly minimumReferences: number;
  readonly allowedProjects: readonly BlindProject[];
}

export interface BlindAcceptanceThresholds {
  readonly availability: number;
  readonly factualAccuracy: number;
  readonly highRiskFactualAccuracy: number;
  readonly evidenceSupport: number;
  readonly routingAccuracy: number;
  readonly completeness: number;
  readonly reasonableRefusal: number;
  readonly consistency: number;
}

export interface BlindAcceptanceDataset {
  readonly schemaVersion: 1;
  readonly frozenAt: string;
  readonly thresholds: BlindAcceptanceThresholds;
  readonly cases: readonly BlindAcceptanceCase[];
}

export interface BlindAcceptanceObservation {
  readonly caseId: string;
  readonly round: 1 | 2 | 3;
  readonly codeCommit: string;
  readonly model: string;
  readonly knowledgeRevisions: Readonly<Record<BlindProject, string>>;
  readonly scope?: BlindScope;
  readonly status?: string;
  readonly answer: string;
  readonly domainsUsed?: readonly BlindProject[];
  readonly references: readonly {
    readonly index: number;
    readonly project: BlindProject;
    readonly revision: string;
  }[];
  readonly stopReason: string;
  readonly latencyMs: number;
  readonly failure?: string;
  readonly diagnostics?: ReliabilityDiagnosticSummary;
}

interface ScoredObservation {
  readonly available: boolean;
  readonly factualAccurate: boolean;
  readonly evidenceSupported: boolean;
  readonly routingCorrect: boolean;
  readonly complete: boolean;
  readonly reasonableRefusal: boolean;
  readonly forbiddenClaimCount: number;
  readonly matchedConceptIds: readonly string[];
  readonly citedConceptIds: readonly string[];
  readonly uncitedConceptIds: readonly string[];
}

export interface BlindAcceptanceHardGate {
  readonly id: string;
  readonly observed: number;
  readonly comparison: "minimum" | "maximum" | "zero";
  readonly threshold: number;
  readonly passed: boolean;
}

export function normalizeBlindQuestion(value: string): string {
  return value.normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function hashBlindQuestion(value: string): string {
  return createHash("sha256").update(normalizeBlindQuestion(value), "utf8").digest("hex");
}

export function parseBlindAcceptanceDataset(
  value: unknown,
  excludedQuestionHashes: ReadonlySet<string>,
): BlindAcceptanceDataset {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
    throw new Error("invalid_blind_acceptance_dataset");
  }
  if (value.cases.length !== 100) {
    throw new Error("blind_acceptance_requires_exactly_100_cases");
  }
  if (typeof value.frozenAt !== "string" || !Number.isFinite(Date.parse(value.frozenAt))) {
    throw new Error("invalid_blind_acceptance_frozen_at");
  }
  const thresholds = parseThresholds(value.thresholds);
  const profiles = isRecord(value.profiles) ? value.profiles : {};
  const cases = value.cases.map((item, index) =>
    parseCase(expandCaseProfile(item, profiles), index));
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) throw new Error("duplicate_blind_acceptance_case_id");
  const hashes = cases.map((item) => hashBlindQuestion(item.question));
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("duplicate_blind_acceptance_question");
  }
  if (hashes.some((hash) => excludedQuestionHashes.has(hash))) {
    throw new Error("blind_acceptance_question_collision");
  }
  for (const layer of blindAcceptanceLayers) {
    if (cases.filter((item) => item.layer === layer).length < 10) {
      throw new Error("blind_acceptance_missing_layer");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    frozenAt: value.frozenAt,
    thresholds,
    cases: Object.freeze(cases),
  });
}

function expandCaseProfile(
  value: unknown,
  profiles: Readonly<Record<string, unknown>>,
): unknown {
  if (!isRecord(value) || value.profile === undefined) return value;
  if (typeof value.profile !== "string" || !isRecord(profiles[value.profile])) {
    throw new Error("invalid_blind_acceptance_profile");
  }
  const { profile: _profile, ...specific } = value;
  return { ...profiles[value.profile], ...specific };
}

export function validateBlindAcceptanceRun(
  dataset: BlindAcceptanceDataset,
  observations: readonly BlindAcceptanceObservation[],
): void {
  if (observations.length !== dataset.cases.length * 3) {
    throw new Error("blind_acceptance_requires_three_outputs_per_case");
  }
  const knownIds = new Set(dataset.cases.map((item) => item.id));
  const keys = new Set<string>();
  for (const item of observations) {
    if (!knownIds.has(item.caseId) || ![1, 2, 3].includes(item.round)) {
      throw new Error("invalid_blind_acceptance_observation");
    }
    const key = `${item.caseId}/${item.round}`;
    if (keys.has(key)) throw new Error("duplicate_blind_acceptance_observation");
    keys.add(key);
  }
  for (const item of dataset.cases) {
    const rounds = observations.filter((observation) => observation.caseId === item.id)
      .map((observation) => observation.round).sort();
    if (rounds.join(",") !== "1,2,3") {
      throw new Error("blind_acceptance_requires_three_outputs_per_case");
    }
  }
  const runtimeKeys = new Set(observations.map((item) => JSON.stringify({
    codeCommit: item.codeCommit,
    model: item.model,
    knowledgeRevisions: item.knowledgeRevisions,
  })));
  if (runtimeKeys.size !== 1) throw new Error("blind_acceptance_runtime_drift");
}

export function buildBlindAcceptanceReport(
  dataset: BlindAcceptanceDataset,
  observations: readonly BlindAcceptanceObservation[],
) {
  validateBlindAcceptanceRun(dataset, observations);
  const caseById = new Map(dataset.cases.map((item) => [item.id, item] as const));
  const scored = observations.map((observation) => {
    const testCase = caseById.get(observation.caseId)!;
    return { observation, testCase, score: scoreObservation(testCase, observation) };
  });
  const first = scored.filter((item) => item.observation.round === 1);
  const answerableFirst = first.filter((item) =>
    item.testCase.expectedDisposition === "answer");
  const evidenceRequiredFirst = first.filter((item) =>
    item.testCase.minimumReferences > 0);
  const refusalFirst = first.filter((item) =>
    item.testCase.expectedDisposition === "partial_or_refuse");
  const highRiskFirst = answerableFirst.filter((item) => item.testCase.highRisk);
  const firstOutput = {
    total: first.length,
    available: countTrue(first, "available"),
    availabilityRate: rate(countTrue(first, "available"), first.length),
    answerableTotal: answerableFirst.length,
    factualAccurate: countTrue(answerableFirst, "factualAccurate"),
    factualAccuracyRate: rate(
      countTrue(answerableFirst, "factualAccurate"),
      answerableFirst.length,
    ),
    highRiskTotal: highRiskFirst.length,
    highRiskFactualAccurate: countTrue(highRiskFirst, "factualAccurate"),
    highRiskFactualAccuracyRate: rate(
      countTrue(highRiskFirst, "factualAccurate"),
      highRiskFirst.length,
    ),
    evidenceRequiredTotal: evidenceRequiredFirst.length,
    evidenceSupported: countTrue(evidenceRequiredFirst, "evidenceSupported"),
    evidenceSupportRate: rate(
      countTrue(evidenceRequiredFirst, "evidenceSupported"),
      evidenceRequiredFirst.length,
    ),
    routingCorrect: countTrue(first, "routingCorrect"),
    routingAccuracyRate: rate(countTrue(first, "routingCorrect"), first.length),
    complete: countTrue(answerableFirst, "complete"),
    completenessRate: rate(countTrue(answerableFirst, "complete"), answerableFirst.length),
    refusalTotal: refusalFirst.length,
    reasonableRefusals: countTrue(refusalFirst, "reasonableRefusal"),
    reasonableRefusalRate: rate(
      countTrue(refusalFirst, "reasonableRefusal"),
      refusalFirst.length,
    ),
    forbiddenClaimCount: first.reduce((sum, item) =>
      sum + item.score.forbiddenClaimCount, 0),
  };
  const allOutputLatencies = scored.map((item) => item.observation.latencyMs)
    .sort((left, right) => left - right);
  const allOutputs = {
    total: scored.length,
    available: countTrue(scored, "available"),
    availabilityRate: rate(countTrue(scored, "available"), scored.length),
    forbiddenClaimCount: scored.reduce((sum, item) =>
      sum + item.score.forbiddenClaimCount, 0),
    latencyMs: {
      p50: percentile(allOutputLatencies, 0.50),
      p95: percentile(allOutputLatencies, 0.95),
      p99: percentile(allOutputLatencies, 0.99),
      maximum: allOutputLatencies.at(-1) ?? 0,
    },
  };
  const consistentCases = dataset.cases.filter((testCase) => {
    const caseScores = scored.filter((item) => item.testCase.id === testCase.id);
    const signatures = new Set(caseScores.map((item) => consistencySignature(item)));
    return signatures.size === 1;
  }).length;
  const consistency = {
    totalCases: dataset.cases.length,
    consistentCases,
    rate: rate(consistentCases, dataset.cases.length),
  };
  const thresholds = dataset.thresholds;
  const hardGates: BlindAcceptanceHardGate[] = [
    minimumGate("all_outputs.chain_success", allOutputs.availabilityRate,
      thresholds.availability),
    minimumGate("first_output.chain_success", firstOutput.availabilityRate,
      thresholds.availability),
    minimumGate("first_output.factual_accuracy", firstOutput.factualAccuracyRate,
      thresholds.factualAccuracy),
    minimumGate("first_output.high_risk_factual_accuracy",
      firstOutput.highRiskFactualAccuracyRate, thresholds.highRiskFactualAccuracy),
    minimumGate("first_output.evidence_support", firstOutput.evidenceSupportRate,
      thresholds.evidenceSupport),
    minimumGate("first_output.routing_accuracy", firstOutput.routingAccuracyRate,
      thresholds.routingAccuracy),
    minimumGate("first_output.completeness", firstOutput.completenessRate,
      thresholds.completeness),
    minimumGate("first_output.reasonable_refusal", firstOutput.reasonableRefusalRate,
      thresholds.reasonableRefusal),
    minimumGate("three_output.conclusion_consistency", consistency.rate,
      thresholds.consistency),
    maximumGate("all_outputs.p95_latency_ms", allOutputs.latencyMs.p95,
      enterpriseLatencyThresholds.p95Ms),
    maximumGate("all_outputs.p99_latency_ms", allOutputs.latencyMs.p99,
      enterpriseLatencyThresholds.p99Ms),
    zeroGate("first_output.unsupported_critical_claims", firstOutput.forbiddenClaimCount),
    zeroGate("all_outputs.unsupported_critical_claims", allOutputs.forbiddenClaimCount),
  ];
  const qualified = hardGates.every((gate) => gate.passed);
  return {
    firstOutput,
    allOutputs,
    consistency,
    qualified,
    hardGates,
    thresholds,
    perLayer: Object.fromEntries(blindAcceptanceLayers.map((layer) => {
      const layerFirst = first.filter((item) => item.testCase.layer === layer);
      const layerAnswerable = layerFirst.filter((item) =>
        item.testCase.expectedDisposition === "answer");
      const layerEvidenceRequired = layerFirst.filter((item) =>
        item.testCase.minimumReferences > 0);
      return [layer, {
        total: layerFirst.length,
        answerableTotal: layerAnswerable.length,
        evidenceRequiredTotal: layerEvidenceRequired.length,
        availabilityRate: rate(countTrue(layerFirst, "available"), layerFirst.length),
        factualAccuracyRate: rate(
          countTrue(layerAnswerable, "factualAccurate"),
          layerAnswerable.length,
        ),
        evidenceSupportRate: rate(
          countTrue(layerEvidenceRequired, "evidenceSupported"),
          layerEvidenceRequired.length,
        ),
        routingAccuracyRate: rate(
          countTrue(layerFirst, "routingCorrect"),
          layerFirst.length,
        ),
        completenessRate: rate(
          countTrue(layerAnswerable, "complete"),
          layerAnswerable.length,
        ),
      }];
    })),
    cases: dataset.cases.map((testCase) => ({
      id: testCase.id,
      layer: testCase.layer,
      rounds: scored.filter((item) => item.testCase.id === testCase.id).map((item) => ({
        round: item.observation.round,
        status: item.observation.status,
        scope: item.observation.scope,
        stopReason: item.observation.stopReason,
        latencyMs: item.observation.latencyMs,
        failure: item.observation.failure,
        score: item.score,
      })),
    })),
  };
}

export type BlindAcceptanceReport = ReturnType<typeof buildBlindAcceptanceReport>;

function scoreObservation(
  testCase: BlindAcceptanceCase,
  observation: BlindAcceptanceObservation,
): ScoredObservation {
  const answer = observation.answer.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const matchedConceptIds = testCase.requiredConcepts.filter((concept) =>
    concept.anyOf.some((candidate) =>
      answer.includes(candidate.normalize("NFKC").toLocaleLowerCase("zh-CN"))))
    .map((concept) => concept.id);
  const forbiddenClaimCount = testCase.forbiddenPatterns.filter((pattern) =>
    answer.includes(pattern.normalize("NFKC").toLocaleLowerCase("zh-CN"))).length;
  const available = observation.failure === undefined &&
    observation.status !== undefined &&
    observation.status !== "temporarily_unavailable";
  const factualAccurate = available &&
    matchedConceptIds.length === testCase.requiredConcepts.length &&
    forbiddenClaimCount === 0;
  const observedDomains = observation.domainsUsed ??
    [...new Set(observation.references.map((reference) => reference.project))];
  const routingCorrect = available &&
    observation.scope === testCase.expectedScope &&
    sameStringSet(testCase.expectedDomains, observedDomains);
  const citedIndexes = citationIndexes(answer);
  const validCitations = citedIndexes.every((index) =>
    observation.references.some((reference) => reference.index === index));
  const validReferenceIndexes = new Set(observation.references.map((reference) =>
    reference.index));
  const citedConceptIds = testCase.requiredConcepts.filter((concept) =>
    conceptIsCited(concept.anyOf, answer, validReferenceIndexes)).map((concept) => concept.id);
  const uncitedConceptIds = matchedConceptIds.filter((id) => !citedConceptIds.includes(id));
  const evidenceSupported = available &&
    observation.references.length >= testCase.minimumReferences &&
    observation.references.every((reference) =>
      testCase.allowedProjects.includes(reference.project) &&
      reference.revision === observation.knowledgeRevisions[reference.project]) &&
    validCitations &&
    (testCase.minimumReferences === 0 || (
      citedIndexes.length > 0 && uncitedConceptIds.length === 0
    ));
  const statusFits = testCase.expectedDisposition === "answer"
    ? observation.status === "answered"
    : ["partially_answered", "not_covered"].includes(observation.status ?? "");
  const complete = factualAccurate && evidenceSupported && routingCorrect && statusFits;
  const reasonableRefusal = testCase.expectedDisposition !== "partial_or_refuse" ||
    (available && statusFits && factualAccurate);
  return {
    available,
    factualAccurate,
    evidenceSupported,
    routingCorrect,
    complete,
    reasonableRefusal,
    forbiddenClaimCount,
    matchedConceptIds,
    citedConceptIds,
    uncitedConceptIds,
  };
}

function consistencySignature(item: {
  readonly observation: BlindAcceptanceObservation;
  readonly score: ScoredObservation;
}): string {
  return JSON.stringify({
    scope: item.observation.scope,
    status: item.observation.status,
    available: item.score.available,
    factualAccurate: item.score.factualAccurate,
    evidenceSupported: item.score.evidenceSupported,
    routingCorrect: item.score.routingCorrect,
    complete: item.score.complete,
    reasonableRefusal: item.score.reasonableRefusal,
    forbiddenClaimCount: item.score.forbiddenClaimCount,
    matchedConceptIds: item.score.matchedConceptIds,
    citedConceptIds: item.score.citedConceptIds,
  });
}

function citationIndexes(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
}

function conceptIsCited(
  candidates: readonly string[],
  answer: string,
  validReferenceIndexes: ReadonlySet<number>,
): boolean {
  return answer.split(/(?:\r?\n\s*){2,}/gu).some((paragraph) => {
    const normalized = paragraph.normalize("NFKC").toLocaleLowerCase("zh-CN");
    const containsConcept = candidates.some((candidate) =>
      normalized.includes(candidate.normalize("NFKC").toLocaleLowerCase("zh-CN")));
    return containsConcept && citationIndexes(paragraph).some((index) =>
      validReferenceIndexes.has(index));
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    new Set(left).size === new Set(right).size &&
    left.every((value) => right.includes(value));
}

function percentile(values: readonly number[], quantile: number): number {
  return values.length === 0
    ? 0
    : values[Math.max(0, Math.ceil(values.length * quantile) - 1)]!;
}

function minimumGate(id: string, observed: number, threshold: number): BlindAcceptanceHardGate {
  return { id, observed, comparison: "minimum", threshold, passed: observed >= threshold };
}

function maximumGate(id: string, observed: number, threshold: number): BlindAcceptanceHardGate {
  return { id, observed, comparison: "maximum", threshold, passed: observed <= threshold };
}

function zeroGate(id: string, observed: number): BlindAcceptanceHardGate {
  return { id, observed, comparison: "zero", threshold: 0, passed: observed === 0 };
}

function countTrue(
  items: readonly { readonly score: ScoredObservation }[],
  key: keyof Pick<ScoredObservation,
    "available" | "factualAccurate" | "evidenceSupported" | "routingCorrect" |
    "complete" | "reasonableRefusal">,
): number {
  return items.filter((item) => item.score[key]).length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function parseThresholds(value: unknown): BlindAcceptanceThresholds {
  if (!isRecord(value)) throw new Error("invalid_blind_acceptance_thresholds");
  const keys = [
    "availability",
    "factualAccuracy",
    "highRiskFactualAccuracy",
    "evidenceSupport",
    "routingAccuracy",
    "completeness",
    "reasonableRefusal",
    "consistency",
  ] as const;
  if (keys.some((key) => typeof value[key] !== "number" ||
    value[key] < 0 || value[key] > 1)) {
    throw new Error("invalid_blind_acceptance_thresholds");
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as
    BlindAcceptanceThresholds;
}

function parseCase(value: unknown, index: number): BlindAcceptanceCase {
  if (
    !isRecord(value) ||
    value.id !== `B${String(index + 1).padStart(3, "0")}` ||
    !blindAcceptanceLayers.includes(value.layer as BlindAcceptanceLayer) ||
    typeof value.question !== "string" || value.question.trim().length < 8 ||
    !["professional", "general", "normal"].includes(String(value.expectedScope)) ||
    !Array.isArray(value.expectedDomains) ||
    !value.expectedDomains.every((item) =>
      ["coremail-professional", "presales-general"].includes(String(item))) ||
    !["answer", "partial_or_refuse"].includes(String(value.expectedDisposition)) ||
    typeof value.highRisk !== "boolean" ||
    !Array.isArray(value.requiredConcepts) || value.requiredConcepts.length === 0 ||
    !Array.isArray(value.forbiddenPatterns) ||
    !Number.isSafeInteger(value.minimumReferences) || Number(value.minimumReferences) < 0 ||
    !Array.isArray(value.allowedProjects) ||
    !value.allowedProjects.every((item) =>
      ["coremail-professional", "presales-general"].includes(String(item)))
  ) {
    throw new Error("invalid_blind_acceptance_case");
  }
  const requiredConcepts = value.requiredConcepts.map((concept) => {
    if (!isRecord(concept) || typeof concept.id !== "string" ||
      !Array.isArray(concept.anyOf) || concept.anyOf.length === 0 ||
      !concept.anyOf.every((item) => typeof item === "string" && item.trim())) {
      throw new Error("invalid_blind_acceptance_concept");
    }
    return { id: concept.id, anyOf: concept.anyOf as string[] };
  });
  return {
    id: value.id as string,
    layer: value.layer as BlindAcceptanceLayer,
    question: value.question,
    ...(typeof value.conversationContext === "string"
      ? { conversationContext: value.conversationContext }
      : {}),
    expectedScope: value.expectedScope as BlindScope,
    expectedDomains: value.expectedDomains as BlindProject[],
    expectedDisposition: value.expectedDisposition as BlindAcceptanceCase["expectedDisposition"],
    highRisk: value.highRisk,
    requiredConcepts,
    forbiddenPatterns: value.forbiddenPatterns as string[],
    minimumReferences: value.minimumReferences as number,
    allowedProjects: value.allowedProjects as BlindProject[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
