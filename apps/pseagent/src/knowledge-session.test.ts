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
  professionalRevision?: string;
  generalRevision?: string;
  searchRevision?: string;
  searchProject?: string;
  pageProject?: string;
  pagePath?: string;
} = {}) {
  const revision = overrides.revision ?? revisionA;
  const call = vi.fn(async (name: KnowledgeToolName, input: unknown) => {
    const project = (input as { project?: string }).project;
    const projectRevision = project === "presales-general"
      ? overrides.generalRevision ?? revision
      : overrides.professionalRevision ?? revision;
    if (name === "knowledge_status") {
      return {
        status: "ready",
        projects: [
          {
            project: "coremail-professional",
            revision: overrides.professionalRevision ?? revision,
            lexicalStatus: "ready",
            graphStatus: "ready",
          },
          {
            project: "presales-general",
            revision: overrides.generalRevision ?? revision,
            lexicalStatus: "ready",
            graphStatus: "ready",
          },
        ],
      };
    }
    if (name === "knowledge_context") {
      return {
        project,
        revision: projectRevision,
        purpose: "purpose",
        schema: "schema",
        planningOverview: "overview body",
        planningOverviewMeta: {
          status: "ready",
          contentHash,
          rendererVersion: "planning-overview-v1",
          originalChars: 13,
          exposedChars: 13,
          truncated: false,
        },
      };
    }
    if (name === "knowledge_search") {
      return {
        project: overrides.searchProject ?? project,
        revision: overrides.searchRevision ?? projectRevision,
        hits: [{ path: "wiki/guide.md", title: "Guide", score: 1, matchedTerms: ["AI"], snippet: "snippet" }],
      };
    }
    if (name === "knowledge_graph") {
      return {
        project,
        revision: projectRevision,
        hits: [{ path: "wiki/related.md", title: "Related", relation: "related" }],
      };
    }
    return {
      project,
      revision: projectRevision,
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
  it("does not permanently close the shared caller after one open failure", async () => {
    const caller = fakeKnowledgeCaller();
    caller.call.mockRejectedValueOnce(new Error("transient status failure"));

    await expect(KnowledgeSession.open("professional", caller)).rejects.toThrow(
      "transient status failure",
    );

    expect(caller.close).not.toHaveBeenCalled();
    await expect(KnowledgeSession.open("professional", caller)).resolves
      .toMatchObject({ project: "coremail-professional" });
  });

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
    expect(session.purpose).toBe("purpose");
    expect(session.planningOverview).toBe("overview body");
    expect(session.planningOverviewMeta.contentHash).toBe(contentHash);
    expect(caller.call).toHaveBeenNthCalledWith(2, "knowledge_context", { project: "presales-general" }, undefined);
  });

  it("opens independent sessions and preserves each domain revision", async () => {
    const caller = fakeKnowledgeCaller({
      professionalRevision: revisionA,
      generalRevision: revisionB,
    });

    const [professional, general] = await Promise.all([
      KnowledgeSession.open("professional", caller),
      KnowledgeSession.open("general", caller),
    ]);

    expect(professional).not.toBe(general);
    expect(professional).toMatchObject({
      project: "coremail-professional",
      revision: revisionA,
    });
    expect(general).toMatchObject({
      project: "presales-general",
      revision: revisionB,
    });
    expect(professional.seenPaths).not.toBe(general.seenPaths);
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

  it("returns a short page in full", async () => {
    const session = await KnowledgeSession.open("professional", fakeKnowledgeCaller());
    const page = {
      project: "coremail-professional" as const,
      path: "wiki/guide.md",
      title: "短页",
      type: "guide",
      tags: [],
      related: [],
      sources: ["来源"],
      body: "## 完整章节\n短页正文",
      contentHash,
    };

    const compact = session.compactPage(page, ["正文"]);

    expect(compact).toContain("## 完整章节\n短页正文");
  });

  it("selects complete relevant Markdown sections from a long page without a mid-section window", async () => {
    const session = await KnowledgeSession.open("professional", fakeKnowledgeCaller());
    const page = {
      project: "coremail-professional" as const,
      path: "wiki/guide.md",
      title: "标题😀",
      type: "guide",
      tags: [],
      related: [],
      sources: ["来源😀"],
      body: [
        `## 无关章节 A\n${"甲".repeat(4_000)}`,
        `## 目标章节😀\n开始标记\n${"命中词".repeat(500)}\n结束标记😀`,
        `## 无关章节 B\n${"乙".repeat(4_000)}`,
      ].join("\n\n"),
      contentHash,
    };
    const original = structuredClone(page);

    const compact = session.compactPage(page, ["命中词"]);

    expect([...compact].length).toBeLessThanOrEqual(8_000);
    expect(compact).toContain("## 目标章节😀");
    expect(compact).toContain("开始标记");
    expect(compact).toContain("结束标记😀");
    expect(compact).not.toContain("## 无关章节 A");
    expect(compact).toContain("标题😀");
    expect(page).toEqual(original);
  });

  it("selects different sections for different requirement terms on the same page", async () => {
    const session = await KnowledgeSession.open("professional", fakeKnowledgeCaller());
    const page = {
      project: "coremail-professional" as const,
      path: "wiki/guide.md",
      title: "复合页面",
      type: "guide",
      tags: [],
      related: [],
      sources: [],
      body: [
        `## 部署规模\n十万用户容量规划\n${"容量".repeat(2_500)}`,
        `## 镜像同步\n镜像系统同步机制\n${"同步".repeat(2_500)}`,
      ].join("\n\n"),
      contentHash,
    };

    const scale = session.compactPage(page, ["十万用户", "部署规模"]);
    const mirror = session.compactPage(page, ["镜像系统", "同步机制"]);

    expect(scale).toContain("## 部署规模");
    expect(scale).not.toContain("## 镜像同步");
    expect(mirror).toContain("## 镜像同步");
    expect(mirror).not.toContain("## 部署规模");
  });
});
