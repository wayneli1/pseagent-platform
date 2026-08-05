export type ViewName="dashboard"|"feedback"|"cards"|"regressions"|"releases"|"audit";
export type FeedbackClassification="useful"|"incorrect"|"missing"|"review_requested"|"evidence"|"correction";
export type FeedbackStatus="new"|"triaged"|"in_review"|"resolved"|"rejected";
export type ReviewProcessingStatus="queued"|"running"|"completed"|"errored";
export type ReviewVerdict="pending"|"pass"|"needs_review"|"fail";
export type ReviewWorkflowStatus="open"|"in_review"|"resolved"|"dismissed";
export interface Dashboard {feedback:Record<string,number>;answerReviews:{pendingHuman:number;passed:number;errored:number;total:number};cardsByStatus:Record<string,number>;jobs:Record<string,number>;activeReleaseId?:string;}
export interface FeedbackMeta {caseId:string;requestId:string;pseudonymousUserId:string;userDisplayName?:string;classification:FeedbackClassification;status:FeedbackStatus;answerStatus:string;scope?:string;referenceCount:number;source:string;createdAt:string;updatedAt:string;}
export interface FeedbackDetail extends FeedbackMeta {question:string;answer:string;comment:string;proposedAnswer?:string;questionId:number;answeredAt:string;answerCardMatch?:Record<string,unknown>;}
export interface AnswerReviewMeta {reviewId:string;requestId:string;pseudonymousUserId:string;userDisplayName?:string;questionPreview:string;processingStatus:ReviewProcessingStatus;verdict:ReviewVerdict;workflowStatus:ReviewWorkflowStatus;answerStatus:string;scope?:string;referenceCount:number;source:string;model:string;score?:number;defectCount:number;errorCode?:string;createdAt:string;updatedAt:string;}
export interface AnswerReviewDetail extends AnswerReviewMeta {questionId:number;question:string;answer:string;references:Array<Record<string,unknown>>;answeredAt:string;answerCardMatch?:Record<string,unknown>;answerCardActivation?:Record<string,unknown>;result?:{summary:string;defects:Array<{category:string;severity:string;summary:string;evidence:string}>;obligationChecks:Array<{obligationId:string;covered:boolean;explanation:string}>};}
export interface CardRevision {revisionId:string;cardId:string;domain:string;revision:number;status:string;content:Record<string,unknown>;createdBy:string;baseGitRevision:string;createdAt:string;updatedAt:string;}
export interface OpsJob {jobId:string;type:string;status:string;attempts:number;lockedBy?:string;errorCode?:string;createdAt:string;updatedAt:string;}
export interface RegressionRun {runId:string;status:string;totalCases:number;passedCases:number;report?:{model?:string;passed?:boolean;summary?:{averageScore?:number;p95LatencyMs?:number;safetyFailures?:number};suites?:unknown[];kinds?:unknown[]};createdAt:string;completedAt?:string;}
export interface Release {releaseId:string;professionalRevision:string;generalRevision:string;cardCatalogHash:string;status:string;createdBy:string;approvedBy:string[];createdAt:string;activatedAt?:string;}
export interface Audit {auditId:string;actorId:string;action:string;resourceType:string;resourceId:string;metadata:Record<string,unknown>;createdAt:string;}
