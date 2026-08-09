import { describe, expect, it } from "vitest";
import { normalAnswerNeedsRepair, stripUnrequestedExamples } from "./normal-answer.js";

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

  it("does not cut a required example out of the middle of a dependent clause", () => {
    const answer = "如果图中存在环，例如 A→B→A，则环内节点的入度无法全部降为 0。";
    expect(stripUnrequestedExamples("为什么拓扑排序要求有向无环图？", answer))
      .toBe(answer);
  });

  it("keeps ordinary answers that contain no example marker unchanged", () => {
    const answer = "先说明前提，再解释机制，最后给出适用边界。";
    expect(stripUnrequestedExamples("为什么？", answer)).toBe(answer);
  });

  it("detects an unclosed delimiter in a truncated ordinary answer", () => {
    expect(normalAnswerNeedsRepair("关键机制：\n- 如果图中存在环（。\n\n因此不适用。"))
      .toBe(true);
    expect(normalAnswerNeedsRepair("关键机制：每轮移除一个入度为 0 的节点；有环时不存在这种节点。"))
      .toBe(false);
  });

  it("detects an empty clause left between consecutive punctuation", () => {
    expect(normalAnswerNeedsRepair(
      "核心机制：\n- 如果图中存在环，。\n\n因此排序无解。",
    )).toBe(true);
    expect(normalAnswerNeedsRepair(
      "核心机制：如果图中存在环，环内节点的入度无法降为 0。",
    )).toBe(false);
  });
});
