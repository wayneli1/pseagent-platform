import { describe, expect, it, vi } from "vitest";
import { AnswerProgressTracker } from "./answer-progress.js";

describe("AnswerProgressTracker", () => {
  it("derives cumulative content-free progress from diagnostic milestones", () => {
    const observer = vi.fn();
    const tracker = new AnswerProgressTracker(observer);

    tracker.record({
      event: "plan",
      requirementCount: 4,
      aspectCount: 6,
      queryCount: 4,
      directOnlyCount: 3,
      synthesisAllowedCount: 1,
    });
    tracker.record({
      event: "candidates",
      requirementId: "R1",
      source: "seed_search_result",
      candidateCount: 2,
      aspects: [],
    });
    tracker.record({
      event: "candidates",
      requirementId: "R2",
      source: "seed_search_result",
      candidateCount: 1,
      aspects: [],
    });
    tracker.record({
      event: "read",
      requirementId: "R1",
      citation: 1,
      sectionHeadingCount: 2,
      aspectIds: ["A1"],
    });
    tracker.recordProgress({
      event: "model_call_started",
      role: "synthesizer",
      operation: "synthesize",
    });
    tracker.record({
      event: "coverage",
      stage: "verified",
      requirements: [
        requirement("R1", "complete"),
        requirement("R2", "partial"),
        requirement("R3", "complete"),
        requirement("R4", "none"),
      ],
      citations: [1],
      stopReason: "final",
    });

    expect(observer).toHaveBeenNthCalledWith(1, { stage: "understanding" });
    expect(observer).toHaveBeenLastCalledWith({
      stage: "verifying",
      requirementCount: 4,
      retrievalCompletedCount: 2,
      evidenceReadCount: 1,
      coveredRequirementCount: 3,
      coverageRequirementCount: 4,
    });
    expect(JSON.stringify(observer.mock.calls)).not.toMatch(
      /question|answer|query|path|body/iu,
    );
  });

  it("keeps stages monotonic when parallel domain events interleave", () => {
    const snapshots: Array<{ readonly stage: string }> = [];
    const tracker = new AnswerProgressTracker((snapshot) => snapshots.push(snapshot));

    tracker.recordProgress({
      event: "model_call_started",
      role: "synthesizer",
      operation: "synthesize",
    });
    tracker.record({
      event: "search",
      requirementId: "R1",
      phase: "supplemental",
      queryChars: 12,
      aspectIds: ["A1"],
    });

    expect(snapshots.at(-1)?.stage).toBe("composing");
  });

  it("isolates observer failures from progress production", () => {
    const tracker = new AnswerProgressTracker(() => {
      throw new Error("observer failed");
    });

    expect(() => tracker.record({
      event: "route",
      scope: "professional",
    })).not.toThrow();
  });
});

function requirement(
  id: string,
  coverage: "complete" | "partial" | "none",
) {
  return {
    id,
    evidenceMode: "direct_only" as const,
    coverage,
    citations: coverage === "none" ? [] : [1],
  };
}
