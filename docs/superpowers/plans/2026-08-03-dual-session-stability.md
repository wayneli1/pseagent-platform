# PSEAgent 双会话稳定性修复实施计划

日期：2026-08-03
设计：`docs/superpowers/specs/2026-08-03-dual-session-stability-design.md`

## 全局约束

- 不修改知识库文件、revision、运行中 Lunkr 服务或用户已有未提交修改。
- 不写 P02/P05 专项业务分支。
- 每个实现阶段先观察新增测试失败，再实现并验证。
- 每个阶段独立提交；提交标题与正文使用中文，正文包含“完成内容”和“验证结果”。

## 阶段 56：冻结双会话稳定性设计

**文件：**

- 新增 `docs/superpowers/specs/2026-08-03-dual-session-stability-design.md`
- 新增 `docs/superpowers/plans/2026-08-03-dual-session-stability.md`

**验证：**

```powershell
rg -n "T[B]D|T[O]DO|F[I]XME|待[定]" <两份文档>
git diff --check -- <两份文档>
```

只暂存两份文档并创建阶段 56 提交。

## 阶段 57：修复稳定性探针假通过

**文件：**

- 新增 `scripts/probe-stability-contract.ts`
- 新增 `scripts/probe-stability-contract.test.ts`
- 修改 `scripts/probe-stability.mts`

**步骤：**

1. 先写 verdict 测试，覆盖 expected scope/status mismatch。
2. 运行测试确认因 helper 不存在而失败。
3. 实现无 I/O 判定和 mismatch 汇总。
4. 让任一 mismatch 产生退出码 1。
5. 运行：

```powershell
npm exec -- vitest run scripts/probe-stability-contract.test.ts
npx tsc --noEmit --allowImportingTsExtensions --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck scripts/probe-stability.mts scripts/probe-stability-contract.ts
git diff --check
```

只暂存本阶段三个文件并创建阶段 57 提交。

## 阶段 58：让直接查询携带动态证据面术语

**文件：**

- 修改 `apps/pseagent/src/knowledge-planner.ts`
- 修改 `apps/pseagent/src/knowledge-planner.test.ts`

**步骤：**

1. 新增 direct query 缺少 aspect terms 的失败测试。
2. 保留 synthesis 查询平衡既有测试。
3. 在模式确定性收紧和对比归一化之后，按 query 的 aspectIds 追加动态 terms。
4. 不增加查询、模型调用或读页预算。
5. 运行：

```powershell
npm exec -w @pseagent/app -- vitest run src/knowledge-planner.test.ts src/prompts.test.ts
npm run typecheck -w @pseagent/app
npm run test -w @pseagent/app
npm run build -w @pseagent/app
git diff --check
```

只暂存 Planner 与测试并创建阶段 58 提交。

## 阶段 59：冻结过滤后覆盖状态修订

**文件：**

- 修改 `docs/superpowers/specs/2026-08-03-dual-session-stability-design.md`
- 修改 `docs/superpowers/plans/2026-08-03-dual-session-stability.md`

**步骤：**

1. 记录阶段 58 后两套会话的逐题状态分布与一致性。
2. 记录 P04/P05 的无正文诊断证据，区分“句段被清理”和“问题仍有缺口”。
3. 冻结过滤后按动态 aspect 重建 coverage 的充分条件与安全边界。
4. 冻结单 aspect direct query 动态术语补全规则。
5. 运行文档占位符扫描和 `git diff --check`。

只暂存两份设计/计划文档并创建阶段 59 提交。

## 阶段 60：按过滤后的证据面重建 coverage

**文件：**

- 修改 `apps/pseagent/src/coverage-verifier.ts`
- 修改 `apps/pseagent/src/coverage-verifier.test.ts`

**步骤：**

1. 先新增失败测试：全部 aspect 仍被保留句段和正式正文覆盖时，删除扩展句段后应恢复
   `complete`。
2. 新增反例：缺少任一 aspect 时保持 `partial`，全部删除时保持 `none`。
3. 对单 aspect 也输出覆盖计数。
4. 在确定性物化后仅按完整覆盖条件恢复 coverage，不恢复任何被删文本或引用。
5. 运行覆盖校验聚焦测试、PSEAgent 全量测试、类型检查、构建和
   `git diff --check`。

只暂存覆盖校验器与测试并创建阶段 60 提交。

## 阶段 61：补全单证据面直接查询术语

**文件：**

- 修改 `apps/pseagent/src/knowledge-planner.ts`
- 修改 `apps/pseagent/src/knowledge-planner.test.ts`

**步骤：**

