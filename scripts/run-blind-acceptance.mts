import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import iconv from "iconv-lite";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import { POLICY_CONTRACT_VERSION } from "../apps/pseagent/src/policy-preflight.ts";
import {
  blindAcceptanceScorerVersion,
  buildBlindAcceptanceReport,
  hashBlindQuestion,
  parseBlindAcceptanceDataset,
  type BlindAcceptanceObservation,
  type BlindProject,
} from "./blind-acceptance-contract.ts";
import {
  assertPinnedKnowledgeRevisions,
  BLIND_ACCEPTANCE_REQUIRED_MODEL,
  requirePinnedKnowledgeRevisions,
  validateColdRunEnvironment,
} from "./blind-run-contract.ts";
import { ReliabilityDiagnosticCollector } from "./reliability-diagnostics.ts";

const matrixPath = resolve(process.env.PSE_BLIND_MATRIX_PATH ??
  "tests/e2e/enterprise-blind-acceptance-20260810.json");
const sealPath = resolve(process.env.PSE_BLIND_SEAL_PATH ??
  "tests/e2e/enterprise-blind-acceptance-20260810.sha256");
const matrixBytes = readFileSync(matrixPath);
const matrixSha256 = sha256(matrixBytes);
const exclusions = loadExcludedQuestionHashes(matrixPath);
const exclusionHashesSha256 = sha256(Buffer.from([...exclusions].sort().join("\n")));
if (process.env.PSE_BLIND_PRINT_SEAL === "true") {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    matrixSha256,
    excludedQuestionCount: exclusions.size,
    excludedQuestionsSha256: exclusionHashesSha256,
  }, null, 2)}\n`);
  process.exit(0);
}
const seal = parseSeal(JSON.parse(readFileSync(sealPath, "utf8")));
if (
  seal.matrixSha256 !== matrixSha256 ||
  seal.excludedQuestionCount !== exclusions.size ||
  seal.excludedQuestionsSha256 !== exclusionHashesSha256
) {
  throw new Error("blind_acceptance_seal_mismatch");
}
const dataset = parseBlindAcceptanceDataset(
  JSON.parse(matrixBytes.toString("utf8")),
  exclusions,
);
if (process.env.PSE_BLIND_VALIDATE_ONLY === "true") {
  process.stdout.write(`${JSON.stringify({
    type: "blind_validation",
    matrix: basename(matrixPath),
    matrixSha256,
    excludedQuestionCount: exclusions.size,
    excludedQuestionsSha256: exclusionHashesSha256,
    caseCount: dataset.cases.length,
    layers: Object.fromEntries(dataset.cases.map((item) => item.layer).map((layer) => [
      layer,
      dataset.cases.filter((item) => item.layer === layer).length,
    ])),
  })}\n`);
  process.exit(0);
}

assertCleanWorktree();
const coldIdentity = validateColdRunEnvironment(process.env);
const pinnedKnowledgeRevisions = requirePinnedKnowledgeRevisions(process.env);
const round = parseRound(process.env.PSE_BLIND_ROUND);
const concurrency = positiveInteger(process.env.PSE_BLIND_CONCURRENCY, 4);
if (concurrency > 4) throw new Error("blind_acceptance_concurrency_above_four");
const timeoutMs = positiveInteger(process.env.PSE_BLIND_TIMEOUT_MS, 180_000);
const codeCommit = gitCommit();
const knowledgeRevisions = await readKnowledgeRevisions();
assertPinnedKnowledgeRevisions(pinnedKnowledgeRevisions, knowledgeRevisions);
const batchRoot = resolve(process.env.PSE_BLIND_BATCH_DIR ??
  join(tmpdir(), `pseagent-blind-acceptance-${matrixSha256.slice(0, 12)}`));
mkdirSync(batchRoot, { recursive: true });
const batchManifestPath = join(batchRoot, "batch.json");
const runtimeIdentity = {
  codeCommit,
  model: BLIND_ACCEPTANCE_REQUIRED_MODEL,
  knowledgeRevisions,
  matrixSha256,
  exclusionHashesSha256,
  ...coldIdentity,
  scorerVersion: blindAcceptanceScorerVersion,
  policyVersion: POLICY_CONTRACT_VERSION,
};
if (existsSync(batchManifestPath)) {
  const previous = JSON.parse(readFileSync(batchManifestPath, "utf8"));
  if (JSON.stringify(previous.runtimeIdentity) !== JSON.stringify(runtimeIdentity)) {
    throw new Error("blind_acceptance_runtime_drift");
  }
} else {
  writeFileSync(batchManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runtimeIdentity,
  }, null, 2)}\n`, "utf8");
}
const roundPath = join(batchRoot, `round-${round}.json`);
if (existsSync(roundPath)) throw new Error("blind_acceptance_round_already_exists");
const progressPath = join(batchRoot, `round-${round}.progress.jsonl`);

