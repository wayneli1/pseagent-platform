# PSEAgent Coremail MCP 历史结果展示门禁实施计划

日期：2026-07-30
对应设计：
`docs/superpowers/specs/2026-07-30-coremail-historical-display-gate-design.md`

## Global Constraints

- 只修改 `pseagent-platform`，不修改 `coremail-knowledge-mcp` 和两个正式知识库。
- 正式知识结果始终优先，历史结果不得改变正式 `scope/status/answer/references`。
- 不新增 Embedding、第二模型 judge、公网搜索或知识写回。
- 历史结果拒绝时可以显示固定提示，但正文、来源和 URL 不得显示。
- MCP 运行失败时不得显示“已完成检索”。
- 历史正文和拒绝提示均不得进入下一轮会话上下文。
- 每个任务按 TDD 完成验证后使用中文独立提交。
- 保留用户现有 `docs/local-runbook.md` 和 `.sisyphus/`，不得暂存或提交。

## Task 1：结构化历史检索结果与展示门禁

涉及文件：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/coremail-mcp-client.ts`
- `apps/pseagent/src/coremail-mcp-client.test.ts`
- `apps/pseagent/src/answer-service.ts`
- `apps/pseagent/src/answer-service.test.ts`
- `apps/pseagent/src/main.ts`
- `apps/pseagent/src/main-wiring.test.ts`

步骤：

1. 先增加失败测试，覆盖：
   - Exchange/Coremail 问题搭配 SMC1/SMC2 附件来源；
   - 主题相关但 `confidence=low`；
   - 空来源和 `confidence=none`；
   - 相关 `medium/high` 来源；
   - MCP 运行失败不产生完成提示。
2. 定义 `HistoricalLookupResult`、`HistoricalRejectionReason` 和
   `HistoricalNotice` 严格契约。
3. 扩展原始来源 Schema，只读取相关性需要的标题、摘录、证据块和分数。
4. 实现确定性主题提取与来源相关性校验：
   - 比较问题解析全部比较对象；
   - 检查全部来源证据集合是否覆盖对象；
   - 排除附件元数据、通用流程和操作建议；
   - 非比较问题要求产品实体与目标概念共同命中。
5. 提供器返回 `display/hidden/unavailable`，不再用 `undefined` 混合语义。
6. AnswerService 在 `hidden` 时附加 `historicalNotice`，在 `display` 时附加
   `historicalAnswer`。
7. 运行定向测试、PSEAgent 类型检查和 `git diff --check`。
8. 中文提交：

```text
修复：拒绝低置信度和主题错配历史答案

完成内容：增加结构化历史检索结果和来源主题门禁，低置信度、无可靠来源及比较对象
缺失时不再附加 Coremail MCP 历史正文。

验证结果：Coremail MCP 客户端、AnswerService 和主装配定向测试通过，PSEAgent
类型检查及 git diff --check 通过。
```

## Task 2：用户提示、URL 隐藏与全局长度限制

涉及文件：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/mcp-server.ts`
- `apps/pseagent/src/mcp-server.test.ts`
- `apps/pseagent/src/coremail-mcp-client.ts`
- `integrations/lunkr-direct/src/bridge.test.ts`
- `scripts/lunkr-start.mts`

步骤：

1. 先增加失败测试，覆盖三种固定拒绝提示。
2. `formatMcpText` 在存在 `historicalNotice` 时只追加固定提示。
3. 通过门禁的历史正文执行 URL 清理和 2,000 字符段落截断。
4. 历史来源最多保留 3 条，格式化时不显示 `reference.url`。
5. 最终历史区块实行 3,000 字符硬上限。
6. Lunkr 继续只把正式 `result.answer` 写入上下文，拒绝提示不得进入。
7. 运行 PSEAgent 和 Lunkr 定向测试、类型检查、构建及 `git diff --check`。
8. 中文提交：

```text
优化：增加历史检索提示并限制展示内容

完成内容：为主题错配、低置信度和无可靠来源增加固定提示，隐藏内部 URL，并限制
历史正文、来源数量和整个历史展示区块长度。

验证结果：PSEAgent 呈现与 Lunkr 上下文隔离测试通过，相关工作区类型检查、构建及
git diff --check 通过。
```

## Task 3：真实案例、探针与完整回归

涉及文件：

- `apps/pseagent/src/coremail-historical-probe-contract.ts`
- `apps/pseagent/src/coremail-historical-probe-contract.test.ts`
- `apps/pseagent/src/layered-evidence-regression.test.ts`
- `scripts/probe-coremail-historical.mts`
- `scripts/probe-layered-evidence.mts`
- `docs/verification/coremail-historical-display-gate-live-acceptance.md`

步骤：

1. 固定 Exchange/Coremail 正式知识回归，要求正式回答并且
   `historicalAttempted=false`。
2. 历史门禁探针改用另一个明确包含 Coremail、正式知识未覆盖的问题。
3. 探针契约允许并验证 `historicalNotice`，同时保证历史正文、来源和 URL 不可见。
4. 运行：

```powershell
npm exec -w @pseagent/app -- vitest run src/coremail-historical-probe-contract.test.ts src/layered-evidence-regression.test.ts
npm run test:regression
npm run test:ts
npm run typecheck
npm run build
npm run test:rust
npm run probe:layered-evidence
npm run probe:coremail
git diff --check
```

5. 手工客户端验收仍由用户执行；自动化和真实探针结果写入验收文档。
6. 中文提交：

```text
测试：覆盖历史兜底拒绝与展示边界

完成内容：增加 Exchange/Coremail 正式知识回归、独立历史门禁探针和真实验收记录，
验证拒绝提示、URL 隐藏、长度限制及会话隔离。

验证结果：PSEAgent、Lunkr、Knowledge MCP、Knowledge Engine、固定回归和真实探针
全部通过，git diff --check 通过。
```

## Final Review Gate

- `Coremail 对比 Exchange` 由正式知识库回答，不进入历史兜底。
- SMC1/SMC2 附件不能回答 Exchange/Coremail 对比。
- `confidence=low` 不显示历史正文。
- `medium/high` 必须通过来源主题相关性门禁。
- 用户能够看见 MCP 完成但未展示的准确原因。
- 历史正文和来源不显示内部 URL。
- 正文最多 2,000 字符、来源最多 3 条、历史区块最多 3,000 字符。
- MCP 运行失败不显示完成提示。
- 历史正文和拒绝提示不进入下一轮上下文。
- 用户现有未提交文件未被纳入任何 commit。
