# 第 159 阶段：义务级检索与完整性闭环

## 结论

本阶段没有修改冻结题集或两个知识库，而是修复了回答链路中“检索已完成但完整性状态不可解释”的问题。

15 道既有混合域回归从上一阶段的 `0 answered / 14 partially_answered / 1 temporarily_unavailable`，提升为 `5 answered / 10 partially_answered / 0 temporarily_unavailable`。更重要的是：

- `partial 且 gap=0`：`9 -> 0`；
- `evidence_metadata_invalid`：`0`；
- 每个未完成义务均能落到确定的候选排序、工具不可用或无证据主张删除原因；
- B060 从两个义务均为无解释的 partial，变为两个义务均 complete、`answered`、`gap=0`；
- B046 从台账分区错误与 `gap=0`，变为 3 个义务 complete，剩余 1 个义务明确归因为 `candidate_not_ranked`。

这证明第 3 阶段已经解决域路由，本阶段主要问题确实位于义务级证据闭环和核验后状态语义，而不是知识库整体缺失。

## 实施内容

### 1. 保留逐义务的无内容诊断

可靠性报告现在保留下列计数和原因码，但不记录问题、答案、路径或正文：

- 候选数、已读数、未读数和剩余读取数；
- seed 检索状态；
- 保留的直接/归纳句段数、删除句段数；
- 已覆盖/缺失方面数；
- 核验原因与安全的校验错误详情码。

混合域合并事件会从域证据台账和合并核验报告重建这些数据，不再用全零的合并事件覆盖域内真实诊断。覆盖缺口汇总只取最终合并事件，避免同一缺口被域事件和合并事件重复统计。

### 2. 核验后定向补读

普通读取预算耗尽后，如果核验器仍确认某个证据方面缺失，系统只允许该义务额外读取一次候选，并同时要求：

- 候选显式关联缺失方面；
- 来源层级为正式页、方法页或原始资料层级；
- 候选至少具备义务匹配、标题匹配或 requirement-specific 匹配之一；
- 同一义务最多一次，不形成无限扩张。

补读后必须重新生成并重新核验；新增正文仍不足时继续 partial/none，不得强制 complete。

### 3. 无依据主张清洗与完整性重算

当核验器删除草稿中的无依据句段，但所有规划证据方面仍被保留句段覆盖时：

1. 生成器最多获得一次核验后重写机会，只能使用已读正文；
2. 如果二次核验仍删除少量延伸句，只有在“缺失方面为 0、保留句段数大于删除句段数、至少覆盖一个方面”时，才按最终清洗后的交付文本重算为 complete；
3. 重度删减、真实方面缺失或无法重写的结果仍保持 partial；
4. partial 且方面缺失为 0 时，必须生成 `unsupported_claim_removed` 缺口，不再静默通过。

### 4. 证据分区不变量

核验器产生 partial、但原摘要错误地同时声明“所有方面均覆盖且无删除句段”时，现在会把摘要重新对齐到最终交付状态，确保 covered/missing 构成合法分区。该修复消除了 `verification_aspect_partition_invalid` 后台降级和由此产生的 `partial + gap=0`。

## 冻结回归证据

### 基线

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786416664197.json`
- SHA-256：`3FCAE2E3F5F4B24AF65AD7969BCF89B402F736DA5C957CB66C080EC671322176`
- 结果：0 answered，14 partially_answered，1 temporarily_unavailable；9 个 partial 没有 coverage gap。

### 本阶段结果

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786419094415.json`
- SHA-256：`8B0E20232201CF53BF90505B69B2DA69A6E93E246BC9C3D9BBB329EE6A8F1B41`
- 代码基线提交：`a8fa95b9d5ced34a0ed93dbd882d2dbf2ff4d58f`
- 本阶段工作树差异对象：`4d4500ae3c0b2438166d8b43e4713501bbc67e46`
- 模型：resolver/planner/synthesizer/verifier 均为 `deepseek_v4_flash`
- 专业知识版本：`64d768e99f137ab149bb3f981d024b75c2dc62a6`
- 通用售前版本：`655ecd95fd1c2b6500810b26ccddc6035111b40a`
- 并发：2；总题数：15；进程失败：0；顶层 unavailable：0。

| 指标 | 基线 | 本阶段 |
|---|---:|---:|
| answered | 0 | 5 |
| partially_answered | 14 | 10 |
| temporarily_unavailable | 1 | 0 |
| partial 且 gap=0 | 9 | 0 |
| evidence_metadata_invalid | 0 | 0 |
| P50 | 55,810 ms | 69,100 ms |
| P95 | 96,039 ms | 180,013 ms |
| queue P95 | 61,516 ms | 26,926 ms |

剩余 12 个最终缺口按报告归类为：

- `tool_unavailable`：7；
- `candidate_not_ranked`：3；
- `unsupported_claim_removed`：2。

其中 B050、B051、B054、B056、B059 出现单域降级；顶层仍返回另一域已验证内容与显式 `tool_unavailable` 缺口。P95 触及 180 秒，说明完整性修复提高了模型调用量，下一阶段的发布门禁必须把延迟、单域降级和正确性同时纳入，不能只看 answered 比例。

## 自动化验证

- 聚焦测试：308 项通过；
- 全仓 TypeScript：1,957 项通过；
- Rust 知识引擎：39 项通过；
- 所有 workspace 类型检查通过；
- `git diff --check` 通过。

## 本阶段边界

- 未修改 `tests/e2e/enterprise-blind-acceptance-20260810.json`；
- 未修改 `coremail-professional` 与 `presales-general`；
- 未把旧回归集结果声明为新的独立企业验收；
- 5/15 answered 是旧混合域回归的完整性改善证据，不是企业级准确率；
- 剩余候选排序和并发超时问题进入第 5 阶段的评分、门禁与发布判定，不在本阶段通过放宽证据标准掩盖。
