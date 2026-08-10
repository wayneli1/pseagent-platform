import { describe, expect, it } from "vitest";
import {
  collectionEnumerationIssue,
  firstOrderedItemValue,
  hasBrokenCollectionEnumeration,
  missingExplicitFrameworkItems,
  missingDirectQueryOperationalConditions,
  missingStrictFrameworkBoundaries,
  usesExplicitFrameworkCollection,
  verifierOrphanedOrderedSequence,
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

  it("detects a list that declares more items than it actually returns", () => {
    expect(collectionEnumerationIssue(
      "具体五步结构为：1. 暂停推进。",
    )).toBe("declared_count_incomplete");
    expect(collectionEnumerationIssue(
      "三项检查为：1）核对组织；2）核对版本。",
    )).toBe("declared_count_incomplete");
  });

  it("accepts complete and explicitly single-item collections", () => {
    expect(hasBrokenCollectionEnumeration(
      "实施前需确认以下事项：1）核对版本；2）核对实际配置。",
    )).toBe(false);
    expect(hasBrokenCollectionEnumeration(
      "具体三步结构为：1）暂停；2）陈述信号；3）提出核验问题。",
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

  it("detects when verification removes the beginning of an ordered sequence", () => {
    const draft = "1. 经济角色 [1]。\n2. 用户角色 [1]。\n3. 技术角色 [1]。\n4. Coach [1]。";
    const verified = "4. Coach [1]。\n角色判断需要持续验证 [1]。";

    expect(firstOrderedItemValue(draft)).toBe(1);
    expect(firstOrderedItemValue(verified)).toBe(4);
    expect(verifierOrphanedOrderedSequence(draft, verified)).toBe(true);
    expect(verifierOrphanedOrderedSequence(draft, draft)).toBe(false);
  });

  it("detects a missing sibling from a formally enumerated framework", () => {
    const evidence = [{
      content: "该结构包括 **Do the Last Thing First**（先展示最终结果）、**Illustration**（简洁画面）和 **Inverted Pyramid**（倒金字塔结构）三个相互配合的方法。",
    }];
    expect(missingExplicitFrameworkItems(
      "采用 Do the Last Thing First 建立相关性，再用 Inverted Pyramid 控制密度。",
      evidence,
    )).toEqual(["Illustration"]);
    expect(missingExplicitFrameworkItems(
      "先展示最终结果，再用简洁画面情境化，最后按 Inverted Pyramid 深入。",
      evidence,
    )).toEqual([]);
    expect(missingExplicitFrameworkItems(
      "Inverted Pyramid 是先结论后细节。",
      evidence,
    )).toEqual([]);
    expect(usesExplicitFrameworkCollection(
      "先展示最终结果，再用倒金字塔结构控制信息密度。",
      evidence,
    )).toBe(true);
    expect(usesExplicitFrameworkCollection(
      "只解释 Inverted Pyramid。",
      evidence,
    )).toBe(false);
  });

  it("detects missing siblings from an unnumbered formal checklist", () => {
    const evidence = [{
      content: "资料列出的检查对象包括发信 IP 规则、发件人规则、组织白名单、关键字规则、用户白名单、用户黑名单和 CAC 检查。",
    }];
    expect(missingExplicitFrameworkItems(
      "先检查组织白名单和 CAC 检查结果。",
      evidence,
    )).toEqual([
      "发信 IP 规则",
      "发件人规则",
      "关键字规则",
      "用户白名单",
      "用户黑名单",
    ]);
    expect(missingExplicitFrameworkItems(
      "依次检查发信 IP 规则、发件人规则、组织白名单、关键字规则、用户白名单、用户黑名单和 CAC 检查。",
      evidence,
    )).toEqual([]);
  });

  it("detects strict boundaries omitted from a broadly used framework", () => {
    const evidence = [{ content: [
      "该结构包括 **Do the Last Thing First**（先展示最终结果）、**Illustration**（简洁画面）和 **Inverted Pyramid**（倒金字塔结构）三个相互配合的方法。",
      "### 边界与风险",
      "- 对监管、数据或流程高度敏感时需使用脱敏或示意环境",
      "- 不能为了制造惊喜而跳过必要背景",
      "## Illustration",
      "### 关键原则",
      "- 画面必须与客户问题直接相关",
      "- 不能用虚构客户数据暗示已实现的承诺",
    ].join("\n") }, {
      content: [
        "这里是相邻的演示建议页面。",
        "### 注意事项",
        "- 必须先确认现场设备",
      ].join("\n"),
    }];
    const broad =
      "先展示最终结果，用 Illustration 简洁画面情境化，再以倒金字塔结构深入。";
    expect(missingStrictFrameworkBoundaries(broad, evidence)).toEqual([
      "对监管、数据或流程高度敏感时需使用脱敏或示意环境",
      "不能为了制造惊喜而跳过必要背景",
      "画面必须与客户问题直接相关",
      "不能用虚构客户数据暗示已实现的承诺",
    ]);
    expect(missingStrictFrameworkBoundaries(
      `${broad}敏感内容使用脱敏或示意环境；不跳过必要背景；画面必须与客户问题直接相关；不能用虚构客户数据暗示承诺。`,
      evidence,
    )).toEqual([]);
    expect(missingStrictFrameworkBoundaries(
      "只解释 Inverted Pyramid。",
      evidence,
    )).toEqual([]);
  });

  it("detects an omitted conditional action from a direct query page", () => {
    const evidence = [{
      path: "wiki/queries/outlook-sync.md",
      content: "在高级设置中配置共享权限。插件语言切换后需要重启 Outlook。",
    }];
    expect(missingDirectQueryOperationalConditions(
      "配置共享权限后即可使用 Outlook。",
      evidence,
    )).toEqual(["插件语言切换后需要重启 Outlook"]);
    expect(missingDirectQueryOperationalConditions(
      "配置共享权限；切换插件语言后需重启 Outlook。",
      evidence,
    )).toEqual([]);
  });

  it("ignores answer-card frontmatter and list lead-ins when detecting operational conditions", () => {
    const evidence = [{
      path: "wiki/queries/tencent-migration.md",
      content: [
        "---",
        "aliases:",
        "  - 完成这些准备后，下一步还需要确认什么？",
        "---",
        "根据当前资料，迁移前至少需要完成以下旧系统准备：先登录旧邮箱；开启安全登录；启用 IMAP/SMTP。",
      ].join("\n"),
    }];

    expect(missingDirectQueryOperationalConditions(
      "迁移前需登录旧邮箱、开启安全登录并启用 IMAP/SMTP。",
      evidence,
    )).toEqual([]);
    expect(missingDirectQueryOperationalConditions(
      "当前资料只说明迁移范围边界。",
      evidence,
    )).toEqual([]);
  });

  it("requires an explicit evidence boundary before presenting a formal list", () => {
    const evidence = [{ content: [
      "应同时检查发信 IP 规则、发件人规则、组织白名单和 CAC 检查。",
      "材料中的规则高低排列不足以证明完整、固定的优先级。",
      "不得据此生成确定性优先级表。",
    ].join("\n") }];
    expect(missingStrictFrameworkBoundaries(
      "按优先级检查发信 IP 规则、发件人规则、组织白名单和 CAC；该顺序并非在所有场景都绝对有效。",
      evidence,
    )).toEqual([
      "材料中的规则高低排列不足以证明完整、固定的优先级",
      "不得据此生成确定性优先级表",
    ]);
    expect(missingStrictFrameworkBoundaries(
      "检查发信 IP 规则、发件人规则、组织白名单和 CAC；材料排列不足以证明完整固定优先级，不能据此生成确定性优先级表。",
      evidence,
    )).toEqual([]);
  });
});
