import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rankRetrievalCandidates } from "./candidate-ranking.js";

interface RetrievalGoldCase {
  readonly id: string;
  readonly question: string;
  readonly evidenceMode: "direct_only" | "synthesis_allowed";
  readonly aspects: readonly string[];
  readonly expectedTopId: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly path: string;
    readonly title: string;
    readonly pageType: string;
    readonly aspectIds: readonly string[];
    readonly rrfScore: number;
  }[];
}

const gold = JSON.parse(readFileSync(
  new URL("../../../tests/regression/retrieval-gold.json", import.meta.url),
  "utf8",
)) as RetrievalGoldCase[];

describe("rankRetrievalCandidates", () => {
  it.each(gold)("puts the direct source first for $id", (sample) => {
    const ranked = rankRetrievalCandidates({
      question: sample.question,
      queries: [sample.question],
      evidenceMode: sample.evidenceMode,
      missingAspectIds: sample.aspects,
      candidates: sample.candidates.map((candidate) => ({
        ...candidate,
        requirementSpecificMatch: true,
        reviewStatus: "approved",
      })),
    });

    expect(ranked[0]?.candidate.id).toBe(sample.expectedTopId);
    expect(ranked[0]?.score).toEqual(expect.objectContaining({
      titleCoverage: expect.any(Number),
      aspectCoverage: expect.any(Number),
      directness: expect.any(Number),
      sourceTier: expect.any(Number),
      freshness: expect.any(Number),
      rrf: expect.any(Number),
    }));
  });

  it("uses a stable path tie-break instead of input order", () => {
    const candidates = ["wiki/queries/b.md", "wiki/queries/a.md"].map((path) => ({
      id: path,
      path,
      title: "同名正式资料",
      pageType: "query",
      aspectIds: ["A1"],
      rrfScore: 0.01,
      requirementSpecificMatch: true,
      reviewStatus: "approved",
    }));
    const ranked = rankRetrievalCandidates({
      question: "同名正式资料",
      queries: ["同名正式资料"],
      evidenceMode: "direct_only",
      missingAspectIds: ["A1"],
      candidates,
    });

    expect(ranked.map((item) => item.candidate.path)).toEqual([
      "wiki/queries/a.md",
      "wiki/queries/b.md",
    ]);
  });

  it("prioritizes the first result of an obligation-shaped query", () => {
    const ranked = rankRetrievalCandidates({
      question: "邮件迁移项目需要考虑哪些产品能力",
      queries: ["邮件迁移项目 产品能力"],
      evidenceMode: "direct_only",
      missingAspectIds: ["A1"],
      candidates: [
        {
          id: "noise",
          path: "wiki/queries/迁移报价.md",
          title: "邮件迁移项目产品报价",
          pageType: "query",
          aspectIds: ["A1"],
          rrfScore: 0.03,
          requirementSpecificMatch: true,
        },
        {
          id: "direct",
          path: "wiki/comparison/第三方邮件系统迁移方式对比.md",
          title: "第三方邮件系统迁移方式对比",
          pageType: "comparison",
          aspectIds: ["A1"],
          rrfScore: 0.015,
          requirementSpecificMatch: true,
          obligationVariantRank: 1,
        },
      ],
    });

    expect(ranked[0]?.candidate.id).toBe("direct");
    expect(ranked[0]?.score.obligationFit).toBeGreaterThan(0);
  });
});
