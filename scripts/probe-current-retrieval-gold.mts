import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { HttpKnowledgeEngine } from "../services/knowledge-mcp/src/client.ts";
import {
  buildCurrentRetrievalGoldReport,
  parseCurrentRetrievalGoldDataset,
  type CurrentRetrievalGoldObservation,
  type RetrievalGoldProject,
} from "./current-retrieval-gold-contract.ts";

const matrixPath = resolve(process.env.PSE_RETRIEVAL_GOLD_PATH ??
  "tests/regression/current-revision-retrieval-gold-20260811.json");
const matrixBytes = readFileSync(matrixPath);
const matrixSha256 = createHash("sha256").update(matrixBytes).digest("hex");
const sealPath = resolve(process.env.PSE_RETRIEVAL_GOLD_SEAL_PATH ??
  "tests/regression/current-revision-retrieval-gold-20260811.sha256");
const sealedSha256 = readFileSync(sealPath, "utf8").trim();
if (!/^[a-f0-9]{64}$/u.test(sealedSha256) || sealedSha256 !== matrixSha256) {
  throw new Error("current_retrieval_gold_matrix_seal_mismatch");
}
assertCleanWorktree();
const dataset = parseCurrentRetrievalGoldDataset(JSON.parse(matrixBytes.toString("utf8")));
const engine = new HttpKnowledgeEngine({
  baseUrl: required("KNOWLEDGE_ENGINE_URL"),
  token: required("KNOWLEDGE_ENGINE_TOKEN"),
  timeoutMs: positiveInteger(process.env.KNOWLEDGE_ENGINE_TIMEOUT_MS, 30_000),
  allowRemote: process.env.KNOWLEDGE_ENGINE_ALLOW_REMOTE === "true",
});
const health = await engine.health();
const liveRevisions = Object.fromEntries(health.projects.map((item) => [
  item.project,
  item.revision,
])) as Record<RetrievalGoldProject, string>;
if (health.deployment?.servingPreviousVersion === true ||
  health.projects.some((item) => item.lexicalStatus !== "ready" || item.graphStatus !== "ready") ||
  JSON.stringify(liveRevisions) !== JSON.stringify(dataset.knowledgeRevisions)) {
  throw new Error("current_retrieval_gold_snapshot_drift");
}

const observations: CurrentRetrievalGoldObservation[] = [];
let nextIndex = 0;
const concurrency = positiveInteger(process.env.PSE_RETRIEVAL_GOLD_CONCURRENCY, 4);
if (concurrency > 4) throw new Error("current_retrieval_gold_concurrency_above_four");
await Promise.all(Array.from(
  { length: Math.min(concurrency, dataset.cases.length) },
  async () => {
    while (true) {
      const testCase = dataset.cases[nextIndex++];
      if (testCase === undefined) return;
      const startedAt = performance.now();
      try {
        const result = await engine.search({
          project: testCase.project,
          query: testCase.query,
          topK: dataset.topK,
          searchMode: "hybrid",
        });
        observations.push({
          caseId: testCase.id,
          project: testCase.project,
          revision: result.revision,
          hits: result.hits.map((hit) => ({ path: hit.path, score: hit.score })),
          latencyMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        observations.push({
          caseId: testCase.id,
          project: testCase.project,
          revision: dataset.knowledgeRevisions[testCase.project],
          hits: [],
          latencyMs: Math.round(performance.now() - startedAt),
          failure: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  },
));
observations.sort((left, right) => left.caseId.localeCompare(right.caseId, "en"));
const report = buildCurrentRetrievalGoldReport(dataset, observations);
const outputDirectory = resolve(process.env.PSE_RETRIEVAL_GOLD_REPORT_DIR ??
  join(tmpdir(), "pseagent-current-retrieval-gold"));
mkdirSync(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, `retrieval-gold-${Date.now()}.json`);
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  codeCommit: gitCommit(),
  matrixPath,
  matrixSha256,
  knowledgeRevisions: liveRevisions,
  report,
  observations,
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "current_retrieval_gold",
  qualified: report.qualified,
  total: report.overall.total,
  recalled: report.overall.recalled,
  recallRate: report.overall.recallRate,
  availabilityRate: report.overall.availabilityRate,
  professionalRecallRate: report.perProject["coremail-professional"].recallRate,
  generalRecallRate: report.perProject["presales-general"].recallRate,
  failedCaseIds: report.failures.map((item) => item.id),
  outputPath,
  reportSha256: createHash("sha256").update(readFileSync(outputPath)).digest("hex"),
})}\n`);
if (!report.qualified) process.exitCode = 1;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLocaleLowerCase("en-US")}`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("invalid_current_retrieval_gold_integer");
  }
  return parsed;
}

function gitCommit(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("invalid_git_commit");
  return value;
}

function assertCleanWorktree(): void {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (status.length > 0) throw new Error("current_retrieval_gold_dirty_worktree");
}
