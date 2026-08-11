# 阶段 156：可靠性根因诊断闭环

## 结论

阶段一已经把外层 `domain_execution_unavailable` 继续分解到域、阶段和内层停止原因，并把同一份脱敏诊断摘要接入百题盲测、发布质量门禁和负载探针。诊断摘要不包含问题、回答、查询词、资料路径或模型推理。

单并发定向复现证明，历史上同样表现为“域执行不可用”的 P02、P10 实际不是同一种故障：

- P02 打开专业知识会话成功，读取 10 个候选中的 3 页，完成 5 次合成调用，最终因 `coordinated_framework_component_missing` 在两次结构修复后仍不完整，以 `invalid_final` 结束；本次耗时 65,083 ms。
- P10 打开专业知识会话成功，读取 20 个候选中的 3 页，覆盖门禁识别出高风险 `uncited_claim` 并要求语义验证；后续继续多轮合成/验证，最后一次合成被请求总时限中止，以 `model_unavailable`/`active_deadline_elapsed` 链路结束；本次耗时 180,013 ms。

因此阶段二应分别处理“最终结构守卫反复修复”和“高风险验证后继续生成直至总时限”两类路径，不能继续用统一延长超时或无差别重试处理。

## 实现内容

- 域 Agent 使用局部诊断追踪器，保留内层停止原因，并在域执行事件上写入 `rootReason`。
- 新增请求级可靠性诊断收集器，汇总：
  - 内层与最终停止原因；
  - 知识域、session/agent 阶段和失败原因；
  - 各模型角色的调用、尝试、排队和执行耗时；
  - 搜索、候选、读页、未读候选和剩余预算；
  - 草稿/验证覆盖、证据缺口和覆盖门禁；
  - 最终守卫、引用验证、模型载荷拒绝和 fallback。
- JSONL 诊断允许表补充 `coverage_gate`、`final_guard` 和域内 `rootReason`，未知自由文本仍会降级为 `unknown`。
- 百题、发布门禁、负载报告均持久化同一诊断摘要。
- 负载探针新增 `PSE_RELIABILITY_IDS`，支持按题号稳定复现，不再必须运行前 N 题。

## 证据

最终定向复现报告：

- 路径：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786411963141.json`
- SHA-256：`a5e05a05c01accc5ed138a843adce56cb95e03a7d11bc6d74fda8cb25cf7e1e7`
- 并发：1
- 题目：P02、P10
- 结果：0/2 可用；两题均已获得可继续修复的内部归因。

前一次验证收集器接入报告：

- 路径：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786411242989.json`
- SHA-256：`6477c9314d8783e5c1eac9f52568f0cae0941d1a8f9f6e7c29cd441af0a680b6`

## 仓库边界

本阶段只修改 `pseagent-platform`。`coremail-professional`、`presales-general` 和 `coremail-knowledge-mcp` 不修改；当前证据仍不支持把上述失败归为 `source_absent`。
