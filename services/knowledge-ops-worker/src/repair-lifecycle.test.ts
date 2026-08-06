import { createHash,randomBytes,randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import type { ModelClient } from "@pseagent/app/embedded";
import type { AnswerReviewResult } from "@pseagent/knowledge-governance-contracts";
import { ContentCipher,InMemoryKnowledgeOpsStore,KnowledgeOpsService } from "@pseagent/knowledge-ops";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";
import { KnowledgeRepairAgent } from "./repair-agent.js";
import { SafeGitWorkspace } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { KnowledgeOpsWorker } from "./worker.js";

const temporary:string[]=[];afterEach(async()=>{for(const item of temporary.splice(0))await rm(item,{recursive:true,force:true});});

describe("knowledge repair lifecycle",()=>{
  it("validates in isolation, publishes an active snapshot, resolves sources and rolls back",async()=>{
    const fixture=await setup(true),base=git(fixture.professional,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!;expect(draft.status).toBe("draft_ready");
    const validationRequest=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(validationRequest.validation.validationId)).toMatchObject({status:"passed",totalCases:5,passedCases:5});expect(await fixture.store.getRepairDraft(draft.draftId)).toMatchObject({status:"ready_to_publish"});expect(git(fixture.professional,"rev-parse","HEAD").trim()).toBe(base);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");
    const publishRequest=await fixture.service.requestRepairPublication(fixture.admin,draft.draftId);await fixture.worker.runOnce();const publication=await fixture.store.getRepairPublication(publishRequest.publication.publicationId);expect(publication).toMatchObject({status:"published",remoteSyncStatus:"synced",remoteName:"origin",remoteBranch:"main",resultingGitRevision:expect.stringMatching(/^[a-f0-9]{40}$/u),catalogHash:expect.stringMatching(/^[a-f0-9]{64}$/u),snapshotReleaseId:expect.stringMatching(/^KR-/u),previousReleaseId:expect.stringMatching(/^KR-/u)});expect(await fixture.store.getRepairBatch(publishRequest.batch.batchId)).toMatchObject({status:"published",itemCount:1});expect(git(fixture.professional,"rev-parse","HEAD").trim()).not.toBe(base);expect(git(fixture.professionalRemote,"rev-parse","refs/heads/main").trim()).toBe(publication?.resultingGitRevision);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain(candidate.answerTemplate);expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"resolved"});expect((await fixture.store.listFeedback())[0]).toMatchObject({status:"resolved"});expect((await fixture.snapshots.active())?.releaseId).toBe(publication?.snapshotReleaseId);
    await fixture.service.requestRepairRollback(fixture.admin,publication!.publicationId);await fixture.worker.runOnce();const rolledBackBatch=await fixture.store.getRepairBatch(publishRequest.batch.batchId);expect(rolledBackBatch).toMatchObject({status:"rolled_back",deploymentStage:"rolled_back",servingPreviousVersion:false});expect(await fixture.store.getRepairPublication(publication!.publicationId)).toMatchObject({status:"rolled_back",remoteSyncStatus:"compensated"});expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");expect(git(fixture.professionalRemote,"show","refs/heads/main:wiki/queries/迁移设置.md")).toContain("旧答案");expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"open"});expect((await fixture.store.listFeedback())[0]).toMatchObject({status:"in_review"});expect((await fixture.snapshots.active())?.releaseId).toBe(rolledBackBatch?.snapshotReleaseId);expect(rolledBackBatch?.snapshotReleaseId).not.toBe(publication?.snapshotReleaseId);
  },60_000);
  it("binds the current knowledge baseline when an administrator turns a blocked draft into a publishable answer card",async()=>{
    const fixture=await setup(true);await fixture.worker.runOnce();const generated=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,draftId=randomUUID(),createdAt=new Date().toISOString();await fixture.store.updateRepairDraft(generated.draftId,{status:"failed"});await fixture.store.createRepairDraft({draftId,issueId:fixture.issueId,status:"draft_ready",targetKind:"answer_card",targetDomain:"coremail-professional",targetPath:"wiki/queries/迁移设置.md",model:"deepseek_v4_flash",encryptedPayload:fixture.cipher.encrypt({proposal:generated.proposal}),createdBy:"admin",createdAt,updatedAt:createdAt});
    const request=await fixture.service.requestRepairValidation(fixture.admin,draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(request.validation.validationId)).toMatchObject({status:"passed",passedCases:5,totalCases:5});expect(await fixture.store.getRepairDraft(draftId)).toMatchObject({status:"ready_to_publish",baseGitRevision:expect.stringMatching(/^[a-f0-9]{40}$/u)});expect((await fixture.store.listAudit()).some((event)=>event.action==="repair.draft.baseline.bound"&&event.resourceId===draftId)).toBe(true);
  },60_000);
  it("returns a failed gate to editing without changing either knowledge repository",async()=>{const fixture=await setup(false),base=git(fixture.professional,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,request=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(request.validation.validationId)).toMatchObject({status:"failed",passedCases:4,totalCases:5});expect(await fixture.store.getRepairDraft(draft.draftId)).toMatchObject({status:"validation_failed"});expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"in_progress"});expect(git(fixture.professional,"rev-parse","HEAD").trim()).toBe(base);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");},60_000);
  it("blocks GitHub and the online switch when the real 4x5 quality gate fails",async()=>{const fixture=await setup(true,false),base=git(fixture.professional,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,validation=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(validation.validation.validationId)).toMatchObject({status:"passed"});const request=await fixture.service.requestRepairPublication(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairBatch(request.batch.batchId)).toMatchObject({status:"failed",deploymentStage:"failed",servingPreviousVersion:true,errorCode:"release_quality_gate_failed"});expect(git(fixture.professional,"rev-parse","HEAD").trim()).toBe(base);expect(git(fixture.professionalRemote,"rev-parse","refs/heads/main").trim()).toBe(base);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");expect((await fixture.store.listRegressionRuns()).find((run)=>run.totalCases===20)).toMatchObject({status:"failed",passedCases:19});},60_000);
  it("returns a deterministic rule conflict before calling either validation model",async()=>{const fixture=await setup(true);await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,proposal=draft.proposal!;await fixture.service.saveRepairDraft(fixture.admin,draft.draftId,{...proposal,obligations:proposal.obligations.map((item)=>item.id==="O1"?{...item,forbiddenClaims:["客户端专用密码"]}:item)});const callsBefore=fixture.modelCalls.length,request=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(fixture.modelCalls).toHaveLength(callsBefore);expect(await fixture.store.getRepairValidation(request.validation.validationId)).toMatchObject({status:"failed",passedCases:0,totalCases:5});const view=(await fixture.service.listRepairValidations(fixture.admin,draft.draftId))[0]!,result=view.result!;expect(result.outcome).toBe("rule_conflict");expect(result.ruleConflicts).toEqual(expect.arrayContaining([expect.objectContaining({code:"required_forbidden_conflict",obligationId:"O1"})]));expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({stage:"rule_conflict",obligationId:"O1",suggestedAction:"modify_rule"})]));},60_000);
  it("rejects an abstract required concept before model review and returns the exact rule",async()=>{const fixture=await setup(true);await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,proposal=draft.proposal!;await fixture.service.saveRepairDraft(fixture.admin,draft.draftId,{...proposal,obligations:proposal.obligations.map((item)=>item.id==="O1"?{...item,requiredConcepts:[...item.requiredConcepts,"迁移前置核心功能"]}:item)});const callsBefore=fixture.modelCalls.length,request=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(fixture.modelCalls).toHaveLength(callsBefore);const view=(await fixture.service.listRepairValidations(fixture.admin,draft.draftId))[0]!,result=view.result!;expect(result).toMatchObject({outcome:"rule_conflict",ruleConflicts:[expect.objectContaining({code:"unverifiable_required_concept",obligationId:"O1",field:"requiredConcepts",triggerText:"迁移前置核心功能"})],diagnostics:[expect.objectContaining({stage:"rule_conflict",obligationId:"O1",field:"requiredConcepts",rule:"迁移前置核心功能",message:expect.stringContaining("抽象或集合标签"),suggestedAction:"modify_rule"})]});expect(await fixture.store.getRepairValidation(request.validation.validationId)).toMatchObject({status:"failed",passedCases:0,totalCases:5});},60_000);
  it("reuses an unchanged failed validation instead of sampling the models again",async()=>{const fixture=await setup(false);await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,first=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(first.validation.validationId)).toMatchObject({status:"failed",passedCases:4});const callsBefore=fixture.modelCalls.length,second=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(fixture.modelCalls).toHaveLength(callsBefore);const view=(await fixture.service.listRepairValidations(fixture.admin,draft.draftId))[0]!;expect(view).toMatchObject({validationId:second.validation.validationId,status:"failed",passedCases:4,result:{reused:true,reusedFromValidationId:first.validation.validationId}});},60_000);
  it("combines two validated repairs in one repository commit and one remote push",async()=>{const fixture=await setup(true),base=git(fixture.professional,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const first=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,validation=await fixture.service.requestRepairValidation(fixture.admin,first.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(validation.validation.validationId)).toMatchObject({status:"passed"});const now=new Date().toISOString(),secondCardHash=createHash("sha256").update("PRO-MIGRATION-SECOND").digest("hex");await fixture.service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:"b".repeat(64),questionId:2,classification:"missing",comment:"缺少第二项",question:"迁移后如何核验？",answer:"旧的核验答案",answerStatus:"answered",scope:"professional",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[secondCardHash]}});const secondIssue=(await fixture.service.listIssues(fixture.admin,{limit:10,offset:0})).items.find((item)=>item.issueId!==fixture.issueId)!,secondDraftId=randomUUID();await fixture.store.createRepairDraft({draftId:secondDraftId,issueId:secondIssue.issueId,status:"ready_to_publish",targetKind:"answer_card",targetDomain:"coremail-professional",targetPath:"wiki/queries/迁移核验.md",baseGitRevision:base,model:"deepseek_v4_flash",encryptedPayload:fixture.cipher.encrypt({proposal:candidate2}),createdBy:"admin",createdAt:now,updatedAt:now});await fixture.store.createRepairValidation({validationId:randomUUID(),draftId:secondDraftId,issueId:secondIssue.issueId,status:"passed",totalCases:5,passedCases:5,model:"deepseek_v4_flash",encryptedPayload:fixture.cipher.encrypt({result:{passed:true}}),createdAt:now,completedAt:now});const request=await fixture.service.requestRepairBatch(fixture.admin,[first.draftId,secondDraftId]);await fixture.worker.runOnce();const batch=await fixture.store.getRepairBatch(request.batch.batchId);expect(batch).toMatchObject({status:"published",itemCount:2,publications:[{status:"published",remoteSyncStatus:"synced"},{status:"published",remoteSyncStatus:"synced"}]});expect(new Set(batch?.publications.map((item)=>item.resultingGitRevision)).size).toBe(1);expect(Number(git(fixture.professional,"rev-list","--count",`${base}..HEAD`).trim())).toBe(1);expect(git(fixture.professionalRemote,"rev-parse","refs/heads/main").trim()).toBe(git(fixture.professional,"rev-parse","HEAD").trim());expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain(candidate.answerTemplate);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移核验.md"),"utf8")).toContain(candidate2.answerTemplate);},60_000);
  it("compensates the first remote when a later knowledge repository push fails",async()=>{const fixture=await setup(true),professionalBase=git(fixture.professional,"rev-parse","HEAD").trim(),generalBase=git(fixture.general,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const first=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,validation=await fixture.service.requestRepairValidation(fixture.admin,first.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(validation.validation.validationId)).toMatchObject({status:"passed"});const now=new Date().toISOString(),cardHash=createHash("sha256").update("GEN-COMMUNICATION-TEST").digest("hex");await fixture.service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:"c".repeat(64),questionId:3,classification:"missing",comment:"缺少范围说明",question:"售前沟通先确认什么？",answer:"先确认客户目标。",answerStatus:"answered",scope:"general",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[cardHash]}});const secondIssue=(await fixture.service.listIssues(fixture.admin,{limit:10,offset:0})).items.find((item)=>item.issueId!==fixture.issueId)!,secondDraftId=randomUUID();await fixture.store.createRepairDraft({draftId:secondDraftId,issueId:secondIssue.issueId,status:"ready_to_publish",targetKind:"answer_card",targetDomain:"presales-general",targetPath:"wiki/queries/沟通.md",baseGitRevision:generalBase,model:"deepseek_v4_flash",encryptedPayload:fixture.cipher.encrypt({proposal:generalCandidate}),createdBy:"admin",createdAt:now,updatedAt:now});await fixture.store.createRepairValidation({validationId:randomUUID(),draftId:secondDraftId,issueId:secondIssue.issueId,status:"passed",totalCases:5,passedCases:5,model:"deepseek_v4_flash",encryptedPayload:fixture.cipher.encrypt({result:{passed:true}}),createdAt:now,completedAt:now});git(fixture.general,"remote","remove","origin");const request=await fixture.service.requestRepairBatch(fixture.admin,[first.draftId,secondDraftId]);await fixture.worker.runOnce();const batch=await fixture.store.getRepairBatch(request.batch.batchId);expect(batch).toMatchObject({status:"failed",publications:[{targetDomain:"coremail-professional",status:"failed",remoteSyncStatus:"compensated"},{targetDomain:"presales-general",status:"failed",remoteSyncStatus:"failed"}]});expect(git(fixture.professionalRemote,"show","refs/heads/main:wiki/queries/迁移设置.md")).toContain("旧答案");expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");expect(await readFile(path.join(fixture.general,"wiki","queries","沟通.md"),"utf8")).toContain("先确认客户目标。");expect(git(fixture.professional,"rev-parse","HEAD").trim()).not.toBe(professionalBase);expect(git(fixture.general,"rev-parse","HEAD").trim()).not.toBe(generalBase);expect(await fixture.store.getRepairDraft(first.draftId)).toMatchObject({status:"validation_failed"});expect(await fixture.store.getRepairDraft(secondDraftId)).toMatchObject({status:"validation_failed"});expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"in_progress"});expect(await fixture.store.getIssue(secondIssue.issueId)).toMatchObject({status:"in_progress"});},60_000);
});

