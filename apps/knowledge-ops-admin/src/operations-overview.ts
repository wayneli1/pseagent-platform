import type { AnswerReviewMeta,FeedbackMeta } from "./types.js";

export type ActionPriority="p0"|"p1"|"p2"|"p3";
export interface OperationsAction {requestId:string;priority:ActionPriority;reason:string;userDisplayName:string;questionPreview:string;createdAt:string;reviewId?:string;feedbackId?:string;}
export interface OperationsOverview {criticalFailures:number;needsHuman:number;judgementConflicts:number;reviewErrors:number;automaticPasses:number;actions:readonly OperationsAction[];}

const NEGATIVE=new Set<FeedbackMeta["classification"]>(["incorrect","missing","review_requested","evidence","correction"]);
const PRIORITY:Record<ActionPriority,number>={p0:0,p1:1,p2:2,p3:3};

export function isAnswerReviewActionable(review:AnswerReviewMeta):boolean{
  if(review.workflowStatus==="resolved"||review.workflowStatus==="dismissed")return false;
  return review.processingStatus==="errored"||review.verdict==="fail"||review.verdict==="needs_review"||review.workflowStatus==="in_review";
}

export function deriveOperationsOverview(feedback:readonly FeedbackMeta[],reviews:readonly AnswerReviewMeta[]):OperationsOverview{
  const reviewByRequest=new Map(reviews.map((item)=>[item.requestId,item]));
  const actionableFeedback=feedback.filter((item)=>NEGATIVE.has(item.classification)&&item.status!=="resolved"&&item.status!=="rejected");
  const judgementConflicts=actionableFeedback.filter((item)=>reviewByRequest.get(item.requestId)?.verdict==="pass").length;
  const actions=new Map<string,OperationsAction>();
  for(const review of reviews){
    if(!isAnswerReviewActionable(review))continue;
    const priority:ActionPriority=review.verdict==="fail"?"p0":review.verdict==="needs_review"?"p1":"p3";
    actions.set(review.requestId,{requestId:review.requestId,priority,reason:review.processingStatus==="errored"?"自动复查执行异常":review.verdict==="fail"?"回答未通过自动复查":"回答需要人工复核",userDisplayName:review.userDisplayName??"未获取到聊天名",questionPreview:review.questionPreview,createdAt:review.createdAt,reviewId:review.reviewId});
  }
  for(const item of actionableFeedback){
    const linked=reviewByRequest.get(item.requestId);const conflict=linked?.verdict==="pass";
    const priority:ActionPriority=item.classification==="incorrect"||conflict?"p1":"p2";
    const candidate:OperationsAction={requestId:item.requestId,priority,reason:conflict?"用户反馈与自动复查结论不一致":item.classification==="incorrect"?"用户报告答案错误":item.classification==="missing"?"用户报告信息不完整":"用户请求人工核查",userDisplayName:item.userDisplayName??"未获取到聊天名",questionPreview:linked?.questionPreview??"打开反馈查看原始问题",createdAt:item.createdAt,feedbackId:item.caseId,...(linked?{reviewId:linked.reviewId}:{})};
    const existing=actions.get(item.requestId);
    if(existing===undefined||PRIORITY[candidate.priority]<PRIORITY[existing.priority])actions.set(item.requestId,{...existing,...candidate});
    else actions.set(item.requestId,{...candidate,...existing,feedbackId:item.caseId});
  }
  return{
    criticalFailures:reviews.filter((item)=>item.verdict==="fail"&&item.workflowStatus!=="resolved"&&item.workflowStatus!=="dismissed").length,
    needsHuman:reviews.filter((item)=>item.verdict==="needs_review"&&item.workflowStatus!=="resolved"&&item.workflowStatus!=="dismissed").length,
    judgementConflicts,
    reviewErrors:reviews.filter((item)=>item.processingStatus==="errored"&&isAnswerReviewActionable(item)).length,
    automaticPasses:reviews.filter((item)=>item.verdict==="pass").length,
    actions:[...actions.values()].sort((left,right)=>PRIORITY[left.priority]-PRIORITY[right.priority]||right.createdAt.localeCompare(left.createdAt)),
  };
}
