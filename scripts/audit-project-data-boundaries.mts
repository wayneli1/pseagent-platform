import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import { parseAnswerCard } from "../services/knowledge-ops-worker/src/catalog-compiler.ts";
import { inspectAnswerCardRuleConflicts, rewriteBroadProjectDataForbiddenClaims } from "../services/knowledge-ops-worker/src/project-data-policy.ts";

interface AuditRow {
  readonly repository: KnowledgeDomain;
  readonly file: string;
  readonly cardId: string;
  readonly obligationId: string;
  readonly field: "requiredConcepts" | "forbiddenClaims" | "answerTemplate";
  readonly originalRule: string;
  readonly adjustedRules: readonly string[];
  readonly reason: string;
  readonly evidencePaths: readonly string[];
}

const sources=[
  {domain:"coremail-professional" as const,root:required("PROFESSIONAL_KB_ROOT")},
  {domain:"presales-general" as const,root:required("GENERAL_KB_ROOT")},
];
const rows:AuditRow[]=[];let scannedQueryPages=0,scannedCards=0;
for(const source of sources){
  const queryRoot=path.join(source.root,"wiki","queries");
  const files=await markdownFiles(queryRoot);scannedQueryPages+=files.length;
  for(const file of files){
    const markdown=await readFile(file,"utf8"),card=parseAnswerCard(markdown,source.domain);if(card===undefined)continue;scannedCards+=1;
    const evidence=await Promise.all([...new Set(card.obligations.flatMap((item)=>item.preferredEvidencePaths))].map(async(relative)=>({title:path.basename(relative,".md"),path:relative,content:await safeKnowledgeRead(source.root,relative)})));
    for(const obligation of card.obligations){
      const rewrite=rewriteBroadProjectDataForbiddenClaims(obligation.forbiddenClaims);
      for(const item of rewrite.rewrites)rows.push({repository:source.domain,file:relativePath(source.root,file),cardId:card.cardId,obligationId:obligation.id,field:"forbiddenClaims",originalRule:item.originalRule,adjustedRules:item.adjustedRules,reason:item.reason,evidencePaths:obligation.preferredEvidencePaths});
    }
    for(const conflict of inspectAnswerCardRuleConflicts({answerTemplate:card.answerTemplate,obligations:card.obligations,evidence})){
      if(rows.some((item)=>item.cardId===card.cardId&&item.obligationId===conflict.obligationId&&item.originalRule===conflict.rule))continue;
      rows.push({repository:source.domain,file:relativePath(source.root,file),cardId:card.cardId,obligationId:conflict.obligationId,field:conflict.field,originalRule:conflict.rule,adjustedRules:[],reason:conflict.message,evidencePaths:conflict.evidencePaths});
    }
  }
}
const report={schemaVersion:1,generatedAt:new Date().toISOString(),policy:"正式证据直接支持的项目具体数据可以回答，但不得跨项目套用、实时化、容量上限化或承诺化。",scannedRepositories:sources.map((item)=>item.domain),scannedQueryPages,scannedCards,conflictCount:rows.length,items:rows};
const serialized=`${JSON.stringify(report,null,2)}\n`,output=optionalArgument("--output");
if(output!==undefined){if(path.extname(output).toLowerCase()!==".json")throw new Error("json_output_required");await writeFile(output,serialized,"utf8");}
process.stdout.write(output===undefined?serialized:`${JSON.stringify({output,scannedQueryPages,scannedCards,conflictCount:rows.length})}\n`);

async function markdownFiles(root:string):Promise<string[]>{const result:string[]=[];for(const entry of await readdir(root,{withFileTypes:true})){const full=path.join(root,entry.name);if(entry.isDirectory())result.push(...await markdownFiles(full));else if(entry.isFile()&&entry.name.endsWith(".md"))result.push(full);}return result.sort();}
async function safeKnowledgeRead(root:string,relative:string):Promise<string>{const target=path.resolve(root,...relative.split("/")),base=`${path.resolve(root)}${path.sep}`;if(!target.startsWith(base))return"";try{return await readFile(target,"utf8");}catch{return"";}}
function relativePath(root:string,file:string):string{return path.relative(root,file).split(path.sep).join("/");}
function required(name:string):string{const value=process.env[name];if(value===undefined||value.trim()==="")throw new Error(`${name}_required`);return path.resolve(value);}
function optionalArgument(name:string):string|undefined{const index=process.argv.indexOf(name),value=index<0?undefined:process.argv[index+1];return value===undefined?undefined:path.resolve(value);}
