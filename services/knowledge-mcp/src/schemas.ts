import { z } from "zod";

export const projectSchema = z.enum(["coremail-professional", "presales-general"]);
export const revisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const topKSchema = z.number().int().min(1).max(20);
export const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) =>
    value.startsWith("wiki/") &&
    value.endsWith(".md") &&
    !value.includes("\\") &&
    !value.split("/").includes(".."),
  );

export const contextInputSchema = z.object({ project: projectSchema }).strict();
export const searchInputSchema = z.object({
  project: projectSchema,
  query: z.string().trim().min(1).max(16_384),
  topK: topKSchema,
}).strict();
export const readInputSchema = z.object({
  project: projectSchema,
  path: safeRelativePathSchema,
}).strict();
export const graphInputSchema = z.object({
  project: projectSchema,
  path: safeRelativePathSchema,
  topK: topKSchema,
}).strict();

const snapshotSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  lexicalStatus: z.literal("ready"),
  graphStatus: z.literal("ready"),
}).strict();
export const healthResultSchema = z.object({
  status: z.literal("ready"),
  projects: z.array(snapshotSchema).length(2),
}).strict();
export const contextResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  purpose: z.string(),
  schema: z.string(),
  planningOverview: z.string().max(12_000),
  planningOverviewMeta: z.object({
    status: z.enum(["ready", "missing", "truncated"]),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    rendererVersion: z.literal("planning-overview-v1"),
    originalChars: z.number().int().nonnegative(),
    exposedChars: z.number().int().nonnegative().max(12_000),
    truncated: z.boolean(),
  }).strict(),
}).strict();
const searchHitSchema = z.object({
  path: safeRelativePathSchema,
  title: z.string().min(1),
  score: z.number(),
  matchedTerms: z.array(z.string()),
  snippet: z.string().max(2_000),
}).strict();
export const searchResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  hits: z.array(searchHitSchema),
}).strict();
export const pageSchema = z.object({
  project: projectSchema,
  path: safeRelativePathSchema,
  title: z.string().min(1),
  type: z.string(),
  tags: z.array(z.string()),
  related: z.array(z.string()),
  sources: z.array(z.string()),
  body: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const readResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  page: pageSchema,
}).strict();
const graphHitSchema = z.object({
  path: safeRelativePathSchema,
  title: z.string().min(1),
  relation: z.string().min(1),
}).strict();
export const graphResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  hits: z.array(graphHitSchema),
}).strict();

export type ContextInput = z.infer<typeof contextInputSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type ReadInput = z.infer<typeof readInputSchema>;
export type GraphInput = z.infer<typeof graphInputSchema>;
export type HealthResult = z.infer<typeof healthResultSchema>;
export type ContextResult = z.infer<typeof contextResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type ReadResult = z.infer<typeof readResultSchema>;
export type GraphResult = z.infer<typeof graphResultSchema>;
