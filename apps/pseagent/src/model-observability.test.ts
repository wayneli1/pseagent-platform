import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
} from "./model-client.js";
import { observeModelCall } from "./model-observability.js";

function trace(events: DiagnosticEvent[]): DiagnosticTrace {
  return {
    requestId: "model-observability-test",
    record(event) { events.push(event); },
  };
}

describe("model role observability", () => {
  it("records only role, operation, outcome, and bounded latency on success", async () => {
    const events: DiagnosticEvent[] = [];
    await expect(observeModelCall({
      trace: trace(events),
      role: "planner",
      operation: "plan",
      call: vi.fn(async () => ({ privateAnswer: "must-not-be-recorded" })),
    })).resolves.toEqual({ privateAnswer: "must-not-be-recorded" });

    expect(events).toEqual([expect.objectContaining({
      event: "model_call",
      role: "planner",
      operation: "plan",
      outcome: "completed",
      elapsedMs: expect.any(Number),
    })]);
    expect(JSON.stringify(events)).not.toContain("privateAnswer");
  });

  it.each([
    [new InvalidModelPayloadError("invalid_json", "RAW_OUTPUT_CANARY"), "invalid_json"],
    [new InvalidModelPayloadError("invalid_schema:root", "RAW_OUTPUT_CANARY"), "invalid_schema"],
    [new ModelUnavailableError("model_unavailable_503"), "unavailable"],
    [new Error("UNEXPECTED_CANARY"), "unexpected"],
  ] as const)("classifies failures without recording error content", async (error, errorClass) => {
    const events: DiagnosticEvent[] = [];
    await expect(observeModelCall({
      trace: trace(events),
      role: "verifier",
      operation: "verify",
      call: async () => { throw error; },
    })).rejects.toBe(error);

    expect(events).toEqual([expect.objectContaining({
      event: "model_call",
      role: "verifier",
      operation: "verify",
      outcome: "failed",
      errorClass,
    })]);
    expect(JSON.stringify(events)).not.toMatch(/RAW_OUTPUT_CANARY|UNEXPECTED_CANARY|503/u);
  });
});
