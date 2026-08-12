import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateStageBudgetFaultInjection,
  runStageBudgetFaultInjection,
} from "./stage-budget-fault-injection-contract.ts";

const observations = runStageBudgetFaultInjection();
const decision = evaluateStageBudgetFaultInjection(observations);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  passed: decision.passed,
  scenarioCount: decision.scenarioCount,
  decision,
  observations,
};
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
const directory = join(tmpdir(), "pseagent-stage-budget-fault-injection");
mkdirSync(directory, { recursive: true });
const reportPath = join(directory, `stage-budget-fault-injection-${Date.now()}.json`);
writeFileSync(reportPath, reportBytes);
process.stdout.write(`${JSON.stringify({
  type: "stage_budget_fault_injection",
  reportPath,
  reportSha256,
  passed: decision.passed,
  scenarioCount: decision.scenarioCount,
  failedScenarioIds: decision.failedScenarioIds,
})}\n`);
if (!decision.passed) process.exitCode = 1;

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
