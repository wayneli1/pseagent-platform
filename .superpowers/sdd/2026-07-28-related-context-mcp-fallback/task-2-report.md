# Task 2 报告：支持性语义提示与相关信息生成

## 完成内容

- 强化知识代理提示：正文遗漏目标只能结论为“未覆盖、无法确认”；只有正文直接肯定或直接否定才能给出支持或不支持结论；未经正文确认的同义词、缩略词和等价表达不能充当证据。
- 加入量子卫星邮件协议反例、IMAP 的显式肯定/否定反例、SMTP/IMAP 的 partial 反例，以及非穷尽协议列表不得声称完整的规则。
- 将最终动作示例更新为 `coverage=none` 的 `relatedContext` 输出：目标 citations 为空，相关事实保留 1–4 个引用；最多三个相关项，顶层引用按目标后接相关项的稳定并集生成。
- 强化覆盖校验器提示，要求删除无直接证据的目标断言，同时只保留不证明目标的直接相关事实；相关引用不能提升 target coverage。
- 新增提示词消息测试，并在代理循环中脚本化量子卫星问题，验证目标为 `none`、target citations 为空、SMTP/POP3/IMAP 等事实留在单个 relatedContext 项中，解析出的正式引用进入校验证据且流程不会退化为暂时不可用。

## TDD 证据

### RED

```powershell
npm exec -w @pseagent/app -- vitest run src/prompts.test.ts
```

初始结果：2 个测试按预期失败。失败原因分别是知识代理提示尚未包含 relatedContext 输出契约和量子卫星反例，覆盖校验提示尚未重复反推断、相关事实保留与引用边界规则。

补充 partial 反例后，同一命令再次按预期失败 2 项：两个提示均缺少“SMTP 已明确支持、IMAP 未提及”的 partial 覆盖示例。

### GREEN

```powershell
npm exec -w @pseagent/app -- vitest run src/prompts.test.ts src/agent-loop.test.ts
# 2 files passed, 40 tests passed

npm run typecheck -w @pseagent/app
# tsc -p tsconfig.json --noEmit exited 0
```

`git diff --check` 无输出。

## 范围检查

- 只修改了提示词、提示词/代理循环测试和本任务报告；未引入词法或嵌入式生产硬门，也未添加运行时字符串特判。
- 未修改、暂存或提交 `docs/local-runbook.md`、`.sisyphus/`、环境或运行时数据。

## 复审修复（Task 2）

### 完成内容

- 为知识代理提示补充三个独立断言：`relatedContext` 仅允许用于 `coverage=none`、每个 statement 只能陈述正文直接确认的事实、相关事实不得声称证明被遗漏目标。删除任一提示规则都会使对应断言失败。
- 量子卫星用例的模型草稿改为故意过期的 related/top-level citation 元数据（`[99]`），以 statement 的 `[1]` 为权威来源，并断言进入 verifier 的草稿、顶层引用和正式正文证据均已归一化为 `[1]`。
- 增加量子卫星审校器返回非法 related statement 的回归：post-verifier `ReferenceRegistry.validateFinal` 必须以 `related_citation_metadata_mismatch` 拒绝并返回暂时不可用，不能静默返回该草稿。
- 移除了会固化当前响应格式的 `result.references === []` 断言；本任务只校验 verifier 草稿与证据，最终参考文献可见性留给 Task 3。

### RED / GREEN 证据

- RED（提示规则）：临时删除三个 relatedContext 规则后，`npm exec -w @pseagent/app -- vitest run src/prompts.test.ts` 失败，缺少受限相关信息契约。
- RED（归一化）：临时跳过 related/top-level citation 归一化后，`npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts` 失败 6 项，其中量子卫星用例未进入 verifier。
- RED（审校后校验）：临时跳过 audited final 校验后，同一 agent-loop 命令失败；量子卫星非法审校结果从预期的 `temporarily_unavailable` 错误地变为 `not_covered`。
- GREEN：恢复实现后执行 `npm exec -w @pseagent/app -- vitest run src/prompts.test.ts src/agent-loop.test.ts`，2 files / 41 tests passed；`npm run typecheck -w @pseagent/app` 通过；`git diff --check` 无输出。
