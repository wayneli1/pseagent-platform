import { createHash,randomUUID } from "node:crypto";
import { answerCardSchema, releaseManifestSchema, type KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import { ContentCipher } from "./crypto.js";
import { assertAuthorized } from "./rbac.js";
import { answerReviewIntakeSchema, feedbackIntakeSchema, releaseQualityReportImportSchema, repairProposalSchema } from "./schemas.js";
import type { KnowledgeOpsStore } from "./store.js";
import type {
  AnswerReviewCaseListView, AnswerReviewCaseView, AnswerReviewEncryptedPayload, CardRevision,
  FeedbackCaseListView, FeedbackCaseView, IssueCategory, IssueListQuery, IssuePriority, IssueStatus, OpsActor, RegressionCaseRecord,
  KnowledgeRepairDraft, KnowledgeRepairDraftSummary, KnowledgeRepairDraftView, RepairDraftProposal, RepairPublication,
  RepairValidationRun, RepairValidationRunView, ReleaseRecord, ReviewRecord, StoredAnswerReviewCase, StoredFeedbackCase,
} from "./types.js";

export class KnowledgeOpsService {
  constructor(
    private readonly store: KnowledgeOpsStore,
    private readonly cipher: ContentCipher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async dashboard(actor: OpsActor) { assertAuthorized(actor,"dashboard:read"); return this.store.dashboard(); }

  async ingestAnswerReview(actor:OpsActor,source:unknown){
    assertAuthorized(actor,"answer_review:ingest");const intake=answerReviewIntakeSchema.parse(source);const timestamp=this.timestamp();
    const stored:StoredAnswerReviewCase={reviewId:intake.reviewId,requestId:intake.requestId,pseudonymousUserId:intake.pseudonymousUserId,
      processingStatus:"queued",verdict:"pending",workflowStatus:"open",
      encryptedPayload:this.cipher.encrypt({question:intake.question,answer:intake.answer,references:intake.references,
        ...(intake.userDisplayName?{userDisplayName:intake.userDisplayName}:{}),questionId:intake.questionId,answeredAt:intake.answeredAt,
        ...(intake.answerCardMatch?{answerCardMatch:intake.answerCardMatch}:{}),
        ...(intake.answerCardActivation?{answerCardActivation:intake.answerCardActivation}:{})}),
      answerStatus:intake.answerStatus,...(intake.scope?{scope:intake.scope}:{}),referenceCount:intake.references.length,
      source:intake.source,model:"deepseek_v4_flash",defectCount:0,createdAt:timestamp,updatedAt:timestamp};
    const result=await this.store.insertAnswerReviewAndEnqueue(stored);
    if(result.enqueued)await this.audit(actor,"answer_review.ingest","answer_review",result.review.reviewId,{source:result.review.source,model:result.review.model});
    return{reviewId:result.review.reviewId,processingStatus:result.review.processingStatus,enqueued:result.enqueued};
  }
  async listAnswerReviews(actor:OpsActor):Promise<readonly AnswerReviewCaseListView[]>{
    assertAuthorized(actor,"answer_review:read");return(await this.store.listAnswerReviews()).map((stored)=>{
      const content=this.cipher.decrypt<{question:string;userDisplayName?:string}>(stored.encryptedPayload);const{encryptedPayload:_secret,...metadata}=stored;
      return{...metadata,questionPreview:[...content.question].slice(0,160).join(""),...(content.userDisplayName?{userDisplayName:content.userDisplayName}:{})};
    });
  }
  async answerReviewDetail(actor:OpsActor,reviewId:string):Promise<AnswerReviewCaseView|undefined>{
    assertAuthorized(actor,"answer_review:read");const stored=await this.store.getAnswerReview(reviewId);if(stored===undefined)return undefined;
    const content=this.cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);const{encryptedPayload:_secret,...metadata}=stored;return{...metadata,...content};
  }
  async triageAnswerReview(actor:OpsActor,reviewId:string,workflowStatus:StoredAnswerReviewCase["workflowStatus"]){
    assertAuthorized(actor,"answer_review:triage");const before=await this.store.getAnswerReview(reviewId);const value=await this.store.updateAnswerReviewWorkflow(reviewId,workflowStatus);
    if(value)await this.audit(actor,"answer_review.triage","answer_review",reviewId,{previousWorkflowStatus:before?.workflowStatus,workflowStatus});return value;
  }

  async ingestFeedback(actor: OpsActor, source: unknown): Promise<StoredFeedbackCase> {
    assertAuthorized(actor,"feedback:ingest");
    const parsed = feedbackIntakeSchema.parse(source);
    const intake = parsed;
    const timestamp = this.timestamp();
    const stored: StoredFeedbackCase = {
      caseId:intake.caseId,requestId:intake.requestId,pseudonymousUserId:intake.pseudonymousUserId,
      classification:intake.classification,status:"new",
      encryptedPayload:this.cipher.encrypt({question:intake.question,answer:intake.answer,comment:intake.comment,
        ...(intake.userDisplayName?{userDisplayName:intake.userDisplayName}:{}),
        ...(intake.proposedAnswer?{proposedAnswer:intake.proposedAnswer}:{}),
        questionId:intake.questionId,answeredAt:intake.answeredAt,answerCardMatch:intake.answerCardMatch}),
      answerStatus:intake.answerStatus,...(intake.scope?{scope:intake.scope}:{}),referenceCount:intake.referenceCount,
      source:intake.source,createdAt:timestamp,updatedAt:timestamp,
    };
    const result=await this.store.insertFeedback(stored);
    await this.audit(actor,"feedback.ingest","feedback_case",result.caseId,{classification:result.classification,source:result.source});
    if(intake.classification!=="useful"){
      const issue=await this.recordFeedbackIssue(result,{question:intake.question,...(intake.answerCardMatch?{answerCardMatch:intake.answerCardMatch}:{})},await this.store.getAnswerReviewByRequestId(intake.requestId));
      await this.audit(actor,"issue.feedback.upsert","issue_case",issue.issueId,{classification:intake.classification,priority:issue.priority,category:issue.category});
    }
    return result;
  }

  async listFeedback(actor: OpsActor): Promise<readonly FeedbackCaseListView[]> {
    assertAuthorized(actor,"feedback:read");
    return (await this.store.listFeedback()).map((stored) => {
      const content=this.cipher.decrypt<{userDisplayName?:string}>(stored.encryptedPayload);
      const {encryptedPayload:_secret,...metadata}=stored;
      return {...metadata,...(content.userDisplayName?{userDisplayName:content.userDisplayName}:{})};
    });
  }
  async feedbackDetail(actor: OpsActor, caseId: string): Promise<FeedbackCaseView|undefined> {
    assertAuthorized(actor,"feedback:read"); const stored=await this.store.getFeedback(caseId); if(!stored)return undefined;
    const content=this.cipher.decrypt<{question:string;answer:string;comment:string;proposedAnswer?:string;userDisplayName?:string;questionId:number;answeredAt:string;answerCardMatch?:Record<string,unknown>}>(stored.encryptedPayload);
    const {encryptedPayload:_secret,...metadata}=stored;
    return {...metadata,...content};
  }
  async triageFeedback(actor: OpsActor,caseId:string,patch:Pick<Partial<StoredFeedbackCase>,"status"|"classification">) {
    assertAuthorized(actor,"feedback:triage");const before=await this.store.getFeedback(caseId);
    const value=await this.store.updateFeedback(caseId,patch);
    if(value)await this.audit(actor,"feedback.triage","feedback_case",caseId,{
      ...(patch.status===undefined?{}:{previousStatus:before?.status,status:patch.status}),
      ...(patch.classification===undefined?{}:{previousClassification:before?.classification,classification:patch.classification}),
    });return value;
  }

  async listIssues(actor:OpsActor,query:IssueListQuery){assertAuthorized(actor,"issue:read");return this.store.listIssues(query);}
  async issueDetail(actor:OpsActor,issueId:string){assertAuthorized(actor,"issue:read");const issue=await this.store.getIssue(issueId);if(issue===undefined)return undefined;return{...issue,occurrences:await this.store.listIssueOccurrences(issueId)};}
  async rebuildIssues(actor:OpsActor){assertAuthorized(actor,"issue:rebuild");let feedbackCount=0,reviewCount=0;for(const stored of await this.store.listFeedback()){if(stored.classification==="useful"||stored.status==="resolved"||stored.status==="rejected")continue;const payload=this.cipher.decrypt<FeedbackIssuePayload>(stored.encryptedPayload);await this.recordFeedbackIssue(stored,payload,await this.store.getAnswerReviewByRequestId(stored.requestId));feedbackCount++;}for(const stored of await this.store.listAnswerReviews()){if(stored.workflowStatus==="resolved"||stored.workflowStatus==="dismissed"||stored.verdict==="pass"||stored.verdict==="pending"&&stored.processingStatus!=="errored")continue;const payload=this.cipher.decrypt<AnswerReviewEncryptedPayload>(stored.encryptedPayload);const priority=stored.processingStatus==="errored"?"p3":stored.verdict==="fail"?"p0":"p1";const category=stored.processingStatus==="errored"?"review_error":primaryReviewIssueCategory(payload);await this.recordReviewIssue(stored,payload,priority,category);reviewCount++;}await this.audit(actor,"issue.rebuild","issue_case","all",{feedbackCount,reviewCount});return{feedbackCount,reviewCount};}
  async triageIssue(actor:OpsActor,issueId:string,status:"open"|"dismissed"){assertAuthorized(actor,"issue:triage");const before=await this.store.getIssue(issueId);if(before===undefined)return undefined;if(!validManualIssueTransition(before.status,status))throw new Error("invalid_issue_transition");const value=await this.store.updateIssue(issueId,status);if(value)await this.audit(actor,"issue.triage","issue_case",issueId,{previousStatus:before.status,status});return value;}

  async listRepairDrafts(actor:OpsActor,issueId:string):Promise<readonly KnowledgeRepairDraftView[]>{assertAuthorized(actor,"repair:read");if(await this.store.getIssue(issueId)===undefined)throw new OpsNotFoundError("issue_not_found");return Promise.all((await this.store.listRepairDrafts(issueId)).map((draft)=>this.repairDraftView(draft)));}
  async repairDraftDetail(actor:OpsActor,draftId:string):Promise<KnowledgeRepairDraftView|undefined>{assertAuthorized(actor,"repair:read");const draft=await this.store.getRepairDraft(draftId);return draft===undefined?undefined:this.repairDraftView(draft);}
  async requestRepairDraft(actor:OpsActor,issueId:string){
    assertAuthorized(actor,"repair:edit");const issue=await this.store.getIssue(issueId);if(issue===undefined)throw new OpsNotFoundError("issue_not_found");
    if(issue.status==="resolved"||issue.status==="dismissed")throw new Error("issue_not_open_for_repair");
    const existing=(await this.store.listRepairDrafts(issueId)).find((draft)=>draft.status!=="published"&&draft.status!=="failed");
    if(existing!==undefined)return{draft:repairSummary(existing),enqueued:false};
    const timestamp=this.timestamp(),draft:KnowledgeRepairDraft={draftId:randomUUID(),issueId,status:"generating",model:"deepseek_v4_flash",encryptedPayload:this.cipher.encrypt({}),createdBy:actor.actorId,createdAt:timestamp,updatedAt:timestamp};
    const created=await this.store.createRepairDraft(draft);await this.store.updateIssue(issueId,"in_progress");const job=await this.store.enqueueJob("generate_repair_draft",{draftId:created.draftId});
    await this.audit(actor,"repair.draft.request","repair_draft",created.draftId,{issueId,jobId:job.jobId});return{draft:repairSummary(created),job,enqueued:true};
  }
  async saveRepairDraft(actor:OpsActor,draftId:string,proposalSource:unknown){
    assertAuthorized(actor,"repair:edit");const draft=await this.store.getRepairDraft(draftId);if(draft===undefined)throw new OpsNotFoundError("repair_draft_not_found");
    if(!["draft_ready","validation_failed"].includes(draft.status))throw new Error("repair_draft_not_editable");const proposal=repairProposalSchema.parse(proposalSource);
    const updated=await this.store.updateRepairDraft(draftId,{status:"draft_ready",targetKind:proposal.targetKind,...(proposal.targetDomain?{targetDomain:proposal.targetDomain}:{}),...(proposal.targetPath?{targetPath:proposal.targetPath}:{}),encryptedPayload:this.cipher.encrypt({proposal})});
    await this.store.updateIssue(draft.issueId,"in_progress");await this.audit(actor,"repair.draft.update","repair_draft",draftId,{issueId:draft.issueId,targetKind:proposal.targetKind,targetDomain:proposal.targetDomain,publishable:proposal.publishable});return updated===undefined?undefined:this.repairDraftView(updated);
  }
  async requestRepairValidation(actor:OpsActor,draftId:string){
    assertAuthorized(actor,"repair:validate");const draft=await this.store.getRepairDraft(draftId);if(draft===undefined)throw new OpsNotFoundError("repair_draft_not_found");
    if(!["draft_ready","validation_failed"].includes(draft.status))throw new Error("repair_draft_not_ready_for_validation");const proposal=this.cipher.decrypt<{proposal?:RepairDraftProposal}>(draft.encryptedPayload).proposal;if(proposal===undefined||!proposal.publishable)throw new Error("repair_draft_not_publishable");
    const timestamp=this.timestamp(),validation:RepairValidationRun={validationId:randomUUID(),draftId,issueId:draft.issueId,status:"queued",totalCases:proposal.regressionQuestions.length,passedCases:0,model:"deepseek_v4_flash",encryptedPayload:this.cipher.encrypt({}),createdAt:timestamp};
    const created=await this.store.createRepairValidation(validation);await this.store.updateRepairDraft(draftId,{status:"validating"});await this.store.updateIssue(draft.issueId,"validating");const job=await this.store.enqueueJob("validate_repair_draft",{draftId,validationId:created.validationId});
    await this.audit(actor,"repair.validation.request","repair_validation",created.validationId,{draftId,issueId:draft.issueId,jobId:job.jobId,totalCases:validation.totalCases});return{validation:validationSummary(created),job};
  }
  async listRepairValidations(actor:OpsActor,draftId:string):Promise<readonly RepairValidationRunView[]>{assertAuthorized(actor,"repair:read");return Promise.all((await this.store.listRepairValidations(draftId)).map((run)=>this.repairValidationView(run)));}
  async requestRepairPublication(actor:OpsActor,draftId:string){
    assertAuthorized(actor,"repair:publish");const draft=await this.store.getRepairDraft(draftId);if(draft===undefined)throw new OpsNotFoundError("repair_draft_not_found");
    if(draft.status!=="ready_to_publish"||draft.targetDomain===undefined||draft.targetPath===undefined||draft.baseGitRevision===undefined)throw new Error("repair_draft_not_ready_for_publish");const latest=(await this.store.listRepairValidations(draftId))[0];if(latest?.status!=="passed")throw new Error("passing_repair_validation_required");
    const timestamp=this.timestamp(),publication:RepairPublication={publicationId:randomUUID(),draftId,issueId:draft.issueId,status:"pending",targetDomain:draft.targetDomain,targetPath:draft.targetPath,baseGitRevision:draft.baseGitRevision,createdBy:actor.actorId,createdAt:timestamp};
    const created=await this.store.createRepairPublication(publication);await this.store.updateRepairDraft(draftId,{status:"publishing"});await this.store.updateIssue(draft.issueId,"validating");const job=await this.store.enqueueJob("publish_repair",{publicationId:created.publicationId});
    await this.audit(actor,"repair.publication.request","repair_publication",created.publicationId,{draftId,issueId:draft.issueId,jobId:job.jobId,targetDomain:draft.targetDomain,targetPath:draft.targetPath});return{publication:created,job};
  }
  async listRepairPublications(actor:OpsActor,draftId:string){assertAuthorized(actor,"repair:read");return this.store.listRepairPublications(draftId);}
  async requestRepairRollback(actor:OpsActor,publicationId:string){assertAuthorized(actor,"repair:rollback");const publication=await this.store.getRepairPublication(publicationId);if(publication===undefined)throw new OpsNotFoundError("repair_publication_not_found");if(publication.status!=="published")throw new Error("repair_publication_not_rollbackable");const job=await this.store.enqueueJob("rollback_repair",{publicationId});await this.audit(actor,"repair.rollback.request","repair_publication",publicationId,{draftId:publication.draftId,issueId:publication.issueId,jobId:job.jobId});return job;}

  async listCards(actor: OpsActor){assertAuthorized(actor,"card:read");return this.store.listCardRevisions();}
  async enqueueCatalogSync(actor:OpsActor){
    assertAuthorized(actor,"card:edit");
    const job=await this.store.enqueueJob("compile_catalog",{trigger:"admin"});
    await this.audit(actor,"card.catalog.sync.enqueue","job",job.jobId,{});
    return job;
  }
  async createCardRevision(actor:OpsActor,cardId:string,domain:KnowledgeDomain,content:Record<string,unknown>,baseGitRevision:string){
    assertAuthorized(actor,"card:edit",domain);
    const card=answerCardSchema.parse({...content,cardId,domain,reviewStatus:"draft"});
    const revisions=await this.store.listCardRevisions();
    const revision=Math.max(0,...revisions.filter(x=>x.cardId===cardId).map(x=>x.revision))+1;
    const timestamp=this.timestamp();
    const value:CardRevision={revisionId:randomUUID(),cardId,domain,revision,status:"draft",content:card,createdBy:actor.actorId,baseGitRevision,createdAt:timestamp,updatedAt:timestamp};
    const result=await this.store.createCardRevision(value); await this.audit(actor,"card.revision.create","card_revision",result.revisionId,{cardId,domain,revision}); return result;
  }
  async reviewRevision(actor:OpsActor,revisionId:string,decision:ReviewRecord["decision"],comment:string){
    const revision=await this.store.getCardRevision(revisionId);if(!revision)throw new OpsNotFoundError("revision_not_found");
    assertAuthorized(actor,"card:review",revision.domain);
    const review:ReviewRecord={reviewId:randomUUID(),revisionId,reviewerId:actor.actorId,decision,comment,createdAt:this.timestamp()};
    await this.store.addReview(review);
    const status=decision==="approved"?"approved":decision==="changes_requested"?"changes_requested":"deprecated";
    if(decision==="approved")await this.store.addApproval({approvalId:randomUUID(),revisionId,cardId:revision.cardId,domain:revision.domain,reviewerId:actor.actorId,createdAt:this.timestamp()});
    await this.store.updateCardRevisionStatus(revisionId,status);
    await this.audit(actor,"card.revision.review","card_revision",revisionId,{decision}); return review;
  }

  async listRegressionCases(actor:OpsActor){assertAuthorized(actor,"regression:read");return this.store.listRegressionCases();}
  async listRegressionRuns(actor:OpsActor){assertAuthorized(actor,"regression:read");return this.store.listRegressionRuns();}
  async recordRegressionRun(actor:OpsActor,source:unknown){
    assertAuthorized(actor,"regression:run");const report=releaseQualityReportImportSchema.parse(source);const timestamp=this.timestamp();
    const run={runId:randomUUID(),status:report.passed?"passed" as const:"failed" as const,totalCases:report.summary.total,passedCases:report.summary.passedCases,report,createdAt:timestamp,completedAt:timestamp};
    const result=await this.store.createRegressionRun(run);await this.audit(actor,"regression.quality.record","regression_run",result.runId,{model:report.model,passed:report.passed});return result;
  }
  async saveRegressionCase(actor:OpsActor,value:RegressionCaseRecord){assertAuthorized(actor,"regression:run");const result=await this.store.upsertRegressionCase(value);await this.audit(actor,"regression.case.save","regression_case",result.caseId,{});return result;}
  async enqueueRegression(actor:OpsActor,payload:Record<string,unknown>={}){assertAuthorized(actor,"regression:run");const job=await this.store.enqueueJob("regression_run",payload);await this.audit(actor,"regression.enqueue","job",job.jobId,{});return job;}

  async listReleases(actor:OpsActor){assertAuthorized(actor,"release:read");return this.store.listReleases();}
  async requestRelease(actor:OpsActor,manifestSource:unknown){
    assertAuthorized(actor,"release:publish");const manifest=releaseManifestSchema.parse(manifestSource);
    const run=await this.store.getRegressionRun(manifest.regressionRunId);const qualityGate=releaseQualityReportImportSchema.safeParse(run?.report);
    if(!run||run.status!=="passed"||!qualityGate.success||!qualityGate.data.passed)throw new Error("passing_release_quality_gate_required");
    const release:ReleaseRecord={...manifest,manifest,status:"pending",createdBy:actor.actorId};
    await this.store.createRelease(release);const job=await this.store.enqueueJob("publish_release",{releaseId:release.releaseId});
    await this.audit(actor,"release.request","release",release.releaseId,{jobId:job.jobId});return {release,job};
  }
  async requestRollback(actor:OpsActor,releaseId:string){assertAuthorized(actor,"release:rollback");const job=await this.store.enqueueJob("rollback_release",{releaseId});await this.audit(actor,"release.rollback.request","release",releaseId,{jobId:job.jobId});return job;}
  async jobs(actor:OpsActor){assertAuthorized(actor,"job:read");return this.store.listJobs();}
  async auditEvents(actor:OpsActor){assertAuthorized(actor,"audit:read");return this.store.listAudit();}

  private timestamp(){return this.clock().toISOString();}
  private repairDraftView(draft:KnowledgeRepairDraft):KnowledgeRepairDraftView{const payload=this.cipher.decrypt<{proposal?:RepairDraftProposal}>(draft.encryptedPayload);return{...repairSummary(draft),...(payload.proposal?{proposal:payload.proposal}:{})};}
  private repairValidationView(run:RepairValidationRun):RepairValidationRunView{const payload=this.cipher.decrypt<{result?:Record<string,unknown>}>(run.encryptedPayload);return{...validationSummary(run),...(payload.result?{result:payload.result}:{})};}
  private recordFeedbackIssue(stored:StoredFeedbackCase,payload:FeedbackIssuePayload,linkedReview:StoredAnswerReviewCase|undefined){const conflict=linkedReview?.verdict==="pass";const category=conflict?"judgement_conflict" as const:feedbackIssueCategory(stored.classification as Exclude<StoredFeedbackCase["classification"],"useful">);const priority=conflict||stored.classification==="incorrect"?"p1" as const:"p2" as const;const cardKey=answerCardKey(payload.answerCardMatch),questionKey=hash(normalizeQuestion(payload.question)),groupKey=cardKey??questionKey;return this.store.recordIssue({fingerprint:hash(`${stored.scope??"unknown"}\0${groupKey}\0${category}`),title:`feedback:${category}:${groupKey.slice(0,12)}`,priority,category,...(stored.scope?{scope:stored.scope}:{}),...(cardKey?{answerCardKey:cardKey}:{}),occurredAt:stored.createdAt,occurrence:{sourceType:"feedback",sourceId:stored.caseId,requestId:stored.requestId,pseudonymousUserId:stored.pseudonymousUserId}});}
  private recordReviewIssue(stored:StoredAnswerReviewCase,payload:AnswerReviewEncryptedPayload,priority:IssuePriority,category:IssueCategory){const questionKey=hash(normalizeQuestion(payload.question)),cardKey=answerCardKey(payload.answerCardMatch),groupKey=cardKey??questionKey;return this.store.recordIssue({fingerprint:hash(`${stored.scope??"unknown"}\0${groupKey}\0${category}`),title:`review:${category}:${groupKey.slice(0,12)}`,priority,category,...(stored.scope?{scope:stored.scope}:{}),...(cardKey?{answerCardKey:cardKey}:{}),occurredAt:stored.createdAt,occurrence:{sourceType:"answer_review",sourceId:stored.reviewId,requestId:stored.requestId,pseudonymousUserId:stored.pseudonymousUserId}});}
  private async audit(actor:OpsActor,action:string,resourceType:string,resourceId:string,metadata:Record<string,unknown>){
    await this.store.appendAudit({auditId:randomUUID(),actorId:actor.actorId,action,resourceType,resourceId,metadata,createdAt:this.timestamp()});
  }
}

export class OpsNotFoundError extends Error { constructor(readonly code:string){super(code);this.name="OpsNotFoundError";} }

interface FeedbackIssuePayload {readonly question:string;readonly answerCardMatch?:Record<string,unknown>;}

function feedbackIssueCategory(classification:Exclude<StoredFeedbackCase["classification"],"useful">){return({incorrect:"user_incorrect",missing:"user_missing",review_requested:"review_requested",evidence:"evidence",correction:"correction"} as const)[classification];}
function answerCardKey(match:Record<string,unknown>|undefined):string|undefined{const values=match?.cardIdHashes;return Array.isArray(values)&&typeof values[0]==="string"&&/^[a-f0-9]{64}$/u.test(values[0])?values[0]:undefined;}
function normalizeQuestion(value:string):string{return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");}
function hash(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}
function primaryReviewIssueCategory(payload:AnswerReviewEncryptedPayload):IssueCategory{return payload.result?.defects.find((item)=>item.severity==="critical")?.category??payload.result?.defects.find((item)=>item.severity==="major")?.category??payload.result?.defects[0]?.category??"coverage_gap";}
function validManualIssueTransition(current:IssueStatus,next:"open"|"dismissed"):boolean{return current===next||next==="dismissed"&&current!=="resolved"||next==="open"&&(current==="dismissed"||current==="resolved");}
function repairSummary(draft:KnowledgeRepairDraft):KnowledgeRepairDraftSummary{const{encryptedPayload:_secret,...summary}=draft;return summary;}
function validationSummary(run:RepairValidationRun):Omit<RepairValidationRun,"encryptedPayload">{const{encryptedPayload:_secret,...summary}=run;return summary;}
