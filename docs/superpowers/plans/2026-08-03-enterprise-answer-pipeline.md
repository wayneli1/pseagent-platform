# PSEAgent 企业级问答链路实施计划

日期：2026-08-03  
设计：`docs/superpowers/specs/2026-08-03-enterprise-answer-pipeline-design.md`

## 全局约束

- 不修改两个知识库的文件、revision 或导入流程。
- 不写具体客户、产品、题号、答案或页面路径的生产分支。
- 保留直接事实证据边界、只读 Coremail MCP 和 Lunkr 长答案附件逻辑。
- 每阶段先增加失败测试，再实现、验证并创建独立中文 commit。
- commit 正文至少包含“完成内容”和“验证结果”。
- 只暂存本阶段文件，不暂存用户已有的 `docs/local-runbook.md` 与 `.sisyphus/`。
- 真实验收失败必须如实记录并回退，不以离线测试代替线上质量。

## 阶段 67：冻结企业级问答链路设计

**文件：**

- 新增 `docs/superpowers/specs/2026-08-03-enterprise-answer-pipeline-design.md`
- 新增 `docs/superpowers/plans/2026-08-03-enterprise-answer-pipeline.md`

**验证：**

```powershell
rg -n "T[B]D|T[O]DO|F[I]XME|待[定]" <两份文档>
git diff --check -- <两份文档>
```

只提交两份文档。

## 阶段 68：引入 ResolvedQuestion 与 TaskSpec 完整性守卫

**主要文件：**

- 新增 `apps/pseagent/src/question-resolver.ts`
- 新增 `apps/pseagent/src/question-resolver.test.ts`
- 新增 `apps/pseagent/src/task-spec.ts`
- 新增 `apps/pseagent/src/task-spec.test.ts`
- 修改 `apps/pseagent/src/contracts.ts`
- 修改 `apps/pseagent/src/prompts.ts`
- 修改 `apps/pseagent/src/answer-service.ts`
- 修改必要的 wiring、诊断与测试

**步骤：**

1. 先写 schema、追问解析回退和显式 obligation 完整性失败测试。
2. 实现 Resolver 与 TaskCompiler 接口、模型结构化输出和确定性 Guard。
3. 生成兼容 `KnowledgePlan`，阶段初期可 shadow 记录，不改变答案。
4. 让路由、规划、原问题搜索、coverage verifier 和历史门槛统一接收 standalone question。
5. 诊断增加 resolved/task-spec 计数，不记录正文。
6. 运行 PSEAgent 聚焦/全量测试、类型检查、构建和 `git diff --check`。

## 阶段 69：结构化会话状态与追问接入

**主要文件：**

- 修改 `integrations/lunkr-direct/src/conversation-store.ts`
- 修改 `integrations/lunkr-direct/src/conversation-store.test.ts`
- 修改 `integrations/lunkr-direct/src/bridge.ts`
- 修改 `integrations/lunkr-direct/src/bridge.test.ts`
- 修改 PSEAgent embedded 输入兼容层及测试

**步骤：**

1. 会话上下文只保留用户问题和已验证的结构化主题状态，不保存完整回答正文。
2. 保持相同问题重复、`/new`、空闲过期、取消和重试行为。
3. 确认历史 MCP 内容不进入后续上下文。
4. 运行 Lunkr Direct 与 PSEAgent 相关测试、类型检查、构建和 `git diff --check`。

## 阶段 70：按覆盖单元协调检索

**主要文件：**

- 修改 `apps/pseagent/src/knowledge-planner.ts`
- 修改 `apps/pseagent/src/agent-loop.ts`
- 修改对应测试与诊断

**步骤：**

1. 为每个显式 obligation 创建独立覆盖单元与查询包。
2. 每个明确实体至少执行一次独立查询并获得公平候选额度。
3. 取消全局候选无条件灌入全部 requirement；增加归属过滤。
4. 摘要页缺少目标信息时沿 sources/related 读取详细页。
5. 读页预算按覆盖单元分配，仍受全局 deadline 与安全上限限制。
6. 有候选未读时记录 `retrieval_incomplete`，不得归类知识缺失。

