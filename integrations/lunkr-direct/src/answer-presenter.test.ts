import { describe, expect, it } from "vitest";
import {
  normalizeCitationOrder,
  presentAnswer,
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
