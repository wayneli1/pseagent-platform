import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import iconv from "iconv-lite";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.ts";
import type { EvidenceLedger, EvidenceLedgerUnit } from
  "../apps/pseagent/src/evidence-ledger.ts";
import {
  classifyEvidenceGap,
  summarizeEvidenceGapAudit,
  type EvidenceAuditHumanGold,
  type EvidenceGapAuditObservation,
} from "./audit-reliability-evidence-gaps-contract.ts";

interface AuditCase {
  readonly id: string;
  readonly question: string;
  readonly expectedScope: "professional" | "general";
  readonly humanGold: EvidenceAuditHumanGold;
  readonly humanGoldByAspect?: Readonly<Record<string, EvidenceAuditHumanGold>>;
}

interface AuditRecord {
  readonly id: string;
  readonly expectedScope: AuditCase["expectedScope"];
  readonly actualScope?: string;
  readonly status?: string;
  readonly stopReason: string;
  readonly elapsedMs: number;
  readonly outcome:
    | "answered_without_gap"
    | "remaining_gap"
    | "scope_mismatch"
    | "execution_unavailable"
    | "probe_exception";
  readonly observations: readonly EvidenceGapAuditObservation[];
  readonly failure?: string;
}

const input = await loadCases();
const concurrency = positiveInteger(process.env.PSE_EVIDENCE_AUDIT_CONCURRENCY, 3);
if (concurrency > 4) throw new Error("evidence_audit_concurrency_above_four");
const timeoutMs = positiveInteger(process.env.PSE_EVIDENCE_AUDIT_TIMEOUT_MS, 180_000);
const runtime = await createPseAgentRuntime(process.env);
const records: AuditRecord[] = [];
let nextIndex = 0;
try {
  const workers = Array.from(
    { length: Math.min(concurrency, input.cases.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        const item = input.cases[index];
        if (item === undefined) return;
        const record = await runOne(item);
        records.push(record);
        process.stdout.write(`${JSON.stringify({
          type: "audit_result",
          id: record.id,
          status: record.status,
          actualScope: record.actualScope,
          outcome: record.outcome,
          elapsedMs: record.elapsedMs,
          gapCount: record.observations.length,
        })}\n`);
      }
    },
  );
  await Promise.all(workers);
} finally {
  await runtime.close();
}

records.sort((left, right) => left.id.localeCompare(right.id, "en"));
const observations = records.flatMap((record) => record.observations);
const gapSummary = summarizeEvidenceGapAudit(observations);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  source: input.source,
  sourceSha256: input.sourceSha256,
  timeoutMs,
  concurrency,
  selectedCaseCount: input.cases.length,
  knowledgeRevisions: await readKnowledgeRevisions(),
  summary: {
    answeredWithoutGap: records.filter((item) =>
      item.outcome === "answered_without_gap").length,
    remainingGap: records.filter((item) => item.outcome === "remaining_gap").length,
    scopeMismatch: records.filter((item) => item.outcome === "scope_mismatch").length,
    executionUnavailable: records.filter((item) =>
      item.outcome === "execution_unavailable").length,
    probeException: records.filter((item) => item.outcome === "probe_exception").length,
    evidenceGapAudit: gapSummary,
  },
  records: records.map((record) => ({
    ...record,
    decisions: record.observations.map(classifyEvidenceGap),
  })),
};
const directory = join(tmpdir(), "pseagent-reliability-evidence-audit");
mkdirSync(directory, { recursive: true });
const reportPath = join(directory, `evidence-gap-audit-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  type: "audit_summary",
  reportPath,
  selectedCaseCount: report.selectedCaseCount,
  ...report.summary,
})}\n`);

