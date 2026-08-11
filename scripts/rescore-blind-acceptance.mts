import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildBlindAcceptanceReport,
  parseBlindAcceptanceDataset,
  type BlindAcceptanceObservation,
} from "./blind-acceptance-contract.ts";

const matrixPath = requiredPath("PSE_BLIND_RESCORE_MATRIX_PATH");
const priorReportPath = requiredPath("PSE_BLIND_RESCORE_REPORT_PATH");
const dataset = parseBlindAcceptanceDataset(
  JSON.parse(readFileSync(matrixPath, "utf8")),
  new Set(),
);
const priorReport = JSON.parse(readFileSync(priorReportPath, "utf8")) as {
  readonly observations?: readonly BlindAcceptanceObservation[];
};
if (!Array.isArray(priorReport.observations)) {
  throw new Error("blind_rescore_observations_missing");
}
const scoring = buildBlindAcceptanceReport(dataset, priorReport.observations);
const outputRoot = join(tmpdir(), "pseagent-blind-rescore");
mkdirSync(outputRoot, { recursive: true });
const outputPath = join(outputRoot, `rescore-${Date.now()}.json`);
const output = `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "evaluator_calibration_only",
  sourceMatrix: matrixPath,
  sourceReport: priorReportPath,
  sourceReportSha256: sha256(readFileSync(priorReportPath)),
  scoring,
}, null, 2)}\n`;
writeFileSync(outputPath, output, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "blind_rescore_summary",
  sourceReport: basename(priorReportPath),
  outputPath,
  outputSha256: sha256(Buffer.from(output)),
  qualified: scoring.qualified,
  firstOutput: scoring.firstOutput,
  consistency: scoring.consistency,
})}\n`);

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return resolve(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
