# PSEAgent 证据覆盖式检索实施计划

日期：2026-07-27  
依据：`docs/superpowers/specs/2026-07-27-pseagent-evidence-coverage-retrieval-design.md`

## 1. 实施约束

- 只修改 `pseagent-platform`；两个知识库保持只读。
- 不读取或复制旧 PSEAgent 原型实现。
- 不引入 Embedding 服务、独立 Judge、Supabase、Worker、公网或知识写回。
- 只在正式结果完全 `not_covered` 时保留现有只读 Coremail MCP 兜底。
- 不停止当前 Lunkr 服务；需要重启进行最终验收时等待用户指令。
- `.env.local`、Session、运行日志和 `.sisyphus/` 不进入提交。
- 每个阶段先验证、再创建独立中文 commit。

## 2. 阶段 37：冻结根治设计

完成内容：

- 新增根治设计和本实施计划；
- 记录用户确认的无 Embedding、历史兜底、5 分钟、自身问题和引用边界；
- 明确旧首期设计中被本文修订的部分。

验证：

```powershell
git diff --check
rg -n "Embedding|not_covered|300 秒|PSEAgent 自身|资料来源" `
  docs/superpowers/specs/2026-07-27-pseagent-evidence-coverage-retrieval-design.md
```

## 3. 阶段 38：修复 PSEAgent 自身路由

主要文件：

- `apps/pseagent/src/self-context.ts`
- `apps/pseagent/src/prompts.ts`
- `apps/pseagent/src/router.ts`
- `apps/pseagent/src/router.test.ts`
- `apps/pseagent/src/answer-service.test.ts`

任务：

1. 增加受版本控制的 PSEAgent 内部自我说明；
2. 当前问题明确为 PSEAgent/当前机器人自身问题时确定性返回 `normal`；
3. 自身主体优先于 Coremail 历史上下文；
4. 普通回答提示词注入内部自我说明；
5. 证明自身问题不打开 Knowledge Session、引用为空；
6. 增加目标、架构、Lunkr、OpenClaw、知识边界等同义测试。

验证：

```powershell
npm exec -w @pseagent/app -- vitest run src/router.test.ts src/answer-service.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

## 4. 阶段 39：升级无 Embedding 检索

主要文件：

- `services/knowledge-engine/src/tokenize.rs`
- `services/knowledge-engine/src/lexical.rs`
- `services/knowledge-engine/src/graph.rs`
- `services/knowledge-engine/src/service.rs`
- `services/knowledge-engine/tests/lexical.rs`
- `services/knowledge-engine/tests/graph.rs`
- `services/knowledge-engine/tests/service.rs`
- `services/knowledge-engine/tests/real_retrieval.rs`

任务：

1. 实现带文档频率和长度归一化的 BM25；
2. 精确路径、标题、短语、正文和查询覆盖率分层加权；
3. 多字查询过滤单汉字噪声；
4. 搜索内部自动扩展一跳图谱并保留受控候选名额；
5. 使用 `purpose.md` 和受控 `schema.md` 作为导航上下文，停止发送完整 overview；
6. 增加真实知识库可选回归，验证网关 POC、Domino、镜像和多活页面召回；
7. 保持项目、revision、路径和只读边界。

验证：

```powershell
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path services/knowledge-engine/Cargo.toml
git diff --check
```

## 5. 阶段 40：增加知识问题规划

主要文件：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/knowledge-planner.ts`
- `apps/pseagent/src/prompts.ts`
- `apps/pseagent/src/answer-service.ts`
- 对应单元测试

任务：

1. 定义 subject、requirements 和 query variants 的严格 Schema；
2. 专业/通用问题在检索前调用同一主模型生成一到六个必答项；
3. 格式非法时只修复一次；
4. 禁止把 page ID 和来源编号作为首选查询；
5. 单项事实问题也产生一个 requirement；
6. 将规划结果传入知识 Agent，不改变对外 MCP Schema。

验证：

```powershell
npm exec -w @pseagent/app -- vitest run src/knowledge-planner.test.ts src/answer-service.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

## 6. 阶段 41：实现分项召回与章节证据

主要文件：

- `apps/pseagent/src/agent-loop.ts`
- `apps/pseagent/src/knowledge-session.ts`
- `apps/pseagent/src/contracts.ts`
- 对应测试

任务：

1. search/read/graph 动作绑定 requirement ID；
2. 每个 requirement 自动执行 seed queries，并使用 RRF 合并候选；
3. 候选、已读页和引用按 requirement 分开登记；
4. Markdown 按标题切分，短页读全文，长页返回最相关完整章节；
5. 动态检索预算取代固定四动作；
6. 单项无增益只结束该项，不强制其他 requirement 提前结束；
7. 总请求主动停止目标 270 秒。

验证：

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts src/knowledge-session.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

## 7. 阶段 42：增加覆盖门禁和分项引用

主要文件：

- `apps/pseagent/src/contracts.ts`
- `apps/pseagent/src/references.ts`
- `apps/pseagent/src/response.ts`
- `apps/pseagent/src/prompts.ts`
- 对应测试

任务：

1. FinalAction 增加逐 requirement coverage 和 citations；
2. 校验每个 requirement 唯一出现；
3. `complete/partial/none` 与该项实际读页绑定；
4. 顶层引用等于逐项引用并集；
5. 任一项未完整覆盖时整体不得为 `answered`；
6. 每个回答部分就近引用，末尾继续展示资料来源；
7. 保持 `partial` 不调用历史资料，只有 `not_covered` 调用。

验证：

```powershell
npm exec -w @pseagent/app -- vitest run src/references.test.ts src/response.test.ts src/answer-service.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

## 8. 阶段 43：建立真实质量回归和诊断轨迹

主要文件：

- `tests/regression/questions.json`
- `tests/regression/evidence-coverage.json`
- `apps/pseagent/src/regression.test.ts`
- `scripts/probe-live.mts`
- 新增只读检索探针和诊断日志模块

任务：

1. 把现有 40 问测试标记为协议回归；
2. 增加五题黄金集和同义改写；
3. 记录每题 scope、requirements、预期证据页、必须/禁止事实；
4. 新增固定 revision 的真实索引 Recall@10 测试；
5. 新增开发诊断模式，记录规划、查询、候选、读页、覆盖和引用；
6. 默认日志继续脱敏，不记录认证信息。

验证：

```powershell
npm run test:regression
npm test
cargo test --manifest-path services/knowledge-engine/Cargo.toml
npm run typecheck
npm run build
git diff --check
```

## 9. 阶段 44：真实模型和 Lunkr 验收

前提：等待用户允许重启当前服务。

任务：

1. 使用固定知识库 revision 和公司模型执行五题及同义改写；
2. 核对 PSEAgent 自身问题的知识调用为零；
3. 核对每个复合问题的 requirement 覆盖和引用；
4. 核对 `partial` 不触发历史资料、`not_covered` 才触发；
5. 核对每题总耗时小于 300 秒；
6. 在 Lunkr 私聊执行最终验收，生成脱敏验收记录。

验证：

```powershell
npm run probe:live
npm run lunkr:status
npm test
cargo test --manifest-path services/knowledge-engine/Cargo.toml
npm run typecheck
npm run build
git diff --check
```

## 10. 交付纪律

每个阶段报告：

- 阶段编号；
- 完整 commit 哈希；
- 中文变更摘要；
- 实际运行的验证命令和结果；
- 尚未完成的下一阶段。

