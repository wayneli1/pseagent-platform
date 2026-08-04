import { describe, expect, it } from "vitest";
import { loadLunkrConfig } from "./config.js";

describe("loadLunkrConfig", () => {
  it("uses secure production defaults", () => {
    const config = loadLunkrConfig({});
    expect(config.baseUrl).toBe("https://lunkr.coremail.cn");
    expect(config.passwordPath).toContain("password.dpapi.json");
    expect(config.contextMaxTurns).toBe(6);
    expect(config.contextMaxChars).toBe(12_000);
    expect(config.messageMaxChars).toBe(1_000);
    expect(config.questionBudgetMs).toBe(300_000);
    expect(config.maxActivePeers).toBe(4);
    expect(config.maxPendingPerPeer).toBe(5);
    expect(config.sessionIdleMs).toBe(86_400_000);
    expect(config.feedbackReceiptTtlMs).toBe(30 * 60_000);
    expect(config.feedbackReceiptMax).toBe(2_000);
  });

  it("loads a bounded question budget", () => {
    expect(loadLunkrConfig({
      LUNKR_QUESTION_BUDGET_MS: "600000",
    }).questionBudgetMs).toBe(600_000);
    expect(() => loadLunkrConfig({ LUNKR_QUESTION_BUDGET_MS: "29999" }))
      .toThrow("LUNKR_QUESTION_BUDGET_MS");
    expect(() => loadLunkrConfig({ LUNKR_QUESTION_BUDGET_MS: "1800001" }))
      .toThrow("LUNKR_QUESTION_BUDGET_MS");
  });

  it("rejects insecure base URLs and invalid numbers", () => {
    expect(() => loadLunkrConfig({ LUNKR_BASE_URL: "http://example.test" }))
      .toThrow("HTTPS");
    expect(() => loadLunkrConfig({ LUNKR_CONTEXT_MAX_TURNS: "0" }))
      .toThrow("正整数");
    expect(() => loadLunkrConfig({ LUNKR_CONTEXT_MAX_TURNS: "1.5" }))
      .toThrow("正整数");
  });

  it("loads positive peer concurrency limits", () => {
    expect(loadLunkrConfig({
      LUNKR_MAX_ACTIVE_PEERS: "3",
      LUNKR_MAX_PENDING_PER_PEER: "7",
    })).toMatchObject({
      maxActivePeers: 3,
      maxPendingPerPeer: 7,
    });
    expect(() => loadLunkrConfig({ LUNKR_MAX_ACTIVE_PEERS: "0" }))
      .toThrow("正整数");
    expect(() => loadLunkrConfig({ LUNKR_MAX_PENDING_PER_PEER: "-1" }))
      .toThrow("正整数");
  });

  it("allows an explicit DPAPI password store path", () => {
    expect(loadLunkrConfig({
      LUNKR_PASSWORD_PATH: "C:\\secure\\lunkr-password.json",
    }).passwordPath).toBe("C:\\secure\\lunkr-password.json");
  });

  it("loads a positive session idle duration", () => {
    expect(loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "2500" }).sessionIdleMs)
      .toBe(2_500);
    expect(() => loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "0" }))
      .toThrow("正整数");
    expect(() => loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "1.5" }))
      .toThrow("正整数");
  });

  it("bounds short-lived feedback receipt retention", () => {
    const config = loadLunkrConfig({
      LUNKR_FEEDBACK_RECEIPT_TTL_MS: "60000",
      LUNKR_FEEDBACK_RECEIPT_MAX: "25",
    });
    expect(config.feedbackReceiptTtlMs).toBe(60_000);
    expect(config.feedbackReceiptMax).toBe(25);
    expect(() => loadLunkrConfig({
      LUNKR_FEEDBACK_RECEIPT_TTL_MS: "59999",
    })).toThrow("介于");
    expect(() => loadLunkrConfig({
      LUNKR_FEEDBACK_RECEIPT_MAX: "100001",
    })).toThrow("介于");
  });
});
