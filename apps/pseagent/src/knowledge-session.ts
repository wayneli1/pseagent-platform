import { z } from "zod";
import type { KnowledgeToolCaller } from "./knowledge-tool-caller.js";

const projectSchema = z.enum(["coremail-professional", "presales-general"]);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const safePathSchema = z.string().refine((value) =>
  value.startsWith("wiki/") && value.endsWith(".md") && !value.includes("\\") && !value.split("/").includes(".."));
const snapshotSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  lexicalStatus: z.literal("ready"),
  graphStatus: z.literal("ready"),
}).strict();
const healthResultSchema = z.object({
  status: z.literal("ready"),
  projects: z.array(snapshotSchema).length(2),
}).strict();
const contextResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  schema: z.string(),
  overview: z.string(),
}).strict();
const searchHitSchema = z.object({
  path: safePathSchema,
  title: z.string().min(1),
  score: z.number(),
  matchedTerms: z.array(z.string()),
  snippet: z.string().max(2_000),
}).strict();
const searchResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  hits: z.array(searchHitSchema),
}).strict();
const graphResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  hits: z.array(z.object({ path: safePathSchema, title: z.string().min(1), relation: z.string().min(1) }).strict()),
}).strict();
export const knowledgePageSchema = z.object({
  project: projectSchema,
  path: safePathSchema,
  title: z.string().min(1),
  type: z.string(),
  tags: z.array(z.string()),
  related: z.array(z.string()),
  sources: z.array(z.string()),
  body: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const readResultSchema = z.object({
  project: projectSchema,
  revision: revisionSchema,
  page: knowledgePageSchema,
}).strict();

export type ProjectKey = z.infer<typeof projectSchema>;
export type KnowledgePage = z.infer<typeof knowledgePageSchema>;
export type KnowledgeSearchResult = z.infer<typeof searchResultSchema>;
export type KnowledgeGraphResult = z.infer<typeof graphResultSchema>;

const PROJECT_BY_SCOPE = {
  professional: "coremail-professional",
  general: "presales-general",
} as const;

export class KnowledgeUnavailableError extends Error {}
export class RevisionMismatchError extends Error {}
export class SnapshotMismatchError extends Error {}
export class UnknownKnowledgePathError extends Error {}

export class KnowledgeSession {
  readonly seenPaths = new Set<string>();

  private constructor(
    readonly project: ProjectKey,
    readonly revision: string,
    readonly schema: string,
    readonly overview: string,
    private readonly caller: KnowledgeToolCaller,
  ) {}

  static async open(
    scope: "professional" | "general",
    caller: KnowledgeToolCaller,
    signal?: AbortSignal,
  ): Promise<KnowledgeSession> {
    const project = PROJECT_BY_SCOPE[scope];
    try {
      await caller.connect();
      const status = healthResultSchema.parse(await caller.call("knowledge_status", {}, signal));
      const snapshot = status.projects.find((item) => item.project === project);
      if (!snapshot) throw new KnowledgeUnavailableError("knowledge_project_unavailable");
      const context = contextResultSchema.parse(
        await caller.call("knowledge_context", { project }, signal),
      );
      assertSameSnapshot(project, snapshot.revision, context);
      return new KnowledgeSession(project, snapshot.revision, context.schema, context.overview, caller);
    } catch (error) {
      await caller.close();
      throw error;
    }
  }

  async search(query: string, topK: number, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    const result = searchResultSchema.parse(await this.caller.call(
      "knowledge_search",
      { project: this.project, query, topK },
      signal,
    ));
    assertSameSnapshot(this.project, this.revision, result);
    for (const hit of result.hits) this.seenPaths.add(hit.path);
    return result;
  }

  async graph(path: string, topK: number, signal?: AbortSignal): Promise<KnowledgeGraphResult> {
    this.assertSeen(path);
    const result = graphResultSchema.parse(await this.caller.call(
      "knowledge_graph",
      { project: this.project, path, topK },
      signal,
    ));
    assertSameSnapshot(this.project, this.revision, result);
    for (const hit of result.hits) this.seenPaths.add(hit.path);
    return result;
  }

  async readPage(path: string, signal?: AbortSignal): Promise<KnowledgePage> {
    this.assertSeen(path);
    const result = readResultSchema.parse(await this.caller.call(
      "knowledge_read",
      { project: this.project, path },
      signal,
    ));
    assertSameSnapshot(this.project, this.revision, result);
    if (result.page.project !== this.project || result.page.path !== path) {
      throw new SnapshotMismatchError("knowledge_page_snapshot_mismatch");
    }
    return result.page;
  }

  compactPage(page: KnowledgePage, matchedTerms: string[]): string {
    const header = `# ${page.title}\nPath: ${page.path}\nSources: ${page.sources.join(", ")}\n\nBody:\n`;
    const headerCharacters = [...header];
    if (headerCharacters.length >= 4_000) return headerCharacters.slice(0, 4_000).join("");
    const bodyCharacters = [...page.body];
    const budget = 4_000 - headerCharacters.length;
    const earliest = earliestTermOffset(page.body, matchedTerms);
    const center = earliest < 0 ? 0 : [...page.body.slice(0, earliest)].length;
    const start = Math.max(0, Math.min(center - Math.floor(budget / 2), bodyCharacters.length - budget));
    return header + bodyCharacters.slice(start, start + budget).join("");
  }

  private assertSeen(path: string): void {
    if (!this.seenPaths.has(path)) throw new UnknownKnowledgePathError("knowledge_path_not_observed");
  }
}

function assertSameSnapshot(
  project: ProjectKey,
  revision: string,
  value: { project: ProjectKey; revision: string },
): void {
  if (value.project !== project) throw new SnapshotMismatchError("knowledge_project_mismatch");
  if (value.revision !== revision) throw new RevisionMismatchError("knowledge_revision_mismatch");
}

function earliestTermOffset(body: string, terms: string[]): number {
  let earliest = -1;
  for (const term of terms) {
    if (!term) continue;
    const offset = body.indexOf(term);
    if (offset >= 0 && (earliest < 0 || offset < earliest)) earliest = offset;
  }
  return earliest;
}
