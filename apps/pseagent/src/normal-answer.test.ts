import { describe, expect, it } from "vitest";
import { stripUnrequestedExamples } from "./normal-answer.js";

describe("stripUnrequestedExamples", () => {
  it("removes an optional constructed example while preserving the explanation", () => {
    const answer = [
      "关键前提是所有输入都满足约束。",
      "",
      "约束失效后，已经确定的结论可能被后续步骤推翻。例如 A→B 为 5，A→C 为 2。后续推导略。",
      "",
      "此时应改用允许重复修正的方案。",
    ].join("\n");

    expect(stripUnrequestedExamples("为什么原方案失效，应该换什么？", answer))
      .toBe([
        "关键前提是所有输入都满足约束。",
        "",
        "约束失效后，已经确定的结论可能被后续步骤推翻。",
        "",
        "此时应改用允许重复修正的方案。",
      ].join("\n"));
  });

  it("preserves examples when the user explicitly asks for one", () => {
    const answer = "核心机制如下。例如 A→B 可以说明这一点。";
    expect(stripUnrequestedExamples("请举一个例子说明", answer)).toBe(answer);
  });

  it("keeps ordinary answers that contain no example marker unchanged", () => {
    const answer = "先说明前提，再解释机制，最后给出适用边界。";
    expect(stripUnrequestedExamples("为什么？", answer)).toBe(answer);
  });
});
