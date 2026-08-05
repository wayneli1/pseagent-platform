import {describe,expect,it} from "vitest";
import {isKnownLabel,label} from "./labels.js";

describe("管理台中文状态词典",()=>{
  it.each([
    ["useful","回答有帮助"],["incorrect","答案错误"],["review_requested","请求人工复查"],
    ["queued","等待处理"],["completed","处理完成"],["needs_review","需要人工复核"],["fail","复查未通过"],
    ["triaged","已分类"],["in_review","处理中"],["resolved","已解决"],["rejected","已关闭"],
    ["assigned","已分派"],["in_progress","修订中"],["validating","待验证"],
    ["user_incorrect","用户报告答案错误"],["judgement_conflict","用户与系统判断冲突"],["review_error","自动复查异常"],
  ])("将 %s 显示为中文",(value,expected)=>{expect(label(value)).toBe(expected);expect(isKnownLabel(value)).toBe(true);});
  it("保留未知技术值以便审计排查",()=>expect(label("future_status")).toBe("future_status"));
});
