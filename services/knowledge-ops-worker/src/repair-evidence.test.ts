import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRepairEvidence } from "./repair-evidence.js";

const temporary:string[]=[];
afterAll(async()=>{await Promise.all(temporary.map((item)=>rm(item,{recursive:true,force:true})));});

describe("loadRepairEvidence",()=>{
  it("revalidates unchanged historical references and rejects stale or mismatched references",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"pse-repair-evidence-"));temporary.push(root);
    const relativePath="wiki/concepts/正式资料.md",absolutePath=path.join(root,...relativePath.split("/")),original="正式资料第一版。\n";
    await mkdir(path.dirname(absolutePath),{recursive:true});git(root,"init");await writeFile(absolutePath,original,"utf8");git(root,"add",".");git(root,"commit","-m","initial");
    const historicalRevision=git(root,"rev-parse","HEAD").trim(),contentHash=createHash("sha256").update(Buffer.from(original,"utf8")).digest("hex");
    await writeFile(path.join(root,"README.md"),"unrelated\n","utf8");git(root,"add",".");git(root,"commit","-m","advance head");const unchangedRevision=git(root,"rev-parse","HEAD").trim();
    const reference={index:1,project:"coremail-professional" as const,title:"正式资料",path:relativePath,revision:historicalRevision,contentHash};

    const unchanged=await loadRepairEvidence({source:{domain:"coremail-professional",root},revision:unchangedRevision,paths:[],references:[reference]});
    expect(unchanged).toMatchObject({documents:[{path:relativePath,content:original}],issues:[],revalidatedReferenceCount:1});

    await writeFile(absolutePath,"正式资料第二版。\n","utf8");git(root,"add",".");git(root,"commit","-m","change evidence");const changedRevision=git(root,"rev-parse","HEAD").trim();
    const stale=await loadRepairEvidence({source:{domain:"coremail-professional",root},revision:changedRevision,paths:[],references:[reference]});
    expect(stale).toMatchObject({documents:[],issues:[`${relativePath}:reference_stale`],revalidatedReferenceCount:0});

    const governed=await loadRepairEvidence({source:{domain:"coremail-professional",root},revision:changedRevision,paths:[relativePath],references:[reference]});
    expect(governed.documents).toHaveLength(1);expect(governed.issues).toEqual([]);

    const mismatched=await loadRepairEvidence({source:{domain:"coremail-professional",root},revision:changedRevision,paths:[relativePath],references:[{...reference,revision:changedRevision}]});
    expect(mismatched).toMatchObject({documents:[],issues:[`${relativePath}:content_hash_mismatch`]});
  });
});

function git(root:string,...args:string[]):string{return execFileSync("git",["-c","user.name=PSE Test","-c","user.email=pse@example.invalid","-C",root,...args],{encoding:"utf8",windowsHide:true});}
