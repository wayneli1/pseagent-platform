import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import type { AnswerReviewReference } from "@pseagent/knowledge-ops";
import type { KnowledgeSource } from "./catalog-compiler.js";
import type { ReviewEvidenceDocument } from "./answer-reviewer.js";

const MAX_FILE_BYTES=256*1024;
const MAX_DOCUMENT_CHARS=12_000;
const MAX_TOTAL_CHARS=40_000;

export async function loadReviewEvidence(input:{
  readonly sources:readonly KnowledgeSource[];
  readonly catalog:AnswerCardCatalog;
  readonly references:readonly AnswerReviewReference[];
}):Promise<{readonly documents:readonly ReviewEvidenceDocument[];readonly issues:readonly string[]}>{
  const sourceByDomain=new Map(input.sources.map((source)=>[source.domain,source] as const));
  const revisionByDomain=new Map(input.catalog.domains.map((domain)=>[domain.domain,domain.revision] as const));
  const documents:ReviewEvidenceDocument[]=[];const issues:string[]=[];let totalChars=0;
  for(const reference of input.references){
    const source=sourceByDomain.get(reference.project);
    if(source===undefined){issues.push(`reference_${reference.index}:unknown_project`);continue;}
    if(revisionByDomain.get(reference.project)!==reference.revision){issues.push(`reference_${reference.index}:revision_mismatch`);continue;}
    const segments=reference.path.split("/");const root=path.resolve(source.root);const candidate=path.resolve(root,...segments);
    if(segments.includes("..")||reference.path.includes("\\")||!isInside(root,candidate)){issues.push(`reference_${reference.index}:path_rejected`);continue;}
    let bytes:Buffer;
    try{bytes=await readFile(candidate);}catch{issues.push(`reference_${reference.index}:unreadable`);continue;}
    if(bytes.byteLength>MAX_FILE_BYTES){issues.push(`reference_${reference.index}:too_large`);continue;}
    if(!matchesContentHash(bytes,reference.contentHash)){issues.push(`reference_${reference.index}:content_hash_mismatch`);continue;}
    const remaining=MAX_TOTAL_CHARS-totalChars;if(remaining<=0){issues.push(`reference_${reference.index}:evidence_budget_exhausted`);continue;}
    const content=[...bytes.toString("utf8")].slice(0,Math.min(MAX_DOCUMENT_CHARS,remaining)).join("");totalChars+=[...content].length;
    documents.push({index:reference.index,title:reference.title,path:reference.path,content});
  }
  return{documents:Object.freeze(documents),issues:Object.freeze(issues)};
}

function isInside(root:string,candidate:string):boolean{const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative));}
function matchesContentHash(bytes:Buffer,expected:string):boolean{
  if(hash(bytes)===expected)return true;
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return false;}
  const lf=text.replace(/\r\n/gu,"\n");
  return hash(Buffer.from(lf,"utf8"))===expected||hash(Buffer.from(lf.replace(/\n/gu,"\r\n"),"utf8"))===expected;
}
function hash(bytes:Buffer):string{return createHash("sha256").update(bytes).digest("hex");}
