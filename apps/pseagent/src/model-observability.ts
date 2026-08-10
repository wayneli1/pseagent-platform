import {
  recordDiagnostic,
  recordDiagnosticProgress,
  type DiagnosticTrace,
} from "./diagnostics.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelCallMetrics,
  type ModelCallMetricsReporter,
  type ModelRole,
} from "./model-client.js";
import { withModelMetricsReporter } from "./model-metrics-context.js";

type ModelOperation = Extract<
  Parameters<DiagnosticTrace["record"]>[0],
  { event: "model_call" }
>["operation"];
type ModelErrorClass = NonNullable<Extract<
  Parameters<DiagnosticTrace["record"]>[0],
  { event: "model_call" }
>["errorClass"]>;

export async function observeModelCall<T>(input: {
  readonly trace?: DiagnosticTrace | undefined;
  readonly role: ModelRole;
  readonly operation: ModelOperation;
  readonly signal?: AbortSignal;
  readonly call: (reportMetrics: ModelCallMetricsReporter) => Promise<T>;
}): Promise<T> {
  recordDiagnosticProgress(input.trace, {
    event: "model_call_started",
    role: input.role,
    operation: input.operation,
  });
  const startedAt = Date.now();
  let metrics: ModelCallMetrics | undefined;
  const reportMetrics: ModelCallMetricsReporter = (reported) => {
    metrics = reported;
  };
  try {
    const result = await withModelMetricsReporter(
      reportMetrics,
      () => input.call(reportMetrics),
    );
    recordDiagnostic(input.trace, {
      event: "model_call",
      role: input.role,
      operation: input.operation,
      outcome: "completed",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...(metrics === undefined ? {} : metrics),
    });
    return result;
  } catch (error) {
    recordDiagnostic(input.trace, {
      event: "model_call",
      role: input.role,
      operation: input.operation,
      outcome: "failed",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      errorClass: classifyModelError(error, input.signal),
      ...(metrics === undefined ? {} : metrics),
    });
    throw error;
  }
}

function classifyModelError(
  error: unknown,
  signal: AbortSignal | undefined,
): ModelErrorClass {
  if (signal?.aborted === true) return "aborted";
  if (error instanceof InvalidModelPayloadError) {
    if (error.code === "invalid_json") return "invalid_json";
    if (error.code.startsWith("invalid_schema:")) return "invalid_schema";
    return "invalid_payload";
  }
  if (error instanceof ModelUnavailableError) return "unavailable";
  return "unexpected";
}
