# 阶段 178：第五批盲测前可靠性硬门

## 结论

整改代码在提交 `313732598bcf94b3541c93f7549b429c18bce067` 上通过第五批全新百题冻结前的全部可靠性硬门：阶段预算故障注入、历史协议回归、独立评分器校准、当前修订检索金标、20 题发布质量门禁，以及并发 1/2/4/10 的真实负载门禁。

这只证明当前版本具备进入下一批独立盲测的资格，不等于已经达到企业级最终验收。最终结论必须由冻结后不改代码、不改题目、不改评分器的第五批 100 题三轮冷启动结果给出。

## 固定身份

| 项目 | 固定值 |
| --- | --- |
| 平台仓库 | `pseagent-platform` 的隔离可靠性工作区 |
| 分支 | `fix/100题可靠性整改-第二阶段` |
| 运行时代码提交 | `313732598bcf94b3541c93f7549b429c18bce067` |
| 专业知识 revision | `64d768e99f137ab149bb3f981d024b75c2dc62a6` |
| 通用知识 revision | `655ecd95fd1c2b6500810b26ccddc6035111b40a` |
| Knowledge Engine | `http://127.0.0.1:19849`，两库 lexical/graph 均 ready，未服务 previous version |
| 模型 | resolver/planner/synthesizer/verifier 均为 `deepseek_v4_flash` |
| 控制面 | `PSE_RELIABILITY_CONTROL_PLANE_ENABLED=true` |
| 缓存 | `PSE_QUALIFIED_CACHE_ENABLED=false`，冷缓存模式 |
| 调度器 | 最大并发 4、队列容量 32、排队超时 60,000 ms |

所有真实运行均删除 Knowledge Ops 导入变量，未写入外部评审、反馈或发布状态。

## 硬门结果

| 硬门 | 结果 | 报告 | SHA-256 |
| --- | --- | --- | --- |
| 阶段预算故障注入 | 6/6，通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-stage-budget-fault-injection\stage-budget-fault-injection-1786508876241.json` | `1d867ce565c10906dcf64045483714c93e7c124d4227f69b4c2537e86e1b18d1` |
| 历史协议回归 | 2 个 suite、48/48，通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-historical-regression\historical-regression-1786508874904.json` | `0008dc503cbd6d65e6dd78c64f112561c67d32bd532411bd5107665c27d6e076` |
| 独立评分器校准 | 3 个 suite、53/53，通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-scorer-calibration\scorer-calibration-1786508874925.json` | `831db1362d5b005f10ff828212375116322405333232bb022bc7a9236447c3c0` |
| 当前修订检索金标 | 59/60，召回率 98.33%，可用率 100%，通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-current-retrieval-gold\retrieval-gold-1786508877243.json` | `193eb4575d78e5d70d9206437fa4d02c6f55bc23dabedf254605309b1614968e` |
| 发布质量门禁 | 20/20，平均分 1.0，安全/可用性失败均为 0，通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786509039701.json` | `7e5e7683fe75a658bc3a42a52c337969e938ef6a512eab95209d777d16d14e10` |
| 可靠性负载门禁 | 40/40，12 个硬门全部通过 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786509518288.json` | `276f35e8d623c86fe7c970705272537f2281d7e743ddf83bc798d7957f3eaad5` |

检索金标唯一未召回项仍为冻结样本 `RG001`；专业域召回率 96.67%，通用域召回率 100%。总召回率和可用率均超过当前发布门槛，且未出现相对前一轮的新退化。

## 负载明细

| 到达并发 | 成功 | P50 | P95/P99 | queue P95 | stop reason |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 10/10 | 21,832 ms | 37,055 ms | 0 ms | `final=10` |
| 2 | 10/10 | 17,450 ms | 25,003 ms | 0 ms | `final=10` |
| 4 | 10/10 | 19,970 ms | 30,936 ms | 0 ms | `final=10` |
| 10 | 10/10 | 49,103 ms | 61,817 ms | 27,507 ms | `final=10` |

四档成功率均为 100%，高于 99.5% 门槛；所有 P95 低于 120 秒，所有 P99 低于 180 秒。并发 10 的排队 P95 低于 60 秒队列超时，没有无界排队或暂时不可用。

## 一次失败如何暴露验收器缺陷

第一次提交态负载运行没有显式设置新增的 `PSE_RELIABILITY_CONTROL_PLANE_ENABLED=true`。旧探针仍创建 runtime，导致任务规格保护失败后走 legacy planner；并发 10 的 `P10` 在只剩约 14 秒的义务编译预算内被中止，最终为 9/10：

- 失败报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786508531151.json`
- SHA-256：`3fe182ed3dd09fdef1b3cb2518b0c2472815b0688ce07a3eaee53b5a35bf7f21`
- 失败题：`P10`
- 根停止原因：`model_unavailable`
- 具体阶段：planner `plan` 调用被阶段信号中止；此前 compile 已生成 `protected_fact_not_direct` 保护问题

该失败不能归因成“模型随机抖动”，因为运行的并不是要验收的新控制面。真正缺陷是负载探针没有校验运行身份。提交 `3137325` 增加了启动前失败关闭合同：

1. 未启用确定性可靠控制面时拒绝运行；
2. qualified cache 开启时拒绝运行；
3. 负载和发布报告写入 `controlPlaneEnabled=true` 与 `cacheMode=disabled`；
4. 校验发生在创建 runtime 和首次模型调用之前。

纠正环境后的同一四档负载为 40/40，说明此次差异来自运行身份而不是通过反复抽样挑选较好结果。失败报告保留，不被成功报告覆盖。

## 代码验证

- 平台 TypeScript 工作区测试共 2,121 项通过；知识引擎 Rust 测试共 42 项通过。
- 全仓 TypeScript 类型检查通过。
- `git diff --check` 通过。
- 发布门禁报告顶层记录 `controlPlaneEnabled=true`、`cacheMode=disabled`。
- 负载报告绑定提交 `313732598bcf94b3541c93f7549b429c18bce067`，并记录两库 revision、四角色模型与调度器身份。

## 仓库边界

- 本阶段只修改并提交 `pseagent-platform-reliability` 工作区所对应的平台仓库。
- 没有修改原始 `pseagent-platform` 工作区。
- 没有修改 `coremail-professional` 或 `presales-general` 知识仓库。

## 下一阶段约束

1. 创建第五套恰好 100 题、从未运行且与历史题、答案卡问法、回归题和前四批盲测归一化去重的矩阵。
2. 同时冻结题目、评分合同、矩阵哈希、排除集哈希、知识 revision、模型、调度器、控制面和冷缓存身份。
3. 冻结提交推送并确认工作区清洁后，连续运行三轮冷启动，共 300 次真实回答。
4. 三轮期间禁止改代码、知识、题目、同义词、阈值和评分器；任何失败先形成最终结论，不能边测边修。
