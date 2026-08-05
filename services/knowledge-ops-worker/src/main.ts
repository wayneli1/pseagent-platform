import { loadContentCipher, PostgresKnowledgeOpsStore, type OpsJobType } from "@pseagent/knowledge-ops";
import { OpenAiCompatibleModelClient } from "@pseagent/app/embedded";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SafeGitWorkspace } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { KnowledgeOpsWorker } from "./worker.js";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";
import { loadAnswerReviewModelConfig } from "./answer-review-config.js";
import { KnowledgeRepairAgent } from "./repair-agent.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name}_required`);return value;};
const professional=required("PROFESSIONAL_KB_ROOT"),general=required("GENERAL_KB_ROOT");
const store=PostgresKnowledgeOpsStore.connect(required("KNOWLEDGE_OPS_DATABASE_URL"));
await store.migrate();
const reviewModelConfig=loadAnswerReviewModelConfig(process.env);
const modelClient=new OpenAiCompatibleModelClient(reviewModelConfig);
const answerContractRevision=process.env.KNOWLEDGE_OPS_ANSWER_CONTRACT_REVISION??(await promisify(execFile)("git",["rev-parse","HEAD"],{cwd:process.cwd(),windowsHide:true})).stdout.trim();
const dependencies={
  store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],
  snapshots:new SnapshotManager(required("KNOWLEDGE_OPS_SNAPSHOT_ROOT")),
  git:new SafeGitWorkspace([professional,general],required("KNOWLEDGE_OPS_WORKTREE_ROOT")),
  cipher:loadContentCipher(process.env),
  answerReviewer:new IndependentAnswerReviewer(modelClient),
  repairAgent:new KnowledgeRepairAgent(modelClient),
  answerContractRevision,
} as const;
await store.enqueueJob("compile_catalog",{trigger:"worker_startup"});
let stopping=false;process.once("SIGINT",()=>{stopping=true;});process.once("SIGTERM",()=>{stopping=true;});
const workerId=process.env.KNOWLEDGE_OPS_WORKER_ID??`worker-${process.pid}`,pools:readonly WorkerPool[]=[
  {name:"review",concurrency:concurrency("KNOWLEDGE_OPS_REVIEW_CONCURRENCY",4),types:["answer_review"]},
  {name:"draft",concurrency:concurrency("KNOWLEDGE_OPS_DRAFT_CONCURRENCY",3),types:["generate_repair_draft"]},
  {name:"validation",concurrency:concurrency("KNOWLEDGE_OPS_VALIDATION_CONCURRENCY",2),types:["validate_repair_draft"]},
  {name:"maintenance",concurrency:concurrency("KNOWLEDGE_OPS_MAINTENANCE_CONCURRENCY",1),types:["compile_catalog","regression_run","publish_release","rollback_release","git_writeback","publish_repair","publish_repair_batch","rollback_repair","rollback_repair_batch"]},
];
try{await Promise.all(pools.flatMap((pool)=>Array.from({length:pool.concurrency},(_,index)=>runPool(new KnowledgeOpsWorker(`${workerId}-${pool.name}-${index+1}`,dependencies),pool.types))));}finally{await store.close();}

interface WorkerPool{readonly name:string;readonly concurrency:number;readonly types:readonly OpsJobType[];}
async function runPool(worker:KnowledgeOpsWorker,types:readonly OpsJobType[]){while(!stopping){const worked=await worker.runOnce(types);if(!worked)await new Promise(resolve=>setTimeout(resolve,1_000));}}
function concurrency(name:string,fallback:number){const raw=process.env[name];if(raw===undefined)return fallback;const value=Number(raw);if(!Number.isInteger(value)||value<1||value>16)throw new Error(`${name}_invalid`);return value;}
