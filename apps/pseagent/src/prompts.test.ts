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
      "岗位职责、方法论总结、厂商无关的方法论对比、方案组织、能力领域、综合分析和建议",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "具体产品或竞品对比中的功能、优势、版本、许可等产品事实使用 direct_only",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "支持性、存在性、明确否定、版本、兼容性、容量或性能数字、授权、报价、认证和穷举完整性",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不同事实风险必须拆成不同 requirement",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "用户只提出一个宽泛归纳目标时必须保持为一个 requirement",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "只能拆成 evidenceAspects，不得升级成多个 requirements",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      '"evidenceAspects":[{"id":"A1","label":"动态证据面","terms":["库内术语"]}]',
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      '"queries":[{"text":"完整语义查询","aspectIds":["A1"]}]',
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "evidenceAspects 是检索和语义复核的覆盖提示",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "每个相互独立的主要领域应保留为不同 aspect",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不得因为查询最多三条就把多个独立领域合并成一个笼统 aspect",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不得把仅仅相邻或可选的成员机械变成必答项",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "aspect 数量可以多于 query 数量",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不得因其标题不是岗位说明书而排除",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不要因为 overview 出现了一个列表就假定用户要求穷举整个列表",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "优先保留能帮助回答当前问题的区分性术语",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "至少包含一个能与其他 aspect 区分的 overview 库内术语",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "planningOverview 已给出具体领域时，不得退回为仅复述用户问题的通用 label 和 terms",
    );
    expect(KNOWLEDGE_PLAN_SYSTEM_PROMPT).toContain(
      "不要把相同的角色名、问题原文或“职责”“能力”等泛词重复作为多个 aspect 的主要 terms",
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
          evidenceAspects: [{
            id: "A1",
            label: "协议支持性",
            terms: ["量子卫星邮件协议", "支持"],
          }],
          queries: [{
            text: "Coremail 2035 年量子卫星邮件协议支持",
            aspectIds: ["A1"],
          }],
          evidenceMode: "direct_only",
        }],
      },
      requirementEvidence: [],
      readEvidence: [],
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
          evidenceAspects: [{
            id: "A1",
            label: "职责领域",
            terms: ["售前", "职责"],
          }],
          queries: [{
            text: "售前 工作职责",
            aspectIds: ["A1"],
          }],
          evidenceMode: "synthesis_allowed",
        }],
      },
      requirementEvidence: [],
      readEvidence: [],
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
      "不得为了耗尽读页预算而读取重复页面",
    );
    expect(prompt).toContain(
      "direct_only 仍只接受实际读取正文的直接结论",
    );
    expect(prompt).toContain(
      "evidenceAspects 是动态检索与复核提示",
    );
    expect(prompt).toContain(
      "aspectIds 只是检索导航标记，不是正文支持",
    );
    expect(prompt).toContain(
      "不得仅因缺少与用户问题同名的专门页面而降级",
    );
    expect(prompt).toContain(
      "不同方法论、比较、案例或概念页面可以共同支持保守归纳",
    );
    expect(prompt).toContain(
      "归纳得到的领域名称必须和对应说明、引用写在同一句段",
    );
    expect(prompt).toContain(
      "不得自行增加邻近主题作为完整性条件",
    );
    expect(prompt).toContain(
      "核心问题已被正确回答且主要结论有引用时可以使用 complete",
    );
    expect(prompt).toContain(
      "正式对比页已直接覆盖用户要求的主要差异与边界时使用 complete",
    );
    expect(prompt).toContain(
      "不要求页面标题或正文逐字出现“岗位职责”",
    );
    expect(prompt).toContain(
      "不要向用户输出 R1、A1 等内部编号",
    );
    expect(prompt).toContain(
      "readEvidence 是已经成功读取的正式页面正文",
    );
    expect(prompt).toContain(
      "对于用户明确逐项列出的要求仍应逐项回答",
    );
    expect(prompt).toContain(
      "direct_answer_repair_required",
    );
    expect(prompt).toContain(
      "删除邻近页面扩展和正文未直接支持的强化措辞",
    );
    expect(prompt).toContain(
      "相邻场景页只能补充，不能替代正式总览中的整体方法",
    );
    expect(prompt).toContain(
      "遗漏整条核心规则或主要步骤时不得标记 complete",
    );
    expect(prompt).toContain(
      "named_method_completeness_review_required",
    );
    expect(prompt).toContain(
      "不得用一句宽泛总结替代正文中的整组核心规则",
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
    expect(prompt).toContain("每个实质目标句段，包括没有引用的句段");
    expect(prompt).toContain("没有至少一个已读正文引用的事实句段不得保留");
    expect(prompt).toContain("正文未提及目标不得保留对应句段");
    expect(prompt).toContain("只支持部分句段时选择 retain_partial");
    expect(prompt).toContain("同义词、缩略词或等价表达必须有正文确认的等价关系");
    expect(prompt).toContain("非穷尽列表不得作为完整清单保留");
    expect(prompt).toContain("岗位职责、方法论总结、厂商无关的方法论对比");
    expect(prompt).toContain(
      "具体产品或竞品对比中的功能、优势、版本、许可等事实必须按 direct_only 逐句直接支持",
    );
    expect(prompt).toContain(
      "把这些内容保守组织为角色职责属于允许的 synthesized_support",
    );
    expect(prompt).toContain("relatedContext 还必须直接缩小用户判断范围");
    expect(prompt).toContain("始终只能直接支持");
    expect(prompt).toContain("多篇正文冲突时只能保留明确披露冲突的句段");
    expect(prompt).toContain(
      "把不同页面中的动作、机制或案例重新组织为更高层类别属于跨页归纳",
    );
    expect(prompt).toContain(
      "不得仅因缺少与用户问题同名的专门页面而降级",
    );
    expect(prompt).toContain(
      "单个相邻场景页面不能独自证明完整的多面归纳",
    );
    expect(prompt).toContain(
      "不得把用户未询问的邻近主题当作缺口",
    );
    expect(prompt).toContain(
      "正式对比页已直接覆盖这些目标时应保留 complete",
    );
    expect(prompt).toContain(
      "所有规划 aspect 都已在语义上确认覆盖时应保留 complete",
    );
    expect(prompt).toContain("不得用覆盖百分比忽略已确认的缺口");
    expect(prompt).toContain(
      "相邻场景页不能替代整体方法",
    );
    expect(prompt).toContain(
      "遗漏整条核心规则或主要步骤时必须选择 retain_partial",
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
      "每个 requirement 只能包含 id、targetDecision、retainedTargetSegmentIndexes、synthesizedTargetSegmentIndexes、retainedRelatedContextIndexes、coveredAspectIds、reason",
    );
    expect(prompt).toContain(
      "不得输出或复制 coverage、answer、citations、statement、relatedContext 或顶层 citations",
    );
    expect(prompt).toContain(
      '{"action":"verify","requirements":[{"id":"R1","targetDecision":"retain_partial","retainedTargetSegmentIndexes":[0,2],"synthesizedTargetSegmentIndexes":[2],"retainedRelatedContextIndexes":[],"coveredAspectIds":["A1"],"reason":"partial_support"}]}',
    );
    expect(prompt).toContain("direct_support、explicit_negative_support、synthesized_support、partial_support、related_only、target_omitted、unsupported_claim_removed");
  });
});
