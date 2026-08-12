export interface ReliabilityLoadObservation {
  readonly elapsedMs: number;
  readonly status?: string;
  readonly stopReason: string;
  readonly failure?: string;
  readonly queueElapsedMs?: number;
  readonly modelExecutionElapsedMs?: number;
  readonly modelAttemptCount?: number;
}

export interface ReliabilityModelMetrics {
  readonly queueElapsedMs: number;
  readonly modelExecutionElapsedMs: number;
  readonly modelAttemptCount: number;
}

export interface ReliabilitySchedulerIdentity {
  readonly maxConcurrency: number;
  readonly maxQueueSize: number;
  readonly queueTimeoutMs: number;
}

export function parseReliabilitySchedulerIdentity(
  env: Readonly<Record<string, string | undefined>>,
): ReliabilitySchedulerIdentity {
  const maxConcurrency = boundedInteger(env.PSE_MODEL_MAX_CONCURRENCY, 4, 1, 32);
  const maxQueueSize = boundedInteger(env.PSE_MODEL_MAX_QUEUE, 32, 0, 1_024);
  const queueTimeoutMs = boundedInteger(
    env.PSE_MODEL_QUEUE_TIMEOUT_MS,
    60_000,
    100,
    180_000,
  );
  if (
    maxConcurrency === undefined ||
    maxQueueSize === undefined ||
    queueTimeoutMs === undefined
  ) {
    throw new Error("invalid_reliability_scheduler_identity");
  }
  return Object.freeze({ maxConcurrency, maxQueueSize, queueTimeoutMs });
}

