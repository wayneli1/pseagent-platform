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
      const status = healthResultSchema.parse(await caller.call("knowledge_status", {}, signal));
      const snapshot = status.projects.find((item) => item.project === project);
      if (!snapshot) throw new KnowledgeUnavailableError("knowledge_project_unavailable");
      const context = contextResultSchema.parse(
        await caller.call("knowledge_context", { project }, signal),
      );
      assertSameSnapshot(project, snapshot.revision, context);
      return new KnowledgeSession(project, snapshot.revision, context.schema, context.overview, caller);
    } catch (error) {
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
    const limit = 8_000;
    if (characterLength(header) >= limit) return takeCharacters(header, limit);
    if (characterLength(header + page.body) <= limit) return header + page.body;

    const budget = limit - characterLength(header);
    const sections = splitMarkdownSections(page.body);
    const terms = semanticTerms(matchedTerms);
    const ranked = sections
      .map((section, index) => ({
        ...section,
        index,
        score: sectionScore(section, terms),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const hasRelevantSection = ranked.some((section) => section.score > 0);

    const selected: typeof ranked = [];
    let used = 0;
    for (const section of ranked) {
      if (selected.length >= 3) break;
      if (hasRelevantSection && section.score === 0) continue;
      const sectionLength = characterLength(section.text);
      if (sectionLength > budget - used) continue;
      selected.push(section);
      used += sectionLength + 2;
    }
    if (selected.length === 0) {
      const best = ranked[0];
      const bounded = best === undefined ? "" : takeWholeParagraphs(best.text, budget);
      return header + bounded;
    }
    selected.sort((left, right) => left.index - right.index);
    return header + selected.map((section) => section.text).join("\n\n");
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

type MarkdownSection = {
  readonly heading: string;
  readonly text: string;
};

function splitMarkdownSections(body: string): MarkdownSection[] {
  const lines = body.split(/\r?\n/u);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current = { heading: "", lines: [] as string[] };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      if (current.lines.length > 0) sections.push(current);
      current = { heading: heading[2] ?? "", lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);
  return sections.map((section) => ({
    heading: section.heading,
    text: section.lines.join("\n").trim(),
  })).filter((section) => section.text.length > 0);
}

function semanticTerms(values: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) continue;
    terms.add(normalized);
    for (const token of normalized.split(/[\s,，。！？、:：;；()[\]{}<>《》"'“”‘’/\\|+-]+/u)) {
      if ([...token].length >= 2) terms.add(token);
    }
  }
  return [...terms];
}

function sectionScore(section: MarkdownSection, terms: readonly string[]): number {
  const heading = section.heading.toLocaleLowerCase("zh-CN");
  const text = section.text.toLocaleLowerCase("zh-CN");
  let score = 0;
  for (const term of terms) {
    if (heading.includes(term)) score += 8;
    const matches = text.split(term).length - 1;
    score += Math.min(matches, 5);
  }
  return score;
}

function takeWholeParagraphs(text: string, budget: number): string {
  const paragraphs = text.split(/\n{2,}/u);
  const selected: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const length = characterLength(paragraph);
    if (length > budget - used) break;
    selected.push(paragraph);
    used += length + 2;
  }
  if (selected.length > 0) return selected.join("\n\n");
  const heading = text.split(/\r?\n/u)[0] ?? "";
  return characterLength(heading) <= budget ? heading : takeCharacters(heading, budget);
}

function characterLength(value: string): number {
  return [...value].length;
}

function takeCharacters(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
}
