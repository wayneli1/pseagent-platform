import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_PLAN_SYSTEM_PROMPT,
  coverageVerificationMessages,
  knowledgeAgentMessages,
} from "./prompts.js";

function systemMessage(messages: ReturnType<typeof knowledgeAgentMessages>): string {
  return messages[0]?.content ?? "";
}

describe("support and existence semantics", () => {
  it("makes the planner classify direct-only and synthesis-allowed evidence", () => {
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      '"evidenceMode":"direct_only|synthesis_allowed"',
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "岗位职责、方法论总结、多页面对比、方案组织、能力领域、综合分析和建议",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "支持性、存在性、明确否定、版本、兼容性、容量或性能数字、授权、报价、认证和穷举完整性",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不同事实风险必须拆成不同 requirement",
    );
  });

  it("gives the agent a bounded related-context contract for omitted target claims", () => {
    const prompt = systemMessage(knowledgeAgentMessages({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
      purpose: "knowledge purpose",
      schema: "schema",
      plan: {
        subject: "Coremail 协议支持",
        requirements: [{
          id: "R1",
          question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
          queries: ["Coremail 2035 年量子卫星邮件协议支持"],
          evidenceMode: "direct_only",
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

  it("keeps planning overview out of the answer agent context", () => {
    const messages = knowledgeAgentMessages({
      question: "售前工程师的工作职责有哪些？",
      purpose: "knowledge purpose",
      schema: "schema",
      plan: {
        subject: "售前职责",
        requirements: [{
          id: "R1",
          question: "售前工程师的工作职责有哪些",
          queries: ["售前 工作职责"],
          evidenceMode: "synthesis_allowed",
        }],
      },
      requirementEvidence: [],
      observations: [],
      references: [],
      remainingTurns: 1,
      remainingRetrievalActions: 6,
      finalOnly: false,
    });
    const prompt = systemMessage(messages);

    expect(prompt).toContain(
      "规划时使用的 overview 不是证据，不能作为最终引用",
    );
    expect(messages[1]?.content).not.toContain("planningOverview");
    expect(prompt).toContain(
      "synthesis_allowed 应从实际候选页收集不同证据面",
    );
    expect(prompt).toContain(
      "不得为了耗尽六页而读取重复页面",
    );
    expect(prompt).toContain(
      "direct_only 仍只接受实际读取正文的直接结论",
    );
    expect(prompt).toContain(
      "不得仅因缺少专门岗位说明页而降为 partial 或 none",
    );
    expect(prompt).toContain(
      "需求诊断、方案组织与价值表达、产品演示与技术证明、客户关系与可信顾问、冲突沟通与异议处理、机会管理与项目推进",
    );
    expect(prompt).toContain(
      "职责领域名称必须和对应说明、引用写在同一句段",
    );
  });

  it("makes the verifier retain only evidence-backed target segments", () => {
    const prompt = systemMessage(coverageVerificationMessages({
      question: "Coremail 是否已经支持 2035 年量子卫星邮件协议？",
      plan: { requirements: [{ id: "R1", evidenceMode: "synthesis_allowed" }] },
      draft: { requirements: [{ id: "R1" }] },
      targetSegments: [{
        id: "R1",
        segments: [{ index: 0, text: "目标结论 [1]。", citations: [1] }],
      }],
      evidence: [],
    }));

    expect(prompt).toContain("一个句段都没有正式支持时才选择 not_covered");
    expect(prompt).toContain("正文未提及目标不得保留对应句段");
    expect(prompt).toContain("只支持部分句段时选择 retain_partial");
    expect(prompt).toContain("同义词、缩略词或等价表达必须有正文确认的等价关系");
    expect(prompt).toContain("非穷尽列表不得作为完整清单保留");
    expect(prompt).toContain("岗位职责、方法论总结、多页面对比");
    expect(prompt).toContain("relatedContext 还必须直接缩小用户判断范围");
    expect(prompt).toContain("始终只能直接支持");
    expect(prompt).toContain("多篇正文冲突时只能保留明确披露冲突的句段");
    expect(prompt).toContain(
      "把方法论动作重新组织为岗位职责属于跨页归纳",
    );
    expect(prompt).toContain(
      "不得仅因缺少专门岗位说明页而把已充分覆盖的职责答案降为 partial",
    );
    expect(prompt).toContain(
      "冲突场景页可以支持“冲突沟通与异议处理”这一职责领域",
    );
    expect(prompt).toContain("targetDecision=retain");
    expect(prompt).toContain("targetDecision=retain_partial");
    expect(prompt).toContain("targetDecision=not_covered");
    expect(prompt).toContain("retainedTargetSegmentIndexes");
    expect(prompt).toContain("synthesizedTargetSegmentIndexes");
    expect(prompt).toContain("retainedRelatedContextIndexes");
    expect(prompt).toContain("索引从 0 开始，只能保留或删除，不能改写内容");
    expect(prompt).toContain("量子卫星邮件协议");
    expect(prompt).toContain("SMTP、POP3、IMAP");
    expect(prompt).toContain("顶层只能包含 action、requirements");
    expect(prompt).toContain(
      "每个 requirement 只能包含 id、targetDecision、retainedTargetSegmentIndexes、synthesizedTargetSegmentIndexes、retainedRelatedContextIndexes、reason",
    );
    expect(prompt).toContain(
      "不得输出或复制 coverage、answer、citations、statement、relatedContext 或顶层 citations",
    );
    expect(prompt).toContain(
      '{"action":"verify","requirements":[{"id":"R1","targetDecision":"retain_partial","retainedTargetSegmentIndexes":[0,2],"synthesizedTargetSegmentIndexes":[2],"retainedRelatedContextIndexes":[],"reason":"partial_support"}]}',
    );
    expect(prompt).toContain("direct_support、explicit_negative_support、synthesized_support、partial_support、related_only、target_omitted、unsupported_claim_removed");
  });
});
