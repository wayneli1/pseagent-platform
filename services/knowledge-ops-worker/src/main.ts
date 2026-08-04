import { PostgresKnowledgeOpsStore } from "@pseagent/knowledge-ops";
import { SafeGitWorkspace } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { KnowledgeOpsWorker } from "./worker.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name}_required`);return value;};
const professional=required("PROFESSIONAL_KB_ROOT"),general=required("GENERAL_KB_ROOT");
const store=PostgresKnowledgeOpsStore.connect(required("KNOWLEDGE_OPS_DATABASE_URL"));
const worker=new KnowledgeOpsWorker(process.env.KNOWLEDGE_OPS_WORKER_ID??`worker-${process.pid}`,{
  store,sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],
  snapshots:new SnapshotManager(required("KNOWLEDGE_OPS_SNAPSHOT_ROOT")),
  git:new SafeGitWorkspace([professional,general],required("KNOWLEDGE_OPS_WORKTREE_ROOT")),
});
let stopping=false;process.once("SIGINT",()=>{stopping=true;});process.once("SIGTERM",()=>{stopping=true;});
try{while(!stopping){const worked=await worker.runOnce();if(!worked)await new Promise(resolve=>setTimeout(resolve,1_000));}}finally{await store.close();}
