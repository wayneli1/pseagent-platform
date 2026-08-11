# 阶段 157：域执行失败与重试预算收敛

## 结论

本阶段完成了域执行失败类型化和重试所有权收敛。服务层不再对完整知识域做第二次执行；模型传输层继续负责自身的瞬时失败重试，Agent 只允许每个域最多两次语义修复生成，非法 JSON 只允许一次显式 Schema 修复。

这解决了“同一问题在多个独立修复计数器之间反复生成，直至请求总时限耗尽”的机制缺陷，但没有把仍然存在的覆盖完整性问题伪装成成功。P10 已从阶段 156 的 180,013 ms、`model_unavailable`/截止时间耗尽，收敛为 53,199 ms 内明确的 `coverage_verifier_invalid`。该剩余问题进入后续“义务驱动检索与完整性”阶段处理。

## 实现内容

- `KnowledgeAgentDetailedResult` 的不可用分支显式携带域内停止原因；域执行诊断不再依赖共享顶层 trace 推断根因。
- 删除 AnswerService 对单域完整 Agent 的二次执行。会话打开、检索、生成和验证不再因外层重跑成倍放大。
- 每个域最多使用两次语义修复生成；答案卡概念、直接回答、比较对象、结构完整性、正式边界、操作条件及引用修复共享同一预算。
- 非法动作 JSON 从最多三次模型调用收敛为“首次调用 + 一次带 Schema 原因的修复”。
- 对正式资料中已明确列举、模型仍遗漏的同组组成项，使用已读证据和对应引用做确定性投影，而不是继续自由生成。
- 区分“部署方式有哪些”与“如何执行部署”：概览型问题不再错误触发操作步骤完整性守卫。

## 定向真实链路证据

阶段 156 基线：

- P02：65,083 ms，`invalid_final`，最终守卫为 `coordinated_framework_component_missing`，不可用。
- P10：180,013 ms，`model_unavailable`，请求截止时间耗尽，不可用。

本阶段首次对照运行：

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786412933266.json`
- P02：21,977 ms，根因为 `operational_condition_missing`，证明原有操作条件守卫把概览问题误判为操作题。
- P10：53,199 ms，根因为 `coverage_verifier_invalid`；不再耗尽 180 秒总时限。

修正概览守卫后的 P02：

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-reliability-load\reliability-load-1786413200039.json`
- SHA-256：`380BC4EC1FBE5314CA85346408ADB4F9C8B76ADA8A47B3506C5CF36ABB72CEC0`
- 结果：32,638 ms，域执行 `verified`，状态 `partially_answered`，停止原因 `final`。

P02 已恢复可用，但仍是部分回答；是否满足完整回答门槛由后续完整性与验收评分阶段判定。

## 发布质量门禁

20 个既有发布质量场景均完成运行，报告在提交知识运营门禁之前已落盘：

- 报告：`C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786413734018.json`
- SHA-256：`357D37C0E0DA43041E02C6CF888F6CE1C25ABC6904A70E2FDD8E6B81DBD19109`
- 结果：16/20，平均分 0.9391，P95 68,366 ms，3 个可用性失败，1 个安全评分失败，门禁未通过。

剩余失败为：

- `QG-PRO-CANONICAL`：操作条件完整性仍未形成可发布答案；
- `QG-PRO-NEGATIVE`：验证后仍触发答案卡禁止主张，当前安全地失败关闭；
- `QG-POC-CANONICAL`：语义验证后的结构完整性仍不合格；
- `QG-GEN-CANONICAL`：答案出现门禁禁止措辞。

这些失败不能通过恢复整域重试解决，分别进入后续义务完整性、安全成品处理和验收评分阶段。运行脚本最后因环境中存在 `KNOWLEDGE_OPS_BASE_URL`、但没有 `KNOWLEDGE_OPS_RELEASE_TOKEN` 而报告 `knowledge_ops_quality_import_configuration_invalid`；该错误发生在报告写入之后，没有向知识运营服务提交数据。

## 自动化验证

- 全仓构建通过。
- 全仓类型检查通过。
- TypeScript：1942 项通过（应用 1478 项，其余工作区 464 项）。
- Rust：39 项通过。
- 定向 Agent/AnswerService：211 项通过。

## 仓库边界

本阶段只修改 `pseagent-platform`。`coremail-professional`、`presales-general` 和 `coremail-knowledge-mcp` 均未修改；现有证据不支持把剩余失败归因于知识源缺失。
