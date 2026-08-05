const LABELS: Readonly<Record<string,string>>={
  useful:"回答有帮助",incorrect:"答案错误",missing:"信息不完整",review_requested:"请求人工复查",evidence:"证据或引用有问题",correction:"用户提供了纠正",
  new:"待处理",triaged:"已分类",in_review:"处理中",resolved:"已解决",rejected:"已关闭",open:"待处理",dismissed:"无需处理",
  queued:"等待处理",running:"处理中",completed:"处理完成",errored:"处理异常",pending:"等待处理",pass:"复查通过",needs_review:"需要人工复核",fail:"复查未通过",
  answered:"已完整回答",partially_answered:"部分回答",failed:"处理失败",
  draft:"草稿",approved:"已批准",changes_requested:"需要修改",deprecated:"已停用",release_ready:"待发布",released:"已发布",
  active:"当前生效",superseded:"已被替代",rolled_back:"已回滚",passed:"已通过",
  enabled:"已启用",disabled:"已停用",covered:"已覆盖",
  compile_catalog:"同步答案卡",answer_review:"自动复查",regression_run:"运行回归",publish_release:"发布知识",rollback_release:"回滚发布",git_writeback:"写回知识库",
  knowledge_gap:"知识缺口",retrieval_gap:"检索缺口",planning_gap:"回答规划问题",coverage_gap:"关键信息遗漏",logic_gap:"逻辑或事实冲突",citation_gap:"引用问题",expression_gap:"表达问题",
  critical:"严重",major:"重要",minor:"一般",
  professional:"Coremail 专业库",general:"售前通用库",coremail:"Coremail 专业库",
  p0:"紧急",p1:"高",p2:"普通",p3:"低",
};

export function label(value:string):string{return LABELS[value]??value;}
export function labelWithCode(value:string):string{return `${label(value)}（${value}）`;}
export function option(value:string,current?:string):string{return`<option value="${escapeAttribute(value)}"${value===current?" selected":""}>${escapeAttribute(label(value))}</option>`;}
export function isKnownLabel(value:string):boolean{return Object.hasOwn(LABELS,value);}

function escapeAttribute(value:string):string{return value.replace(/[&<>"']/gu,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);}
