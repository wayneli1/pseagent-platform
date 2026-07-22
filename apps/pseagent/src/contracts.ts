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
export const answerResultSchema = z.object({
  scope: scopeSchema,
  status: answerStatusSchema,
  answer: z.string(),
  references: z.array(referenceSchema),
}).strict();
export type Scope = z.infer<typeof scopeSchema>;
export type RouteAction = z.infer<typeof routeActionSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type ToolAction = z.infer<typeof toolActionSchema>;
export type FinalAction = z.infer<typeof finalActionSchema>;
export type AnswerResult = z.infer<typeof answerResultSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type AnswerStatus = z.infer<typeof answerStatusSchema>;
