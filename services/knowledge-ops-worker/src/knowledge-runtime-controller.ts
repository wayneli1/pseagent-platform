import { z } from "zod";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";

const projectSchema=z.object({project:z.enum(["coremail-professional","presales-general"]),revision:z.string().regex(/^[a-f0-9]{40}$/u),lexicalStatus:z.string(),graphStatus:z.string()}).strict();
const deploymentSchema=z.object({status:z.enum(["ready","reloading","failed"]),servingPreviousVersion:z.boolean(),releaseId:z.string().optional().nullable(),professionalRevision:z.string().optional().nullable(),generalRevision:z.string().optional().nullable(),errorCode:z.string().optional().nullable()}).strict();
const healthSchema=z.object({status:z.literal("ready"),projects:z.array(projectSchema).length(2),deployment:deploymentSchema}).strict();
const reloadSchema=z.object({releaseId:z.string(),previousProjects:z.array(projectSchema).length(2),projects:z.array(projectSchema).length(2),oldVersionServedDuringReload:z.literal(true)}).strict();

export type KnowledgeRuntimeHealth=z.infer<typeof healthSchema>;

export interface KnowledgeRuntimeController {
  health():Promise<KnowledgeRuntimeHealth>;
  reload(releaseId:string,catalog:AnswerCardCatalog):Promise<KnowledgeRuntimeHealth>;
  assertAligned(catalog:AnswerCardCatalog):Promise<KnowledgeRuntimeHealth>;
}

export class HttpKnowledgeRuntimeController implements KnowledgeRuntimeController {
  private readonly baseUrl:string;
  constructor(private readonly config:{readonly baseUrl:string;readonly token:string;readonly timeoutMs:number}){
    const url=new URL(config.baseUrl),loopback=["127.0.0.1","localhost","::1","[::1]"].includes(url.hostname);
    if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))throw new Error("knowledge_runtime_requires_https_or_loopback");
    if(config.token.trim()===""||config.timeoutMs<1_000||config.timeoutMs>1_800_000)throw new Error("knowledge_runtime_config_invalid");
    this.baseUrl=url.toString().replace(/\/$/u,"");
  }
  async health():Promise<KnowledgeRuntimeHealth>{return healthSchema.parse(await this.request("/health"));}
  async reload(releaseId:string,catalog:AnswerCardCatalog):Promise<KnowledgeRuntimeHealth>{
    const professional=revision(catalog,"coremail-professional"),general=revision(catalog,"presales-general");
    const result=reloadSchema.parse(await this.request("/v1/reload",{releaseId,professionalRevision:professional,generalRevision:general}));
    if(revisionFromProjects(result.projects,"coremail-professional")!==professional||revisionFromProjects(result.projects,"presales-general")!==general)throw new Error("knowledge_runtime_reload_revision_mismatch");
    return this.assertAligned(catalog);
  }
  async assertAligned(catalog:AnswerCardCatalog):Promise<KnowledgeRuntimeHealth>{
    const health=await this.health();
    for(const domain of ["coremail-professional","presales-general"] as const)if(revisionFromProjects(health.projects,domain)!==revision(catalog,domain))throw new Error("knowledge_runtime_revision_mismatch");
    if(health.deployment.status!=="ready"||health.deployment.servingPreviousVersion)throw new Error("knowledge_runtime_not_ready");
    return health;
  }
  private async request(path:string,body?:unknown):Promise<unknown>{
    const signal=AbortSignal.timeout(this.config.timeoutMs),response=await fetch(this.baseUrl+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${this.config.token}`,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,redirect:"error"});
    if(!response.ok)throw new Error(`knowledge_runtime_http_${response.status}`);
    return response.json();
  }
}

function revision(catalog:AnswerCardCatalog,domain:"coremail-professional"|"presales-general"):string{const value=catalog.domains.find((item)=>item.domain===domain)?.revision;if(value===undefined)throw new Error("catalog_domain_revision_missing");return value;}
function revisionFromProjects(projects:readonly z.infer<typeof projectSchema>[],domain:"coremail-professional"|"presales-general"):string|undefined{return projects.find((item)=>item.project===domain)?.revision;}
