import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeRuntimeStatus } from "./types.js";

export interface KnowledgeRuntimeStatusProvider {
  status():Promise<Omit<KnowledgeRuntimeStatus,"activeBatch">>;
}

export class HttpKnowledgeRuntimeStatusProvider implements KnowledgeRuntimeStatusProvider {
  private readonly baseUrl:string;
  constructor(private readonly config:{readonly baseUrl:string;readonly token:string;readonly snapshotRoot:string;readonly timeoutMs:number}){
    const url=new URL(config.baseUrl),loopback=["127.0.0.1","localhost","::1","[::1]"].includes(url.hostname);
    if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))throw new Error("knowledge_runtime_requires_https_or_loopback");
    if(config.token.trim()===""||!path.isAbsolute(config.snapshotRoot)||config.timeoutMs<500||config.timeoutMs>30_000)throw new Error("knowledge_runtime_status_config_invalid");
    this.baseUrl=url.toString().replace(/\/$/u,"");
  }
  async status():Promise<Omit<KnowledgeRuntimeStatus,"activeBatch">>{
    try{
      const [engine,snapshot]=await Promise.all([this.engineHealth(),this.activeSnapshot()]);
      const professional=engine.projects.find((item)=>item.project==="coremail-professional")?.revision,general=engine.projects.find((item)=>item.project==="presales-general")?.revision;
      const aligned=snapshot!==undefined&&professional===snapshot.professionalRevision&&general===snapshot.generalRevision;
      const state=engine.deployment.status==="reloading"?"switching":engine.deployment.status==="failed"||!aligned?"degraded":"aligned";
      return{state,checkedAt:new Date().toISOString(),servingPreviousVersion:engine.deployment.servingPreviousVersion,engineStatus:engine.deployment.status,...(engine.deployment.releaseId?{targetReleaseId:engine.deployment.releaseId}:{}),...(engine.deployment.errorCode?{errorCode:engine.deployment.errorCode}:{}),...(snapshot?{activeReleaseId:snapshot.releaseId,activeProfessionalRevision:snapshot.professionalRevision,activeGeneralRevision:snapshot.generalRevision}:{}),...(professional?{engineProfessionalRevision:professional}:{}),...(general?{engineGeneralRevision:general}:{})};
    }catch(error){return{state:"unavailable",checkedAt:new Date().toISOString(),servingPreviousVersion:true,engineStatus:"unavailable",errorCode:error instanceof Error?error.message:"knowledge_runtime_status_unavailable"};}
  }
  private async engineHealth():Promise<EngineHealth>{
    const response=await fetch(`${this.baseUrl}/health`,{headers:{authorization:`Bearer ${this.config.token}`},signal:AbortSignal.timeout(this.config.timeoutMs),redirect:"error"});
    if(!response.ok)throw new Error(`knowledge_runtime_http_${response.status}`);return parseEngineHealth(await response.json());
  }
  private async activeSnapshot():Promise<SnapshotManifest|undefined>{
    try{const pointer=record(JSON.parse(await readFile(path.join(this.config.snapshotRoot,"active.json"),"utf8"))),releaseId=string(pointer.releaseId);if(releaseId===undefined)return undefined;const manifest=record(JSON.parse(await readFile(path.join(this.config.snapshotRoot,"releases",releaseId,"release-manifest.json"),"utf8"))),professionalRevision=revision(manifest.professionalRevision),generalRevision=revision(manifest.generalRevision);if(professionalRevision===undefined||generalRevision===undefined)throw new Error("active_snapshot_manifest_invalid");return{releaseId,professionalRevision,generalRevision};}catch(error){if(isMissing(error))return undefined;throw error;}
  }
}

interface EngineHealth {readonly projects:readonly{readonly project:string;readonly revision:string}[];readonly deployment:{readonly status:"ready"|"reloading"|"failed";readonly servingPreviousVersion:boolean;readonly releaseId?:string;readonly errorCode?:string};}
interface SnapshotManifest {readonly releaseId:string;readonly professionalRevision:string;readonly generalRevision:string;}
function parseEngineHealth(value:unknown):EngineHealth{const source=record(value),projects=Array.isArray(source.projects)?source.projects.map((item)=>{const project=record(item),name=string(project.project),valueRevision=revision(project.revision);if(name===undefined||valueRevision===undefined)throw new Error("knowledge_runtime_health_invalid");return{project:name,revision:valueRevision};}):[],deployment=record(source.deployment),status=deployment.status,releaseId=string(deployment.releaseId),errorCode=string(deployment.errorCode);if(projects.length!==2||(status!=="ready"&&status!=="reloading"&&status!=="failed")||typeof deployment.servingPreviousVersion!=="boolean")throw new Error("knowledge_runtime_health_invalid");return{projects,deployment:{status,servingPreviousVersion:deployment.servingPreviousVersion,...(releaseId===undefined?{}:{releaseId}),...(errorCode===undefined?{}:{errorCode})}};}
function record(value:unknown):Record<string,unknown>{if(value===null||typeof value!=="object"||Array.isArray(value))throw new Error("knowledge_runtime_status_invalid");return value as Record<string,unknown>;}
function string(value:unknown):string|undefined{return typeof value==="string"&&value.trim()!==""?value:undefined;}
function revision(value:unknown):string|undefined{const result=string(value);return result!==undefined&&/^[a-f0-9]{40}$/u.test(result)?result:undefined;}
function isMissing(error:unknown):boolean{return typeof error==="object"&&error!==null&&"code" in error&&(error as{code?:unknown}).code==="ENOENT";}
