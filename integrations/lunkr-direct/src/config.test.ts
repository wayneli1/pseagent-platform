import { describe, expect, it } from "vitest";
import { loadLunkrConfig } from "./config.js";

describe("loadLunkrConfig", () => {
  it("uses secure production defaults", () => {
    const config = loadLunkrConfig({});
    expect(config.baseUrl).toBe("https://lunkr.coremail.cn");
    expect(config.contextMaxTurns).toBe(6);
    expect(config.contextMaxChars).toBe(12_000);
    expect(config.messageMaxChars).toBe(1_000);
  });

  it("rejects insecure base URLs and invalid numbers", () => {
    expect(() => loadLunkrConfig({ LUNKR_BASE_URL: "http://example.test" }))
      .toThrow("HTTPS");
    expect(() => loadLunkrConfig({ LUNKR_CONTEXT_MAX_TURNS: "0" }))
      .toThrow("正整数");
    expect(() => loadLunkrConfig({ LUNKR_CONTEXT_MAX_TURNS: "1.5" }))
      .toThrow("正整数");
  });
});
