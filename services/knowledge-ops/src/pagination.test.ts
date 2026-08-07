import {randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {ContentCipher} from "./crypto.js";
import {KnowledgeOpsService} from "./service.js";
import {InMemoryKnowledgeOpsStore} from "./store.js";
import type {AuditEvent,KnowledgeRepairDraft,RegressionRun,ReleaseRecord,RepairBatch,RepairPublication} from "./types.js";

describe("知识运营长列表分页",()=>{
  it("分页并在服务端筛选原始记录元数据",async()=>{
    const store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),service=new KnowledgeOpsService(store,cipher),serviceActor={actorId:"lunkr",roles:["service"] as const},admin={actorId:"admin",roles:["admin"] as const},timestamp="2026-08-07T01:00:00.000Z";
    const reviewIds:string[]=[];
    for(let index=0;index<3;index+=1){const reviewId=randomUUID();reviewIds.push(reviewId);await service.ingestAnswerReview(serviceActor,{reviewId,requestId:randomUUID(),pseudonymousUserId:String(index+1).repeat(64),questionId:index+1,question:`复查问题 ${index+1}`,answer:"回答",answerStatus:"answered",references:[],answeredAt:timestamp,submittedAt:timestamp,source:"lunkr_direct"});}
    await store.updateAnswerReviewMachine(reviewIds[0]!,{verdict:"needs_review"});
    await store.updateAnswerReviewMachine(reviewIds[1]!,{verdict:"pass"});
    await store.updateAnswerReviewMachine(reviewIds[2]!,{verdict:"pass",workflowStatus:"in_review"});
    expect(await service.listAnswerReviews(admin,{limit:1,offset:1})).toMatchObject({total:3,items:[{reviewId:expect.any(String)}]});
    expect(await service.listAnswerReviews(admin,{limit:25,offset:0,actionableOnly:true})).toMatchObject({total:2,items:[{workflowStatus:expect.any(String)},{workflowStatus:expect.any(String)}]});
    expect(await service.listAnswerReviews(admin,{limit:25,offset:0,verdict:"needs_review"})).toMatchObject({total:1,items:[{reviewId:reviewIds[0]}]});

    const feedbackIds:string[]=[];
    for(const [index,classification] of ["useful","missing","incorrect"].entries()){const caseId=randomUUID();feedbackIds.push(caseId);await service.ingestFeedback(serviceActor,{caseId,requestId:randomUUID(),pseudonymousUserId:String(index+4).repeat(64),questionId:index+10,classification:classification as "useful"|"missing"|"incorrect",comment:"",question:`反馈问题 ${index+1}`,answer:"回答",answerStatus:"answered",referenceCount:0,answeredAt:timestamp,submittedAt:timestamp,source:"lunkr_direct"});}
    await store.updateFeedback(feedbackIds[1]!,{status:"resolved"});
    expect(await service.listFeedback(admin,{limit:1,offset:1})).toMatchObject({total:3,items:[{caseId:expect.any(String)}]});
    expect(await service.listFeedback(admin,{limit:25,offset:0,actionableOnly:true})).toMatchObject({total:1,items:[{caseId:feedbackIds[2]}]});
    expect(await service.listFeedback(admin,{limit:25,offset:0,status:"resolved"})).toMatchObject({total:1,items:[{caseId:feedbackIds[1]}]});
  });

  it("为待发布、回归、发布和审计历史返回当前页与总数",async()=>{
    const store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),admin={actorId:"admin",roles:["admin"] as const},timestamp="2026-08-07T02:00:00.000Z",drafts:KnowledgeRepairDraft[]=[];
    for(let index=0;index<3;index+=1){const issue=await store.recordIssue({fingerprint:String(index).repeat(64),title:`问题 ${index}`,priority:"p2",category:"knowledge_gap",occurredAt:timestamp,occurrence:{sourceType:"feedback",sourceId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:String(index+1).repeat(64)}}),draft:KnowledgeRepairDraft={draftId:randomUUID(),issueId:issue.issueId,status:"ready_to_publish",targetKind:"knowledge_page",targetDomain:"coremail-professional",targetPath:`wiki/queries/分页${index}.md`,baseGitRevision:"a".repeat(40),model:"deepseek_v4_flash",encryptedPayload:cipher.encrypt({}),createdBy:admin.actorId,createdAt:timestamp,updatedAt:timestamp};drafts.push(await store.createRepairDraft(draft));}
    expect(await store.listRepairDraftPageByStatus("ready_to_publish",{limit:1,offset:1})).toMatchObject({total:3,items:[{draftId:expect.any(String)}]});
    for(const draft of drafts){const batchId=randomUUID(),batch:RepairBatch={batchId,status:"queued",deploymentStage:"queued",servingPreviousVersion:true,itemCount:1,domains:["coremail-professional"],createdBy:admin.actorId,createdAt:timestamp},publication:RepairPublication={publicationId:randomUUID(),batchId,draftId:draft.draftId,issueId:draft.issueId,status:"pending",targetDomain:"coremail-professional",targetPath:draft.targetPath!,baseGitRevision:draft.baseGitRevision!,remoteSyncStatus:"pending",createdBy:admin.actorId,createdAt:timestamp};await store.createRepairBatch(batch,[publication]);}
    expect(await store.listRepairBatchPage({limit:1,offset:1})).toMatchObject({total:3,items:[{batchId:expect.any(String)}]});

    for(let index=0;index<3;index+=1){const run:RegressionRun={runId:randomUUID(),status:"passed",totalCases:20,passedCases:20,createdAt:timestamp,completedAt:timestamp};await store.createRegressionRun(run);const release:ReleaseRecord={releaseId:`KR-PAGE-${index}`,professionalRevision:"a".repeat(40),generalRevision:"b".repeat(40),answerContractRevision:"c".repeat(40),cardCatalogHash:"d".repeat(64),regressionRunId:run.runId,manifest:{},status:"pending",createdBy:admin.actorId,approvedBy:[admin.actorId],createdAt:timestamp};await store.createRelease(release);const audit:AuditEvent={auditId:randomUUID(),actorId:admin.actorId,action:"page.test",resourceType:"test",resourceId:String(index),metadata:{},createdAt:timestamp};await store.appendAudit(audit);}
    expect(await store.listRegressionRunPage({limit:1,offset:1})).toMatchObject({total:3,items:[{runId:expect.any(String)}]});
    expect(await store.listReleasePage({limit:1,offset:1})).toMatchObject({total:3,items:[{releaseId:expect.any(String)}]});
    expect(await store.listAuditPage({limit:1,offset:1})).toMatchObject({total:3,items:[{auditId:expect.any(String)}]});
  });
});
