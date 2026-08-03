import { describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";

describe("ConversationStore", () => {
  it("isolates peers and keeps only bounded recent turns", () => {
    const store = new ConversationStore(2, 1_000);
    store.append("#a#U", { question: "A1", answer: "RA1" });
    store.append("#a#U", { question: "A2", answer: "RA2" });
    store.append("#a#U", { question: "A3", answer: "RA3" });
    store.append("#b#U", { question: "B1", answer: "RB1" });
    expect(store.context("#a#U")).not.toContain("A1");
    expect(store.context("#a#U")).toContain("A2");
    expect(store.context("#a#U")).toContain("A3");
    expect(store.context("#b#U")).toContain("B1");
    expect(store.context("#b#U")).not.toContain("A3");
  });

  it("clears one peer without affecting another", () => {
    const store = new ConversationStore(6, 1_000);
    store.append("#a#U", { question: "A", answer: "RA" });
    store.append("#b#U", { question: "B", answer: "RB" });
    store.clear("#a#U");
    expect(store.context("#a#U")).toBeUndefined();
    expect(store.context("#b#U")).toContain("B");
  });

  it("isolates an immediate normalized repeat from its previous answer", () => {
    const store = new ConversationStore(6, 1_000);
    store.append("#a#U", {
      question: "Coremail 优势有哪些？",
      answer: "上一轮回答",
    });

    expect(store.context("#a#U", " coremail优势有哪些 ")).toBeUndefined();
    expect(store.context("#a#U", "继续说明")).toContain("上一轮回答");
  });
});
