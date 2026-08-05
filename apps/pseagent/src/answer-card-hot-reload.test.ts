import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { ReloadingAnswerCardMatcher } from "./answer-card-matcher.js";
import type { ModelClient } from "./model-client.js";

const temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map((item)=>rm(item,{recursive:true,force:true})));});

describe("answer card catalog hot reload",()=>{
  it("switches atomically to a published snapshot, preserves the last valid catalog, and follows rollback",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"pse-card-reload-"));temporary.push(root);
    const basePath=path.join(root,"base.json"),snapshotRoot=path.join(root,"snapshots");
    await writeCatalog(basePath,catalog("旧问题","a"));
    const matcher=new ReloadingAnswerCardMatcher(basePath,snapshotRoot,model(),true);
    expect(matcher.routeExact("旧问题")).toEqual({domain:"coremail-professional",expectedRevision:"a".repeat(40)});

    await publishSnapshot(snapshotRoot,"KR-2026-08-REPAIR-A",catalog("新问题","c"));
    expect(matcher.routeExact("新问题")).toEqual({domain:"coremail-professional",expectedRevision:"c".repeat(40)});
    expect(matcher.routeExact("旧问题")).toBeUndefined();

    await writeFile(path.join(snapshotRoot,"active.json"),"{broken","utf8");
    expect(matcher.routeExact("新问题")).toEqual({domain:"coremail-professional",expectedRevision:"c".repeat(40)});

    await publishSnapshot(snapshotRoot,"KR-2026-08-ROLLBACK-A",catalog("旧问题","e"));
    expect(matcher.routeExact("旧问题")).toEqual({domain:"coremail-professional",expectedRevision:"e".repeat(40)});
    expect(matcher.routeExact("新问题")).toBeUndefined();
  });
});

function model():ModelClient{return{completeJson:vi.fn(),completeText:vi.fn()} as unknown as ModelClient;}

function catalog(question:string,revisionCharacter:string):AnswerCardCatalog{return{
  schemaVersion:1,
  domains:[
    {domain:"coremail-professional",revision:revisionCharacter.repeat(40),contentHash:revisionCharacter.repeat(64)},
    {domain:"presales-general",revision:"b".repeat(40),contentHash:"d".repeat(64)},
  ],
  cards:[{
    cardSchemaVersion:1,cardId:"PRO-HOT-RELOAD",domain:"coremail-professional",title:"热加载测试",
    canonicalQuestion:question,questionFamily:"hot_reload",aliases:[],applicability:{products:[],versions:["*"],scenarios:[],excludeWhen:[]},
    obligations:[{id:"O1",label:"给出结论",required:true,domains:["coremail-professional"],evidencePolicy:"direct",requiredConcepts:[],forbiddenClaims:[],preferredEvidencePaths:[]}],
    answerTemplate:`${question}的标准答案`,owner:"知识运营",reviewers:[],reviewStatus:"approved",regressionCaseIds:[],
  }],
  families:[],
};}

async function writeCatalog(target:string,value:AnswerCardCatalog){await mkdir(path.dirname(target),{recursive:true});await writeFile(target,`${JSON.stringify(value)}\n`,"utf8");}
async function publishSnapshot(root:string,releaseId:string,value:AnswerCardCatalog){
  await writeCatalog(path.join(root,"releases",releaseId,"answer-card-catalog.json"),value);
  await writeFile(path.join(root,"active.json"),`${JSON.stringify({releaseId})}\n`,"utf8");
}
