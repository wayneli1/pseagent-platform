import { describe,expect,it,vi } from "vitest";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { HttpKnowledgeRuntimeController } from "./knowledge-runtime-controller.js";

const catalog={schemaVersion:1,domains:[{domain:"coremail-professional",revision:"a".repeat(40),contentHash:"1".repeat(64)},{domain:"presales-general",revision:"b".repeat(40),contentHash:"2".repeat(64)}],cards:[],families:[]} satisfies AnswerCardCatalog;

describe("knowledge runtime controller",()=>{
  it("reloads both revisions and verifies the active runtime",async()=>{
    const responses=[{releaseId:"KR-2026-08-TEST",previousProjects:projects("c","d"),projects:projects("a","b"),oldVersionServedDuringReload:true},{status:"ready",projects:projects("a","b"),deployment:{status:"ready",servingPreviousVersion:false,releaseId:"KR-2026-08-TEST",professionalRevision:"a".repeat(40),generalRevision:"b".repeat(40),errorCode:null}}];
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify(responses.shift()),{status:200,headers:{"content-type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
    await expect(new HttpKnowledgeRuntimeController({baseUrl:"http://127.0.0.1:19829",token:"secret",timeoutMs:30_000}).reload("KR-2026-08-TEST",catalog)).resolves.toMatchObject({status:"ready"});
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({professionalRevision:"a".repeat(40),generalRevision:"b".repeat(40)});
  });
  it("fails closed when runtime revisions do not match",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({status:"ready",projects:projects("c","b"),deployment:{status:"ready",servingPreviousVersion:false,releaseId:null,professionalRevision:null,generalRevision:null,errorCode:null}}),{status:200})));await expect(new HttpKnowledgeRuntimeController({baseUrl:"http://127.0.0.1:19829",token:"secret",timeoutMs:30_000}).assertAligned(catalog)).rejects.toThrow("knowledge_runtime_revision_mismatch");});
});

function projects(professional:string,general:string){return[{project:"coremail-professional",revision:professional.repeat(40),lexicalStatus:"ready",graphStatus:"ready"},{project:"presales-general",revision:general.repeat(40),lexicalStatus:"ready",graphStatus:"ready"}];}