1. 先新增单 aspect direct query 的失败测试。
2. 移除“必须映射多个 aspect”限制，复用阶段 58 的动态术语、去重与长度边界。
3. 验证 synthesis query 行为不变。
4. 运行 Planner 聚焦测试、PSEAgent 全量测试、类型检查、构建和
   `git diff --check`。

只暂存 Planner 与测试并创建阶段 61 提交。

## 阶段 62：冻结直接事实规划收敛设计

**文件：**

- 修改 `docs/superpowers/specs/2026-08-03-dual-session-stability-design.md`
- 修改 `docs/superpowers/plans/2026-08-03-dual-session-stability.md`

**步骤：**

1. 记录阶段 60、61 后两套独立会话复测的真实分布与同题一致率。
2. 记录 P03/P08/P09 的规划标签诊断，不记录知识正文。
3. 冻结能力列表 direct 模式、未请求邻近 aspect 裁剪与确定性重映射规则。
4. 冻结 direct seed topK 随 aspect 数量扩展且读页预算不变的边界。
5. 运行文档占位符扫描与 `git diff --check`。

只暂存两份设计/计划文档并创建阶段 62 提交。

## 阶段 63：收敛直接事实规划与候选窗口

**文件：**

- 修改 `apps/pseagent/src/knowledge-planner.ts`
- 修改 `apps/pseagent/src/knowledge-planner.test.ts`
- 修改 `apps/pseagent/src/agent-loop.ts`
- 修改 `apps/pseagent/src/agent-loop.test.ts`
- 按需修改 `apps/pseagent/src/prompts.ts` 与 `apps/pseagent/src/prompts.test.ts`

**步骤：**

1. 先新增失败测试，覆盖能力列表 direct 模式、未请求邻近主题裁剪、明确主题保留和
   aspect/query 连续重映射。
2. 实现通用意图组裁剪，不写业务题号、答案或页面路径。
3. 新增 direct seed topK 的 10、动态值和 20 上限测试并实现公式。
4. 运行 Planner/Agent/提示词聚焦测试、PSEAgent 全量测试、类型检查、构建和
   `git diff --check`。

只暂存本阶段实现与测试并创建阶段 63 提交。

## 阶段 64：记录规划收敛回归并冻结回退

**文件：**

- 修改 `docs/superpowers/specs/2026-08-03-dual-session-stability-design.md`
- 修改 `docs/superpowers/plans/2026-08-03-dual-session-stability.md`

**步骤：**

1. 记录阶段 63 后两套独立会话的真实分布与同题一致率。
2. 与阶段 60、61 后的双会话结果比较，明确判定为质量回归。
3. 冻结完整回退阶段 63 六个实现/测试文件、保留阶段 57–61 的边界。
4. 运行文档占位符扫描和 `git diff --check`。

只暂存两份设计/计划文档并创建阶段 64 提交。

## 阶段 65：回退不稳定的规划收敛实验

**文件：**

- 恢复 `apps/pseagent/src/knowledge-planner.ts`
- 恢复 `apps/pseagent/src/knowledge-planner.test.ts`
- 恢复 `apps/pseagent/src/agent-loop.ts`
- 恢复 `apps/pseagent/src/agent-loop.test.ts`
- 恢复 `apps/pseagent/src/prompts.ts`
- 恢复 `apps/pseagent/src/prompts.test.ts`

**步骤：**

1. 使用可审计补丁完整撤销阶段 63 对六个文件的变更，不改写 Git 历史。
2. 用 `git diff 356e3d7^ -- <六个文件>` 证明文件与阶段 63 父提交一致。
3. 运行 Planner/Agent/提示词聚焦测试、PSEAgent 全量测试、类型检查、构建和
   `git diff --check`。
4. 只暂存六个回退文件并创建阶段 65 提交。

## 阶段 66：双会话复测与验收记录

**文件：**

- 新增 `docs/verification/dual-session-stability-live-acceptance.md`

**步骤：**

1. 两套诊断会话并发复测 P02，检查正式引用与覆盖轨迹。
2. 两套独立运行时再次并发执行相同 P01–P10。
3. 对比每题 scope、status、引用数、停止原因和耗时。
4. 运行全仓 TypeScript 测试、类型检查、工作区构建和 `git diff --check`。
5. 记录修复前后结果、剩余边界和 Windows UI 验收限制，不记录回答或知识正文。
6. 只暂存验收记录并创建阶段 66 提交。

如果真实复测仍存在预期页面召回缺失，阶段 66 不得写“通过”；必须保留失败记录，回到
新的设计阶段继续修复后再验收。
