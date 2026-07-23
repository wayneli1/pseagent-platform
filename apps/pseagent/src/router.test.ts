import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { ROUTE_SYSTEM_PROMPT } from "./prompts.js";
import { ScopeRouter } from "./router.js";

describe("ScopeRouter", () => {
  it("puts the complete strict route contract in the model prompt", () => {
    expect(ROUTE_SYSTEM_PROMPT).toContain(
      '{"action":"route","scope":"professional|general|normal"}',
    );
  });

  it.each([
    ["Coremail XT6 怎么部署？", "professional"],
    ["怎样向银行客户介绍 Coremail 容灾方案？", "professional"],
    ["如何做厂商无关的售前需求访谈？", "general"],
    ["帮我写一个 JavaScript 数组去重函数", "normal"],
  ] as const)("routes %s to %s", async (_question, expected) => {
    const completeJson = vi.fn(async () => ({ action: "route", scope: expected }));
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;
    await expect(new ScopeRouter(model).route(_question)).resolves.toBe(expected);
  });

  it("repairs one invalid route and never silently downgrades", async () => {
    const completeJson = vi.fn()
      .mockRejectedValueOnce(new InvalidModelPayloadError())
      .mockResolvedValueOnce({ action: "route", scope: "professional" });
    const model = { completeJson, completeText: vi.fn() } as unknown as ModelClient;
    await expect(new ScopeRouter(model).route("Coremail")).resolves.toBe("professional");
    expect(completeJson).toHaveBeenCalledTimes(2);
  });
});
