# PSEAgent 答案卡与知识运营平台设计

日期：2026-08-05
状态：已确认，开始实施
适用仓库：`pseagent-platform`、`coremail-professional`、`presales-general`

## 1. 背景

现有在线链路已经具备问题路由、双知识域 TaskSpec、按 obligation 检索、EvidenceLedger、覆盖校验、跨域合并和 Lunkr 私聊交付，但真实四会话二十题验收仍暴露以下系统性问题：

- 知识库存在正确页面时仍可能漏召回、漏读或被其他页面挤占；
- 多问只回答一部分时，字符串级评测和输出层仍可能误判为完整；
- 覆盖校验后的字符串裁剪会留下重复段落、断裂编号和悬空连接词；
- 专业库已有 `query` 页面，但运行时没有审核状态、别名和答案卡优先级；
- 反馈、人工正确答案、知识修正、回归和发布之间没有受治理闭环；
- 现有脱敏诊断刻意不保存问题、答案、检索词和知识路径，不能直接承担人工知识运营数据源。

本设计把在线回答面和知识运营控制面分离：在线回答面只读取已发布、与固定知识 revision 绑定的答案卡编译产物；知识运营控制面负责反馈、草稿、审批、回归、Git 写回、发布和回滚。管理后台或运营数据库不可用时，不得影响现有问答链路。

## 2. 目标

1. 建立版本化答案卡契约，使相同问题和同义问题能够复用稳定的必答项、知识域、证据路径、禁答项和答案结构。
2. 答案卡只能生成或约束 TaskSpec，不得绕过当前 revision 的正式证据读取和覆盖校验。
3. 将最终答案改为 obligation 驱动的结构化 AST，统一完成句段保留、去重、排序、编号和引用渲染。
4. 扩展知识引擎元数据和检索能力，使已批准 `query` 页面、别名和问题族获得确定性优先级。
5. 保持专业事实和通用方法的物理隔离；跨域问题族只负责编排，不能成为第三个事实库。
6. 建立受控反馈入口，只有用户主动反馈或获授权抽检时才持久化原问题与回答正文。
7. 建立可视化知识运营后台，覆盖工单、答案卡、证据、审批、冲突、回归、发布、回滚和审计。
8. 每次知识发布绑定专业库 revision、通用库 revision、答案卡目录哈希和回归运行，支持无破坏回滚。
9. 保持 `deepseek_v4_flash` 作为 resolver、planner、synthesizer、verifier 和答案卡问题族分类模型。

## 3. 非目标与边界

- 不把用户反馈直接自动发布为知识；模型只能生成草稿。
- 不把答案卡当作脱离证据的全文缓存。
- 不把专业事实复制到通用知识库，也不把通用方法当作产品事实证据。
- 不重新解析专业库 PDF；继续使用已提交 Markdown。
- 不修改或接入 `coremail-knowledge-mcp` 写回能力；历史 Coremail MCP 继续保持只读和展示门禁。
- 不让 PSEAgent 在线回答依赖运营数据库、后台 Worker 或管理 Web 可用。
- 不使用 `git reset --hard` 实现知识回滚；回滚通过上一份发布清单和只读快照完成。

## 4. 总体架构

```text
Lunkr 私聊
  -> Bridge / 会话状态
  -> 精确答案卡预匹配
  -> QuestionResolver
  -> 问题族答案卡匹配
  -> 答案卡 TaskSpec 或模型 TaskSpec
  -> Guard
  -> 按 obligation 分域
  -> 专业库 / 通用库固定快照
  -> 检索、读页、EvidenceLedger
  -> 逐 obligation 覆盖校验
  -> StructuredAnswer AST
  -> 去重、合并、编号、引用
  -> Lunkr

用户反馈 / 授权抽检
  -> FeedbackCase
  -> 人工审核工作台
  -> AnswerCardRevision 草稿
  -> 领域审批
  -> 回归
  -> 隔离 Git worktree 写回
  -> 双 revision 发布清单
  -> 只读知识快照
```

