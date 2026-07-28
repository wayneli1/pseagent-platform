import { z } from "zod";

export const scopeSchema = z.enum(["professional", "general", "normal"]);
export const answerStatusSchema = z.enum(["answered", "partially_answered", "not_covered", "temporarily_unavailable"]);
export const coverageSchema = z.enum(["complete", "partial", "none"]);
export const routeActionSchema = z.object({ action: z.literal("route"), scope: scopeSchema }).strict();
export const knowledgeRequirementIdSchema = z.string().regex(/^R[1-6]$/u);
export const knowledgeRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  question: z.string().trim().min(1).max(1_024),
  queries: z.array(z.string().trim().min(1).max(1_024)).min(1).max(3),
}).strict().superRefine((requirement, context) => {
  const normalizedQueries = requirement.queries.map((query) =>
    query.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim());
  if (new Set(normalizedQueries).size !== normalizedQueries.length) {
    context.addIssue({
      code: "custom",
      path: ["queries"],
      message: "duplicate_queries",
    });
  }
  if (looksLikeOpaqueKnowledgeIdentifier(requirement.queries[0] ?? "")) {
    context.addIssue({
      code: "custom",
      path: ["queries", 0],
      message: "primary_query_must_be_semantic",
    });
  }
});
export const knowledgePlanSchema = z.object({
  subject: z.string().trim().min(1).max(1_024),
  requirements: z.array(knowledgeRequirementSchema).min(1).max(6),
}).strict().superRefine((plan, context) => {
  const ids = plan.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["requirements"],
      message: "duplicate_requirement_ids",
    });
  }
  plan.requirements.forEach((requirement, index) => {
    if (requirement.id !== `R${index + 1}`) {
      context.addIssue({
        code: "custom",
        path: ["requirements", index, "id"],
        message: "requirement_ids_must_be_sequential",
      });
    }
  });
});
const searchActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.search"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    query: z.string().trim().min(1).max(16_384),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict(),
}).strict();
const readActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.read_page"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    path: z.string().trim().min(1).max(1_024),
  }).strict(),
}).strict();
const readPagesActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.read_pages"),
  input: z.object({
    pages: z.array(z.object({
      requirementId: knowledgeRequirementIdSchema,
      path: z.string().trim().min(1).max(1_024),
    }).strict()).min(1).max(12),
}).strict(),
}).strict().superRefine((action, context) => {
  const keys = action.input.pages.map((page) => `${page.requirementId}\u0000${page.path}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["input", "pages"],
      message: "batch_read_requires_distinct_requirement_paths",
    });
  }
});
const graphActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.graph"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    path: z.string().trim().min(1).max(1_024),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict(),
}).strict();
export const toolActionSchema = z.discriminatedUnion("tool", [
  searchActionSchema,
  readActionSchema,
  readPagesActionSchema,
  graphActionSchema,
]);
export const requirementCoverageSchema = z.object({
  id: knowledgeRequirementIdSchema,
  coverage: coverageSchema,
  answer: z.string().trim().min(1).max(16_384),
  citations: z.array(z.number().int().positive()).max(20),
});
export const finalActionSchema = z.object({
  action: z.literal("final"),
  requirements: z.array(requirementCoverageSchema).min(1).max(6),
  citations: z.array(z.number().int().positive()).max(20),
}).strict();
export const coverageVerificationReasonSchema = z.enum([
  "direct_support",
  "explicit_negative_support",
  "partial_support",
  "related_only",
  "target_omitted",
  "unsupported_claim_removed",
]);
const coverageVerificationRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  coverage: coverageSchema,
  answer: z.string().trim().min(1).max(16_384),
  citations: z.array(z.number().int().positive()).max(20),
  reason: coverageVerificationReasonSchema,
}).strict();
export const coverageVerificationActionSchema = z.object({
  action: z.literal("verify"),
  requirements: z.array(coverageVerificationRequirementSchema).min(1).max(6),
  citations: z.array(z.number().int().positive()).max(20),
}).strict();
export const agentActionSchema = z.union([toolActionSchema, finalActionSchema]);
export const finalOnlyActionSchema = finalActionSchema;
export const pseAnswerInputSchema = z.object({
  question: z.string().trim().min(1).max(16_384),
  conversationContext: z.string().max(32_768).optional(),
}).strict();
export const referenceSchema = z.object({
  index: z.number().int().positive(),
  project: z.enum(["coremail-professional", "presales-general"]),
  title: z.string().min(1),
  path: z.string().min(1),
  revision: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const HISTORICAL_ANSWER_WARNING =
  "以下内容由 Coremail MCP 根据 Jira/Wiki 历史资料自动整理，未经过产品或售前人员验证。资料可能过时、不完整或不准确，请勿直接作为投标、部署、升级或变更依据。";
export const historicalReferenceSchema = z.object({
  sourceType: z.enum(["jira", "wiki"]),
  id: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  versions: z.array(z.string().min(1)).max(20).optional(),
  status: z.string().min(1).optional(),
}).strict();
export const historicalAnswerSchema = z.object({
  provider: z.literal("coremail_mcp"),
  verified: z.literal(false),
  confidence: z.enum(["low", "medium", "high"]),
  warning: z.literal(HISTORICAL_ANSWER_WARNING),
  answer: z.string().min(1).max(32_768),
  references: z.array(historicalReferenceSchema).min(1).max(20),
}).strict();
export const answerResultSchema = z.object({
  scope: scopeSchema,
  status: answerStatusSchema,
  answer: z.string(),
  references: z.array(referenceSchema),
  historicalAnswer: historicalAnswerSchema.optional(),
}).strict();
export type Scope = z.infer<typeof scopeSchema>;
export type RouteAction = z.infer<typeof routeActionSchema>;
export type KnowledgeRequirement = z.infer<typeof knowledgeRequirementSchema>;
export type KnowledgePlan = z.infer<typeof knowledgePlanSchema>;
export type RequirementCoverage = z.infer<typeof requirementCoverageSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type ToolAction = z.infer<typeof toolActionSchema>;
export type FinalAction = z.infer<typeof finalActionSchema>;
export type CoverageVerificationAction = z.infer<typeof coverageVerificationActionSchema>;
export type AnswerResult = z.infer<typeof answerResultSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type HistoricalReference = z.infer<typeof historicalReferenceSchema>;
export type HistoricalAnswer = z.infer<typeof historicalAnswerSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type AnswerStatus = z.infer<typeof answerStatusSchema>;

function looksLikeOpaqueKnowledgeIdentifier(query: string): boolean {
  const normalized = query.trim();
  return /^(?:(?:page|wiki|confluence|source|页面|来源|附件)\s*(?:id|编号)?\s*[:#_-]?\s*)?\d{6,}(?:\s*[-_:#]|$)/iu
    .test(normalized)
    || /^(?:[a-f\d]{8}-){3,}[a-f\d-]+$/iu.test(normalized);
}
