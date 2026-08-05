import { createHash, randomUUID } from "node:crypto";
import type { AnswerReviewEncryptedPayload, KnowledgeOpsStore, OpsJob, RegressionRun } from "@pseagent/knowledge-ops";
import { ContentCipher } from "@pseagent/knowledge-ops";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { CatalogCompiler, type KnowledgeSource } from "./catalog-compiler.js";
import { SafeGitWorkspace, type GitFileChange } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";
import { loadReviewEvidence } from "./review-evidence.js";

export interface WorkerDependencies { readonly store:KnowledgeOpsStore; readonly sources:readonly KnowledgeSource[]; readonly snapshots:SnapshotManager; readonly git:SafeGitWorkspace; readonly cipher?:ContentCipher; readonly answerReviewer?:IndependentAnswerReviewer; }

export class KnowledgeOpsWorker {
  private readonly compiler=new CatalogCompiler();
  constructor(private readonly workerId:string,private readonly dependencies:WorkerDependencies){}
  async runOnce():Promise<boolean>{const job=await this.dependencies.store.claimJob(this.workerId);if(!job)return false;try{const result=await this.execute(job);await this.dependencies.store.completeJob(job.jobId,result);return true;}catch(error){await this.dependencies.store.failJob(job.jobId,safeCode(error));return true;}}
  private async execute(job:OpsJob):Promise<Record<string,unknown>>{
    switch(job.type){
      case "answer_review":return this.reviewAnswer(requireString(job.payload,"reviewId"));
      case "compile_catalog":{
        const catalog=await this.compile();
        const synced=await this.syncCatalog(catalog);
        return{catalogHash:hashCatalog(catalog),cardCount:catalog.cards.length,familyCount:catalog.families.length,syncedCardCount:synced.created,existingCardCount:synced.existing};
      }
      case "regression_run":return this.regression(job);
      case "publish_release":return this.publish(requireString(job.payload,"releaseId"));
      case "rollback_release":{const id=requireString(job.payload,"releaseId");await this.dependencies.snapshots.rollback(id);await this.dependencies.store.rollbackRelease(id);return{releaseId:id,active:true};}
      case "git_writeback":return this.writeback(job.payload);
    }
    throw new Error("unsupported_job_type");
  }
  private compile(){return this.compiler.compile(this.dependencies.sources);}
  private async syncCatalog(catalog:AnswerCardCatalog):Promise<{created:number;existing:number}>{
    const revisions=new Map(catalog.domains.map((domain)=>[domain.domain,domain.revision]));
    let created=0,existing=0;
    for(const card of catalog.cards){
      const baseGitRevision=revisions.get(card.domain);if(baseGitRevision===undefined)throw new Error("catalog_domain_revision_missing");
      const result=await this.dependencies.store.syncCatalogCardRevision({cardId:card.cardId,domain:card.domain,status:card.reviewStatus,content:structuredClone(card) as unknown as Record<string,unknown>,baseGitRevision});
      if(result.created)created++;else existing++;
    }
    return{created,existing};
  }
  private async reviewAnswer(reviewId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher,reviewer=this.dependencies.answerReviewer;if(cipher===undefined||reviewer===undefined)throw new Error("answer_reviewer_not_configured");
    const stored=await this.dependencies.store.getAnswerReview(reviewId);if(stored===undefined)throw new Error("answer_review_not_found");
    await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"running"});
    try{
      const payload=cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);const catalog=await this.compile();
      const exactCard=catalog.cards.find((card)=>isActiveCard(card.reviewStatus)&&[card.canonicalQuestion,...card.aliases].some((question)=>normalize(question)===normalize(payload.question)));
      const evidence=await loadReviewEvidence({sources:this.dependencies.sources,catalog,references:payload.references});
      const result=await reviewer.review({question:payload.question,answer:payload.answer,answerStatus:stored.answerStatus,evidence:evidence.documents,evidenceIssues:evidence.issues,...(exactCard===undefined?{}:{exactCard}),...(payload.answerCardActivation===undefined?{}:{answerCardActivation:payload.answerCardActivation})});
      const encryptedPayload=cipher.encrypt({...payload,result});const workflowStatus=result.verdict==="pass"?"resolved" as const:"open" as const;
      await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"completed",verdict:result.verdict,workflowStatus,encryptedPayload,score:result.score,defectCount:result.defects.length});
      return{reviewId,verdict:result.verdict,score:result.score,defectCount:result.defects.length};
    }catch(error){await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"errored",verdict:"pending",workflowStatus:"open",errorCode:safeCode(error)});throw error;}
  }
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
function isActiveCard(status:string){return status==="approved"||status==="release_ready"||status==="released";}
function hashCatalog(catalog:AnswerCardCatalog){return createHash("sha256").update(stableJson(catalog)).digest("hex");}
function stableJson(value:unknown):string{if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;if(value!==null&&typeof value==="object"){const r=value as Record<string,unknown>;return`{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(",")}}`;}return JSON.stringify(value);}
function safeCode(error:unknown){return error instanceof Error?error.message.replace(/[^a-z0-9_:.-]/giu,"_").slice(0,160):"worker_job_failed";}
