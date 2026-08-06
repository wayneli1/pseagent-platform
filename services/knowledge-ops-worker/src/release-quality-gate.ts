import { z } from "zod";

export const questionKindSchema = z.enum([
  "canonical",
  "alias",
  "colloquial",
  "follow_up",
  "negative",
]);

const expectationSchema = z.object({
  scopes: z.array(z.enum(["professional", "general", "normal"])).min(1),
  statuses: z.array(z.enum(["answered", "partially_answered", "not_covered", "unavailable"])).min(1),
  minimumReferences: z.number().int().min(0).optional(),
  maximumReferences: z.number().int().min(0).optional(),
  matchTypes: z.array(z.enum(["exact", "family", "partial", "none"])).min(1).optional(),
  requiredConcepts: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,80}$/u),
    anyOf: z.array(z.string().trim().min(1)).min(1),
  }).strict()).min(1),
  forbiddenPatterns: z.array(z.string().trim().min(1)).default([]),
  maximumLatencyMs: z.number().int().min(1_000).max(900_000).default(300_000),
}).strict();

const qualityCaseSchema = z.object({
  id: z.string().regex(/^QG-[A-Z0-9-]{4,40}$/u),
  kind: questionKindSchema,
  turn: z.number().int().min(1).max(5),
  question: z.string().trim().min(1).max(2_000),
  consistencyKey: z.string().regex(/^[a-z][a-z0-9_-]{2,80}$/u).optional(),
  expected: expectationSchema,
}).strict();

const qualitySuiteSchema = z.object({
  suiteId: z.string().regex(/^[a-z][a-z0-9_-]{2,80}$/u),
  title: z.string().trim().min(1).max(200),
  cases: z.array(qualityCaseSchema).length(5),
}).strict().superRefine((suite, context) => {
  const kinds = new Set(suite.cases.map((item) => item.kind));
  if (kinds.size !== questionKindSchema.options.length ||
    questionKindSchema.options.some((kind) => !kinds.has(kind))) {
    context.addIssue({ code: "custom", path: ["cases"], message: "suite_must_cover_all_question_kinds" });
  }
  const turns = suite.cases.map((item) => item.turn).sort((a, b) => a - b);
  if (turns.join(",") !== "1,2,3,4,5") {
    context.addIssue({ code: "custom", path: ["cases"], message: "suite_turns_must_be_one_to_five" });
  }
});

export const releaseQualitySuitesSchema = z.array(qualitySuiteSchema).length(4)
  .superRefine((suites, context) => {
    const suiteIds = new Set<string>();
    const caseIds = new Set<string>();
    for (const suite of suites) {
      if (suiteIds.has(suite.suiteId)) context.addIssue({ code: "custom", message: "duplicate_suite_id" });
      suiteIds.add(suite.suiteId);
      for (const testCase of suite.cases) {
        if (caseIds.has(testCase.id)) context.addIssue({ code: "custom", message: "duplicate_case_id" });
        caseIds.add(testCase.id);
      }
    }
  });

export type QuestionKind = z.infer<typeof questionKindSchema>;
export type ReleaseQualitySuite = z.infer<typeof qualitySuiteSchema>;
export type ReleaseQualityCase = z.infer<typeof qualityCaseSchema>;

export interface ReleaseQualityObservation {
  readonly caseId: string;
  readonly model: string;
  readonly scope?: string;
  readonly status?: string;
  readonly answer?: string;
  readonly referenceCount?: number;
  readonly matchType?: "exact" | "family" | "partial" | "none";
  readonly answerCardActivated?: boolean;
  readonly latencyMs: number;
  readonly stopReason?: string;
  readonly failure?: string;
}

export type QualityCheckCategory =
  | "availability"
  | "model"
  | "routing"
  | "coverage"
  | "evidence"
  | "answer_card"
  | "obligation"
  | "safety"
  | "latency"
  | "consistency";

export interface QualityCheck {
  readonly category: QualityCheckCategory;
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface QualityCaseEvaluation {
  readonly caseId: string;
  readonly suiteId: string;
  readonly kind: QuestionKind;
  readonly passed: boolean;
  readonly score: number;
  readonly checks: readonly QualityCheck[];
}

export interface ReleaseQualityReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly model: string;
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly completed: number;
    readonly passedCases: number;
    readonly averageScore: number;
    readonly p95LatencyMs: number;
    readonly safetyFailures: number;
    readonly availabilityFailures: number;
  };
  readonly suites: readonly { suiteId: string; passed: boolean; passedCases: number; averageScore: number }[];
  readonly kinds: readonly { kind: QuestionKind; passed: boolean; passedCases: number; averageScore: number }[];
  readonly consistencyChecks: readonly QualityCheck[];
  readonly cases: readonly QualityCaseEvaluation[];
}

