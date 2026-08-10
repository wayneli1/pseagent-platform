import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ModelCallMetrics,
  ModelCallMetricsReporter,
} from "./model-client.js";

const modelMetricsReporter = new AsyncLocalStorage<ModelCallMetricsReporter>();

export function withModelMetricsReporter<T>(
  reporter: ModelCallMetricsReporter,
  call: () => Promise<T>,
): Promise<T> {
  return modelMetricsReporter.run(reporter, call);
}

export function reportModelCallMetrics(metrics: ModelCallMetrics): void {
  try {
    modelMetricsReporter.getStore()?.(metrics);
  } catch {
    // Request diagnostics are best effort and never affect model execution.
  }
}
