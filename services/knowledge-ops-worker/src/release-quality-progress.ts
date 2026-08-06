import { releaseQualityPlan, type ReleaseQualityPlan, type ReleaseQualityPlanCase } from "@pseagent/knowledge-ops";
import type { ReleaseQualityGateReport, ReleaseQualityProcessEvent } from "./release-quality-runner.js";

export type ReleaseQualityCaseStatus = "queued" | "running" | "completed" | "passed" | "failed" | "error";

export interface ReleaseQualityProgressCase extends ReleaseQualityPlanCase {
  readonly suiteId: string;
  readonly suiteTitle: string;
  readonly status: ReleaseQualityCaseStatus;
  readonly latencyMs?: number;
  readonly answerStatus?: string;
  readonly failure?: string;
}

export interface ReleaseQualityProgress {
  readonly kind: "release_quality_progress";
  readonly model: "deepseek_v4_flash";
  readonly totalCases: number;
  readonly completedCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly currentCaseIds: readonly string[];
  readonly cases: readonly ReleaseQualityProgressCase[];
}

export function initialReleaseQualityProgress(plan:ReleaseQualityPlan=releaseQualityPlan):ReleaseQualityProgress{
  return summarize(plan.suites.flatMap((suite)=>suite.cases.map((testCase)=>({...testCase,suiteId:suite.suiteId,suiteTitle:suite.title,status:"queued" as const}))));
}

export function applyReleaseQualityEvent(progress:ReleaseQualityProgress,event:ReleaseQualityProcessEvent):ReleaseQualityProgress{
  return summarize(progress.cases.map((testCase)=>{
    if(testCase.caseId!==event.caseId)return testCase;
    if(event.type==="case_started")return{...testCase,status:"running" as const};
    if(event.type==="failure")return{...testCase,status:"error" as const,latencyMs:event.latencyMs,failure:event.failure};
    return{...testCase,status:"completed" as const,latencyMs:event.latencyMs,...(event.status===undefined?{}:{answerStatus:event.status})};
  }));
}

export function finalizeReleaseQualityProgress(progress:ReleaseQualityProgress,report:ReleaseQualityGateReport):ReleaseQualityProgress{
  const evaluations=new Map(report.cases.map((item)=>[item.caseId,item]));
  return summarize(progress.cases.map((testCase)=>{
    const evaluation=evaluations.get(testCase.caseId);
    if(evaluation===undefined)return testCase.status==="error"?testCase:{...testCase,status:"error" as const,failure:"quality_evaluation_missing"};
    return{...testCase,status:evaluation.passed?"passed" as const:"failed" as const};
  }));
}

function summarize(cases:readonly ReleaseQualityProgressCase[]):ReleaseQualityProgress{
  const completed=cases.filter((item)=>item.status==="completed"||item.status==="passed"||item.status==="failed"||item.status==="error");
  return{kind:"release_quality_progress",model:"deepseek_v4_flash",totalCases:cases.length,completedCases:completed.length,passedCases:cases.filter((item)=>item.status==="passed").length,failedCases:cases.filter((item)=>item.status==="failed"||item.status==="error").length,currentCaseIds:cases.filter((item)=>item.status==="running").map((item)=>item.caseId),cases};
}
