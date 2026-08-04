import { z } from "zod";
import {
  feedbackClassificationSchema,
  governanceReviewStatusSchema,
  knowledgeDomainSchema,
} from "@pseagent/knowledge-governance-contracts";

const isoTimestamp = z.string().datetime({ offset: true });

export const feedbackIntakeSchema = z.object({
  caseId: z.string().uuid(),
  requestId: z.string().uuid(),
  pseudonymousUserId: z.string().regex(/^[a-f0-9]{64}$/u),
  questionId: z.number().int().positive(),
  classification: feedbackClassificationSchema,
  comment: z.string().trim().max(4_000),
  question: z.string().trim().min(1).max(20_000),
  answer: z.string().trim().min(1).max(100_000),
  answerStatus: z.string().trim().min(1).max(100),
  scope: z.string().trim().max(500).optional(),
  referenceCount: z.number().int().min(0).max(10_000),
  answeredAt: isoTimestamp,
  submittedAt: isoTimestamp,
  source: z.literal("lunkr_direct"),
  answerCardMatch: z.record(z.string(), z.unknown()).optional(),
  audit: z.object({ event: z.literal("feedback_submitted") }).optional(),
}).strict();

export const cardRevisionInputSchema = z.object({
  domain: knowledgeDomainSchema,
  content: z.record(z.string(), z.unknown()),
  baseGitRevision: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

export const reviewInputSchema = z.object({
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  comment: z.string().trim().max(4_000).default(""),
}).strict();

export const feedbackStatusSchema = z.enum(["new", "triaged", "in_review", "resolved", "rejected"]);
export const cardStatusSchema = governanceReviewStatusSchema;
