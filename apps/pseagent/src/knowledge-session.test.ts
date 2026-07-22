import { describe, expect, it, vi } from "vitest";
import type { KnowledgeToolCaller, KnowledgeToolName } from "./knowledge-tool-caller.js";
import {
  KnowledgeSession,
  RevisionMismatchError,
  SnapshotMismatchError,
  UnknownKnowledgePathError,
} from "./knowledge-session.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const contentHash = "c".repeat(64);

function fakeKnowledgeCaller(overrides: {
  revision?: string;
  searchRevision?: string;
  searchProject?: string;
  pageProject?: string;
  pagePath?: string;
} = {}) {
  const revision = overrides.revision ?? revisionA;
  const call = vi.fn(async (name: KnowledgeToolName, input: unknown) => {
    const project = (input as { project?: string }).project;
    if (name === "knowledge_status") {
      return {
        status: "ready",
        projects: [
          { project: "coremail-professional", revision, lexicalStatus: "ready", graphStatus: "ready" },
          { project: "presales-general", revision, lexicalStatus: "ready", graphStatus: "ready" },
        ],
      };
    }
    if (name === "knowledge_context") return { project, revision, schema: "schema", overview: "overview" };
    if (name === "knowledge_search") {
      return {
        project: overrides.searchProject ?? project,
        revision: overrides.searchRevision ?? revision,
        hits: [{ path: "wiki/guide.md", title: "Guide", score: 1, matchedTerms: ["AI"], snippet: "snippet" }],
      };
    }
    if (name === "knowledge_graph") {
      return { project, revision, hits: [{ path: "wiki/related.md", title: "Related", relation: "related" }] };
    }
    return {
      project,
      revision,
      page: {
        project: overrides.pageProject ?? project,
        path: overrides.pagePath ?? (input as { path: string }).path,
        title: "Guide",
        type: "guide",
        tags: [],
        related: [],
        sources: ["source.md"],
        body: "AI body",
        contentHash,
      },
    };
  });
  return {
    connect: vi.fn(async () => undefined),
    call,
    close: vi.fn(async () => undefined),
  } satisfies KnowledgeToolCaller;
}

describe("KnowledgeSession", () => {
  it("binds professional to coremail-professional and hides project from model actions", async () => {
    const caller = fakeKnowledgeCaller();
    const session = await KnowledgeSession.open("professional", caller);

    await session.search("AI 助手", 5);

    expect(caller.call).toHaveBeenLastCalledWith("knowledge_search", {
      project: "coremail-professional",
      query: "AI 助手",
      topK: 5,
    }, undefined);
  });

  it("binds general only to presales-general", async () => {
    const caller = fakeKnowledgeCaller();
    const session = await KnowledgeSession.open("general", caller);

    expect(session.project).toBe("presales-general");
    expect(caller.call).toHaveBeenNthCalledWith(2, "knowledge_context", { project: "presales-general" }, undefined);
  });

  it("rejects any tool response from a different revision", async () => {
    const caller = fakeKnowledgeCaller({ searchRevision: revisionB });
    const session = await KnowledgeSession.open("general", caller);

    await expect(session.search("需求访谈", 5)).rejects.toThrow(RevisionMismatchError);
  });

  it("rejects cross-project payloads", async () => {
    const caller = fakeKnowledgeCaller({ searchProject: "coremail-professional" });
    const session = await KnowledgeSession.open("general", caller);

    await expect(session.search("需求访谈", 5)).rejects.toThrow(SnapshotMismatchError);
  });

  it("requires an observed path before graph or read", async () => {
    const session = await KnowledgeSession.open("professional", fakeKnowledgeCaller());

    await expect(session.readPage("wiki/unknown.md")).rejects.toThrow(UnknownKnowledgePathError);
    await expect(session.graph("wiki/unknown.md", 5)).rejects.toThrow(UnknownKnowledgePathError);
  });

  it("adds search and graph paths, then fails closed on a mismatched page path", async () => {
    const caller = fakeKnowledgeCaller({ pagePath: "wiki/other.md" });
    const session = await KnowledgeSession.open("professional", caller);

    await session.search("AI", 5);
    await session.graph("wiki/guide.md", 5);
    expect(session.seenPaths).toEqual(new Set(["wiki/guide.md", "wiki/related.md"]));
    await expect(session.readPage("wiki/guide.md")).rejects.toThrow(SnapshotMismatchError);
  });

  it("compacts pages around the earliest matched term without splitting Unicode", async () => {
    const session = await KnowledgeSession.open("professional", fakeKnowledgeCaller());
    const page = {
      project: "coremail-professional" as const,
      path: "wiki/guide.md",
      title: "标题😀",
      type: "guide",
      tags: [],
      related: [],
      sources: ["来源😀"],
      body: `${"前".repeat(5_000)}命中词${"后".repeat(5_000)}😀`,
      contentHash,
    };
    const original = structuredClone(page);

    const compact = session.compactPage(page, ["命中词"]);

    expect([...compact].length).toBeLessThanOrEqual(4_000);
    expect(compact).toContain("命中词");
    expect(compact).toContain("标题😀");
    expect(page).toEqual(original);
  });
});
