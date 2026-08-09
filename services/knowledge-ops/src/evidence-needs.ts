import type { RepairBlockingKind, RepairDraftProposal, RepairEvidenceRequest } from "./types.js";

const EVIDENCE_WORDS = /(?:正式资料|正式证据|知识来源|资料不足|证据不足|证据未覆盖|信息缺口|知识库.*(?:缺少|未覆盖|无))/u;

export function repairBlockingKind(proposal: RepairDraftProposal): RepairBlockingKind | undefined {
  if (proposal.publishable) return undefined;
  if (proposal.blockingKind !== undefined) return proposal.blockingKind;
  if (proposal.targetKind === "system_fix") return "system_fix_required";
  if (proposal.rootCause === "judgement_conflict") return "human_decision_required";
  if (proposal.targetKind === "knowledge_page" || EVIDENCE_WORDS.test(proposal.blockingReason ?? "")) return "evidence_required";
  return "candidate_invalid";
}

export function isEvidenceBlockedProposal(proposal: RepairDraftProposal): boolean {
  return repairBlockingKind(proposal) === "evidence_required";
}

export function evidenceRequestForProposal(proposal: Pick<RepairDraftProposal,
  "title" | "canonicalQuestion" | "targetDomain" | "rootCause" | "blockingReason" | "evidenceRequest"
>): RepairEvidenceRequest {
  if (proposal.evidenceRequest !== undefined) return proposal.evidenceRequest;
  const topic = proposal.canonicalQuestion.trim() || proposal.title.trim() || "当前问题";
  return {
    summary: `为“${topic}”补充能够被答案卡直接引用的正式资料。`,
    requiredMaterials: requiredMaterials(topic, proposal.targetDomain),
    acceptanceCriteria: [
      "资料来源可追溯，并标明适用产品或业务范围、版本或生效日期以及维护责任。",
      "核心结论、操作要求和限制条件能够在正文中直接定位，不能只引用用户反馈或模型推测。",
      "资料明确覆盖前置条件、适用与排除边界、验证方式以及异常升级或回退路径。",
    ],
  };
}

function requiredMaterials(topic: string, domain: RepairDraftProposal["targetDomain"]): readonly string[] {
  if (/预算|资源调动/u.test(topic)) return [
    "正式销售方法或资格判断标准：明确预算权、资源调动权和决策角色分别如何核验。",
    "可接受的核验事实清单：例如审批链、预算来源、资源承诺、参与角色和已完成的实际动作。",
    "适用与排除条件、记录模板及升级审批边界，说明哪些信号只能作为假设而不能作为结论。",
  ];
  if (/\bAIR\b/iu.test(topic)) return [
    "AIR 客户端 AI 能力清单，并区分在线、内网隔离和完全离线环境下的可用范围。",
    "产品版本、部署形态、授权项、服务端依赖和网络依赖的正式支持矩阵。",
    "不支持或条件支持场景、验证方法、升级要求及需由产品团队确认的例外流程。",
  ];
  if (/云.*自建|自建.*云|迁移.*分阶段/u.test(topic)) return [
    "Coremail 云转自建的正式迁移指南，明确迁移对象、工具、前置检查和责任分工。",
    "分阶段实施步骤：盘点、方案确认、试迁移、全量或增量迁移、切换、验证和收尾。",
    "停机与一致性边界、失败回退、验收指标、异常升级路径及不同版本或数据类型的限制。",
  ];
  if (/需求|追问|优化|售前/u.test(topic)) return [
    "正式售前需求发现方法或访谈 SOP，明确从模糊目标到可验证问题的追问顺序。",
    "角色、现状、影响、期望结果、优先级、预算与决策流程等信息的核验口径。",
    "访谈记录模板、结束条件、升级边界及不得替客户推断需求的约束。",
  ];
  if (domain === "presales-general") return [
    `覆盖“${topic}”的正式售前方法、流程或制度说明。`,
    "角色、决策、预算、资源或价值判断的核验口径及可接受证据。",
    "适用与排除条件、审批边界、记录模板和需要升级确认的例外。",
  ];
  if (/(?:\bCVE\b|漏洞|高危|安全公告|安全修复|漏洞修复)/iu.test(topic)) {
    return securityCommitmentMaterials(topic);
  }
  if (/(?:是否|能否|支持|兼容|能力|功能|版本|license|licence|授权|许可|配置|启用|部署|安装|步骤)/iu.test(topic)) {
    return productCapabilityMaterials(topic);
  }
  return [
    `覆盖“${topic}”的正式产品、实施、迁移或运维资料。`,
    "适用版本、部署形态、授权条件、依赖项和前置条件说明。",
    "可执行步骤、输入输出、验证方法、限制、例外以及异常升级或回退路径。",
  ];
}

function securityCommitmentMaterials(topic: string): readonly string[] {
  const materials = [
    `覆盖“${topic}”的官方安全公告和版本发布或修复说明，标明产品、版本、发布日期及公告维护责任。`,
    "截至指定日期的 CVE 或漏洞清单，逐项标明受影响版本、修复版本、不受影响依据、例外和残余风险。",
    "对应目标版本的正式复测、漏洞扫描或渗透测试报告，标明测试日期、环境、范围、方法、结果和报告签发方。",
  ];
  if (/(?:合同|承诺|保证|担保|SLA|招标应答)/iu.test(topic)) {
    materials.push("经产品、安全和法务审批的书面确认或合同条款模板，明确承诺主体、适用版本、截止日期、例外、有效期和升级审批人。");
  }
  return materials;
}

function productCapabilityMaterials(topic: string): readonly string[] {
  const materials: string[] = [];
  if (/(?:是否|能否|支持|兼容|能力|功能)/u.test(topic)) {
    materials.push(`覆盖“${topic}”的正式产品功能说明、产品发布说明或能力边界说明。`);
  }
  if (/(?:版本|release|edition|\bv\d|xt\d)/iu.test(topic)) {
    materials.push("产品版本—功能支持矩阵，明确首次支持版本、适用小版本、升级要求和已知限制。");
  }
  if (/(?:license|licence|授权|许可|sku)/iu.test(topic)) {
    materials.push("License、SKU 或版本授权说明，明确必需授权项、购买前提和部署限制。");
  }
  if (/(?:配置|启用|部署|安装|操作|步骤|验证|回退)/u.test(topic)) {
    materials.push("正式管理员配置手册，包含前置条件、启用步骤、参数含义、验证方法、安全边界和回退方式。");
  }
  return materials.length > 0
    ? materials
    : [`覆盖“${topic}”的正式产品资料，并明确适用范围与维护责任。`];
}
