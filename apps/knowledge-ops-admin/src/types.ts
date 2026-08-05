export type ViewName="dashboard"|"feedback"|"cards"|"regressions"|"releases"|"audit";
export interface Dashboard {feedback:Record<string,number>;cardsByStatus:Record<string,number>;jobs:Record<string,number>;activeReleaseId?:string;}
export interface FeedbackMeta {caseId:string;requestId:string;pseudonymousUserId:string;userDisplayName?:string;classification:string;status:string;answerStatus:string;scope?:string;referenceCount:number;source:string;createdAt:string;updatedAt:string;}
export interface FeedbackDetail extends FeedbackMeta {question:string;answer:string;comment:string;proposedAnswer?:string;questionId:number;answeredAt:string;answerCardMatch?:Record<string,unknown>;}
export interface CardRevision {revisionId:string;cardId:string;domain:string;revision:number;status:string;content:Record<string,unknown>;createdBy:string;baseGitRevision:string;createdAt:string;updatedAt:string;}
export interface OpsJob {jobId:string;type:string;status:string;attempts:number;lockedBy?:string;errorCode?:string;createdAt:string;updatedAt:string;}
export interface RegressionRun {runId:string;status:string;totalCases:number;passedCases:number;report?:{model?:string;passed?:boolean;summary?:{averageScore?:number;p95LatencyMs?:number;safetyFailures?:number};suites?:unknown[];kinds?:unknown[]};createdAt:string;completedAt?:string;}
export interface Release {releaseId:string;professionalRevision:string;generalRevision:string;cardCatalogHash:string;status:string;createdBy:string;approvedBy:string[];createdAt:string;activatedAt?:string;}
export interface Audit {auditId:string;actorId:string;action:string;resourceType:string;resourceId:string;metadata:Record<string,unknown>;createdAt:string;}
