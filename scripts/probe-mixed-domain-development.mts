import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import { ReliabilityDiagnosticCollector } from "./reliability-diagnostics.ts";

type DevelopmentCase = {
  readonly id: string;
  readonly layer: string;
  readonly question: string;
};

const matrixPath = resolve(process.env.PSE_MIXED_DEV_MATRIX_PATH ??
  "tests/e2e/enterprise-blind-acceptance-20260811-final.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
  readonly cases?: readonly DevelopmentCase[];
};
const cases = (matrix.cases ?? []).filter((testCase) => testCase.layer === "mixed");
if (cases.length === 0) throw new Error("mixed_development_cases_missing");

const concurrency = Math.min(4, positiveInteger(
  process.env.PSE_MIXED_DEV_CONCURRENCY,
  3,
));
const timeoutMs = positiveInteger(process.env.PSE_MIXED_DEV_TIMEOUT_MS, 180_000);
const outputRoot = resolve(process.env.PSE_MIXED_DEV_OUTPUT_DIR ??
  join(tmpdir(), "pseagent-mixed-domain-development"));
mkdirSync(outputRoot, { recursive: true });
const outputPath = join(outputRoot, `mixed-domain-${Date.now()}.json`);

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
          undefined,
          AbortSignal.timeout(timeoutMs),
        );
        const diagnostics = diagnosticCollector.take(execution.requestId);
        const domainsUsed = execution.domainsUsed ?? [];
        observations.push({
          caseId: testCase.id,
          question: testCase.question,
          scope: execution.result.scope,
          status: execution.result.status,
          domainsUsed,
          bothDomains: domainsUsed.includes("coremail-professional") &&
            domainsUsed.includes("presales-general"),
          stopReason: execution.stopReason,
          rootStopReason: diagnostics?.rootStopReason,
          latencyMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        observations.push({
          caseId: testCase.id,
          question: testCase.question,
          bothDomains: false,
          stopReason: "probe_exception",
          failure: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
          latencyMs: Math.round(performance.now() - startedAt),
        });
      }
      process.stdout.write(`${JSON.stringify({
        type: "mixed_development_progress",
        completed: observations.length,
        total: cases.length,
        ...observations.at(-1),
      })}\n`);
    }
  }));
} finally {
  await runtime.close();
}

observations.sort((left, right) => String(left.caseId).localeCompare(String(right.caseId), "en"));
const bothDomains = observations.filter((item) => item.bothDomains === true).length;
const available = observations.filter((item) =>
  typeof item.status === "string" && item.status !== "temporarily_unavailable").length;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "development_regression_only",
  matrixPath,
  caseCount: cases.length,
  bothDomains,
  available,
  qualified: bothDomains === cases.length && available === cases.length,
  observations,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "mixed_development_summary",
  outputPath,
  caseCount: cases.length,
  bothDomains,
  available,
  qualified: report.qualified,
})}\n`);
if (!report.qualified) process.exitCode = 1;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("mixed_development_positive_integer_required");
  }
  return parsed;
}
