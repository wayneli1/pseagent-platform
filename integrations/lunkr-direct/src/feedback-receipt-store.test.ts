import { describe, expect, it } from "vitest";
import {
  FeedbackReceiptStore,
  pseudonymizeFeedbackUser,
  type FeedbackReceipt,
} from "./feedback-receipt-store.js";

const requestId = "019fcd9f-cfb9-7c62-93a9-39b84c7e00f9";

describe("FeedbackReceiptStore", () => {
  it("isolates receipts by peer and expires original content", () => {
    let now = 1_000;
    const store = new FeedbackReceiptStore(100, 10, () => now);
    expect(store.remember("#a#U", receipt(1))).toBe(true);
    expect(store.claim("#b#U", 1)).toEqual({ kind: "missing" });
    now = 1_100;
    expect(store.claim("#a#U", 1)).toEqual({ kind: "missing" });
  });

  it("allows one in-flight claim, releases failures, and rejects a submitted duplicate", () => {
    const store = new FeedbackReceiptStore();
    store.remember("#a#U", receipt(1));

    const first = store.claim("#a#U", 1);
    expect(first.kind).toBe("claimed");
    expect(store.claim("#a#U", 1)).toEqual({ kind: "duplicate" });
    if (first.kind !== "claimed") throw new Error("claim expected");
    first.claim.settle(false);

    const retry = store.claim("#a#U", 1);
    expect(retry.kind).toBe("claimed");
    if (retry.kind !== "claimed") throw new Error("retry expected");
    retry.claim.settle(true);
    expect(store.claim("#a#U", 1)).toEqual({ kind: "duplicate" });
  });

  it("clears one peer without exposing or deleting another peer receipt", () => {
    const store = new FeedbackReceiptStore();
    store.remember("#a#U", receipt(1));
    store.remember("#b#U", receipt(1));

    store.clearPeer("#a#U");

    expect(store.claim("#a#U", 1)).toEqual({ kind: "missing" });
    expect(store.claim("#b#U", 1).kind).toBe("claimed");
  });

  it("creates a stable HMAC pseudonym without retaining the raw peer id", () => {
    const secret = "feedback-test-key-with-at-least-32-characters";
    const first = pseudonymizeFeedbackUser("#private-user#U", secret);
    const second = pseudonymizeFeedbackUser("#private-user#U", secret);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("private-user");
    expect(() => pseudonymizeFeedbackUser("#private-user#U", "weak"))
      .toThrow("feedback_pseudonymization_input_invalid");
  });
});

function receipt(questionId: number): FeedbackReceipt {
  return {
    questionId,
    requestId,
    question: "原始问题",
    answer: "原始回答",
    answerStatus: "answered",
    scope: "general",
    referenceCount: 2,
    answeredAt: "2026-08-05T00:00:00.000Z",
  };
}
