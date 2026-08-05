import { randomUUID } from "node:crypto";
import { answerCardSchema, releaseManifestSchema, type KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import { ContentCipher } from "./crypto.js";
import { assertAuthorized, assertSeparationOfDuties } from "./rbac.js";
import { feedbackIntakeSchema, releaseQualityReportImportSchema } from "./schemas.js";
import type { KnowledgeOpsStore } from "./store.js";
import type {
  CardRevision, FeedbackCaseView, OpsActor,
  RegressionCaseRecord, ReleaseRecord, ReviewRecord, StoredFeedbackCase,
} from "./types.js";

export class KnowledgeOpsService {
  constructor(
    private readonly store: KnowledgeOpsStore,
    private readonly cipher: ContentCipher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async dashboard(actor: OpsActor) { assertAuthorized(actor,"dashboard:read"); return this.store.dashboard(); }

  async ingestFeedback(actor: OpsActor, source: unknown): Promise<StoredFeedbackCase> {
    assertAuthorized(actor,"feedback:ingest");
    const parsed = feedbackIntakeSchema.parse(source);
    const intake = parsed;
    const timestamp = this.timestamp();
    const stored: StoredFeedbackCase = {
      caseId:intake.caseId,requestId:intake.requestId,pseudonymousUserId:intake.pseudonymousUserId,
      classification:intake.classification,status:"new",
      encryptedPayload:this.cipher.encrypt({question:intake.question,answer:intake.answer,comment:intake.comment,
        ...(intake.proposedAnswer?{proposedAnswer:intake.proposedAnswer}:{}),
        questionId:intake.questionId,answeredAt:intake.answeredAt,answerCardMatch:intake.answerCardMatch}),
      answerStatus:intake.answerStatus,...(intake.scope?{scope:intake.scope}:{}),referenceCount:intake.referenceCount,
      source:intake.source,createdAt:timestamp,updatedAt:timestamp,
    };
    const result=await this.store.insertFeedback(stored);
    await this.audit(actor,"feedback.ingest","feedback_case",result.caseId,{classification:result.classification,source:result.source});
    return result;
  }

  async listFeedback(actor: OpsActor) { assertAuthorized(actor,"feedback:read"); return (await this.store.listFeedback()).map(({encryptedPayload:_secret,...metadata})=>metadata); }
  async feedbackDetail(actor: OpsActor, caseId: string): Promise<FeedbackCaseView|undefined> {
    assertAuthorized(actor,"feedback:read"); const stored=await this.store.getFeedback(caseId); if(!stored)return undefined;
    const content=this.cipher.decrypt<{question:string;answer:string;comment:string;proposedAnswer?:string;questionId:number;answeredAt:string;answerCardMatch?:Record<string,unknown>}>(stored.encryptedPayload);
    const {encryptedPayload:_secret,...metadata}=stored;
    return {...metadata,...content};
  }
  async triageFeedback(actor: OpsActor,caseId:string,status:StoredFeedbackCase["status"]) {
    assertAuthorized(actor,"feedback:triage"); const value=await this.store.updateFeedbackStatus(caseId,status);
    if(value)await this.audit(actor,"feedback.triage","feedback_case",caseId,{status}); return value;
  }

  async listCards(actor: OpsActor){assertAuthorized(actor,"card:read");return this.store.listCardRevisions();}
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
    assertAuthorized(actor,"card:review",revision.domain); assertSeparationOfDuties(actor,revision.createdBy);
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
    if(manifest.approvedBy.includes(actor.actorId)) throw new Error("release_requester_cannot_be_sole_approver");
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
  private async audit(actor:OpsActor,action:string,resourceType:string,resourceId:string,metadata:Record<string,unknown>){
    await this.store.appendAudit({auditId:randomUUID(),actorId:actor.actorId,action,resourceType,resourceId,metadata,createdAt:this.timestamp()});
  }
}

export class OpsNotFoundError extends Error { constructor(readonly code:string){super(code);this.name="OpsNotFoundError";} }
