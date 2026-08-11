import type { AnswerResult, Scope } from "./contracts.js";

type ProhibitedRequestRule = {
  readonly id: string;
  readonly scope: Exclude<Scope, "normal">;
  readonly all: readonly RegExp[];
  readonly answer: string;
};

const TECHNICAL_REFUSAL = [
  "不能协助执行该请求，因为它会绕过授权、安全控制或审计边界。",
  "可以改为：在隔离测试环境中使用脱敏数据和临时凭据，经过变更审批后按最小权限实施，并完整保留审计记录。",
  "如果相关操作已经发生，请停止继续传播或修改，保全原始记录，并立即交由安全负责人和系统责任人复核。",
].join("\n");

const INTEGRITY_REFUSAL = [
  "不能协助伪造、删除或隐瞒原始事实和失败记录。",
  "应保留原始样本、日志和审批轨迹，按预先约定的统计口径如实披露结果，并把失败项、影响和补救计划单独列出。",
  "如需改变结论或对外材料，应由合规、法务或有权审批人基于完整记录复核。",
].join("\n");

const rules: readonly ProhibitedRequestRule[] = [
  {
    id: "audit_evasion",
    scope: "professional",
    all: [/(?:关闭|绕过|禁用)/u, /(?:审计|日志)/u, /(?:不留痕|不记录|无痕)/u],
    answer: TECHNICAL_REFUSAL,
  },
  {
    id: "secret_disclosure",
    scope: "professional",
    all: [/(?:提供|贴(?:出|在)?|发送|交给|共享|上传)/u, /(?:私钥|密码|密钥|令牌|token)/iu, /(?:生产|真实|供应商|第三方)/u],
    answer: TECHNICAL_REFUSAL,
  },
  {
    id: "unauthorized_social_test",
    scope: "professional",
    all: [/(?:发送|发起|开展)/u, /(?:仿冒|钓鱼)/u, /(?:未经批准|未授权|不审批|无需审批)/u],
    answer: [
      "不能在未经批准的情况下发送仿冒或钓鱼测试邮件。",
      "应先取得安全、法务和管理层授权，明确演练目标、收件人范围、时间窗口、数据处理、停止条件和应急联系人，再在受控范围内执行。",
      "演练后应保留真实结果并按批准口径复盘；若邮件已经发出，请立即停止并向安全负责人报告。",
    ].join("\n"),
  },
  {
    id: "technical_audit_falsification",
    scope: "professional",
    all: [/(?:改成|删除|隐瞒|篡改)/u, /(?:审计摘要|审计报告|问题记录)/u, /(?:零缺陷|无缺陷|原问题)/u],
    answer: [
      "不能把技术审计摘要篡改成“零缺陷”，也不能删除原问题记录。",
      "应保留真实审计证据，区分已修复、已接受、待修复和误报，并让有权审批人基于完整记录确认最终结论。",
      "如对外措辞需要调整，应保留原始版本、修改理由和审批轨迹。",
    ].join("\n"),
  },
  {
    id: "record_falsification",
    scope: "professional",
    all: [/(?:修改|篡改|伪造)/u, /(?:日志|时间戳|审计记录)/u, /(?:掩盖|隐瞒|伪装)/u],
    answer: [
      "不能协助修改日志或时间戳来掩盖超时，这会破坏事件调查和审计证据。",
      "应保全原始日志，校准可信时间源，按真实时间线记录超时、影响和恢复动作，并由事件负责人复核。",
      "如已发生修改，请停止继续操作并向安全或审计负责人报告。",
    ].join("\n"),
  },
  {
    id: "unauthorized_data_access",
    scope: "professional",
    all: [/(?:遍历|读取|复制|导出|抓取)/u, /(?:所有用户|任意账号|实际邮件|邮件正文|账号数据)/u, /(?:无需审批|绕过权限|未授权|不告知)/u],
    answer: [
      "不能在未经审批和授权的情况下遍历、读取或复制所有用户的邮件正文。",
      "邮件内容属于客户隐私和敏感数据；应按最小权限、明确目的、审批范围和审计要求，仅使用获批且必要的数据，优先采用脱敏样本。",
      "如数据已经被复制，请停止传播并立即向数据保护和安全负责人报告。",
    ].join("\n"),
  },
  {
    id: "authorization_bypass",
    scope: "professional",
    all: [/(?:绕过|规避)/u, /(?:权限|授权|认证)/u, /(?:读取|访问|调用示例|脚本)/u],
    answer: TECHNICAL_REFUSAL,
  },
  {
    id: "confidential_publication",
    scope: "professional",
    all: [/(?:公开|公开投标|互联网|投标文件)/u, /(?:客户|站点)/u, /(?:地址|路由|管理员名单|邮箱内容|敏感信息)/u],
    answer: [
      "不能把客户真实站点地址、路由、管理员名单或其他敏感信息直接放入公开文件。",
      "应先取得客户确认，按最小披露原则脱敏客户身份和基础设施细节，并由安全、隐私和投标责任人复核公开范围。",
      "如材料已经公开，请立即撤回或更正并启动泄露处置。",
    ].join("\n"),
  },
  {
    id: "security_control_disable",
    scope: "professional",
    all: [/(?:关闭|禁用)/u, /(?:反垃圾|安全策略|访问控制|审计)/u, /(?:永久|不评审|不审批|跳过评审)/u],
    answer: [
      "不能在生产环境永久关闭全部反垃圾或安全策略且跳过评审。",
      "应先界定误报范围和业务风险，在审批后的最小范围、最短时间内使用可回退的例外规则，并保留监控、复核和恢复条件。",
      "如控制已经关闭，请立即恢复基线并由安全负责人评估影响。",
    ].join("\n"),
  },
  {
    id: "illicit_competitive_intelligence",
    scope: "general",
    all: [/(?:购买|获取|使用|利用)/u, /(?:竞品|竞争对手)/u, /(?:泄露|内部机密|员工提供|非法来源)/u],
    answer: [
      "不能协助购买、获取或使用竞品员工泄露的内部信息；这种信息来源不合法或未经授权，也无法作为合规的定价依据。",
      "可以改用公开招投标信息、官方价目、授权渠道调研、客户预算和可验证价值来制定价格，并记录每项信息来源。",
      "如泄露材料已经到手，请停止传播和使用，保全来源记录，并交由法务或合规负责人处理。",
    ].join("\n"),
  },
  {
    id: "bribery",
    scope: "general",
    all: [/(?:回扣|好处费|账外佣金)/u, /(?:不入账|个人|私下|账外)/u],
    answer: [
      "不能协助设计个人回扣、账外付款或其他不透明利益安排。",
      "应改用公开、可审计的商业条款和客户价值论证，并由采购、财务与合规按正式流程审批。",
      "若已经提出或发生相关安排，请停止推进并向合规或法务升级处理。",
    ].join("\n"),
  },
  {
    id: "result_falsification",
    scope: "general",
    all: [/(?:删除|隐瞒|剔除|改成|宣称)/u, /(?:失败样本|原问题记录|零缺陷|百分之百通过|100%通过)/iu],
    answer: INTEGRITY_REFUSAL,
  },
  {
    id: "license_misrepresentation",
    scope: "general",
    all: [/(?:写成|声称|宣称)/u, /(?:已授权|License)/iu, /(?:没购买|未购买|等签约后)/u],
    answer: [
      "不能把客户未购买的模块写成已授权或已有 License。",
      "建议书应如实标记当前授权边界，把目标模块写为待采购或有条件选项，并明确价格、前提、责任人与生效条件。",
      "授权状态必须以真实合同、订单或许可记录为证据，由商务和法务确认。",
    ].join("\n"),
  },
  {
    id: "customer_approval_forgery",
    scope: "general",
    all: [/(?:制作|伪造|代签)/u, /(?:已签字|已同意|已验收)/u, /(?:客户|尚未确认|未确认)/u],
    answer: [
      "不能替客户伪造已签字、已同意或已验收的邮件。",
      "阶段出口必须以客户真实确认和可审计证据为准；应发送待确认纪要，列出验收结果、未决项和异议期限，请有权客户代表亲自回复或签署。",
      "在客户确认前，应把状态保持为待确认，不得对外宣称已经通过。",
    ].join("\n"),
  },
  {
    id: "unconsented_ai_processing",
    scope: "general",
    all: [/(?:喂给|上传|发送|导入)/u, /(?:外部\s*AI|第三方\s*AI|公网模型)/iu, /(?:真实邮箱|客户数据|邮件内容)/u, /(?:不告知|未同意|不脱敏|未脱敏)/u],
    answer: [
      "不能协助在未告知客户、未经授权且未脱敏的情况下，把真实邮箱或邮件内容交给外部 AI 处理。",
      "应先取得明确授权并完成数据分类、最小化和脱敏，只在获批环境中使用受控样本，同时落实访问控制、留存期限和可审计的数据处理记录。",
      "如数据已经外发，请停止处理并立即向数据保护、安全和合规负责人报告。",
    ].join("\n"),
  },
];

export type ProhibitedRequestDecision = {
  readonly ruleId: string;
  readonly result: AnswerResult;
};

export function evaluateProhibitedRequest(
  question: string,
): ProhibitedRequestDecision | undefined {
  const normalized = question.normalize("NFKC").trim();
  const rule = rules.find((candidate) =>
    candidate.all.every((pattern) => pattern.test(normalized)));
  if (rule === undefined) return undefined;
  return {
    ruleId: rule.id,
    result: {
      scope: rule.scope,
      status: "answered",
      policyDisposition: "needs_escalation",
      answer: rule.answer,
      references: [],
    },
  };
}
