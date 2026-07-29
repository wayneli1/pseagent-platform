import { describe, expect, it } from "vitest";
import {
  coverageVerificationMessages,
  knowledgeAgentMessages,
} from "./prompts.js";

function systemMessage(messages: ReturnType<typeof knowledgeAgentMessages>): string {
  return messages[0]?.content ?? "";
}

describe("support and existence semantics", () => {
  it("gives the agent a bounded related-context contract for omitted target claims", () => {
    const prompt = systemMessage(knowledgeAgentMessages({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
      schema: "schema",
      overview: "overview",
      plan: {
        subject: "Coremail 协议支持",
        requirements: [{
          id: "R1",
          question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
          queries: ["Coremail 2035 年量子卫星邮件协议支持"],
        }],
      },
      requirementEvidence: [],
      observations: [],
      references: [],
      remainingTurns: 1,
      remainingRetrievalActions: 0,
      finalOnly: true,
    }));

    expect(prompt).toContain('"relatedContext":[{"statement":"正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1][2]。","citations":[1,2]}]');
    expect(prompt).toContain("正文未提及目标只能得到“未覆盖、无法确认”，不能得到“不支持/尚未支持”");
    expect(prompt).toContain("正文明确支持才能回答支持，正文明确否定才能回答不支持");
    expect(prompt).toContain("同义词、缩略词或等价表达只有确认等价关系时才能作为证据");
    expect(prompt).toContain("“支持哪些/有哪些”只能列出正文明确项目，非穷尽列表不得声称完整");
    expect(prompt).toContain("最多三项、每项一到四个引用的 relatedContext");
    expect(prompt).toContain("仅在 coverage=none 时可以补充");
    expect(prompt).toContain("每个 statement 只能陈述正文直接确认的相邻事实");
    expect(prompt).toContain("也不得声称相关事实证明被遗漏的目标");
    expect(prompt).toContain("相关信息不得提升 coverage，目标 citations 仍必须为空");
    expect(prompt).toContain("量子卫星邮件协议");
    expect(prompt).toContain("正文只列 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP");
    expect(prompt).toContain("明确写“支持 IMAP”时才可回答支持 IMAP");
    expect(prompt).toContain("明确写“暂不支持 IMAP”时才可回答不支持 IMAP");
    expect(prompt).toContain("正文明确支持 SMTP、但未提及 IMAP 时，对“是否支持 SMTP 和 IMAP”只能标记 partial");
  });

  it("makes the verifier return only deterministic retain-or-drop decisions", () => {
    const prompt = systemMessage(coverageVerificationMessages({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
      plan: { requirements: [{ id: "R1" }] },
      draft: { requirements: [{ id: "R1" }] },
      evidence: [],
    }));

    expect(prompt).toContain("正文未提及目标必须选择 not_covered");
    expect(prompt).toContain("不得把草稿中的“不支持/尚未支持”保留下来");
    expect(prompt).toContain("只有明确支持或明确否定");
    expect(prompt).toContain("同义词、缩略词或等价表达必须有正文确认的等价关系");
    expect(prompt).toContain("非穷尽列表不得作为完整清单保留");
    expect(prompt).toContain("targetDecision=retain");
    expect(prompt).toContain("targetDecision=not_covered");
    expect(prompt).toContain("retainedRelatedContextIndexes");
    expect(prompt).toContain("索引从 0 开始，只能保留或删除，不能改写内容");
    expect(prompt).toContain("量子卫星邮件协议");
    expect(prompt).toContain("SMTP、POP3、IMAP");
    expect(prompt).toContain("顶层只能包含 action、requirements");
    expect(prompt).toContain(
      "每个 requirement 只能包含 id、targetDecision、retainedRelatedContextIndexes、reason",
    );
    expect(prompt).toContain(
      "不得输出或复制 coverage、answer、citations、statement、relatedContext 或顶层 citations",
    );
    expect(prompt).toContain(
      '{"action":"verify","requirements":[{"id":"R1","targetDecision":"not_covered","retainedRelatedContextIndexes":[0],"reason":"related_only"}]}',
    );
    expect(prompt).toContain("direct_support、explicit_negative_support、partial_support、related_only、target_omitted、unsupported_claim_removed");
  });
});
