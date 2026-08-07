import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type { FeedbackAnswerCardSummary } from "./feedback-receipt-store.js";

export interface BridgeReviewReference {
  readonly index: number;
  readonly project: KnowledgeDomain;
  readonly title: string;
  readonly path: string;
  readonly revision: string;
  readonly contentHash: string;
}

export interface BridgeAnswerCardActivationSummary {
  readonly activated: boolean;
  readonly reason: string;
  readonly obligationCount: number;
  readonly issueCodes?: readonly string[];
}

export interface BridgeAnswerReviewSubmission {
  readonly reviewId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly userDisplayName?: string;
  readonly questionId: number;
  readonly question: string;
  readonly answer: string;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly references: readonly BridgeReviewReference[];
  readonly answeredAt: string;
  readonly submittedAt: string;
  readonly source: "lunkr_direct";
  readonly answerCardMatch?: FeedbackAnswerCardSummary;
  readonly answerCardActivation?: BridgeAnswerCardActivationSummary;
}
