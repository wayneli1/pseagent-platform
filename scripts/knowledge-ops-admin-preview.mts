import { createHash,randomBytes,randomUUID } from "node:crypto";
import path from "node:path";
import { ContentCipher,InMemoryKnowledgeOpsStore,KnowledgeOpsApi,KnowledgeOpsService,StaticTokenAuthorizer,createKnowledgeOpsHttpServer } from "../services/knowledge-ops/src/index.ts";

const token="local-preview-token-for-knowledge-ops";const store=new InMemoryKnowledgeOpsStore();const service=new KnowledgeOpsService(store,new ContentCipher(randomBytes(32)));
const now=new Date().toISOString();const serviceActor={actorId:"lunkr-preview",roles:["service"] as const};
for(const [classification,status,comment,index] of [["incorrect","new","版本边界说明不准确",1],["missing","triaged","没有回答归档数据迁移",2],["useful","resolved","回答完整，可直接使用",3],["evidence","in_review","需要补充原始资料链接",4]] as const){const item=await service.ingestFeedback(serviceActor,{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:String(index).repeat(64),questionId:index,classification,comment,question:`示例用户问题 ${index}`,answer:`这是用于视觉检查的示例回答 ${index}。`,answerStatus:"answered",scope:index%2?"coremail":"general",referenceCount:index,answeredAt:now,submittedAt:now,source:"lunkr_direct"});await store.updateFeedbackStatus(item.caseId,status);}
for(let index=1;index<=6;index++)await store.createCardRevision({revisionId:randomUUID(),cardId:`PRO-PREVIEW-${index}`,domain:index%2?"coremail-professional":"presales-general",revision:1,status:index<5?"approved":"in_review",content:{title:`示例答案卡 ${index}`,canonicalQuestion:`示例问题 ${index}`},createdBy:index<5?"knowledge-editor":"pending-editor",baseGitRevision:String(index).repeat(40),createdAt:now,updatedAt:now});
await store.enqueueJob("regression_run",{suite:"all"});const running=await store.enqueueJob("compile_catalog",{});await store.claimJob("preview-worker");await store.completeJob(running.jobId,{ok:true}).catch(()=>undefined);
await store.appendAudit({auditId:randomUUID(),actorId:"knowledge-editor",action:"card.revision.create",resourceType:"card_revision",resourceId:randomUUID(),metadata:{domain:"coremail-professional"},createdAt:now});
const authorizer=new StaticTokenAuthorizer([{tokenHash:createHash("sha256").update(token).digest("hex"),actor:{actorId:"preview-admin",roles:["admin"]}}]);
const server=createKnowledgeOpsHttpServer(new KnowledgeOpsApi(service,authorizer),{staticRoot:path.resolve(import.meta.dirname,"../apps/knowledge-ops-admin/dist")});
server.listen(19832,"127.0.0.1",()=>process.stdout.write(`preview.ready http://127.0.0.1:19832 token=${token}\n`));
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>server.close());
