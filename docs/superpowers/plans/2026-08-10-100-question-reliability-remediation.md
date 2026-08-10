# 百题可靠性整改实施计划

> 设计依据：`docs/superpowers/specs/2026-08-10-100-question-reliability-remediation-design.md`

**目标：** 先消除回答链路的不可用和不可归因长尾，再依次校准检索、覆盖验证与路由；只有证据审计确认正式资料不存在时才修改知识仓库；最后用全新 100 题、每题三次的冻结盲测给出企业级验收结论。

**实施方式：** 在 `pseagent-platform-reliability` worktree 的 `fix/100题可靠性整改` 分支内顺序执行。每项代码改动遵循 TDD：先新增一个能解释缺陷的失败测试并观察失败，再写最小实现并观察通过。每阶段完成仓库级验证、中文提交和推送后才进入下一阶段。不启用子任务并行，避免共享运行时、测试数据和 Git 状态相互污染。

**技术栈：** TypeScript 7、Node.js 24、Vitest 4、Zod 4、MCP、Rust knowledge-engine、PowerShell。

## 全局约束

- 不修改原始 `pseagent-platform` 主工作区和 `pseagent-platform-status-progress` worktree。
- 平台改动只提交到 `pseagent-platform` 的 `fix/100题可靠性整改` 分支。
- `coremail-professional`、`presales-general` 仅在阶段 154 确认 `source_absent` 后分别建分支、分别提交和推送。
- `coremail-knowledge-mcp` 保持只读，不增加 Jira/Wiki 写回。
- 当前 70 道问法已经暴露，只能作开发/校准集；最终 100 题必须在代码冻结后首次运行。
- 不提交 `.env.local`、模型密钥、客户原文、模型推理或未脱敏诊断。
- 每个阶段提交正文必须包含“完成内容”和“验证结果”。

## 阶段 149：冻结可执行计划

### 任务 149.1：提交本计划

**文件：**

- 新增：`docs/superpowers/plans/2026-08-10-100-question-reliability-remediation.md`

**步骤：**

1. 运行 `git diff --check`。
2. 确认 `git status --short` 只包含本计划。
3. 提交：

   ```powershell
   git add -- docs/superpowers/plans/2026-08-10-100-question-reliability-remediation.md
   git commit -m "制定百题可靠性整改实施计划" -m "完成内容：...`n`n验证结果：..."
   git push
   ```

**预期：** 阶段 149 只有文档改动，远端整改分支与本地提交一致。

## 阶段 150：链路可用性和模型编排

### 任务 150.1：建立不可增长的请求预算

**文件：**

- 新增：`apps/pseagent/src/request-budget.ts`
- 新增：`apps/pseagent/src/request-budget.test.ts`
- 修改：`apps/pseagent/src/answer-service.ts`
- 修改：`apps/pseagent/src/answer-service.test.ts`
- 修改：`apps/pseagent/src/agent-loop.ts`
- 修改：`apps/pseagent/src/agent-loop.test.ts`

**失败测试：**

1. 在 `request-budget.test.ts` 写测试，证明子阶段预算不能超过请求剩余预算，并为返回余量预留时间。
2. 在 `answer-service.test.ts` 写测试，证明路由、任务分析和知识域执行收到同一绝对截止时间，而不是各自重置超时。
3. 在 `agent-loop.test.ts` 写测试，证明剩余预算不足时不启动新的生成修复或覆盖验证调用。
4. 运行：

   ```powershell
   npm exec -w @pseagent/app -- vitest run src/request-budget.test.ts src/answer-service.test.ts src/agent-loop.test.ts
   ```

   预期：新断言失败，失败原因分别指向缺少请求预算对象、仍启动后续调用或截止时间不受约束。

**最小实现：**

