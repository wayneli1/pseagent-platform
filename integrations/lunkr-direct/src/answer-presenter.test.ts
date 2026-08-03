import { describe, expect, it } from "vitest";
import {
  normalizeAnswerText,
  normalizeCitationOrder,
  presentAnswer,
  presentLongAnswerNotice,
} from "./answer-presenter.js";

describe("presentAnswer", () => {
  it("prefixes a short answer with its question id", () => {
    expect(presentAnswer(13, "简短回答", 1_000)).toEqual([
      "问题 #13 的回答：\n\n简短回答",
    ]);
  });

  it("labels every long-answer chunk and keeps it inside the transport limit", () => {
    const chunks = presentAnswer(13, [
      "第一段。".repeat(30),
      "",
      "第二段。".repeat(30),
    ].join("\n"), 80);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, index) => {
      expect(chunk.startsWith(
        `问题 #13（${index + 1}/${chunks.length}）\n\n`,
      )).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(80);
    });
  });

  it("keeps normal markdown list items intact", () => {
    const items = [
      "1. 第一项包含完整说明和一个明确结论。",
      "2. 第二项包含完整说明和一个明确结论。",
      "3. 第三项包含完整说明和一个明确结论。",
    ];
    const chunks = presentAnswer(
      2,
      ["建议：", "", ...items].join("\n"),
      60,
    );

    for (const item of items) {
      expect(chunks.some((chunk) => chunk.includes(item))).toBe(true);
    }
  });

  it("keeps a bounded source block together", () => {
    const sources = [
      "资料来源：",
      "[1] 第一来源 — general/a.md",
      "[2] 第二来源 — general/b.md",
    ].join("\n");
    const chunks = presentAnswer(
      4,
      `${"正文。".repeat(30)}\n\n${sources}`,
      100,
    );

    expect(chunks.some((chunk) => chunk.includes(sources))).toBe(true);
  });

  it("sorts adjacent citations and source entries without renumbering", () => {
    const answer = [
      "结论 [2][1][2]。",
      "",
      "资料来源：",
      "[2] 第二来源 — presales-general/b.md",
      "[1] 第一来源 — presales-general/a.md",
    ].join("\n");
    const rendered = presentAnswer(7, answer, 1_000).join("\n");

    expect(rendered).toContain("结论 [1][2]。");
    expect(rendered.indexOf("[1] 第一来源"))
      .toBeLessThan(rendered.indexOf("[2] 第二来源"));
  });

  it("normalizes the body shared by text messages and native posts", () => {
    expect(normalizeAnswerText("  结论 [2][1]\r\n\r\n正文  ")).toBe(
      "结论 [1][2]\n\n正文",
    );
  });

  it("preserves non-whitespace body character order across chunks", () => {
    const answer = [
      "甲段包含若干文字和句号。",
      "",
      "乙段也包含若干文字和句号。",
      "",
      "丙段作为最后一段。",
    ].join("\n");
    const chunks = presentAnswer(9, answer, 35);
    const reconstructed = chunks
      .map((chunk) => chunk.replace(/^问题 #9（\d+\/\d+）\n\n/u, ""))
      .join("");

    expect(reconstructed.replace(/\s/gu, ""))
      .toBe(normalizeCitationOrder(answer).replace(/\s/gu, ""));
  });

  it("falls back to hard boundaries only for one oversized indivisible block", () => {
    const chunks = presentAnswer(1, "甲".repeat(100), 30);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
    expect(chunks
      .map((chunk) => chunk.replace(/^问题 #1（\d+\/\d+）\n\n/u, ""))
      .join("")).toBe("甲".repeat(100));
  });

  it("reserves enough prefix space for a double-digit total", () => {
    const chunks = presentAnswer(88, "甲".repeat(500), 35);

    expect(chunks.length).toBeGreaterThan(9);
    chunks.forEach((chunk, index) => {
      expect(chunk.startsWith(
        `问题 #88（${index + 1}/${chunks.length}）\n\n`,
      )).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(35);
    });
  });
});

describe("presentLongAnswerNotice", () => {
  it("summarizes two to four actual answer headings", () => {
    const answer = [
      "# Coremail 压力测试方案",
      "正文。",
      "## 压测场景设计",
      "正文。",
      "三、关键性能指标",
      "正文。",
      "**协议服务分析**",
      "正文。",
      "资料来源：",
      "[1] 资料",
    ].join("\n");

    expect(presentLongAnswerNotice(7, "如何进行压力测试？", answer)).toBe([
      "问题 #7 已处理完成",
      "本次回答涵盖：Coremail 压力测试方案、压测场景设计、关键性能指标、协议服务分析。完整内容见附件。",
    ].join("\n"));
  });

  it("falls back to a normalized question subject when headings are absent", () => {
    expect(presentLongAnswerNotice(
      2,
      "  Coremail 如何设计压测场景并分析结果？  ",
      "这是一段没有章节标题的完整回答。".repeat(20),
    )).toBe([
      "问题 #2 已处理完成",
      "本次回答围绕「Coremail 如何设计压测场景并分析结果」展开，完整内容见附件。",
    ].join("\n"));
  });

  it("deduplicates headings, excludes source headings, and bounds the notice", () => {
    const notice = presentLongAnswerNotice(3, "问题", [
      "## 场景设计",
      "## 场景设计",
      "## 这是一个非常非常非常非常非常非常长的性能指标章节标题",
      "## 监控与分析",
      "## 调优建议",
      "## 额外内容",
      "## 参考资料",
    ].join("\n"));

    expect(notice.match(/场景设计/gu)).toHaveLength(1);
    expect(notice).not.toContain("参考资料");
    expect(notice).not.toContain("额外内容");
    expect(notice.length).toBeLessThanOrEqual(100);
  });
});