async function setup(allAssessmentsPass:boolean,qualityGatePass=true){
  const root=await mkdtemp(path.join(tmpdir(),"pse-repair-life-")),professional=path.join(root,"professional"),general=path.join(root,"general"),professionalRemote=path.join(root,"professional.git"),generalRemote=path.join(root,"general.git"),worktrees=path.join(root,"worktrees"),snapshots=new SnapshotManager(path.join(root,"snapshots"));temporary.push(root);await initializeKnowledgeRepo(professional,professionalRemote,true);await initializeKnowledgeRepo(general,generalRemote,false);
  const store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),service=new KnowledgeOpsService(store,cipher),admin={actorId:"admin",roles:["admin"] as const},now=new Date().toISOString(),requestId=randomUUID(),cardHash=createHash("sha256").update("PRO-MIGRATION-TEST").digest("hex");await service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId,pseudonymousUserId:"a".repeat(64),userDisplayName:"测试用户",questionId:1,classification:"missing",comment:"缺少认证准备",question:"迁移前需要准备什么？",answer:"旧答案",answerStatus:"answered",scope:"professional",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[cardHash]}});const issue=(await service.listIssues(admin,{limit:10,offset:0})).items[0]!;await service.requestRepairDraft(admin,issue.issueId);
  const modelCalls:string[]=[],model=scriptedModel(allAssessmentsPass,modelCalls),runtimeController={health:async()=>runtimeHealth(),reload:async()=>runtimeHealth(),assertAligned:async()=>runtimeHealth()},releaseQualityRunner={run:async()=>qualityReport(qualityGatePass)},worker=new KnowledgeOpsWorker("repair-lifecycle",{store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],snapshots,git:new SafeGitWorkspace([professional,general],worktrees),cipher,repairAgent:new KnowledgeRepairAgent(model),answerReviewer:new IndependentAnswerReviewer(model),answerContractRevision:"c".repeat(40),runtimeController,releaseQualityRunner});return{root,professional,general,professionalRemote,generalRemote,store,cipher,service,admin,worker,snapshots,issueId:issue.issueId,modelCalls};
}

