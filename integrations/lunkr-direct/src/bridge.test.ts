import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import type { LunkrDirectMessage } from "./contracts.js";
import { LunkrPseBridge } from "./bridge.js";

const config: LunkrDirectConfig = {
  baseUrl: "https://lunkr.example.test",
  apiPath: "/lunkr/s/json",
  sessionPath: "unused",
  connectTimeoutMs: 1_000,
  reconnectMaxMs: 1_000,
  messageDedupeTtlMs: 60_000,
  messageDedupeMax: 100,
  contextMaxTurns: 6,
  contextMaxChars: 12_000,
  messageMaxChars: 1_000,
};

describe("LunkrPseBridge", () => {
  it("calls PSEAgent exactly once and passes the next-turn context", async () => {
    const answer = vi.fn(async (question: string, context?: string) => ({
      answer: `${question}:${context ?? "empty"}`,
    }));
    const sendText = vi.fn(async () => undefined);
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText,
    });
    await bridge.handle(message("m1", "#a#U", "第一问"));
    await bridge.handle(message("m2", "#a#U", "第二问"));
    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[0]?.[1]).toBeUndefined();
    expect(answer.mock.calls[1]?.[1]).toContain("第一问");
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("deduplicates messages without re-answering", async () => {
    const answer = vi.fn(async () => ({ answer: "回答" }));
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText: vi.fn(async () => undefined),
    });
    const duplicate = message("same", "#a#U", "问题");
    await Promise.all([bridge.handle(duplicate), bridge.handle(duplicate)]);
    expect(answer).toHaveBeenCalledOnce();
  });

  it("serializes one peer while allowing another peer to run", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const answer = vi.fn(async (question: string) => {
      order.push(`start:${question}`);
      if (question === "A1") await first;
      order.push(`end:${question}`);
      return { answer: question };
    });
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText: vi.fn(async () => undefined),
    });
    const a1 = bridge.handle(message("a1", "#a#U", "A1"));
    const a2 = bridge.handle(message("a2", "#a#U", "A2"));
    const b1 = bridge.handle(message("b1", "#b#U", "B1"));
    await vi.waitFor(() => expect(order).toContain("end:B1"));
    expect(order).not.toContain("start:A2");
    releaseFirst();
    await Promise.all([a1, a2, b1]);
    expect(order.indexOf("end:A1")).toBeLessThan(order.indexOf("start:A2"));
  });

  it("handles commands and attachments without calling PSEAgent", async () => {
    const answer = vi.fn(async (_question: string, _context?: string) => ({
      answer: "不应调用",
    }));
    const sendText = vi.fn(async (_peerUid: string, _text: string) => undefined);
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText,
    });
    await bridge.handle(message("help", "#a#U", "/help"));
    await bridge.handle(message("new", "#a#U", "/new"));
    await bridge.handle({ ...message("file", "#a#U", ""), hasAttachments: true });
    expect(answer).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText.mock.calls[2]?.[1]).toContain("仅支持文字");
  });

  it("retries sending without re-answering and does not store failed answers", async () => {
    const answer = vi.fn(async (question: string, _context?: string) => ({
      answer: `回答:${question}`,
    }));
    const sendText = vi.fn(async (_peerUid: string, _text: string) => undefined)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText,
    });
    await bridge.handle(message("m1", "#a#U", "问题"));
    await bridge.handle(message("m2", "#a#U", "追问"));
    expect(answer).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(answer.mock.calls[1]?.[1]).toContain("问题");
  });

  it("returns a fixed failure reply without adding failed context", async () => {
    const answer = vi.fn(async (_question: string, _context?: string) => ({
      answer: "恢复",
    }))
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValue({ answer: "恢复" });
    const sendText = vi.fn(async (_peerUid: string, _text: string) => undefined);
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => result.answer,
      sendText,
    });
    await bridge.handle(message("m1", "#a#U", "失败问题"));
    await bridge.handle(message("m2", "#a#U", "新问题"));
    expect(sendText.mock.calls[0]?.[1]).toContain("暂时不可用");
    expect(answer.mock.calls[1]?.[1]).toBeUndefined();
  });
});

function message(
  id: string,
  peerUid: string,
  text: string,
): LunkrDirectMessage {
  return {
    id,
    peerUid,
    senderUid: peerUid,
    timestamp: Date.now(),
    text,
    hasAttachments: false,
  };
}