const diagnosticCollector = new ReliabilityDiagnosticCollector();
const runtime = await createPseAgentRuntime(process.env, {
  createDiagnosticTraceFactory: () => diagnosticCollector,
});
const observations: BlindAcceptanceObservation[] = [];
const orderedCases = rotate(dataset.cases, (round - 1) * 37);
let nextIndex = 0;
try {
  const workers = Array.from(
    { length: Math.min(concurrency, orderedCases.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        const testCase = orderedCases[index];
        if (testCase === undefined) return;
        const startedAt = performance.now();
        let observation: BlindAcceptanceObservation;
        try {
          const execution = await runtime.answerDetailed(
            testCase.question,
            testCase.conversationContext,
            AbortSignal.timeout(timeoutMs),
          );
          const diagnostics = diagnosticCollector.take(execution.requestId);
          observation = {
            caseId: testCase.id,
            round,
            ...runtimeIdentity,
            scope: execution.result.scope,
            status: execution.result.status,
            ...(execution.result.policyDisposition === undefined
              ? {}
              : { policyDisposition: execution.result.policyDisposition }),
            answer: execution.result.answer,
            ...(execution.domainsUsed === undefined
              ? {}
              : { domainsUsed: execution.domainsUsed }),
            references: execution.result.references.map((reference) => ({
              index: reference.index,
              project: reference.project,
              revision: reference.revision,
            })),
            stopReason: execution.stopReason,
            latencyMs: Math.round(performance.now() - startedAt),
            diagnostics,
          };
        } catch (error) {
          observation = {
            caseId: testCase.id,
            round,
            ...runtimeIdentity,
            answer: "",
            references: [],
            stopReason: "probe_exception",
            latencyMs: Math.round(performance.now() - startedAt),
            failure: error instanceof Error ? error.name : "unknown",
          };
        }
        observations.push(observation);
        appendFileSync(progressPath, `${JSON.stringify({
          caseId: observation.caseId,
          round,
          status: observation.status,
          scope: observation.scope,
          stopReason: observation.stopReason,
          latencyMs: observation.latencyMs,
          failure: observation.failure,
          rootStopReason: observation.diagnostics?.rootStopReason,
          modelAttemptCount: observation.diagnostics?.model.attemptCount,
          cacheHitCount: observation.diagnostics?.cache.hitCount,
        })}\n`, "utf8");
        process.stdout.write(`${JSON.stringify({
          type: "blind_progress",
          completed: observations.length,
          total: dataset.cases.length,
          caseId: observation.caseId,
          round,
          status: observation.status,
          stopReason: observation.stopReason,
          rootStopReason: observation.diagnostics?.rootStopReason,
          cacheHitCount: observation.diagnostics?.cache.hitCount,
          latencyMs: observation.latencyMs,
        })}\n`);
      }
    },
  );
  await Promise.all(workers);
} finally {
  await runtime.close();
}
if (observations.some((observation) =>
  (observation.diagnostics?.cache.hitCount ?? 0) > 0)) {
  throw new Error("blind_acceptance_cache_hit_forbidden");
}
const endingRevisions = await readKnowledgeRevisions();
assertPinnedKnowledgeRevisions(pinnedKnowledgeRevisions, endingRevisions);
const endingRuntimeIdentity = {
  codeCommit: gitCommit(),
  model: BLIND_ACCEPTANCE_REQUIRED_MODEL,
  knowledgeRevisions: endingRevisions,
  matrixSha256,
  exclusionHashesSha256,
  ...validateColdRunEnvironment(process.env),
  scorerVersion: blindAcceptanceScorerVersion,
  policyVersion: POLICY_CONTRACT_VERSION,
};
assertCleanWorktree();
if (JSON.stringify(endingRuntimeIdentity) !== JSON.stringify(runtimeIdentity)) {
  throw new Error("blind_acceptance_runtime_drift");
}
observations.sort((left, right) => left.caseId.localeCompare(right.caseId, "en"));
writeFileSync(roundPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtimeIdentity,
  matrixSha256,
  round,
  observations,
}, null, 2)}\n`, "utf8");

const allObservations = [1, 2, 3].flatMap((candidateRound) => {
  const candidatePath = join(batchRoot, `round-${candidateRound}.json`);
  if (!existsSync(candidatePath)) return [];
  const value = JSON.parse(readFileSync(candidatePath, "utf8"));
  return Array.isArray(value.observations)
    ? value.observations as BlindAcceptanceObservation[]
    : [];
});
let finalReportPath: string | undefined;
let finalQualified: boolean | undefined;
if (allObservations.length === 300) {
  const scoring = buildBlindAcceptanceReport(dataset, allObservations);
  finalQualified = scoring.qualified;
  finalReportPath = join(batchRoot, "final-report.json");
  writeFileSync(finalReportPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtimeIdentity,
    matrixSha256,
    exclusionHashesSha256,
    scoring,
    observations: allObservations,
  }, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({
  type: "blind_round_summary",
  batchRoot,
  round,
  completed: observations.length,
  roundPath,
  roundSha256: sha256(readFileSync(roundPath)),
  finalReportPath,
  ...(finalReportPath === undefined
    ? {}
    : { finalReportSha256: sha256(readFileSync(finalReportPath)) }),
})}\n`);
if (finalQualified === false) process.exitCode = 1;

