import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import { ConversationStore } from "../integrations/lunkr-direct/src/conversation-store.ts";
import {
  evaluateReleaseQualityGate,
  parseReleaseQualitySuites,
  type ReleaseQualityObservation,
} from "../services/knowledge-ops-worker/src/release-quality-gate.ts";
import { ReliabilityDiagnosticCollector } from "./reliability-diagnostics.ts";
import { runWithBoundedConcurrency } from "./bounded-concurrency.ts";

const REQUIRED_MODEL = "deepseek_v4_flash";
assertFixedModel(process.env);
const source = JSON.parse(readFileSync(
  new URL("../tests/regression/release-quality-suites.json", import.meta.url),
  "utf8",
));
const suites = parseReleaseQualitySuites(source);
const diagnosticCollector = new ReliabilityDiagnosticCollector();
const runtime = await createPseAgentRuntime(process.env, {
  createDiagnosticTraceFactory: () => diagnosticCollector,
});
const conversation = new ConversationStore(6, 12_000);
const observations: ReleaseQualityObservation[] = [];
const records: Record<string, unknown>[] = [];
const suiteConcurrency = releaseSuiteConcurrency(process.env, suites.length);

try {
  await runWithBoundedConcurrency(suites, suiteConcurrency, async (suite) => {
    for (const testCase of [...suite.cases].sort((left, right) => left.turn - right.turn)) {
      process.stdout.write(`${JSON.stringify({ type: "case_started", suiteId: suite.suiteId, caseId: testCase.id, kind: testCase.kind, turn: testCase.turn })}\n`);
      const context = conversation.context(suite.suiteId, testCase.question);
      const started = performance.now();
      try {
        const execution = await runtime.answerDetailed(testCase.question, context);
        const diagnostics = diagnosticCollector.take(execution.requestId);
        const latencyMs = Math.round(performance.now() - started);
        const observation: ReleaseQualityObservation = {
          caseId: testCase.id,
          model: REQUIRED_MODEL,
          scope: execution.result.scope,
          status: execution.result.status,
          answer: execution.result.answer,
          referenceCount: execution.result.references.length +
            (execution.result.historicalAnswer?.references.length ?? 0),
          matchType: execution.answerCardMatch?.matchType ?? "none",
          answerCardActivated: execution.answerCardActivation?.activated,
          latencyMs,
          stopReason: execution.stopReason,
        };
        observations.push(observation);
        records.push({
          suiteId: suite.suiteId,
          testCase,
          contextUsed: context !== undefined,
          observation,
          execution,
          diagnostics,
        });
        if (execution.result.status === "answered" || execution.result.status === "partially_answered") {
          conversation.append(suite.suiteId, { question: testCase.question, answer: execution.result.answer });
        }
        process.stdout.write(`${JSON.stringify({
          type: "progress",
          suiteId: suite.suiteId,
          caseId: testCase.id,
          kind: testCase.kind,
          model: REQUIRED_MODEL,
          scope: observation.scope,
          status: observation.status,
          matchType: observation.matchType,
          latencyMs,
        })}\n`);
      } catch (error) {
        const latencyMs = Math.round(performance.now() - started);
        const failure = error instanceof Error ? `${error.name}:${error.message}` : "unknown_error";
        observations.push({ caseId: testCase.id, model: REQUIRED_MODEL, latencyMs, failure });
        records.push({ suiteId: suite.suiteId, testCase, contextUsed: context !== undefined, failure, latencyMs });
        process.stdout.write(`${JSON.stringify({ type: "failure", suiteId: suite.suiteId, caseId: testCase.id, failure, latencyMs })}\n`);
      }
    }
  });
} finally {
  await runtime.close();
}

const gate = evaluateReleaseQualityGate(source, observations, REQUIRED_MODEL);
const report = {
  ...gate,
  taskSpecActive: process.env.PSE_TASK_SPEC_ACTIVE_ENABLED === "true",
  multiDomainActive: process.env.PSE_MULTI_DOMAIN_ACTIVE_ENABLED === "true",
  answerCardExactActive: process.env.PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED === "true",
  answerCardFamilyActive: process.env.PSE_ANSWER_CARD_FAMILY_ACTIVE_ENABLED === "true",
  suiteConcurrency,
  records: records.sort((left, right) => String(left.suiteId).localeCompare(String(right.suiteId))),
};
const reportDirectory = join(tmpdir(), "pseagent-release-quality");
mkdirSync(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, `release-quality-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await submitGateWhenConfigured(gate, process.env);
process.stdout.write(`${JSON.stringify({ type: "summary", ...gate.summary, passed: gate.passed, reportPath })}\n`);
if (!gate.passed) process.exitCode = 1;

function assertFixedModel(env: NodeJS.ProcessEnv): void {
  const values = [
    env.PSE_MODEL_NAME,
    env.PSE_RESOLVER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_PLANNER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_SYNTHESIZER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_VERIFIER_MODEL_NAME ?? env.PSE_MODEL_NAME,
  ];
  if (values.some((value) => value !== REQUIRED_MODEL)) {
    throw new Error(`release_quality_requires_${REQUIRED_MODEL}`);
  }
}

function releaseSuiteConcurrency(env: NodeJS.ProcessEnv, suiteCount: number): number {
  const configured = Number(env.PSE_MODEL_MAX_CONCURRENCY ?? 3);
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error("release_quality_model_concurrency_invalid");
  }
  return Math.min(configured, suiteCount);
}

async function submitGateWhenConfigured(gate: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  const baseUrl = env.KNOWLEDGE_OPS_BASE_URL;
  const token = env.KNOWLEDGE_OPS_RELEASE_TOKEN;
  if (baseUrl === undefined && token === undefined) return;
  if (baseUrl === undefined || token === undefined || token.trim().length < 24) {
    throw new Error("knowledge_ops_quality_import_configuration_invalid");
  }
  const url = new URL("/v1/regression-runs", baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("knowledge_ops_quality_import_requires_https_or_loopback");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(gate),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`knowledge_ops_quality_import_rejected_${response.status}`);
}
