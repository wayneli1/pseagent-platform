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

## 阶段 59：双会话复测与验收记录

**文件：**

- 新增 `docs/verification/dual-session-stability-live-acceptance.md`

**步骤：**

1. 两套诊断会话并发复测 P02，检查正式引用与覆盖轨迹。
2. 两套独立运行时再次并发执行相同 P01–P10。
3. 对比每题 scope、status、引用数、停止原因和耗时。
4. 运行全仓 TypeScript 测试、类型检查、工作区构建和 `git diff --check`。
5. 记录修复前后结果、剩余边界和 Windows UI 验收限制，不记录回答或知识正文。
6. 只暂存验收记录并创建阶段 59 提交。

如果真实复测仍存在预期页面召回缺失，阶段 59 不得写“通过”；必须保留失败记录，回到
新的设计阶段继续修复后再验收。
