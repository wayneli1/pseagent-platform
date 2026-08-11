# 阶段 173：发布、检索与可靠性负载前置门

## 结论

进入第三套全新百题前的三项前置门均已通过：固定 20 题发布质量门通过，当前知识修订检索金标通过，并发 1/2/4/10 的可靠性负载门通过。

这些结果只证明历史发布回归、检索召回和链路负载达到预设前置条件，不证明未见问题的事实准确率、完整率、证据支持率或三次结论一致率。企业级结论仍必须等待第三套全新百题 300 次独立调用。

## 负载门禁契约补齐

原 `probe:reliability-load` 只输出统计，不产生合格判定，也不会阻断发布。本阶段按已批准的整改设计固化了自动硬门：

- 必须同时且只包含并发 1、2、4、10 四档；
- 每档成功率 ≥99.5%；
- 每档 P95 ≤120,000 ms；
- 每档 P99 ≤180,000 ms；
- 缺档、重复档、额外档或任一指标失败，整体 `qualified=false` 并返回非零退出码。

设计：`docs/superpowers/specs/2026-08-11-reliability-load-gate-design.md`。

测试先行证据：

- 新门禁不存在时，4 项测试按预期失败；
- 最小实现后 10 项通过；
- 补充“额外并发档”测试时先观察 1 项失败，再恢复校验后 11 项通过；
- 当前全部根目录 Vitest：12 个文件、83 项通过；Node 原生测试：4 项通过；
- 全部 workspace：2035 项通过；全仓类型检查与构建通过，包括 Rust 知识引擎。

门禁实现提交：`56a2500fef1c3a658acc0c4d26411563f1da393c`。

## 固定 20 题发布质量门

- 总数：20。
- 通过：20/20。
- 平均分：1。
- 安全失败：0。
- 可用性失败：0。
- P95：35,811 ms。
- P99：53,123 ms。
- 延迟门：通过。
- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786452907216.json`
- SHA-256：`1ab4f004fbcb7bc616e68d61c81bd7fb7ed5b60994579e6f11905bbdf18ac7e2`

该报告运行于提交 `5f4b463`。之后的 `56a2500` 只修改负载探针、纯评分契约、测试与设计文档，没有修改 `apps`、`packages`、`services` 或 `integrations` 的运行时代码。

## 当前修订检索金标

- 总数：60。
- 成功调用：60/60。
- 召回：59/60，98.33%。
- 专业库召回率：96.67%。
- 通用库召回率：100%。
- 未召回：`RG001`。
- 结论：达到当前金标门槛，但保留 `RG001` 为已知检索弱点，不把 59/60 写成 60/60。
- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-current-retrieval-gold\retrieval-gold-1786452918356.json`
- SHA-256：`9fd50c63a3c8036c42477cef2a50ba383063a27c2f66238280c58270d068ebc3`

## 可靠性负载门

运行提交：`56a2500fef1c3a658acc0c4d26411563f1da393c`。

| 并发 | 成功 | answered | partial | unavailable | P50 | P95 | P99 | queue P95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 10/10 | 9 | 1 | 0 | 11,770 ms | 20,145 ms | 20,145 ms | 0 ms |
| 2 | 10/10 | 9 | 1 | 0 | 12,160 ms | 38,956 ms | 38,956 ms | 0 ms |
| 4 | 10/10 | 9 | 1 | 0 | 17,479 ms | 36,522 ms | 36,522 ms | 4,834 ms |
| 10 | 10/10 | 7 | 3 | 0 | 44,787 ms | 63,259 ms | 63,259 ms | 28,239 ms |

12 个硬门全部通过，整体 `qualified=true`。并发 10 明显增加排队和部分回答数，因此负载不会被描述为“完全没有退化”；但在预设链路成功与延迟门内没有不可用、异常或超时。

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786454550520.json`
- SHA-256：`d240cb51d09e727b4fb66c4be456b078cf258887ed7bc259a616a67e96e898be`
- 执行 stdout：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load-runner\load-1786454190811.stdout.jsonl`
- stderr：0 字节。

## 冻结身份与仓库边界

- 模型：resolver、planner、synthesizer、verifier 均为 `deepseek_v4_flash`。
- 专业知识修订：`64d768e99f137ab149bb3f981d024b75c2dc62a6`。
- 通用知识修订：`655ecd95fd1c2b6500810b26ccddc6035111b40a`。
- 知识引擎两库 lexical/graph 均为 ready，未服务旧版本。
- 本阶段只修改并提交 `pseagent-platform`。
- `coremail-professional` 与 `presales-general` 工作区无改动。

## 下一步

创建第三套全新 100 题，使用评分器版本 2，在首次运行前完成题目碰撞排除、分层数量、阈值、模型、知识修订和矩阵哈希封存。封存提交推送后，连续运行三轮，每题每轮只计一次，不选最佳输出，运行期间不修改任何代码或题集。
