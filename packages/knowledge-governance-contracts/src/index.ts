import { z } from "zod";

export const knowledgeDomainSchema = z.enum([
  "coremail-professional",
  "presales-general",
]);

export const governanceReviewStatusSchema = z.enum([
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "release_ready",
  "released",
  "stale",
  "deprecated",
]);

export const answerCardMatchTypeSchema = z.enum([
  "exact",
  "family",
  "partial",
  "none",
]);

export const answerCardObligationSchema = z.object({
  id: z.string().regex(/^O\d+$/u),
  label: z.string().trim().min(1).max(200),
  required: z.boolean().default(true),
  domains: z.array(knowledgeDomainSchema).min(1).max(2),
  evidencePolicy: z.enum(["direct", "synthesis", "customer_input"]),
  requiredConcepts: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  forbiddenClaims: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  preferredEvidencePaths: z.array(
    z.string().regex(/^wiki\/[\p{L}\p{N}_.\-/ ()（）]+\.md$/u),
  ).max(20).default([]),
}).strict();

export const answerCardApplicabilitySchema = z.object({
  products: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  versions: z.array(z.string().trim().min(1).max(100)).max(20).default(["*"]),
  scenarios: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  excludeWhen: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
}).strict();

export const answerCardSchema = z.object({
  cardSchemaVersion: z.literal(1),
  cardId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u),
  domain: knowledgeDomainSchema,
  title: z.string().trim().min(1).max(200),
  canonicalQuestion: z.string().trim().min(1).max(1_000),
  questionFamily: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u),
  aliases: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  applicability: answerCardApplicabilitySchema,
  obligations: z.array(answerCardObligationSchema).min(1).max(12),
  answerTemplate: z.string().trim().max(20_000).default(""),
  owner: z.string().trim().min(1).max(200),
  reviewers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  reviewStatus: governanceReviewStatusSchema,
  reviewDue: z.string().date().optional(),
  regressionCaseIds: z.array(
    z.string().regex(/^RC-[A-Z0-9-]{3,80}$/u),
  ).max(100).default([]),
}).strict().superRefine((card, context) => {
  for (const obligation of card.obligations) {
    if (!obligation.domains.includes(card.domain)) {
      context.addIssue({
        code: "custom",
        path: ["obligations", card.obligations.indexOf(obligation), "domains"],
        message: "domain_card_obligation_must_include_card_domain",
      });
    }
  }
});

export const questionFamilyBindingSchema = z.object({
  obligationId: z.string().regex(/^O\d+$/u),
  label: z.string().trim().min(1).max(200),
  domain: knowledgeDomainSchema,
  cardId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u),
  required: z.boolean().default(true),
}).strict();

export const questionFamilySchema = z.object({
  schemaVersion: z.literal(1),
  familyId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u),
  title: z.string().trim().min(1).max(200),
  canonicalQuestion: z.string().trim().min(1).max(1_000),
  aliases: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  bindings: z.array(questionFamilyBindingSchema).min(1).max(12),
  reviewStatus: governanceReviewStatusSchema,
}).strict();

export const feedbackClassificationSchema = z.enum([
  "useful",
  "incorrect",
  "missing",
  "evidence",
]);

export const feedbackCaseSchema = z.object({
  caseId: z.string().uuid(),
  requestId: z.string().uuid(),
  pseudonymousUserId: z.string().regex(/^[a-f0-9]{64}$/u),
  classification: feedbackClassificationSchema,
  comment: z.string().trim().max(4_000).default(""),
  status: z.enum(["new", "triaged", "in_review", "resolved", "rejected"]),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const approvalSchema = z.object({
  approvalId: z.string().uuid(),
  cardId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u),
  cardRevision: z.number().int().positive(),
  domain: knowledgeDomainSchema,
  reviewerId: z.string().trim().min(1).max(200),
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  comment: z.string().trim().max(4_000).default(""),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const regressionCaseSchema = z.object({
  caseId: z.string().regex(/^RC-[A-Z0-9-]{3,80}$/u),
  question: z.string().trim().min(1).max(2_000),
  expectedCardId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u).optional(),
  expectedDomains: z.array(knowledgeDomainSchema).max(2),
  requiredObligationIds: z.array(z.string().regex(/^O\d+$/u)).max(12),
  forbiddenClaims: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  kind: z.enum(["canonical", "alias", "typo", "follow_up", "negative", "stale"]),
}).strict();

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^KR-\d{4}-\d{2}-[A-Z0-9-]{3,40}$/u),
  professionalRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  generalRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  answerContractRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  cardCatalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
  regressionRunId: z.string().uuid(),
  approvedBy: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type KnowledgeDomain = z.infer<typeof knowledgeDomainSchema>;
export type GovernanceReviewStatus = z.infer<typeof governanceReviewStatusSchema>;
export type AnswerCard = z.infer<typeof answerCardSchema>;
export type AnswerCardObligation = z.infer<typeof answerCardObligationSchema>;
export type QuestionFamily = z.infer<typeof questionFamilySchema>;
export type FeedbackClassification = z.infer<typeof feedbackClassificationSchema>;
export type FeedbackCase = z.infer<typeof feedbackCaseSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type RegressionCase = z.infer<typeof regressionCaseSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
