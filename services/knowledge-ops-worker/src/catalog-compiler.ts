import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import {
  answerCardCatalogSchema, answerCardSchema, type AnswerCard, type AnswerCardCatalog,
  type KnowledgeDomain, type QuestionFamily,
} from "@pseagent/knowledge-governance-contracts";

export interface KnowledgeSource { readonly domain:KnowledgeDomain; readonly root:string; readonly revision?:string; }

export class CatalogCompiler {
  async compile(sources:readonly KnowledgeSource[]):Promise<AnswerCardCatalog>{
    if(sources.length!==2||new Set(sources.map(x=>x.domain)).size!==2)throw new Error("two_unique_knowledge_domains_required");
    const cards:AnswerCard[]=[]; const domains=[];
    for(const source of sources){
      const queryRoot=path.join(source.root,"wiki","queries"); const files=(await markdownFiles(queryRoot)).sort();
      const contentHasher=createHash("sha256");
      for(const file of files){const relative=path.relative(source.root,file).split(path.sep).join("/");const content=await readFile(file,"utf8");contentHasher.update(relative).update("\0").update(content).update("\0");const card=parseAnswerCard(content,source.domain);if(card)cards.push(card);}
      domains.push({domain:source.domain,revision:source.revision??await gitRevision(source.root),contentHash:contentHasher.digest("hex")});
    }
    const families=await loadFamilies(sources);
    return answerCardCatalogSchema.parse({schemaVersion:1,domains,cards,families});
  }
}

export function parseAnswerCard(markdown:string,domain:KnowledgeDomain):AnswerCard|undefined{
  const normalized=markdown.replace(/\r\n?|\n/gu,"\n"); if(!normalized.startsWith("---\n"))return undefined;
  const end=normalized.indexOf("\n---\n",4);if(end<0)return undefined;
  let meta:Record<string,unknown>;try{meta=parse(normalized.slice(4,end)) as Record<string,unknown>;}catch{return undefined;}
  if(meta.card_schema_version!==1)return undefined;
  const body=normalized.slice(end+5).trim();
  const obligations=asRecords(meta.obligations).map(item=>({id:item.id,label:item.label,required:item.required??true,domains:item.domains,
    evidencePolicy:item.evidence_policy,requiredConcepts:item.required_concepts??[],forbiddenClaims:item.forbidden_claims??[],preferredEvidencePaths:item.preferred_evidence_paths??[]}));
  return answerCardSchema.parse({cardSchemaVersion:1,cardId:meta.card_id,domain,title:meta.title,canonicalQuestion:meta.canonical_question,
    questionFamily:meta.question_family,aliases:array(meta.aliases),applicability:{products:array(meta.applicable_product),versions:array(meta.applicable_version,"*"),
      scenarios:array(meta.applicable_scenarios),excludeWhen:array(meta.exclude_when)},obligations,answerTemplate:body,owner:meta.owner,
    reviewers:array(meta.reviewers),reviewStatus:meta.review_status,...(meta.review_due?{reviewDue:String(meta.review_due)}:{}),regressionCaseIds:array(meta.regression_case_ids)});
}

async function loadFamilies(sources:readonly KnowledgeSource[]):Promise<QuestionFamily[]>{
  const result:QuestionFamily[]=[];
  for(const source of sources){const directory=path.join(source.root,"governance","question-families");let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{continue;}
    for(const entry of entries.filter(x=>x.isFile()&&x.name.endsWith(".json"))){const sourceValue=JSON.parse(await readFile(path.join(directory,entry.name),"utf8"));result.push(sourceValue as QuestionFamily);}}
  return result;
}
async function markdownFiles(root:string):Promise<string[]>{const result:string[]=[];for(const entry of await readdir(root,{withFileTypes:true})){const full=path.join(root,entry.name);if(entry.isDirectory())result.push(...await markdownFiles(full));else if(entry.isFile()&&entry.name.endsWith(".md"))result.push(full);}return result;}
async function gitRevision(root:string):Promise<string>{return (await execGit(root,["rev-parse","HEAD"])).trim();}
function array(value:unknown,defaultValue?:string):string[]{if(value===undefined||value===null||value==="")return defaultValue?[defaultValue]:[];return Array.isArray(value)?value.map(String):[String(value)];}
function asRecords(value:unknown):Record<string,unknown>[] {return Array.isArray(value)?value.filter(x=>x!==null&&typeof x==="object") as Record<string,unknown>[]:[];}
function execGit(cwd:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn("git",["-C",cwd,...args],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.setEncoding("utf8").on("data",x=>out+=x);child.stderr.setEncoding("utf8").on("data",x=>err+=x);child.once("error",reject);child.once("exit",code=>code===0?resolve(out):reject(new Error(`git_failed:${err.trim().slice(0,200)}`)));});}
