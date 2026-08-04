import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import type { PseAnswerExecution } from "../apps/pseagent/src/answer-service.ts";
import { ConversationStore } from "../integrations/lunkr-direct/src/conversation-store.ts";
import {
  evaluateConsistency,
  evaluateEnterpriseScenario,
  parseEnterpriseScenarios,
  type EnterpriseScenario,
  type ScenarioEvaluation,
} from "./enterprise-scenario-contract.ts";

interface ProbeRecord {
  readonly scenario: EnterpriseScenario;
  readonly model: string;
  readonly elapsedMs: number;
  readonly contextUsed: boolean;
  readonly execution?: PseAnswerExecution;
  readonly evaluation?: ScenarioEvaluation;
  readonly failure?: string;
}

const allScenarios = parseEnterpriseScenarios(JSON.parse(readFileSync(
  new URL("../tests/regression/enterprise-user-scenarios.json", import.meta.url),
  "utf8",
)));
const selectedIds = new Set((process.env.PSE_ENTERPRISE_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const scenarios = allScenarios.filter((scenario) =>
  selectedIds.size === 0 || selectedIds.has(scenario.id));
if (scenarios.length === 0) throw new Error("no_enterprise_scenarios_selected");

const runtime = await createPseAgentRuntime(process.env);
const store = new ConversationStore(6, 12_000);
const records: ProbeRecord[] = [];
const model = process.env.PSE_MODEL_NAME ?? "unknown";
try {
  const users = [...new Set(scenarios.map((scenario) => scenario.userId))];
  await Promise.all(users.map(async (userId) => {
    const turns = scenarios
      .filter((scenario) => scenario.userId === userId)
      .sort((left, right) => left.turn - right.turn);
    for (const scenario of turns) {
      const context = store.context(userId, scenario.question);
      const started = performance.now();
      try {
        const execution = await runtime.answerDetailed(scenario.question, context);
        const evaluation = evaluateEnterpriseScenario(scenario, execution);
        records.push({
          scenario,
          model,
          elapsedMs: Math.round(performance.now() - started),
          contextUsed: context !== undefined,
          execution,
          evaluation,
        });
        if (execution.result.status === "answered" || execution.result.status === "partially_answered") {
          store.append(userId, { question: scenario.question });
        }
        process.stdout.write(`${JSON.stringify({
          type: "progress",
          id: scenario.id,
          model,
          status: execution.result.status,
          scope: execution.result.scope,
          score: Number(evaluation.score.toFixed(3)),
          passed: evaluation.passed,
          elapsedMs: Math.round(performance.now() - started),
        })}\n`);
      } catch (error) {
        records.push({
          scenario,
          model,
          elapsedMs: Math.round(performance.now() - started),
          contextUsed: context !== undefined,
          failure: error instanceof Error ? `${error.name}:${error.message}` : "unknown_error",
        });
      }
    }
  }));
} finally {
  await runtime.close();
}

records.sort((left, right) =>
  left.scenario.userId.localeCompare(right.scenario.userId) ||
  left.scenario.turn - right.scenario.turn);
const consistencyChecks = evaluateConsistency(records.map((record) => ({
  scenario: record.scenario,
  ...(record.execution === undefined ? {} : { execution: record.execution }),
})));
const report = {
  generatedAt: new Date().toISOString(),
  model,
  taskSpecActive: process.env.PSE_TASK_SPEC_ACTIVE_ENABLED === "true",
  multiDomainActive: process.env.PSE_MULTI_DOMAIN_ACTIVE_ENABLED === "true",
  summary: {
    total: records.length,
    completed: records.filter((record) => record.execution !== undefined).length,
    passed: records.filter((record) => record.evaluation?.passed === true).length,
    averageScore: average(records.flatMap((record) =>
      record.evaluation === undefined ? [] : [record.evaluation.score])),
    failedChecks: records.reduce((count, record) =>
      count + (record.evaluation?.checks.filter((check) => !check.passed).length ?? 0), 0),
    consistencyPassed: consistencyChecks.every((check) => check.passed),
  },
  consistencyChecks,
  records,
};
const reportDirectory = join(tmpdir(), "pseagent-enterprise-probes");
mkdirSync(reportDirectory, { recursive: true });
const safeModel = model.replace(/[^A-Za-z0-9_.-]+/gu, "-");
const reportPath = join(reportDirectory, `enterprise-${safeModel}-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ type: "summary", ...report.summary, reportPath })}\n`);
if (report.summary.completed !== report.summary.total) process.exitCode = 1;

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}
