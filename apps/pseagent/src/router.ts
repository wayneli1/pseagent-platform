import type { Scope } from "./contracts.js";
import { routeActionSchema } from "./contracts.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { routeMessages } from "./prompts.js";
import { isPseAgentSelfQuestion } from "./self-context.js";
import { z } from "zod";

const routeModelResponseSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 1 &&
    ["professional", "general", "normal"].includes(String(record.scope))
  ) {
    return { action: "route", scope: record.scope };
  }
  return value;
}, routeActionSchema);

export class ScopeRouter {
  constructor(private readonly model: ModelClient) {}

  async route(question: string, conversationContext?: string, signal?: AbortSignal): Promise<Scope> {
    if (isPseAgentSelfQuestion(question)) return "normal";
    if (isUnambiguouslyNormalQuestion(question)) return "normal";
    if (isUnambiguouslyGeneralPresalesQuestion(question)) return "general";
    if (isUnambiguouslyProfessionalQuestion(question)) return "professional";
    if (isProfessionalArchitectureFollowUp(question, conversationContext)) {
      return "professional";
    }
    const messages = routeMessages(question, conversationContext);
    try {
      return (await this.model.completeJson({
        messages,
        schema: routeModelResponseSchema,
        schemaDescription: '{"action":"route","scope":"professional|general|normal"}',
        ...(signal === undefined ? {} : { signal }),
      })).scope;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      return conversationContext !== undefined &&
          PRODUCT_BOUNDARY_PATTERN.test(conversationContext)
        ? "professional"
        : "normal";
    }
  }
}

const PRODUCT_BOUNDARY_PATTERN =
  /(?:coremail|exchange|\bXT\d+(?:\.\d+)*\b|邮件|邮箱|电子信箱|网关|反垃圾|归档|部署|迁移|版本|兼容|授权|报价|交付周期|产品功能)/iu;
const GENERAL_PRESALES_ACTIVITY_PATTERN =
  /(?:职责|工作|方法|需求|访谈|话术|方案组织|价值表达|异议|沟通|冲突|演示|机会管理|项目推进|可信顾问|范围|变更|非标|客户关系|承诺|免费|控制)/u;
const PRODUCT_NEUTRAL_OPPORTUNITY_PATTERN =
  /(?:销售|赢率|胜率|成交概率|机会质量|陪标|决策链|决策人|内部支持者|客户信息|采购意向|预算状态|竞争对手)/u;
const PRODUCT_NEUTRAL_GOVERNANCE_PATTERN =
  /(?:POC|合同(?:边界|条款|承诺|责任|变更)?|验收(?:流程|评审|标准|边界|检查点)?|职责分工|责任分工|范围控制|变更流程|风险沟通|升级(?:路径|流程|机制)|交付边界)/iu;
const GOVERNANCE_METHOD_CUE_PATTERN =
  /(?:如何|怎样|怎么|应该|应当|流程|原则|模板|清单|组织|分工|约定|沟通|控制|机制|路径|检查点)/u;
const EXPLICIT_PRODUCT_TECHNICAL_SIGNAL_PATTERN =
  /(?:Coremail|Exchange|\bXT\d+(?:\.\d+)*\b)|(?:(?:POC|验收|核验|验证).{0,40}(?:产品能力|技术能力|模块|接口|协议|版本|兼容|适配|部署|配置|归档|网关|反垃圾)|(?:产品能力|技术能力|模块|接口|协议|版本|兼容|适配|部署|配置|归档|网关|反垃圾).{0,40}(?:POC|验收|核验|验证))/iu;
const EXPLICIT_GENERAL_METHOD_PATTERN =
  /(?:(?:报价|价格).{0,16}(?:压价|业务价值|价值异议)|压价.{0,16}(?:业务价值|价值|异议)|(?:讲不清|说不清|不明确).{0,16}(?:需求|目标)|(?:需求|目标).{0,16}(?:讲不清|说不清|不明确|继续追问)|继续追问|澄清需求|需求访谈)/u;
const GENERAL_PRESALES_METHOD_PATTERN =
  /(?:关系分层|补位动作|购买角色|业务影响|选择标准|可验证价值|机会复盘|红旗|价值主张画布|客户任务|待验证假设|交通灯|信任方程|非暴力沟通|原则性谈判|价值工程|内部支持者|经济角色|技术否决者|\b(?:SPIN|MEDDPICC|NVC|BATNA|RFP|JOLT|MTL)\b)/iu;
const PROFESSIONAL_ARCHITECTURE_CUE_PATTERN =
  /(?:RPO|RTO|两地三中心|多活|容灾|镜像|故障切换|数据一致性|容量输入|用户规模)/giu;
