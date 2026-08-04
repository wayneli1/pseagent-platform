import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeOpsStore, OpsJob, RegressionRun } from "@pseagent/knowledge-ops";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { CatalogCompiler, type KnowledgeSource } from "./catalog-compiler.js";
import { SafeGitWorkspace, type GitFileChange } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";

export interface WorkerDependencies { readonly store:KnowledgeOpsStore; readonly sources:readonly KnowledgeSource[]; readonly snapshots:SnapshotManager; readonly git:SafeGitWorkspace; }

export class KnowledgeOpsWorker {
  private readonly compiler=new CatalogCompiler();
  constructor(private readonly workerId:string,private readonly dependencies:WorkerDependencies){}
  async runOnce():Promise<boolean>{const job=await this.dependencies.store.claimJob(this.workerId);if(!job)return false;try{const result=await this.execute(job);await this.dependencies.store.completeJob(job.jobId,result);return true;}catch(error){await this.dependencies.store.failJob(job.jobId,safeCode(error));return true;}}
  private async execute(job:OpsJob):Promise<Record<string,unknown>>{
    switch(job.type){
      case "compile_catalog":{const catalog=await this.compile();return{catalogHash:hashCatalog(catalog),cardCount:catalog.cards.length,familyCount:catalog.families.length};}
      case "regression_run":return this.regression(job);
      case "publish_release":return this.publish(requireString(job.payload,"releaseId"));
      case "rollback_release":{const id=requireString(job.payload,"releaseId");await this.dependencies.snapshots.rollback(id);await this.dependencies.store.rollbackRelease(id);return{releaseId:id,active:true};}
      case "git_writeback":return this.writeback(job.payload);
    }
    throw new Error("unsupported_job_type");
  }
  private compile(){return this.compiler.compile(this.dependencies.sources);}
  private async regression(job:OpsJob){
    const runId=typeof job.payload.runId==="string"?job.payload.runId:randomUUID();const catalog=await this.compile();const cases=await this.dependencies.store.listRegressionCases();
    const outcomes=cases.filter(x=>x.enabled).map(test=>{const normalized=normalize(test.question);const exact=catalog.cards.find(card=>[card.canonicalQuestion,...card.aliases].some(q=>normalize(q)===normalized));const passed=(test.expectedCardId===undefined||exact?.cardId===test.expectedCardId)&&test.forbiddenClaims.every(x=>!exact?.answerTemplate.includes(x));return{caseId:test.caseId,passed,actualCardId:exact?.cardId};});
    const passed=outcomes.filter(x=>x.passed).length;const timestamp=new Date().toISOString();const run:RegressionRun={runId,status:passed===outcomes.length?"passed":"failed",totalCases:outcomes.length,passedCases:passed,report:{outcomes},createdAt:timestamp,completedAt:timestamp};
    const existing=await this.dependencies.store.getRegressionRun(runId);if(existing)await this.dependencies.store.updateRegressionRun(run);else await this.dependencies.store.createRegressionRun(run);return{runId,status:run.status,totalCases:run.totalCases,passedCases:passed};
  }
  private async publish(releaseId:string){const release=(await this.dependencies.store.listReleases()).find(x=>x.releaseId===releaseId);if(!release)throw new Error("release_not_found");const catalog=await this.compile();
    if(catalog.domains.find(x=>x.domain==="coremail-professional")?.revision!==release.professionalRevision||catalog.domains.find(x=>x.domain==="presales-general")?.revision!==release.generalRevision)throw new Error("knowledge_revision_changed");
    const result=await this.dependencies.snapshots.publish(release.manifest,catalog);await this.dependencies.store.activateRelease(releaseId);return{releaseId,...result};}
  private async writeback(payload:Record<string,unknown>){const repositoryRoot=requireString(payload,"repositoryRoot"),baseRevision=requireString(payload,"baseRevision"),message=requireString(payload,"message");if(!Array.isArray(payload.changes))throw new Error("changes_required");const changes=payload.changes as GitFileChange[];return this.dependencies.git.writeRevision(repositoryRoot,baseRevision,changes,message);}
}
function requireString(value:Record<string,unknown>,key:string){const result=value[key];if(typeof result!=="string"||result.trim()==="")throw new Error(`${key}_required`);return result;}
function normalize(value:string){return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}
function hashCatalog(catalog:AnswerCardCatalog){return createHash("sha256").update(stableJson(catalog)).digest("hex");}
function stableJson(value:unknown):string{if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;if(value!==null&&typeof value==="object"){const r=value as Record<string,unknown>;return`{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(",")}}`;}return JSON.stringify(value);}
function safeCode(error:unknown){return error instanceof Error?error.message.replace(/[^a-z0-9_:.-]/giu,"_").slice(0,160):"worker_job_failed";}
