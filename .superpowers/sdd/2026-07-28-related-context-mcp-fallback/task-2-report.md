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
