import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonlDiagnosticTraceFactory,
  recordDiagnostic,
  type DiagnosticTrace,
} from "./diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
  }
});

describe("development diagnostic trace", () => {
  it("writes only structured, bounded, redacted JSONL events under a temporary directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pseagent-diagnostics-test-"));
    temporaryDirectories.push(directory);
    const trace = new JsonlDiagnosticTraceFactory(directory).start();

    trace.record({ event: "route", scope: "professional" });
    trace.record({
      event: "question_resolution",
      mode: "contextual",
      contextUsed: true,
      entityCount: 4,
      correctionCount: 1,
    });
    trace.record({
      event: "task_spec",
      domainCount: 1,
      entityCount: 4,
      deliverableCount: 2,
      coverageUnitCount: 4,
      directUnitCount: 3,
      synthesisUnitCount: 1,
      customerInputUnitCount: 0,
    });
    trace.record({
      event: "task_spec_guard",
      ok: false,
      issueCodes: ["explicit_entity_unmapped"],
      explicitEntityCount: 3,
      mappedExplicitEntityCount: 2,
      explicitRequestCount: 2,
      mappedExplicitRequestCount: 2,
    });
    trace.record({
      event: "task_spec_shadow",
      result: "completed",
      elapsedMs: 12,
    });
    trace.record({
      event: "task_spec_activation",
      activated: true,
      reason: "activated",
      requirementCount: 3,
    });
    trace.record({
      event: "plan",
      requirementCount: 1,
      aspectCount: 1,
      queryCount: 2,
      directOnlyCount: 1,
      synthesisAllowedCount: 0,
    });
    trace.record({
      event: "model_payload",
      result: "rejected",
      reason: "invalid_schema:citations:invalid_type(expected=array)",
      repairAttempt: 1,
      schemaDescription: "pse_final_action",
      rawPayload: "{\"citations\":\"Bearer live-token\"}",
      rawPayloadLength: 37,
      finishReason: "length",
    });
    trace.record({
      event: "coverage",
      stage: "verified",
      requirements: [{
        id: "R1",
        evidenceMode: "synthesis_allowed",
        coverage: "complete",
        citations: [1, 2, 3],
        retainedDirectSegmentCount: 1,
        retainedSynthesizedSegmentCount: 2,
        removedSegmentCount: 1,
      }],
      reasons: [{ id: "R1", reason: "synthesized_support" }],
      citations: [1, 2, 3],
      stopReason: "final",
    });
    trace.record({
      event: "finish",
      scope: "professional",
      status: "answered",
      citationCount: 2,
      elapsedMs: 123,
      historicalAttempted: false,
      historicalUsed: false,
    });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0] ?? ""), "utf8");
    expect(content).not.toContain("secret-value");
    expect(content).not.toContain("session-value");
    expect(content).not.toContain("live-token");
    expect(content).not.toContain("demo-pass-2026");
    expect(content).toContain("[REDACTED]");
    const records = content.trim().split("\n").map((line) => JSON.parse(line) as {
      requestId: string;
      event: string;
      answer?: string;
    });
    expect(records.map((record) => record.event)).toEqual([
      "route",
      "question_resolution",
      "task_spec",
      "task_spec_guard",
      "task_spec_shadow",
      "task_spec_activation",
      "plan",
      "model_payload",
      "coverage",
      "finish",
    ]);
    expect(new Set(records.map((record) => record.requestId))).toEqual(new Set([trace.requestId]));
    expect(records.every((record) => record.answer === undefined)).toBe(true);
    expect(content).not.toContain("standaloneQuestion");
    expect(content).not.toContain("sourceText");
    const coverage = records.find((record) => record.event === "coverage");
    expect(coverage).toMatchObject({
      requirements: [{
        id: "R1",
        evidenceMode: "synthesis_allowed",
        coverage: "complete",
        citations: [1, 2, 3],
        retainedDirectSegmentCount: 1,
        retainedSynthesizedSegmentCount: 2,
        removedSegmentCount: 1,
      }],
    });
    expect(Object.keys(coverage ?? {}).sort()).toEqual([
      "citations",
      "event",
      "reasons",
      "requestId",
      "requirements",
      "stage",
      "stopReason",
      "timestamp",
    ]);
    expect(content.length).toBeLessThan(10_000);
  });

  it("never lets a diagnostic sink failure change the answer path", () => {
    const trace = {
      requestId: "test",
      record: vi.fn(() => {
        throw new Error("disk full");
      }),
    } satisfies DiagnosticTrace;

    expect(() => recordDiagnostic(trace, { event: "route", scope: "normal" })).not.toThrow();
  });
});
