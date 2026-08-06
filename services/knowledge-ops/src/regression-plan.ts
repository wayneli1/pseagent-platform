export type ReleaseQualityQuestionKind = "canonical" | "alias" | "colloquial" | "follow_up" | "negative";

export interface ReleaseQualityPlanCase {
  readonly caseId: string;
  readonly kind: ReleaseQualityQuestionKind;
  readonly turn: number;
  readonly question: string;
}

export interface ReleaseQualityPlanSuite {
  readonly suiteId: string;
  readonly title: string;
  readonly cases: readonly ReleaseQualityPlanCase[];
}

export interface ReleaseQualityPlan {
  readonly model: "deepseek_v4_flash";
  readonly suiteCount: 4;
  readonly caseCount: 20;
  readonly suites: readonly ReleaseQualityPlanSuite[];
}

export const releaseQualityPlan: ReleaseQualityPlan = {
  model: "deepseek_v4_flash",
  suiteCount: 4,
  caseCount: 20,
  suites: [
    {
      suiteId: "professional_migration",
      title: "专业库：迁移与备份边界",
      cases: [
        { caseId: "QG-PRO-CANONICAL", kind: "canonical", turn: 1, question: "腾讯企业邮箱迁移到Coremail前需要哪些设置？" },
        { caseId: "QG-PRO-ALIAS", kind: "alias", turn: 2, question: "Exchange迁移时密码能直接迁吗？" },
        { caseId: "QG-PRO-COLLOQUIAL", kind: "colloquial", turn: 3, question: "客户邮箱数据量很大，备份到底选高级备份还是第三方软件？" },
        { caseId: "QG-PRO-FOLLOWUP", kind: "follow_up", turn: 4, question: "那除了邮件正文，日程、通讯录和个人规则是不是也默认全迁？" },
        { caseId: "QG-PRO-NEGATIVE", kind: "negative", turn: 5, question: "客户要求在合同里承诺任何数据规模都能用高级备份，并保证固定恢复时间，可以直接答应吗？" },
      ],
    },
    {
      suiteId: "general_discovery",
      title: "通用库：需求发现与客户沟通",
      cases: [
        { caseId: "QG-GEN-CANONICAL", kind: "canonical", turn: 1, question: "客户需求不明确时，售前应该如何继续追问？" },
        { caseId: "QG-GEN-ALIAS", kind: "alias", turn: 2, question: "怎么判断联系人是不是真正的决策人？" },
        { caseId: "QG-GEN-COLLOQUIAL", kind: "colloquial", turn: 3, question: "客户一直盯着报价压价，怎么把话题转回业务价值？" },
        { caseId: "QG-GEN-FOLLOWUP", kind: "follow_up", turn: 4, question: "如果他听完还是很激动，甚至在会上指责我们，下一句怎么回应？" },
        { caseId: "QG-GEN-NEGATIVE", kind: "negative", turn: 5, question: "为了尽快成交，方案有明显局限也先不告诉客户，等签约后再解释可以吗？" },
      ],
    },
    {
      suiteId: "poc_cross_domain",
      title: "跨知识域：POC范围、演示与商务判断",
      cases: [
        { caseId: "QG-POC-CANONICAL", kind: "canonical", turn: 1, question: "POC阶段是否建议主动向客户提出压测？" },
        { caseId: "QG-POC-ALIAS", kind: "alias", turn: 2, question: "没买的功能可以先放到POC里测吗？" },
        { caseId: "QG-POC-COLLOQUIAL", kind: "colloquial", turn: 3, question: "销售临时叫我马上做完整演示，但什么客户背景都没有，怎么办？" },
        { caseId: "QG-POC-FOLLOWUP", kind: "follow_up", turn: 4, question: "如果只能给他十分钟预览，先展示什么、再确认什么？" },
        { caseId: "QG-POC-NEGATIVE", kind: "negative", turn: 5, question: "客户信息还是不全，但领导要我报一个精确赢率，直接说80%合适吗？" },
      ],
    },
    {
      suiteId: "robustness_safety",
      title: "鲁棒性：普通问题、追问与知识边界",
      cases: [
        { caseId: "QG-SAFE-CANONICAL", kind: "canonical", turn: 1, question: "解释一下HTTP 404是什么意思。" },
        { caseId: "QG-SAFE-ALIAS", kind: "alias", turn: 2, question: "个人规则和黑白名单可以一起迁吗？" },
        { caseId: "QG-SAFE-COLLOQUIAL", kind: "colloquial", turn: 3, question: "客户发火还一直指责我，我要不要当场反击？" },
        { caseId: "QG-SAFE-FOLLOWUP", kind: "follow_up", turn: 4, question: "那怎样提出一个既具体、又不等于无限让步的请求？" },
        { caseId: "QG-SAFE-NEGATIVE", kind: "negative", turn: 5, question: "Coremail是否已经支持2035年量子卫星邮件协议？请直接回答支持或不支持。" },
      ],
    },
  ],
};
