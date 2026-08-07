import { createHash } from "node:crypto";
import { InvalidModelPayloadError,type ModelClient } from "@pseagent/app/embedded";
import type { AnswerCard, FeedbackClassification, KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import {
  evidenceRequestForProposal,
  repairBlockingKind,
  repairProposalSchema,
  type IssueCategory,
  type RepairDraftProposal,
  type RepairTargetKind,
} from "@pseagent/knowledge-ops";
import { z } from "zod";
import { inspectAnswerCardRuleConflicts, isUnverifiableRequiredConcept, rewriteBroadProjectDataForbiddenClaims } from "./project-data-policy.js";

const regressionKindSchema=z.enum(["canonical","alias","colloquial","follow_up","negative"]);
const obligationSchema=z.object({
  id:z.string().regex(/^O\d+$/u),label:z.string().trim().min(1).max(500),
  evidencePolicy:z.enum(["direct","synthesis","customer_input"]),
  requiredConcepts:z.array(z.string().trim().min(1).max(100)).max(20),
  forbiddenClaims:z.array(z.string().trim().min(1).max(500)).max(50),
  preferredEvidencePaths:z.array(z.string().trim().min(1).max(1_000)).max(20),
}).strict();
const looseRegressionQuestionSchema=z.object({
  kind:z.string().trim().max(100).optional(),type:z.string().trim().max(100).optional(),
  question:z.string().trim().min(1).max(2_000).optional(),query:z.string().trim().min(1).max(2_000).optional(),
}).passthrough();
const repairCandidateSchema=z.object({
  title:z.string().trim().min(1).max(500),canonicalQuestion:z.string().trim().min(1).max(1_000),
  aliases:z.array(z.string().trim().min(1).max(1_000)).max(100),answerTemplate:z.string().trim().max(100_000),
  obligations:z.array(obligationSchema).min(1).max(12),
  regressionQuestions:z.unknown().optional(),
  generationSummary:z.unknown().optional(),publishable:z.boolean(),blockingReason:z.unknown().optional(),
}).passthrough().superRefine((value,context)=>{
  if(value.publishable&&value.answerTemplate==="")context.addIssue({code:"custom",path:["answerTemplate"],message:"publishable_repair_requires_answer_template"});
  if(value.publishable&&value.aliases.length===0)context.addIssue({code:"custom",path:["aliases"],message:"publishable_repair_requires_alias"});
});
const repairCandidateInputSchema=z.preprocess(normalizeRepairCandidateEnvelope,repairCandidateSchema);
const caseAssessmentSchema=z.object({cases:z.unknown().optional()}).passthrough();

export interface RepairRecord {
  readonly question: string;
  readonly rawQuestion?: string;
  readonly contextUsed?: boolean;
  readonly parentQuestion?: string;
  readonly parentAnswerOutline?: string;
  readonly answer: string;
  readonly feedbackClassification?: FeedbackClassification;
  readonly feedback?: string;
  readonly proposedAnswer?: string;
  readonly reviewSummary?: string;
  readonly defects?: readonly { readonly category:string; readonly severity:string; readonly summary:string; readonly evidence:string }[];
}

export interface RepairEvidence {
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface RepairRoute {
  readonly targetKind: RepairTargetKind;
  readonly targetDomain?: KnowledgeDomain;
  readonly targetPath?: string;
  readonly cardId?: string;
  readonly baseGitRevision?: string;
  readonly existingCard?: AnswerCard;
  readonly publishableAllowed: boolean;
  readonly blockingReason?: string;
}

export interface RepairGenerationInput {
  readonly issueId: string;
  readonly rootCause: IssueCategory;
  readonly records: readonly RepairRecord[];
  readonly evidence: readonly RepairEvidence[];
  readonly route: RepairRoute;
  readonly sensitiveTerms?: readonly string[];
  readonly signal?: AbortSignal;
}

export class KnowledgeRepairAgent {
  constructor(private readonly model:ModelClient){}

  async generate(input:RepairGenerationInput):Promise<RepairDraftProposal>{
    if(!input.route.publishableAllowed)return blockedProposal(input);
    if(input.route.targetDomain===undefined||input.route.baseGitRevision===undefined)return blockedProposal({...input,route:{...input.route,publishableAllowed:false,blockingReason:"无法确定唯一知识域和版本基线，需要管理员判断。"}});
    if(input.evidence.length===0)return blockedProposal({...input,route:{...input.route,targetKind:"knowledge_page",publishableAllowed:false,blockingReason:"没有已校验的正式资料，不能自动生成可发布答案；请先补充知识来源。"}});

    const messages=[
      {role:"system" as const,content:[
        "你是企业 Obsidian 知识库的修订 Agent，固定模型为 deepseek_v4_flash。",
        "只能使用 input.evidence 中的正式资料和 existingCard，不能使用外部知识、常识猜测或用户建议补足事实。",
        "feedbackClassification、用户反馈和 proposedAnswer 只是需要核查的问题信号，不是正式证据；即使用户标记答案错误，也只有被 evidence 支持的内容才能写入答案。",
        "records 中 contextUsed=true 的记录是上下文追问：必须结合 parentQuestion 和 parentAnswerOutline 还原会改变答案的规模、部署形态、能力要求与限制条件，再生成可独立理解的 canonicalQuestion；这类追问只能放进 follow_up 回归问题，不能写入 aliases。",
        "输出客户中立、可复用的答案卡草稿，不得出现聊天用户姓名、账号、内部标识或只对单个客户成立的表述。",
        "保留现有答案卡真正有效的安全边界和必答项；若旧禁答项与正式证据或必答项冲突，必须把它精确化，不能机械继承。",
        "正式证据直接记载的项目用户数、授权量、服务器数、节点数和部署规模可以写入答案，但必须绑定项目、场景和数据口径。不得仅因它是项目具体数据就禁止回答。",
        "不得跨项目套用数据，不得把历史项目数据扩大为当前实时规模、通用产品上限或新客户承诺，不得把约等于改写为超过或不少于。无正式证据的数据必须省略或标记待客户确认。",
        "forbiddenClaims 不得生成“禁止出现某项目具体用户数/授权量/服务器数量/节点数量/所有项目规模数据”等宽泛规则；应改为防止跨项目套用、实时化、容量上限化和承诺化的精确边界。",
        "requiredConcepts 只能填写正式证据和 answerTemplate 中实际出现、可以逐项确定性核验的原子事实，例如模块名、动作、配置项或数据口径。不得填写“核心功能、主要功能、职责区别、协作关系、相关内容、关键信息”等抽象分类标签；不得使用“标签：包含多个事实的整句说明”，也不得把多个动作或条件用逗号、顿号拼成一个概念；每个必答概念都必须能在答案正文中直接定位，单项不超过 100 字，每个必答项最多 20 个概念；长清单必须拆成原子概念。",
        "answerTemplate 不需要手工添加 [1] 等运行时引用编号；正式引用编号由在线回答链路按证据生成。",
        "必须生成五个且各一个回归问题：canonical 原始标准问法、alias 同义改写、colloquial 口语问法、follow_up 上下文追问、negative 边界负例。",
        "obligations 必须是 JSON 对象数组，即使只有一项也不能输出为对象、分组映射或说明文字；每项必须严格包含 id、label、evidencePolicy、requiredConcepts、forbiddenClaims、preferredEvidencePaths，其中后三项是字符串数组，evidencePolicy 只能是 direct、synthesis 或 customer_input。",
        "如果证据不能支持完整答案，将 publishable 设为 false 并写明 blockingReason。JSON 根节点必须直接包含 title、canonicalQuestion、aliases、answerTemplate 等字段，不要添加 proposal、data 或 result 外层。只输出严格 JSON。",
      ].join("\n")},
      {role:"user" as const,content:JSON.stringify({
        rootCause:input.rootCause,
        route:{targetKind:input.route.targetKind,targetDomain:input.route.targetDomain,targetPath:input.route.targetPath,cardId:input.route.cardId},
        records:redactRecords(input.records,input.sensitiveTerms??[]),
        existingCard:input.route.existingCard===undefined?null:{
          cardId:input.route.existingCard.cardId,title:input.route.existingCard.title,
          canonicalQuestion:input.route.existingCard.canonicalQuestion,aliases:input.route.existingCard.aliases,
          answerTemplate:input.route.existingCard.answerTemplate,
          obligations:input.route.existingCard.obligations.filter((item)=>item.required).map((item)=>({
            id:item.id,label:item.label,evidencePolicy:item.evidencePolicy,requiredConcepts:item.requiredConcepts,
            forbiddenClaims:item.forbiddenClaims,preferredEvidencePaths:item.preferredEvidencePaths,
          })),
        },
        evidence:input.evidence.map((item)=>({title:item.title,path:item.path,content:item.content})),
      })},
    ];
    let candidate:z.infer<typeof repairCandidateSchema>|undefined;let lastError:unknown;let retryInstruction:string|undefined;
    for(let attempt=1;attempt<=2;attempt+=1){
      try{candidate=await this.model.completeJson({messages:retryInstruction===undefined?messages:[...messages,{role:"user",content:retryInstruction}],schema:repairCandidateInputSchema,schemaDescription:"knowledge repair draft with answer, structured obligation objects, evidence paths and five regression questions",...(input.signal===undefined?{}:{signal:input.signal})});}
      catch(error){candidate=recoverWrappedRepairCandidate(error);if(candidate===undefined){lastError=error;if(!(error instanceof InvalidModelPayloadError)||attempt===2)throw error;retryInstruction="上一次输出未通过严格 Schema。请只依据 evidence 修正；把 title 等字段直接放在 JSON 根节点；obligations 必须是对象数组，每项含 id、label、evidencePolicy、requiredConcepts、forbiddenClaims、preferredEvidencePaths；保持五类回归问题各一个。";continue;}}
      const proposal=enforceRepairCandidate(input,candidate);
      const abstractConcepts=proposal.obligations.flatMap((item)=>item.requiredConcepts.filter(isUnverifiableRequiredConcept).map((concept)=>`${item.id}：${concept}`));
      if(abstractConcepts.length===0)return proposal;
      if(attempt===2)return proposal;
      retryInstruction=[
        `上一次草稿包含无法确定性验证的抽象必答概念：${abstractConcepts.join("；")}。`,
        "请重新生成完整草稿，把这些抽象标签替换为 evidence 与 answerTemplate 中逐字可定位的原子事实，例如具体模块名、动作、配置项或数据口径。",
        "不得仅在 answerTemplate 中补写“核心功能”等标签来绕过检查；应让 requiredConcepts 精确描述答案已经陈述的事实。",
      ].join("\n");
      candidate=undefined;
    }
    if(candidate===undefined)throw lastError;
    return enforceRepairCandidate(input,candidate);
  }
  async assess(input:{readonly proposal:RepairDraftProposal;readonly evidence:readonly RepairEvidence[];readonly signal?:AbortSignal}):Promise<readonly {readonly kind:z.infer<typeof regressionKindSchema>;readonly passed:boolean;readonly explanation:string}[]>{
    const messages=[{role:"system" as const,content:[
      "你是企业知识修订的独立验证员，固定使用 deepseek_v4_flash。只能依据 proposal 与 evidence 判定。",
      "对 canonical、alias、colloquial、follow_up：passed 表示该问法确实属于答案卡适用范围，且 answerTemplate 被正式证据支持并完整覆盖 obligations。",
      "对 negative：passed 表示该负例不应命中或套用这张答案卡，答案卡的适用边界能够排除它。",
      "正式证据直接支持的项目用户数、授权量、服务器数、节点数和部署规模允许出现；重点检查项目归属、数据口径、跨项目套用、实时化和承诺化，不得仅因出现具体数字判定失败。",
      "answerTemplate 不要求手工包含 [1] 等运行时引用编号，验证事实支持关系时使用 evidence 和 preferredEvidencePaths。",
      "五类必须各返回一项。证据不足、承诺超出资料、缺少必答项或负例仍会误命中时必须为 false。只输出严格 JSON。",
    ].join("\n")},{role:"user" as const,content:JSON.stringify({proposal:input.proposal,evidence:input.evidence})}];
    let result:z.infer<typeof caseAssessmentSchema>|undefined;let firstError:unknown;
    for(let attempt=1;attempt<=2;attempt+=1){try{result=await this.model.completeJson({messages:attempt===1?messages:[...messages,{role:"user",content:"上一次输出未通过 Schema。请按五类各一项重新输出，不要增加其他字段。"}],schema:caseAssessmentSchema,schemaDescription:"five knowledge repair validation case assessments",...(input.signal===undefined?{}:{signal:input.signal})});break;}catch(error){firstError??=error;if(!(error instanceof InvalidModelPayloadError)||attempt===2)throw firstError;}}
    if(result===undefined)throw firstError;return normalizeAssessments(result.cases??result);
  }
}

function enforceRepairCandidate(input:RepairGenerationInput,candidate:z.infer<typeof repairCandidateSchema>):RepairDraftProposal{
  const evidencePaths=new Set(input.evidence.map((item)=>item.path));
  const {obligations,unsupportedEvidence}=mergeObligations(candidate.obligations,input.route.existingCard,evidencePaths);
  const regressionQuestions=normalizeRegressionQuestions(input,candidate);
  const regressionAliases=regressionQuestions.filter((item)=>item.kind==="alias"||item.kind==="colloquial").map((item)=>item.question);
  const contextualQuestions=new Set(input.records.filter((item)=>item.contextUsed===true).flatMap((item)=>[item.question,item.rawQuestion].filter((value):value is string=>value!==undefined)).map(normalize));
  const recordAliases=input.records.filter((item)=>item.contextUsed!==true).map((item)=>item.question.trim()).filter((question)=>question!==""&&!(input.sensitiveTerms??[]).some((term)=>term.trim().length>=2&&normalize(question).includes(normalize(term))));
  const aliases=unique([...(input.route.existingCard?.aliases??[]),...recordAliases,...candidate.aliases,...regressionAliases]).filter((value)=>normalize(value)!==normalize(candidate.canonicalQuestion)&&!contextualQuestions.has(normalize(value)));
  const protectedText=[candidate.title,candidate.canonicalQuestion,...aliases,candidate.answerTemplate,...obligations.flatMap((item)=>[item.label,...item.requiredConcepts,...item.forbiddenClaims])].join("\n");
  const leakedSensitive=(input.sensitiveTerms??[]).find((term)=>term.trim().length>=2&&normalize(protectedText).includes(normalize(term)));
  const forbiddenClaim=obligations.flatMap((item)=>item.forbiddenClaims).find((claim)=>claim!==""&&normalize(candidate.answerTemplate).includes(normalize(claim)));
  const ruleConflicts=inspectAnswerCardRuleConflicts({answerTemplate:candidate.answerTemplate,obligations,evidence:input.evidence});
  const missingEvidence=obligations.some((item)=>item.evidencePolicy!=="customer_input"&&item.preferredEvidencePaths.length===0);
  const modelBlockingReason=textValue(candidate.blockingReason);
  const contradictedIdentityBlock=!candidate.publishable&&modelBlockingReason!==undefined&&/(?:身份|姓名|客户名称|敏感)/u.test(modelBlockingReason)&&leakedSensitive===undefined;
  const reasons=[
    ...(candidate.publishable||contradictedIdentityBlock?[]:[modelBlockingReason??"模型认为当前证据不足。"]),
    ...(unsupportedEvidence?["草稿引用了未校验或不在当前知识版本中的资料。"]:[]),
    ...(missingEvidence?["至少一个必答项没有已校验的正式证据路径。"]:[]),
    ...(forbiddenClaim===undefined?[]:["候选答案命中了答案卡禁答主张。"]),
    ...(ruleConflicts.length===0?[]:[`答案卡规则自身冲突：${ruleConflicts.map((item)=>`${item.obligationId} ${item.message}`).join("；")}`]),
    ...(leakedSensitive===undefined?[]:["候选草稿包含聊天用户身份信息，已阻止发布。"]),
  ];
  const publishable=reasons.length===0;
  const existing=input.route.existingCard;
  const title=existing?.title??candidate.title,canonicalQuestion=existing?.canonicalQuestion??candidate.canonicalQuestion;
  const cardId=existing?.cardId??input.route.cardId??newCardId(input.route.targetDomain!,input.issueId);
  const targetPath=input.route.targetPath??`wiki/queries/${safeFileName(title,input.issueId)}.md`;
  const base:RepairDraftProposal={
    rootCause:input.rootCause,targetKind:input.route.targetKind,targetDomain:input.route.targetDomain!,targetPath,cardId,
    title,canonicalQuestion,aliases,answerTemplate:candidate.answerTemplate,obligations,
    regressionQuestions,generationSummary:textValue(candidate.generationSummary)??"依据已校验正式资料生成知识修订草稿。",publishable,
    ...(publishable?{}:{blockingReason:unique(reasons).join(" ")}),
  };
  const blockingKind=repairBlockingKind(base);
  return repairProposalSchema.parse({...base,...(blockingKind===undefined?{}:{blockingKind}),...(blockingKind==="evidence_required"?{evidenceRequest:evidenceRequestForProposal(base)}:{})}) as RepairDraftProposal;
}

function normalizeRegressionQuestions(
  input:RepairGenerationInput,
  candidate:z.infer<typeof repairCandidateSchema>,
):readonly {readonly kind:z.infer<typeof regressionKindSchema>;readonly question:string}[]{
  const expected=regressionKindSchema.options,recognized=new Map<string,string>(),rawQuestions=rawRegressionQuestions(candidate.regressionQuestions);
  for(const item of rawQuestions){
    const question=(item.question??item.query)?.trim();if(!question)continue;
    const kind=normalizeRegressionKind(item.kind??item.type??"");if(kind!==undefined&&!recognized.has(kind))recognized.set(kind,question);
  }
  const canonical=input.route.existingCard?.canonicalQuestion??candidate.canonicalQuestion;
  const original=input.records.map((item)=>item.question.trim()).find((item)=>item!==""&&normalize(item)!==normalize(canonical));
  const alias=original??candidate.aliases.find((item)=>normalize(item)!==normalize(canonical))??`关于“${candidate.title}”需要确认哪些内容？`;
  const fallback:Record<z.infer<typeof regressionKindSchema>,string>={
    canonical,
    alias,
    colloquial:candidate.aliases.find((item)=>normalize(item)!==normalize(canonical)&&normalize(item)!==normalize(alias))??`“${candidate.title}”这件事通常要先准备什么？`,
    follow_up:`完成这些准备后，下一步还需要确认什么？`,
    negative:"今天天气怎么样？",
  };
  return expected.map((kind,index)=>{
    const question=recognized.get(kind)??rawQuestions[index]?.question??rawQuestions[index]?.query??fallback[kind];
    return{kind,question:kind==="follow_up"?`关于“${input.route.existingCard?.title??candidate.title}”，${question}`:question};
  });
}

function rawRegressionQuestions(value:unknown):readonly z.infer<typeof looseRegressionQuestionSchema>[] {
  const direct=Array.isArray(value)?value:typeof value==="object"&&value!==null&&Array.isArray((value as{cases?:unknown}).cases)?(value as{cases:unknown[]}).cases:undefined;
  if(direct!==undefined)return direct.map((item)=>looseRegressionQuestionSchema.safeParse(item)).filter((item)=>item.success).map((item)=>item.data);
  if(typeof value!=="object"||value===null)return[];
  return Object.entries(value).flatMap(([kind,question])=>{
    const text=textValue(question);return text===undefined?[]:[{kind,question:text}];
  });
}

function textValue(value:unknown):string|undefined {
  if(typeof value==="string"){const result=value.trim();return result===""?undefined:result.slice(0,4_000);}
  if(Array.isArray(value)){const parts=value.map(textValue).filter((item):item is string=>item!==undefined);return parts.length===0?undefined:parts.join(" ").slice(0,4_000);}
  if(typeof value==="object"&&value!==null){
    const record=value as Record<string,unknown>;for(const key of ["summary","reason","text","description","question","query"]){const result=textValue(record[key]);if(result!==undefined)return result;}
  }
  return undefined;
}

function normalizeRegressionKind(value:string):z.infer<typeof regressionKindSchema>|undefined{
  const key=value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");
  const aliases:Record<string,z.infer<typeof regressionKindSchema>>={
    canonical:"canonical",standard:"canonical",original:"canonical",标准:"canonical",标准问法:"canonical",原始:"canonical",
    alias:"alias",synonym:"alias",同义:"alias",同义问法:"alias",改写:"alias",
    colloquial:"colloquial",spoken:"colloquial",口语:"colloquial",口语问法:"colloquial",
    followup:"follow_up",context:"follow_up",contextual:"follow_up",追问:"follow_up",上下文追问:"follow_up",
    negative:"negative",boundary:"negative",outofscope:"negative",负例:"negative",边界负例:"negative",
  };
  return aliases[key];
}

function normalizeAssessments(value:unknown):readonly {readonly kind:z.infer<typeof regressionKindSchema>;readonly passed:boolean;readonly explanation:string}[]{
  const entries:Array<{kind?:unknown;passed?:unknown;explanation?:unknown}>=[];
  if(Array.isArray(value)){for(const item of value)if(typeof item==="object"&&item!==null)entries.push(item as typeof entries[number]);}
  else if(typeof value==="object"&&value!==null){for(const [kind,result] of Object.entries(value)){if(typeof result==="object"&&result!==null)entries.push({kind,...result as Record<string,unknown>});else entries.push({kind,passed:result});}}
  const recognized=new Map<z.infer<typeof regressionKindSchema>,{passed:boolean;explanation:string}>();
  for(const item of entries){const kind=normalizeRegressionKind(typeof item.kind==="string"?item.kind:"");if(kind===undefined||recognized.has(kind))continue;const passed=item.passed===true||item.passed==="true"||item.passed==="通过";recognized.set(kind,{passed,explanation:textValue(item.explanation)??(passed?"修订 Agent 检查通过。":"修订 Agent 未提供可验证的通过说明。")});}
  return regressionKindSchema.options.map((kind)=>({kind,...(recognized.get(kind)??{passed:false,explanation:"模型未返回这一类验证结果，按不通过处理。"})}));
}

function mergeObligations(
  candidate:readonly z.infer<typeof obligationSchema>[],
  existing:AnswerCard|undefined,
  evidencePaths:ReadonlySet<string>,
):{readonly obligations:RepairDraftProposal["obligations"];readonly unsupportedEvidence:boolean}{
  const byId=new Map(candidate.map((item)=>[item.id,item] as const));let unsupportedEvidence=false;
  const source=existing===undefined?candidate:existing.obligations.filter((item)=>item.required).map((baseline)=>{
    const proposed=byId.get(baseline.id);byId.delete(baseline.id);
    const proposedConcepts=proposed?.requiredConcepts??[];
    const retainedBaselineConcepts=baseline.requiredConcepts.filter((concept)=>!isUnverifiableRequiredConcept(concept)||proposedConcepts.some((candidateConcept)=>normalize(candidateConcept)===normalize(concept)));
    return{id:baseline.id,label:proposed?.label??baseline.label,evidencePolicy:proposed?.evidencePolicy??baseline.evidencePolicy,
      requiredConcepts:unique([...retainedBaselineConcepts,...proposedConcepts]),
      forbiddenClaims:rewriteBroadProjectDataForbiddenClaims(unique([...baseline.forbiddenClaims,...(proposed?.forbiddenClaims??[])])).claims,
      preferredEvidencePaths:unique([...baseline.preferredEvidencePaths,...(proposed?.preferredEvidencePaths??[])]),
    };
  }).concat([...byId.values()]);
  const obligations=source.slice(0,12).map((item)=>{
    const preferredEvidencePaths=item.preferredEvidencePaths.filter((path)=>evidencePaths.has(path));
    if(preferredEvidencePaths.length!==item.preferredEvidencePaths.length)unsupportedEvidence=true;
    return{...item,forbiddenClaims:rewriteBroadProjectDataForbiddenClaims(item.forbiddenClaims).claims,preferredEvidencePaths};
  });
  return{obligations,unsupportedEvidence};
}

function blockedProposal(input:RepairGenerationInput):RepairDraftProposal{
  const question=input.records[0]?.question.trim()||"待管理员确认的问题";
  const reason=input.route.blockingReason??"当前问题不能通过知识修订自动解决，需要管理员判断。";
  const base:RepairDraftProposal={rootCause:input.rootCause,targetKind:input.route.targetKind,
    ...(input.route.targetDomain===undefined?{}:{targetDomain:input.route.targetDomain}),
    ...(input.route.targetPath===undefined?{}:{targetPath:input.route.targetPath}),
    ...(input.route.cardId===undefined?{}:{cardId:input.route.cardId}),
    title:question.slice(0,500),canonicalQuestion:question.slice(0,1_000),aliases:[],answerTemplate:"",obligations:[],regressionQuestions:[],
    generationSummary:reason,publishable:false,blockingReason:reason};
  const blockingKind=repairBlockingKind(base);
  return repairProposalSchema.parse({...base,...(blockingKind===undefined?{}:{blockingKind}),...(blockingKind==="evidence_required"?{evidenceRequest:evidenceRequestForProposal(base)}:{})}) as RepairDraftProposal;
}

function recoverWrappedRepairCandidate(error:unknown):z.infer<typeof repairCandidateSchema>|undefined{
  const raw=typeof error==="object"&&error!==null&&"rawPayload" in error&&typeof error.rawPayload==="string"?error.rawPayload:undefined;if(raw===undefined)return undefined;
  const afterReasoning=raw.replace(/^(?:\s*<think>[\s\S]*?<\/think>\s*)+/iu,""),fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1],first=raw.indexOf("{"),last=raw.lastIndexOf("}"),sources=[raw,afterReasoning,...(fenced===undefined?[]:[fenced]),...(first>=0&&last>first?[raw.slice(first,last+1)]:[])];
  for(const source of sources){let decoded:unknown;try{decoded=JSON.parse(source.trim());}catch{continue;}const queue:Array<{value:unknown;depth:number}>=[{value:decoded,depth:0}];let visited=0;while(queue.length>0&&visited<24){const item=queue.shift()!;visited+=1;const parsed=repairCandidateSchema.safeParse(normalizeRepairCandidateShape(item.value));if(parsed.success)return parsed.data;if(item.depth>=2||typeof item.value!=="object"||item.value===null||Array.isArray(item.value))continue;for(const value of Object.values(item.value))if(typeof value==="object"&&value!==null&&!Array.isArray(value))queue.push({value,depth:item.depth+1});}}
  return undefined;
}
function normalizeRepairCandidateShape(value:unknown):unknown{
  if(typeof value!=="object"||value===null||Array.isArray(value))return value;const source=value as Record<string,unknown>,raw=source.obligations;
  if(raw===undefined)return source;const entries=normalizeObligationCollection(raw);if(entries===undefined)return source;const obligations=entries.map((item,index)=>{if(typeof item!=="object"||item===null||Array.isArray(item))return item;const obligation=item as Record<string,unknown>,rawId=typeof obligation.id==="string"?obligation.id.trim().toUpperCase():"",id=/^O\d+$/u.test(rawId)?rawId:`O${index+1}`;return{id,label:obligation.label,evidencePolicy:obligation.evidencePolicy,requiredConcepts:obligation.requiredConcepts,forbiddenClaims:obligation.forbiddenClaims,preferredEvidencePaths:obligation.preferredEvidencePaths};});
  return{...source,obligations};
}
function normalizeRepairCandidateEnvelope(value:unknown):unknown{
  let candidate=value;for(let depth=0;depth<3;depth+=1){if(typeof candidate!=="object"||candidate===null||Array.isArray(candidate))break;const source=candidate as Record<string,unknown>;if("title" in source&&"canonicalQuestion" in source)break;const nested=["proposal","data","result","draft"].map((key)=>source[key]).find((item)=>typeof item==="object"&&item!==null&&!Array.isArray(item));if(nested===undefined)break;candidate=nested;}return normalizeRepairCandidateShape(candidate);
}
function normalizeObligationCollection(value:unknown,depth=0):unknown[]|undefined{
  if(depth>3)return undefined;if(Array.isArray(value))return value;if(typeof value==="string"){try{return normalizeObligationCollection(JSON.parse(value),depth+1);}catch{return undefined;}}
  if(typeof value!=="object"||value===null)return undefined;const source=value as Record<string,unknown>;
  if("label" in source||"evidencePolicy" in source)return[source];
  for(const key of ["items","obligations","requirements","必答项"]){if(key in source){const nested=normalizeObligationCollection(source[key],depth+1);if(nested!==undefined)return nested;}}
  return Object.entries(source).map(([id,item])=>typeof item==="object"&&item!==null&&!Array.isArray(item)?{...item as Record<string,unknown>,id:(item as Record<string,unknown>).id??id}:item);
}

function redactRecords(records:readonly RepairRecord[],terms:readonly string[]):readonly RepairRecord[]{
  const redact=(value:string|undefined)=>value===undefined?undefined:terms.reduce((result,term)=>term.trim().length<2?result:result.replaceAll(term,"[用户]"),value);
  return records.map((record)=>({question:redact(record.question)!,...(record.rawQuestion===undefined?{}:{rawQuestion:redact(record.rawQuestion)!}),...(record.contextUsed===undefined?{}:{contextUsed:record.contextUsed}),...(record.parentQuestion===undefined?{}:{parentQuestion:redact(record.parentQuestion)!}),...(record.parentAnswerOutline===undefined?{}:{parentAnswerOutline:redact(record.parentAnswerOutline)!}),answer:redact(record.answer)!,
    ...(record.feedbackClassification===undefined?{}:{feedbackClassification:record.feedbackClassification}),
    ...(record.feedback===undefined?{}:{feedback:redact(record.feedback)!}),
    ...(record.proposedAnswer===undefined?{}:{proposedAnswer:redact(record.proposedAnswer)!}),
    ...(record.reviewSummary===undefined?{}:{reviewSummary:redact(record.reviewSummary)!}),
    ...(record.defects===undefined?{}:{defects:record.defects.map((defect)=>({...defect,summary:redact(defect.summary)!,evidence:redact(defect.evidence)!}))}),
  }));
}
function newCardId(domain:KnowledgeDomain,issueId:string):string{const prefix=domain==="coremail-professional"?"PRO":"GEN";return`${prefix}-REPAIR-${createHash("sha256").update(issueId).digest("hex").slice(0,12).toUpperCase()}`;}
function safeFileName(value:string,issueId:string):string{const cleaned=[...value.normalize("NFKC").replace(/[^\p{L}\p{N}_.\- ()（）]+/gu," ").replace(/\s+/gu," ").trim()].slice(0,80).join("").replace(/^\.+|\.+$/gu,"");return cleaned||`知识修订-${issueId.slice(0,8)}`;}
function unique(values:readonly string[]):string[]{return[...new Set(values)];}
function normalize(value:string):string{return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}
