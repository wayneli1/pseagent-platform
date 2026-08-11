import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  evaluateEnterpriseReleaseGate,
  type EnterpriseReleaseEvidence,
} from "./enterprise-release-gate.ts";

const evidencePath = process.env.PSE_ENTERPRISE_RELEASE_EVIDENCE_PATH?.trim();
if (!evidencePath) throw new Error("enterprise_release_evidence_path_required");
const resolvedEvidencePath = resolve(evidencePath);
const evidence = JSON.parse(readFileSync(resolvedEvidencePath, "utf8")) as
  EnterpriseReleaseEvidence;
const decision = evaluateEnterpriseReleaseGate(evidence);
const outputPath = resolve(process.env.PSE_ENTERPRISE_RELEASE_REPORT_PATH?.trim() ||
  `${resolvedEvidencePath}.decision.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidencePath: resolvedEvidencePath,
  decision,
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "enterprise_release_decision",
  passed: decision.passed,
  failedChecks: decision.checks.filter((check) => !check.passed).map((check) => check.id),
  outputPath,
})}\n`);
if (!decision.passed) process.exitCode = 1;
