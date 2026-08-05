import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterAll,describe,expect,it,vi } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelClient } from "@pseagent/app/embedded";
import { ContentCipher,InMemoryKnowledgeOpsStore,KnowledgeOpsService } from "@pseagent/knowledge-ops";
import { KnowledgeRepairAgent } from "./repair-agent.js";
import { SafeGitWorkspace } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { KnowledgeOpsWorker } from "./worker.js";

const temporary:string[]=[];afterAll(async()=>{await Promise.all(temporary.map((item)=>rm(item,{recursive:true,force:true})));});

describe("repair draft worker",()=>{
  it("loads linked records and fixed-revision evidence, then stores only an encrypted draft",async()=>{
    const workspace=path.resolve(import.meta.dirname,"../../../.."),professional=path.join(workspace,"coremail-professional"),general=path.join(workspace,"presales-general"),store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),service=new KnowledgeOpsService(store,cipher),now=new Date().toISOString();
    const cardId="PRO-TENCENT-MIGRATION-PREREQUISITES",cardHash=createHash("sha256").update(cardId).digest("hex");
    await service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:"a".repeat(64),userDisplayName:"Wayne 黎政良",questionId:1,classification:"missing",comment:"缺少前置权限",question:"腾讯企业邮箱迁移到Coremail前需要哪些设置？",answer:"只要打开收取全部邮件。",answerStatus:"answered",scope:"professional",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[cardHash]}});
    const issue=(await service.listIssues({actorId:"admin",roles:["admin"]},{limit:10,offset:0})).items[0]!,request=await service.requestRepairDraft({actorId:"admin",roles:["admin"]},issue.issueId),root=await mkdtemp(path.join(tmpdir(),"pse-repair-worker-"));temporary.push(root);
    const completeJson=vi.fn(async()=>candidate),model:ModelClient={completeJson:completeJson as ModelClient["completeJson"],completeText:async()=>""};
    const worker=new KnowledgeOpsWorker("repair-worker",{store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],snapshots:new SnapshotManager(path.join(root,"snapshots")),git:new SafeGitWorkspace([professional,general],path.join(root,"worktrees")),cipher,repairAgent:new KnowledgeRepairAgent(model)});
    expect(await worker.runOnce()).toBe(true);const stored=await store.getRepairDraft(request.draft.draftId);expect(stored).toMatchObject({status:"draft_ready",targetKind:"answer_card",targetDomain:"coremail-professional",targetPath:"wiki/queries/腾讯企业邮箱迁移到Coremail前需要哪些设置.md",baseGitRevision:expect.stringMatching(/^[a-f0-9]{40}$/u)});expect(JSON.stringify(stored)).not.toContain("客户端专用密码");
    const decrypted=cipher.decrypt<{proposal:{publishable:boolean;answerTemplate:string};evidenceIssues:readonly string[]}>(stored!.encryptedPayload);expect(decrypted.proposal).toMatchObject({publishable:true,answerTemplate:candidate.answerTemplate});expect(decrypted.evidenceIssues).toEqual([]);expect(JSON.stringify(completeJson.mock.calls)).not.toContain("Wayne 黎政良");expect((await store.listJobs())[0]).toMatchObject({type:"generate_repair_draft",status:"completed"});expect((await store.listAudit()).some((event)=>event.action==="repair.draft.generated")).toBe(true);
  },30_000);
  it("marks a failed model generation recoverable instead of leaving the issue stuck",async()=>{
    const workspace=path.resolve(import.meta.dirname,"../../../.."),professional=path.join(workspace,"coremail-professional"),general=path.join(workspace,"presales-general"),store=new InMemoryKnowledgeOpsStore(),cipher=new ContentCipher(randomBytes(32)),service=new KnowledgeOpsService(store,cipher),now=new Date().toISOString(),cardHash=createHash("sha256").update("PRO-TENCENT-MIGRATION-PREREQUISITES").digest("hex");
    await service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:"b".repeat(64),questionId:2,classification:"incorrect",comment:"",question:"腾讯企业邮箱迁移到Coremail前需要哪些设置？",answer:"错误答案",answerStatus:"answered",scope:"professional",referenceCount:1,answeredAt:now,submittedAt:now,source:"lunkr_direct",answerCardMatch:{cardIdHashes:[cardHash]}});
    const admin={actorId:"admin",roles:["admin"] as const},issue=(await service.listIssues(admin,{limit:10,offset:0})).items[0]!,request=await service.requestRepairDraft(admin,issue.issueId),root=await mkdtemp(path.join(tmpdir(),"pse-repair-worker-error-"));temporary.push(root);const unavailable:ModelClient={completeJson:async()=>{throw new Error("model_unavailable");},completeText:async()=>{throw new Error("model_unavailable");}};
    const worker=new KnowledgeOpsWorker("repair-worker",{store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],snapshots:new SnapshotManager(path.join(root,"snapshots")),git:new SafeGitWorkspace([professional,general],path.join(root,"worktrees")),cipher,repairAgent:new KnowledgeRepairAgent(unavailable)});expect(await worker.runOnce()).toBe(true);expect(await store.getRepairDraft(request.draft.draftId)).toMatchObject({status:"failed",errorCode:"model_unavailable"});expect((await store.listJobs())[0]).toMatchObject({status:"failed",errorCode:"model_unavailable"});expect((await service.requestRepairDraft(admin,issue.issueId)).enqueued).toBe(true);
  },30_000);
});

const candidate={title:"迁移前置修订",canonicalQuestion:"腾讯企业邮箱迁移到Coremail前需要哪些设置？",aliases:["腾讯企邮搬家前要开什么权限？"],answerTemplate:"迁移前应完成微信绑定并开启安全登录，生成客户端专用密码，启用 IMAP 和 SMTP，勾选收取文件夹并选择全部邮件；通讯录、日程、规则及界面版本边界需要另行核实。",obligations:[{id:"O1",label:"列出旧系统准备项",evidencePolicy:"direct" as const,requiredConcepts:["微信绑定","安全登录","客户端专用密码","IMAP","SMTP"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/腾讯企业邮箱迁移前置设置.md"]},{id:"O2",label:"说明覆盖范围和边界",evidencePolicy:"direct" as const,requiredConcepts:["收取文件夹","全部邮件","个人配置边界","版本边界"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/腾讯企业邮箱迁移前置设置.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"腾讯企业邮箱迁移到Coremail前需要哪些设置？"},{kind:"alias" as const,question:"腾讯企邮搬家前要开什么权限？"},{kind:"colloquial" as const,question:"企邮搬家前得先整啥？"},{kind:"follow_up" as const,question:"那通讯录也能一起迁吗？"},{kind:"negative" as const,question:"Exchange 密码如何承接？"}],generationSummary:"补齐迁移前置条件、作用和资料边界。",publishable:true};