## 阶段 71：按交付项支持多知识域

**主要文件：**

- 修改 `apps/pseagent/src/knowledge-session.ts`
- 修改 `apps/pseagent/src/answer-service.ts`
- 修改路由、契约、引用注册和对应测试

**步骤：**

1. 内部引入 per-deliverable domain assignment。
2. 同一请求可打开专业库与通用库，证据和引用继续按 project/revision 隔离。
3. 专业事实、通用方法和客户输入不能跨域证明。
4. 保持外部主 scope/status 兼容，并记录 `domainsUsed`。

## 阶段 72：实现 EvidenceLedger 与 CoverageGap

**主要文件：**

- 新增 `apps/pseagent/src/evidence-ledger.ts`
- 新增 `apps/pseagent/src/coverage-gap.ts`
- 修改 `apps/pseagent/src/contracts.ts`
- 修改 `apps/pseagent/src/agent-loop.ts`
- 修改 `apps/pseagent/src/coverage-verifier.ts`
- 修改 `apps/pseagent/src/diagnostics.ts`
- 增加对应测试

**步骤：**

1. 记录每个 obligation 的查询、候选、读页、失败类型和正式 claim。
2. verifier 返回 covered/missing obligation IDs，不用字面命中率要求固定措辞。
3. GapAnalyzer 按 input/retrieval/source/conflict/freshness/knowledge 优先级确定性归因。
4. 只有搜索成功、候选核验完成仍无支持时才允许 `knowledge`。

## 阶段 73：具体边界输出与双轴状态

**主要文件：**

- 修改 `apps/pseagent/src/response.ts`
- 修改 `apps/pseagent/src/coverage-verifier.ts`
- 修改 prompts、MCP 展示和对应测试

**步骤：**

1. 删除 `PARTIAL_LIMITATION_TEXT` 与基于正则的限制说明兜底。
2. 保留逐项 gap；全未覆盖也不得退化成单句通用文案。
3. 引入 `knowledgeCoverage + caseAssessability`，客户输入不足不自动等于知识 partial。
4. 答案按事实、对比、诊断和建议动态组织，缺口最多合并三组。

## 阶段 74：模型能力适配和角色隔离

**主要文件：**

- 修改 `apps/pseagent/src/model-client.ts`
- 修改 main/config/wiring 与对应测试

**步骤：**

1. 增加受控 `<think>`、代码围栏和 JSON 对象提取适配，再执行严格 Schema 校验。
2. 接口上分离 resolver/planner/synthesizer/verifier，初期允许共用模型配置。
3. 结构输出失败有明确 repair/fallback，不改变事实安全边界。
4. 记录模型角色、延迟和错误分类，不记录原始输出。

## 阶段 75：场景族语义回归与真实验收

**文件：**

- 新增/修改 `tests/regression` 与 PSEAgent 场景测试
- 新增 `docs/verification/enterprise-answer-pipeline-live-acceptance.md`

**场景：**

- 任意 N 个并列客户和多个交付项；
- 指代追问、主题切换、错别字和重复问题；
- 专业与通用混合问题；
- POC 客户信息不足和追问强行要求百分比；
- 真正知识缺失、有候选未读、外部来源未接入；
- 数值冲突、版本过旧和模型结构输出异常。

**验收：**

- 先固定问题比较 TaskSpec；
- 再固定 TaskSpec 比较检索；
- 最后固定 EvidenceLedger 比较多模型答案；
- 以显式 obligation 覆盖、事实支持、方向正确、缺口分类和可执行性评分，不比较逐字答案；
- 运行全仓 TypeScript/Rust 测试、类型检查、构建和 `git diff --check`；
- 真实双会话不通过时如实记录并回到新设计阶段。

