import { createHash } from "node:crypto";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,expect,it } from "vitest";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { loadReviewEvidence } from "./review-evidence.js";

const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true})));});

it("loads only revision-bound hash-valid knowledge evidence",async()=>{const root=await mkdtemp(path.join(tmpdir(),"pse-review-evidence-"));roots.push(root);const relative="wiki/concepts/正式页面.md",file=path.join(root,...relative.split("/")),content="正式知识内容";await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content,"utf8");const revision="a".repeat(40),hash=createHash("sha256").update(Buffer.from(content)).digest("hex");const catalog={schemaVersion:1,domains:[{domain:"coremail-professional",revision,contentHash:"b".repeat(64)},{domain:"presales-general",revision:"c".repeat(40),contentHash:"d".repeat(64)}],cards:[],families:[]} satisfies AnswerCardCatalog;const source={domain:"coremail-professional" as const,root,revision};const valid=await loadReviewEvidence({sources:[source,{domain:"presales-general",root,revision:"c".repeat(40)}],catalog,references:[{index:1,project:"coremail-professional",title:"正式页面",path:relative,revision,contentHash:hash}]});expect(valid).toMatchObject({documents:[{content}],issues:[]});const invalid=await loadReviewEvidence({sources:[source,{domain:"presales-general",root,revision:"c".repeat(40)}],catalog,references:[{index:1,project:"coremail-professional",title:"越界",path:"wiki/../secret.md",revision,contentHash:hash},{index:2,project:"coremail-professional",title:"漂移",path:relative,revision:"e".repeat(40),contentHash:hash},{index:3,project:"coremail-professional",title:"哈希错误",path:relative,revision,contentHash:"f".repeat(64)}]});expect(invalid.documents).toEqual([]);expect(invalid.issues).toEqual(["reference_1:path_rejected","reference_2:revision_mismatch","reference_3:content_hash_mismatch"]);});
