# Knowledge Engine 零停机知识发布设计

## 目标

知识修订发布期间，Lunkr 用户始终获得可用回答。候选版本只有在定向验证和 `deepseek_v4_flash` 4 组 × 5 类真实回归全部通过后，才允许写入 GitHub、构建索引并切换为线上版本。

## 核心约束

- 回归与新索引构建期间，Knowledge Engine 继续使用上一套不可变 `KnowledgeService`。
- 新专业库与通用库索引必须一起构建成功，才能原子替换内存中的服务指针。
- 构建失败不修改服务指针，健康接口显示失败目标及“旧版本仍服务”。
- 发布状态写入 PostgreSQL，浏览器只呈现事实，不自行推断阶段。
- 答案卡活动快照、Knowledge Engine 两个 Git revision 和数据库发布记录必须在发布完成前再次核对。
- GitHub 推送或线上切换后的失败通过 Git revert 恢复内容，并为恢复后的新 Git revision 生成新的不可变恢复快照；不能把旧快照 revision 与新的 revert revision 混用。

## 发布状态

`queued → running_global_regression → writing_git → pushing_github → reloading_engine → activating_snapshot → verifying_online → active`

异常路径进入 `compensating`，完成恢复后标记 `failed`；人工回滚完成后标记 `rolled_back`。

## 回归门禁

固定套件位于 `tests/regression/release-quality-suites.json`，包含四个独立连续会话。每组依次测试标准问法、同义/错别字问法、上下文追问和边界负例等五类问题，四组并行执行，总计 20 个真实 PSEAgent 调用。候选答案卡目录通过临时只读 JSON 注入；线上活动快照在门禁期间不改变。

## 管理台状态

每个页面顶部显示：

- 当前线上 release 和双知识库 revision；
- 当前发布阶段及目标 revision；
- 旧版本是否仍在回答；
- 版本对齐、切换中、异常或不可读取；
- 活动批次入口及失败恢复说明。

状态不能只依赖颜色，必须同时有中文标题、说明和阶段文本。

## 回归执行可观测性补充

- 门禁题型统一为标准问法、同义问法、口语问法、上下文追问和边界负例；题库、接口与管理台使用同一份服务端计划，避免页面文案和实际执行不一致。
- 回归开始前管理台即可展示四组二十题的完整题目、轮次和类型；执行期间 Worker 按题写入排队、执行中、通过、未通过或执行异常状态。
- 子进程输出必须流式消费，不能等整个回归结束后才落库。运行中的进度保存在作业结果中，最终质量报告仍写入 `regression_runs`。
- Worker 每 30 秒续约运行中作业；连续 5 分钟没有心跳的作业视为 Worker 已失联，自动解除锁并重新排队，避免服务或容器重启后永久停在“处理中”。
- 页面必须显示当前正在执行的问题、已完成数量和失败原因，并用文字与 `aria-live` 提示状态变化。

## 失败恢复与后台健康补充

- 修订 Agent 遇到短暂模型不可用时自动重试，最多三次，并在管理台显示尝试次数、下次重试时间和最终可操作建议。
- PostgreSQL 连接和查询设置有界超时；数据库不可用时接口返回明确的 `database_unavailable`，管理台提示后台数据未刷新，但不将其误报为知识回答失败。
