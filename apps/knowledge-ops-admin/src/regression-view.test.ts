import { describe,expect,it } from "vitest";
import { regressionRunView,summarizeProgress } from "./regression-view.js";
import type { OpsJob,RegressionPlan } from "./types.js";

const plan:RegressionPlan={model:"deepseek_v4_flash",suiteCount:4,caseCount:20,suites:[{suiteId:"suite",title:"场景",cases:[{caseId:"Q1",kind:"canonical",turn:1,question:"问题一"},{caseId:"Q2",kind:"alias",turn:2,question:"问题二"}]}] as RegressionPlan["suites"]};

describe("regression run view",()=>{
  it("shows the plan before a run and consumes persisted live progress",()=>{
    expect(regressionRunView(plan,[]).progress.cases.map((item)=>item.question)).toEqual(["问题一","问题二"]);
    const result={kind:"release_quality_progress",model:"deepseek_v4_flash",totalCases:2,completedCases:1,passedCases:0,failedCases:0,currentCaseIds:["Q2"],cases:[{...plan.suites[0]!.cases[0]!,suiteId:"suite",suiteTitle:"场景",status:"completed"},{...plan.suites[0]!.cases[1]!,suiteId:"suite",suiteTitle:"场景",status:"running"}]};
    const job:OpsJob={jobId:"job",type:"regression_run",payload:{},status:"running",attempts:1,availableAt:"2026-08-06T00:00:00.000Z",result,createdAt:"2026-08-06T00:00:00.000Z",updatedAt:"2026-08-06T00:00:01.000Z"};const view=regressionRunView(plan,[job]);expect(view.activeJob?.jobId).toBe("job");expect(view.progress).toMatchObject({completedCases:1,currentCaseIds:["Q2"]});expect(summarizeProgress(view.progress.cases,"suiteId").get("suite")).toMatchObject({total:2,completed:1,running:1});
  });
});
