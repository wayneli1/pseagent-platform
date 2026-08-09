import { describe, expect, it } from "vitest";
import { explicitNamedMethods } from "./named-method.js";

describe("explicitNamedMethods", () => {
  it("extracts explicitly requested English methods and algorithms", () => {
    expect(explicitNamedMethods("怎样用 Mom Test 把赞美追问成事实？"))
      .toEqual(["momtest"]);
    expect(explicitNamedMethods("存在负权边时采用 Bellman-Ford 算法。"))
      .toEqual(["bellmanford"]);
  });

  it("extracts explicitly requested Chinese named methods", () => {
    expect(explicitNamedMethods("售前怎样用价值主张画布把客户任务与方案能力对齐？"))
      .toEqual(["价值主张画布"]);
    expect(explicitNamedMethods("请采用客户旅程地图梳理关键触点。"))
      .toEqual(["客户旅程地图"]);
  });

  it("does not treat incidental English product words as a method request", () => {
    expect(explicitNamedMethods("Coremail Outlook 插件如何同步日程？"))
      .toEqual([]);
  });
});
