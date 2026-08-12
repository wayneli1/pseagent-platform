# 阶段 184：空草稿与混合域规划稳定性

## 结论

同一代码、模型和知识版本下，B053 连续运行出现 `partial / answered / answered`，证明结构合法并不代表生成完整。进一步拆分出两类模型波动：

1. 已读到正式证据且存在必答绑定，但某个域返回合法的空 claims 数组；
2. 模型任务规格漏掉问题中确定存在的一个知识域。

本阶段分别增加受预算约束的空草稿重试和确定性混合域补全。验证后仍观察到“模型生成了 claim、但验证后整域没有可发布 claim”的第三类波动，已保留为下一阶段任务，没有把本阶段描述为完全解决。

## 空草稿治理

仅当以下条件同时满足时重试一次：

- 草稿 JSON 结构合法但 claims 为空；
- 对应域已经读到正式证据；
- 绑定不是答案卡 `answerTemplate`；
- 请求阶段未超时；
- 开放式模型调用总预算仍有容量。

没有正式证据时不重试。第二次仍为空时，只对低风险义务投影精确正式证据段落；高风险义务仍失败关闭。传输失败仍不以空草稿规则重试。

## 混合域补全

当问题的确定性技术证据信号和售前治理信号同时成立时，原子契约必须覆盖：

```text
coremail-professional + presales-general
```

不再要求模型任务规格预先正确列出两个域。缺失域仍只添加到最匹配的一个原子，不把两个域复制到每个义务。

## 验证证据

```text
atomic-obligation.test.ts + domain-plan.test.ts + reliable-answer-pipeline.test.ts: 38 passed
@pseagent/app: 58 files, 1715 passed
npm run typecheck: passed
```

B053 修复前后的诊断证据：

- 单独运行可得到完整两域 `answered`，说明知识与检索能够覆盖问题；
- 随后关闭缓存串行运行三次，得到：

| 轮次 | 状态 | 执行域 | 引用 | 结论 |
| --- | --- | --- | ---: | --- |
| 1 | partially_answered | professional + general | 2 | 专业 claim 在验证后未发布 |
| 2 | answered | professional | 1 | 模型规划漏掉通用域 |
| 3 | answered | professional + general | 2 | 完整 |

本阶段可确定消除第 2 轮所代表的规划漏域，并对证据充分时的合法空草稿执行一次预算内重试。第 1 轮所代表的低风险验证后整域丢失仍需下一阶段治理。

## 仓库边界

- 仅修改 `pseagent-platform-reliability` 平台工作区。
- 未修改原始 `pseagent-platform` 工作区。
- 未修改 `coremail-professional` 与 `presales-general` 知识仓库。
