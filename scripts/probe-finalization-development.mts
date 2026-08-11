import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import { ReliabilityDiagnosticCollector } from "./reliability-diagnostics.ts";

type DevelopmentCase = {
  readonly id: string;
  readonly question: string;
  readonly conversationContext?: string;
};

const defaultIds = ["B007", "B028", "B056", "B058", "B095"];
const requestedIds = new Set(
  (process.env.PSE_FINALIZATION_DEV_CASE_IDS ?? defaultIds.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const matrixPath = resolve(process.env.PSE_FINALIZATION_DEV_MATRIX_PATH ??
  "tests/e2e/enterprise-blind-acceptance-20260811-final.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
  readonly cases?: readonly DevelopmentCase[];
};
const cases = (matrix.cases ?? []).filter((testCase) => requestedIds.has(testCase.id));
if (cases.length !== requestedIds.size) {
  throw new Error("finalization_development_cases_missing");
}

const concurrency = Math.min(4, positiveInteger(
  process.env.PSE_FINALIZATION_DEV_CONCURRENCY,
  2,
));
const timeoutMs = positiveInteger(
  process.env.PSE_FINALIZATION_DEV_TIMEOUT_MS,
  180_000,
);
const outputRoot = resolve(process.env.PSE_FINALIZATION_DEV_OUTPUT_DIR ??
  join(tmpdir(), "pseagent-finalization-development"));
mkdirSync(outputRoot, { recursive: true });
const outputPath = join(outputRoot, `finalization-${Date.now()}.json`);

const diagnosticCollector = new ReliabilityDiagnosticCollector();
const runtime = await createPseAgentRuntime(process.env, {
  createDiagnosticTraceFactory: () => diagnosticCollector,
});
const observations: Array<Record<string, unknown>> = [];
let nextIndex = 0;
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (true) {
      const testCase = cases[nextIndex++];
      if (testCase === undefined) return;
      const startedAt = performance.now();
      try {
        const execution = await runtime.answerDetailed(
          testCase.question,
          testCase.conversationContext,
          AbortSignal.timeout(timeoutMs),
        );
        const diagnostics = diagnosticCollector.take(execution.requestId);
        observations.push({
          caseId: testCase.id,
          question: testCase.question,
          scope: execution.result.scope,
          status: execution.result.status,
          policyDisposition: execution.result.policyDisposition,
          domainsUsed: execution.domainsUsed ?? [],
          answer: execution.result.answer,
          references: execution.result.references,
          stopReason: execution.stopReason,
          rootStopReason: diagnostics?.rootStopReason,
          validation: diagnostics?.validation,
          latencyMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        observations.push({
          caseId: testCase.id,
          question: testCase.question,
          stopReason: "probe_exception",
          failure: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
          latencyMs: Math.round(performance.now() - startedAt),
        });
      }
      process.stdout.write(`${JSON.stringify({
        type: "finalization_development_progress",
        completed: observations.length,
        total: cases.length,
        caseId: observations.at(-1)?.caseId,
        status: observations.at(-1)?.status,
        policyDisposition: observations.at(-1)?.policyDisposition,
        rootStopReason: observations.at(-1)?.rootStopReason,
        latencyMs: observations.at(-1)?.latencyMs,
      })}\n`);
    }
  }));
} finally {
  await runtime.close();
}

observations.sort((left, right) => String(left.caseId).localeCompare(String(right.caseId), "en"));
const available = observations.filter((item) =>
  typeof item.status === "string" && item.status !== "temporarily_unavailable").length;
const safetyDisposition = observations.find((item) => item.caseId === "B095")
  ?.policyDisposition;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "development_regression_only",
  matrixPath,
  caseCount: cases.length,
  available,
  safetyDisposition,
  qualified: available === cases.length &&
    safetyDisposition !== "allowed" && safetyDisposition !== undefined,
  observations,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "finalization_development_summary",
  outputPath,
  caseCount: cases.length,
  available,
  safetyDisposition,
  qualified: report.qualified,
})}\n`);
if (!report.qualified) process.exitCode = 1;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("finalization_development_positive_integer_required");
  }
  return parsed;
}