## 5. 答案卡契约

知识库继续使用 `type: query`，通过 `card_schema_version` 区分可编译答案卡。只有 `review_status: approved` 的卡片进入在线卡片目录。

答案卡至少包含：

- `card_id`、`domain`、`question_family`；
- 典型问题、`aliases`、排除表达；
- 产品、版本、场景和时效适用条件；
- required obligations、evidence policy、领域归属；
- 推荐证据路径和必要来源；
- 禁答 claim；
- owner、reviewer、review due；
- regression case 标识。

答案卡命中分为：

1. `exact`：规范化问题与典型问题或别名完全相同；
2. `family`：从确定性候选中由严格 JSON 模型分类为同一问题族；
3. `partial`：只允许复用部分 obligation，仍由 TaskSpec Guard 保留用户新增要求；
4. `none`：沿用模型动态规划。

任何命中都必须满足卡片已批准、适用条件有效、卡片目录与当前知识发布清单一致。否则按未命中或 stale 处理。

## 6. 结构化答案与覆盖

最终回答不再以自由字符串数组拼接。每个保留句段必须属于一个 deliverable 和 obligation，并记录：

- statement；
- citations；
- support kind：`direct` 或 `synthesized`；
- knowledge domain；
- card id（如适用）。

覆盖状态只按 required obligation 聚合：

- 所有 required obligation 都有合法保留句段：`complete`；
- 只有部分 required obligation 有合法保留句段：`partial`；
- 全部没有合法保留句段：`none`。

用户输入不足、资料冲突、候选未读、工具不可用、知识缺失和资料过期继续使用结构化 CoverageGap 区分，不得互相伪装。

## 7. 检索与知识治理

知识引擎扩展解析以下 frontmatter：

```text
aliases
question_family
review_status
applicable_product
applicable_version
card_schema_version
owner
review_due
```

排序优先级为：精确别名、已批准 query 标题、普通页面精确标题、标签和问题族、正文 BM25、图邻接。普通历史页面在治理迁移期间不因 `pending` 被整体排除；只有答案卡激活强制要求 `approved`。

专业库 `wiki/query` 统一迁移到 `wiki/queries`。通用库 Schema 增加 `query` 类型。跨域问题族位于平台仓 `governance/question-families`，只引用两个领域的 card id。

## 8. 反馈与隐私

普通诊断继续不保存问题、答案、查询词、页面标题、路径和正文。`PseAnswerExecution` 增加内部 request id、卡片命中摘要和安全会话状态；Bridge 只短期保留最近回答收据。

Lunkr 保留原有专家型反馈命令：

```text
/feedback #12 useful
/feedback #12 incorrect <说明>
/feedback #12 missing <缺失内容>
/feedback #12 evidence <证据问题>
```

同时提供面向普通用户的快捷反馈选项。回答完成后，Bridge 单独发送一条简短反馈菜单：

```text
—
这次回答对你有帮助吗？

/q 1  回答有用
/q 2  答案错误
/q 3  缺少关键信息
/q 4  提交你认为的正确答案

选择 2、3 时可以在命令后补充说明；选择 4 时必须在命令后填写答案。
```

`/q` 默认关联当前用户最近一条仍有效的回答，也允许使用 `/q #12 ...` 明确评价旧回答。选项映射为 `useful`、`incorrect`、`missing` 和 `correction`；用户提交的候选正确答案必须与原问题、原回答一起加密保存，只能进入人工审核和答案卡草稿流程，不能自动成为线上知识。

用户提问后的即时回执采用 PSEAgent 自有的“检索并核对依据”表达，不复制其他 Agent 的任务文案：

```text
问题 #12 已收到，正在检索并核对相关资料。

处理期间可以：
/status  查看问题状态
/new     取消当前及排队问题，开始新会话
/help    查看全部使用说明
```

