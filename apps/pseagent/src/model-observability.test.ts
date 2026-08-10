import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiagnosticEvent,
  DiagnosticProgressEvent,
  DiagnosticTrace,
} from "./diagnostics.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  OpenAiCompatibleModelClient,
} from "./model-client.js";
import { observeModelCall } from "./model-observability.js";

afterEach(() => vi.unstubAllGlobals());

function trace(events: DiagnosticEvent[]): DiagnosticTrace {
  return {
    requestId: "model-observability-test",
    record(event) { events.push(event); },
  };
}

describe("model role observability", () => {
  it("records only role, operation, outcome, and bounded latency on success", async () => {
    const events: DiagnosticEvent[] = [];
    const progress: DiagnosticProgressEvent[] = [];
    await expect(observeModelCall({
      trace: {
        ...trace(events),
        progress(event) { progress.push(event); },
      },
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
    expect(progress).toEqual([{
      event: "model_call_started",
      role: "planner",
      operation: "plan",
    }]);
  });

  it("keeps model execution available when a progress observer fails", async () => {
    const call = vi.fn(async () => "answer");
    await expect(observeModelCall({
      trace: {
        ...trace([]),
        progress() { throw new Error("progress unavailable"); },
      },
      role: "synthesizer",
      operation: "normal_answer",
      call,
    })).resolves.toBe("answer");
    expect(call).toHaveBeenCalledOnce();
  });

  it("records content-free scheduler and transport metrics", async () => {
    const events: DiagnosticEvent[] = [];
    await observeModelCall({
      trace: trace(events),
      role: "resolver",
      operation: "route",
      call: async (reportMetrics) => {
        reportMetrics({
          attemptCount: 2,
          queueElapsedMs: 17,
          executionElapsedMs: 43,
        });
        return "professional";
      },
    });

    expect(events).toEqual([expect.objectContaining({
      event: "model_call",
      attemptCount: 2,
      queueElapsedMs: 17,
      executionElapsedMs: 43,
    })]);
  });

  it("collects metrics from a nested model client without plumbing callbacks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: "professional" } }],
    })));
    const model = new OpenAiCompatibleModelClient({
      baseUrl: "https://model.example/v1",
      apiKey: "secret",
      model: "model",
      timeoutMs: 1_000,
      maxTokens: 1_024,
    });
    const events: DiagnosticEvent[] = [];

    await observeModelCall({
      trace: trace(events),
      role: "resolver",
      operation: "route",
      call: async () => model.completeText({ messages: [] }),
    });

    expect(events).toEqual([expect.objectContaining({
      attemptCount: 1,
      queueElapsedMs: expect.any(Number),
      executionElapsedMs: expect.any(Number),
    })]);
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
