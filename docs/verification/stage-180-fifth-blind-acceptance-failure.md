# 阶段 180：第五套全新百题冷验收失败

## 结论

第五套全新百题没有通过企业级验收。首轮完成 100/100；第二轮在完成 5/100 后，模型调用到达请求截止时间并抛出 `ModelUnavailableError: model_request_aborted`，该异常越过单题隔离边界并终止整个 Node.js 进程。运行器因此没有生成第二轮正式文件，也没有生成 300 次 observation 的最终报告。

本次结果按失败封存。不得重新运行第二轮并用新输出覆盖这次进程崩溃，也不得把第五套题在修复后重新包装为独立盲测。第五套从此只作为开发诊断集；完成修复后必须使用另一套全新冻结题集做最终验收。

## 冻结运行身份

| 项目 | 值 |
| --- | --- |
| 平台提交 / 发布 ID | `1564d976ac5b9f749cf294d1236f4a2b82d7c879` |
| 题集 SHA-256 | `bac4ab60afebb31874f1404de622587ac883141c64a94f1fde1a86ef8dde7b47` |
| 历史排除集 SHA-256 | `16492d92015b6b852e45341cf72e2b4b346dd10e46d2885b28c35fa34645676c` |
| 模型 | resolver、planner、synthesizer、verifier、consensus verifier、answer review 均为 `deepseek_v4_flash` |
| 专业知识 revision | `64d768e99f137ab149bb3f981d024b75c2dc62a6` |
| 通用知识 revision | `655ecd95fd1c2b6500810b26ccddc6035111b40a` |
| 缓存 | `cold_disabled`；首轮 100 条缓存命中合计为 0 |
| 并发 / 单题截止时间 | 4 / 180 秒 |
| scorer / policy | v3 / `policy-contract-v1` |

## 原始证据

批次目录：`%TEMP%\pseagent-blind-acceptance-fifth-bac4ab60afeb-1564d97`

| 文件 | SHA-256 | 说明 |
| --- | --- | --- |
| `batch.json` | `ccbf0512856008eda35f9bd8048ae6b0fa729ec33d24570695a332d7ac4667b8` | 冻结运行身份 |
| `round-1.json` | `2aa4f90d9457af2abec3916a890335ac35fab1059a5f77015bccd9e766c665f2` | 100 条完整首轮 observation |
| `round-1.progress.jsonl` | `4f44e229d47880097d7767d23da18d3051aaba360c3110ae55bf40a267411a4f` | 首轮追加式进度证据 |
| `round-2.progress.jsonl` | `ba0093f79fb39f17759a07887bb7750a88e7e621ad1100d8bfa300208f22a441` | 第二轮崩溃前 5 条追加式证据 |

第二轮没有 `round-2.json`，这是运行器只在整轮结束后写正式轮次文件的预期行为。不存在 `final-report.json`，因为 300 条 observation 的完整性硬门槛没有满足。

## 首轮可用性事实

| 状态 | 数量 |
| --- | ---: |
| `answered` | 47 |
| `partially_answered` | 33 |
| `not_covered` | 12 |
| `temporarily_unavailable` | 8 |

| stop reason | 数量 |
| --- | ---: |
| `final` | 92 |
| `domain_plan_invalid` | 3 |
| `unknown_unavailable` | 5 |

- P95 延迟：76,828 ms。
- P99 延迟：100,412 ms。
- 首轮缓存命中：0。
- 100 个 case ID 唯一，round、代码提交、release ID、题集哈希和两库 revision 均无漂移。

这些状态分布还不是事实准确率评分；但 8% 的临时不可用已经明显低于 99.5% 可用率门槛。即使暂不考虑答案质量，第五批也不能通过。

## 第二轮崩溃事实

第二轮完成 B038、B040、B041、B039、B042 后，在约 179 秒处终止。进程最后错误为：

```text
ModelUnavailableError: model_request_aborted
    at OpenAiCompatibleModelClient.complete (.../model-client.ts:248:40)
```

`run-blind-acceptance.mts` 已在每个 `runtime.answerDetailed` 外设置 `try/catch`，但该拒绝仍成为进程级未处理异常。这说明至少有一条并发模型异步分支在请求截止后脱离了 `answerDetailed` 的结构化等待范围；单题超时没有被可靠转换为该题的 `probe_exception` observation。

## 下一阶段准入条件

1. 用可重复的并发超时测试证明所有晚到的模型拒绝都被消费，不产生 `unhandledRejection` 或进程退出。
2. 让单题超时只失败该 observation，其他 worker 必须继续，整轮最终仍写满 100 条。
3. 分别治理 `domain_plan_invalid`、`unknown_unavailable` 与状态/覆盖偏低，不能把模型随机性当成统一解释。
4. 通过故障注入、历史回归、检索金标、发布门禁和并发负载门禁后，再冻结第六套全新 100 题。
5. 第六套在新的清洁提交上冷运行三轮，不能复用第五套题或第五套输出调门槛。

## 仓库边界

本阶段只修改 `pseagent-platform-reliability` 的验证文档。原始 `pseagent-platform` 工作区以及两个知识仓库均未修改。