1. `RequestBudget` 只保存 `startedAt`、`requestDeadlineAt`、`activeDeadlineAt` 和 `returnReserveMs`。
2. 暴露 `remainingMs()`、`canStart(minimumMs)`、`signalForStage(maximumMs)`，所有阶段信号均与调用者信号合并。
3. `AnswerService` 在入口创建一次预算并传给知识域执行。
4. `agent-loop` 在动作修复、概念修复、结构修复和验证前调用 `canStart`；不足时保留已经通过确定性证据约束的安全草稿或返回明确不可用。

**通过测试：** 重新运行同一命令，预期全部通过。

### 任务 150.2：实现有界模型调度和排队诊断

**文件：**

- 新增：`apps/pseagent/src/model-request-scheduler.ts`
- 新增：`apps/pseagent/src/model-request-scheduler.test.ts`
- 修改：`apps/pseagent/src/model-client.ts`
- 修改：`apps/pseagent/src/model-client.test.ts`
- 修改：`apps/pseagent/src/main.ts`
- 修改：`apps/pseagent/src/config.ts`
- 修改：`apps/pseagent/src/config.test.ts`
- 修改：`.env.example`

**失败测试：**

1. 证明共享调度器不会因 resolver/planner/synthesizer/verifier 使用不同 client 实例而突破总并发上限。
2. 证明队列满时立即返回 `model_queue_full`，排队超时返回 `model_queue_timeout`，调用者取消返回 `model_request_aborted`。
3. 证明释放槽位后严格跳过已取消等待者，且不会泄漏活动计数或监听器。
4. 证明配置拒绝队列长度小于并发数、排队预算大于模型预算等非法组合。
5. 运行：

   ```powershell
   npm exec -w @pseagent/app -- vitest run src/model-request-scheduler.test.ts src/model-client.test.ts src/config.test.ts
   ```

   预期：因为当前固定模块级并发 3、无队列长度/排队预算而失败。

**最小实现：**

1. `ModelRequestScheduler` 由 `createModelRoles` 创建一次并共享给四个模型角色。
2. 配置新增 `PSE_MODEL_MAX_CONCURRENCY`、`PSE_MODEL_MAX_QUEUE`、`PSE_MODEL_QUEUE_TIMEOUT_MS`，提供安全默认值并写入 `.env.example`。
3. 调度结果记录 `queuedAt`、`acquiredAt`、`queueElapsedMs`；错误码保持内容无关。
4. 删除 `model-client.ts` 中不可配置的模块级活动计数和等待数组。

**通过测试：** 重新运行同一命令，预期全部通过。

### 任务 150.3：统一重试所有权并扩展模型诊断

**文件：**

- 修改：`apps/pseagent/src/model-client.ts`
- 修改：`apps/pseagent/src/model-client.test.ts`
- 修改：`apps/pseagent/src/model-observability.ts`
- 修改：`apps/pseagent/src/model-observability.test.ts`
- 修改：`apps/pseagent/src/diagnostics.ts`
- 修改：`apps/pseagent/src/diagnostics.test.ts`
- 修改：`apps/pseagent/src/answer-service.ts`
- 修改：`apps/pseagent/src/answer-service.test.ts`

**失败测试：**

1. 传输重试只允许 408、425、429、500、502、503、504，并且下一次尝试必须能在剩余预算内完成。
2. 非瞬时 4xx、调用者取消、排队失败、无剩余预算不得重试。
3. 单域整域重试只接受明确 `retryable` 的失败，不能对验证结构错误、快照不一致或截止时间重试。
4. `model_call` 诊断包含 `attemptCount`、`queueElapsedMs`、`executionElapsedMs`、`remainingMs` 和具体错误类别。
5. 运行：

   ```powershell
   npm exec -w @pseagent/app -- vitest run src/model-client.test.ts src/model-observability.test.ts src/diagnostics.test.ts src/answer-service.test.ts
   ```

**最小实现：**

1. 模型客户端返回内部调用元数据或通过受控回调交给观测层，不把元数据暴露到最终答案。
2. 传输重试由模型客户端独占；业务层只对一次完整知识域执行的明确瞬时失败重试。
3. 重试前检查请求预算，退避时间加最小执行余量超出剩余预算时直接停止。
4. 诊断持久化白名单同步新增字段并继续过滤未知字段。

