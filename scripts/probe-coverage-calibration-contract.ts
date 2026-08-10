import { z } from "zod";
import {
  coverageSchema,
  knowledgePlanSchema,
  type FinalAction,
  type KnowledgePlan,
} from "../apps/pseagent/src/contracts.js";
import type { CoverageEvidenceDocument } from "../apps/pseagent/src/coverage-verifier.js";
import type { RequirementEvidenceCondition } from "../apps/pseagent/src/evidence-ledger.js";

const requirementCoverageSchema = z.object({
  id: z.string().regex(/^R[1-6]$/u),
  coverage: coverageSchema,
  answer: z.string(),
  citations: z.array(z.number().int().positive()),
  relatedContext: z.array(z.object({
    statement: z.string(),
    citations: z.array(z.number().int().positive()),
  }).strict()).optional(),
}).strict();

const finalActionSchema = z.object({
  action: z.literal("final"),
  requirements: z.array(requirementCoverageSchema).min(1).max(6),
  citations: z.array(z.number().int().positive()),
}).strict();

const evidenceSchema = z.object({
  requirementId: z.string().regex(/^R[1-6]$/u),
  citation: z.number().int().positive(),
  title: z.string().min(1),
  path: z.string().min(1),
  content: z.string().min(1),
  aspectIds: z.array(z.string().regex(/^A[1-8]$/u)).optional(),
}).strict();

const conditionSchema = z.object({
  requirementId: z.string().regex(/^R[1-6]$/u),
  conflictDetected: z.boolean(),
  freshness: z.enum(["not_assessed", "current", "stale_or_unconfirmed"]),
  inputState: z.enum(["not_applicable", "available", "missing"]),
  ambiguous: z.boolean(),
}).strict();

const calibrationCaseSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.string().min(1).max(64),
  question: z.string().min(1),
  gold: z.object({
    coverage: coverageSchema,
    authority: z.string().min(1),
  }).strict(),
  expectedGate: z.object({
    disposition: z.enum([
      "deterministic_accept",
      "semantic_required",
      "reject",
    ]),
    risk: z.enum(["low", "high"]),
  }).strict(),
  plan: knowledgePlanSchema,
  draft: finalActionSchema,
  evidence: z.array(evidenceSchema),
  conditions: z.array(conditionSchema),
}).strict();

const datasetSchema = z.object({
  schemaVersion: z.literal(1),
  frozenAt: z.string().datetime(),
  cases: z.array(calibrationCaseSchema).min(1).superRefine((cases, context) => {
    const ids = cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate_calibration_case" });
    }
  }),
}).strict();

export interface CoverageCalibrationCase {
  readonly id: string;
  readonly category: string;
  readonly question: string;
  readonly gold: {
    readonly coverage: "complete" | "partial" | "none";
    readonly authority: string;
  };
  readonly expectedGate: {
    readonly disposition:
      | "deterministic_accept"
      | "semantic_required"
      | "reject";
    readonly risk: "low" | "high";
  };
  readonly plan: KnowledgePlan;
  readonly draft: FinalAction;
  readonly evidence: readonly CoverageEvidenceDocument[];
  readonly conditions: readonly RequirementEvidenceCondition[];
}

export interface CoverageCalibrationDataset {
  readonly schemaVersion: 1;
  readonly frozenAt: string;
  readonly cases: readonly CoverageCalibrationCase[];
}

export interface CoverageCalibrationObservation {
  readonly caseId: string;
  readonly run: number;
  readonly coverage?: "complete" | "partial" | "none";
  readonly gateDisposition:
    | "deterministic_accept"
    | "semantic_required"
    | "reject";
  readonly elapsedMs: number;
  readonly failure?: string;
}

export interface CoverageCalibrationReport {
  readonly expectedRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly falseUpgrades: number;
  readonly falseDowngrades: number;
  readonly correctHolds: number;
  readonly inconsistentCaseIds: readonly string[];
  readonly consistencyRate: number;
  readonly qualified: boolean;
}

export function parseCoverageCalibrationDataset(
  value: unknown,
): CoverageCalibrationDataset {
  if (isRecord(value) && Array.isArray(value.cases)) {
    for (const item of value.cases) {
      if (isRecord(item) && typeof item.id === "string" && item.gold === undefined) {
        throw new Error(`calibration_gold_required:${item.id}`);
      }
    }
  }
  return datasetSchema.parse(value) as CoverageCalibrationDataset;
}

export function buildCoverageCalibrationReport(
  dataset: CoverageCalibrationDataset,
  observations: readonly CoverageCalibrationObservation[],
  repeat: number,
): CoverageCalibrationReport {
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error("calibration_repeat_invalid");
  }
  const goldById = new Map(dataset.cases.map((item) => [
    item.id,
    item.gold.coverage,
  ] as const));
  let falseUpgrades = 0;
  let falseDowngrades = 0;
  let correctHolds = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  for (const observation of observations) {
    const gold = goldById.get(observation.caseId);
    if (gold === undefined) throw new Error(`calibration_case_unknown:${observation.caseId}`);
    if (observation.failure !== undefined || observation.coverage === undefined) {
      failedRuns += 1;
      continue;
    }
    completedRuns += 1;
    const delta = coverageRank(observation.coverage) - coverageRank(gold);
    if (delta > 0) falseUpgrades += 1;
    else if (delta < 0) falseDowngrades += 1;
    else correctHolds += 1;
  }

  const inconsistentCaseIds = dataset.cases.flatMap((item) => {
    const records = observations.filter((record) => record.caseId === item.id);
    const coverageValues = new Set(records.flatMap((record) =>
      record.coverage === undefined ? [] : [record.coverage]));
    return records.length !== repeat ||
        records.some((record) => record.failure !== undefined) ||
        coverageValues.size !== 1
      ? [item.id]
      : [];
  });
  const expectedRuns = dataset.cases.length * repeat;
  const consistencyRate = dataset.cases.length === 0
    ? 0
    : (dataset.cases.length - inconsistentCaseIds.length) /
      dataset.cases.length;
  return {
    expectedRuns,
    completedRuns,
    failedRuns,
    falseUpgrades,
    falseDowngrades,
    correctHolds,
    inconsistentCaseIds,
    consistencyRate,
    qualified:
      observations.length === expectedRuns &&
      completedRuns === expectedRuns &&
      failedRuns === 0 &&
      falseUpgrades === 0 &&
      falseDowngrades === 0 &&
      inconsistentCaseIds.length === 0,
  };
}

function coverageRank(value: "complete" | "partial" | "none"): number {
  if (value === "complete") return 2;
  if (value === "partial") return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
