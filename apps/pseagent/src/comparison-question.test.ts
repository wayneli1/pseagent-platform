import { describe, expect, it } from "vitest";
import {
  isDirectComparisonQuestion,
  missingExplicitComparisonLabels,
} from "./comparison-question.js";

describe("comparison question", () => {
  it("recognizes 差别 as a direct comparison and requires both named choices", () => {
    const question = "POP3 和 IMAP 在文件夹、存储和同步上有什么差别？";

    expect(isDirectComparisonQuestion(question)).toBe(true);
    expect(missingExplicitComparisonLabels(
      question,
      "IMAP 可操作所有文件夹，邮件保留在服务器并同步。",
    )).toEqual(["pop3"]);
  });

  it("does not require another rewrite when both named choices remain explicit", () => {
    expect(missingExplicitComparisonLabels(
      "Alpha 与 Beta 有哪些差异？",
      "Alpha 使用本地存储，Beta 使用服务器存储。",
    )).toEqual([]);
  });
});