`/status` 返回当前用户正在处理和排队的问题编号、状态及可靠的排队位置；没有任务时明确提示可以直接提问。排队和繁忙状态继续明确告知队列位置或服务状态。

处理中的问题额外展示 PSEAgent 回答管线已经发生的、经过白名单脱敏的运行事实：处理耗时、当前流程阶段、需求项数量、已完成的资料检索项数、证据读取数、覆盖核验结果和最后更新时间。示例：

```text
问题 #12：处理中 · 已用时 1分26秒
当前阶段：核对证据

需求拆解：4 项
资料检索：已完成 4 项
证据读取：7 份
覆盖核验：3/4 项完成
最后更新：13:52:18
```

进度事实由 `DiagnosticEvent` 的安全子集经进度观察器转换后实时回传 Bridge，并以当前用户、会话代次和问题编号绑定内存快照。允许展示的阶段只有理解问题、拆解问题、检索资料、核对证据、组织回答、核验答案和准备发送；允许展示的计数只有非负累计数，不包含问题、答案、查询词、页面标题、路径、正文、模型原始载荷或思维链。Bridge 与 PeerScheduler 仍是处理中、排队和取消状态的唯一事实来源。

用户可见进度不展示百分比或预计完成时间。模型调用、补充检索、并行知识域和重试会动态改变剩余工作，固定百分比不能证明真实剩余量。流程阶段只按已经观察到的里程碑前进；尚未产生可靠数据的计数不展示。进度观察、格式化或回调失败不得改变回答路径。任务完成、失败、取消或 Bridge 重启后清除内存快照，不把运行进度写入运营数据库或诊断日志之外的持久介质。

只有反馈命令成功关联短期回答收据后，原问题、回答和用户备注才进入加密反馈存储。用户标识持久化前必须伪匿名化。查看、编辑、导出、审批和发布都写入审计事件。

## 9. 知识运营控制面

新增 `apps/knowledge-ops`、`services/knowledge-ops-worker` 和共享治理契约包。管理端采用数据密集、逐层下钻的桌面优先布局，同时保持键盘导航、可见焦点、文本状态标签、加载和错误恢复。

管理页面包括：运营总览、反馈工单、三栏审核工作台、答案卡、知识浏览、冲突与过期、回归实验室、发布中心、审计、用户与权限。

权限至少包括 viewer、operator、professional editor/reviewer、general editor/reviewer、release manager 和 admin。创建人不能成为唯一批准人；跨域问题族需要两个领域分别批准。

## 10. 发布与回滚

作者知识仓库不直接作为运行时可编辑目录。发布 Worker 在路径白名单内创建隔离 worktree，展示 Git diff、校验 Schema、提交对应仓库、运行回归，然后生成发布清单：

```json
{
  "releaseId": "KR-2026-08-001",
  "professionalRevision": "<sha>",
  "generalRevision": "<sha>",
  "answerContractRevision": "<sha>",
  "cardCatalogHash": "<sha256>",
  "regressionRunId": "<id>"
}
```

每个发布 revision 创建只读快照 worktree。知识引擎从发布专用 project config 启动，健康检查和回归通过后再切换。回滚重新激活上一份清单，不重写仓库历史。

## 11. 验收原则

- 已批准答案卡固定回归通过率 100%；
- 无直接证据的受保护事实输出为 0；
- 专业事实使用通用库正式引用为 0；
- 答案卡问题族误命中率低于 1%；
- 多问 required obligation 召回和覆盖率不低于 95%；
- 不出现整段重复、残缺编号和引用错位；
- 所有引用 revision 与发布清单一致；
- 管理后台、运营数据库和 Worker 不可用时在线问答继续工作；
- 发布和回滚完整演练通过；
- 精确卡片路径 P95 目标不超过 30 秒，普通知识路径 P95 目标不超过 90 秒；
- 用户可见硬超时逐步收敛到 120 秒以内。
- `/status` 的阶段和计数必须来自真实脱敏事件；进度回调失败、任务取消和重试不得产生陈旧状态或影响回答交付。
