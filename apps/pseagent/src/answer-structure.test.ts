import { describe, expect, it } from "vitest";
import { hasDanglingCollectionEnumeration } from "./answer-structure.js";

describe("hasDanglingCollectionEnumeration", () => {
  it("detects a collection that stops after its first numbered item", () => {
    expect(hasDanglingCollectionEnumeration(
      "实施前需确认以下事项：1）确认用户所属组织。",
    )).toBe(true);
    expect(hasDanglingCollectionEnumeration(
      "主要步骤如下：一是核对版本。",
    )).toBe(true);
  });

  it("accepts complete and explicitly single-item collections", () => {
    expect(hasDanglingCollectionEnumeration(
      "实施前需确认以下事项：1）核对版本；2）核对实际配置。",
    )).toBe(false);
    expect(hasDanglingCollectionEnumeration(
      "当前唯一一个要求：1）核对版本。",
    )).toBe(false);
  });

  it("does not mistake ordinary prose or version numbers for an enumeration", () => {
    expect(hasDanglingCollectionEnumeration("请核对 v2.0 的实际配置。"))
      .toBe(false);
    expect(hasDanglingCollectionEnumeration("1）结论已经由正式资料确认。"))
      .toBe(false);
  });
});