### 任务 150.4：增加可重复的负载剖面运行器

**文件：**

- 新增：`scripts/probe-reliability-load-contract.ts`
- 新增：`scripts/probe-reliability-load-contract.test.ts`
- 新增：`scripts/probe-reliability-load.mts`
- 修改：`package.json`

**失败测试：**

1. 报告聚合器必须分别输出并发 1、2、4、10 的完成数、成功率、P50/P95/P99、排队时间和停止原因。
2. 中止/未返回必须计入失败，不能从分母删除。
3. 报告必须记录 commit、模型角色名、知识修订和外部硬截止时间。

**最小实现：**

1. 运行器在单个 runtime 内施加并发，确保共享模型调度器生效。
2. 默认使用开发题集和系统临时目录，不修改知识、答案卡或反馈状态。
3. 并发 10 用于过载行为验证；若被有界拒绝，必须快速、可重试且可归因，不能长时间挂起。

### 任务 150.5：阶段验证、提交和推送

```powershell
npm exec -w @pseagent/app -- vitest run src/request-budget.test.ts src/model-request-scheduler.test.ts src/model-client.test.ts src/model-observability.test.ts src/diagnostics.test.ts src/config.test.ts src/answer-service.test.ts src/agent-loop.test.ts
npm exec -- vitest run scripts/probe-reliability-load-contract.test.ts
npm run typecheck
npm run test:ts
git diff --check
```

所有命令通过后，检查差异仅属于 `pseagent-platform`，中文提交“治理回答链路预算与模型调度”并推送。

## 阶段 151：按义务检索和来源排序

### 任务 151.1：冻结检索金标准与错误分类

**文件：**

- 新增：`tests/regression/retrieval-gold.json`
- 修改：`apps/pseagent/src/coverage-gap.ts`
- 修改：`apps/pseagent/src/coverage-gap.test.ts`
- 修改：`apps/pseagent/src/evidence-ledger.ts`
- 修改：`apps/pseagent/src/evidence-ledger.test.ts`

**失败测试：**

1. 用迁移能力、技术排障、产品边界、售前方法和证据不足样本冻结期望直接来源/禁止噪声来源。
2. 分别产生 `source_absent`、`candidate_not_recalled`、`candidate_not_ranked`、`candidate_not_read`、`evidence_insufficient`。
3. 任意未读候选存在时不得归类为 `source_absent`。

**最小实现：** 扩展证据账本和覆盖缺口分类，不改变最终用户文案，只增加安全诊断和审计字段。

### 任务 151.2：按义务和方面计算候选得分

**文件：**

- 修改：`apps/pseagent/src/agent-loop.ts`
- 修改：`apps/pseagent/src/agent-loop.test.ts`
- 修改：`apps/pseagent/src/obligation-semantics.ts`
- 修改：`apps/pseagent/src/obligation-semantics.test.ts`
- 修改：`apps/pseagent/src/diagnostics.ts`
- 修改：`apps/pseagent/src/diagnostics.test.ts`

**失败测试：**

1. 迁移产品能力题中，标题和主题直接匹配的产品资料排在 O365 前置、运营商案例和报价资料之前。
2. 每个义务独立保有候选和读取预算，宽查询命中不能无归属地污染全部义务。
3. 同分时优先顺序为正式概念/正式查询页、正式综合页、原始来源、案例/报价、历史线索。
4. 排序不依赖某个客户名或某道题的完整文本。
5. 诊断只记录路径哈希、来源级别和分数分解，不记录正文。

**最小实现：** 引入通用 `CandidateScore`，由标题主题覆盖、方面覆盖、直接性、来源等级、新鲜度和 RRF 基础分组成；每项有稳定的排序 tie-break。

### 任务 151.3：限定读取预算和停止条件

