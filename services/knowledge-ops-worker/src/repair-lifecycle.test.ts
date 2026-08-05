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
    const publishRequest=await fixture.service.requestRepairPublication(fixture.admin,draft.draftId);await fixture.worker.runOnce();const publication=await fixture.store.getRepairPublication(publishRequest.publication.publicationId);expect(publication).toMatchObject({status:"published",resultingGitRevision:expect.stringMatching(/^[a-f0-9]{40}$/u),catalogHash:expect.stringMatching(/^[a-f0-9]{64}$/u),snapshotReleaseId:expect.stringMatching(/^KR-/u),previousReleaseId:expect.stringMatching(/^KR-/u)});expect(git(fixture.professional,"rev-parse","HEAD").trim()).not.toBe(base);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain(candidate.answerTemplate);expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"resolved"});expect((await fixture.store.listFeedback())[0]).toMatchObject({status:"resolved"});expect((await fixture.snapshots.active())?.releaseId).toBe(publication?.snapshotReleaseId);
    await fixture.service.requestRepairRollback(fixture.admin,publication!.publicationId);await fixture.worker.runOnce();expect(await fixture.store.getRepairPublication(publication!.publicationId)).toMatchObject({status:"rolled_back"});expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"open"});expect((await fixture.store.listFeedback())[0]).toMatchObject({status:"in_review"});expect((await fixture.snapshots.active())?.releaseId).toBe(publication?.previousReleaseId);
  },30_000);
  it("returns a failed gate to editing without changing either knowledge repository",async()=>{const fixture=await setup(false),base=git(fixture.professional,"rev-parse","HEAD").trim();await fixture.worker.runOnce();const draft=(await fixture.service.listRepairDrafts(fixture.admin,fixture.issueId))[0]!,request=await fixture.service.requestRepairValidation(fixture.admin,draft.draftId);await fixture.worker.runOnce();expect(await fixture.store.getRepairValidation(request.validation.validationId)).toMatchObject({status:"failed",passedCases:4,totalCases:5});expect(await fixture.store.getRepairDraft(draft.draftId)).toMatchObject({status:"validation_failed"});expect(await fixture.store.getIssue(fixture.issueId)).toMatchObject({status:"in_progress"});expect(git(fixture.professional,"rev-parse","HEAD").trim()).toBe(base);expect(await readFile(path.join(fixture.professional,"wiki","queries","迁移设置.md"),"utf8")).toContain("旧答案");},30_000);
});

async function setup(allAssessmentsPass:boolean){
  const root=await mkdtemp(path.join(tmpdir(),"pse-repair-life-")),professional=path.join(root,"professional"),general=path.join(root,"general"),worktrees=path.join(root,"worktrees"),snapshots=new SnapshotManager(path.join(root,"snapshots"));temporary.push(root);await initializeKnowledgeRepo(professional,true);await initializeKnowledgeRepo(general,false);
  const store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),service=new KnowledgeOpsService(store,cipher),admin={actorId:"admin",roles:["admin"] as const},now=new Date().toISOString(),requestId=randomUUID(),cardHash=createHash("sha256").update("PRO-MIGRATION-TEST").digest("hex");await service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId,pseudonymousUserId:"a".repeat(64),userDisplayName:"测试用户",questionId:1,classification:"missing",comment:"缺少认证准备",question:"迁移前需要准备什么？",answer:"旧答案",answerStatus:"answered",scope:"professional",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[cardHash]}});const issue=(await service.listIssues(admin,{limit:10,offset:0})).items[0]!;await service.requestRepairDraft(admin,issue.issueId);
  const model=scriptedModel(allAssessmentsPass),worker=new KnowledgeOpsWorker("repair-lifecycle",{store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],snapshots,git:new SafeGitWorkspace([professional,general],worktrees),cipher,repairAgent:new KnowledgeRepairAgent(model),answerReviewer:new IndependentAnswerReviewer(model),answerContractRevision:"c".repeat(40)});return{root,professional,general,store,cipher,service,admin,worker,snapshots,issueId:issue.issueId};
}

async function initializeKnowledgeRepo(root:string,professional:boolean){await mkdir(path.join(root,"wiki","queries"),{recursive:true});if(professional){await mkdir(path.join(root,"wiki","concepts"),{recursive:true});await writeFile(path.join(root,"wiki","concepts","迁移证据.md"),"# 迁移证据\n\n正式资料要求生成客户端专用密码并启用 IMAP。\n");await writeFile(path.join(root,"wiki","queries","迁移设置.md"),`---
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
`);}else await writeFile(path.join(root,"wiki","queries","沟通.md"),"# 沟通\n\n先确认客户目标。\n");git(root,"init");git(root,"config","user.email","test@example.invalid");git(root,"config","user.name","Test");git(root,"add",".");git(root,"commit","-m","初始知识");}

function scriptedModel(allAssessmentsPass:boolean):ModelClient{return{completeJson:async<T>(input:Parameters<ModelClient["completeJson"]>[0])=>{if(input.schemaDescription.startsWith("knowledge repair draft"))return candidate as T;if(input.schemaDescription.startsWith("five knowledge repair"))return{cases:candidate.regressionQuestions.map((item)=>({kind:item.kind,passed:allAssessmentsPass||item.kind!=="follow_up",explanation:allAssessmentsPass||item.kind!=="follow_up"?"通过":"追问缺少上下文承接"}))} as T;if(input.schemaDescription.startsWith("answer review result"))return reviewPass as T;throw new Error("unexpected_model_schema");},completeText:async()=>""};}
function git(root:string,...args:string[]){return execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true});}

const reviewPass:AnswerReviewResult={verdict:"pass",score:95,summary:"正式证据支持且必答项完整",defects:[],obligationChecks:[{obligationId:"O1",covered:true,explanation:"已覆盖"}]};
const candidate={title:"迁移设置",canonicalQuestion:"迁移前需要准备什么？",aliases:["迁移要准备什么？"],answerTemplate:"迁移前需要生成客户端专用密码并启用 IMAP；普通登录密码不能直接视为可迁移密码。",obligations:[{id:"O1",label:"说明认证准备",evidencePolicy:"direct" as const,requiredConcepts:["客户端专用密码","IMAP"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/迁移证据.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"迁移前需要准备什么？"},{kind:"alias" as const,question:"迁移要准备什么？"},{kind:"colloquial" as const,question:"搬邮箱之前得整啥？"},{kind:"follow_up" as const,question:"那密码这块呢？"},{kind:"negative" as const,question:"客户只谈价格时怎么办？"}],generationSummary:"补齐迁移认证准备。",publishable:true};
