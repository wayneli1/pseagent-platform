import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../apps/pseagent/src/config.ts";
import { evaluateDeterministicCoverageGate } from "../apps/pseagent/src/deterministic-coverage-gate.ts";
import { OpenAiCompatibleModelClient } from "../apps/pseagent/src/model-client.ts";
import { verifyKnowledgeCoverage } from "../apps/pseagent/src/coverage-verifier.ts";
import {
  buildCoverageCalibrationReport,
  parseCoverageCalibrationDataset,
  type CoverageCalibrationObservation,
} from "./probe-coverage-calibration-contract.ts";

const datasetPath = resolve(
  process.env.PSE_COVERAGE_CALIBRATION_PATH ??
    new URL("../tests/regression/coverage-verifier-calibration.json", import.meta.url)
      .pathname.slice(process.platform === "win32" ? 1 : 0),
);
const dataset = parseCoverageCalibrationDataset(JSON.parse(readFileSync(
  datasetPath,
  "utf8",
)));
const repeat = positiveInteger(
  process.env.PSE_COVERAGE_CALIBRATION_REPEAT,
  3,
);
if (repeat > 5) throw new Error("PSE_COVERAGE_CALIBRATION_REPEAT must be <= 5");
const selectedIds = new Set(
  (process.env.PSE_COVERAGE_CALIBRATION_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = dataset.cases.filter((item) =>
  selectedIds.size === 0 || selectedIds.has(item.id));
if (selectedCases.length === 0) throw new Error("no_coverage_calibration_cases_selected");
const selectedDataset = { ...dataset, cases: selectedCases };

const config = loadConfig(process.env);
const model = new OpenAiCompatibleModelClient({
  baseUrl: config.PSE_MODEL_BASE_URL,
  apiKey: config.PSE_MODEL_API_KEY,
  model: config.modelRoles.verifier,
  timeoutMs: config.PSE_MODEL_TIMEOUT_MS,
  maxTokens: config.PSE_MODEL_MAX_TOKENS,
  jsonResponseFormat: config.modelCapabilities.jsonResponseFormat,
});
const observations: CoverageCalibrationObservation[] = [];

for (let run = 1; run <= repeat; run += 1) {
  for (const item of selectedCases) {
    const started = performance.now();
    const gate = evaluateDeterministicCoverageGate({
      question: item.question,
      plan: item.plan,
      draft: item.draft,
      evidence: item.evidence,
      conditions: item.conditions,
    });
    let observation: CoverageCalibrationObservation;
    try {
      if (gate.disposition === "reject") {
        throw new Error(`coverage_gate_rejected:${gate.reasons.join(",")}`);
      }
      const action = gate.disposition === "deterministic_accept"
        ? item.draft
        : await verifyKnowledgeCoverage({
            question: item.question,
            plan: item.plan,
            draft: item.draft,
            evidence: item.evidence,
            model,
          });
      observation = {
        caseId: item.id,
        run,
        coverage: aggregateCoverage(action.requirements.map((requirement) =>
          requirement.coverage)),
        gateDisposition: gate.disposition,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      observation = {
        caseId: item.id,
        run,
        gateDisposition: gate.disposition,
        elapsedMs: Math.round(performance.now() - started),
        failure: error instanceof Error ? error.message : "unexpected_error",
      };
    }
    observations.push(observation);
    process.stdout.write(`${JSON.stringify({ type: "result", ...observation })}\n`);
  }
}

const calibration = buildCoverageCalibrationReport(
  selectedDataset,
  observations,
  repeat,
);
const report = {
  type: "summary",
  generatedAt: new Date().toISOString(),
  datasetPath,
  frozenAt: dataset.frozenAt,
  model: config.modelRoles.verifier,
  repeat,
  selectedCaseIds: selectedCases.map((item) => item.id),
  observations,
  ...calibration,
};
const outputPath = resolve(
  process.env.PSE_COVERAGE_CALIBRATION_OUTPUT ??
    join(
      tmpdir(),
      "pseagent-coverage-calibration",
      `coverage-calibration-${Date.now()}.json`,
    ),
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, observations: undefined, outputPath })}\n`);
if (!report.qualified) process.exitCode = 1;

function aggregateCoverage(
  values: readonly ("complete" | "partial" | "none")[],
): "complete" | "partial" | "none" {
  if (values.every((value) => value === "complete")) return "complete";
  if (values.every((value) => value === "none")) return "none";
  return "partial";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("positive_integer_required");
  }
  return parsed;
}
