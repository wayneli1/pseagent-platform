# PSEAgent 结构化输出稳定性修复实施计划

日期：2026-07-29

## 目标

修复真实模型调用中常见的 `invalid_model_payload`、`invalid_final` 和
`coverage_verifier_invalid`，同时保持正式证据校验和覆盖降级的安全边界。

## 已确认范围

- 覆盖验证器只返回离散保留/删除决策，最终内容由代码从已校验草稿确定性重建。
- 非法的可选 `relatedContext` 只丢弃该条，不使整个目标回答失败。
- Schema 修复提示携带具体路径和错误码。
- 连续无效验证决策确定性降为 `not_covered`；验证器服务不可用仍关闭失败。
- 本轮不实施 Coremail MCP 文本附件。

## Task 1：主回答可选相关信息清洗

修改：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/contracts.test.ts`
- `apps/pseagent/src/agent-loop.test.ts`
- `apps/pseagent/src/agent-loop.ts`

步骤：

1. 先增加失败测试，覆盖空 citations、缺少内联 `[n]`、元数据不一致和单条字段
   非法时只删除该 relatedContext。
2. 为模型动作增加输入预处理；正式输出 Schema 仍保持每条 1–4 个引用的严格约束。
3. 最终引用元数据继续由合法内联标记确定性归一化。
4. 运行契约、引用和代理循环定向测试及类型检查。

## Task 2：覆盖验证器决策化

修改：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/contracts.test.ts`
- `apps/pseagent/src/coverage-verifier.ts`
- `apps/pseagent/src/coverage-verifier.test.ts`
- `apps/pseagent/src/prompts.ts`
- `apps/pseagent/src/prompts.test.ts`
- `apps/pseagent/src/agent-loop.ts`
- `apps/pseagent/src/agent-loop.test.ts`

步骤：

1. 先增加失败契约和回放测试：验证器输出只包含 requirement ID、目标决策、
   保留的 relatedContext 索引和固定 reason。
2. 删除验证器输出中的 answer、statement 和 citations。
3. 校验索引有序、唯一且不越界，然后从草稿原样重建目标内容、相关信息及顶层引用。
4. `not_covered` 使用确定性安全文案；不得保留目标引用。
5. 验证器无效决策连续失败后返回确定性全 `none` 结果；模型服务不可用仍抛出。
6. 修复提示加入上一次具体 Schema/决策错误，不记录正文。
7. 运行覆盖验证、提示词和代理循环测试及类型检查。

## Task 3：验证与发布

1. 运行：

   ```powershell
   npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/references.test.ts src/coverage-verifier.test.ts src/agent-loop.test.ts src/prompts.test.ts
   npm run typecheck -w @pseagent/app
   npm test
   npm run typecheck
   npm run build
   npm run test:regression
   git diff --check
   ```

2. 使用当前 `mimo-v2.5-pro` 和相同真实问题连续执行至少 20 次隔离验收：

   - 不得出现 `invalid_model_payload`、`invalid_final` 或
     `coverage_verifier_invalid`；
   - 每次均为 `professional + not_covered`；
   - 不得出现无证据的支持或不支持结论；
   - 合法 relatedContext 必须保留原始内联引用，非法可选项可被删除。

3. 不提交 `.env.local`、运行日志、原始模型响应、`docs/local-runbook.md` 或
   `.sisyphus/`。
4. 使用中文提交标题和正文，正文包含“完成内容”和“验证结果”，最后推送当前分支。
