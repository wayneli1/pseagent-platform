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
  type DiagnosticEvent,
  type DiagnosticTrace,
} from "./diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
  }
});

describe("development diagnostic trace", () => {
  it("writes only structured, bounded, allowlisted JSONL events under a temporary directory", () => {
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

  it("drops every non-allowlisted field even when a caller escapes the event type", () => {
    const directory = mkdtempSync(join(tmpdir(), "pseagent-diagnostics-canary-"));
    temporaryDirectories.push(directory);
    const trace = new JsonlDiagnosticTraceFactory(directory).start();
    const canaries = [
      "QUESTION_CANARY_8f0194",
      "ANSWER_CANARY_46cd37",
      "QUERY_CANARY_324b18",
      "PATH_CANARY_61fe24",
      "CONTENT_CANARY_239ab5",
      "TITLE_CANARY_77b2d1",
      "HEADING_CANARY_5b180f",
      "RELATION_CANARY_105caf",
      "RAW_PAYLOAD_CANARY_90e826",
      "SCHEMA_CANARY_faf542",
      "NESTED_CANARY_0ae795",
    ] as const;

    trace.record({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [{ id: "A1", candidateCount: 1, readCandidateCount: 0 }],
      question: canaries[0],
      answer: canaries[1],
      query: canaries[2],
      path: canaries[3],
      content: canaries[4],
      title: canaries[5],
      sectionHeadings: [canaries[6]],
      graphRelations: [canaries[7]],
      rawPayload: canaries[8],
      schemaDescription: canaries[9],
      payload: { nested: canaries[10] },
    } as unknown as DiagnosticEvent);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0] ?? ""), "utf8");
    for (const canary of canaries) expect(content).not.toContain(canary);
    expect(content).not.toMatch(
      /"(?:question|answer|query|path|content|title|sectionHeadings|graphRelations|rawPayload|schemaDescription|payload)"/u,
    );
    expect(JSON.parse(content)).toMatchObject({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [{ id: "A1", candidateCount: 1, readCandidateCount: 0 }],
    });
  });

  it("does not persist nested objects smuggled through allowlisted scalar slots", () => {
    const directory = mkdtempSync(join(tmpdir(), "pseagent-diagnostics-nested-canary-"));
    temporaryDirectories.push(directory);
    const trace = new JsonlDiagnosticTraceFactory(directory).start();
    const nestedCanary = "NESTED_CANARY_9b62fd";

    trace.record({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [{
        id: { question: nestedCanary },
        candidateCount: { content: nestedCanary },
        readCandidateCount: 0,
      }],
    } as unknown as DiagnosticEvent);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0] ?? ""), "utf8");
    expect(content).not.toContain(nestedCanary);
    expect(content).not.toMatch(/"(?:question|content)"/u);
    expect(JSON.parse(content)).toMatchObject({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [{ id: "UNKNOWN", candidateCount: 0, readCandidateCount: 0 }],
    });
  });

  it("downgrades illegal diagnostic identifiers and reasons without persisting them", () => {
    const directory = mkdtempSync(join(tmpdir(), "pseagent-diagnostics-string-canary-"));
    temporaryDirectories.push(directory);
    const trace = new JsonlDiagnosticTraceFactory(directory).start();
    const requirementCanary = "REQUIREMENT_CANARY_784bd1";
    const reasonCanary = "REASON_CANARY_d77e0a";
    const finishCanary = "FINISH_CANARY_33b979";

    trace.record({
      event: "candidates",
      requirementId: requirementCanary,
      source: "seed_search_result",
      candidateCount: 0,
      aspects: [],
    } as unknown as DiagnosticEvent);
    trace.record({
      event: "validation",
      result: "rejected",
      reason: reasonCanary,
      repairAttempt: 1,
    } as unknown as DiagnosticEvent);
    trace.record({
      event: "model_payload",
      result: "rejected",
      reason: reasonCanary,
      repairAttempt: 1,
      finishReason: finishCanary,
    } as unknown as DiagnosticEvent);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0] ?? ""), "utf8");
    expect(content).not.toContain(requirementCanary);
    expect(content).not.toContain(reasonCanary);
    expect(content).not.toContain(finishCanary);
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        event: "candidates",
        requirementId: "UNKNOWN",
      }),
      expect.objectContaining({
        event: "validation",
        reason: "unknown",
      }),
      expect.objectContaining({
        event: "model_payload",
        reason: "unknown",
        finishReason: "unknown",
      }),
    ]);
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
