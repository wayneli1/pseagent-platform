import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AnswerCard, AnswerCardCatalog, KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type { AnswerReviewReference } from "@pseagent/knowledge-ops";
import { parseAnswerCard, type KnowledgeSource } from "./catalog-compiler.js";
import type { RepairEvidence } from "./repair-agent.js";

const MAX_FILE_BYTES=256*1024;
const MAX_DOCUMENT_CHARS=12_000;
const MAX_TOTAL_CHARS=48_000;

export interface LocatedAnswerCard {
  readonly card: AnswerCard;
  readonly source: KnowledgeSource;
  readonly revision: string;
  readonly path: string;
  readonly content: string;
}

export async function locateAnswerCard(
  sources:readonly KnowledgeSource[],
  catalog:AnswerCardCatalog,
  cardId:string,
):Promise<LocatedAnswerCard|undefined>{
  const catalogCard=catalog.cards.find((card)=>card.cardId===cardId);if(catalogCard===undefined)return undefined;
  const source=sources.find((item)=>item.domain===catalogCard.domain),revision=catalog.domains.find((item)=>item.domain===catalogCard.domain)?.revision;
  if(source===undefined||revision===undefined)throw new Error("repair_card_source_missing");
  const files=(await git(source.root,["ls-tree","-r","--name-only",revision,"--","wiki/queries"])).split(/\r?\n/gu).filter(Boolean).sort();
  for(const relativePath of files){
    if(!safeWikiPath(relativePath))continue;
    const content=await readGitFile(source.root,revision,relativePath),parsed=parseAnswerCard(content,source.domain);
    if(parsed?.cardId===cardId)return{card:parsed,source,revision,path:relativePath,content};
  }
  return undefined;
}

export async function loadRepairEvidence(input:{
  readonly source:KnowledgeSource;
  readonly revision:string;
  readonly paths:readonly string[];
  readonly references:readonly AnswerReviewReference[];
}):Promise<{readonly documents:readonly RepairEvidence[];readonly issues:readonly string[]}>{
  const documents:RepairEvidence[]=[];const issues:string[]=[];const seen=new Set<string>();let totalChars=0;
  const referencesByPath=new Map(input.references.filter((item)=>item.project===input.source.domain&&item.revision===input.revision).map((item)=>[item.path,item] as const));
  for(const relativePath of [...new Set([...input.paths,...referencesByPath.keys()])]){
    if(!safeWikiPath(relativePath)){issues.push(`${relativePath}:path_rejected`);continue;}
    if(seen.has(relativePath))continue;seen.add(relativePath);
    let content:string;try{content=await readGitFile(input.source.root,input.revision,relativePath);}catch{issues.push(`${relativePath}:unreadable`);continue;}
    const reference=referencesByPath.get(relativePath);
    if(reference!==undefined&&createHash("sha256").update(Buffer.from(content,"utf8")).digest("hex")!==reference.contentHash){issues.push(`${relativePath}:content_hash_mismatch`);continue;}
    const remaining=MAX_TOTAL_CHARS-totalChars;if(remaining<=0){issues.push(`${relativePath}:evidence_budget_exhausted`);continue;}
    const bounded=[...content].slice(0,Math.min(MAX_DOCUMENT_CHARS,remaining)).join("");totalChars+=[...bounded].length;
    documents.push({title:reference?.title??path.posix.basename(relativePath,".md"),path:relativePath,content:bounded});
  }
  return{documents:Object.freeze(documents),issues:Object.freeze(issues)};
}

export function domainForIssueScope(scope:string|undefined):KnowledgeDomain|undefined{
  if(scope==="professional"||scope==="coremail-professional")return"coremail-professional";
  if(scope==="general"||scope==="presales-general")return"presales-general";
  return undefined;
}

function safeWikiPath(value:string):boolean{return value.startsWith("wiki/")&&value.endsWith(".md")&&!value.includes("\\")&&!value.split("/").includes("..");}
async function readGitFile(root:string,revision:string,relativePath:string):Promise<string>{
  if(!/^[a-f0-9]{40}$/u.test(revision))throw new Error("repair_evidence_revision_invalid");
  const content=await git(root,["show",`${revision}:${relativePath}`],MAX_FILE_BYTES);return content;
}
function git(cwd:string,args:string[],maxBytes=2*1024*1024):Promise<string>{return new Promise((resolve,reject)=>{
  const child=spawn("git",["-c",`safe.directory=${cwd}`,"-c","core.quotepath=false","-C",cwd,...args],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});const output:Buffer[]=[];let bytes=0,error="";
  child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.byteLength;if(bytes<=maxBytes)output.push(chunk);else child.kill();});child.stderr.setEncoding("utf8").on("data",(chunk)=>error+=chunk);
  child.once("error",reject);child.once("exit",(code)=>code===0&&bytes<=maxBytes?resolve(Buffer.concat(output).toString("utf8")):reject(new Error(bytes>maxBytes?"repair_evidence_too_large":`git_failed:${error.trim().slice(0,200)}`)));
});}

export function findCardByHashedKey(catalog:AnswerCardCatalog,key:string|undefined):AnswerCard|undefined{
  if(key===undefined)return undefined;return catalog.cards.find((card)=>createHash("sha256").update(card.cardId,"utf8").digest("hex")===key);
}

export function catalogRevision(catalog:AnswerCardCatalog,domain:KnowledgeDomain):string|undefined{return catalog.domains.find((item)=>item.domain===domain)?.revision;}
