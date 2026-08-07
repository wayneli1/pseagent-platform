import { createHash, randomUUID } from "node:crypto";
import type { AnswerReviewEncryptedPayload, AnswerReviewReference, IssueCategory, IssuePriority, KnowledgeOpsStore, OpsJob, OpsJobType, RegressionCaseRecord, RegressionRun, RepairDraftProposal, RepairPublication, ReleaseRecord, StoredAnswerReviewCase } from "@pseagent/knowledge-ops";
import { ContentCipher, isEvidenceBlockedProposal, repairProposalSchema } from "@pseagent/knowledge-ops";
import type { AnswerCard, AnswerCardCatalog, AnswerReviewResult, KnowledgeDomain, ReleaseManifest, RepairValidationDiagnostic } from "@pseagent/knowledge-governance-contracts";
import { CatalogCompiler, type KnowledgeSource } from "./catalog-compiler.js";
import { SafeGitWorkspace, type GitFileChange } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";
import { loadReviewEvidence } from "./review-evidence.js";
import { KnowledgeRepairAgent, type RepairRecord, type RepairRoute } from "./repair-agent.js";
import { catalogRevision, discoverRepairEvidencePaths, domainForIssueScope, findCardByHashedKey, loadRepairEvidence, locateAnswerCard, readKnowledgeFileAtRevision, type LocatedAnswerCard } from "./repair-evidence.js";
import { renderRepairMarkdown } from "./repair-renderer.js";
import { PROJECT_DATA_POLICY_VERSION, conflictDiagnostics, inspectAnswerCardRuleConflicts } from "./project-data-policy.js";
import type { KnowledgeRuntimeController } from "./knowledge-runtime-controller.js";
import type { ReleaseQualityGateReport, ReleaseQualityRunner } from "./release-quality-runner.js";
import { applyReleaseQualityEvent, finalizeReleaseQualityProgress, initialReleaseQualityProgress } from "./release-quality-progress.js";

export interface WorkerDependencies { readonly store:KnowledgeOpsStore; readonly sources:readonly KnowledgeSource[]; readonly snapshots:SnapshotManager; readonly git:SafeGitWorkspace; readonly cipher?:ContentCipher; readonly answerReviewer?:IndependentAnswerReviewer; readonly repairAgent?:KnowledgeRepairAgent; readonly answerContractRevision?:string; readonly runtimeController?:KnowledgeRuntimeController; readonly releaseQualityRunner?:ReleaseQualityRunner; }

