import { loadContentCipher, PostgresKnowledgeOpsStore } from "@pseagent/knowledge-ops";
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
const worker=new KnowledgeOpsWorker(process.env.KNOWLEDGE_OPS_WORKER_ID??`worker-${process.pid}`,{
  store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],
  snapshots:new SnapshotManager(required("KNOWLEDGE_OPS_SNAPSHOT_ROOT")),
  git:new SafeGitWorkspace([professional,general],required("KNOWLEDGE_OPS_WORKTREE_ROOT")),
  cipher:loadContentCipher(process.env),
  answerReviewer:new IndependentAnswerReviewer(modelClient),
  repairAgent:new KnowledgeRepairAgent(modelClient),
  answerContractRevision,
});
await store.enqueueJob("compile_catalog",{trigger:"worker_startup"});
let stopping=false;process.once("SIGINT",()=>{stopping=true;});process.once("SIGTERM",()=>{stopping=true;});
try{while(!stopping){const worked=await worker.runOnce();if(!worked)await new Promise(resolve=>setTimeout(resolve,1_000));}}finally{await store.close();}
