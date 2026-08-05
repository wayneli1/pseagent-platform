import type { RepairDraft } from "./types.js";

export interface RepairAction {readonly id:"generate"|"validate"|"publish"|"retry"|"none";readonly label:string;readonly disabled:boolean;}
export function repairStep(status:RepairDraft["status"]|undefined):number{if(status===undefined)return 1;if(status==="generating"||status==="draft_ready"||status==="validation_failed"||status==="failed")return 2;if(status==="validating")return 3;if(status==="ready_to_publish"||status==="publishing"||status==="published")return 4;return 2;}
export function repairPrimaryAction(draft:RepairDraft|undefined):RepairAction{
  if(draft===undefined)return{id:"generate",label:"生成修订草稿",disabled:false};
  if(draft.status==="generating")return{id:"none",label:"正在生成修订草稿…",disabled:true};
  if((draft.status==="draft_ready"||draft.status==="validation_failed")&&draft.proposal?.publishable===false)return{id:"retry",label:"重新生成完整草稿",disabled:false};
  if(draft.status==="draft_ready")return{id:"validate",label:"保存并开始自动验证",disabled:false};
  if(draft.status==="validation_failed")return{id:"validate",label:"保存修改并重新验证",disabled:false};
  if(draft.status==="validating")return{id:"none",label:"正在执行自动验证…",disabled:true};
  if(draft.status==="ready_to_publish")return{id:"publish",label:"发布并应用到后续回答",disabled:false};
  if(draft.status==="publishing")return{id:"none",label:"正在发布并切换线上版本…",disabled:true};
  if(draft.status==="failed")return{id:"retry",label:"重新生成修订草稿",disabled:false};
  return{id:"none",label:"修订已发布生效",disabled:true};
}
export function isRepairEditable(status:RepairDraft["status"]):boolean{return status==="draft_ready"||status==="validation_failed";}
export function hasCompleteRepairProposal(draft:RepairDraft|undefined):boolean{return draft?.proposal?.publishable===true&&draft.proposal.answerTemplate.trim()!==""&&draft.proposal.aliases.length>0;}
export function shouldShowRepairDiff(draft:RepairDraft|undefined,originalAnswer:string|undefined):boolean{return hasCompleteRepairProposal(draft)&&(originalAnswer?.trim()??"")!=="";}
