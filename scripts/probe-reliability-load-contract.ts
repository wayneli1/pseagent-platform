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

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
