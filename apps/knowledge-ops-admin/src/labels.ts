const LABELS: Readonly<Record<string,string>>={
  useful:"回答有帮助",incorrect:"答案错误",missing:"信息不完整",review_requested:"请求人工复查",evidence:"证据或引用有问题",correction:"用户提供了纠正",
  new:"待处理",triaged:"已分类",in_review:"处理中",resolved:"已解决",rejected:"已关闭",open:"待处理",in_progress:"修订中",validating:"待验证",dismissed:"无需处理",
  queued:"等待处理",running:"处理中",completed:"处理完成",errored:"处理异常",pending:"等待处理",pass:"复查通过",needs_review:"需要人工复核",fail:"复查未通过",
  answered:"已完整回答",partially_answered:"部分回答",failed:"处理失败",
  draft:"草稿",approved:"已批准",changes_requested:"需要修改",deprecated:"已停用",release_ready:"待发布",released:"已发布",
  active:"当前生效",superseded:"已被替代",rolled_back:"已回滚",passed:"已通过",validation_case_failed:"未通过",
  generating:"正在生成草稿",draft_ready:"草稿待确认",validation_failed:"验证未通过",ready_to_publish:"验证通过，待发布",publishing:"正在发布",published:"已发布生效",
  answer_card:"答案卡",knowledge_page:"知识页面",retrieval_rule:"检索规则",system_fix:"系统修复",
  canonical:"标准问法",alias:"同义问法",colloquial:"口语问法",typo:"错别字问法",follow_up:"上下文追问",negative:"边界负例",
  direct:"直接证据",synthesis:"多证据综合",customer_input:"需客户确认",feedback_case:"用户反馈",answer_review:"自动复查",
  enabled:"已启用",disabled:"已停用",covered:"已覆盖",
  compile_catalog:"同步答案卡",reconcile_runtime:"核对线上知识版本",regression_run:"运行 4×5 真实回归",publish_release:"发布知识",rollback_release:"回滚发布",git_writeback:"写回知识库",generate_repair_draft:"生成修订草稿",validate_repair_draft:"验证修订",publish_repair:"发布修订",publish_repair_batch:"发布修订批次",rollback_repair:"回滚修订",rollback_repair_batch:"回滚修订批次",
  running_global_regression:"正在运行 4×5 真实回归",writing_git:"正在写入知识库",pushing_github:"正在同步 GitHub",reloading_engine:"正在构建新引擎索引",activating_snapshot:"正在切换答案卡",verifying_online:"正在核对线上版本",compensating:"正在恢复上一版本",
  pushing:"正在推送 GitHub",synced:"已同步 GitHub",compensated:"已补偿回滚",
  knowledge_gap:"知识缺口",retrieval_gap:"检索缺口",planning_gap:"回答规划问题",coverage_gap:"关键信息遗漏",logic_gap:"逻辑或事实冲突",citation_gap:"引用问题",expression_gap:"表达问题",
  user_incorrect:"用户报告答案错误",user_missing:"用户报告信息不完整",judgement_conflict:"用户与系统判断冲突",review_error:"自动复查异常",
  feedback:"用户反馈",
  critical:"严重",major:"重要",minor:"一般",
  professional:"Coremail 专业库",general:"售前通用库",coremail:"Coremail 专业库",
  p0:"紧急",p1:"高",p2:"普通",p3:"低",
};
const ERROR_MESSAGES:Readonly<Record<string,string>>={
  invalid_issue_transition:"问题状态由生成、验证和发布动作自动推进；管理员只能标记无需处理或重新打开",
  permission_denied:"当前账号没有执行此操作的权限",
  authentication_required:"登录已失效，请重新登录",
  invalid_credentials:"账号或密码错误，请检查后重试",
  model_unavailable:"模型服务暂时不可用，请稍后重新生成",
  model_timeout:"修订 Agent 生成内容超时，系统会按计划自动重试；若最终失败，请重新生成",
  model_request_aborted:"模型请求已取消，请重新生成",
  database_unavailable:"知识运营数据库暂时不可用，后台数据尚未刷新；用户问答服务不受此提示影响",
  management_service_timeout:"管理后台等待数据超时，请稍后刷新；用户问答服务仍会独立运行",
  management_service_unavailable:"暂时无法连接管理服务，请检查本地服务后重试",
  knowledge_revision_changed:"知识库在验证后发生了变化，请重新生成并验证草稿",
  knowledge_repository_dirty:"知识库存在未提交修改，系统为避免覆盖已停止发布",
  repair_draft_not_publishable:"当前草稿缺少正式证据或属于系统问题，不能发布为知识",
  passing_repair_validation_required:"必须先完成并通过自动验证",
  full_regression_failed_after_publish:"现有回归用例未全部通过，系统已自动恢复上一版本",
  release_quality_gate_failed:"4 组 × 5 类真实问题未全部通过；知识库和线上版本均未切换",
  knowledge_runtime_revision_mismatch:"Knowledge Engine 与当前答案卡版本不一致；旧版本仍可回答，但新修订尚未可靠生效",
  knowledge_runtime_not_ready:"Knowledge Engine 尚未完成版本切换，请稍后查看发布进度",
  knowledge_runtime_http_503:"Knowledge Engine 暂时无法执行热切换，上一版本继续服务",
  repair_publication_not_current:"只能回滚当前正在生效的最近一次修订",
  repair_batch_not_found:"没有找到该发布批次",
  repair_batch_not_ready:"批次中的修订已变化，请刷新后重新选择",
  repair_batch_target_conflict:"同一批次不能同时修改同一知识页面",
  repair_draft_not_ready_for_batch:"该修订尚未通过验证，不能加入发布批次",
  git_upstream_missing:"知识库尚未配置 GitHub 上游分支，发布已停止",
  git_remote_ahead:"GitHub 上存在本地没有的新提交，请先同步知识库再发布",
  rolled_back:"本次修订已回滚，可以重新生成草稿",
};

export function label(value:string):string{return LABELS[value]??value;}
export function labelWithCode(value:string):string{return `${label(value)}（${value}）`;}
export function option(value:string,current?:string):string{return`<option value="${escapeAttribute(value)}"${value===current?" selected":""}>${escapeAttribute(label(value))}</option>`;}
export function isKnownLabel(value:string):boolean{return Object.hasOwn(LABELS,value);}
export function errorMessage(value:string):string{if(value.startsWith("model_timeout"))return ERROR_MESSAGES.model_timeout!;if(value.startsWith("model_unavailable"))return ERROR_MESSAGES.model_unavailable!;return ERROR_MESSAGES[value]??`操作失败（${value}）`;}

export function issueStatusHelp(value:string):string{return({open:"等待后台管理员处理",in_progress:"后台管理员正在修订答案卡或知识",validating:"修订完成，等待回归验证",resolved:"修复已验证并关闭",dismissed:"误报、重复或无需处理"} as Readonly<Record<string,string>>)[value]??"";}

function escapeAttribute(value:string):string{return value.replace(/[&<>"']/gu,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);}
