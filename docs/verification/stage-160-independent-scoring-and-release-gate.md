# 阶段 160：独立评分与企业发布硬门禁

日期：2026-08-11

## 结论

本阶段完成了评分口径和发布门禁的工程化收口，但不据此宣称系统已经达到企业级验收。

盲测报告不再把“有返回”“事实命中”“引用存在”“回答完整”和“多次稳定”合并成一个通过率。100 题首次输出用于泛化质量，全部 300 次输出用于链路成功率、关键错误和延迟；任一硬指标失败，整批结果即为不合格，命令行以非零退出码结束。

截至本阶段开始前的最新 15 题负载报告中，P95 为 180,013 ms，高于 120,000 ms 门槛；而且新的独立 100 题尚未运行。因此当前结论仍是“未达到企业级验收”，不能因门禁代码通过测试而改写。

## 已实现内容

### 1. 分离统计分母

- 可回答问题的事实准确率只以 `expectedDisposition=answer` 的题为分母。
- 高风险事实准确率只统计高风险且可回答的题。
- 证据支持率只统计要求引用的题，安全拒答不会因为不需要引用而抬高该指标。
- 完整率只统计可回答题。
- 合理拒答率只统计证据不足或安全边界题。
- 首次 100 次和全部 300 次的链路成功率分别保留。

### 2. 收紧事实、证据和路由检查

- 必答概念除了需要出现在回答中，还必须与有效引用位于同一段落；仅在答案末尾堆放一个引用不再算证据支持。
- 所有引用编号必须存在，引用项目必须在允许范围内，修订必须与冻结运行时一致。
- 路由从“包含预期域即可”改为“实际域集合与预期域集合完全一致”，防止多跑错误知识域仍被计为正确。
- 首次输出和全部输出中的禁止主张分别统计，二者都必须为零。

### 3. 增加延迟硬门槛

- 盲测 300 次输出计算 P50、P95、P99 和最大延迟。
- P95 必须不超过 120,000 ms。
- P99 必须不超过 180,000 ms。
- 20 题发布质量门禁同步加入 P95/P99 检查；即使内容检查全部通过，只要延迟超标，发布质量门禁仍失败。

### 4. 建立最终企业发布决策

新增企业发布门禁，把以下证据逐项列为硬检查，不使用加权总分相互抵消：

- 盲测所有硬指标；
- 冻结检索集召回率不低于 95%；
- 当前历史回归相对冻结基线退化不超过 2 个百分点；
- 20 题发布质量门禁通过；
- 发布质量门禁的安全失败为零；
- 发布质量门禁的可用性失败为零；
- 发布质量门禁延迟通过。

`npm run gate:enterprise-release` 读取规范化证据文件，输出逐项决策报告；任何检查失败时进程返回非零退出码。

### 5. 兼容性和失败关闭

- 质量报告导入契约识别新的 P99 和延迟门禁字段。
- 旧版已保存报告仍可读取；新版报告只要明确记录 `latencyPassed=false` 就不能被登记为通过。
- 盲测第三轮生成最终报告后，若 `qualified=false`，运行器保留原始报告并返回失败，避免 CI 只看到“命令执行完成”。

## 验证结果

针对性验证：

```text
npm exec -- vitest run scripts/blind-acceptance-contract.test.ts scripts/enterprise-release-gate.test.ts services/knowledge-ops-worker/src/release-quality-gate.test.ts services/knowledge-ops/src/quality-import.test.ts
结果：4 个文件、24 个测试全部通过

npm run typecheck --if-present
结果：全部工作区通过
```

完整仓库验证：

```text
npm test
TypeScript：108 个测试文件、1,958 个测试全部通过
Rust：39 个测试全部通过
```

新增分母隔离测试后又执行：

```text
npm exec -- vitest run scripts/blind-acceptance-contract.test.ts scripts/enterprise-release-gate.test.ts services/knowledge-ops-worker/src/release-quality-gate.test.ts
结果：3 个文件、22 个测试全部通过

npm run typecheck --if-present
结果：全部工作区通过
```

## 仓库边界

本阶段只修改 `pseagent-platform` 整改工作树：

`C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform-reliability`

未修改 `coremail-professional`、`presales-general`、`coremail-knowledge-mcp`，也未修改原始脏工作区 `pseagent-platform`。既有 2026-08-10 盲测矩阵未被修改，并且不会再用于下一阶段的独立验收。

## 下一阶段

代码冻结后创建一套与历史题、回归题、答案卡问法及 2026-08-10 盲测题均不重复的新 100 题矩阵，封存哈希；随后在固定代码提交、固定模型和固定知识修订下运行 100 题三次，共 300 次。最终报告必须原样保留未通过项，不能边测边改。
