import type { RepairDraft,RepairProposal,RepairSuggestedAction,RepairValidation,RepairValidationDiagnostic,RepairValidationStage } from "./types.js";

export interface RepairAction {readonly id:"generate"|"validate"|"batch"|"retry"|"none";readonly label:string;readonly disabled:boolean;}
export interface RepairEvidenceState {readonly tone:"success"|"warning"|"blocked"|"unknown";readonly title:string;readonly summary:string;readonly details:readonly string[];}
export interface RepairValidationCaseState {readonly badge:"passed"|"validation_case_failed";readonly explanation:string;readonly diagnostic?:RepairValidationDiagnostic;}
type RepairValidationCase=NonNullable<NonNullable<RepairValidation["result"]>["targeted"]>[number];
export function repairStep(status:RepairDraft["status"]|undefined):number{if(status===undefined)return 1;if(status==="generating"||status==="draft_ready"||status==="validation_failed"||status==="failed")return 2;if(status==="validating")return 3;if(status==="ready_to_publish"||status==="publishing"||status==="published")return 4;return 2;}
export function repairPrimaryAction(draft:RepairDraft|undefined):RepairAction{
  if(draft===undefined)return{id:"generate",label:"生成修订草稿",disabled:false};
  if(draft.status==="generating")return{id:"none",label:"正在生成修订草稿…",disabled:true};
  if((draft.status==="draft_ready"||draft.status==="validation_failed")&&draft.proposal?.publishable===false)return{id:"retry",label:"重新校验正式证据并生成",disabled:false};
  if(draft.status==="draft_ready")return{id:"validate",label:"保存并开始自动验证",disabled:false};
  if(draft.status==="validation_failed")return{id:"validate",label:"保存修改并重新验证",disabled:false};
  if(draft.status==="validating")return{id:"none",label:"正在执行自动验证…",disabled:true};
  if(draft.status==="ready_to_publish")return{id:"batch",label:"加入待发布批次",disabled:false};
  if(draft.status==="publishing")return{id:"none",label:"正在发布并切换线上版本…",disabled:true};
  if(draft.status==="failed")return{id:"retry",label:"重新生成修订草稿",disabled:false};
  return{id:"none",label:"修订已发布生效",disabled:true};
}
export function isRepairEditable(status:RepairDraft["status"]):boolean{return status==="draft_ready"||status==="validation_failed";}
export function hasCompleteRepairProposal(draft:RepairDraft|undefined):boolean{return draft?.proposal?.publishable===true&&draft.proposal.answerTemplate.trim()!==""&&draft.proposal.aliases.length>0;}
export function shouldShowRepairDiff(draft:RepairDraft|undefined,originalAnswer:string|undefined):boolean{return hasCompleteRepairProposal(draft)&&(originalAnswer?.trim()??"")!=="";}
export function standaloneRepairAliases(proposal:RepairProposal):readonly string[]{
  const contextual=new Set(proposal.regressionQuestions.filter((item)=>item.kind==="follow_up"||item.kind==="negative").map((item)=>item.question.trim()));
  return proposal.aliases.filter((item)=>!contextual.has(item.trim()));
}
export function repairValidationCaseState(item:RepairValidationCase):RepairValidationCaseState{
  const diagnostic=item.diagnostics?.[0];if(diagnostic!==undefined)return{badge:"validation_case_failed",explanation:`${repairValidationStageLabel(diagnostic.stage)}：${diagnostic.message}`,diagnostic};
  if(item.kind!=="follow_up"&&item.kind!=="negative"&&!item.exactMatch)return{badge:"validation_case_failed",explanation:"问法命中检查未通过：该问法没有命中候选答案卡。"};
  if(item.kind==="negative"&&item.exactMatch)return{badge:"validation_case_failed",explanation:"边界检查未通过：无关问题错误命中了候选答案卡。"};
  if(item.assessment?.passed!==true)return{badge:"validation_case_failed",explanation:`结构与必答项检查未通过：${item.assessment?.explanation??"未返回可验证的通过结论。"}`};
  if(item.kind!=="negative"&&item.review?.verdict!=="pass"){
    const prefix=item.review?.verdict==="needs_review"?"独立内容复查需要人工复核":item.review?.verdict==="fail"?"独立内容复查未通过":"独立内容复查未返回通过结论";
    return{badge:"validation_case_failed",explanation:`${prefix}：${item.review?.summary??"请修改答案后重新验证。"}`};
  }
  if(!item.passed)return{badge:"validation_case_failed",explanation:"综合验证门禁未通过，请修改答案后重新验证。"};
  if(item.kind==="negative")return{badge:"passed",explanation:"边界检查通过：无关问题没有错误命中答案卡。"};
  if(item.kind==="follow_up")return{badge:"passed",explanation:"结构与必答项检查、独立内容复查均通过；上下文追问不要求直接命中答案卡。"};
  return{badge:"passed",explanation:"问法命中、结构与必答项检查、独立内容复查均通过。"};
}
export function repairValidationStageLabel(value:RepairValidationStage):string{return({card_match:"答案卡命中",obligation_coverage:"必答项覆盖",forbidden_claim:"禁止项边界",evidence_support:"证据支持",independent_review:"独立复核",rule_conflict:"规则冲突"} satisfies Record<RepairValidationStage,string>)[value];}
export function repairSuggestedActionLabel(value:RepairSuggestedAction):string{return({modify_answer:"修改答案",modify_rule:"修改规则",add_evidence:"补充证据",human_review:"人工复核"} satisfies Record<RepairSuggestedAction,string>)[value];}
export function repairValidationFieldLabel(value:RepairValidationDiagnostic["field"]):string{return value===undefined?"—":({requiredConcepts:"必须覆盖的概念",forbiddenClaims:"禁止出现的承诺",answerTemplate:"修订后的标准答案",preferredEvidencePaths:"正式证据路径"} as const)[value];}
export function repairValidationIsUnchanged(draft:RepairDraft|undefined,validation:RepairValidation|undefined):boolean{return draft?.status==="validation_failed"&&validation?.completedAt!==undefined&&new Date(draft.updatedAt).valueOf()<=new Date(validation.completedAt).valueOf();}
export function repairEvidenceState(draft:RepairDraft):RepairEvidenceState{
  const evidence=draft.evidenceSummary;if(evidence===undefined)return{tone:"unknown",title:"证据状态待刷新",summary:"这份草稿生成于证据摘要上线前，重新校验后会显示本次实际使用的正式资料。",details:[]};
  const details=evidence.issues.map(evidenceIssueText),rebased=evidence.revalidatedReferenceCount>0?`；其中 ${evidence.revalidatedReferenceCount} 条历史引用已确认正文未变化`:"";
  if(evidence.loadedCount===0)return{tone:"blocked",title:"没有可用的正式证据",summary:"修订 Agent 未收到可用于生成企业答案的正式资料。",details};
  if(details.length>0)return{tone:"warning",title:"部分正式证据可用",summary:`已加载 ${evidence.loadedCount} 条正式资料${rebased}，另有 ${details.length} 条引用未通过校验。`,details};
  return{tone:"success",title:"正式证据已校验",summary:`已加载 ${evidence.loadedCount} 条正式资料${rebased}。`,details};
}
function evidenceIssueText(value:string):string{
  if(value==="repair_domain_or_revision_missing")return"当前问题无法确定唯一知识库或知识版本。";
  const split=value.lastIndexOf(":"),target=split<0?"":value.slice(0,split),code=split<0?value:value.slice(split+1),name=target.split("/").at(-1)?.replace(/\.md$/u,"")||"一条引用";
  if(code==="path_rejected")return`“${name}”不在允许读取的知识库路径内。`;
  if(code==="unreadable")return`“${name}”当前不存在或无法读取。`;
  if(code==="reference_stale")return`“${name}”在复查后已经更新，旧引用不能继续作为证据。`;
  if(code==="content_hash_mismatch")return`“${name}”未通过内容完整性校验。`;
  if(code==="evidence_budget_exhausted")return`“${name}”超出本次证据处理容量，未送入 Agent。`;
  return"有一条正式资料暂时不可用，可在审计记录中查看技术原因。";
}
