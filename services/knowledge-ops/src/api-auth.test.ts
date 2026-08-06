import {createHash,randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {KnowledgeOpsApi} from "./api.js";
import {ContentCipher} from "./crypto.js";
import {createAdminPasswordHash,KnowledgeOpsAuthorizer,StaticTokenAuthorizer} from "./rbac.js";
import {KnowledgeOpsService} from "./service.js";
import {InMemoryKnowledgeOpsStore} from "./store.js";

describe("knowledge ops administrator login",()=>{
  it("accepts persistent conversation context only from the service role",async()=>{const token="conversation-service-token",store=new InMemoryKnowledgeOpsStore(),service=new KnowledgeOpsService(store,new ContentCipher(randomBytes(32)),()=>new Date("2026-08-06T03:00:00.000Z")),api=new KnowledgeOpsApi(service,new StaticTokenAuthorizer([{tokenHash:createHash("sha256").update(token).digest("hex"),actor:{actorId:"bridge",roles:["service"]}}])),authorization=`Bearer ${token}`,user="a".repeat(64),requestId=randomUUID();expect((await api.handle({method:"POST",path:"/v1/conversations/turns",authorization,body:{turnId:randomUUID(),requestId,pseudonymousUserId:user,questionId:1,rawQuestion:"第一问",resolvedQuestion:"完整第一问",contextUsed:false,inheritedSubjects:[],answerOutline:"1. 第一项",answerStatus:"answered",scope:"professional",answeredAt:"2026-08-06T03:00:00.000Z",expiresAt:"2026-08-07T03:00:00.000Z",source:"lunkr_direct"}})).status).toBe(201);expect(await api.handle({method:"POST",path:"/v1/conversations/context",authorization,body:{pseudonymousUserId:user,maxTurns:6}})).toMatchObject({status:200,body:{recentTurns:[{requestId,resolvedQuestion:"完整第一问"}]}});expect((await api.handle({method:"POST",path:"/v1/conversations/end",authorization,body:{pseudonymousUserId:user,reason:"manual",endedAt:"2026-08-06T03:01:00.000Z"}})).status).toBe(200);expect(await api.handle({method:"POST",path:"/v1/conversations/context",authorization,body:{pseudonymousUserId:user,maxTurns:6}})).toEqual({status:200,body:{recentTurns:[]}});});
  it("uses generic credential errors and revokes the issued session on logout",async()=>{
    const passwordHash=await createAdminPasswordHash("test-admin-password",Buffer.alloc(16,3));
    const api=new KnowledgeOpsApi(new KnowledgeOpsService(new InMemoryKnowledgeOpsStore(),new ContentCipher(randomBytes(32))),new KnowledgeOpsAuthorizer([],{username:"admin",passwordHash,sessionTtlMs:3_600_000}));
    await expect(api.handle({method:"POST",path:"/v1/auth/login",body:{username:"admin",password:"wrong"}})).resolves.toEqual({status:401,body:{error:"invalid_credentials"}});
    await expect(api.handle({method:"POST",path:"/v1/auth/login",body:{username:"missing",password:"test-admin-password"}})).resolves.toEqual({status:401,body:{error:"invalid_credentials"}});
    const response=await api.handle({method:"POST",path:"/v1/auth/login",body:{username:"admin",password:"test-admin-password"}});expect(response).toMatchObject({status:200,body:{sessionToken:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),expiresAt:expect.any(String),user:{username:"admin"}}});
    const sessionToken=(response.body as {sessionToken:string}).sessionToken,authorization=`Bearer ${sessionToken}`;
    expect((await api.handle({method:"GET",path:"/v1/dashboard",authorization})).status).toBe(200);
    await expect(api.handle({method:"GET",path:"/v1/repair-drafts/ready",authorization})).resolves.toEqual({status:200,body:[]});
    await expect(api.handle({method:"GET",path:"/v1/repair-batches",authorization})).resolves.toEqual({status:200,body:[]});
    expect((await api.handle({method:"POST",path:"/v1/repair-batches",authorization,body:{draftIds:[]}})).status).toBe(400);
    await expect(api.handle({method:"POST",path:"/v1/auth/logout",authorization,body:{}})).resolves.toEqual({status:200,body:{status:"logged_out"}});
    await expect(api.handle({method:"GET",path:"/v1/dashboard",authorization})).resolves.toEqual({status:401,body:{error:"authentication_required"}});
  });
  it("rejects malformed login bodies without exposing internals",async()=>{const passwordHash=await createAdminPasswordHash("test-admin-password",Buffer.alloc(16,4)),api=new KnowledgeOpsApi(new KnowledgeOpsService(new InMemoryKnowledgeOpsStore(),new ContentCipher(randomBytes(32))),new KnowledgeOpsAuthorizer([],{username:"admin",passwordHash,sessionTtlMs:3_600_000}));const response=await api.handle({method:"POST",path:"/v1/auth/login",body:{username:"admin"}});expect(response.status).toBe(400);expect(JSON.stringify(response.body)).not.toContain(passwordHash);});
});