async function initializeKnowledgeRepo(root:string,remote:string,professional:boolean){await mkdir(remote,{recursive:true});git(remote,"init","--bare");await mkdir(path.join(root,"wiki","queries"),{recursive:true});if(professional){await mkdir(path.join(root,"wiki","concepts"),{recursive:true});await writeFile(path.join(root,"wiki","concepts","迁移证据.md"),"# 迁移证据\n\n正式资料要求生成客户端专用密码并启用 IMAP。\n");await writeFile(path.join(root,"wiki","queries","迁移设置.md"),`---
type: query
title: 迁移设置
created: 2026-01-01
card_schema_version: 1
card_id: PRO-MIGRATION-TEST
canonical_question: "迁移前需要准备什么？"
question_family: migration_test
aliases: ["迁移要准备什么？"]
applicable_product: 邮件系统
applicable_version: "*"
applicable_scenarios: [迁移]
exclude_when: []
obligations:
  - id: O1
    label: 说明认证准备
    required: true
    domains: [coremail-professional]
    evidence_policy: direct
    required_concepts: [客户端专用密码, IMAP]
    forbidden_claims: [普通密码一定可以直接迁移]
    preferred_evidence_paths: [wiki/concepts/迁移证据.md]
owner: PSE知识运营
reviewers: [管理员]
review_status: approved
regression_case_ids: []
---
# 迁移设置

旧答案
`);await writeFile(path.join(root,"wiki","queries","迁移核验.md"),`---
type: query
title: 迁移核验
created: 2026-01-01
card_schema_version: 1
card_id: PRO-MIGRATION-SECOND
canonical_question: "迁移后如何核验？"
question_family: migration_verify
aliases: ["迁移完成怎么检查？"]
applicable_product: 邮件系统
applicable_version: "*"
applicable_scenarios: [迁移]
exclude_when: []
obligations:
  - id: O1
    label: 说明核验方法
    required: true
    domains: [coremail-professional]
    evidence_policy: direct
    required_concepts: [IMAP]
    forbidden_claims: []
    preferred_evidence_paths: [wiki/concepts/迁移证据.md]
owner: PSE知识运营
reviewers: [管理员]
review_status: approved
regression_case_ids: []
---
# 迁移核验

旧的核验答案
`);}else{await mkdir(path.join(root,"wiki","concepts"),{recursive:true});await writeFile(path.join(root,"wiki","concepts","沟通证据.md"),"# 沟通证据\n\n售前沟通应先确认客户目标和范围。\n");await writeFile(path.join(root,"wiki","queries","沟通.md"),`---
type: query
title: 售前沟通
created: 2026-01-01
card_schema_version: 1
card_id: GEN-COMMUNICATION-TEST
canonical_question: "售前沟通先确认什么？"
question_family: communication_test
aliases: ["跟客户聊之前问什么？"]
applicable_product: 邮件系统
applicable_version: "*"
applicable_scenarios: [售前沟通]
exclude_when: []
obligations:
  - id: O1
    label: 确认目标
    required: true
    domains: [presales-general]
    evidence_policy: direct
    required_concepts: [客户目标, 范围]
    forbidden_claims: []
    preferred_evidence_paths: [wiki/concepts/沟通证据.md]
owner: PSE知识运营
reviewers: [管理员]
review_status: approved
regression_case_ids: []
---
# 售前沟通

先确认客户目标。
`);}git(root,"init");git(root,"config","user.email","test@example.invalid");git(root,"config","user.name","Test");git(root,"add",".");git(root,"commit","-m","初始知识");git(root,"branch","-M","main");git(root,"remote","add","origin",remote);git(root,"push","-u","origin","main");}