export class KnowledgeOpsWorker {
  private readonly compiler=new CatalogCompiler();
  constructor(private readonly workerId:string,private readonly dependencies:WorkerDependencies){}
  async runOnce(types?:readonly OpsJobType[]):Promise<boolean>{const job=await this.dependencies.store.claimJob(this.workerId,types);if(!job)return false;const heartbeat=setInterval(()=>void this.dependencies.store.heartbeatJob(job.jobId,this.workerId).catch(()=>undefined),30_000);heartbeat.unref();try{const result=await this.execute(job);await this.dependencies.store.completeJob(job.jobId,result);return true;}catch(error){await this.handleJobFailure(job,error);return true;}finally{clearInterval(heartbeat);}}
  private async handleJobFailure(job:OpsJob,error:unknown):Promise<void>{
    const code=safeCode(error);
    if(job.type==="generate_repair_draft"){
      const draftId=requireString(job.payload,"draftId"),draft=await this.dependencies.store.getRepairDraft(draftId);
      if(draft!==undefined&&isTransientModelError(code)&&job.attempts<3){
        const delayMs=job.attempts===1?15_000:45_000,availableAt=new Date(Date.now()+delayMs).toISOString();
        await this.dependencies.store.updateRepairDraft(draftId,{status:"generating",errorCode:code});
        await this.dependencies.store.retryJob(job.jobId,code,availableAt);
        await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.retry_scheduled",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:draft.issueId,errorCode:code,attempt:job.attempts,maxAttempts:3,availableAt},createdAt:new Date().toISOString()});
        return;
      }
      if(draft!==undefined){await this.dependencies.store.updateRepairDraft(draftId,{status:"failed",errorCode:code});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.failed",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:draft.issueId,errorCode:code,attempt:job.attempts,maxAttempts:3},createdAt:new Date().toISOString()});}
    }
    if(job.type==="validate_repair_draft"){
      const draftId=requireString(job.payload,"draftId"),validationId=requireString(job.payload,"validationId"),draft=await this.dependencies.store.getRepairDraft(draftId);
      if(draft!==undefined&&isTransientModelError(code)&&job.attempts<3){
        const delayMs=job.attempts===1?15_000:45_000,availableAt=new Date(Date.now()+delayMs).toISOString();
        await this.dependencies.store.updateRepairValidation(validationId,{status:"queued",errorCode:code});
        await this.dependencies.store.updateRepairDraft(draftId,{status:"validating",errorCode:code});
        await this.dependencies.store.updateIssue(draft.issueId,"validating");
        await this.dependencies.store.retryJob(job.jobId,code,availableAt);
        await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.validation.retry_scheduled",resourceType:"repair_validation",resourceId:validationId,metadata:{draftId,issueId:draft.issueId,errorCode:code,attempt:job.attempts,maxAttempts:3,availableAt},createdAt:new Date().toISOString()});
        return;
      }
      const completedAt=new Date().toISOString(),encryptedPayload=this.dependencies.cipher?.encrypt({result:{passed:false,errorCode:code}});
      await this.dependencies.store.updateRepairValidation(validationId,{status:"failed",errorCode:code,...(encryptedPayload===undefined?{}:{encryptedPayload}),completedAt});
      if(draft!==undefined){await this.dependencies.store.updateRepairDraft(draftId,{status:"validation_failed",errorCode:code});await this.dependencies.store.updateIssue(draft.issueId,"in_progress");await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.validation.error",resourceType:"repair_validation",resourceId:validationId,metadata:{draftId,issueId:draft.issueId,errorCode:code,attempt:job.attempts,maxAttempts:3},createdAt:completedAt});}
    }
    await this.dependencies.store.failJob(job.jobId,code);
  }
  private async execute(job:OpsJob):Promise<Record<string,unknown>>{
    switch(job.type){
      case "answer_review":return this.reviewAnswer(requireString(job.payload,"reviewId"));
      case "generate_repair_draft":return this.generateRepairDraft(requireString(job.payload,"draftId"));
      case "validate_repair_draft":return this.validateRepairDraft(requireString(job.payload,"draftId"),requireString(job.payload,"validationId"));
      case "publish_repair":{const id=requireString(job.payload,"publicationId");return this.withPublicationRepositoryLock(id,()=>this.publishRepair(id));}
      case "publish_repair_batch":{const id=requireString(job.payload,"batchId");return this.withBatchRepositoryLocks(id,()=>this.publishRepairBatch(id));}
      case "rollback_repair":{const id=requireString(job.payload,"publicationId");return this.withPublicationRepositoryLock(id,()=>this.rollbackRepair(id));}
      case "rollback_repair_batch":{const id=requireString(job.payload,"batchId");return this.withBatchRepositoryLocks(id,()=>this.rollbackRepairBatch(id));}
      case "compile_catalog":{
        const catalog=await this.compile();
        const synced=await this.syncCatalog(catalog);
        const requeuedEvidenceDraftCount=await this.requeueEvidenceBlockedDrafts(catalog);
        return{catalogHash:hashCatalog(catalog),cardCount:catalog.cards.length,familyCount:catalog.families.length,syncedCardCount:synced.created,existingCardCount:synced.existing,requeuedEvidenceDraftCount};
      }
      case "reconcile_runtime":return this.reconcileRuntime();
      case "regression_run":return this.regression(job);
      case "publish_release":return this.publish(requireString(job.payload,"releaseId"));
      case "rollback_release":{const id=requireString(job.payload,"releaseId");await this.dependencies.snapshots.rollback(id);await this.dependencies.store.rollbackRelease(id);return{releaseId:id,active:true};}
      case "git_writeback":return this.writeback(job.payload);
    }
    throw new Error("unsupported_job_type");
  }
  private compile(){return this.compiler.compile(this.dependencies.sources);}
  private async withPublicationRepositoryLock<T>(publicationId:string,operation:()=>Promise<T>):Promise<T>{const publication=await this.dependencies.store.getRepairPublication(publicationId);if(publication===undefined)throw new Error("repair_publication_not_found");return this.withRepositoryLocks([publication.targetDomain],operation);}
  private async withBatchRepositoryLocks<T>(batchId:string,operation:()=>Promise<T>):Promise<T>{const batch=await this.dependencies.store.getRepairBatch(batchId);if(batch===undefined)throw new Error("repair_batch_not_found");return this.withRepositoryLocks(batch.domains,operation);}
  private async withRepositoryLocks<T>(domains:readonly KnowledgeDomain[],operation:()=>Promise<T>):Promise<T>{const ordered=[...new Set(domains)].sort();const visit=(index:number):Promise<T>=>index===ordered.length?operation():this.dependencies.store.withResourceLock(`knowledge-repository:${ordered[index]!}`,()=>visit(index+1));return visit(0);}
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
  private async requeueEvidenceBlockedDrafts(catalog:AnswerCardCatalog):Promise<number>{
    const cipher=this.dependencies.cipher;if(cipher===undefined)return 0;let count=0;const issues=[];
    for(let offset=0;;offset+=100){const page=await this.dependencies.store.listIssues({status:"awaiting_evidence",limit:100,offset});issues.push(...page.items);if(offset+page.items.length>=page.total)break;}
    for(const issue of issues){
      const draft=(await this.dependencies.store.listRepairDrafts(issue.issueId)).find((item)=>item.status==="draft_ready");if(draft===undefined)continue;
      let proposal:RepairDraftProposal;try{proposal=repairProposalSchema.parse(cipher.decrypt<{proposal?:unknown}>(draft.encryptedPayload).proposal) as RepairDraftProposal;}catch{continue;}
      if(!isEvidenceBlockedProposal(proposal))continue;const domain=proposal.targetDomain??draft.targetDomain??domainForIssueScope(issue.scope);if(domain===undefined)continue;
      const revision=catalogRevision(catalog,domain);if(revision===undefined||draft.baseGitRevision===revision)continue;
      const updated=await this.dependencies.store.updateRepairDraft(draft.draftId,{status:"generating",targetDomain:domain,baseGitRevision:revision,encryptedPayload:cipher.encrypt({}),errorCode:""});if(updated===undefined)continue;
      const job=await this.dependencies.store.enqueueJob("generate_repair_draft",{draftId:draft.draftId});await this.dependencies.store.updateIssue(issue.issueId,"in_progress");count+=1;
      await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.evidence.recheck_scheduled",resourceType:"repair_draft",resourceId:draft.draftId,metadata:{issueId:issue.issueId,targetDomain:domain,previousRevision:draft.baseGitRevision??null,currentRevision:revision,jobId:job.jobId},createdAt:new Date().toISOString()});
    }
    return count;
  }
  private async reviewAnswer(reviewId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher,reviewer=this.dependencies.answerReviewer;if(cipher===undefined||reviewer===undefined)throw new Error("answer_reviewer_not_configured");
    const stored=await this.dependencies.store.getAnswerReview(reviewId);if(stored===undefined)throw new Error("answer_review_not_found");
    await this.dependencies.store.updateAnswerReviewMachine(reviewId,{processingStatus:"running"});
    let payload:AnswerReviewEncryptedPayload|undefined;let machineCompleted=false;
    try{
      const decrypted=cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);payload=decrypted;const conversation=await this.reviewConversation(stored.requestId),reviewQuestion=conversation?.current.resolvedQuestion??decrypted.question;const catalog=await this.compile();
      const governedCard=resolveReviewCard(catalog,reviewQuestion,decrypted.answerCardMatch);
      const evidence=await loadReviewEvidence({sources:this.dependencies.sources,catalog,references:decrypted.references});
      const result=await reviewer.review({question:reviewQuestion,...(conversation===undefined?{}:{rawQuestion:conversation.current.rawQuestion,conversation:{contextUsed:conversation.current.contextUsed,...(conversation.parent===undefined?{}:{parentQuestion:conversation.parent.resolvedQuestion,...(conversation.parent.answerOutline===undefined?{}:{parentAnswerOutline:conversation.parent.answerOutline})})}}),answer:decrypted.answer,answerStatus:stored.answerStatus,evidence:evidence.documents,evidenceIssues:evidence.issues,...(governedCard===undefined?{}:{governedCard}),...(decrypted.answerCardMatch===undefined?{}:{answerCardMatch:decrypted.answerCardMatch}),...(decrypted.answerCardActivation===undefined?{}:{answerCardActivation:decrypted.answerCardActivation})});
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
    await this.dependencies.store.updateRepairDraft(draftId,{status:"generating",errorCode:""});
    try{
      const issue=await this.dependencies.store.getIssue(draft.issueId);if(issue===undefined)throw new Error("repair_issue_not_found");
      if(issue.status==="dismissed"||issue.status==="resolved")throw new Error("repair_issue_closed");
      const context=await this.loadRepairRecords(issue.issueId,cipher),catalog=await this.compile();
      const catalogCard=findCardByHashedKey(catalog,issue.answerCardKey)??findCardByCurrentQuestion(catalog,context.records),located=catalogCard===undefined?undefined:await locateAnswerCard(this.dependencies.sources,catalog,catalogCard.cardId);
      const domain=located?.card.domain??catalogCard?.domain??domainForIssueScope(issue.scope),source=domain===undefined?undefined:this.dependencies.sources.find((item)=>item.domain===domain),revision=domain===undefined?undefined:catalogRevision(catalog,domain);
      const discoveredPaths=source===undefined||revision===undefined||located!==undefined?[]:await discoverRepairEvidencePaths({source,revision,queries:repairEvidenceQueries(context.records)});
      const paths=located===undefined?discoveredPaths:[located.path,...located.card.obligations.flatMap((item)=>item.preferredEvidencePaths)];
      const evidence=source===undefined||revision===undefined?{documents:[],issues:["repair_domain_or_revision_missing"],revalidatedReferenceCount:0}:await loadRepairEvidence({source,revision,paths,references:context.references});
      const route=resolveRepairRoute({category:issue.category,domain,revision,located,hasEvidence:evidence.documents.length>0});
      const proposal=await agent.generate({issueId:issue.issueId,rootCause:issue.category,records:context.records,evidence:evidence.documents,route,sensitiveTerms:context.sensitiveTerms});
      const currentIssue=await this.dependencies.store.getIssue(issue.issueId);if(currentIssue?.status==="dismissed"||currentIssue?.status==="resolved")throw new Error("repair_issue_closed");
      const updated=await this.dependencies.store.updateRepairDraft(draftId,{status:"draft_ready",targetKind:proposal.targetKind,
        ...(proposal.targetDomain===undefined?{}:{targetDomain:proposal.targetDomain}),...(proposal.targetPath===undefined?{}:{targetPath:proposal.targetPath}),
        ...(route.baseGitRevision===undefined?{}:{baseGitRevision:route.baseGitRevision}),encryptedPayload:cipher.encrypt({proposal,evidenceSummary:{loadedCount:evidence.documents.length,revalidatedReferenceCount:evidence.revalidatedReferenceCount,issues:evidence.issues}}),errorCode:""});
      if(updated===undefined)throw new Error("repair_draft_update_failed");await this.dependencies.store.updateIssue(issue.issueId,proposal.blockingKind==="evidence_required"?"awaiting_evidence":"in_progress");
      const timestamp=new Date().toISOString();await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.generated",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:issue.issueId,targetKind:proposal.targetKind,publishable:proposal.publishable,evidenceCount:evidence.documents.length,evidenceIssueCount:evidence.issues.length,revalidatedReferenceCount:evidence.revalidatedReferenceCount},createdAt:timestamp});
      return{draftId,status:updated.status,targetKind:proposal.targetKind,publishable:proposal.publishable,evidenceCount:evidence.documents.length};
    }catch(error){throw error;}
  }
  private async loadRepairRecords(issueId:string,cipher:ContentCipher):Promise<{readonly records:readonly RepairRecord[];readonly references:readonly AnswerReviewReference[];readonly sensitiveTerms:readonly string[]}>{
    const records:RepairRecord[]=[];const references:AnswerReviewReference[]=[];const sensitiveTerms:string[]=[];const seenReviews=new Set<string>();
    const appendReview=async(reviewId:string)=>{if(seenReviews.has(reviewId))return;seenReviews.add(reviewId);const stored=await this.dependencies.store.getAnswerReview(reviewId);if(stored===undefined)return;const payload=cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload),conversation=await this.reviewConversation(stored.requestId);if(payload.userDisplayName)sensitiveTerms.push(payload.userDisplayName);references.push(...payload.references);records.push({question:conversation?.current.resolvedQuestion??payload.question,...(conversation===undefined?{}:{rawQuestion:conversation.current.rawQuestion,contextUsed:conversation.current.contextUsed,...(conversation.parent===undefined?{}:{parentQuestion:conversation.parent.resolvedQuestion,...(conversation.parent.answerOutline===undefined?{}:{parentAnswerOutline:conversation.parent.answerOutline})})}),answer:payload.answer,...(payload.result===undefined?{}:{reviewSummary:payload.result.summary,defects:payload.result.defects})});};
    for(const occurrence of await this.dependencies.store.listIssueOccurrences(issueId)){
      if(occurrence.sourceType==="answer_review"){await appendReview(occurrence.sourceId);continue;}
      const stored=await this.dependencies.store.getFeedback(occurrence.sourceId);if(stored===undefined)continue;
      const payload=cipher.decrypt<{question:string;answer:string;comment:string;proposedAnswer?:string;userDisplayName?:string}>(stored.encryptedPayload);if(payload.userDisplayName)sensitiveTerms.push(payload.userDisplayName);
      const conversation=await this.reviewConversation(stored.requestId);records.push({question:conversation?.current.resolvedQuestion??payload.question,...(conversation===undefined?{}:{rawQuestion:conversation.current.rawQuestion,contextUsed:conversation.current.contextUsed,...(conversation.parent===undefined?{}:{parentQuestion:conversation.parent.resolvedQuestion,...(conversation.parent.answerOutline===undefined?{}:{parentAnswerOutline:conversation.parent.answerOutline})})}),answer:payload.answer,feedbackClassification:stored.classification,...(payload.comment.trim()===""?{}:{feedback:payload.comment}),...(payload.proposedAnswer===undefined?{}:{proposedAnswer:payload.proposedAnswer})});
      const linked=await this.dependencies.store.getAnswerReviewByRequestId(stored.requestId);if(linked!==undefined)await appendReview(linked.reviewId);
    }
    if(records.length===0)throw new Error("repair_issue_has_no_records");return{records,references:uniqueReferences(references),sensitiveTerms:[...new Set(sensitiveTerms)]};
  }
  private async validateRepairDraft(draftId:string,validationId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher,reviewer=this.dependencies.answerReviewer;if(cipher===undefined||reviewer===undefined)throw new Error("repair_validator_not_configured");
    const validation=await this.dependencies.store.getRepairValidation(validationId);if(validation===undefined||validation.draftId!==draftId)throw new Error("repair_validation_not_found");await this.dependencies.store.updateRepairValidation(validationId,{status:"running",errorCode:""});
    const material=await this.repairMaterial(draftId,cipher),candidateCatalog=await this.compileRepairCandidate(material.source,material.draft.baseGitRevision!,material.proposal.targetPath!,material.rendered,material.baselineCatalog);
      const card=candidateCatalog.cards.find((item)=>item.cardId===material.proposal.cardId);if(card===undefined)throw new Error("repair_candidate_card_missing");
      const regressionCases=await this.dependencies.store.listRegressionCases(),validationFingerprint=hashText(stableJson({policyVersion:PROJECT_DATA_POLICY_VERSION,proposal:material.proposal,evidence:material.evidence,candidateCatalogHash:hashCatalog(candidateCatalog),regressionCases}));
      const previous=(await this.dependencies.store.listRepairValidations(draftId)).find((item)=>item.validationId!==validationId&&(item.status==="passed"||item.status==="failed"));
      if(previous!==undefined){const previousResult=cipher.decrypt<{result?:Record<string,unknown>}>(previous.encryptedPayload).result;if(previousResult?.validationFingerprint===validationFingerprint){const completedAt=new Date().toISOString(),result={...previousResult,reused:true,reusedFromValidationId:previous.validationId};await this.dependencies.store.updateRepairValidation(validationId,{status:previous.status,totalCases:previous.totalCases,passedCases:previous.passedCases,encryptedPayload:cipher.encrypt({result}),completedAt});await this.dependencies.store.updateRepairDraft(draftId,{status:previous.status==="passed"?"ready_to_publish":"validation_failed"});await this.dependencies.store.updateIssue(material.draft.issueId,previous.status==="passed"?"validating":"in_progress");await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.validation.reused",resourceType:"repair_validation",resourceId:validationId,metadata:{draftId,issueId:material.draft.issueId,reusedFromValidationId:previous.validationId,totalCases:previous.totalCases,passedCases:previous.passedCases},createdAt:completedAt});return{validationId,passed:previous.status==="passed",totalCases:previous.totalCases,passedCases:previous.passedCases,reused:true};}}
      const ruleConflicts=inspectAnswerCardRuleConflicts({answerTemplate:card.answerTemplate,obligations:material.proposal.obligations,evidence:material.evidence.documents});
      if(ruleConflicts.length>0){const completedAt=new Date().toISOString(),totalCases=material.proposal.regressionQuestions.length,passedCases=0,result={passed:false,outcome:"rule_conflict",validationFingerprint,ruleConflicts,diagnostics:conflictDiagnostics(ruleConflicts),targeted:[],fullRegression:[],evidenceIssues:material.evidence.issues,candidateCardId:card.cardId};await this.dependencies.store.updateRepairValidation(validationId,{status:"failed",totalCases,passedCases,encryptedPayload:cipher.encrypt({result}),completedAt});await this.dependencies.store.updateRepairDraft(draftId,{status:"validation_failed"});await this.dependencies.store.updateIssue(material.draft.issueId,"in_progress");await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.validation.rule_conflict",resourceType:"repair_validation",resourceId:validationId,metadata:{draftId,issueId:material.draft.issueId,totalCases,passedCases,conflictCount:ruleConflicts.length,obligationIds:[...new Set(ruleConflicts.map((item)=>item.obligationId))]},createdAt:completedAt});return{validationId,passed:false,totalCases,passedCases,outcome:"rule_conflict"};}
      const assessmentByKind=new Map(material.proposal.regressionQuestions.map((item)=>[item.kind,{kind:item.kind,passed:true,explanation:"候选答案卡已通过 Schema 编译；必答项、禁答项和证据支持由确定性检查及独立内容复核继续判定。"}] as const));
      const normalizedMatches=new Set([card.canonicalQuestion,...card.aliases].map(normalize)),reviewByKind=new Map<string,Awaited<ReturnType<IndependentAnswerReviewer["review"]>>>();
      for(const test of material.proposal.regressionQuestions.filter((item)=>item.kind!=="negative")){
        const review=await reviewer.review({question:test.question,answer:card.answerTemplate,answerStatus:"answered",evidence:material.evidence.documents.map((item,index)=>({index:index+1,...item})),evidenceIssues:material.evidence.issues,governedCard:card,answerCardActivation:{activated:true}});reviewByKind.set(test.kind,review);
      }
      const targeted=material.proposal.regressionQuestions.map((test)=>{const exact=normalizedMatches.has(normalize(test.question)),assessment=assessmentByKind.get(test.kind),review=reviewByKind.get(test.kind);const deterministic=test.kind==="follow_up"?true:test.kind==="negative"?!exact:exact;const passed=deterministic&&assessment?.passed===true&&(test.kind==="negative"||review?.verdict==="pass"),diagnostics=validationCaseDiagnostics({kind:test.kind,exact,assessment,review,answer:card.answerTemplate});return{kind:test.kind,question:test.question,passed,exactMatch:exact,assessment:assessment??null,review:review??null,diagnostics};});
      const fullRegression=runCatalogCases(candidateCatalog,regressionCases),passedCases=targeted.filter((item)=>item.passed).length+fullRegression.filter((item)=>item.passed).length,totalCases=targeted.length+fullRegression.length;
      const passed=material.evidence.issues.length===0&&targeted.every((item)=>item.passed)&&fullRegression.every((item)=>item.passed),completedAt=new Date().toISOString(),diagnostics=uniqueValidationDiagnostics(targeted.flatMap((item)=>item.diagnostics)),result={passed,outcome:passed?"passed":"validation_failed",validationFingerprint,targeted,fullRegression,evidenceIssues:material.evidence.issues,candidateCardId:card.cardId,diagnostics};
      await this.dependencies.store.updateRepairValidation(validationId,{status:passed?"passed":"failed",totalCases,passedCases,encryptedPayload:cipher.encrypt({result}),completedAt});await this.dependencies.store.updateRepairDraft(draftId,{status:passed?"ready_to_publish":"validation_failed"});await this.dependencies.store.updateIssue(material.draft.issueId,passed?"validating":"in_progress");
      await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:passed?"repair.validation.passed":"repair.validation.failed",resourceType:"repair_validation",resourceId:validationId,metadata:{draftId,issueId:material.draft.issueId,totalCases,passedCases},createdAt:completedAt});return{validationId,passed,totalCases,passedCases};
  }
  private async repairMaterial(draftId:string,cipher:ContentCipher){
    const storedDraft=await this.dependencies.store.getRepairDraft(draftId);if(storedDraft===undefined)throw new Error("repair_draft_not_found");const proposal=repairProposalSchema.parse(cipher.decrypt<{proposal?:unknown}>(storedDraft.encryptedPayload).proposal) as RepairDraftProposal;
    if(!proposal.publishable||proposal.targetKind!=="answer_card"||proposal.targetDomain===undefined||proposal.targetPath===undefined||proposal.cardId===undefined)throw new Error("repair_draft_not_publishable");
    const source=this.dependencies.sources.find((item)=>item.domain===proposal.targetDomain);if(source===undefined)throw new Error("repair_target_source_missing");const baselineCatalog=await this.compile();
    for(const item of this.dependencies.sources){const revision=catalogRevision(baselineCatalog,item.domain);if(revision===undefined)throw new Error("catalog_domain_revision_missing");await this.dependencies.git.assertCleanRevision(item.root,revision);}
    const currentRevision=catalogRevision(baselineCatalog,proposal.targetDomain);if(currentRevision===undefined)throw new Error("catalog_domain_revision_missing");let draft=storedDraft;
    if(draft.baseGitRevision===undefined){const rebound=await this.dependencies.store.updateRepairDraft(draftId,{baseGitRevision:currentRevision,errorCode:""});if(rebound===undefined)throw new Error("repair_draft_not_found");draft=rebound;await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.draft.baseline.bound",resourceType:"repair_draft",resourceId:draftId,metadata:{issueId:draft.issueId,targetDomain:proposal.targetDomain,baseGitRevision:currentRevision},createdAt:new Date().toISOString()});}
    if(currentRevision!==draft.baseGitRevision)throw new Error("knowledge_revision_changed");const existing=baselineCatalog.cards.find((item)=>item.cardId===proposal.cardId);
    let original:string|undefined;try{original=await readKnowledgeFileAtRevision(source,draft.baseGitRevision,proposal.targetPath);}catch(error){if(existing!==undefined)throw error;}
    if(existing===undefined&&original!==undefined)throw new Error("repair_target_path_already_exists");const rendered=renderRepairMarkdown(proposal,original),paths=proposal.obligations.flatMap((item)=>item.preferredEvidencePaths),evidence=await loadRepairEvidence({source,revision:draft.baseGitRevision,paths,references:[]});
    return{draft,proposal,source,baselineCatalog,rendered,evidence};
  }
  private async compileRepairCandidate(target:KnowledgeSource,baseRevision:string,targetPath:string,content:string,baseline:AnswerCardCatalog):Promise<AnswerCardCatalog>{
    const other=this.dependencies.sources.find((item)=>item.domain!==target.domain);if(other===undefined)throw new Error("repair_other_domain_missing");const otherRevision=catalogRevision(baseline,other.domain);if(otherRevision===undefined)throw new Error("repair_other_revision_missing");
    return this.dependencies.git.withRevision(target.root,baseRevision,[{relativePath:targetPath,content}],async(targetRoot)=>this.dependencies.git.withRevision(other.root,otherRevision,[],async(otherRoot)=>this.compiler.compile(this.dependencies.sources.map((item)=>item.domain===target.domain?{...item,root:targetRoot,revision:baseRevision}:{...item,root:otherRoot,revision:otherRevision}))));
  }
  private async compileRepairBatchCandidate(materials:readonly Awaited<ReturnType<KnowledgeOpsWorker["repairMaterial"]>>[],baseline:AnswerCardCatalog):Promise<AnswerCardCatalog>{
    const roots=new Map<KnowledgeDomain,string>(),revisions=new Map<KnowledgeDomain,string>(),changes=new Map<KnowledgeDomain,GitFileChange[]>();
    for(const source of this.dependencies.sources){const revision=catalogRevision(baseline,source.domain);if(revision===undefined)throw new Error("catalog_domain_revision_missing");revisions.set(source.domain,revision);}
    for(const material of materials){const revision=revisions.get(material.source.domain);if(revision!==material.draft.baseGitRevision)throw new Error("knowledge_revision_changed");const current=changes.get(material.source.domain)??[];if(current.some((item)=>item.relativePath===material.proposal.targetPath))throw new Error("repair_batch_target_conflict");current.push({relativePath:material.proposal.targetPath!,content:material.rendered});changes.set(material.source.domain,current);}
    const visit=async(index:number):Promise<AnswerCardCatalog>=>{if(index>=this.dependencies.sources.length)return this.compiler.compile(this.dependencies.sources.map((source)=>({ ...source,root:roots.get(source.domain)!,revision:revisions.get(source.domain)! })));
      const source=this.dependencies.sources[index]!,revision=revisions.get(source.domain)!;return this.dependencies.git.withRevision(source.root,revision,changes.get(source.domain)??[],async(root)=>{roots.set(source.domain,root);return visit(index+1);});};
    return visit(0);
  }
  private async publishRepairBatch(batchId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher;
    const runtime=this.dependencies.runtimeController;
    const qualityRunner=this.dependencies.releaseQualityRunner;
    if(cipher===undefined)throw new Error("repair_cipher_not_configured");
    if(runtime===undefined)throw new Error("knowledge_runtime_controller_not_configured");
    if(qualityRunner===undefined)throw new Error("release_quality_runner_not_configured");
    const batch=await this.dependencies.store.getRepairBatch(batchId);
    if(batch===undefined)throw new Error("repair_batch_not_found");
    if(batch.status!=="queued"&&batch.status!=="publishing")throw new Error("repair_batch_not_pending");
    if(batch.publications.length!==batch.itemCount||batch.publications.length===0)throw new Error("repair_batch_item_count_invalid");
    await this.dependencies.store.updateRepairBatch(batchId,{status:"publishing",deploymentStage:"running_global_regression",servingPreviousVersion:true});
    for(const publication of batch.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"publishing"});
    const applied:{source:KnowledgeSource;revision:string;publications:readonly RepairPublication[];pushed:boolean}[]=[];
    let previousReleaseId:string|undefined;
    try{
      const materials:Awaited<ReturnType<KnowledgeOpsWorker["repairMaterial"]>>[]=[];
      let baseline:AnswerCardCatalog|undefined;
      for(const publication of batch.publications){
        const material=await this.repairMaterial(publication.draftId,cipher);
        if(publication.targetDomain!==material.proposal.targetDomain||publication.targetPath!==material.proposal.targetPath||publication.baseGitRevision!==material.draft.baseGitRevision)throw new Error("repair_batch_publication_mismatch");
        if(baseline!==undefined&&hashCatalog(baseline)!==hashCatalog(material.baselineCatalog))throw new Error("knowledge_revision_changed");
        baseline=material.baselineCatalog;
        const latest=(await this.dependencies.store.listRepairValidations(publication.draftId))[0];
        if(latest?.status!=="passed")throw new Error("passing_repair_validation_required");
        materials.push(material);
      }
      if(baseline===undefined)throw new Error("repair_batch_empty");
      await runtime.assertAligned(baseline);
      const candidate=await this.compileRepairBatchCandidate(materials,baseline);
      for(const material of materials)if(!candidate.cards.some((card)=>card.cardId===material.proposal.cardId))throw new Error("repair_candidate_card_missing");
      const candidateRegression=runCatalogCases(candidate,await this.dependencies.store.listRegressionCases());
      if(candidateRegression.some((item)=>!item.passed))throw new Error("repair_batch_combined_regression_failed");
      const qualityRun=await this.recordQualityRun(await qualityRunner.run(candidate));
      await this.dependencies.store.updateRepairBatch(batchId,{qualityRunId:qualityRun.runId});
      if(qualityRun.status!=="passed")throw new Error("release_quality_gate_failed");

      previousReleaseId=await this.ensureBaselineRelease(baseline,batch.createdBy,batchId);
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"writing_git"});
      for(const domain of batch.domains){
        const source=this.dependencies.sources.find((item)=>item.domain===domain);
        if(source===undefined)throw new Error("repair_target_source_missing");
        const publications=batch.publications.filter((item)=>item.targetDomain===domain);
        const domainMaterials=materials.filter((item)=>item.source.domain===domain);
        const baseRevision=catalogRevision(baseline,domain);
        if(baseRevision===undefined||publications.some((item)=>item.baseGitRevision!==baseRevision))throw new Error("knowledge_revision_changed");
        const write=await this.dependencies.git.publishRevision(source.root,baseRevision,domainMaterials.map((item)=>({relativePath:item.proposal.targetPath!,content:item.rendered})),`知识修订批次：${publications.length} 项`);
        applied.push({source,revision:write.revision,publications,pushed:false});
        for(const publication of publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{resultingGitRevision:write.revision,remoteSyncStatus:"pushing"});
      }
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"pushing_github"});
      for(const item of applied){
        const pushed=await this.dependencies.git.pushCurrent(item.source.root,item.revision);
        item.pushed=true;
        for(const publication of item.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:"synced",remoteName:pushed.remoteName,remoteBranch:pushed.remoteBranch});
      }
      const catalog=await this.compile();
      for(const item of applied)if(catalogRevision(catalog,item.source.domain)!==item.revision)throw new Error("repair_published_revision_not_loaded");
      for(const material of materials)if(!catalog.cards.some((card)=>card.cardId===material.proposal.cardId))throw new Error("repair_published_card_missing");
      const fullRegression=runCatalogCases(catalog,await this.dependencies.store.listRegressionCases());
      if(fullRegression.some((item)=>!item.passed))throw new Error("full_regression_failed_after_publish");

      const release=await this.prepareCatalogRelease(catalog,batch.createdBy,batchId,"RB",qualityRun.runId);
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"reloading_engine",targetProfessionalRevision:release.professionalRevision,targetGeneralRevision:release.generalRevision,snapshotReleaseId:release.releaseId,previousReleaseId});
      await runtime.reload(release.releaseId,catalog);
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"activating_snapshot"});
      await this.activateCatalogRelease(release,catalog);
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"verifying_online",servingPreviousVersion:false});
      await runtime.assertAligned(catalog);
      const active=await this.dependencies.snapshots.active();
      if(active?.releaseId!==release.releaseId)throw new Error("knowledge_snapshot_activation_mismatch");
      await this.syncCatalog(catalog);

      const publishedAt=new Date().toISOString();
      await this.dependencies.store.updateRepairBatch(batchId,{status:"published",deploymentStage:"active",servingPreviousVersion:false,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,publishedAt});
      for(const publication of batch.publications){
        await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"published",catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,publishedAt});
        await this.dependencies.store.updateRepairDraft(publication.draftId,{status:"published"});
        await this.dependencies.store.updateIssue(publication.issueId,"resolved");
        await this.setIssueSources(publication.issueId,true);
      }
      await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.published",resourceType:"repair_batch",resourceId:batchId,metadata:{publicationIds:batch.publications.map((item)=>item.publicationId),domains:batch.domains,resultingGitRevisions:applied.map((item)=>({domain:item.source.domain,revision:item.revision})),catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,qualityRunId:qualityRun.runId},createdAt:publishedAt});
      return{batchId,status:"published",deploymentStage:"active",itemCount:batch.itemCount,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,qualityRunId:qualityRun.runId};
    }catch(error){
      await this.dependencies.store.updateRepairBatch(batchId,{deploymentStage:"compensating",servingPreviousVersion:true});
      let compensationFailed=false;
      const compensatedRevisions=new Map<KnowledgeDomain,string>();
      for(const item of [...applied].reverse()){
        try{
          const reverted=await this.dependencies.git.revertPublishedRevision(item.source.root,item.revision,item.revision,`回退失败的知识修订批次：${batchId}`);
          compensatedRevisions.set(item.source.domain,reverted.revision);
          if(item.pushed)await this.dependencies.git.pushCurrent(item.source.root,reverted.revision);
          for(const publication of item.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:item.pushed?"compensated":"failed"});
        }catch{compensationFailed=true;}
      }
      if(applied.length>0){try{await this.activateRecoveryCatalog(batch.createdBy,batchId,"COMP");}catch{compensationFailed=true;}}
      const code=safeCode(error),batchCode=compensationFailed?`repair_batch_compensation_failed:${code}`:code;
      for(const publication of batch.publications){
        await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"failed",errorCode:batchCode,...(applied.some((item)=>item.publications.some((entry)=>entry.publicationId===publication.publicationId))?{}:{remoteSyncStatus:"failed"})});
        await this.dependencies.store.updateRepairDraft(publication.draftId,{status:compensationFailed?"failed":"validation_failed",errorCode:batchCode,...(compensatedRevisions.get(publication.targetDomain)?{baseGitRevision:compensatedRevisions.get(publication.targetDomain)!}:{})});
        await this.dependencies.store.updateIssue(publication.issueId,"in_progress");
      }
      await this.dependencies.store.updateRepairBatch(batchId,{status:"failed",deploymentStage:"failed",servingPreviousVersion:true,errorCode:batchCode});
      await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.failed",resourceType:"repair_batch",resourceId:batchId,metadata:{publicationIds:batch.publications.map((item)=>item.publicationId),domains:batch.domains,errorCode:batchCode,appliedDomains:applied.map((item)=>item.source.domain),pushedDomains:applied.filter((item)=>item.pushed).map((item)=>item.source.domain),compensationFailed},createdAt:new Date().toISOString()});
      throw error;
    }
  }
  private async publishRepairBatchLegacy(batchId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher;if(cipher===undefined)throw new Error("repair_cipher_not_configured");const batch=await this.dependencies.store.getRepairBatch(batchId);if(batch===undefined)throw new Error("repair_batch_not_found");if(batch.status!=="queued"&&batch.status!=="publishing")throw new Error("repair_batch_not_pending");if(batch.publications.length!==batch.itemCount||batch.publications.length===0)throw new Error("repair_batch_item_count_invalid");
    await this.dependencies.store.updateRepairBatch(batchId,{status:"publishing"});for(const publication of batch.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"publishing"});
    const applied:{source:KnowledgeSource;revision:string;publications:readonly RepairPublication[];pushed:boolean}[]=[],latestValidations=new Map<string,Awaited<ReturnType<KnowledgeOpsStore["getRepairValidation"]>>>();let previousReleaseId:string|undefined;
    try{
      const materials=[] as Awaited<ReturnType<KnowledgeOpsWorker["repairMaterial"]>>[];let baseline:AnswerCardCatalog|undefined;
      for(const publication of batch.publications){const material=await this.repairMaterial(publication.draftId,cipher);if(publication.targetDomain!==material.proposal.targetDomain||publication.targetPath!==material.proposal.targetPath||publication.baseGitRevision!==material.draft.baseGitRevision)throw new Error("repair_batch_publication_mismatch");if(baseline!==undefined&&hashCatalog(baseline)!==hashCatalog(material.baselineCatalog))throw new Error("knowledge_revision_changed");baseline=material.baselineCatalog;const latest=(await this.dependencies.store.listRepairValidations(publication.draftId))[0];if(latest?.status!=="passed")throw new Error("passing_repair_validation_required");latestValidations.set(publication.draftId,latest);materials.push(material);}
      if(baseline===undefined)throw new Error("repair_batch_empty");const candidate=await this.compileRepairBatchCandidate(materials,baseline);for(const material of materials)if(!candidate.cards.some((card)=>card.cardId===material.proposal.cardId))throw new Error("repair_candidate_card_missing");const candidateRegression=runCatalogCases(candidate,await this.dependencies.store.listRegressionCases());if(candidateRegression.some((item)=>!item.passed))throw new Error("repair_batch_combined_regression_failed");
      previousReleaseId=await this.ensureBaselineRelease(baseline,batch.createdBy,batchId);
      for(const domain of batch.domains){const source=this.dependencies.sources.find((item)=>item.domain===domain);if(source===undefined)throw new Error("repair_target_source_missing");const publications=batch.publications.filter((item)=>item.targetDomain===domain),domainMaterials=materials.filter((item)=>item.source.domain===domain),baseRevision=catalogRevision(baseline,domain);if(baseRevision===undefined||publications.some((item)=>item.baseGitRevision!==baseRevision))throw new Error("knowledge_revision_changed");const write=await this.dependencies.git.publishRevision(source.root,baseRevision,domainMaterials.map((item)=>({relativePath:item.proposal.targetPath!,content:item.rendered})),`知识修订批次：${publications.length} 项`);applied.push({source,revision:write.revision,publications,pushed:false});for(const publication of publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{resultingGitRevision:write.revision,remoteSyncStatus:"pushing"});}
      for(const item of applied){const pushed=await this.dependencies.git.pushCurrent(item.source.root,item.revision);item.pushed=true;for(const publication of item.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:"synced",remoteName:pushed.remoteName,remoteBranch:pushed.remoteBranch});}
      const catalog=await this.compile();for(const item of applied)if(catalogRevision(catalog,item.source.domain)!==item.revision)throw new Error("repair_published_revision_not_loaded");for(const material of materials)if(!catalog.cards.some((card)=>card.cardId===material.proposal.cardId))throw new Error("repair_published_card_missing");const fullRegression=runCatalogCases(catalog,await this.dependencies.store.listRegressionCases());if(fullRegression.some((item)=>!item.passed))throw new Error("full_regression_failed_after_publish");
      const validationRuns=[...latestValidations.values()].filter((item)=>item!==undefined),totalCases=validationRuns.reduce((sum,item)=>sum+item.totalCases,0)+fullRegression.length,passedCases=validationRuns.reduce((sum,item)=>sum+item.passedCases,0)+fullRegression.filter((item)=>item.passed).length,release=await this.createCatalogRelease(catalog,batch.createdBy,batchId,"RB",{repairValidationIds:validationRuns.map((item)=>item.validationId),combinedRegression:fullRegression},totalCases,passedCases);await this.syncCatalog(catalog);
      const publishedAt=new Date().toISOString();await this.dependencies.store.updateRepairBatch(batchId,{status:"published",catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,publishedAt});for(const publication of batch.publications){await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"published",catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,publishedAt});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:"published"});await this.dependencies.store.updateIssue(publication.issueId,"resolved");await this.setIssueSources(publication.issueId,true);}await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.published",resourceType:"repair_batch",resourceId:batchId,metadata:{publicationIds:batch.publications.map((item)=>item.publicationId),domains:batch.domains,resultingGitRevisions:applied.map((item)=>({domain:item.source.domain,revision:item.revision})),catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId},createdAt:publishedAt});return{batchId,status:"published",itemCount:batch.itemCount,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId};
    }catch(error){let compensationFailed=false;const compensatedRevisions=new Map<KnowledgeDomain,string>();for(const item of [...applied].reverse()){try{const reverted=await this.dependencies.git.revertPublishedRevision(item.source.root,item.revision,item.revision,`回退失败的知识修订批次：${batchId}`);compensatedRevisions.set(item.source.domain,reverted.revision);if(item.pushed)await this.dependencies.git.pushCurrent(item.source.root,reverted.revision);for(const publication of item.publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:item.pushed?"compensated":"failed"});}catch{compensationFailed=true;}}
      if(previousReleaseId!==undefined){try{const active=await this.dependencies.snapshots.active();if(active?.releaseId!==previousReleaseId){await this.dependencies.snapshots.rollback(previousReleaseId);await this.dependencies.store.rollbackRelease(previousReleaseId);}}catch{compensationFailed=true;}}
      const code=safeCode(error),batchCode=compensationFailed?`repair_batch_compensation_failed:${code}`:code;for(const publication of batch.publications){await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"failed",errorCode:batchCode,...(applied.some((item)=>item.publications.some((entry)=>entry.publicationId===publication.publicationId))?{}:{remoteSyncStatus:"failed"})});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:compensationFailed?"failed":"validation_failed",errorCode:batchCode,...(compensatedRevisions.get(publication.targetDomain)?{baseGitRevision:compensatedRevisions.get(publication.targetDomain)!}:{})});await this.dependencies.store.updateIssue(publication.issueId,"in_progress");}await this.dependencies.store.updateRepairBatch(batchId,{status:"failed",errorCode:batchCode});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.failed",resourceType:"repair_batch",resourceId:batchId,metadata:{publicationIds:batch.publications.map((item)=>item.publicationId),domains:batch.domains,errorCode:batchCode,appliedDomains:applied.map((item)=>item.source.domain),pushedDomains:applied.filter((item)=>item.pushed).map((item)=>item.source.domain),compensationFailed},createdAt:new Date().toISOString()});throw error;}
  }
  private async publishRepair(publicationId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher;if(cipher===undefined)throw new Error("repair_cipher_not_configured");const publication=await this.dependencies.store.getRepairPublication(publicationId);if(publication===undefined)throw new Error("repair_publication_not_found");if(publication.status!=="pending"&&publication.status!=="publishing")throw new Error("repair_publication_not_pending");await this.dependencies.store.updateRepairPublication(publicationId,{status:"publishing"});
    let appliedRevision:string|undefined,previousReleaseId:string|undefined,source:KnowledgeSource|undefined;
    try{
      const material=await this.repairMaterial(publication.draftId,cipher);source=material.source;const latest=(await this.dependencies.store.listRepairValidations(publication.draftId))[0];if(latest?.status!=="passed")throw new Error("passing_repair_validation_required");previousReleaseId=await this.ensureBaselineRelease(material.baselineCatalog,publication.createdBy,publicationId);
      const write=await this.dependencies.git.publishRevision(material.source.root,publication.baseGitRevision,[{relativePath:publication.targetPath,content:material.rendered}],`知识修订：${material.proposal.title}`);appliedRevision=write.revision;
      const catalog=await this.compile(),targetRevision=catalogRevision(catalog,publication.targetDomain);if(targetRevision!==appliedRevision)throw new Error("repair_published_revision_not_loaded");const card=catalog.cards.find((item)=>item.cardId===material.proposal.cardId);if(card===undefined)throw new Error("repair_published_card_missing");
      const fullRegression=runCatalogCases(catalog,await this.dependencies.store.listRegressionCases());if(fullRegression.some((item)=>!item.passed))throw new Error("full_regression_failed_after_publish");const validationResult=cipher.decrypt<{result?:Record<string,unknown>}>(latest.encryptedPayload).result??{};
      const release=await this.createCatalogRelease(catalog,publication.createdBy,publicationId,"RP",{repairValidationId:latest.validationId,validationResult,fullRegression},latest.totalCases+fullRegression.length,latest.passedCases+fullRegression.filter((item)=>item.passed).length);
      const publishedAt=new Date().toISOString();await this.dependencies.store.updateRepairPublication(publicationId,{status:"published",resultingGitRevision:appliedRevision,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId,publishedAt});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:"published"});await this.dependencies.store.updateIssue(publication.issueId,"resolved");await this.setIssueSources(publication.issueId,true);await this.syncCatalog(catalog);
      await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.publication.published",resourceType:"repair_publication",resourceId:publicationId,metadata:{draftId:publication.draftId,issueId:publication.issueId,targetDomain:publication.targetDomain,targetPath:publication.targetPath,resultingGitRevision:appliedRevision,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId,previousReleaseId},createdAt:publishedAt});return{publicationId,status:"published",resultingGitRevision:appliedRevision,catalogHash:release.cardCatalogHash,snapshotReleaseId:release.releaseId};
    }catch(error){const code=safeCode(error);if(appliedRevision!==undefined&&source!==undefined){try{await this.dependencies.git.revertPublishedRevision(source.root,appliedRevision,appliedRevision,`回退失败的知识修订：${publicationId}`);if(previousReleaseId!==undefined){await this.dependencies.snapshots.rollback(previousReleaseId);await this.dependencies.store.rollbackRelease(previousReleaseId);}}catch{}}
      const retryable=appliedRevision===undefined;await this.dependencies.store.updateRepairPublication(publicationId,{status:"failed",errorCode:code});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:retryable?"ready_to_publish":"failed",errorCode:code});await this.dependencies.store.updateIssue(publication.issueId,retryable?"validating":"in_progress");await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.publication.failed",resourceType:"repair_publication",resourceId:publicationId,metadata:{draftId:publication.draftId,issueId:publication.issueId,errorCode:code,gitApplied:appliedRevision!==undefined,retryable},createdAt:new Date().toISOString()});throw error;}
  }
  private async rollbackRepair(publicationId:string):Promise<Record<string,unknown>>{
    const cipher=this.dependencies.cipher;if(cipher===undefined)throw new Error("repair_cipher_not_configured");const publication=await this.dependencies.store.getRepairPublication(publicationId);if(publication===undefined||publication.status!=="published"||publication.resultingGitRevision===undefined||publication.snapshotReleaseId===undefined||publication.previousReleaseId===undefined)throw new Error("repair_publication_not_rollbackable");
    const active=await this.dependencies.snapshots.active();if(active?.releaseId!==publication.snapshotReleaseId)throw new Error("repair_publication_not_current");const draft=await this.dependencies.store.getRepairDraft(publication.draftId);if(draft===undefined)throw new Error("repair_draft_not_found");const proposal=repairProposalSchema.parse(cipher.decrypt<{proposal?:unknown}>(draft.encryptedPayload).proposal) as RepairDraftProposal;if(proposal.targetDomain===undefined)throw new Error("repair_target_domain_missing");const source=this.dependencies.sources.find((item)=>item.domain===proposal.targetDomain);if(source===undefined)throw new Error("repair_target_source_missing");
    const reverted=await this.dependencies.git.revertPublishedRevision(source.root,publication.resultingGitRevision,publication.resultingGitRevision,`回滚知识修订：${proposal.title}`);await this.dependencies.snapshots.rollback(publication.previousReleaseId);await this.dependencies.store.rollbackRelease(publication.previousReleaseId);const rolledBackAt=new Date().toISOString();await this.dependencies.store.updateRepairPublication(publicationId,{status:"rolled_back",rolledBackAt});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:"failed",errorCode:"rolled_back"});await this.dependencies.store.updateIssue(publication.issueId,"open");await this.setIssueSources(publication.issueId,false);await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.publication.rolled_back",resourceType:"repair_publication",resourceId:publicationId,metadata:{draftId:publication.draftId,issueId:publication.issueId,revertRevision:reverted.revision,activeReleaseId:publication.previousReleaseId},createdAt:rolledBackAt});return{publicationId,status:"rolled_back",revertRevision:reverted.revision,activeReleaseId:publication.previousReleaseId};
  }
  private async rollbackRepairBatch(batchId:string):Promise<Record<string,unknown>>{
    const batch=await this.dependencies.store.getRepairBatch(batchId);if(batch===undefined||batch.status!=="published"||batch.snapshotReleaseId===undefined||batch.previousReleaseId===undefined)throw new Error("repair_batch_not_rollbackable");const active=await this.dependencies.snapshots.active();if(active?.releaseId!==batch.snapshotReleaseId)throw new Error("repair_publication_not_current");const revertedByDomain:{domain:KnowledgeDomain;revision:string}[]=[];await this.dependencies.store.updateRepairBatch(batchId,{status:"publishing",deploymentStage:"compensating",servingPreviousVersion:true});
    try{for(const domain of batch.domains){const publications=batch.publications.filter((item)=>item.targetDomain===domain),publishedRevision=publications[0]?.resultingGitRevision;if(publishedRevision===undefined||publications.some((item)=>item.resultingGitRevision!==publishedRevision))throw new Error("repair_batch_revision_mismatch");const source=this.dependencies.sources.find((item)=>item.domain===domain);if(source===undefined)throw new Error("repair_target_source_missing");for(const publication of publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:"pushing"});const reverted=await this.dependencies.git.revertPublishedRevision(source.root,publishedRevision,publishedRevision,`回滚知识修订批次：${batchId}`),pushed=await this.dependencies.git.pushCurrent(source.root,reverted.revision);revertedByDomain.push({domain,revision:reverted.revision});for(const publication of publications)await this.dependencies.store.updateRepairPublication(publication.publicationId,{remoteSyncStatus:"compensated",remoteName:pushed.remoteName,remoteBranch:pushed.remoteBranch});}
      const release=await this.activateRecoveryCatalog(batch.createdBy,batchId,"ROLLBACK"),rolledBackAt=new Date().toISOString();await this.dependencies.store.updateRepairBatch(batchId,{status:"rolled_back",deploymentStage:"rolled_back",servingPreviousVersion:false,snapshotReleaseId:release.releaseId,rolledBackAt});for(const publication of batch.publications){await this.dependencies.store.updateRepairPublication(publication.publicationId,{status:"rolled_back",snapshotReleaseId:release.releaseId,rolledBackAt});await this.dependencies.store.updateRepairDraft(publication.draftId,{status:"failed",errorCode:"rolled_back",...(revertedByDomain.find((item)=>item.domain===publication.targetDomain)?{baseGitRevision:revertedByDomain.find((item)=>item.domain===publication.targetDomain)!.revision}:{})});await this.dependencies.store.updateIssue(publication.issueId,"open");await this.setIssueSources(publication.issueId,false);}await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.rolled_back",resourceType:"repair_batch",resourceId:batchId,metadata:{publicationIds:batch.publications.map((item)=>item.publicationId),revertedByDomain,activeReleaseId:release.releaseId,restoredFromReleaseId:batch.previousReleaseId},createdAt:rolledBackAt});return{batchId,status:"rolled_back",activeReleaseId:release.releaseId,revertedByDomain};
    }catch(error){const code=safeCode(error);await this.dependencies.store.updateRepairBatch(batchId,{status:"failed",deploymentStage:"failed",servingPreviousVersion:true,errorCode:code});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"repair.batch.rollback.failed",resourceType:"repair_batch",resourceId:batchId,metadata:{errorCode:code,revertedByDomain},createdAt:new Date().toISOString()});throw error;}
  }
  private async recordQualityRun(report:ReleaseQualityGateReport,runId:string=randomUUID()):Promise<RegressionRun>{
    const timestamp=new Date().toISOString(),run:RegressionRun={runId,status:report.passed?"passed":"failed",totalCases:report.summary.total,passedCases:report.summary.passedCases,report:structuredClone(report) as Record<string,unknown>,createdAt:timestamp,completedAt:timestamp};
    const existing=await this.dependencies.store.getRegressionRun(runId);
    return existing===undefined?this.dependencies.store.createRegressionRun(run):this.dependencies.store.updateRegressionRun(run);
  }
  private async prepareCatalogRelease(catalog:AnswerCardCatalog,actorId:string,seed:string,kind:string,regressionRunId:string):Promise<ReleaseRecord>{
    const answerContractRevision=this.dependencies.answerContractRevision;if(answerContractRevision===undefined||!/^[a-f0-9]{40}$/u.test(answerContractRevision))throw new Error("answer_contract_revision_required");
    const run=await this.dependencies.store.getRegressionRun(regressionRunId);if(run?.status!=="passed")throw new Error("passing_release_quality_gate_required");
    const timestamp=new Date().toISOString(),revisions=new Map(catalog.domains.map((item)=>[item.domain,item.revision] as const)),professionalRevision=revisions.get("coremail-professional"),generalRevision=revisions.get("presales-general");if(professionalRevision===undefined||generalRevision===undefined)throw new Error("catalog_domain_revision_missing");
    const cardCatalogHash=hashCatalog(catalog),releaseId=repairReleaseId(timestamp,kind,seed),manifest:ReleaseManifest={schemaVersion:1,releaseId,professionalRevision,generalRevision,answerContractRevision,cardCatalogHash,regressionRunId,approvedBy:[actorId],createdAt:timestamp},release:ReleaseRecord={...manifest,manifest,status:"pending",createdBy:actorId};
    await this.dependencies.store.createRelease(release);return release;
  }
  private async activateCatalogRelease(release:ReleaseRecord,catalog:AnswerCardCatalog):Promise<void>{
    await this.dependencies.snapshots.publish(release.manifest,catalog);await this.dependencies.store.activateRelease(release.releaseId);
  }
  private async activateRecoveryCatalog(actorId:string,seed:string,kind:string):Promise<ReleaseRecord>{
    const runtime=this.dependencies.runtimeController;if(runtime===undefined)throw new Error("knowledge_runtime_controller_not_configured");const catalog=await this.compile(),timestamp=new Date().toISOString(),run:RegressionRun={runId:randomUUID(),status:"passed",totalCases:0,passedCases:0,report:{kind:"known_good_content_recovery",sourceSeed:seed},createdAt:timestamp,completedAt:timestamp};await this.dependencies.store.createRegressionRun(run);const release=await this.prepareCatalogRelease(catalog,actorId,`${seed}-${timestamp}`,kind,run.runId);await runtime.reload(release.releaseId,catalog);await this.activateCatalogRelease(release,catalog);await runtime.assertAligned(catalog);return release;
  }
  private async reconcileRuntime():Promise<Record<string,unknown>>{
    const runtime=this.dependencies.runtimeController;if(runtime===undefined)throw new Error("knowledge_runtime_controller_not_configured");const catalog=await this.compile();
    try{const health=await runtime.assertAligned(catalog);return{status:"already_aligned",projects:health.projects};}catch{/* Reload the immutable active release below while the previous engine stays online. */}
    let active=await this.dependencies.snapshots.active();
    if(active===undefined){const releaseId=await this.ensureBaselineRelease(catalog,this.workerId,"worker-startup");active=await this.dependencies.snapshots.active();if(active?.releaseId!==releaseId)throw new Error("knowledge_snapshot_activation_mismatch");}
    if(active.professionalRevision!==catalogRevision(catalog,"coremail-professional")||active.generalRevision!==catalogRevision(catalog,"presales-general"))throw new Error("active_snapshot_repository_revision_mismatch");
    const health=await runtime.reload(active.releaseId,catalog);return{status:"reloaded",releaseId:active.releaseId,projects:health.projects};
  }
  private async ensureBaselineRelease(catalog:AnswerCardCatalog,actorId:string,seed:string):Promise<string>{
    const active=await this.dependencies.snapshots.active();if(active!==undefined){const known=(await this.dependencies.store.listReleases()).find((item)=>item.releaseId===active.releaseId);if(known===undefined){if(await this.dependencies.store.getRegressionRun(active.regressionRunId)===undefined)await this.dependencies.store.createRegressionRun({runId:active.regressionRunId,status:"passed",totalCases:0,passedCases:0,report:{kind:"imported_active_snapshot"},createdAt:active.createdAt,completedAt:active.createdAt});await this.dependencies.store.createRelease({...active,manifest:active,status:"pending",createdBy:actorId});await this.dependencies.store.activateRelease(active.releaseId);}return active.releaseId;}
    const release=await this.createCatalogRelease(catalog,actorId,seed,"BASE",{kind:"baseline_snapshot"},0,0);return release.releaseId;
  }
  private async createCatalogRelease(catalog:AnswerCardCatalog,actorId:string,seed:string,kind:string,report:Record<string,unknown>,totalCases:number,passedCases:number):Promise<ReleaseRecord>{
    const answerContractRevision=this.dependencies.answerContractRevision;if(answerContractRevision===undefined||!/^[a-f0-9]{40}$/u.test(answerContractRevision))throw new Error("answer_contract_revision_required");const timestamp=new Date().toISOString(),runId=randomUUID(),run:RegressionRun={runId,status:passedCases===totalCases?"passed":"failed",totalCases,passedCases,report,createdAt:timestamp,completedAt:timestamp};if(run.status!=="passed")throw new Error("repair_release_regression_failed");await this.dependencies.store.createRegressionRun(run);
    const revisions=new Map(catalog.domains.map((item)=>[item.domain,item.revision] as const)),professionalRevision=revisions.get("coremail-professional"),generalRevision=revisions.get("presales-general");if(professionalRevision===undefined||generalRevision===undefined)throw new Error("catalog_domain_revision_missing");const cardCatalogHash=hashCatalog(catalog),releaseId=repairReleaseId(timestamp,kind,seed);
    const manifest:ReleaseManifest={schemaVersion:1,releaseId,professionalRevision,generalRevision,answerContractRevision,cardCatalogHash,regressionRunId:runId,approvedBy:[actorId],createdAt:timestamp};const release:ReleaseRecord={...manifest,manifest,status:"pending",createdBy:actorId};await this.dependencies.store.createRelease(release);await this.dependencies.snapshots.publish(manifest,catalog);await this.dependencies.store.activateRelease(releaseId);return{...release,status:"active",activatedAt:timestamp};
  }
  private async setIssueSources(issueId:string,resolved:boolean):Promise<void>{for(const occurrence of await this.dependencies.store.listIssueOccurrences(issueId)){if(occurrence.sourceType==="feedback")await this.dependencies.store.updateFeedback(occurrence.sourceId,{status:resolved?"resolved":"in_review"});else await this.dependencies.store.updateAnswerReviewWorkflow(occurrence.sourceId,resolved?"resolved":"open");}}
  private async recordReviewIssue(stored:StoredAnswerReviewCase,payload:AnswerReviewEncryptedPayload|undefined,priority:IssuePriority,category:IssueCategory){const resolved=(await this.dependencies.store.getConversationTurnByRequestId(stored.requestId))?.resolvedQuestion,questionKey=hashText(normalize(resolved??payload?.question??stored.reviewId));const answerCardKey=cardKey(payload?.answerCardMatch);const groupKey=answerCardKey??questionKey;const occurredAt=new Date().toISOString();const issue=await this.dependencies.store.recordIssue({fingerprint:hashText(`${stored.scope??"unknown"}\0${groupKey}\0${category}`),title:`review:${category}:${groupKey.slice(0,12)}`,priority,category,...(stored.scope?{scope:stored.scope}:{}),...(answerCardKey?{answerCardKey}:{}),occurredAt,occurrence:{sourceType:"answer_review",sourceId:stored.reviewId,requestId:stored.requestId,pseudonymousUserId:stored.pseudonymousUserId}});await this.dependencies.store.appendAudit({auditId:randomUUID(),actorId:this.workerId,action:"issue.review.upsert",resourceType:"issue_case",resourceId:issue.issueId,metadata:{priority:issue.priority,category:issue.category},createdAt:occurredAt});}
  private async reviewConversation(requestId:string){const current=await this.dependencies.store.getConversationTurnByRequestId(requestId);if(current===undefined)return undefined;const parent=current.parentRequestId===undefined?undefined:await this.dependencies.store.getConversationTurnByRequestId(current.parentRequestId);return{current,parent};}
  private async regression(job:OpsJob){
    const runner=this.dependencies.releaseQualityRunner;if(runner===undefined)throw new Error("release_quality_runner_not_configured");const runId=typeof job.payload.runId==="string"?job.payload.runId:randomUUID();let progress=initialReleaseQualityProgress();await this.dependencies.store.updateJobProgress(job.jobId,{runId,...progress});
    const report=await runner.run(await this.compile(),async(event)=>{progress=applyReleaseQualityEvent(progress,event);await this.dependencies.store.updateJobProgress(job.jobId,{runId,...progress});});
    progress=finalizeReleaseQualityProgress(progress,report);await this.dependencies.store.updateJobProgress(job.jobId,{runId,...progress});const run=await this.recordQualityRun(report,runId);return{runId,status:run.status,...progress};
  }
  private async publish(releaseId:string){const release=(await this.dependencies.store.listReleases()).find(x=>x.releaseId===releaseId);if(!release)throw new Error("release_not_found");const catalog=await this.compile();
    if(catalog.domains.find(x=>x.domain==="coremail-professional")?.revision!==release.professionalRevision||catalog.domains.find(x=>x.domain==="presales-general")?.revision!==release.generalRevision)throw new Error("knowledge_revision_changed");
    const runtime=this.dependencies.runtimeController;if(runtime===undefined)throw new Error("knowledge_runtime_controller_not_configured");await runtime.reload(releaseId,catalog);const result=await this.dependencies.snapshots.publish(release.manifest,catalog);await this.dependencies.store.activateRelease(releaseId);await runtime.assertAligned(catalog);return{releaseId,...result};}
  private async writeback(payload:Record<string,unknown>){const repositoryRoot=requireString(payload,"repositoryRoot"),baseRevision=requireString(payload,"baseRevision"),message=requireString(payload,"message");if(!Array.isArray(payload.changes))throw new Error("changes_required");const changes=payload.changes as GitFileChange[];return this.dependencies.git.writeRevision(repositoryRoot,baseRevision,changes,message);}
}
function validationCaseDiagnostics(input:{
  readonly kind:string;
  readonly exact:boolean;
  readonly assessment:{readonly passed:boolean;readonly explanation:string}|undefined;
  readonly review:AnswerReviewResult|undefined;
  readonly answer:string;
}):RepairValidationDiagnostic[]{
  if(input.kind!=="follow_up"&&input.kind!=="negative"&&!input.exact)return[{stage:"card_match",triggerText:"",rule:"标准问法和独立同义问法必须命中候选答案卡",message:"该问法没有命中候选答案卡。",suggestedAction:"modify_rule",evidencePaths:[]}];
  if(input.kind==="negative"&&input.exact)return[{stage:"card_match",triggerText:"",rule:"边界负例不得命中候选答案卡",message:"无关问题错误命中了候选答案卡。",suggestedAction:"modify_rule",evidencePaths:[]}];
  if(input.assessment?.passed!==true){const obligationId=obligationIdFrom(input.assessment?.explanation);return[{stage:"obligation_coverage",...(obligationId===undefined?{}:{obligationId}),field:"answerTemplate",triggerText:answerExcerpt(input.answer),rule:"修订 Agent 必须确认答案完整覆盖必答项",message:input.assessment?.explanation??"修订 Agent 未返回可验证的通过结论。",suggestedAction:"modify_answer",evidencePaths:[]}];}
  if(input.kind==="negative"||input.review?.verdict==="pass")return[];
  if(input.review===undefined)return[{stage:"independent_review",field:"answerTemplate",triggerText:answerExcerpt(input.answer),rule:"独立内容复核必须返回明确结论",message:"独立内容复查未返回通过结论。",suggestedAction:"human_review",evidencePaths:[]}];
  const diagnostics=input.review.defects.filter((item)=>item.severity!=="minor").map((defect):RepairValidationDiagnostic=>{
    const stage=defect.category==="citation_gap"?"evidence_support":defect.category==="coverage_gap"||defect.category==="planning_gap"?"obligation_coverage":defect.category==="logic_gap"?"forbidden_claim":"independent_review";
    const missingGovernedConcept=defect.summary.includes("缺少受治理概念")&&defect.evidence.trim()!=="";
    const message=missingGovernedConcept?`${defect.summary}：${defect.evidence}`:defect.summary;
    const rule=missingGovernedConcept?`必须覆盖：${defect.evidence}`:defect.summary;
    const suggestedAction=stage==="evidence_support"?"add_evidence":stage==="independent_review"?"human_review":"modify_answer",obligationId=obligationIdFrom(`${defect.summary} ${defect.evidence}`),triggerText=missingGovernedConcept?answerExcerpt(input.answer):answerTrigger(input.answer,defect.evidence);
    return{stage,...(obligationId===undefined?{}:{obligationId}),field:stage==="evidence_support"?"preferredEvidencePaths":"answerTemplate",triggerText,rule,message,suggestedAction,evidencePaths:stage==="evidence_support"?evidencePathsFrom(defect.evidence):[]};
  });
  return diagnostics.length>0?diagnostics:[{stage:"independent_review",field:"answerTemplate",triggerText:answerExcerpt(input.answer),rule:input.review.summary,message:input.review.summary,suggestedAction:"human_review",evidencePaths:[]}];
}
function obligationIdFrom(value:string|undefined):string|undefined{return value?.match(/\bO\d+\b/u)?.[0];}
function answerExcerpt(value:string):string{return value.trim().replace(/\s+/gu," ").slice(0,500);}
function answerTrigger(answer:string,evidence:string):string{const candidate=evidence.split("；")[0]?.trim();return candidate&&answer.includes(candidate)?candidate.slice(0,1_000):answerExcerpt(answer);}
function evidencePathsFrom(value:string):string[]{return [...value.matchAll(/wiki\/[\p{L}\p{N}_.\-/ ()（）]+\.md/gu)].map((item)=>item[0]).slice(0,20);}
function uniqueValidationDiagnostics(values:readonly RepairValidationDiagnostic[]):RepairValidationDiagnostic[]{const seen=new Set<string>();return values.filter((item)=>{const key=`${item.stage}\0${item.obligationId??""}\0${item.field??""}\0${item.message}\0${item.triggerText}`;if(seen.has(key))return false;seen.add(key);return true;});}
function requireString(value:Record<string,unknown>,key:string){const result=value[key];if(typeof result!=="string"||result.trim()==="")throw new Error(`${key}_required`);return result;}
function normalize(value:string){return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}
function isActiveCard(status:string){return status==="approved"||status==="release_ready"||status==="released";}
export function resolveReviewCard(catalog:AnswerCardCatalog,question:string,match:Record<string,unknown>|undefined):AnswerCard|undefined{
  const exact=catalog.cards.find((card)=>isActiveCard(card.reviewStatus)&&[card.canonicalQuestion,...card.aliases].some((candidate)=>normalize(candidate)===normalize(question)));
  if(exact!==undefined)return exact;
  const hashes=match?.cardIdHashes;
  if(!Array.isArray(hashes)||hashes.length!==1||typeof hashes[0]!=="string"||!/^[a-f0-9]{64}$/u.test(hashes[0]))return undefined;
  const matched=findCardByHashedKey(catalog,hashes[0]);
  return matched!==undefined&&isActiveCard(matched.reviewStatus)?matched:undefined;
}
function hashCatalog(catalog:AnswerCardCatalog){return createHash("sha256").update(stableJson(catalog)).digest("hex");}
function stableJson(value:unknown):string{if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;if(value!==null&&typeof value==="object"){const r=value as Record<string,unknown>;return`{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(",")}}`;}return JSON.stringify(value);}
function safeCode(error:unknown){return error instanceof Error?error.message.replace(/[^a-z0-9_:.-]/giu,"_").slice(0,160):"worker_job_failed";}
function isTransientModelError(code:string){return code==="model_unavailable"||code.startsWith("model_unavailable_")||code.startsWith("model_request_timeout")||code.startsWith("model_timeout");}
function primaryIssueCategory(result:{readonly defects:readonly{readonly category:IssueCategory;readonly severity:string}[]}):IssueCategory{return result.defects.find((item)=>item.severity==="critical")?.category??result.defects.find((item)=>item.severity==="major")?.category??result.defects[0]?.category??"coverage_gap";}
function cardKey(match:Record<string,unknown>|undefined):string|undefined{const values=match?.cardIdHashes;return Array.isArray(values)&&typeof values[0]==="string"&&/^[a-f0-9]{64}$/u.test(values[0])?values[0]:undefined;}
function hashText(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}
function findCardByCurrentQuestion(catalog:AnswerCardCatalog,records:readonly RepairRecord[]):AnswerCard|undefined{
  const questions=new Set(records.map((record)=>normalize(record.question)).filter(Boolean));
  return catalog.cards.find((card)=>isActiveCard(card.reviewStatus)&&[card.canonicalQuestion,...card.aliases].some((question)=>questions.has(normalize(question))));
}
export function resolveRepairRoute(input:{readonly category:IssueCategory;readonly domain:KnowledgeDomain|undefined;readonly revision:string|undefined;readonly located:LocatedAnswerCard|undefined;readonly hasEvidence:boolean}):RepairRoute{
  if(input.category==="logic_gap"||input.category==="judgement_conflict"||input.category==="review_error")return{targetKind:"system_fix",publishableAllowed:false,blockingReason:input.category==="judgement_conflict"?"用户反馈与自动复查结论冲突，需要管理员裁决，不能自动写入知识库。":"该问题属于逻辑或程序链路，不应通过改写企业知识掩盖，需要创建系统修复任务。"};
  if(input.category==="knowledge_gap"&&!input.hasEvidence)return{targetKind:"knowledge_page",...(input.domain===undefined?{}:{targetDomain:input.domain}),...(input.revision===undefined?{}:{baseGitRevision:input.revision}),publishableAllowed:false,blockingReason:"正式资料存在缺口，请先由管理员补充和确认知识来源，再生成答案卡。"};
  if(input.domain===undefined||input.revision===undefined)return{targetKind:"knowledge_page",publishableAllowed:false,blockingReason:"无法确定问题属于专业知识库还是通用售前知识库，需要管理员判断。"};
  if(input.located!==undefined)return{targetKind:"answer_card",targetDomain:input.domain,targetPath:input.located.path,cardId:input.located.card.cardId,baseGitRevision:input.revision,existingCard:input.located.card,publishableAllowed:true};
  if(!input.hasEvidence)return{targetKind:"knowledge_page",targetDomain:input.domain,baseGitRevision:input.revision,publishableAllowed:false,blockingReason:"没有已校验的正式证据，不能把用户反馈直接固化为企业答案。"};
  return{targetKind:"answer_card",targetDomain:input.domain,baseGitRevision:input.revision,publishableAllowed:true};
}
function repairEvidenceQueries(records:readonly RepairRecord[]):string[]{return records.flatMap((record)=>[record.question,record.rawQuestion,record.reviewSummary,...(record.defects??[]).flatMap((defect)=>[defect.summary,defect.evidence])].filter((value):value is string=>typeof value==="string"&&value.trim()!==""));}
function uniqueReferences(references:readonly AnswerReviewReference[]):AnswerReviewReference[]{const seen=new Set<string>();return references.filter((item)=>{const key=`${item.project}\0${item.path}\0${item.revision}\0${item.contentHash}`;if(seen.has(key))return false;seen.add(key);return true;});}
function runCatalogCases(catalog:AnswerCardCatalog,cases:readonly RegressionCaseRecord[]){return cases.filter((item)=>item.enabled).map((test)=>{const exact=catalog.cards.find((card)=>isActiveCard(card.reviewStatus)&&[card.canonicalQuestion,...card.aliases].some((question)=>normalize(question)===normalize(test.question))),negative=(test.kind==="negative"||test.kind==="stale")&&test.expectedCardId===undefined;const expected=negative?exact===undefined:test.expectedCardId===undefined||exact?.cardId===test.expectedCardId,domain=exact===undefined||exact.domain===test.domain,obligations=test.requiredObligationIds.every((id)=>exact?.obligations.some((item)=>item.id===id)),forbidden=test.forbiddenClaims.every((claim)=>!exact?.answerTemplate.includes(claim));return{caseId:test.caseId,passed:expected&&domain&&obligations&&forbidden,...(exact===undefined?{}:{actualCardId:exact.cardId})};});}
function repairReleaseId(timestamp:string,kind:string,seed:string):string{const date=new Date(timestamp),year=String(date.getUTCFullYear()),month=String(date.getUTCMonth()+1).padStart(2,"0"),suffix=createHash("sha256").update(seed).digest("hex").slice(0,10).toUpperCase();return`KR-${year}-${month}-${kind}-${suffix}`;}
