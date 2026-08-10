import { describe, expect, it } from "vitest";
import {
  explicitComparisonSubjects,
  isDirectComparisonQuestion,
  missingExplicitComparisonLabels,
} from "./comparison-question.js";

describe("comparison question", () => {
  it("extracts mixed-language comparison subjects without product aliases", () => {
    expect(explicitComparisonSubjects(
      "找一下 AIHUB 和 Coremail AI系统的功能区别：两者分别解决什么问题？",
    )).toEqual(["AIHUB", "Coremail AI系统"]);
    expect(explicitComparisonSubjects(
      "POP3 和 IMAP 在文件夹、存储和同步上有什么区别？",
    )).toEqual(["POP3", "IMAP"]);
  });

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
