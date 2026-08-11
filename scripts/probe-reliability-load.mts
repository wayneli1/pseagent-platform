import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import {
  parseReliabilityKnowledgeHealth,
  selectReliabilityCases,
  summarizeReliabilityLoad,
  type ReliabilityLoadObservation,
} from "./probe-reliability-load-contract.ts";
import { ReliabilityDiagnosticCollector } from "./reliability-diagnostics.ts";

interface ProbeCase {
  readonly id: string;
  readonly question: string;
}

const cases = parseCases(JSON.parse(readFileSync(
  new URL("../tests/regression/questions.json", import.meta.url),
  "utf8",
)));
const profiles = parseProfiles(process.env.PSE_RELIABILITY_CONCURRENCY ?? "1,2,4,10");
const limit = positiveInteger(process.env.PSE_RELIABILITY_LIMIT, 10);
const repeat = positiveInteger(process.env.PSE_RELIABILITY_REPEAT, 1);
const timeoutMs = positiveInteger(process.env.PSE_RELIABILITY_TIMEOUT_MS, 180_000);
const selected = selectReliabilityCases(
  cases,
  process.env.PSE_RELIABILITY_IDS,
  limit,
);
if (selected.length === 0) throw new Error("no_reliability_cases_selected");
const work = Array.from({ length: repeat }, () => selected).flat();
const knowledgeRevisions = await readKnowledgeRevisions();
const report = {
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  timeoutMs,
  models: {
    resolver: process.env.PSE_RESOLVER_MODEL_NAME ?? process.env.PSE_MODEL_NAME,
    planner: process.env.PSE_PLANNER_MODEL_NAME ?? process.env.PSE_MODEL_NAME,
    synthesizer: process.env.PSE_SYNTHESIZER_MODEL_NAME ?? process.env.PSE_MODEL_NAME,
    verifier: process.env.PSE_VERIFIER_MODEL_NAME ?? process.env.PSE_MODEL_NAME,
  },
  knowledgeRevisions,
  profiles: [] as Array<{
    readonly summary: ReturnType<typeof summarizeReliabilityLoad>;
    readonly records: readonly (ReliabilityLoadObservation & {
      readonly id: string;
      readonly sequence: number;
      readonly scope?: string;
    })[];
  }>,
};

for (const concurrency of profiles) {
  const diagnosticCollector = new ReliabilityDiagnosticCollector();
  const runtime = await createPseAgentRuntime(process.env, {
    createDiagnosticTraceFactory: () => diagnosticCollector,
  });
  const records: Array<ReliabilityLoadObservation & {
    readonly id: string;
    readonly sequence: number;
    readonly scope?: string;
  }> = [];
  let nextIndex = 0;
  try {
    const workers = Array.from(
      { length: Math.min(concurrency, work.length) },
      async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          const item = work[index];
          if (item === undefined) return;
          const record = await runOne(index + 1, item);
          records.push(record);
          process.stdout.write(`${JSON.stringify({
            type: "result",
            concurrency,
            ...record,
          })}\n`);
        }
      },
    );
    await Promise.all(workers);
  } finally {
    await runtime.close();
  }
  records.sort((left, right) => left.sequence - right.sequence);
  report.profiles.push({
    summary: summarizeReliabilityLoad(concurrency, records),
    records,
  });

  async function runOne(
    sequence: number,
    item: ProbeCase,
  ): Promise<ReliabilityLoadObservation & {
    readonly id: string;
    readonly sequence: number;
    readonly scope?: string;
  }> {
    const startedAt = performance.now();
    try {
      const execution = await runtime.answerDetailed(
        item.question,
        undefined,
        AbortSignal.timeout(timeoutMs),
      );
      const diagnostics = diagnosticCollector.take(execution.requestId);
      return {
        id: item.id,
        sequence,
        elapsedMs: Math.round(performance.now() - startedAt),
        scope: execution.result.scope,
        status: execution.result.status,
        stopReason: execution.stopReason,
        queueElapsedMs: diagnostics.model.queueElapsedMs,
        modelExecutionElapsedMs: diagnostics.model.executionElapsedMs,
        modelAttemptCount: diagnostics.model.attemptCount,
        diagnostics,
      };
    } catch (error) {
      return {
        id: item.id,
        sequence,
        elapsedMs: Math.round(performance.now() - startedAt),
        stopReason: "probe_exception",
        failure: error instanceof Error ? error.name : "unknown",
      };
    }
  }
}

const directory = join(tmpdir(), "pseagent-reliability-load");
mkdirSync(directory, { recursive: true });
const reportPath = join(directory, `reliability-load-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "summary",
  reportPath,
  profiles: report.profiles.map((profile) => profile.summary),
})}\n`);

function parseCases(value: unknown): ProbeCase[] {
  if (!Array.isArray(value)) throw new Error("invalid_reliability_cases");
  return value.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("question" in item) ||
      typeof item.question !== "string"
    ) {
      throw new Error("invalid_reliability_case");
    }
    return { id: item.id, question: item.question };
  });
}

function parseProfiles(value: string): number[] {
  const profiles = [...new Set(value.split(",").map((item) => Number(item.trim())))];
  if (
    profiles.length === 0 ||
    profiles.some((item) => !Number.isSafeInteger(item) || item <= 0 || item > 10)
  ) {
    throw new Error("invalid_reliability_concurrency_profiles");
  }
  return profiles;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("reliability numeric options must be positive integers");
  }
  return parsed;
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function readKnowledgeRevisions() {
  const baseUrl = process.env.KNOWLEDGE_ENGINE_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    throw new Error("knowledge_engine_url_missing");
  }
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("knowledge_health_unavailable");
  return parseReliabilityKnowledgeHealth(await response.json());
}