async function runOne(item: AuditCase): Promise<AuditRecord> {
  const startedAt = performance.now();
  try {
    const execution = await runtime.answerDetailed(
      item.question,
      undefined,
      AbortSignal.timeout(timeoutMs),
    );
    const observations = (execution.domainEvidenceLedgers ?? []).flatMap((ledger) =>
      observationsFromLedger(item, ledger));
    const actualScope = execution.result.scope;
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (actualScope !== item.expectedScope) {
      return {
        id: item.id,
        expectedScope: item.expectedScope,
        actualScope,
        status: execution.result.status,
        stopReason: execution.stopReason,
        elapsedMs,
        outcome: "scope_mismatch",
        observations,
      };
    }
    if (execution.result.status === "temporarily_unavailable") {
      return {
        id: item.id,
        expectedScope: item.expectedScope,
        actualScope,
        status: execution.result.status,
        stopReason: execution.stopReason,
        elapsedMs,
        outcome: "execution_unavailable",
        observations,
      };
    }
    return {
      id: item.id,
      expectedScope: item.expectedScope,
      actualScope,
      status: execution.result.status,
      stopReason: execution.stopReason,
      elapsedMs,
      outcome: observations.length === 0
        ? "answered_without_gap"
        : "remaining_gap",
      observations,
    };
  } catch (error) {
    return {
      id: item.id,
      expectedScope: item.expectedScope,
      stopReason: "probe_exception",
      elapsedMs: Math.round(performance.now() - startedAt),
      outcome: "probe_exception",
      observations: [],
      failure: error instanceof Error ? error.name : "unknown",
    };
  }
}

function observationsFromLedger(
  item: AuditCase,
  ledger: EvidenceLedger,
): EvidenceGapAuditObservation[] {
  return ledger.units.flatMap((unit) => unit.verification.missingAspectIds.map((aspectId) => {
    const candidates = unit.candidates.filter((candidate) =>
      candidate.aspectIds.length === 0 || candidate.aspectIds.includes(aspectId));
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const reads = unit.reads.filter((read) => candidatePaths.has(read.path));
    const successfulPaths = new Set(
      reads.filter((read) => read.status === "success").map((read) => read.path),
    );
    const plannedIndexes = unit.requirement.queries.flatMap((query, index) =>
      query.aspectIds.includes(aspectId) ? [index] : []);
    const applicableQueries = unit.queries.filter((query) =>
      query.aspectIds.length === 0 ||
      query.aspectIds.includes(aspectId) ||
      query.plannedQueryIndexes.some((index) => plannedIndexes.includes(index)));
    return {
      id: `${item.id}/${unit.requirement.id}/${aspectId}`,
      caseId: item.id,
      domain: ledger.project,
      requirementId: unit.requirement.id,
      obligationId: unit.binding.obligationId,
      aspectId,
      queryStatuses: applicableQueries.map((query) => query.status),
      plannedQueryCount: plannedIndexes.length,
      completedPlannedQueryCount: completedPlannedQueries(unit, plannedIndexes),
      candidateCount: candidates.length,
      readCandidateCount: successfulPaths.size,
      unreadCandidateCount: candidates.filter((candidate) =>
        !successfulPaths.has(candidate.path)).length,
      failedReadCount: reads.filter((read) => read.status === "unavailable").length,
      accessDeniedCount: reads.filter((read) => read.status === "access_denied").length +
        Math.max(0, unit.retrieval.accessDeniedCount - unit.reads.filter((read) =>
          read.status === "access_denied").length),
      toolUnavailableCount: unit.retrieval.toolUnavailableCount,
      retrievalBudgetExhausted:
        unit.retrieval.deadlineReached ||
        unit.retrieval.searchBudgetExhausted ||
        unit.retrieval.readBudgetExhausted,
      ambiguous: unit.ambiguous,
      conflictDetected: unit.conflictDetected,
      staleOrUnconfirmed: unit.freshness === "stale_or_unconfirmed",
      inputState: unit.inputState,
      humanGold: item.humanGoldByAspect?.[aspectId] ?? item.humanGold,
    } satisfies EvidenceGapAuditObservation;
  }));
}

function completedPlannedQueries(
  unit: EvidenceLedgerUnit,
  indexes: readonly number[],
): number {
  return indexes.filter((index) => unit.queries.some((query) =>
    query.plannedQueryIndexes.includes(index) && query.status !== "unavailable"))
    .length;
}

