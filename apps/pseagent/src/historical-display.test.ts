import { describe, expect, it } from "vitest";
import { sanitizeHistoricalBody } from "./historical-display.js";

describe("historical display", () => {
  it("removes operator instructions, command prompts, internal paths, and internal tool names", () => {
    const value = [
      "AIHUB 通过网关连接模型服务。",
      "下一步：Use get_wiki_page with a larger maxChars.",
      "补充路径：\\\\172.16.4.66\\release\\CMAI\\latest",
      "[root @localhost coremail]# /home/coremail/bin/sautil license",
      "授权字段：[REDACTED]",
      "必要时查询 Coremail MCP。",
    ].join("\n");

    const result = sanitizeHistoricalBody(value);

    expect(result).toContain("AIHUB 通过网关连接模型服务");
    expect(result).toContain("[内部路径已省略]");
    expect(result).toContain("进一步核实正式资料");
    expect(result).not.toMatch(/get_wiki_page|root @|sautil|REDACTED|Coremail MCP/u);
  });
});
