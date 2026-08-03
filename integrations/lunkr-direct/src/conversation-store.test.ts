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

  it("isolates an immediate normalized repeat and never stores answer text", () => {
    const store = new ConversationStore(6, 1_000);
    store.append("#a#U", { question: "Coremail 优势有哪些？" });

    expect(store.context("#a#U", " coremail优势有哪些 ")).toBeUndefined();
    const context = store.context("#a#U", "继续说明");
    expect(context).toContain("Coremail 优势有哪些");
    expect(context).not.toContain("上一轮回答");
    expect(JSON.parse(context ?? "null")).toEqual({
      version: 2,
      recentUserQuestions: ["Coremail 优势有哪些？"],
    });
  });

  it("keeps serialized context within the configured character budget", () => {
    const store = new ConversationStore(6, 90);
    store.append("#a#U", { question: "第一条很长的问题".repeat(8) });
    store.append("#a#U", { question: "第二问" });

    const context = store.context("#a#U");
    expect(context?.length).toBeLessThanOrEqual(90);
    expect(() => JSON.parse(context ?? "")).not.toThrow();
    expect(context).toContain("第二问");
  });
});