const EXPLICIT_NORMAL_RESET_PATTERN = /(?:换个话题|转换话题|另外写|题外话)/u;
const NON_DOMAIN_CREATIVE_PATTERN =
  /(?:写|创作|生成|改写).{0,12}(?:诗|故事|对联|歌词|小说|段子)/u;
const GENERIC_HTTP_STATUS_PATTERN =
  /(?:解释|什么是|什么意思|含义).{0,16}HTTP\s*[1-5]\d{2}/iu;
const KNOWLEDGE_RECORD_PATTERN =
  /(?:现有知识|知识库|正式资料|已有资料|项目资料|案例资料).{0,32}(?:事实|记录|证据|经验|案例|借鉴|边界)/u;
const TECHNICAL_CAPABILITY_BOUNDARY_PATTERN =
  /(?:\bIPv[46]\b|(?:支持|兼容|适配|验证|承诺).{0,24}(?:双栈|网络栈|技术协议|技术接口|产品模块|功能模块|全部模块|所有模块|各模块)|(?:双栈|网络栈|技术协议|技术接口|产品模块|功能模块|全部模块|所有模块|各模块).{0,24}(?:支持|兼容|适配|验证|承诺))/iu;
const TECHNICAL_ACRONYM_PATTERN = /\b[A-Z][A-Z0-9]{1,15}\b/gu;
const TECHNICAL_IMPLEMENTATION_CUE_PATTERN =
  /(?:支持|兼容|适配|扫描|审核|放行|集成|接口|协议|引擎|客户端|移动端|服务端|部署|配置|模块|版本)/gu;
const CAPABILITY_VERIFICATION_PATTERN = /(?:核验|验证|确认|承诺|逐项|能力|需求)/u;

export function isUnambiguouslyProfessionalQuestion(
  question: string,
): boolean {
  return PRODUCT_BOUNDARY_PATTERN.test(question) ||
    KNOWLEDGE_RECORD_PATTERN.test(question) ||
    TECHNICAL_CAPABILITY_BOUNDARY_PATTERN.test(question) ||
    EXPLICIT_PRODUCT_TECHNICAL_SIGNAL_PATTERN.test(question) ||
    isStructuredTechnicalCapabilityRequirement(question);
}

export function isStructuredTechnicalCapabilityRequirement(question: string): boolean {
  if (!CAPABILITY_VERIFICATION_PATTERN.test(question)) return false;
  const acronyms = new Set(question.match(TECHNICAL_ACRONYM_PATTERN) ?? []);
  const implementationCues = new Set(question.match(TECHNICAL_IMPLEMENTATION_CUE_PATTERN) ?? []);
  return acronyms.size >= 2 && implementationCues.size >= 1 ||
    acronyms.size >= 1 && implementationCues.size >= 3;
}

export function isUnambiguouslyNormalQuestion(question: string): boolean {
  return !PRODUCT_BOUNDARY_PATTERN.test(question) &&
    (
      EXPLICIT_NORMAL_RESET_PATTERN.test(question) ||
      NON_DOMAIN_CREATIVE_PATTERN.test(question) ||
      GENERIC_HTTP_STATUS_PATTERN.test(question)
    );
}

function isProfessionalArchitectureFollowUp(
  question: string,
  conversationContext: string | undefined,
): boolean {
  if (!conversationContext || !PRODUCT_BOUNDARY_PATTERN.test(conversationContext)) {
    return false;
  }
  const cues = new Set(
    [...question.matchAll(PROFESSIONAL_ARCHITECTURE_CUE_PATTERN)]
      .map((match) => match[0].toLocaleLowerCase("zh-CN")),
  );
  return cues.size >= 2;
}

export function isUnambiguouslyGeneralPresalesQuestion(
  question: string,
): boolean {
  if (EXPLICIT_GENERAL_METHOD_PATTERN.test(question)) return true;
  if (
    GENERAL_PRESALES_METHOD_PATTERN.test(question) &&
    !isUnambiguouslyProfessionalQuestion(question)
  ) {
    return true;
  }
  if (
    PRODUCT_NEUTRAL_GOVERNANCE_PATTERN.test(question) &&
    GOVERNANCE_METHOD_CUE_PATTERN.test(question) &&
    !EXPLICIT_PRODUCT_TECHNICAL_SIGNAL_PATTERN.test(question)
  ) {
    return true;
  }
  return (
    (/售前/u.test(question) && GENERAL_PRESALES_ACTIVITY_PATTERN.test(question)) ||
    PRODUCT_NEUTRAL_OPPORTUNITY_PATTERN.test(question)
  ) &&
    !isUnambiguouslyProfessionalQuestion(question);
}
