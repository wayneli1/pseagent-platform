import {describe,expect,it} from "vitest";
import {runtimeStatusPresentation} from "./runtime-status-view.js";
import type {KnowledgeRuntimeStatus} from "./types.js";

const aligned:KnowledgeRuntimeStatus={state:"aligned",checkedAt:new Date().toISOString(),servingPreviousVersion:false,engineStatus:"ready",activeReleaseId:"KR-2026-08-TEST"};
describe("runtime status presentation",()=>{
  it("states explicitly that the old version remains online while a release is prepared",()=>{const result=runtimeStatusPresentation({...aligned,state:"switching",servingPreviousVersion:true,activeBatch:{batchId:"batch",status:"publishing",deploymentStage:"reloading_engine",servingPreviousVersion:true,itemCount:2,domains:["coremail-professional"],createdBy:"admin",createdAt:new Date().toISOString()}});expect(result.title).toContain("旧版本仍正常回答");expect(result.stage).toContain("Knowledge Engine");expect(result.busy).toBe(true);});
  it("raises an explicit warning when revisions are not aligned",()=>{const result=runtimeStatusPresentation({...aligned,state:"degraded",errorCode:"knowledge_runtime_revision_mismatch"});expect(result.alert).toBe(true);expect(result.title).toContain("需要检查");});
});