function loadExcludedQuestionHashes(blindMatrixPath: string): Set<string> {
  const questions = new Set<string>();
  for (const path of walkJson(resolve("tests"))) {
    if (resolve(path) === blindMatrixPath) continue;
    collectQuestionStrings(JSON.parse(readFileSync(path, "utf8")), questions);
  }
  const catalogPath = process.env.PSE_ANSWER_CARD_CATALOG_PATH?.trim();
  if (catalogPath && existsSync(catalogPath)) {
    collectQuestionStrings(JSON.parse(readFileSync(catalogPath, "utf8")), questions);
  }
  const legacyPaths = process.env.PSE_BLIND_LEGACY_JSONL?.split(";")
    .map((path) => path.trim()).filter(Boolean) ?? [];
  for (const path of legacyPaths) {
    for (const line of readFileSync(resolve(path), "utf8").split(/\r?\n/u)) {
      if (!line.startsWith("{")) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type !== "manifest" || !Array.isArray(value.items)) continue;
      for (const item of value.items) {
        if (isRecord(item) && typeof item.question === "string") {
          questions.add(recoverLegacyUtf8(item.question));
        }
      }
    }
  }
  return new Set([...questions].map(hashBlindQuestion));
}

function collectQuestionStrings(value: unknown, output: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (["question", "canonicalQuestion", "aliases", "regressionQuestions"]
      .includes(key) && value.trim()) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectQuestionStrings(item, output, key);
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, child] of Object.entries(value)) {
    collectQuestionStrings(child, output, childKey);
  }
}

function walkJson(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = statSync(path);
    return stat.isDirectory() ? walkJson(path) : path.endsWith(".json") ? [path] : [];
  });
}

function parseSeal(value: unknown): {
  readonly matrixSha256: string;
  readonly excludedQuestionCount: number;
  readonly excludedQuestionsSha256: string;
} {
  if (!isRecord(value) ||
    typeof value.matrixSha256 !== "string" ||
    typeof value.excludedQuestionsSha256 !== "string" ||
    !Number.isSafeInteger(value.excludedQuestionCount)) {
    throw new Error("invalid_blind_acceptance_seal");
  }
  return value as ReturnType<typeof parseSeal>;
}

function parseRound(value: string | undefined): 1 | 2 | 3 {
  const parsed = Number(value);
  if (![1, 2, 3].includes(parsed)) throw new Error("blind_acceptance_round_required");
  return parsed as 1 | 2 | 3;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("blind_acceptance_numeric_options_must_be_positive_integers");
  }
  return parsed;
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  const normalized = offset % items.length;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

function assertCleanWorktree(): void {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.trim()) throw new Error("blind_acceptance_requires_clean_worktree");
}

function gitCommit(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("invalid_git_commit");
  return value;
}

async function readKnowledgeRevisions(): Promise<Record<BlindProject, string>> {
  const baseUrl = process.env.KNOWLEDGE_ENGINE_URL?.replace(/\/$/u, "");
  if (!baseUrl) throw new Error("knowledge_engine_url_missing");
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("knowledge_health_unavailable");
  const value = await response.json();
  if (!isRecord(value) || value.status !== "ready" || !Array.isArray(value.projects)) {
    throw new Error("knowledge_health_not_ready");
  }
  const revision = (project: BlindProject): string => {
    const item = value.projects.find((candidate) =>
      isRecord(candidate) && candidate.project === project);
    if (!isRecord(item) || typeof item.revision !== "string" ||
      item.lexicalStatus !== "ready" || item.graphStatus !== "ready") {
      throw new Error("knowledge_snapshot_not_ready");
    }
    return item.revision;
  };
  return {
    "coremail-professional": revision("coremail-professional"),
    "presales-general": revision("presales-general"),
  };
}

function recoverLegacyUtf8(value: string): string {
  const decoded = iconv.decode(iconv.encode(value, "gb18030"), "utf8");
  return decoded.includes("�") ? value : decoded;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
