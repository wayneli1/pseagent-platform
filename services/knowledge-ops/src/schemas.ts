import { z } from "zod";
import {
  answerReviewWorkflowStatusSchema,
  feedbackClassificationSchema,
  governanceReviewStatusSchema,
  knowledgeDomainSchema,
} from "@pseagent/knowledge-governance-contracts";

const isoTimestamp = z.string().datetime({ offset: true });

export const feedbackIntakeSchema = z.object({
  caseId: z.string().uuid(),
  requestId: z.string().uuid(),
  pseudonymousUserId: z.string().regex(/^[a-f0-9]{64}$/u),
  userDisplayName: z.string().trim().min(1).max(128).optional(),
  questionId: z.number().int().positive(),
  classification: feedbackClassificationSchema,
  comment: z.string().trim().max(4_000),
  proposedAnswer: z.string().trim().min(1).max(20_000).optional(),
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
}).strict().superRefine((value, context) => {
  if (value.classification === "correction" && value.proposedAnswer === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposedAnswer"],
      message: "correction_requires_proposed_answer",
    });
  }
  if (value.classification !== "correction" && value.proposedAnswer !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposedAnswer"],
      message: "proposed_answer_requires_correction",
    });
  }
});

const answerReviewReferenceSchema = z.object({
  index: z.number().int().positive().max(10_000),
  project: knowledgeDomainSchema,
  title: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(1_000).refine((value) =>
    value.startsWith("wiki/") &&
    value.endsWith(".md") &&
    !value.includes("\\") &&
    !value.split("/").includes(".."), "invalid_review_reference_path"),
  revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const answerReviewIntakeSchema = z.object({
  reviewId: z.string().uuid(),
  requestId: z.string().uuid(),
  pseudonymousUserId: z.string().regex(/^[a-f0-9]{64}$/u),
  userDisplayName: z.string().trim().min(1).max(128).optional(),
  questionId: z.number().int().positive(),
  question: z.string().trim().min(1).max(20_000),
  answer: z.string().trim().min(1).max(100_000),
  answerStatus: z.string().trim().min(1).max(100),
  scope: z.string().trim().max(500).optional(),
  references: z.array(answerReviewReferenceSchema).max(20),
  answeredAt: isoTimestamp,
  submittedAt: isoTimestamp,
  source: z.literal("lunkr_direct"),
  answerCardMatch: z.record(z.string(), z.unknown()).optional(),
  answerCardActivation: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.references.map((reference) => reference.index)).size !== value.references.length) {
    context.addIssue({ code: "custom", path: ["references"], message: "duplicate_review_reference_index" });
  }
});

