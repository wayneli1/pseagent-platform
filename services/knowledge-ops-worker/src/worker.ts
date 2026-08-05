import { createHash, randomUUID } from "node:crypto";
import type { AnswerReviewEncryptedPayload, AnswerReviewReference, IssueCategory, IssuePriority, KnowledgeOpsStore, OpsJob, RegressionRun, StoredAnswerReviewCase } from "@pseagent/knowledge-ops";
import { ContentCipher } from "@pseagent/knowledge-ops";
import type { AnswerCardCatalog, KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import { CatalogCompiler, type KnowledgeSource } from "./catalog-compiler.js";
import { SafeGitWorkspace, type GitFileChange } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";
import { loadReviewEvidence } from "./review-evidence.js";
import { KnowledgeRepairAgent, type RepairRecord, type RepairRoute } from "./repair-agent.js";
import { catalogRevision, domainForIssueScope, findCardByHashedKey, loadRepairEvidence, locateAnswerCard, type LocatedAnswerCard } from "./repair-evidence.js";

export interface WorkerDependencies { readonly store:KnowledgeOpsStore; readonly sources:readonly KnowledgeSource[]; readonly snapshots:SnapshotManager; readonly git:SafeGitWorkspace; readonly cipher?:ContentCipher; readonly answerReviewer?:IndependentAnswerReviewer; readonly repairAgent?:KnowledgeRepairAgent; }

export class KnowledgeOpsWorker {
  private readonly compiler=new CatalogCompiler();
  constructor(private readonly workerId:string,private readonly dependencies:WorkerDependencies){}
  async runOnce():Promise<boolean>{const job=await this.dependencies.store.claimJob(this.workerId);if(!job)return false;try{const result=await this.execute(job);await this.dependencies.store.completeJob(job.jobId,result);return true;}catch(error){await this.dependencies.store.failJob(job.jobId,safeCode(error));return true;}}
  private async execute(job:OpsJob):Promise<Record<string,unknown>>{
    switch(job.type){
      case "answer_review":return this.reviewAnswer(requireString(job.payload,"reviewId"));
      case "generate_repair_draft":return this.generateRepairDraft(requireString(job.payload,"draftId"));
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
    let payload:AnswerReviewEncryptedPayload|undefined;let machineCompleted=false;
    try{
      const decrypted=cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);payload=decrypted;const catalog=await this.compile();
      const exactCard=catalog.cards.find((card)=>isActiveCard(card.reviewStatus)&&[card.canonicalQuestion,...card.aliases].some((question)=>normalize(question)===normalize(decrypted.question)));
      const evidence=await loadReviewEvidence({sources:this.dependencies.sources,catalog,references:decrypted.references});
      const result=await reviewer.review({question:decrypted.question,answer:decrypted.answer,answerStatus:stored.answerStatus,evidence:evidence.documents,evidenceIssues:evidence.issues,...(exactCard===undefined?{}:{exactCard}),...(decrypted.answerCardActivation===undefined?{}:{answerCardActivation:decrypted.answerCardActivation})});
      const encryptedPayload=cipher.encrypt({...decrypted,result});const workflowStatus=result.verdict==="pass"?"resolved" as const:"open" as const;
      await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"completed",verdict:result.verdict,workflowStatus,encryptedPayload,score:result.score,defectCount:result.defects.length});
      machineCompleted=true;
      if(result.verdict!=="pass")await this.recordReviewIssue(stored,payload,result.verdict==="fail"?"p0":"p1",primaryIssueCategory(result));
      else{const feedback=await this.dependencies.store.getFeedbackByRequestId(stored.requestId);if(feedback!==undefined&&feedback.classification!=="useful"&&feedback.status!=="resolved"&&feedback.status!=="rejected")await this.recordReviewIssue(stored,payload,"p1","judgement_conflict");}
      return{reviewId,verdict:result.verdict,score:result.score,defectCount:result.defects.length};
    }catch(error){if(!machineCompleted){await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"errored",verdict:"pending",workflowStatus:"open",errorCode:safeCode(error)});await this.recordReviewIssue(stored,payload,"p3","review_error");}throw error;}
  }
  private async generateRepairDraft(draftId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher,agent=this.dependencies.repairAgent;if(cipher===undefined||agent===undefined)throw new Error("repair_agent_not_configured");
    const draft=await this.dependencies.store.getRepairDraft(draftId);if(draft===undefined)throw new Error("repair_draft_not_found");
    try{
      const issue=await this.dependencies.store.getIssue(draft.issueId);if(issue===undefined)throw new Error("repair_issue_not_found");
      if(issue.status==="dismissed"||issue.status==="resolved")throw new Error("repair_issue_closed");
      const context=await this.loadRepairRecords(issue.issueId,cipher),catalog=await this.compile();
      const catalogCard=findCardByHashedKey(catalog,issue.answerCardKey),located=catalogCard===undefined?undefined:await locateAnswerCard(this.dependencies.sources,catalog,catalogCard.cardId);
      const domain=located?.card.domain??catalogCard?.domain??domainForIssueScope(issue.scope),source=domain===undefined?undefined:this.dependencies.sources.find((item)=>item.domain===domain),revision=domain===undefined?undefined:catalogRevision(catalog,domain);
      const paths=located===undefined?[]:[located.path,...located.card.obligations.flatMap((item)=>item.preferredEvidencePaths)];
      const evidence=source===undefined||revision===undefined?{documents:[],issues:["repair_domain_or_revision_missing"]}:await loadRepairEvidence({source,revision,paths,references:context.references});
      const route=repairRoute({category:issue.category,domain,revision,located,hasEvidence:evidence.documents.length>0});
      const proposal=await agent.generate({issueId:issue.issueId,rootCause:issue.category,records:context.records,evidence:evidence.documents,route,sensitiveTerms:context.sensitiveTerms});
      const currentIssue=await this.dependencies.store.getIssue(issue.issueId);if(currentIssue?.status==="dismissed"||currentIssue?.status==="resolved")throw new Error("repair_issue_closed");
      const updated=await this.dependencies.store.updateRepairDraft(draftId,{status:"draft_ready",targetKind:proposal.targetKind,
        ...(proposal.targetDomain===undefined?{}:{targetDomain:proposal.targetDomain}),...(proposal.targetPath===undefined?{}:{targetPath:proposal.targetPath}),
        ...(route.baseGitRevision===undefined?{}:{baseGitRevision:route.baseGitRevision}),encryptedPayload:cipher.encrypt({proposal,evidenceIssues:evidence.issues})});
      if(updated===undefined)throw new Error("repair_draft_update_failed");await this.dependencies.store.updateIssue(issue.issueId,"in_progress");
      const timestamp=new Date().toISOString();await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.generated",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:issue.issueId,targetKind:proposal.targetKind,publishable:proposal.publishable,evidenceCount:evidence.documents.length,evidenceIssueCount:evidence.issues.length},createdAt:timestamp});
      return{draftId,status:updated.status,targetKind:proposal.targetKind,publishable:proposal.publishable,evidenceCount:evidence.documents.length};
    }catch(error){const code=safeCode(error);await this.dependencies.store.updateRepairDraft(draftId,{status:"failed",errorCode:code});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.failed",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:draft.issueId,errorCode:code},createdAt:new Date().toISOString()});throw error;}
  }
  private async loadRepairRecords(issueId:string,cipher:ContentCipher):Promise<{readonly records:readonly RepairRecord[];readonly references:readonly AnswerReviewReference[];readonly sensitiveTerms:readonly string[]}>{
    const records:RepairRecord[]=[];const references:AnswerReviewReference[]=[];const sensitiveTerms:string[]=[];const seenReviews=new Set<string>();
    const appendReview=async(reviewId:string)=>{if(seenReviews.has(reviewId))return;seenReviews.add(reviewId);const stored=await this.dependencies.store.getAnswerReview(reviewId);if(stored===undefined)return;const payload=cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);if(payload.userDisplayName)sensitiveTerms.push(payload.userDisplayName);references.push(...payload.references);records.push({question:payload.question,answer:payload.answer,...(payload.result===undefined?{}:{reviewSummary:payload.result.summary,defects:payload.result.defects})});};
    for(const occurrence of await this.dependencies.store.listIssueOccurrences(issueId)){
      if(occurrence.sourceType==="answer_review"){await appendReview(occurrence.sourceId);continue;}
      const stored=await this.dependencies.store.getFeedback(occurrence.sourceId);if(stored===undefined)continue;
      const payload=cipher.decrypt<{question:string;answer:string;comment:string;proposedAnswer?:string;userDisplayName?:string}>(stored.encryptedPayload);if(payload.userDisplayName)sensitiveTerms.push(payload.userDisplayName);
      records.push({question:payload.question,answer:payload.answer,...(payload.comment.trim()===""?{}:{feedback:payload.comment}),...(payload.proposedAnswer===undefined?{}:{proposedAnswer:payload.proposedAnswer})});
      const linked=await this.dependencies.store.getAnswerReviewByRequestId(stored.requestId);if(linked!==undefined)await appendReview(linked.reviewId);
    }
    if(records.length===0)throw new Error("repair_issue_has_no_records");return{records,references:uniqueReferences(references),sensitiveTerms:[...new Set(sensitiveTerms)]};
  }
  private async recordReviewIssue(stored:StoredAnswerReviewCase,payload:AnswerReviewEncryptedPayload|undefined,priority:IssuePriority,category:IssueCategory){const questionKey=hashText(normalize(payload?.question??stored.reviewId));const answerCardKey=cardKey(payload?.answerCardMatch);const groupKey=answerCardKey??questionKey;const occurredAt=new Date().toISOString();const issue=await this.dependencies.store.recordIssue({fingerprint:hashText(`${stored.scope??"unknown"}\0${groupKey}\0${category}`),title:`review:${category}:${groupKey.slice(0,12)}`,priority,category,...(stored.scope?{scope:stored.scope}:{}),...(answerCardKey?{answerCardKey}:{}),occurredAt,occurrence:{sourceType:"answer_review",sourceId:stored.reviewId,requestId:stored.requestId,pseudonymousUserId:stored.pseudonymousUserId}});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"issue.review.upsert",resourceType:"issue_case",resourceId:issue.issueId,metadata:{priority:issue.priority,category:issue.category},createdAt:occurredAt});}
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
function primaryIssueCategory(result:{readonly defects:readonly{readonly category:IssueCategory;readonly severity:string}[]}):IssueCategory{return result.defects.find((item)=>item.severity==="critical")?.category??result.defects.find((item)=>item.severity==="major")?.category??result.defects[0]?.category??"coverage_gap";}
function cardKey(match:Record<string,unknown>|undefined):string|undefined{const values=match?.cardIdHashes;return Array.isArray(values)&&typeof values[0]==="string"&&/^[a-f0-9]{64}$/u.test(values[0])?values[0]:undefined;}
function hashText(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}
function repairRoute(input:{readonly category:IssueCategory;readonly domain:KnowledgeDomain|undefined;readonly revision:string|undefined;readonly located:LocatedAnswerCard|undefined;readonly hasEvidence:boolean}):RepairRoute{
  if(input.category==="logic_gap"||input.category==="judgement_conflict"||input.category==="review_error")return{targetKind:"system_fix",publishableAllowed:false,blockingReason:input.category==="judgement_conflict"?"用户反馈与自动复查结论冲突，需要管理员裁决，不能自动写入知识库。":"该问题属于逻辑或程序链路，不应通过改写企业知识掩盖，需要创建系统修复任务。"};
  if(input.category==="knowledge_gap")return{targetKind:"knowledge_page",...(input.domain===undefined?{}:{targetDomain:input.domain}),publishableAllowed:false,blockingReason:"正式资料存在缺口，请先由管理员补充和确认知识来源，再生成答案卡。"};
  if(input.domain===undefined||input.revision===undefined)return{targetKind:"knowledge_page",publishableAllowed:false,blockingReason:"无法确定问题属于专业知识库还是通用售前知识库，需要管理员判断。"};
  if(input.located!==undefined)return{targetKind:"answer_card",targetDomain:input.domain,targetPath:input.located.path,cardId:input.located.card.cardId,baseGitRevision:input.revision,existingCard:input.located.card,publishableAllowed:true};
  if(!input.hasEvidence)return{targetKind:"knowledge_page",targetDomain:input.domain,baseGitRevision:input.revision,publishableAllowed:false,blockingReason:"没有已校验的正式证据，不能把用户反馈直接固化为企业答案。"};
  return{targetKind:"answer_card",targetDomain:input.domain,baseGitRevision:input.revision,publishableAllowed:true};
}
function uniqueReferences(references:readonly AnswerReviewReference[]):AnswerReviewReference[]{const seen=new Set<string>();return references.filter((item)=>{const key=`${item.project}\0${item.path}\0${item.revision}\0${item.contentHash}`;if(seen.has(key))return false;seen.add(key);return true;});}
