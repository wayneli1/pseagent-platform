import {describe,expect,it} from "vitest";
import {errorMessage,isKnownLabel,label} from "./labels.js";

describe("管理台中文状态词典",()=>{
  it.each([
    ["useful","回答有帮助"],["incorrect","答案错误"],["review_requested","请求人工复查"],
    ["queued","等待处理"],["completed","处理完成"],["needs_review","需要人工复核"],["fail","复查未通过"],
    ["triaged","已分类"],["in_review","处理中"],["resolved","已解决"],["rejected","已关闭"],
    ["open","待处理"],["in_progress","修订中"],["validating","待验证"],
    ["user_incorrect","用户报告答案错误"],["judgement_conflict","用户与系统判断冲突"],["review_error","自动复查异常"],
    ["draft_ready","草稿待确认"],["validation_failed","验证未通过"],["ready_to_publish","验证通过，待发布"],["published","已发布生效"],
    ["publish_repair_batch","发布修订批次"],["rollback_repair_batch","回滚修订批次"],["synced","已同步 GitHub"],["compensated","已补偿回滚"],
    ["answer_card","答案卡"],["colloquial","口语问法"],["follow_up","上下文追问"],["negative","边界负例"],["validation_case_failed","未通过"],
  ])("将 %s 显示为中文",(value,expected)=>{expect(label(value)).toBe(expected);expect(isKnownLabel(value)).toBe(true);});
  it("保留未知技术值以便审计排查",()=>expect(label("future_status")).toBe("future_status"));
  it("把业务错误翻译成可行动提示",()=>{expect(errorMessage("invalid_issue_transition")).toContain("状态由生成、验证和发布动作自动推进");expect(errorMessage("invalid_credentials")).toBe("账号或密码错误，请检查后重试");expect(errorMessage("authentication_required")).toBe("登录已失效，请重新登录");expect(errorMessage("model_timeout")).toContain("生成内容超时");expect(errorMessage("model_unavailable_503")).toContain("模型服务暂时不可用");expect(errorMessage("future_error")).toBe("操作失败（future_error）");});
});
