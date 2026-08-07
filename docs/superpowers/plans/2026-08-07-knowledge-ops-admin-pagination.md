# PSEAgent 知识运营管理后台分页实施计划

日期：2026-08-07  
对应设计：`docs/superpowers/specs/2026-08-07-knowledge-ops-admin-pagination-design.md`

## 执行纪律

1. 每阶段先验证、后提交；提交标题和正文使用中文，正文包含“完成内容”和“验证结果”。
2. 不暂存用户现有 `docs/local-runbook.md`、`.sisyphus/` 和临时自动化脚本。
3. 分页只改变列表读取和展示，不改变加密正文、详情读取、发布门禁、回滚或审计写入语义。
4. PostgreSQL 与内存 Store 必须保持筛选、排序、总数和分页边界一致。

## 阶段 143：分页设计与接口边界

- 固化五个页面内各列表的独立分页状态、每页数量和越界恢复行为。
- 固化列表接口统一 `{items,total}` 契约、原始记录服务端筛选和稳定排序。
- 固化回归固定题目展示分页与运行历史服务端分页的职责边界。

验证：设计与计划执行 `git diff --check`，确认五个页面、全部长列表和验收边界无未决项。

## 阶段 144：服务端分页与管理后台交互

- 扩展 Schema、类型、内存 Store、PostgreSQL Store、Service 和 API，使复查、反馈、待发布草稿、发布批次、回归运行、发布记录和审计事件按页读取。
- 将原始记录和待发布页面改为两套独立服务端分页；筛选变化重置页码，跨页选择和自动刷新保留状态。
- 将回归题目按 10 条展示分页，回归运行、发布回滚和审计日志按 25 条服务端分页。
- 总览改为只请求最近一条发布记录；补齐越界回退、空状态、首尾页和筛选分页测试。

验证：

- `npm run test -w @pseagent/knowledge-ops`
- `npm run test -w @pseagent/knowledge-ops-admin`
- `npm run typecheck`
- `npm run build -w @pseagent/knowledge-ops-admin`
- `git diff --check`

