# Task 3 报告：目标覆盖状态推导与未覆盖响应格式

## 完成内容

- `deriveStatus` 只按目标 requirement 的 `coverage` 推导状态，保留第二个参数以兼容现有调用方，但不再让正式引用数量改变状态。
- `formatKnowledgeFinal` 在全部目标均未覆盖、且存在已审校相关事实及已解析正式来源时，按“正式知识库相关信息 / 覆盖结论 / 正式知识库资料来源”输出，并保持 `not_covered`。
- 没有相关信息时，仍返回精确的 `NOT_COVERED_TEXT` 和空正式引用；`formatAnswerResult` 会原样保留非空、已审校的未覆盖回答及其正式引用。
- 增加 MCP 文本分层回归，并在真实量子卫星代理循环中断言相关事实、已解析正式引用和 `not_covered` 状态同时可见。

## TDD 证据

### RED

```powershell
npm exec -w @pseagent/app -- vitest run src/response.test.ts src/mcp-server.test.ts
```

初始结果为 2 项预期失败：`complete + 0 refs` 被错误推导为 `not_covered`，且已审校相关信息的正式引用被清空。随后为 `formatAnswerResult` 增加原样保留契约，旧实现额外追加“资料来源”段，形成第 3 个预期失败。

### GREEN

```powershell
npm exec -w @pseagent/app -- vitest run src/response.test.ts src/mcp-server.test.ts src/agent-loop.test.ts
npm run typecheck -w @pseagent/app
```

结果：3 个测试文件、56 项测试通过；`tsc -p tsconfig.json --noEmit` 退出成功。

## 范围检查

- 已自审响应状态、正式来源渲染、MCP 历史分层和量子卫星端到端契约。
- 未修改、暂存或提交 `docs/local-runbook.md`、`.sisyphus/`、环境或运行时文件。
