import { ZodError } from "zod";
import { knowledgeDomainSchema } from "@pseagent/knowledge-governance-contracts";
import { OpsAuthorizationError } from "./rbac.js";
import type { OpsAuthenticator } from "./rbac.js";
import { adminLoginSchema, answerReviewWorkflowPatchSchema, emptyActionSchema, feedbackPatchSchema, issueListQuerySchema, issuePatchSchema, repairBatchRequestSchema, repairDraftUpdateSchema, reviewInputSchema } from "./schemas.js";
import { KnowledgeOpsService, OpsNotFoundError } from "./service.js";

export interface OpsApiRequest { readonly method:string; readonly path:string; readonly authorization?:string; readonly body?:unknown; }
export interface OpsApiResponse { readonly status:number; readonly body:unknown; }

export class KnowledgeOpsApi {
  constructor(private readonly service:KnowledgeOpsService,private readonly authorizer:OpsAuthenticator){}
  async handle(request:OpsApiRequest):Promise<OpsApiResponse>{
    const url=new URL(request.path,"http://knowledge-ops.local");const pathname=url.pathname;const segments=pathname.split("/").filter(Boolean);
    try{
      if(request.method==="POST"&&pathname==="/v1/auth/login"){
        const input=adminLoginSchema.parse(request.body),session=await this.authorizer.login?.(input.username,input.password);
        if(session===undefined)return{status:401,body:{error:"invalid_credentials"}};
        return ok({sessionToken:session.sessionToken,expiresAt:session.expiresAt,user:{username:session.actor.actorId}});
      }
      const credential=bearer(request.authorization),actor=this.authorizer.authenticate(credential);
      if(!actor)return {status:401,body:{error:"authentication_required"}};
      if(request.method==="POST"&&pathname==="/v1/auth/logout"){this.authorizer.logout?.(credential);return ok({status:"logged_out"});}
      if(request.method==="GET"&&pathname==="/v1/dashboard")return ok(await this.service.dashboard(actor));
      if(request.method==="POST"&&pathname==="/v1/answer-reviews")return created(await this.service.ingestAnswerReview(actor,request.body));
      if(request.method==="GET"&&pathname==="/v1/answer-reviews")return ok(await this.service.listAnswerReviews(actor));
      if(segments[0]==="v1"&&segments[1]==="answer-reviews"&&segments[2]){
        if(request.method==="GET"){const value=await this.service.answerReviewDetail(actor,segments[2]);return value?ok(value):notFound();}
        if(request.method==="PATCH"){const input=answerReviewWorkflowPatchSchema.parse(request.body);const value=await this.service.triageAnswerReview(actor,segments[2],input.workflowStatus);return value?ok(value):notFound();}
      }
      if(request.method==="POST"&&pathname==="/v1/feedback")return created(await this.service.ingestFeedback(actor,request.body));
      if(request.method==="GET"&&pathname==="/v1/feedback")return ok(await this.service.listFeedback(actor));
      if(segments[0]==="v1"&&segments[1]==="feedback"&&segments[2]){
        if(request.method==="GET"){const value=await this.service.feedbackDetail(actor,segments[2]);return value?ok(value):notFound();}
        if(request.method==="PATCH"){const input=feedbackPatchSchema.parse(request.body);const patch={...(input.status===undefined?{}:{status:input.status}),...(input.classification===undefined?{}:{classification:input.classification})};const value=await this.service.triageFeedback(actor,segments[2],patch);return value?ok(value):notFound();}
      }
      if(request.method==="GET"&&pathname==="/v1/issues"){const input=issueListQuerySchema.parse(Object.fromEntries(url.searchParams));return ok(await this.service.listIssues(actor,{limit:input.limit,offset:input.offset,...(input.status?{status:input.status}:{}),...(input.priority?{priority:input.priority}:{}),...(input.actionable===undefined?{}:{actionableOnly:input.actionable})}));}
      if(request.method==="POST"&&pathname==="/v1/issues/rebuild")return ok(await this.service.rebuildIssues(actor));
      if(segments[0]==="v1"&&segments[1]==="issues"&&segments[2]&&segments[3]==="repair-drafts"){
        if(request.method==="GET")return ok(await this.service.listRepairDrafts(actor,segments[2]));
        if(request.method==="POST"){emptyActionSchema.parse(request.body??{});return created(await this.service.requestRepairDraft(actor,segments[2]));}
      }
      if(segments[0]==="v1"&&segments[1]==="issues"&&segments[2]){
        if(request.method==="GET"){const value=await this.service.issueDetail(actor,segments[2]);return value?ok(value):notFound();}
        if(request.method==="PATCH"){const input=issuePatchSchema.parse(request.body);const value=await this.service.triageIssue(actor,segments[2],input.status);return value?ok(value):notFound();}
      }
      if(request.method==="GET"&&pathname==="/v1/repair-drafts/ready")return ok(await this.service.listReadyRepairDrafts(actor));
      if(request.method==="GET"&&pathname==="/v1/repair-batches")return ok(await this.service.listRepairBatches(actor));
      if(request.method==="POST"&&pathname==="/v1/repair-batches"){const input=repairBatchRequestSchema.parse(request.body);return created(await this.service.requestRepairBatch(actor,input.draftIds));}
      if(segments[0]==="v1"&&segments[1]==="repair-batches"&&segments[2]&&request.method==="GET"){const value=await this.service.repairBatchDetail(actor,segments[2]);return value?ok(value):notFound();}
      if(segments[0]==="v1"&&segments[1]==="repair-drafts"&&segments[2]){
        if(request.method==="GET"&&segments.length===3){const value=await this.service.repairDraftDetail(actor,segments[2]);return value?ok(value):notFound();}
        if(request.method==="PATCH"&&segments.length===3){const input=repairDraftUpdateSchema.parse(request.body);const value=await this.service.saveRepairDraft(actor,segments[2],input.proposal);return value?ok(value):notFound();}
        if(request.method==="POST"&&segments[3]==="validate"){emptyActionSchema.parse(request.body??{});return created(await this.service.requestRepairValidation(actor,segments[2]));}
        if(request.method==="GET"&&segments[3]==="validations")return ok(await this.service.listRepairValidations(actor,segments[2]));
        if(request.method==="POST"&&segments[3]==="publish"){emptyActionSchema.parse(request.body??{});return created(await this.service.requestRepairPublication(actor,segments[2]));}
        if(request.method==="GET"&&segments[3]==="publications")return ok(await this.service.listRepairPublications(actor,segments[2]));
      }
      if(segments[0]==="v1"&&segments[1]==="repair-publications"&&segments[2]&&segments[3]==="rollback"&&request.method==="POST"){emptyActionSchema.parse(request.body??{});return created(await this.service.requestRepairRollback(actor,segments[2]));}
      if(request.method==="GET"&&pathname==="/v1/cards")return ok(await this.service.listCards(actor));
      if(request.method==="POST"&&pathname==="/v1/cards/sync")return created(await this.service.enqueueCatalogSync(actor));
      if(segments[0]==="v1"&&segments[1]==="cards"&&segments[2]&&segments[3]==="revisions"&&request.method==="POST"){
        const body=record(request.body);return created(await this.service.createCardRevision(actor,segments[2],knowledgeDomainSchema.parse(body.domain),record(body.content),String(body.baseGitRevision)));
      }
      if(segments[0]==="v1"&&segments[1]==="revisions"&&segments[2]&&segments[3]==="reviews"&&request.method==="POST"){
        const input=reviewInputSchema.parse(request.body);return created(await this.service.reviewRevision(actor,segments[2],input.decision,input.comment));
      }
      if(request.method==="GET"&&pathname==="/v1/regressions")return ok(await this.service.listRegressionCases(actor));
      if(request.method==="GET"&&pathname==="/v1/regression-runs")return ok(await this.service.listRegressionRuns(actor));
      if(request.method==="POST"&&pathname==="/v1/regression-runs")return created(await this.service.recordRegressionRun(actor,request.body));
      if(request.method==="POST"&&pathname==="/v1/regressions/run")return created(await this.service.enqueueRegression(actor,record(request.body)));
      if(request.method==="GET"&&pathname==="/v1/releases")return ok(await this.service.listReleases(actor));
      if(request.method==="POST"&&pathname==="/v1/releases")return created(await this.service.requestRelease(actor,request.body));
      if(segments[0]==="v1"&&segments[1]==="releases"&&segments[2]&&segments[3]==="rollback"&&request.method==="POST")return created(await this.service.requestRollback(actor,segments[2]));
      if(request.method==="GET"&&pathname==="/v1/jobs")return ok(await this.service.jobs(actor));
      if(request.method==="GET"&&pathname==="/v1/audit")return ok(await this.service.auditEvents(actor));
      return {status:404,body:{error:"route_not_found"}};
    }catch(error){return errorResponse(error);}
  }
}
function bearer(value:string|undefined){const match=/^Bearer\s+(.+)$/iu.exec(value??"");return match?.[1];}
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function ok(body:unknown):OpsApiResponse{return{status:200,body};}function created(body:unknown):OpsApiResponse{return{status:201,body};}function notFound():OpsApiResponse{return{status:404,body:{error:"not_found"}};}
function errorResponse(error:unknown):OpsApiResponse{if(error instanceof OpsAuthorizationError)return{status:error.code==="authentication_required"?401:403,body:{error:error.code}};if(error instanceof ZodError)return{status:400,body:{error:"validation_failed",issues:error.issues.map(x=>({path:x.path.join("."),message:x.message}))}};if(error instanceof OpsNotFoundError)return notFound();const code=error instanceof Error?error.message:"internal_error";const status=code.includes("already")||code.includes("required")||code.includes("cannot")||code.includes("invalid")||code.includes("conflict")||code.includes("not_ready")?409:500;return{status,body:{error:status===500?"internal_error":code}};}
