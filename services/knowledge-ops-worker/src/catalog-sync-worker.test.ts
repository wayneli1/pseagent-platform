import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,expect,it } from "vitest";
import { InMemoryKnowledgeOpsStore } from "@pseagent/knowledge-ops";
import { SafeGitWorkspace } from "./git-workspace.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { KnowledgeOpsWorker } from "./worker.js";

const temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map((root)=>rm(root,{recursive:true,force:true})));});

it("syncs both real catalog domains once and remains idempotent",async()=>{
  const workspace=path.resolve(import.meta.dirname,"../../../..");
  const professional=path.join(workspace,"coremail-professional"),general=path.join(workspace,"presales-general");
  const runtime=await mkdtemp(path.join(tmpdir(),"pse-catalog-sync-"));temporary.push(runtime);
  const store=new InMemoryKnowledgeOpsStore();
  const worker=new KnowledgeOpsWorker("catalog-worker",{
    store,
    sources:[{domain:"coremail-professional",root:professional},{domain:"presales-general",root:general}],
    snapshots:new SnapshotManager(path.join(runtime,"snapshots")),
    git:new SafeGitWorkspace([professional,general],path.join(runtime,"worktrees")),
  });
  await store.enqueueJob("compile_catalog",{trigger:"test"});
  expect(await worker.runOnce(["answer_review"])).toBe(false);
  expect(await worker.runOnce(["compile_catalog"])).toBe(true);
  const first=await store.listCardRevisions();
  expect(first).toHaveLength(13);
  expect(first.every((card)=>card.createdBy==="catalog-sync"&&card.status==="approved")).toBe(true);
  await store.enqueueJob("compile_catalog",{trigger:"test-repeat"});
  expect(await worker.runOnce()).toBe(true);
  expect(await store.listCardRevisions()).toHaveLength(13);
  const latestJob=(await store.listJobs()).find((job)=>job.payload.trigger==="test-repeat");
  expect(latestJob).toMatchObject({status:"completed",result:{cardCount:13,syncedCardCount:0,existingCardCount:13}});
},30_000);
