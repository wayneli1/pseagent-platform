import { createHash } from "node:crypto";
import type { ModelClient } from "@pseagent/app/embedded";
import type { AnswerCard, FeedbackClassification, KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import {
  repairProposalSchema,
  type IssueCategory,
  type RepairDraftProposal,
  type RepairTargetKind,
} from "@pseagent/knowledge-ops";
import { z } from "zod";

const regressionKindSchema=z.enum(["canonical","alias","colloquial","follow_up","negative"]);
const obligationSchema=z.object({
  id:z.string().regex(/^O\d+$/u),label:z.string().trim().min(1).max(500),
  evidencePolicy:z.enum(["direct","synthesis","customer_input"]),
  requiredConcepts:z.array(z.string().trim().min(1).max(200)).max(50),
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
const caseAssessmentSchema=z.object({cases:z.unknown().optional()}).passthrough();

export interface RepairRecord {
  readonly question: string;
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
        "输出客户中立、可复用的答案卡草稿，不得出现聊天用户姓名、账号、内部标识或只对单个客户成立的表述。",
        "保留现有答案卡的安全边界、禁答主张和必答项，不得用更宽泛的承诺替换它们。",
        "必须生成五个且各一个回归问题：canonical 原始标准问法、alias 同义改写、colloquial 口语问法、follow_up 上下文追问、negative 边界负例。",
        "如果证据不能支持完整答案，将 publishable 设为 false 并写明 blockingReason。只输出严格 JSON。",
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
    let candidate:z.infer<typeof repairCandidateSchema>|undefined;let firstError:unknown;
    for(let attempt=1;attempt<=2;attempt+=1){
      try{candidate=await this.model.completeJson({messages:attempt===1?messages:[...messages,{role:"user",content:"上一次输出未通过严格 Schema。请只依据 evidence 修正，并保持五类回归问题各一个。"}],schema:repairCandidateSchema,schemaDescription:"knowledge repair draft with answer, obligations, evidence paths and five regression questions",...(input.signal===undefined?{}:{signal:input.signal})});break;}
      catch(error){firstError??=error;if(attempt===2)throw firstError;}
    }
    if(candidate===undefined)throw firstError;
    return enforceRepairCandidate(input,candidate);
  }
  async assess(input:{readonly proposal:RepairDraftProposal;readonly evidence:readonly RepairEvidence[];readonly signal?:AbortSignal}):Promise<readonly {readonly kind:z.infer<typeof regressionKindSchema>;readonly passed:boolean;readonly explanation:string}[]>{
    const messages=[{role:"system" as const,content:[
      "你是企业知识修订的独立验证员，固定使用 deepseek_v4_flash。只能依据 proposal 与 evidence 判定。",
      "对 canonical、alias、colloquial、follow_up：passed 表示该问法确实属于答案卡适用范围，且 answerTemplate 被正式证据支持并完整覆盖 obligations。",
      "对 negative：passed 表示该负例不应命中或套用这张答案卡，答案卡的适用边界能够排除它。",
      "五类必须各返回一项。证据不足、承诺超出资料、缺少必答项或负例仍会误命中时必须为 false。只输出严格 JSON。",
    ].join("\n")},{role:"user" as const,content:JSON.stringify({proposal:input.proposal,evidence:input.evidence})}];
    let result:z.infer<typeof caseAssessmentSchema>|undefined;let firstError:unknown;
    for(let attempt=1;attempt<=2;attempt+=1){try{result=await this.model.completeJson({messages:attempt===1?messages:[...messages,{role:"user",content:"上一次输出未通过 Schema。请按五类各一项重新输出，不要增加其他字段。"}],schema:caseAssessmentSchema,schemaDescription:"five knowledge repair validation case assessments",...(input.signal===undefined?{}:{signal:input.signal})});break;}catch(error){firstError??=error;if(attempt===2)throw firstError;}}
    if(result===undefined)throw firstError;return normalizeAssessments(result.cases??result);
  }
}

function enforceRepairCandidate(input:RepairGenerationInput,candidate:z.infer<typeof repairCandidateSchema>):RepairDraftProposal{
  const evidencePaths=new Set(input.evidence.map((item)=>item.path));
  const {obligations,unsupportedEvidence}=mergeObligations(candidate.obligations,input.route.existingCard,evidencePaths);
  const regressionQuestions=normalizeRegressionQuestions(input,candidate);
  const regressionAliases=regressionQuestions.filter((item)=>item.kind==="alias"||item.kind==="colloquial"||item.kind==="follow_up").map((item)=>item.question);
  const recordAliases=input.records.map((item)=>item.question.trim()).filter((question)=>question!==""&&!(input.sensitiveTerms??[]).some((term)=>term.trim().length>=2&&normalize(question).includes(normalize(term))));
  const aliases=unique([...(input.route.existingCard?.aliases??[]),...recordAliases,...candidate.aliases,...regressionAliases]).filter((value)=>normalize(value)!==normalize(candidate.canonicalQuestion));
  const protectedText=[candidate.title,candidate.canonicalQuestion,...aliases,candidate.answerTemplate,...obligations.flatMap((item)=>[item.label,...item.requiredConcepts,...item.forbiddenClaims])].join("\n");
  const leakedSensitive=(input.sensitiveTerms??[]).find((term)=>term.trim().length>=2&&normalize(protectedText).includes(normalize(term)));
  const forbiddenClaim=obligations.flatMap((item)=>item.forbiddenClaims).find((claim)=>claim!==""&&normalize(candidate.answerTemplate).includes(normalize(claim)));
  const missingEvidence=obligations.some((item)=>item.evidencePolicy!=="customer_input"&&item.preferredEvidencePaths.length===0);
  const modelBlockingReason=textValue(candidate.blockingReason);
  const contradictedIdentityBlock=!candidate.publishable&&modelBlockingReason!==undefined&&/(?:身份|姓名|客户名称|敏感)/u.test(modelBlockingReason)&&leakedSensitive===undefined;
  const reasons=[
    ...(candidate.publishable||contradictedIdentityBlock?[]:[modelBlockingReason??"模型认为当前证据不足。"]),
    ...(unsupportedEvidence?["草稿引用了未校验或不在当前知识版本中的资料。"]:[]),
    ...(missingEvidence?["至少一个必答项没有已校验的正式证据路径。"]:[]),
    ...(forbiddenClaim===undefined?[]:["候选答案命中了答案卡禁答主张。"]),
    ...(leakedSensitive===undefined?[]:["候选草稿包含聊天用户身份信息，已阻止发布。"]),
  ];
  const publishable=reasons.length===0;
  const existing=input.route.existingCard;
  const title=existing?.title??candidate.title,canonicalQuestion=existing?.canonicalQuestion??candidate.canonicalQuestion;
  const cardId=existing?.cardId??input.route.cardId??newCardId(input.route.targetDomain!,input.issueId);
  const targetPath=input.route.targetPath??`wiki/queries/${safeFileName(title,input.issueId)}.md`;
  return repairProposalSchema.parse({
    rootCause:input.rootCause,targetKind:input.route.targetKind,targetDomain:input.route.targetDomain,targetPath,cardId,
    title,canonicalQuestion,aliases,answerTemplate:candidate.answerTemplate,obligations,
    regressionQuestions,generationSummary:textValue(candidate.generationSummary)??"依据已校验正式资料生成知识修订草稿。",publishable,
    ...(publishable?{}:{blockingReason:unique(reasons).join(" ")}),
  }) as RepairDraftProposal;
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
  for(const item of entries){const kind=normalizeRegressionKind(typeof item.kind==="string"?item.kind:"");if(kind===undefined||recognized.has(kind))continue;const passed=item.passed===true||item.passed==="true"||item.passed==="通过";recognized.set(kind,{passed,explanation:textValue(item.explanation)??(passed?"模型判定通过。":"模型未提供可验证的通过说明。")});}
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
    return{id:baseline.id,label:proposed?.label??baseline.label,evidencePolicy:proposed?.evidencePolicy??baseline.evidencePolicy,
      requiredConcepts:unique([...baseline.requiredConcepts,...(proposed?.requiredConcepts??[])]),
      forbiddenClaims:unique([...baseline.forbiddenClaims,...(proposed?.forbiddenClaims??[])]),
      preferredEvidencePaths:unique([...baseline.preferredEvidencePaths,...(proposed?.preferredEvidencePaths??[])]),
    };
  }).concat([...byId.values()]);
  const obligations=source.slice(0,12).map((item)=>{
    const preferredEvidencePaths=item.preferredEvidencePaths.filter((path)=>evidencePaths.has(path));
    if(preferredEvidencePaths.length!==item.preferredEvidencePaths.length)unsupportedEvidence=true;
    return{...item,preferredEvidencePaths};
  });
  return{obligations,unsupportedEvidence};
}

function blockedProposal(input:RepairGenerationInput):RepairDraftProposal{
  const question=input.records[0]?.question.trim()||"待管理员确认的问题";
  const reason=input.route.blockingReason??"当前问题不能通过知识修订自动解决，需要管理员判断。";
  return repairProposalSchema.parse({rootCause:input.rootCause,targetKind:input.route.targetKind,
    ...(input.route.targetDomain===undefined?{}:{targetDomain:input.route.targetDomain}),
    ...(input.route.targetPath===undefined?{}:{targetPath:input.route.targetPath}),
    ...(input.route.cardId===undefined?{}:{cardId:input.route.cardId}),
    title:question.slice(0,500),canonicalQuestion:question.slice(0,1_000),aliases:[],answerTemplate:"",obligations:[],regressionQuestions:[],
    generationSummary:reason,publishable:false,blockingReason:reason}) as RepairDraftProposal;
}

function redactRecords(records:readonly RepairRecord[],terms:readonly string[]):readonly RepairRecord[]{
  const redact=(value:string|undefined)=>value===undefined?undefined:terms.reduce((result,term)=>term.trim().length<2?result:result.replaceAll(term,"[用户]"),value);
  return records.map((record)=>({question:redact(record.question)!,answer:redact(record.answer)!,
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