export const answerReviewWorkflowPatchSchema = z.object({
  workflowStatus: answerReviewWorkflowStatusSchema,
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
export const feedbackPatchSchema = z.object({
  status: feedbackStatusSchema.optional(),
  classification: z.enum([
    "useful",
    "incorrect",
    "missing",
    "review_requested",
    "evidence",
    "correction",
  ]).optional(),
}).strict().refine((value) => value.status !== undefined || value.classification !== undefined, {
  message: "feedback_patch_empty",
});
export const cardStatusSchema = governanceReviewStatusSchema;

export const issuePrioritySchema=z.enum(["p0","p1","p2","p3"]);
export const issueStatusSchema=z.enum(["open","in_progress","validating","resolved","dismissed"]);
export const issueListQuerySchema=z.object({
  status:issueStatusSchema.optional(),priority:issuePrioritySchema.optional(),
  actionable:z.enum(["true","false"]).transform((value)=>value==="true").optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0),
}).strict();
export const issuePatchSchema=z.object({status:z.enum(["open","dismissed"])}).strict();

export const repairTargetKindSchema=z.enum(["answer_card","knowledge_page","retrieval_rule","system_fix"]);
export const repairRegressionKindSchema=z.enum(["canonical","alias","typo","follow_up","negative"]);
const repairPathSchema=z.string().trim().min(1).max(1_000).refine((value)=>
  /^(?:wiki\/(?:queries|concepts)\/[\p{L}\p{N}_.\- ()（）]+\.md|governance\/(?:question-families|regression)\/[A-Za-z0-9_.-]+\.json)$/u.test(value)&&
  !value.includes("\\")&&!value.split("/").includes(".."),"invalid_repair_target_path");
const repairEvidencePathSchema=z.string().trim().min(1).max(1_000).refine((value)=>
  value.startsWith("wiki/")&&value.endsWith(".md")&&!value.includes("\\")&&!value.split("/").includes(".."),"invalid_repair_evidence_path");
const repairObligationSchema=z.object({
  id:z.string().regex(/^O\d+$/u),label:z.string().trim().min(1).max(500),
  evidencePolicy:z.enum(["direct","synthesis","customer_input"]),
  requiredConcepts:z.array(z.string().trim().min(1).max(200)).max(50),
  forbiddenClaims:z.array(z.string().trim().min(1).max(500)).max(50),
  preferredEvidencePaths:z.array(repairEvidencePathSchema).max(20),
}).strict();
export const repairProposalSchema=z.object({
  rootCause:z.enum(["knowledge_gap","retrieval_gap","planning_gap","coverage_gap","logic_gap","citation_gap","expression_gap","user_incorrect","user_missing","review_requested","evidence","correction","judgement_conflict","review_error"]),
  targetKind:repairTargetKindSchema,targetDomain:knowledgeDomainSchema.optional(),targetPath:repairPathSchema.optional(),
  cardId:z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u).optional(),title:z.string().trim().min(1).max(500),
  canonicalQuestion:z.string().trim().max(1_000),aliases:z.array(z.string().trim().min(1).max(1_000)).max(100),
  answerTemplate:z.string().trim().max(100_000),obligations:z.array(repairObligationSchema).max(12),
  regressionQuestions:z.array(z.object({kind:repairRegressionKindSchema,question:z.string().trim().min(1).max(2_000)}).strict()).max(5),
  generationSummary:z.string().trim().min(1).max(4_000),publishable:z.boolean(),blockingReason:z.string().trim().min(1).max(4_000).optional(),
}).strict().superRefine((value,context)=>{
  if(value.publishable){
    if(value.targetKind==="system_fix")context.addIssue({code:"custom",path:["targetKind"],message:"system_fix_cannot_be_published_as_knowledge"});
    if(value.targetDomain===undefined)context.addIssue({code:"custom",path:["targetDomain"],message:"publishable_repair_requires_target_domain"});
    if(value.targetPath===undefined)context.addIssue({code:"custom",path:["targetPath"],message:"publishable_repair_requires_target_path"});
    if(value.targetKind==="answer_card"&&value.cardId===undefined)context.addIssue({code:"custom",path:["cardId"],message:"answer_card_repair_requires_card_id"});
    if(value.canonicalQuestion==="")context.addIssue({code:"custom",path:["canonicalQuestion"],message:"publishable_repair_requires_canonical_question"});
    if(value.answerTemplate==="")context.addIssue({code:"custom",path:["answerTemplate"],message:"publishable_repair_requires_answer_template"});
    if(value.obligations.length===0)context.addIssue({code:"custom",path:["obligations"],message:"publishable_repair_requires_obligations"});
    const kinds=new Set(value.regressionQuestions.map((item)=>item.kind));
    if(value.regressionQuestions.length!==5||repairRegressionKindSchema.options.some((kind)=>!kinds.has(kind)))context.addIssue({code:"custom",path:["regressionQuestions"],message:"repair_requires_five_regression_kinds"});
  }else if(value.blockingReason===undefined)context.addIssue({code:"custom",path:["blockingReason"],message:"non_publishable_repair_requires_reason"});
});
export const repairDraftUpdateSchema=z.object({proposal:repairProposalSchema}).strict();
export const emptyActionSchema=z.object({}).strict();

const qualityBucketSchema = z.object({
  passed: z.boolean(),
  passedCases: z.number().int().min(0).max(20),
  averageScore: z.number().min(0).max(1),
}).passthrough();

export const releaseQualityReportImportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoTimestamp,
  model: z.literal("deepseek_v4_flash"),
  passed: z.boolean(),
  summary: z.object({
    total: z.literal(20),
    completed: z.number().int().min(0).max(20),
    passedCases: z.number().int().min(0).max(20),
    averageScore: z.number().min(0).max(1),
    p95LatencyMs: z.number().int().min(0),
    safetyFailures: z.number().int().min(0),
    availabilityFailures: z.number().int().min(0),
  }).strict(),
  suites: z.array(qualityBucketSchema.extend({ suiteId: z.string().trim().min(1) })).length(4),
  kinds: z.array(qualityBucketSchema.extend({ kind: z.string().trim().min(1) })).length(5),
  consistencyChecks: z.array(z.record(z.string(), z.unknown())),
  cases: z.array(z.record(z.string(), z.unknown())).length(20),
}).strict().superRefine((report, context) => {
  if (report.passed !== (
    report.summary.completed === 20 &&
    report.summary.passedCases === 20 &&
    report.summary.safetyFailures === 0 &&
    report.summary.availabilityFailures === 0 &&
    report.suites.every((item) => item.passed) &&
    report.kinds.every((item) => item.passed)
  )) context.addIssue({ code: "custom", path: ["passed"], message: "quality_gate_summary_inconsistent" });
});
