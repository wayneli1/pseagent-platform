import {
  answerReviewResultSchema,
  type AnswerCard,
  type AnswerReviewResult,
} from "@pseagent/knowledge-governance-contracts";
import type { ModelClient } from "@pseagent/app/embedded";
import { evaluateProjectDataAnswer, inspectAnswerCardRuleConflicts, isUnverifiableRequiredConcept } from "./project-data-policy.js";

export interface ReviewEvidenceDocument {
  readonly index: number;
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface IndependentAnswerReviewInput {
  readonly question: string;
  readonly rawQuestion?: string;
  readonly conversation?: {
    readonly contextUsed: boolean;
    readonly parentQuestion?: string;
    readonly parentAnswerOutline?: string;
  };
  readonly answer: string;
  readonly answerStatus: string;
  readonly evidence: readonly ReviewEvidenceDocument[];
  readonly evidenceIssues: readonly string[];
  readonly exactCard?: AnswerCard;
  readonly answerCardActivation?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export class IndependentAnswerReviewer {
  constructor(private readonly model:ModelClient){}

  async review(input:IndependentAnswerReviewInput):Promise<AnswerReviewResult>{
    const messages=[
        {role:"system",content:[
          "你是企业知识问答的独立复查员，不参与原回答生成。",
          "只能依据输入中的已批准答案卡和正式知识页面判断，不得使用外部知识补足。",
          "受评对象只能是 input.answer。evidence 只是判定基准；正式资料写了某项，不代表回答已经写了该项。",
          "逐项检查正确性、完整性、逻辑、引用和表达；证据不足时选择 needs_review，不得猜测 pass。",
          "exactCard 存在时，必须为每个 required obligation 返回且只返回一个 obligationChecks 项。",
          "发现与正式证据冲突的关键结论时选择 fail；缺项或证据不足选择 needs_review。",
          "正式证据直接支持的项目用户数、授权量、服务器数、节点数和部署规模允许出现。重点检查项目归属、数据口径、跨项目套用、历史数据实时化、产品上限化和对新客户的承诺，不得仅因答案包含具体数字而失败。",
          "不要要求 answer 包含手工 [1] 等引用编号；修订验证依据 evidence 与 preferredEvidencePaths 检查事实支持，在线引用编号由回答系统另行生成。",
          "score 采用 0-100 正向评分，0 最差、100 最好；pass 必须为 80-100 分。",
          "只输出一个 JSON 对象，不输出推理过程或额外字段。必须严格使用以下结构和类型：",
          '{"verdict":"pass|needs_review|fail","score":0,"summary":"字符串","defects":[{"category":"knowledge_gap|retrieval_gap|planning_gap|coverage_gap|logic_gap|citation_gap|expression_gap","severity":"critical|major|minor","summary":"字符串","evidence":"字符串"}],"obligationChecks":[{"obligationId":"O1","covered":true,"explanation":"字符串"}]}',
        ].join("\n")},
        {role:"user",content:JSON.stringify({
          question:input.question,
          rawQuestion:input.rawQuestion??input.question,
          conversation:input.conversation??null,
          answer:input.answer,
          answerStatus:input.answerStatus,
          evidenceIssues:input.evidenceIssues,
          exactCard:input.exactCard===undefined?null:{
            cardId:input.exactCard.cardId,
            canonicalQuestion:input.exactCard.canonicalQuestion,
            obligations:input.exactCard.obligations.filter((item)=>item.required).map((item)=>({
              id:item.id,label:item.label,requiredConcepts:item.requiredConcepts,forbiddenClaims:item.forbiddenClaims,
            })),
          },
          answerCardActivation:input.answerCardActivation??null,
          evidence:input.evidence.map((document)=>({
            index:document.index,title:document.title,path:document.path,content:document.content,
          })),
        })},
      ] as const;
    let modelResult:AnswerReviewResult|undefined;let firstError:unknown;
    for(let attempt=1;attempt<=2;attempt+=1){
      try{modelResult=await this.model.completeJson({messages:attempt===1?messages:[...messages,{role:"user",content:"上一次输出未通过严格 Schema。请重新检查 input.answer，而不是复述 evidence，并严格按指定 JSON 键名和类型输出。"}],schema:answerReviewResultSchema,schemaDescription:"answer review result: verdict, score, summary, defects, obligationChecks",...(input.signal===undefined?{}:{signal:input.signal})});break;}catch(error){firstError??=error;if(attempt===2)throw firstError;}
    }
    if(modelResult===undefined)throw firstError;
    return enforceDeterministicReview(input,modelResult);
  }
}

export function enforceDeterministicReview(
  input:IndependentAnswerReviewInput,
  modelResult:AnswerReviewResult,
):AnswerReviewResult{
  const projectData=evaluateProjectDataAnswer({answer:input.answer,evidence:input.evidence});
  const modelDefects=modelResult.defects.filter((defect)=>!isRuntimeCitationNumberingDefect(defect)&&!isSupportedProjectDataFalsePositive(defect,projectData.diagnostics.length));
  const defects=[...modelDefects,...projectData.defects];
  let forceFail=false;
  if(projectData.defects.some((defect)=>defect.severity==="critical"))forceFail=true;
  if(input.answerStatus!=="answered"){
    defects.push({category:"coverage_gap",severity:"major",summary:`回答状态为 ${input.answerStatus}，不能自动判为完整通过`,evidence:"回答交付元数据"});
  }
  for(const issue of input.evidenceIssues){
    defects.push({category:"citation_gap",severity:"major",summary:"正式引用未通过独立校验",evidence:issue.slice(0,1_000)});
  }
  if(input.evidence.length===0){
    defects.push({category:"citation_gap",severity:"major",summary:"没有可供独立复查的正式知识页面",evidence:"复查证据包为空"});
  }
  const required=input.exactCard?.obligations.filter((item)=>item.required)??[];
  const ruleConflicts=input.exactCard===undefined?[]:inspectAnswerCardRuleConflicts({answerTemplate:input.answer,obligations:required,evidence:input.evidence}).filter((item)=>item.code!=="unverifiable_required_concept");
  for(const conflict of ruleConflicts){forceFail=true;defects.push({category:"logic_gap",severity:"critical",summary:`答案卡规则冲突（${conflict.obligationId}）`,evidence:`${conflict.message} 规则：${conflict.rule}`.slice(0,1_000)});}
  const checks=new Map(modelResult.obligationChecks.map((check)=>[check.obligationId,check] as const));
  const normalizedAnswer=normalize(input.answer);
  for(const obligation of required){
    const check=checks.get(obligation.id);
    if(check===undefined){
      defects.push({category:"planning_gap",severity:"major",summary:`复查结果遗漏必答项 ${obligation.id}`,evidence:obligation.label});
    }else if(!check.covered){
      defects.push({category:"coverage_gap",severity:"major",summary:`必答项 ${obligation.id} 未完整覆盖`,evidence:check.explanation});
    }
    const missingConcepts=obligation.requiredConcepts.filter((concept)=>!isUnverifiableRequiredConcept(concept)).filter((concept)=>
      !containsGovernedConcept(normalizedAnswer,normalize(concept)));
    if(missingConcepts.length>0){
      defects.push({category:"coverage_gap",severity:"major",summary:`必答项 ${obligation.id} 缺少受治理概念`,evidence:missingConcepts.join("、")});
    }
    const forbidden=obligation.forbiddenClaims.find((claim)=>normalizedAnswer.includes(normalize(claim)));
    if(forbidden!==undefined){forceFail=true;defects.push({category:"logic_gap",severity:"critical",summary:`回答包含答案卡禁答主张（${obligation.id}）`,evidence:forbidden});}
  }
  if(input.exactCard!==undefined&&input.answerCardActivation?.activated===false){
    defects.push({category:"planning_gap",severity:"major",summary:"精确命中已批准答案卡但在线回答未激活卡片约束",evidence:String(input.answerCardActivation.reason??"activation_disabled")});
  }
  const unique=uniqueDefects(defects);
  const hasMajor=unique.some((defect)=>defect.severity==="major"||defect.severity==="critical");
  const hasSubstantiveModelFailure=modelDefects.some((defect)=>defect.severity==="critical");
  const verdict=forceFail||(modelResult.verdict==="fail"&&hasSubstantiveModelFailure)
    ? "fail" as const
    : hasMajor
      ? "needs_review" as const
      : "pass" as const;
  const score=verdict==="fail"
    ? Math.min(modelResult.score,39)
    : verdict==="needs_review"
      ? Math.min(modelResult.score,69)
      : Math.max(modelResult.score,80);
  return answerReviewResultSchema.parse({...modelResult,verdict,score,defects:unique});
}

function isRuntimeCitationNumberingDefect(defect:AnswerReviewResult["defects"][number]):boolean{
  return defect.category==="citation_gap"&&/(?:\[\d+\]|引用编号|引用序号|手工引用|未标注编号)/u.test(`${defect.summary} ${defect.evidence}`);
}

function isSupportedProjectDataFalsePositive(defect:AnswerReviewResult["defects"][number],deterministicIssueCount:number):boolean{
  if(deterministicIssueCount>0)return false;
  const text=`${defect.summary} ${defect.evidence}`;
  return /(?:具体数字|具体数据|具体用户数|具体授权量|项目数据)/u.test(text)&&!/(?:跨项目|其他客户|产品上限|容量上限|承诺|当前|实时|无证据|证据不足|口径)/u.test(text);
}

function uniqueDefects(defects:AnswerReviewResult["defects"]):AnswerReviewResult["defects"]{
  const seen=new Set<string>();return defects.filter((defect)=>{const key=`${defect.category}\0${defect.severity}\0${defect.summary}\0${defect.evidence}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,20);
}

function normalize(value:string):string{return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}

function containsGovernedConcept(answer:string,concept:string):boolean{
  if(answer.includes(concept))return true;
  let answerIndex=0;
  for(const character of concept){
    answerIndex=answer.indexOf(character,answerIndex);
    if(answerIndex<0)return false;
    answerIndex+=character.length;
  }
  return true;
}