**文件：**

- 修改：`apps/pseagent/src/agent-loop.ts`
- 修改：`apps/pseagent/src/agent-loop.test.ts`

**失败测试：**

1. 某义务连续两轮无新增方面覆盖后停止扩搜，但不阻断其他义务。
2. 直接来源尚未读取时，不能用低等级宽资料耗尽全部读取预算。
3. 读取失败可在同一物理页上进行一次受预算约束的恢复，不能无限重复。

### 任务 151.4：阶段验证、提交和推送

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-gap.test.ts src/evidence-ledger.test.ts src/obligation-semantics.test.ts src/agent-loop.test.ts src/diagnostics.test.ts
npm run typecheck
npm run test:ts
git diff --check
```

通过后中文提交“按义务校准知识检索与来源排序”并推送。

## 阶段 152：覆盖验证器约束和校准

### 任务 152.1：建立不可变验证契约

**文件：**

- 修改：`apps/pseagent/src/coverage-verifier.ts`
- 修改：`apps/pseagent/src/coverage-verifier.test.ts`
- 修改：`apps/pseagent/src/agent-loop.ts`
- 修改：`apps/pseagent/src/agent-loop.test.ts`

**失败测试：**

1. 验证器新增、删除、重排义务或返回未知证据 ID 时失败关闭。
2. 验证器只能对输入片段给出 `supported`、`unsupported`、`ambiguous`，不能生成替代答案。
3. 客户输入缺失与正式知识缺失必须保持不同原因。
4. `partial -> complete` 必须由所有必需片段均有已读证据支持；`complete -> partial` 必须列出具体不支持片段。

**最小实现：** 先冻结 `VerificationEnvelope`，将义务、片段和证据 ID 哈希后传给验证器；解析后逐项比对并拒绝结构漂移。

### 任务 152.2：确定性验证优先和风险分层

**文件：**

- 新增：`apps/pseagent/src/deterministic-coverage-gate.ts`
- 新增：`apps/pseagent/src/deterministic-coverage-gate.test.ts`
- 修改：`apps/pseagent/src/agent-loop.ts`
- 修改：`apps/pseagent/src/agent-loop.test.ts`

**失败测试：**

1. 引用存在、引用已读、片段归属和显式客户待补输入可由确定性层判定。
2. 低风险且全部确定性通过时不调用语义验证器。
3. 数值承诺、版本能力、兼容性、法律/合同承诺和冲突证据必须调用语义验证器；验证器不可用时失败关闭。
4. 普通方法建议在语义验证器不可用时保留确定性安全结果，并记录降级。

### 任务 152.3：冻结校准集与混淆矩阵

**文件：**

- 新增：`tests/regression/coverage-verifier-calibration.json`
- 新增：`scripts/probe-coverage-calibration-contract.ts`
- 新增：`scripts/probe-coverage-calibration-contract.test.ts`
- 新增：`scripts/probe-coverage-calibration.mts`
- 修改：`package.json`

**失败测试：** 报告分别统计错误升级、错误降级、正确保持和三次一致率；缺少金标准或只给总通过率时拒绝生成合格结论。

### 任务 152.4：阶段验证、提交和推送

```powershell
npm exec -w @pseagent/app -- vitest run src/deterministic-coverage-gate.test.ts src/coverage-verifier.test.ts src/agent-loop.test.ts
npm exec -- vitest run scripts/probe-coverage-calibration-contract.test.ts
npm run typecheck
npm run test:ts
git diff --check
```

通过后中文提交“约束覆盖验证并建立校准门禁”并推送。

## 阶段 153：通用 POC、合同和验收路由

### 任务 153.1：冻结正反例路由集

**文件：**

- 新增：`tests/regression/routing-gold.json`
- 修改：`apps/pseagent/src/router.test.ts`

**失败测试：**

1. 产品中性的 POC 组织、验收流程、合同边界、职责分工、风险沟通和升级机制应为 `general`。
2. 明确 Coremail 产品、版本、模块、协议、接口或技术能力验证应为 `professional`。
3. 同时包含产品事实和售前方法的题不能被单一关键词吞并，必须允许 TaskSpec 多域拆分。
4. 新主题不得继承旧会话域。

### 任务 153.2：调整确定性优先级和多域边界

**文件：**

- 修改：`apps/pseagent/src/router.ts`
- 修改：`apps/pseagent/src/router.test.ts`
- 修改：`apps/pseagent/src/task-spec.ts`
- 修改：`apps/pseagent/src/task-spec.test.ts`
- 修改：`apps/pseagent/src/domain-plan.ts`
- 修改：`apps/pseagent/src/domain-plan.test.ts`

**最小实现：**

1. 在专业域判断前识别产品中性的治理交付物，但显式产品技术信号拥有更高优先级。
2. 将“POC/合同/验收”视为活动，不单独视为专业技术证据。
3. 混合交付物由 TaskSpec 分配到 `coremail-professional` 与 `presales-general`，不新增客户名硬编码。

### 任务 153.3：路由评分运行器

**文件：**

- 新增：`scripts/probe-routing-gold-contract.ts`
- 新增：`scripts/probe-routing-gold-contract.test.ts`
- 新增：`scripts/probe-routing-gold.mts`
- 修改：`package.json`

**失败测试：** 总准确率、各类召回率和混淆矩阵必须单列；任何类别样本不足时报告不合格。

### 任务 153.4：阶段验证、提交和推送

```powershell
npm exec -w @pseagent/app -- vitest run src/router.test.ts src/task-spec.test.ts src/domain-plan.test.ts
npm exec -- vitest run scripts/probe-routing-gold-contract.test.ts
npm run typecheck
npm run test:ts
git diff --check
```

通过后中文提交“纠正通用POC与验收问题路由”并推送。

## 阶段 154：真实资料缺口和高风险答案卡

### 任务 154.1：生成证据缺口审计报告

**平台文件：**

- 新增：`scripts/audit-reliability-evidence-gaps.mts`
- 新增：`scripts/audit-reliability-evidence-gaps-contract.ts`
- 新增：`scripts/audit-reliability-evidence-gaps-contract.test.ts`
- 新增：`docs/verification/100-question-evidence-gap-audit.md`
- 修改：`package.json`

**失败测试：** 只有所有检索层状态均证明无候选且金标准人工确认资料不存在时才允许输出 `source_absent`；存在未读候选、失败搜索或模糊证据时必须退回系统缺陷。

**运行：** 对阶段 151—153 后仍失败的开发题执行审计，逐条记录域、义务、候选、读取、证据、分类和建议归属仓库。

### 任务 154.2：条件式修改知识仓库

只有审计报告出现 `source_absent` 时执行：

1. 产品/技术事实进入 `coremail-professional` 独立分支；通用方法进入 `presales-general` 独立分支。
2. 先阅读各仓库 `AGENTS.md` 和现有索引，不重新上传或解析 PDF。
3. 新增失败的仓库内知识校验或索引测试，观察失败后再补最小正式知识。
4. 每个知识仓库分别运行其要求的格式、索引和测试命令。
5. 每个仓库分别中文提交和推送，提交正文写明来源、适用边界和验证结果。

若没有 `source_absent`，明确记录“本阶段无知识仓库改动”，不得为了产生提交而修改资料。

### 任务 154.3：条件式高风险答案卡

**可能的平台文件：**

- 修改：`apps/pseagent/src/answer-card-policy.ts`
- 修改：`apps/pseagent/src/answer-card.test.ts`
- 修改：经治理流程产生的答案卡目录或编译输入

只对高风险、高价值、边界稳定的问题族建卡。先写适用域、修订绑定、义务、证据、失效条件的失败测试；禁止为普通问法逐题建卡。

### 任务 154.4：阶段验证、提交和推送

```powershell
npm exec -- vitest run scripts/audit-reliability-evidence-gaps-contract.test.ts
npm exec -w @pseagent/app -- vitest run src/answer-card.test.ts src/answer-card-integration.test.ts src/regression.test.ts
npm run typecheck
npm run test:ts
git diff --check
```

平台审计和必要卡治理中文提交“审计可靠性缺口并治理高风险知识”并推送；知识仓库按任务 154.2 独立提交。

## 阶段 155：历史回归与全新百题盲测

### 任务 155.1：建立盲测防泄露和评分契约

**文件：**

- 新增：`scripts/blind-acceptance-contract.ts`
- 新增：`scripts/blind-acceptance-contract.test.ts`
- 新增：`scripts/run-blind-acceptance.mts`
- 修改：`package.json`

**失败测试：**

1. 题面规范化哈希不得与 `tests/e2e`、`tests/regression`、答案卡标准问法或当前 70 题相同。
2. 矩阵必须恰好 100 题，覆盖专业、通用、综合多域、多轮、证据不足和安全边界各层。
3. 每题必须恰好三次独立结果；中止和未返回计入失败。
4. 首次输出计算泛化，三次计算一致率；禁止挑最好一次。
5. 报告必须同时包含可用性、事实准确、完整、证据支持、合理拒答、路由和稳定性，不得以一个总分替代。
6. 模型、代码提交或知识修订在批次内漂移时整批无效。

### 任务 155.2：准备封存矩阵

**文件：**

- 新增：`tests/e2e/enterprise-blind-acceptance-20260810.json`
- 新增：`tests/e2e/enterprise-blind-acceptance-20260810.sha256`

代码冻结后再编写 100 道全新题。提交前仅运行结构、分层和去重校验，不调用 `pse_answer`。矩阵一旦首次运行即冻结，后续不得修改题面或期望来适配答案。

### 任务 155.3：运行离线、历史和发布门禁

```powershell
npm run build
npm run typecheck
npm test
npm run test:regression
npm run probe:release-quality
```

记录所有命令退出码、报告路径、代码提交、模型和知识修订。任何命令失败先归因；只允许修复测试基础设施，不能查看盲测答案后改回答逻辑。

### 任务 155.4：运行负载剖面和 300 次盲测

1. 依次运行并发 1、2、4、10 的负载剖面，保存系统临时目录报告。
2. 冻结运行时版本后执行 100 题 × 3 次真实 `pse_answer`。
3. 运行期间不提交代码、不发布知识、不修改答案卡。
4. 对 100 题首次结果做金标准评分，对三次结果做一致率评分。
5. 将脱敏原始结果摘要和统计报告写入 `docs/verification/100-question-reliability-final-acceptance.md`；完整大体积原始报告保留在临时目录并记录 SHA-256。

### 任务 155.5：阶段验证、结论、提交和推送

**文件：**

- 新增：`docs/verification/100-question-reliability-final-acceptance.md`
- 可能修改：`tests/e2e/enterprise-blind-acceptance-20260810.json`
- 可能新增：脱敏机器可读摘要

最终报告必须逐项对照设计门槛。任一门槛未达成，结论写“未达到企业级验收”，并列出可复现缺陷，不再修改本盲测集。

最终运行：

```powershell
npm exec -- vitest run scripts/blind-acceptance-contract.test.ts
npm run build
npm run typecheck
npm test
git diff --check
git status --short
```

通过后中文提交“完成百题可靠性独立验收”并推送。若结论为未通过，提交仍应保存真实报告和后续缺陷清单。

## 执行检查点

每阶段完成后向用户报告：

- 阶段号；
- 所属仓库和分支；
- 完整提交哈希；
- 中文完成摘要；
- 实际运行的验证命令、通过数和失败数；
- 推送目标；
- 下一阶段是否因审计结果需要进入其他仓库。

实施期间若发现设计范围需要实质变化，先更新设计和本计划，中文提交并推送后再继续，禁止静默改变验收口径。
