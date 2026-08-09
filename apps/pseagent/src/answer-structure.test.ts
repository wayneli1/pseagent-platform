import { describe, expect, it } from "vitest";
import {
  collectionEnumerationIssue,
  hasBrokenCollectionEnumeration,
} from "./answer-structure.js";

describe("collection enumeration integrity", () => {
  it("detects a collection that stops after its first numbered item", () => {
    expect(collectionEnumerationIssue(
      "实施前需确认以下事项：1）确认用户所属组织。",
    )).toBe("dangling_first_item");
    expect(collectionEnumerationIssue(
      "主要步骤如下：一是核对版本。",
    )).toBe("dangling_first_item");
    expect(collectionEnumerationIssue(
      "网络层面需要检查：1) nginx 节点具备 DNS 能力。",
    )).toBe("dangling_first_item");
    expect(collectionEnumerationIssue(
      "- **核心规则**：1) 谈客户的生活而不是你的想法 [1]；\n- **识别坏数据**：继续说明其他内容。",
    )).toBe("dangling_first_item");
  });

  it("detects a collection whose numeric or Chinese ordinals skip an item", () => {
    expect(collectionEnumerationIssue(
      "实施前需确认以下事项：1）核对组织；2）核对版本；4）核对配置。",
    )).toBe("non_contiguous_ordinals");
    expect(collectionEnumerationIssue(
      "实施事项如下：一是核对组织；二是核对版本；四是核对配置。",
    )).toBe("non_contiguous_ordinals");
  });

  it("accepts complete and explicitly single-item collections", () => {
    expect(hasBrokenCollectionEnumeration(
      "实施前需确认以下事项：1）核对版本；2）核对实际配置。",
    )).toBe(false);
    expect(hasBrokenCollectionEnumeration(
      "当前唯一一个要求：1）核对版本。",
    )).toBe(false);
  });

  it("does not mistake ordinary prose or version numbers for an enumeration", () => {
    expect(hasBrokenCollectionEnumeration("请核对 v2.0 的实际配置。"))
      .toBe(false);
    expect(hasBrokenCollectionEnumeration("1）结论已经由正式资料确认。"))
      .toBe(false);
  });
});
