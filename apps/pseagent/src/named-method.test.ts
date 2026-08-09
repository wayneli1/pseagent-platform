import { describe, expect, it } from "vitest";
import { explicitNamedMethods } from "./named-method.js";

describe("explicitNamedMethods", () => {
  it("extracts explicitly requested English methods and algorithms", () => {
    expect(explicitNamedMethods("怎样用 Mom Test 把赞美追问成事实？"))
      .toEqual(["momtest"]);
    expect(explicitNamedMethods("存在负权边时采用 Bellman-Ford 算法。"))
      .toEqual(["bellmanford"]);
  });

  it("does not treat incidental English product words as a method request", () => {
    expect(explicitNamedMethods("Coremail Outlook 插件如何同步日程？"))
      .toEqual([]);
  });
});
