import { describe, expect, it, vi } from "vitest";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import type { KnowledgePage, KnowledgeSession } from "./knowledge-session.js";
import { DeterministicRetrievalCoordinator } from "./deterministic-retrieval.js";

const revision = "a".repeat(40);
const trace: DiagnosticTrace = { requestId: "deterministic-retrieval", record() {} };

function domainPlan(requirementCount = 2): DomainKnowledgePlan {
  return {
    domain: "coremail-professional",
    scope: "professional",
    plan: {
      subject: "Coremail 迁移",
      retrievalStrategy: "coverage_units",
      requirements: Array.from({ length: requirementCount }, (_, index) => ({
        id: `R${index + 1}`,
        question: index === 0 ? "Coremail 迁移能力" : "Coremail 迁移边界",
        evidenceMode: "direct_only" as const,
        evidenceAspects: [{
          id: "A1",
          label: index === 0 ? "迁移能力" : "迁移边界",
          terms: index === 0 ? ["迁移", "能力"] : ["迁移", "边界"],
        }],
        queries: [
          { text: `Coremail 迁移 ${index + 1} 主查询`, aspectIds: ["A1"] },
          { text: `Coremail 迁移 ${index + 1} 补充查询`, aspectIds: ["A1"] },
        ],
      })),
    },
    bindings: Array.from({ length: requirementCount }, (_, index) => ({
      domain: "coremail-professional",
      requirementId: `R${index + 1}`,
      deliverableId: `D${index + 1}`,
      obligationId: `O${index + 1}`,
      order: index,
    })),
  };
}

function page(path: string, title: string, type = "query"): KnowledgePage {
  return {
    project: "coremail-professional",
    path,
    title,
    type,
    tags: [],
    related: [],
    sources: [],
    body: `# ${title}\n正式证据正文。`,
    contentHash: path.includes("quote") ? "b".repeat(64) : "c".repeat(64),
  };
}

function sessionFixture(options: {
  readonly priceFirst?: boolean;
  readonly entityFirst?: boolean;
} = {}) {
  const search = vi.fn(async (query: string) => {
    const requirement = query.includes(" 2 ") ? "2" : "1";
    const hits = options.entityFirst
      ? [
          {
            path: "wiki/entities/第三方备份软件.md",
            title: "第三方备份软件",
            score: 0.99,
            matchedTerms: ["备份"],
            snippet: "实体摘要",
            pageType: "entity",
          },
          {
            path: "wiki/queries/客户大库备份选型.md",
            title: "客户大库备份选型",
            score: 0.7,
            matchedTerms: ["备份", "选型"],
            snippet: "审核答案卡",
            pageType: "query",
            reviewStatus: "approved",
          },
        ]
      : options.priceFirst
      ? [
          {
            path: "wiki/quotes/migration-quote.md",
            title: "迁移能力报价",
            score: 0.99,
            matchedTerms: ["迁移", "能力"],
            snippet: "报价",
            pageType: "quote",
          },
          {
            path: "wiki/queries/migration-capability.md",
            title: "Coremail 迁移能力",
            score: 0.7,
            matchedTerms: ["迁移", "能力"],
            snippet: "正式能力",
            pageType: "query",
            reviewStatus: "approved",
          },
        ]
      : [{
          path: `wiki/queries/migration-${requirement}.md`,
          title: `Coremail 迁移资料 ${requirement}`,
          score: 0.8,
          matchedTerms: ["迁移"],
          snippet: "正式资料",
          pageType: "query",
          reviewStatus: "approved",
        }];
    return { project: "coremail-professional" as const, revision, hits };
  });
  const readPage = vi.fn(async (path: string) => path.includes("quote")
    ? page(path, "迁移能力报价", "quote")
    : path.includes("entities")
      ? page(path, "第三方备份软件", "entity")
      : path.includes("客户大库")
        ? page(path, "客户大库备份选型")
        : page(path, "Coremail 迁移能力"));
  const compactPage = vi.fn((value: KnowledgePage) => value.body);
  return {
    session: {
      project: "coremail-professional",
      revision,
      search,
      readPage,
      compactPage,
    } as unknown as KnowledgeSession,
    search,
    readPage,
  };
}

