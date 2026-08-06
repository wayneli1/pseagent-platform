import type { OpsJob, RegressionPlan, RegressionProgress, RegressionProgressCase } from "./types.js";

export interface RegressionRunView {
  readonly activeJob?:OpsJob;
  readonly latestJob?:OpsJob;
  readonly progress:RegressionProgress;
}

export function regressionRunView(plan:RegressionPlan,jobs:readonly OpsJob[]):RegressionRunView{
  const regressionJobs=jobs.filter((job)=>job.type==="regression_run").sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
  const activeJob=regressionJobs.find((job)=>job.status==="queued"||job.status==="running"),latestJob=activeJob??regressionJobs[0];
  const progress=parseProgress(latestJob?.result)??emptyProgress(plan);
  return{...(activeJob===undefined?{}:{activeJob}),...(latestJob===undefined?{}:{latestJob}),progress};
}

export function summarizeProgress(cases:readonly RegressionProgressCase[],key:"suiteId"|"kind"){
  const values=new Map<string,{total:number;completed:number;passed:number;failed:number;running:number}>();
  for(const testCase of cases){const name=testCase[key],current=values.get(name)??{total:0,completed:0,passed:0,failed:0,running:0};current.total++;if(["completed","passed","failed","error"].includes(testCase.status))current.completed++;if(testCase.status==="passed")current.passed++;if(testCase.status==="failed"||testCase.status==="error")current.failed++;if(testCase.status==="running")current.running++;values.set(name,current);}
  return values;
}

function parseProgress(value:Record<string,unknown>|undefined):RegressionProgress|undefined{
  if(value?.kind!=="release_quality_progress"||!Array.isArray(value.cases))return undefined;
  return value as unknown as RegressionProgress;
}

function emptyProgress(plan:RegressionPlan):RegressionProgress{
  const cases=plan.suites.flatMap((suite)=>suite.cases.map((testCase)=>({...testCase,suiteId:suite.suiteId,suiteTitle:suite.title,status:"queued" as const})));
  return{kind:"release_quality_progress",model:plan.model,totalCases:cases.length,completedCases:0,passedCases:0,failedCases:0,currentCaseIds:[],cases};
}
