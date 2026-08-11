import { describe, expect, it } from "vitest";
import type { DiagnosticEvent } from "../apps/pseagent/src/diagnostics.ts";
import {
  ReliabilityDiagnosticCollector,
  summarizeReliabilityDiagnostics,
} from "./reliability-diagnostics.ts";

describe("reliability diagnostics", () => {
  it("summarizes content-free absolute stage budget outcomes", () => {
    const events: DiagnosticEvent[] = [{
      event: "stage_budget",
      stage: "obligation_compile",
      result: "timeout",
      elapsedMs: 25_000,
      remainingMs: 0,
    }];

    const summary = summarizeReliabilityDiagnostics(events);

    expect(summary.stages).toEqual([{
      stage: "obligation_compile",
      result: "timeout",
      elapsedMs: 25_000,
      remainingMs: 0,
    }]);
    expect(JSON.stringify(summary.stages)).not.toContain("question");
    expect(JSON.stringify(summary.stages)).not.toContain("evidence");
  });

  it("retains the inner domain root cause without content", () => {
    const events: DiagnosticEvent[] = [
      {
        event: "model_call",
        role: "synthesizer",
        operation: "synthesize",
        outcome: "failed",
        elapsedMs: 123,
        attemptCount: 4,
        queueElapsedMs: 10,
        executionElapsedMs: 100,
        errorClass: "unavailable",
      },
      { event: "stop", reason: "model_unavailable" },
      {
        event: "domain_execution",
        domain: "coremail-professional",
        phase: "agent",
        result: "unavailable",
        domainCount: 1,
        domainsUsed: ["coremail-professional"],
        reason: "agent_unavailable",
        rootReason: "model_unavailable",
      },
      { event: "stop", reason: "domain_execution_unavailable" },
    ];

    expect(summarizeReliabilityDiagnostics(events)).toMatchObject({
      rootStopReason: "model_unavailable",
      finalStopReason: "domain_execution_unavailable",
      stopReasons: ["model_unavailable", "domain_execution_unavailable"],
      model: {
        callCount: 1,
        failedCallCount: 1,
        attemptCount: 4,
        queueElapsedMs: 10,
        executionElapsedMs: 100,
      },
      domains: [{
        domain: "coremail-professional",
        phase: "agent",
        result: "unavailable",
        reason: "agent_unavailable",
        rootReason: "model_unavailable",
      }],
    });
  });

  it("aggregates content-free retrieval and coverage counters", () => {
    const events: DiagnosticEvent[] = [
      {
        event: "search",
        requirementId: "R1",
        phase: "seed",
        queryChars: 8,
        aspectIds: ["A1"],
      },
      {
        event: "candidates",
        requirementId: "R1",
        source: "seed_search_result",
        candidateCount: 3,
        aspects: [{ id: "A1", candidateCount: 3, readCandidateCount: 1 }],
      },
      {
        event: "read",
        requirementId: "R1",
        citation: 1,
        sectionHeadingCount: 2,
        aspectIds: ["A1"],
      },
      {
        event: "coverage",
        stage: "verified",
        requirements: [{
          id: "R1",
          evidenceMode: "direct_only",
          coverage: "partial",
          citations: [1],
          candidateCount: 3,
          readCandidateCount: 1,
          unreadCandidateCount: 2,
          remainingReads: 1,
          seedSearchStatus: "success",
          retainedDirectSegmentCount: 1,
          retainedSynthesizedSegmentCount: 0,
          removedSegmentCount: 2,
          coveredAspectCount: 1,
          missingAspectCount: 1,
        }],
        reasons: [{ id: "R1", reason: "partial_support" }],
        citations: [1],
        stopReason: "final",
      },
      {
        event: "coverage_gaps",
        domainCount: 1,
        gapCount: 1,
        gaps: [{
          domain: "coremail-professional",
          gapClass: "retrieval",
          reason: "candidate_not_read",
          affectsConclusion: true,
        }],
      },
      {
        event: "coverage_gate",
        disposition: "semantic_required",
        risk: "high",
        reasons: ["compatibility"],
        missingInputCount: 0,
        knowledgeMissingCount: 1,
      },
      {
        event: "validation",
        result: "rejected",
        reason: "evidence_metadata_invalid:verification_aspect_partition_invalid",
        repairAttempt: 2,
      },
      {
        event: "model_payload",
        result: "rejected",
        reason: "invalid_schema:answer",
        repairAttempt: 1,
        finishReason: "stop",
      },
      {
        event: "final_guard",
        result: "rejected",
        reason: "direct_answer_missing",
        repairAttempt: 1,
      },
    ];

    expect(summarizeReliabilityDiagnostics(events)).toMatchObject({
      retrieval: {
        seedSearchCount: 1,
        candidateEventCount: 1,
        candidateCount: 3,
        readCount: 1,
        unreadCandidateCount: 2,
        remainingReads: 1,
      },
      coverage: {
        verifiedRequirementCount: 1,
        incompleteVerifiedRequirementCount: 1,
        requirements: [{
          id: "R1",
          coverage: "partial",
          reason: "partial_support",
          candidateCount: 3,
          readCandidateCount: 1,
          unreadCandidateCount: 2,
          remainingReads: 1,
          seedSearchStatus: "success",
          retainedDirectSegmentCount: 1,
          retainedSynthesizedSegmentCount: 0,
          removedSegmentCount: 2,
          coveredAspectCount: 1,
          missingAspectCount: 1,
        }],
        gapCount: 1,
        gates: [{
          disposition: "semantic_required",
          risk: "high",
          reasons: ["compatibility"],
          knowledgeMissingCount: 1,
        }],
      },
      validation: {
        rejectedCount: 1,
        payloadRejectedCount: 1,
        finalGuardRejectedCount: 1,
        rejected: [{
          reason: "evidence_metadata_invalid",
          detail: "verification_aspect_partition_invalid",
          repairAttempt: 2,
        }],
        payloadRejected: [{
          reason: "invalid_schema",
          repairAttempt: 1,
          finishReason: "stop",
        }],
        finalGuardRejected: [{
          reason: "direct_answer_missing",
          repairAttempt: 1,
        }],
      },
    });
  });

  it("retains content-free task routing and activation diagnostics", () => {
    const events: DiagnosticEvent[] = [
      {
        event: "task_spec",
        domainCount: 2,
        entityCount: 1,
        deliverableCount: 1,
        coverageUnitCount: 2,
        directUnitCount: 1,
        synthesisUnitCount: 1,
        customerInputUnitCount: 0,
      },
      {
        event: "task_spec_guard",
        ok: false,
        issueCodes: ["explicit_request_unmapped"],
        explicitEntityCount: 1,
        mappedExplicitEntityCount: 1,
        explicitRequestCount: 2,
        mappedExplicitRequestCount: 1,
      },
      {
        event: "task_spec_activation",
        activated: false,
        reason: "guard_rejected",
        requirementCount: 0,
      },
    ];

    expect(summarizeReliabilityDiagnostics(events).task).toEqual({
      domainCount: 2,
      coverageUnitCount: 2,
      guardOk: false,
      guardIssueCodes: ["explicit_request_unmapped"],
      activation: {
        activated: false,
        reason: "guard_rejected",
        requirementCount: 0,
      },
    });
  });

  it("removes completed requests from the collector", () => {
    const collector = new ReliabilityDiagnosticCollector();
    const trace = collector.start();
    trace.record({ event: "stop", reason: "invalid_final" });
    expect(collector.pendingCount()).toBe(1);
    expect(collector.take(trace.requestId).rootStopReason).toBe("invalid_final");
    expect(collector.pendingCount()).toBe(0);
  });
});
