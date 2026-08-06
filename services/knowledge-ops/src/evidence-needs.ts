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
  if (/AIR|离线|断网|版本/u.test(topic)) return [
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
  return [
    `覆盖“${topic}”的正式产品、实施、迁移或运维资料。`,
    "适用版本、部署形态、授权条件、依赖项和前置条件说明。",
    "可执行步骤、输入输出、验证方法、限制、例外以及异常升级或回退路径。",
  ];
}