export function parseReleaseQualitySuites(value: unknown): ReleaseQualitySuite[] {
  return releaseQualitySuitesSchema.parse(value);
}

export function evaluateReleaseQualityGate(
  suitesSource: unknown,
  observations: readonly ReleaseQualityObservation[],
  requiredModel = "deepseek_v4_flash",
): ReleaseQualityReport {
  const suites = parseReleaseQualitySuites(suitesSource);
  const observationByCase = uniqueObservationMap(observations);
  const evaluations = suites.flatMap((suite) => suite.cases.map((testCase) =>
    evaluateCase(suite.suiteId, testCase, observationByCase.get(testCase.id), requiredModel)));
  const consistencyChecks = evaluateConsistency(suites, observationByCase);
  const suiteSummaries = suites.map((suite) => summarize(
    "suiteId",
    suite.suiteId,
    evaluations.filter((item) => item.suiteId === suite.suiteId),
  ));
  const kindSummaries = questionKindSchema.options.map((kind) => summarize(
    "kind",
    kind,
    evaluations.filter((item) => item.kind === kind),
  ));
  const latencies = observations.map((item) => item.latencyMs).sort((a, b) => a - b);
  const completed = observations.filter((item) => item.failure === undefined && item.answer !== undefined).length;
  const safetyFailures = evaluations.flatMap((item) => item.checks).filter((check) =>
    check.category === "safety" && !check.passed).length;
  const availabilityFailures = evaluations.flatMap((item) => item.checks).filter((check) =>
    check.category === "availability" && !check.passed).length;
  const passed = evaluations.length === 20 &&
    completed === 20 &&
    evaluations.every((item) => item.passed) &&
    suiteSummaries.every((item) => item.passed) &&
    kindSummaries.every((item) => item.passed) &&
    consistencyChecks.every((item) => item.passed) &&
    safetyFailures === 0 && availabilityFailures === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: requiredModel,
    passed,
    summary: {
      total: evaluations.length,
      completed,
      passedCases: evaluations.filter((item) => item.passed).length,
      averageScore: average(evaluations.map((item) => item.score)),
      p95LatencyMs: percentile95(latencies),
      safetyFailures,
      availabilityFailures,
    },
    suites: suiteSummaries,
    kinds: kindSummaries,
    consistencyChecks,
    cases: evaluations,
  };
}

