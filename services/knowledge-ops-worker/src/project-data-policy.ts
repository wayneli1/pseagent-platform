import {
  answerCardRuleConflictSchema,
  repairValidationDiagnosticSchema,
  type AnswerCardRuleConflict,
  type AnswerReviewDefect,
  type RepairValidationDiagnostic,
} from "@pseagent/knowledge-governance-contracts";
import type { RepairObligation } from "@pseagent/knowledge-ops";

export interface ProjectDataEvidence {
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface ForbiddenClaimRewrite {
  readonly originalRule: string;
  readonly adjustedRules: readonly string[];
  readonly reason: string;
}

interface NumericFact {
  readonly raw: string;
  readonly value: number;
  readonly metric: "users" | "authorizations" | "servers" | "nodes" | "systems" | "scale";
  readonly comparator: "exact" | "approx" | "gt" | "gte";
  readonly projects: readonly string[];
  readonly context: string;
  readonly path?: string;
}

const projectMetricPattern=/(?:用户(?:数|量|基数)?|授权(?:量|数)?|服务器(?:数量|数)?|节点(?:数量|数)?|部署规模|项目规模|规模数据)/u;
const scopedBoundaryPattern=/(?:描述为|视为|套用|扩大|推断|承诺|当前|实时|上限|超过|不少于|至少|其他客户|所有客户|所有项目|通用|标准配置)/u;
const broadBanVerbPattern=/(?:禁止|不得|不能|不应|不要).{0,16}(?:出现|回答|提供|披露|包含)/u;
const generalizationPattern=/(?:所有客户|其他客户|所有项目|通用配置|标准配置|产品(?:容量)?上限|容量上限|保证|承诺|新项目.{0,8}(?:一定|必须|均)|一定采用相同配置)/u;
const safeBoundaryPattern=/(?:不(?:代表|等于|作为|视为|是|应|可)|不得|不能|不应|不可|禁止).{0,24}(?:所有客户|其他客户|所有项目|通用配置|标准配置|产品(?:容量)?上限|容量上限|保证|承诺|套用|新项目)/u;
const currentClaimPattern=/(?:(?:当前|目前|现在)(?:的|项目|系统|用户|规模|容量|授权|部署|数据)?|实时(?:用户|规模|容量|授权|部署|数据))/u;
const abstractRequiredConceptPattern=/(?:核心功能|主要功能|功能概述|功能介绍|职责区分|职责区别|职责对比|职责说明|角色区别|角色差异|角色说明|协作关系|区别与联系|差异说明|相关内容|关键信息|具体说明)$/u;
const countedCollectionConceptPattern=/(?:\d+|[一二三四五六七八九十两]+)\s*个?(?:步骤|环节|阶段|流程|配置项|参数|字段|要点|事项)$/u;
const compoundConceptLabelPattern=/[：:]/u;
const compoundConceptSeparatorPattern=/[，,、；;]/gu;
export const PROJECT_DATA_POLICY_VERSION="2026-08-07.4";

export function isUnverifiableRequiredConcept(concept:string):boolean{
  const normalized=concept.normalize("NFKC").trim();
  const semanticLength=[...normalized.replace(/[\s\p{P}\p{S}]+/gu,"")].length;
  const separatorCount=[...normalized.matchAll(compoundConceptSeparatorPattern)].length;
  return abstractRequiredConceptPattern.test(normalized)||
    countedCollectionConceptPattern.test(normalized)||
    (semanticLength>28&&compoundConceptLabelPattern.test(normalized))||
    (semanticLength>24&&separatorCount>=2);
}

export function isBroadProjectDataForbiddenClaim(claim:string):boolean{
  const normalized=claim.trim();
  if(!projectMetricPattern.test(normalized))return false;
  if(scopedBoundaryPattern.test(normalized))return false;
  return broadBanVerbPattern.test(normalized)||/(?:项目|案例).{0,12}(?:具体)?(?:用户(?:数|量)?|授权(?:量|数)?|服务器(?:数量|数)?|节点(?:数量|数)?|部署规模|规模数据)$/u.test(normalized)||/(?:所有项目|全部项目).{0,8}(?:规模|数据)/u.test(normalized);
}

export function rewriteBroadProjectDataForbiddenClaims(claims:readonly string[]):{
  readonly claims:readonly string[];
  readonly rewrites:readonly ForbiddenClaimRewrite[];
}{
  const result:string[]=[];const rewrites:ForbiddenClaimRewrite[]=[];
  for(const claim of claims){
    if(!isBroadProjectDataForbiddenClaim(claim)){result.push(claim);continue;}
    const project=projectNameFromRule(claim),metric=metricLabel(claim),subject=project===undefined?"单一项目":`${project}项目`;
    const adjusted=[
      `不得将${subject}${metric}描述为产品容量上限`,
      `不得将${subject}${metric}套用到其他客户`,
      `不得将${subject}历史${metric}描述为当前实时数据或新客户承诺`,
    ];
    result.push(...adjusted);rewrites.push({originalRule:claim,adjustedRules:adjusted,reason:"正式证据中的项目数据可以回答，边界应限制跨项目套用、实时化和承诺化，而不是禁止数据本身。"});
  }
  return{claims:unique(result),rewrites};
}

export function inspectAnswerCardRuleConflicts(input:{
  readonly answerTemplate:string;
  readonly obligations:readonly RepairObligation[];
  readonly evidence:readonly ProjectDataEvidence[];
}):readonly AnswerCardRuleConflict[]{
  const projects=collectProjectNames(input.answerTemplate,input.evidence),answerFacts=extractFacts(input.answerTemplate,projects),evidenceFacts=input.evidence.flatMap((item)=>extractFacts(item.content,projects,item.path,item.title));
  const conflicts:AnswerCardRuleConflict[]=[];
  for(const obligation of input.obligations){
    for(const concept of obligation.requiredConcepts){
      if(!isUnverifiableRequiredConcept(concept))continue;
      conflicts.push(answerCardRuleConflictSchema.parse({
        code:"unverifiable_required_concept",obligationId:obligation.id,field:"requiredConcepts",
        triggerText:concept,rule:concept,
        message:`${obligation.id} 的必答概念“${concept}”是抽象、集合或复合陈述，无法用确定性规则稳定验证。请拆成正式证据和答案正文中实际出现的原子事实、动作或配置项。`,
        suggestedAction:"modify_rule",evidencePaths:obligation.preferredEvidencePaths,
      }));
    }
    for(const claim of obligation.forbiddenClaims){
      if(isBroadProjectDataForbiddenClaim(claim)){
        const fact=answerFacts.find((candidate)=>evidenceFacts.some((source)=>factsReferToSameData(candidate,source)&&comparatorSupported(source.comparator,candidate.comparator)));
        if(fact!==undefined)conflicts.push(answerCardRuleConflictSchema.parse({code:"evidence_supported_project_data_forbidden",obligationId:obligation.id,field:"forbiddenClaims",triggerText:fact.context,rule:claim,message:`答案中的“${fact.raw}”有正式证据支持，但 ${obligation.id} 同时笼统禁止项目具体数据。`,suggestedAction:"modify_rule",evidencePaths:obligation.preferredEvidencePaths}));
        continue;
      }
      const required=obligation.requiredConcepts.find((concept)=>sameGovernedConcept(concept,claim));
      if(required!==undefined)conflicts.push(answerCardRuleConflictSchema.parse({code:"required_forbidden_conflict",obligationId:obligation.id,field:"requiredConcepts",triggerText:required,rule:claim,message:`${obligation.id} 同时要求覆盖“${required}”并禁止同一内容。`,suggestedAction:"modify_rule",evidencePaths:obligation.preferredEvidencePaths}));
      const trigger=forbiddenTrigger(input.answerTemplate,claim);
      if(trigger!==undefined)conflicts.push(answerCardRuleConflictSchema.parse({code:/超过|不少于|至少|大于|高于/u.test(claim)?"numeric_boundary_conflict":"answer_forbidden_conflict",obligationId:obligation.id,field:"answerTemplate",triggerText:trigger,rule:claim,message:`答案正文触发了 ${obligation.id} 的证据边界。`,suggestedAction:"modify_answer",evidencePaths:obligation.preferredEvidencePaths}));
    }
  }
  return uniqueConflicts(conflicts);
}

export function evaluateProjectDataAnswer(input:{readonly question?:string;readonly answer:string;readonly evidence:readonly ProjectDataEvidence[]}):{
  readonly defects:readonly AnswerReviewDefect[];
  readonly diagnostics:readonly RepairValidationDiagnostic[];
}{
  const projects=collectProjectNames([input.question??"",input.answer].join("\n"),input.evidence),answerFacts=extractFacts(input.answer,projects),questionFacts=input.question===undefined?[]:extractFacts(input.question,projects),evidenceFacts=input.evidence.flatMap((item)=>extractFacts(item.content,projects,item.path,item.title));
  const diagnostics:RepairValidationDiagnostic[]=[];
  for(const fact of answerFacts.filter((item)=>item.projects.length>0)){
    const sameData=evidenceFacts.filter((source)=>factsReferToSameData(fact,source));
    const supported=sameData.find((source)=>comparatorSupported(source.comparator,fact.comparator));
    if(hasUnsafeProjectDataGeneralization(fact.context)){
      diagnostics.push(diagnostic("forbidden_claim",fact,"项目案例数据不得扩大为所有客户的通用配置、产品上限或新项目承诺。","modify_answer",supported?.path));continue;
    }
    if(fact.comparator!=="approx"&&currentClaimPattern.test(fact.context)&&sameData.some((source)=>source.comparator==="approx"||/(?:历史|案例|预测|预计)/u.test(source.context))){
      diagnostics.push(diagnostic("forbidden_claim",fact,"历史或预测项目数据不得描述为当前实时规模。","modify_answer",supported?.path));continue;
    }
    if(questionFacts.some((source)=>source.value===fact.value&&metricCompatible(source.metric,fact.metric)&&comparatorSupported(source.comparator,fact.comparator)))continue;
    if(supported!==undefined)continue;
    if(sameData.length>0){diagnostics.push(diagnostic("evidence_support",fact,`答案使用“${comparatorText(fact.comparator)}${fact.raw}”，但正式证据的数值口径不支持该比较关系。`,`modify_answer`,sameData[0]?.path));continue;}
    const sameValue=evidenceFacts.filter((source)=>source.value===fact.value&&metricCompatible(source.metric,fact.metric));
    if(sameValue.length>0){diagnostics.push(diagnostic("evidence_support",fact,"该数字只在其他项目证据中出现，不能跨项目套用。","modify_answer",sameValue[0]?.path));continue;}
    diagnostics.push(diagnostic("evidence_support",fact,"没有正式证据直接支持该项目数字。","add_evidence"));
  }
  const uniqueDiagnostics=uniqueDiagnosticsByKey(diagnostics),defects=uniqueDiagnostics.map((item):AnswerReviewDefect=>({category:item.stage==="evidence_support"?"citation_gap":"logic_gap",severity:"critical",summary:item.message,evidence:[item.triggerText,...item.evidencePaths].filter(Boolean).join("；").slice(0,1_000)}));
  return{defects,diagnostics:uniqueDiagnostics};
}

function hasUnsafeProjectDataGeneralization(context:string):boolean{
  return context.split(/[，,；;。！？!?]/u).some((clause)=>generalizationPattern.test(clause)&&!safeBoundaryPattern.test(clause));
}

export function conflictDiagnostics(conflicts:readonly AnswerCardRuleConflict[]):readonly RepairValidationDiagnostic[]{
  return conflicts.map((item)=>repairValidationDiagnosticSchema.parse({stage:"rule_conflict",obligationId:item.obligationId,field:item.field,triggerText:item.triggerText,rule:item.rule,message:item.message,suggestedAction:item.suggestedAction,evidencePaths:item.evidencePaths}));
}

function diagnostic(stage:"evidence_support"|"forbidden_claim",fact:NumericFact,message:string,suggestedAction:"modify_answer"|"add_evidence",path?:string):RepairValidationDiagnostic{
  return repairValidationDiagnosticSchema.parse({stage,field:"answerTemplate",triggerText:fact.context,rule:message,message,suggestedAction,evidencePaths:path===undefined?[]:[path]});
}

function extractFacts(text:string,projects:readonly string[],path?:string,title?:string):NumericFact[]{
  const result:NumericFact[]=[];let heading=title??"";
  for(const rawLine of text.replace(/\r\n?/gu,"\n").split("\n")){
    const line=rawLine.trim();if(line==="")continue;
    if(/^#{1,6}\s/u.test(line)){heading=line.replace(/^#{1,6}\s*/u,"");continue;}
    if(line.length<=100&&/(?:项目|案例)/u.test(line)&&!(/\d/u.test(line))&&/^\*\*/u.test(line)){heading=line.replace(/^\*\*|\*\*[：:]?$/gu,"");continue;}
    const context=`${heading} ${line}`.replace(/\s+/gu," ").trim();
    const pattern=/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)\s*(?:(?:万|千|亿|[wW])\s*(?:用户|授权|套(?:系统)?|台(?:服务器)?|个?节点|服务器)?|(?:用户|授权|套(?:系统)?|台(?:服务器)?|个?节点|服务器))/gu;
    for(const match of context.matchAll(pattern)){
      const raw=match[0],arabic=raw.match(/^\d+(?:\.\d+)?/u)?.[0],chinese=arabic===undefined?raw.match(/^[零〇一二两三四五六七八九十百千万亿]+/u)?.[0]:undefined,number=arabic===undefined?parseChineseInteger(chinese??""):Number.parseFloat(arabic),multiplier=arabic===undefined?1:/亿/u.test(raw)?100_000_000:/(?:万|[wW])/u.test(raw)?10_000:/千/u.test(raw)?1_000:1;
      const before=context.slice(Math.max(0,(match.index??0)-10),match.index??0),window=context.slice(Math.max(0,(match.index??0)-18),(match.index??0)+raw.length+18);
      const comparator=/(?:超过|超出|大于|高于)\s*$/u.test(before)?"gt":/(?:不少于|至少|不低于)\s*$/u.test(before)?"gte":/(?:约|大约|左右|预测|预计)[^，。；]{0,8}$/u.test(before)?"approx":"exact";
      const metric=/授权/u.test(raw)||(!/(?:用户|服务器|节点|套|台)/u.test(raw)&&/授权/u.test(window))?"authorizations":/用户|户/u.test(raw)||(!/(?:授权|服务器|节点|套|台)/u.test(raw)&&/用户|户/u.test(window))?"users":/服务器|台/u.test(raw)||(!/(?:授权|用户|节点|套)/u.test(raw)&&/服务器|台/u.test(window))?"servers":/节点/u.test(raw)||(!/(?:授权|用户|服务器|套|台)/u.test(raw)&&/节点/u.test(window))?"nodes":/套/u.test(raw)||/套/u.test(window)?"systems":"scale";
      result.push({raw,value:number*multiplier,metric,comparator,projects:projects.filter((project)=>context.includes(project)),context:context.slice(0,1_000),...(path===undefined?{}:{path})});
    }
  }
  return result;
}

function parseChineseInteger(value:string):number{
  const digits:Readonly<Record<string,number>>={零:0,"〇":0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const smallUnits:Readonly<Record<string,number>>={十:10,百:100,千:1_000};
  let total=0,section=0,digit=0;
  for(const character of value){
    const numeric=digits[character];if(numeric!==undefined){digit=numeric;continue;}
    const small=smallUnits[character];if(small!==undefined){section+=(digit||1)*small;digit=0;continue;}
    const large=character==="万"?10_000:character==="亿"?100_000_000:undefined;
    if(large!==undefined){section+=digit;total+=section*large;section=0;digit=0;}
  }
  return total+section+digit;
}

function collectProjectNames(answer:string,evidence:readonly ProjectDataEvidence[]):string[]{
  const values:string[]=[];
  for(const text of [answer,...evidence.flatMap((item)=>[item.title,item.content])]){
    for(const match of text.matchAll(/(?:^|[\s#*：:（(、，。])([\p{Script=Han}A-Za-z0-9·_-]{2,20}?)(?:Coremail)?(?:邮件系统)?(?:项目|案例)/gmu))values.push(cleanProjectName(match[1]??""));
  }
  for(const item of evidence){const company=item.title.replace(/(?:股份有限公司|有限责任公司|有限公司)$/u,"").trim();if(company!==item.title&&company.length>=2)values.push(company);}
  return unique(values.filter((item)=>item.length>=2&&!/(?:当前|本次|这个|该|单一|历史|正式|客户|邮件系统|多节点部署)$/u.test(item)));
}

function cleanProjectName(value:string):string{return value.replace(/^(?:关于|参考|例如|比如|禁止出现|不得出现|不能出现)/u,"").replace(/Coremail(?:邮件系统)?$/u,"").trim();}
function projectNameFromRule(claim:string):string|undefined{const match=claim.match(/([\p{Script=Han}A-Za-z0-9·_-]{2,20}?)(?:Coremail)?(?:邮件系统)?(?:项目|案例)/u);if(match===null)return undefined;const value=cleanProjectName(match[1]??"");return value.length>=2?value:undefined;}
function metricLabel(claim:string):string{if(/用户/u.test(claim))return"用户数";if(/授权/u.test(claim))return"授权量";if(/服务器/u.test(claim))return"服务器数量";if(/节点/u.test(claim))return"节点数量";return"规模数据";}
function comparatorText(value:NumericFact["comparator"]):string{return value==="gt"?"超过":value==="gte"?"不少于":value==="approx"?"约":"";}
function comparatorSupported(source:NumericFact["comparator"],answer:NumericFact["comparator"]):boolean{if(answer==="gt"||answer==="gte")return source===answer;return source==="exact"||source===answer;}
function metricCompatible(left:NumericFact["metric"],right:NumericFact["metric"]):boolean{return left===right||left==="scale"||right==="scale";}
function factsReferToSameData(left:NumericFact,right:NumericFact):boolean{return left.value===right.value&&metricCompatible(left.metric,right.metric)&&(left.projects.length===0||right.projects.length===0||left.projects.some((project)=>right.projects.includes(project)));}
function sameGovernedConcept(left:string,right:string):boolean{const a=normalize(left),b=normalize(right);return a!==""&&a===b;}
function forbiddenTrigger(answer:string,claim:string):string|undefined{
  const normalizedClaim=normalize(claim),lines=answer.split(/\r?\n/u).map((item)=>item.trim()).filter(Boolean);
  if(/(?:超过|超出|大于|高于)/u.test(claim)){const number=claim.match(/\d+(?:\.\d+)?\s*(?:万|千|亿|[wW])?/u)?.[0];return number===undefined?undefined:lines.find((line)=>/(?:超过|超出|大于|高于)/u.test(line)&&normalize(line).includes(normalize(number)));}
  if(/(?:不少于|至少|不低于)/u.test(claim)){const number=claim.match(/\d+(?:\.\d+)?\s*(?:万|千|亿|[wW])?/u)?.[0];return number===undefined?undefined:lines.find((line)=>/(?:不少于|至少|不低于)/u.test(line)&&normalize(line).includes(normalize(number)));}
  return lines.find((line)=>normalize(line).includes(normalizedClaim));
}
function normalize(value:string):string{return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}
function unique(values:readonly string[]):string[]{return [...new Set(values)];}
function uniqueConflicts(values:readonly AnswerCardRuleConflict[]):AnswerCardRuleConflict[]{const seen=new Set<string>();return values.filter((item)=>{const key=`${item.code}\0${item.obligationId}\0${item.field}\0${item.rule}\0${item.triggerText}`;if(seen.has(key))return false;seen.add(key);return true;});}
function uniqueDiagnosticsByKey(values:readonly RepairValidationDiagnostic[]):RepairValidationDiagnostic[]{const seen=new Set<string>();return values.filter((item)=>{const key=`${item.stage}\0${item.triggerText}\0${item.message}`;if(seen.has(key))return false;seen.add(key);return true;});}