export function selectReliabilityCases<T extends { readonly id: string }>(
  cases: readonly T[],
  idsValue: string | undefined,
  limit: number,
): T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("invalid_reliability_limit");
  }
  if (idsValue === undefined || idsValue.trim() === "") {
    return cases.slice(0, limit);
  }
  const ids = [...new Set(idsValue.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("empty_reliability_ids");
  const byId = new Map(cases.map((item) => [item.id, item] as const));
  return ids.map((id) => {
    const item = byId.get(id);
    if (item === undefined) throw new Error(`unknown_reliability_id:${id}`);
    return item;
  });
}

export function parseReliabilityKnowledgeHealth(value: unknown): {
  readonly professional: string;
  readonly general: string;
} {
  if (!isRecord(value) || value.status !== "ready" || !Array.isArray(value.projects)) {
    throw new Error("knowledge_health_not_ready");
  }
  const revision = (project: string): string => {
    const snapshot = value.projects.find((item) =>
      isRecord(item) && item.project === project);
    if (
      !isRecord(snapshot) ||
      typeof snapshot.revision !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(snapshot.revision) ||
      snapshot.lexicalStatus !== "ready" ||
      snapshot.graphStatus !== "ready"
    ) {
      throw new Error("knowledge_snapshot_not_ready");
    }
    return snapshot.revision;
  };
  return {
    professional: revision("coremail-professional"),
    general: revision("presales-general"),
  };
}

export function collectReliabilityModelMetrics(
  events: readonly unknown[],
): ReliabilityModelMetrics {
  let queueElapsedMs = 0;
  let modelExecutionElapsedMs = 0;
  let modelAttemptCount = 0;
  for (const event of events) {
    if (!isRecord(event) || event.event !== "model_call") continue;
    queueElapsedMs = Math.max(queueElapsedMs, nonNegativeNumber(event.queueElapsedMs));
    modelExecutionElapsedMs += nonNegativeNumber(event.executionElapsedMs);
    modelAttemptCount += nonNegativeNumber(event.attemptCount);
  }
  return { queueElapsedMs, modelExecutionElapsedMs, modelAttemptCount };
}

export interface ReliabilityLoadSummary {
  readonly concurrency: number;
  readonly total: number;
  readonly successful: number;
  readonly unavailable: number;
  readonly failures: number;
  readonly successRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly queueP95Ms?: number;
  readonly stopReasons: Readonly<Record<string, number>>;
}

export const reliabilityLoadGateThresholds = Object.freeze({
  requiredConcurrencies: Object.freeze([1, 2, 4, 10] as const),
  successRate: 0.995,
  p95Ms: 120_000,
  p99Ms: 180_000,
});

export interface ReliabilityLoadHardGate {
  readonly id: string;
  readonly observed: number;
  readonly comparison: "minimum" | "maximum";
  readonly threshold: number;
  readonly passed: boolean;
}

export interface ReliabilityLoadGate {
  readonly qualified: boolean;
  readonly thresholds: typeof reliabilityLoadGateThresholds;
  readonly missingConcurrencies: readonly number[];
  readonly hardGates: readonly ReliabilityLoadHardGate[];
}

export function evaluateReliabilityLoadGate(
  summaries: readonly ReliabilityLoadSummary[],
): ReliabilityLoadGate {
  const byConcurrency = new Map<number, ReliabilityLoadSummary>();
  for (const summary of summaries) {
    if (byConcurrency.has(summary.concurrency)) {
      throw new Error("duplicate_reliability_load_concurrency");
    }
    if (!reliabilityLoadGateThresholds.requiredConcurrencies.includes(
      summary.concurrency as 1 | 2 | 4 | 10,
    )) {
      throw new Error("unexpected_reliability_load_concurrency");
    }
    byConcurrency.set(summary.concurrency, summary);
  }
  const missingConcurrencies = reliabilityLoadGateThresholds.requiredConcurrencies
    .filter((concurrency) => !byConcurrency.has(concurrency));
  const hardGates = reliabilityLoadGateThresholds.requiredConcurrencies
    .flatMap((concurrency): ReliabilityLoadHardGate[] => {
      const summary = byConcurrency.get(concurrency);
      if (summary === undefined) return [];
      return [
        minimumGate(
          `concurrency_${concurrency}.success_rate`,
          summary.successRate,
          reliabilityLoadGateThresholds.successRate,
        ),
        maximumGate(
          `concurrency_${concurrency}.p95_latency_ms`,
          summary.p95Ms,
          reliabilityLoadGateThresholds.p95Ms,
        ),
        maximumGate(
          `concurrency_${concurrency}.p99_latency_ms`,
          summary.p99Ms,
          reliabilityLoadGateThresholds.p99Ms,
        ),
      ];
    });
  return {
    qualified: missingConcurrencies.length === 0 &&
      hardGates.every((gate) => gate.passed),
    thresholds: reliabilityLoadGateThresholds,
    missingConcurrencies,
    hardGates,
  };
}

export function summarizeReliabilityLoad(
  concurrency: number,
  observations: readonly ReliabilityLoadObservation[],
): ReliabilityLoadSummary {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("invalid_load_concurrency");
  }
  if (observations.length === 0) throw new Error("empty_load_profile");
  const elapsed = observations.map((item) => item.elapsedMs);
  const queueElapsed = observations.flatMap((item) =>
    item.queueElapsedMs === undefined ? [] : [item.queueElapsedMs]);
  const failures = observations.filter((item) => item.failure !== undefined).length;
  const unavailable = observations.filter((item) =>
    item.status === "temporarily_unavailable").length;
  const successful = observations.filter((item) =>
    item.failure === undefined &&
    item.status !== undefined &&
    item.status !== "temporarily_unavailable" &&
    item.stopReason === "final"
  ).length;
  const stopReasons = Object.fromEntries(
    [...new Set(observations.map((item) => item.stopReason))]
      .sort()
      .map((reason) => [
        reason,
        observations.filter((item) => item.stopReason === reason).length,
      ]),
  );
  return {
    concurrency,
    total: observations.length,
    successful,
    unavailable,
    failures,
    successRate: successful / observations.length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    p99Ms: percentile(elapsed, 0.99),
    ...(queueElapsed.length === 0
      ? {}
      : { queueP95Ms: percentile(queueElapsed, 0.95) }),
    stopReasons,
  };
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index]!;
}

function minimumGate(
  id: string,
  observed: number,
  threshold: number,
): ReliabilityLoadHardGate {
  return {
    id,
    observed,
    comparison: "minimum",
    threshold,
    passed: observed >= threshold,
  };
}

function maximumGate(
  id: string,
  observed: number,
  threshold: number,
): ReliabilityLoadHardGate {
  return {
    id,
    observed,
    comparison: "maximum",
    threshold,
    passed: observed <= threshold,
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = value === undefined || value.trim() === ""
    ? fallback
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
