import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";

type StabilityCase = {
  readonly id: string;
  readonly question: string;
  readonly expectedScope?: string;
  readonly expectedStatus?: string;
};

type StabilityRecord = {
  readonly type: "result";
  readonly sequence: number;
  readonly id: string;
  readonly scope?: string;
  readonly status?: string;
  readonly stopReason: string;
  readonly retryable?: boolean;
  readonly references?: number;
  readonly historicalAttempted?: boolean;
  readonly historicalUsed?: boolean;
  readonly elapsedMs: number;
  readonly expectedScope?: string;
  readonly expectedStatus?: string;
  readonly scopeMatches?: boolean;
  readonly statusMatches?: boolean;
  readonly failure?: string;
};

const cases = parseCases(JSON.parse(readFileSync(
  new URL("../tests/regression/questions.json", import.meta.url),
  "utf8",
)));
const selectedIds = new Set(
  (process.env.PSE_STABILITY_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const repeat = positiveInteger(process.env.PSE_STABILITY_REPEAT, 1);
const concurrency = positiveInteger(process.env.PSE_STABILITY_CONCURRENCY, 1);
if (concurrency > 4) throw new Error("PSE_STABILITY_CONCURRENCY must be <= 4");
const limit = positiveInteger(process.env.PSE_STABILITY_LIMIT, cases.length);
const selected = cases
  .filter((item) => selectedIds.size === 0 || selectedIds.has(item.id))
  .slice(0, limit);
if (selected.length === 0) throw new Error("no_stability_cases_selected");
const work = Array.from({ length: repeat }, () => selected).flat();

const runtime = await createPseAgentRuntime(process.env);
const records: StabilityRecord[] = [];
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
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    },
  );
  await Promise.all(workers);
} finally {
  await runtime.close();
}

const summary = {
  type: "summary",
  total: records.length,
  final: records.filter((item) => item.stopReason === "final").length,
  unavailable: records.filter((item) =>
    item.status === "temporarily_unavailable").length,
  failures: records.filter((item) => item.failure !== undefined).length,
  stopReasons: Object.fromEntries(
    [...new Set(records.map((item) => item.stopReason))]
      .sort()
      .map((reason) => [
        reason,
        records.filter((item) => item.stopReason === reason).length,
      ]),
  ),
  statuses: Object.fromEntries(
    [...new Set(records.map((item) => item.status ?? "missing"))]
      .sort()
      .map((status) => [
        status,
        records.filter((item) => (item.status ?? "missing") === status).length,
      ]),
  ),
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.unavailable > 0 || summary.failures > 0) process.exitCode = 1;

async function runOne(
  sequence: number,
  item: StabilityCase,
): Promise<StabilityRecord> {
  const started = performance.now();
  try {
    const execution = await runtime.answerDetailed(item.question);
    const elapsedMs = Math.round(performance.now() - started);
    return {
      type: "result",
      sequence,
      id: item.id,
      scope: execution.result.scope,
      status: execution.result.status,
      stopReason: execution.stopReason,
      retryable: execution.retryable,
      references: execution.result.references.length,
      historicalAttempted: execution.historicalAttempted,
      historicalUsed: execution.historicalUsed,
      elapsedMs,
      ...(item.expectedScope === undefined
        ? {}
        : {
            expectedScope: item.expectedScope,
            scopeMatches: execution.result.scope === item.expectedScope,
          }),
      ...(item.expectedStatus === undefined
        ? {}
        : {
            expectedStatus: item.expectedStatus,
            statusMatches: execution.result.status === item.expectedStatus,
          }),
    };
  } catch (error) {
    return {
      type: "result",
      sequence,
      id: item.id,
      stopReason: "probe_exception",
      elapsedMs: Math.round(performance.now() - started),
      failure: error instanceof Error ? error.message.slice(0, 256) : "unknown",
      ...(item.expectedScope === undefined
        ? {}
        : { expectedScope: item.expectedScope }),
      ...(item.expectedStatus === undefined
        ? {}
        : { expectedStatus: item.expectedStatus }),
    };
  }
}

function parseCases(value: unknown): StabilityCase[] {
  if (!Array.isArray(value)) throw new Error("invalid_stability_cases");
  return value.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("question" in item) ||
      typeof item.question !== "string"
    ) {
      throw new Error("invalid_stability_case");
    }
    return {
      id: item.id,
      question: item.question,
      ...("expectedScope" in item && typeof item.expectedScope === "string"
        ? { expectedScope: item.expectedScope }
        : {}),
      ...("expectedStatus" in item && typeof item.expectedStatus === "string"
        ? { expectedStatus: item.expectedStatus }
        : {}),
    };
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("stability numeric options must be positive integers");
  }
  return parsed;
}
