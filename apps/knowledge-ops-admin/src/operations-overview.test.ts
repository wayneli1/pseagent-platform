import {describe,expect,it} from "vitest";
import {deriveOperationsOverview,isAnswerReviewActionable,isFeedbackActionable} from "./operations-overview.js";
import type {AnswerReviewMeta,FeedbackMeta} from "./types.js";

describe("行动导向总览",()=>{
  it("隐藏正常通过并把失败、需复核和判断冲突排到人工队列",()=>{
    const reviews=[review("a","pass","resolved"),review("b","fail","open"),review("c","needs_review","open")] as const;
    const feedback=[feedbackItem("a","incorrect"),feedbackItem("d","missing")] as const;
    const result=deriveOperationsOverview(feedback,reviews);
    expect(result).toMatchObject({criticalFailures:1,needsHuman:1,judgementConflicts:1,automaticPasses:1});
    expect(result.actions.map((item)=>[item.requestId,item.priority])).toEqual([["b","p0"],["a","p1"],["c","p1"],["d","p2"]]);
  });
  it("不把有帮助或已关闭反馈加入人工待办",()=>expect(deriveOperationsOverview([feedbackItem("a","useful"),{...feedbackItem("b","incorrect"),status:"resolved"}],[]).actions).toEqual([]));
  it("与服务端使用相同的待处理反馈判定",()=>{expect(isFeedbackActionable(feedbackItem("a","incorrect"))).toBe(true);expect(isFeedbackActionable(feedbackItem("b","useful"))).toBe(false);expect(isFeedbackActionable({...feedbackItem("c","missing"),status:"rejected"})).toBe(false);});
  it("人工关闭后不再把自动复查列为待处理",()=>{
    expect(isAnswerReviewActionable(review("dismissed","needs_review","dismissed"))).toBe(false);
    expect(isAnswerReviewActionable(review("resolved","fail","resolved"))).toBe(false);
    expect(isAnswerReviewActionable(review("open","needs_review","open"))).toBe(true);
    expect(isAnswerReviewActionable({...review("queued","pending","open"),processingStatus:"queued"})).toBe(false);
    expect(deriveOperationsOverview([], [
      review("dismissed","needs_review","dismissed"),
      {...review("errored","pending","dismissed"),processingStatus:"errored"},
    ])).toMatchObject({needsHuman:0,reviewErrors:0,actions:[]});
  });
});

function review(requestId:string,verdict:AnswerReviewMeta["verdict"],workflowStatus:AnswerReviewMeta["workflowStatus"]):AnswerReviewMeta{return{reviewId:`review-${requestId}`,requestId,pseudonymousUserId:"a".repeat(64),questionPreview:`问题 ${requestId}`,processingStatus:"completed",verdict,workflowStatus,answerStatus:"answered",referenceCount:1,source:"lunkr_direct",model:"deepseek_v4_flash",defectCount:verdict==="pass"?0:1,createdAt:"2026-08-05T00:00:00.000Z",updatedAt:"2026-08-05T00:00:00.000Z"};}
function feedbackItem(requestId:string,classification:FeedbackMeta["classification"]):FeedbackMeta{return{caseId:`case-${requestId}`,requestId,pseudonymousUserId:"b".repeat(64),classification,status:"new",answerStatus:"answered",referenceCount:1,source:"lunkr_direct",createdAt:"2026-08-05T00:01:00.000Z",updatedAt:"2026-08-05T00:01:00.000Z"};}
