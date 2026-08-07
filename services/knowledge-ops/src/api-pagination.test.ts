import {createHash,randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {KnowledgeOpsApi} from "./api.js";
import {ContentCipher} from "./crypto.js";
import {StaticTokenAuthorizer} from "./rbac.js";
import {KnowledgeOpsService} from "./service.js";
import {InMemoryKnowledgeOpsStore} from "./store.js";

describe("知识运营分页接口",()=>{
  it("返回当前页、筛选总数并拒绝越界参数",async()=>{
    const token="pagination-service-token",store=new InMemoryKnowledgeOpsStore(),service=new KnowledgeOpsService(store,new ContentCipher(randomBytes(32))),api=new KnowledgeOpsApi(service,new StaticTokenAuthorizer([{tokenHash:createHash("sha256").update(token).digest("hex"),actor:{actorId:"admin",roles:["admin"]}}])),authorization=`Bearer ${token}`,timestamp="2026-08-07T03:00:00.000Z";
    for(const [index,classification] of ["useful","incorrect"].entries())await service.ingestFeedback({actorId:"lunkr",roles:["service"]},{caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:String(index+1).repeat(64),questionId:index+1,classification:classification as "useful"|"incorrect",comment:"",question:`问题 ${index}`,answer:"回答",answerStatus:"answered",referenceCount:0,answeredAt:timestamp,submittedAt:timestamp,source:"lunkr_direct"});
    await expect(api.handle({method:"GET",path:"/v1/feedback?limit=1&offset=1",authorization})).resolves.toMatchObject({status:200,body:{total:2,items:[{caseId:expect.any(String)}]}});
    await expect(api.handle({method:"GET",path:"/v1/feedback?actionable=true",authorization})).resolves.toMatchObject({status:200,body:{total:1,items:[{classification:"incorrect"}]}});
    await expect(api.handle({method:"GET",path:"/v1/releases?limit=25&offset=0",authorization})).resolves.toEqual({status:200,body:{items:[],total:0}});
    expect((await api.handle({method:"GET",path:"/v1/audit?limit=101&offset=0",authorization})).status).toBe(400);
  });
});
