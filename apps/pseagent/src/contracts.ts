import { z } from "zod";

export const scopeSchema = z.enum(["professional", "general", "normal"]);
export const answerStatusSchema = z.enum(["answered", "partially_answered", "not_covered", "temporarily_unavailable"]);
export const coverageSchema = z.enum(["complete", "partial", "none"]);
export const routeActionSchema = z.object({ action: z.literal("route"), scope: scopeSchema }).strict();
const searchActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.search"),
  input: z.object({
    query: z.string().trim().min(1).max(16_384),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict(),
}).strict();
const readActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.read_page"),
  input: z.object({ path: z.string().trim().min(1).max(1_024) }).strict(),
}).strict();
const graphActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.graph"),
  input: z.object({
    path: z.string().trim().min(1).max(1_024),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict(),
}).strict();
export const toolActionSchema = z.discriminatedUnion("tool", [searchActionSchema, readActionSchema, graphActionSchema]);
export const finalActionSchema = z.object({
  action: z.literal("final"),
  coverage: coverageSchema,
  answer: z.string().max(32_768),
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
export type AgentAction = z.infer<typeof agentActionSchema>;
export type ToolAction = z.infer<typeof toolActionSchema>;
export type FinalAction = z.infer<typeof finalActionSchema>;
export type AnswerResult = z.infer<typeof answerResultSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type HistoricalReference = z.infer<typeof historicalReferenceSchema>;
export type HistoricalAnswer = z.infer<typeof historicalAnswerSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type AnswerStatus = z.infer<typeof answerStatusSchema>;
