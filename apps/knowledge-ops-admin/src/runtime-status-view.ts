import type { KnowledgeRuntimeStatus } from "./types.js";

export interface RuntimeStatusPresentation {readonly tone:"success"|"warning"|"danger"|"neutral";readonly title:string;readonly description:string;readonly stage:string;readonly busy:boolean;readonly alert:boolean;}

const STAGES:Readonly<Record<string,string>>={queued:"等待发布任务",running_global_regression:"正在运行 4 组 × 5 类真实回归",writing_git:"正在写入知识库",pushing_github:"正在批量同步 GitHub",reloading_engine:"正在后台构建新 Knowledge Engine 索引",activating_snapshot:"正在切换答案卡版本",verifying_online:"新版本已切换，正在核对线上版本",active:"新版本已在线生效",compensating:"发布异常，正在自动恢复上一版本",failed:"发布失败，上一版本继续服务",rolled_back:"已回退到稳定版本"};

export function runtimeStatusPresentation(status:KnowledgeRuntimeStatus):RuntimeStatusPresentation{
  const batch=status.activeBatch,stage=batch===undefined?"当前无发布任务":STAGES[batch.deploymentStage]??batch.deploymentStage;
  if(batch!==undefined&&(batch.status==="queued"||batch.status==="publishing")){
    const switched=!batch.servingPreviousVersion;
    return{tone:switched?"warning":"neutral",title:switched?"新知识版本已切换，正在做最后核对":"新知识版本正在准备，旧版本仍正常回答",description:switched?"线上流量已使用目标版本；系统核对 Knowledge Engine 与答案卡快照一致后才会标记发布完成。":"回归、GitHub 同步和新索引构建不会中断当前问答；任何一步失败都会保留或恢复上一稳定版本。",stage,busy:true,alert:false};
  }
  if(status.state==="aligned")return{tone:"success",title:"线上知识版本正常",description:`Knowledge Engine 与答案卡快照一致，当前版本 ${status.activeReleaseId??"已对齐"}。`,stage,busy:false,alert:false};
  if(status.state==="switching")return{tone:"neutral",title:"Knowledge Engine 正在准备新版本，旧版本仍正常回答",description:"新索引构建完成前不会切换线上流量。",stage,busy:true,alert:false};
  if(status.state==="degraded")return{tone:"danger",title:"线上知识版本需要检查",description:"Knowledge Engine 与答案卡快照不一致或最近一次切换失败；系统不会把该状态标记为发布完成。",stage,busy:false,alert:true};
  return{tone:"warning",title:"暂时无法读取线上知识状态",description:"管理服务未能取得 Knowledge Engine 状态；这不等于问答已停止，请检查服务连接。",stage,busy:false,alert:true};
}

export function deploymentStageLabel(value:string):string{return STAGES[value]??value;}