async function loadCases(): Promise<{
  readonly cases: readonly AuditCase[];
  readonly source: readonly string[];
  readonly sourceSha256: string;
}> {
  const casesPath = process.env.PSE_EVIDENCE_AUDIT_CASES_PATH?.trim();
  const legacyPaths = process.env.PSE_EVIDENCE_AUDIT_LEGACY_JSONL?.split(";")
    .map((path) => path.trim()).filter(Boolean) ?? [];
  if ((casesPath === undefined) === (legacyPaths.length === 0)) {
    throw new Error("provide_exactly_one_evidence_audit_input");
  }
  if (casesPath !== undefined) {
    const path = resolve(casesPath);
    const source = readFileSync(path);
    const parsed = JSON.parse(source.toString("utf8"));
    return {
      cases: parseCases(parsed),
      source: [basename(path)],
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    };
  }

  const manifests = new Map<string, AuditCase>();
  const oldResults = new Map<string, { readonly status?: string; readonly scope?: string }>();
  const hash = createHash("sha256");
  for (const unresolved of legacyPaths) {
    const path = resolve(unresolved);
    const source = readFileSync(path);
    hash.update(source);
    for (const line of source.toString("utf8").split(/\r?\n/u)) {
      if (!line.startsWith("{")) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "manifest" && Array.isArray(value.items)) {
        for (const item of parseLegacyManifest(value.items)) manifests.set(item.id, item);
      } else if (value.type === "result" && typeof value.id === "string") {
        oldResults.set(value.id, {
          ...(typeof value.status === "string" ? { status: value.status } : {}),
          ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
        });
      }
    }
  }
  const cases = [...manifests.values()].filter((item) => {
    const previous = oldResults.get(item.id);
    return previous?.status !== "answered" || previous.scope !== item.expectedScope;
  });
  if (cases.length === 0) throw new Error("no_remaining_development_cases");
  return {
    cases,
    source: legacyPaths.map((path) => basename(path)),
    sourceSha256: hash.digest("hex"),
  };
}

function parseCases(value: unknown): AuditCase[] {
  if (!Array.isArray(value)) throw new Error("invalid_evidence_audit_cases");
  return value.map(parseCase);
}

function parseLegacyManifest(items: readonly unknown[]): AuditCase[] {
  return items.map((raw) => {
    const item = parseCase({
      ...(isRecord(raw) ? raw : {}),
      expectedScope: isRecord(raw) ? raw.category : undefined,
      humanGold: "unknown",
    });
    return { ...item, question: recoverLegacyUtf8(item.question) };
  });
}

function parseCase(raw: unknown): AuditCase {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.question !== "string" ||
    !["professional", "general"].includes(String(raw.expectedScope)) ||
    !["source_present", "source_absent", "unknown"].includes(String(raw.humanGold))
  ) {
    throw new Error("invalid_evidence_audit_case");
  }
  return {
    id: raw.id,
    question: raw.question,
    expectedScope: raw.expectedScope as AuditCase["expectedScope"],
    humanGold: raw.humanGold as EvidenceAuditHumanGold,
    ...(isRecord(raw.humanGoldByAspect)
      ? { humanGoldByAspect: raw.humanGoldByAspect as Record<string, EvidenceAuditHumanGold> }
      : {}),
  };
}

function recoverLegacyUtf8(value: string): string {
  const decoded = iconv.decode(iconv.encode(value, "gb18030"), "utf8");
  return decoded.includes("�") ? value : decoded;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("evidence_audit_numeric_options_must_be_positive_integers");
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

async function readKnowledgeRevisions(): Promise<unknown> {
  const baseUrl = process.env.KNOWLEDGE_ENGINE_URL?.replace(/\/$/u, "");
  if (!baseUrl) return { status: "not_configured" };
  const response = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { status: "unavailable", httpStatus: response.status };
  const value = await response.json();
  if (!isRecord(value) || !Array.isArray(value.projects)) return { status: "invalid" };
  return {
    status: value.status,
    projects: value.projects.flatMap((project) =>
      isRecord(project) && typeof project.project === "string"
        ? [{
            project: project.project,
            revision: project.revision,
            lexicalStatus: project.lexicalStatus,
            graphStatus: project.graphStatus,
          }]
        : []),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
