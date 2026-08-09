import { describe, expect, it } from "vitest";
import { passingReviewConflictsWithFeedback } from "./feedback-review-alignment.js";

describe("passingReviewConflictsWithFeedback", () => {
  it.each(["not_covered", "partially_answered"])(
    "treats missing feedback on a %s answer as an aligned knowledge gap",
    (answerStatus) => {
      expect(passingReviewConflictsWithFeedback({
        classification: "missing",
        answerStatus,
      })).toBe(false);
    },
  );

  it("keeps a pass versus a claimed-missing complete answer as a judgement conflict", () => {
    expect(passingReviewConflictsWithFeedback({
      classification: "missing",
      answerStatus: "answered",
    })).toBe(true);
  });
});
