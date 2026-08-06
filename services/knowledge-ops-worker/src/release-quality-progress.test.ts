import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
import { releaseQualityPlan } from "@pseagent/knowledge-ops";
import { parseReleaseQualitySuites } from "./release-quality-gate.js";
import { applyReleaseQualityEvent,finalizeReleaseQualityProgress,initialReleaseQualityProgress } from "./release-quality-progress.js";

describe("release quality progress",()=>{
  it("keeps the API plan aligned with the executable fixture",()=>{
    const suites=parseReleaseQualitySuites(JSON.parse(readFileSync(new URL("../../../tests/regression/release-quality-suites.json",import.meta.url),"utf8")));
    expect(releaseQualityPlan.suites).toEqual(suites.map((suite)=>({suiteId:suite.suiteId,title:suite.title,cases:suite.cases.map((testCase)=>({caseId:testCase.id,kind:testCase.kind,turn:testCase.turn,question:testCase.question}))})));
  });
  it("moves one case through running and completed before applying the gate verdict",()=>{
    let progress=initialReleaseQualityProgress();expect(progress).toMatchObject({totalCases:20,completedCases:0,currentCaseIds:[]});
    progress=applyReleaseQualityEvent(progress,{type:"case_started",suiteId:"professional_migration",caseId:"QG-PRO-CANONICAL",kind:"canonical",turn:1});expect(progress).toMatchObject({completedCases:0,currentCaseIds:["QG-PRO-CANONICAL"]});
    progress=applyReleaseQualityEvent(progress,{type:"progress",suiteId:"professional_migration",caseId:"QG-PRO-CANONICAL",kind:"canonical",latencyMs:321,status:"answered"});expect(progress).toMatchObject({completedCases:1,currentCaseIds:[]});expect(progress.cases.find((item)=>item.caseId==="QG-PRO-CANONICAL")).toMatchObject({status:"completed",latencyMs:321});
    progress=finalizeReleaseQualityProgress(progress,{schemaVersion:1,generatedAt:new Date().toISOString(),model:"deepseek_v4_flash",passed:false,summary:{total:20,completed:1,passedCases:1,averageScore:1,p95LatencyMs:321,safetyFailures:0,availabilityFailures:19},suites:[],kinds:[],consistencyChecks:[],cases:[{caseId:"QG-PRO-CANONICAL",suiteId:"professional_migration",kind:"canonical",passed:true,score:1,checks:[]}]});
    expect(progress.cases.find((item)=>item.caseId==="QG-PRO-CANONICAL")?.status).toBe("passed");expect(progress.failedCases).toBe(19);
  });
});
