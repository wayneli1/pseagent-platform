import { describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";

describe("ConversationStore", () => {
  it("isolates peers and keeps only bounded recent turns", () => {
    const store = new ConversationStore(2, 1_000);
    store.append("#a#U", { question: "A1" });
    store.append("#a#U", { question: "A2" });
    store.append("#a#U", { question: "A3" });
    store.append("#b#U", { question: "B1" });
    expect(store.context("#a#U")).not.toContain("A1");
    expect(store.context("#a#U")).toContain("A2");
    expect(store.context("#a#U")).toContain("A3");
    expect(store.context("#b#U")).toContain("B1");
    expect(store.context("#b#U")).not.toContain("A3");
  });

  it("clears one peer without affecting another", () => {
    const store = new ConversationStore(6, 1_000);
    store.append("#a#U", { question: "A" });
    store.append("#b#U", { question: "B" });
    store.clear("#a#U");
    expect(store.context("#a#U")).toBeUndefined();
    expect(store.context("#b#U")).toContain("B");
  });

  it("isolates an immediate normalized repeat and serializes structured turns", () => {
    const store = new ConversationStore(6, 1_000);
    store.append("#a#U", { question: "Coremail 优势有哪些？" });

    expect(store.context("#a#U", " coremail优势有哪些 ")).toBeUndefined();
    const context = store.context("#a#U", "继续说明");
    expect(context).toContain("Coremail 优势有哪些");
    expect(JSON.parse(context ?? "null")).toEqual({
      version: 3,
      recentTurns: [{ question: "Coremail 优势有哪些？" }],
    });
  });

  it("keeps a bounded answer outline for ordinal follow-ups and removes sources", () => {
    const store = new ConversationStore(6, 2_000);
    const answer = "1. 确认迁移范围\n2. 获取客户端专用密码\n3. 核对 IMAP/SMTP 开关\n\n资料来源：\nwiki/concepts/迁移.md";
    store.append("#a#U", { question: "迁移前要做什么？", answer });

    const context = store.context("#a#U", "把第二点展开说说") ?? "";
    const parsed = JSON.parse(context) as {version:number;recentTurns:Array<{question:string;answerOutline:string}>};
    expect(parsed.version).toBe(3);
    expect(parsed.recentTurns[0]?.answerOutline).toContain("2. 获取客户端专用密码");
    expect(context).not.toContain("资料来源");
    expect(context).not.toContain("wiki/");
  });

  it("keeps serialized context within the configured character budget", () => {
    const store = new ConversationStore(6, 90);
    store.append("#a#U", { question: "第一条很长的问题".repeat(8), answer: "第一条很长的回答".repeat(20) });
    store.append("#a#U", { question: "第二问", answer: "1. 第二问回答\n2. 第二项" });

    const context = store.context("#a#U");
    expect(context?.length).toBeLessThanOrEqual(90);
    expect(() => JSON.parse(context ?? "")).not.toThrow();
    expect(context).toContain("第二问");
  });
});