describe("DeterministicRetrievalCoordinator", () => {
  it("searches and reads every required obligation without a model action loop", async () => {
    const { session, search } = sessionFixture();
    const model = { completeJson: vi.fn() };

    const result = await new DeterministicRetrievalCoordinator().retrieve({
      plan: domainPlan(2),
      session,
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
      trace,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(result.evidence.map((item) => item.requirementId)).toEqual([
      "R1",
      "R2",
    ]);
    expect(result.evidence[0]?.aspectRequirements).toEqual([{
      id: "A1",
      label: "迁移能力",
      terms: ["迁移", "能力"],
    }]);
    expect(result.evidenceLedger.units).toHaveLength(2);
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("keeps a direct formal page ahead of a price quote with lexical overlap", async () => {
    const { session, readPage } = sessionFixture({ priceFirst: true });

    const result = await new DeterministicRetrievalCoordinator().retrieve({
      plan: domainPlan(1),
      session,
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
      trace,
    });

    expect(result.evidence[0]?.path).toMatch(/^wiki\/(?:queries|concepts)\//u);
    expect(result.evidence[0]?.path).not.toMatch(/报价|quote/iu);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("keeps the dedicated first query ahead of a broad fallback query", async () => {
    const dedicatedQuery = "Exchange 替换 用户通知 培训 回退 旧系统";
    const broadQuestion =
      "Exchange 与 Coremail 双轨并行，邮件路由已经验证；当前追问：双轨图里跨系统日程不可用，只说明这项限制、用户替代动作和回退时如何通知。";
    const directPath = "wiki/concepts/Exchange替换项目中的客户端切换影响.md";
    const broadPath = "wiki/queries/Exchange与Coremail同域名并行时如何配置邮件路由.md";
    const base = domainPlan(1);
    const orderedPlan: DomainKnowledgePlan = {
      ...base,
      plan: {
        ...base.plan,
        subject: "回退通知",
        requirements: [{
          ...base.plan.requirements[0]!,
          question: broadQuestion,
          queries: [
            { text: dedicatedQuery, aspectIds: ["A1"] },
            { text: broadQuestion, aspectIds: ["A1"] },
          ],
        }],
      },
    };
    const search = vi.fn(async (query: string) => ({
      project: "coremail-professional" as const,
      revision,
      hits: query === dedicatedQuery
        ? [{
            path: directPath,
            title: "Exchange替换项目中的客户端切换影响",
            score: 1,
            matchedTerms: ["用户通知", "回退"],
            pageType: "concept",
          }]
        : [{
            path: broadPath,
            title: "Exchange 与 Coremail 同域名并行时如何配置邮件路由",
            score: 1,
            matchedTerms: ["Exchange", "Coremail", "双轨"],
            pageType: "query",
          }],
    }));
    const readPage = vi.fn(async (path: string) =>
      path === directPath
        ? page(path, "Exchange替换项目中的客户端切换影响", "concept")
        : page(path, "Exchange 与 Coremail 同域名并行时如何配置邮件路由"));
    const session = {
      project: "coremail-professional",
      revision,
      search,
      readPage,
      compactPage: vi.fn((value: KnowledgePage) => value.body),
    } as unknown as KnowledgeSession;

    const result = await new DeterministicRetrievalCoordinator().retrieve({
      plan: orderedPlan,
      session,
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
      trace,
    });

    expect(result.evidence[0]?.path).toBe(directPath);
    expect(readPage).toHaveBeenCalledWith(directPath, expect.any(AbortSignal));
  });

  it("reads a governed preferred evidence path before a higher-ranked entity summary", async () => {
    const { session, readPage } = sessionFixture({ entityFirst: true });
    const governedPlan: DomainKnowledgePlan = {
      ...domainPlan(1),
      bindings: [{
        ...domainPlan(1).bindings[0]!,
        cardId: "PRO-LARGE-DATA-BACKUP-SELECTION",
        preferredEvidencePaths: ["wiki/queries/客户大库备份选型.md"],
      }],
    };

    const result = await new DeterministicRetrievalCoordinator().retrieve({
      plan: governedPlan,
      session,
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
      trace,
    });

    expect(result.evidence[0]?.path).toBe("wiki/queries/客户大库备份选型.md");
    expect(readPage).toHaveBeenCalledTimes(1);
  });
});
