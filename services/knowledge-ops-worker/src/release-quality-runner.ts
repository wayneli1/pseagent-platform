import { execFile } from "node:child_process";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";
import { releaseQualityReportImportSchema } from "@pseagent/knowledge-ops";

export type ReleaseQualityGateReport=ReturnType<typeof releaseQualityReportImportSchema.parse>;

export type ReleaseQualityProcessEvent =
  | { readonly type:"case_started"; readonly suiteId:string; readonly caseId:string; readonly kind:string; readonly turn:number }
  | { readonly type:"progress"; readonly suiteId:string; readonly caseId:string; readonly kind:string; readonly latencyMs:number; readonly status?:string; readonly scope?:string; readonly matchType?:string }
  | { readonly type:"failure"; readonly suiteId:string; readonly caseId:string; readonly latencyMs:number; readonly failure:string };

export interface ReleaseQualityRunner { run(catalog:AnswerCardCatalog,onEvent?:(event:ReleaseQualityProcessEvent)=>void|Promise<void>):Promise<ReleaseQualityGateReport>; }

export class ProcessReleaseQualityRunner implements ReleaseQualityRunner {
  constructor(private readonly config:{readonly command:string;readonly entryPath:string;readonly cwd:string;readonly timeoutMs:number}){
    if(!path.isAbsolute(config.entryPath)||!path.isAbsolute(config.cwd)||config.timeoutMs<30_000||config.timeoutMs>1_800_000)throw new Error("release_quality_runner_config_invalid");
  }
  async run(catalog:AnswerCardCatalog,onEvent?:(event:ReleaseQualityProcessEvent)=>void|Promise<void>):Promise<ReleaseQualityGateReport>{
    const directory=await mkdtemp(path.join(tmpdir(),"pse-release-candidate-")),catalogPath=path.join(directory,"answer-card-catalog.json");let reportPath:string|undefined;
    try{
      await writeFile(catalogPath,`${JSON.stringify(catalog)}\n`,"utf8");
      const env:NodeJS.ProcessEnv={...process.env,PSE_ANSWER_CARD_CATALOG_PATH:catalogPath};
      delete env.PSE_ANSWER_CARD_SNAPSHOT_ROOT;delete env.KNOWLEDGE_OPS_SNAPSHOT_ROOT;delete env.KNOWLEDGE_OPS_BASE_URL;delete env.KNOWLEDGE_OPS_RELEASE_TOKEN;
      const stdout=await this.execute(env,onEvent);
      reportPath=summaryReportPath(stdout);const artifact=JSON.parse(await readFile(reportPath,"utf8"));return releaseQualityReportImportSchema.parse(selectGateReport(artifact));
    }finally{await rm(directory,{recursive:true,force:true});if(reportPath!==undefined)await rm(reportPath,{force:true}).catch(()=>undefined);}
  }
  private execute(env:NodeJS.ProcessEnv,onEvent?:(event:ReleaseQualityProcessEvent)=>void|Promise<void>):Promise<string>{
    return new Promise((resolve,reject)=>{
      let stdout="",pending="",events=Promise.resolve();
      const child=execFile(this.config.command,["--import","tsx",this.config.entryPath],{cwd:this.config.cwd,env,encoding:"utf8",windowsHide:true,timeout:this.config.timeoutMs,maxBuffer:16*1024*1024},(error,finalStdout)=>{
        if(finalStdout.length>stdout.length)stdout=finalStdout;
        if(pending.trim()!=="")events=events.then(()=>dispatchProgressLine(pending,onEvent));
        void events.then(()=>{if(error!==null&&stdout==="")reject(new Error("release_quality_gate_execution_failed"));else resolve(stdout);},reject);
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data",(chunk:string)=>{
        stdout+=chunk;pending+=chunk;const lines=pending.split(/\r?\n/gu);pending=lines.pop()??"";
        for(const line of lines)events=events.then(()=>dispatchProgressLine(line,onEvent));
      });
    });
  }
}

async function dispatchProgressLine(line:string,onEvent:((event:ReleaseQualityProcessEvent)=>void|Promise<void>)|undefined):Promise<void>{
  if(onEvent===undefined)return;
  try{
    const value=JSON.parse(line) as Partial<ReleaseQualityProcessEvent>;
    if(value.type==="case_started"||value.type==="progress"||value.type==="failure")await onEvent(value as ReleaseQualityProcessEvent);
  }catch{/* summary and diagnostic output are not progress events */}
}

export function summaryReportPath(stdout:string):string{
  for(const line of stdout.trim().split(/\r?\n/gu).reverse()){
    try{const value=JSON.parse(line) as {type?:unknown;reportPath?:unknown};if(value.type==="summary"&&typeof value.reportPath==="string"&&path.isAbsolute(value.reportPath))return value.reportPath;}catch{/* ignore progress lines that are not valid JSON */}
  }
  throw new Error("release_quality_report_path_missing");
}

function selectGateReport(value:unknown):Record<string,unknown>{
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error("release_quality_report_invalid");const source=value as Record<string,unknown>;
  return Object.fromEntries(["schemaVersion","generatedAt","model","passed","summary","suites","kinds","consistencyChecks","cases"].map((key)=>[key,source[key]]));
}
