import { createHash } from "node:crypto";
import type { ModelClient } from "@pseagent/app/embedded";
import type { AnswerCard, KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
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
const repairCandidateSchema=z.object({
  title:z.string().trim().min(1).max(500),canonicalQuestion:z.string().trim().min(1).max(1_000),
  aliases:z.array(z.string().trim().min(1).max(1_000)).max(100),answerTemplate:z.string().trim().max(100_000),
  obligations:z.array(obligationSchema).min(1).max(12),
  regressionQuestions:z.array(z.object({kind:regressionKindSchema,question:z.string().trim().min(1).max(2_000)}).strict()).length(5),
  generationSummary:z.string().trim().min(1).max(4_000),publishable:z.boolean(),blockingReason:z.string().trim().min(1).max(4_000).optional(),
}).strict().superRefine((value,context)=>{
  const kinds=new Set(value.regressionQuestions.map((item)=>item.kind));
  if(regressionKindSchema.options.some((kind)=>!kinds.has(kind)))context.addIssue({code:"custom",path:["regressionQuestions"],message:"repair_requires_five_regression_kinds"});
  if(value.publishable&&value.answerTemplate==="")context.addIssue({code:"custom",path:["answerTemplate"],message:"publishable_repair_requires_answer_template"});
  if(!value.publishable&&value.blockingReason===undefined)context.addIssue({code:"custom",path:["blockingReason"],message:"non_publishable_repair_requires_reason"});
});

export interface RepairRecord {
  readonly question: string;
  readonly answer: string;
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
        "用户反馈和 proposedAnswer 只是问题线索，不是正式证据；只有被 evidence 支持的内容才能写入答案。",
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
}

function enforceRepairCandidate(input:RepairGenerationInput,candidate:z.infer<typeof repairCandidateSchema>):RepairDraftProposal{
  const evidencePaths=new Set(input.evidence.map((item)=>item.path));
  const {obligations,unsupportedEvidence}=mergeObligations(candidate.obligations,input.route.existingCard,evidencePaths);
  const aliases=unique([...(input.route.existingCard?.aliases??[]),...candidate.aliases]).filter((value)=>normalize(value)!==normalize(candidate.canonicalQuestion));
  const protectedText=[candidate.title,candidate.canonicalQuestion,...aliases,candidate.answerTemplate,...obligations.flatMap((item)=>[item.label,...item.requiredConcepts,...item.forbiddenClaims])].join("\n");
  const leakedSensitive=(input.sensitiveTerms??[]).find((term)=>term.trim().length>=2&&normalize(protectedText).includes(normalize(term)));
  const forbiddenClaim=obligations.flatMap((item)=>item.forbiddenClaims).find((claim)=>claim!==""&&normalize(candidate.answerTemplate).includes(normalize(claim)));
  const missingEvidence=obligations.some((item)=>item.evidencePolicy!=="customer_input"&&item.preferredEvidencePaths.length===0);
  const reasons=[
    ...(candidate.publishable?[]:[candidate.blockingReason??"模型认为当前证据不足。"]),
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
    regressionQuestions:candidate.regressionQuestions,generationSummary:candidate.generationSummary,publishable,
    ...(publishable?{}:{blockingReason:unique(reasons).join(" ")}),
  }) as RepairDraftProposal;
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