function scriptedModel(allAssessmentsPass:boolean,calls:string[]=[]):ModelClient{return{completeJson:async<T>(input:Parameters<ModelClient["completeJson"]>[0])=>{calls.push(input.schemaDescription);if(input.schemaDescription.startsWith("knowledge repair draft"))return candidate as T;if(input.schemaDescription.startsWith("five knowledge repair"))return{cases:candidate.regressionQuestions.map((item)=>({kind:item.kind,passed:true,explanation:"通过"}))} as T;if(input.schemaDescription.startsWith("answer review result")){const payload=JSON.parse(input.messages[1]?.content??"{}") as{question?:string};if(!allAssessmentsPass&&payload.question?.includes("那密码"))return{...reviewPass,verdict:"needs_review",score:60,summary:"追问缺少上下文承接",defects:[{category:"coverage_gap",severity:"major",summary:"追问缺少上下文承接",evidence:"O1"}],obligationChecks:[{obligationId:"O1",covered:false,explanation:"追问缺少上下文承接"}]} as T;return reviewPass as T;}throw new Error("unexpected_model_schema");},completeText:async()=>""};}
function git(root:string,...args:string[]){return execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true});}

const reviewPass:AnswerReviewResult={verdict:"pass",score:95,summary:"正式证据支持且必答项完整",defects:[],obligationChecks:[{obligationId:"O1",covered:true,explanation:"已覆盖"}]};
function runtimeHealth(){return{status:"ready" as const,projects:[{project:"coremail-professional" as const,revision:"a".repeat(40),lexicalStatus:"ready",graphStatus:"ready"},{project:"presales-general" as const,revision:"b".repeat(40),lexicalStatus:"ready",graphStatus:"ready"}],deployment:{status:"ready" as const,servingPreviousVersion:false,releaseId:null,professionalRevision:null,generalRevision:null,errorCode:null}};}
function qualityReport(passed=true){const kinds=["canonical","alias","typo","follow_up","negative"];return{schemaVersion:1 as const,generatedAt:new Date().toISOString(),model:"deepseek_v4_flash" as const,passed,summary:{total:20 as const,completed:20,passedCases:passed?20:19,averageScore:passed?1:.98,p95LatencyMs:10,safetyFailures:0,availabilityFailures:0},suites:Array.from({length:4},(_,index)=>({suiteId:`suite-${index+1}`,passed:passed||index>0,passedCases:passed||index>0?5:4,averageScore:passed||index>0?1:.9})),kinds:kinds.map((kind,index)=>({kind,passed:passed||index>0,passedCases:passed||index>0?4:3,averageScore:passed||index>0?1:.9})),consistencyChecks:[],cases:Array.from({length:20},(_,index)=>({caseId:`case-${index+1}`,passed:passed||index>0}))};}
const candidate={title:"迁移设置",canonicalQuestion:"迁移前需要准备什么？",aliases:["迁移要准备什么？"],answerTemplate:"迁移前需要生成客户端专用密码并启用 IMAP；普通登录密码不能直接视为可迁移密码。",obligations:[{id:"O1",label:"说明认证准备",evidencePolicy:"direct" as const,requiredConcepts:["客户端专用密码","IMAP"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/迁移证据.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"迁移前需要准备什么？"},{kind:"alias" as const,question:"迁移要准备什么？"},{kind:"colloquial" as const,question:"搬邮箱之前得整啥？"},{kind:"follow_up" as const,question:"那密码这块呢？"},{kind:"negative" as const,question:"客户只谈价格时怎么办？"}],generationSummary:"补齐迁移认证准备。",publishable:true};
const candidate2={title:"迁移核验",canonicalQuestion:"迁移后如何核验？",aliases:["迁移完成怎么检查？"],answerTemplate:"迁移后应核验 IMAP 收取结果并抽查账号状态。",obligations:[{id:"O1",label:"说明核验方法",evidencePolicy:"direct" as const,requiredConcepts:["IMAP"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/迁移证据.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"迁移后如何核验？"},{kind:"alias" as const,question:"迁移完成怎么检查？"},{kind:"colloquial" as const,question:"搬完怎么验？"},{kind:"follow_up" as const,question:"那账号呢？"},{kind:"negative" as const,question:"客户只谈价格时怎么办？"}],generationSummary:"补齐迁移后核验方法。",publishable:true,rootCause:"user_missing" as const,targetKind:"answer_card" as const,targetDomain:"coremail-professional" as const,targetPath:"wiki/queries/迁移核验.md",cardId:"PRO-MIGRATION-SECOND"};
const generalCandidate={title:"售前沟通",canonicalQuestion:"售前沟通先确认什么？",aliases:["跟客户聊之前问什么？"],answerTemplate:"售前沟通应先确认客户目标和范围，再讨论方案。",obligations:[{id:"O1",label:"确认目标",evidencePolicy:"direct" as const,requiredConcepts:["客户目标","范围"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/沟通证据.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"售前沟通先确认什么？"},{kind:"alias" as const,question:"跟客户聊之前问什么？"},{kind:"colloquial" as const,question:"开聊前先问啥？"},{kind:"follow_up" as const,question:"那范围呢？"},{kind:"negative" as const,question:"迁移密码是什么？"}],generationSummary:"补齐售前沟通范围。",publishable:true,rootCause:"user_missing" as const,targetKind:"answer_card" as const,targetDomain:"presales-general" as const,targetPath:"wiki/queries/沟通.md",cardId:"GEN-COMMUNICATION-TEST"};
