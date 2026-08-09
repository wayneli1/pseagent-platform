import type { FeedbackClassification } from "@pseagent/knowledge-governance-contracts";

export function passingReviewConflictsWithFeedback(input: {
  readonly classification: FeedbackClassification;
  readonly answerStatus: string;
}): boolean {
  return !(
    input.classification === "missing" &&
    ["not_covered", "partially_answered"].includes(input.answerStatus)
  );
}