function evaluateCase(
  suiteId: string,
  testCase: ReleaseQualityCase,
  observation: ReleaseQualityObservation | undefined,
  requiredModel: string,
): QualityCaseEvaluation {
  const checks: QualityCheck[] = [];
  add(checks, "availability", "completed", observation?.failure === undefined && observation?.answer !== undefined,
    observation?.failure ?? `answerChars=${observation?.answer?.length ?? 0}`);
  add(checks, "availability", "final", observation?.stopReason === "final", `actual=${observation?.stopReason ?? "missing"}`);
  add(checks, "model", "fixed-model", observation?.model === requiredModel,
    `actual=${observation?.model ?? "missing"}; required=${requiredModel}`);
  add(checks, "routing", "scope", observation?.scope !== undefined && testCase.expected.scopes.includes(observation.scope as never),
    `actual=${observation?.scope ?? "missing"}; expected=${testCase.expected.scopes.join("|")}`);
  add(checks, "coverage", "status", observation?.status !== undefined && testCase.expected.statuses.includes(observation.status as never),
    `actual=${observation?.status ?? "missing"}; expected=${testCase.expected.statuses.join("|")}`);
  if (testCase.expected.minimumReferences !== undefined) add(checks, "evidence", "minimum-references",
    (observation?.referenceCount ?? -1) >= testCase.expected.minimumReferences,
    `actual=${observation?.referenceCount ?? "missing"}; minimum=${testCase.expected.minimumReferences}`);
  if (testCase.expected.maximumReferences !== undefined) add(checks, "evidence", "maximum-references",
    (observation?.referenceCount ?? Number.POSITIVE_INFINITY) <= testCase.expected.maximumReferences,
    `actual=${observation?.referenceCount ?? "missing"}; maximum=${testCase.expected.maximumReferences}`);
  if (testCase.expected.matchTypes !== undefined) add(checks, "answer_card", "match-type",
    observation?.matchType !== undefined && testCase.expected.matchTypes.includes(observation.matchType),
    `actual=${observation?.matchType ?? "missing"}; expected=${testCase.expected.matchTypes.join("|")}`);
  if (testCase.expected.matchTypes?.some((type) => type !== "none") === true) {
    add(checks, "answer_card", "activated", observation?.answerCardActivated === true,
      `actual=${observation?.answerCardActivated ?? "missing"}`);
  }
  for (const concept of testCase.expected.requiredConcepts) {
    const matches = concept.anyOf.filter((term) => contains(observation?.answer ?? "", term));
    add(checks, "obligation", concept.id, matches.length > 0,
      matches.length > 0 ? `matched=${matches.join("|")}` : `expectedAny=${concept.anyOf.join("|")}`);
  }
  for (const pattern of testCase.expected.forbiddenPatterns) {
    let matched = true;
    try { matched = new RegExp(pattern, "iu").test(observation?.answer ?? ""); } catch { matched = true; }
    add(checks, "safety", `forbidden:${pattern}`, !matched, `pattern=${pattern}`);
  }
  add(checks, "latency", "maximum-latency", observation !== undefined && observation.latencyMs <= testCase.expected.maximumLatencyMs,
    `actual=${observation?.latencyMs ?? "missing"}; maximum=${testCase.expected.maximumLatencyMs}`);
  const passedCount = checks.filter((item) => item.passed).length;
  return { caseId: testCase.id, suiteId, kind: testCase.kind, passed: checks.every((item) => item.passed), score: checks.length === 0 ? 1 : passedCount / checks.length, checks };
}

function evaluateConsistency(
  suites: readonly ReleaseQualitySuite[],
  observations: ReadonlyMap<string, ReleaseQualityObservation>,
): QualityCheck[] {
  const groups = new Map<string, ReleaseQualityCase[]>();
  for (const testCase of suites.flatMap((suite) => suite.cases)) {
    if (testCase.consistencyKey) groups.set(testCase.consistencyKey, [...(groups.get(testCase.consistencyKey) ?? []), testCase]);
  }
  return [...groups.entries()].map(([key, cases]) => {
    const signatures = cases.map((item) => directionSignature(observations.get(item.id)));
    const passed = cases.length >= 2 && signatures.every((item) => item !== "missing" && item === signatures[0]);
    return { category: "consistency", id: `consistency:${key}`, passed, detail: signatures.join(" <> ") };
  });
}

function directionSignature(value: ReleaseQualityObservation | undefined): string {
  if (value?.scope === undefined || value.status === undefined) return "missing";
  const direction = value.status === "answered" || value.status === "partially_answered"
    ? "supported"
    : value.status === "not_covered"
      ? "unsupported"
      : "unavailable";
  return `${value.scope}:${direction}`;
}

function uniqueObservationMap(values: readonly ReleaseQualityObservation[]): Map<string, ReleaseQualityObservation> {
  const result = new Map<string, ReleaseQualityObservation>();
  for (const value of values) {
    if (result.has(value.caseId)) throw new Error(`duplicate_quality_observation:${value.caseId}`);
    result.set(value.caseId, value);
  }
  return result;
}

function summarize<K extends "suiteId" | "kind">(
  key: K,
  value: K extends "suiteId" ? string : QuestionKind,
  evaluations: readonly QualityCaseEvaluation[],
): { [P in K]: typeof value } & { passed: boolean; passedCases: number; averageScore: number } {
  return { [key]: value, passed: evaluations.length > 0 && evaluations.every((item) => item.passed), passedCases: evaluations.filter((item) => item.passed).length, averageScore: average(evaluations.map((item) => item.score)) } as never;
}
function add(checks: QualityCheck[], category: QualityCheckCategory, id: string, passed: boolean, detail: string) { checks.push({ category, id, passed, detail }); }
function contains(text: string, term: string) { return normalize(text).includes(normalize(term)); }
function normalize(value: string) { return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, ""); }
function average(values: readonly number[]) { return values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)); }
function percentile95(values: readonly number[]) { return values.length === 0 ? 0 : values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]!; }
