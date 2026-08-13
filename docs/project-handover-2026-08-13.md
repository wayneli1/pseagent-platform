# Coremail PSEAgent 项目交接文档（2026-08-13）

## 1. 交接结论

项目目前已经具备完整的双知识库问答链路、历史 Jira/Wiki 辅助检索、答案卡治理、知识修订与发布闭环、自动化测试和百题可靠性验收工具，但回答质量尚未达到企业级最终验收标准。

接手人必须区分两条代码线：

- `pseagent-platform/main` 是当前稳定主线。本次交接前最后一个功能提交为 `9e5a2f330909427437a5461d580cd6163ff3b4fa`，应用与 Knowledge Ops Worker 测试均通过。
- `pseagent-platform/fix/100题可靠性整改-第二阶段` 是可靠性整改实验线，完整包含本机 `main`，并在其上增加 75 个提交。该分支引入确定性义务、证据和发布控制面，但第五批开发复测仍未达标，不能直接合并或宣布企业级可用。

本次交接只覆盖以下四个 Git 仓库，`AI-` 与 `motivation` 明确不在范围内：

1. `pseagent-platform`
2. `coremail-professional`
3. `presales-general`
4. `coremail-knowledge-mcp`

## 2. 仓库清单

| 仓库 | 本机目录 | 远端 | 交接时关键提交 | 用途 |
| --- | --- | --- | --- | --- |
| `pseagent-platform` | `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` | `https://github.com/wayneli1/pseagent-platform.git` | `main` 的最后功能提交 `9e5a2f3`；可靠性分支 `fec17b9` | PSEAgent、Knowledge MCP、Knowledge Engine、Knowledge Ops、Lunkr 接入、测试与验收工具 |
| `coremail-professional` | `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-professional` | `https://github.com/wayneli1/coremail-professional.git` | `64d768e` | Coremail 产品、版本、部署、迁移、安全、竞品和售前场景正式知识 |
| `presales-general` | `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general` | `https://github.com/wayneli1/presales-general.git` | `655ecd9` | 厂商无关的需求发现、价值表达、异议处理和项目推进方法 |
| `coremail-knowledge-mcp` | `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp` | `https://github.com/wayneli1/coremail-knowledge-mcp.git` | `3cbf5c9` | Jira/Wiki 历史资料只读检索与历史答案模板 |

`Coremail-PSE` 总目录本身不是 Git 仓库，也没有使用 submodule。四个仓库应分别提交、推送和回滚。

## 3. 系统架构与职责边界

```text
Lunkr 私聊 / MCP 客户端
          |
          v
       PSEAgent
          |
          +-- 专业问题 ------> coremail-professional
          |                       ^
          |                       |
          +-- 通用售前问题 --> presales-general
          |
          +-- 历史线索 ------> coremail-knowledge-mcp --> Jira / Wiki
          |
          +-- 知识治理 ------> Knowledge Ops / Worker / Admin
```

边界要求：

- 产品、功能、版本、部署、迁移和客户项目事实只能由 `coremail-professional` 正式证据支持。
- 通用售前方法只能由 `presales-general` 支持，不得反向补写 Coremail 产品事实。
- `coremail-knowledge-mcp` 提供历史 Jira/Wiki 线索；历史资料不能自动覆盖正式知识，也不能绕过展示门禁。
- 在线回答链路不得把模型先验当成正式产品事实。
- 价格、折扣、交付周期、授权边界和对外承诺仍需人工确认。
- OpenCode 正式入口只连接 `pseagent`；不要把 `coremail-knowledge-mcp` 再直接注册成第二个知识问答入口。

## 4. `pseagent-platform` 分支说明

### 4.1 `main`

当前稳定主线。交接前最后 8 个功能提交为：

```text
48276bb 修复比较问答身份错配并加入累积验收
c043d58 对齐验收复核与用户可见答案
f7d7416 稳定高置信答案卡的随机规划绑定
e2fdd7c 识别口语化任务请求并稳定答案卡激活
7f97cd4 让验收复刻线上可重试容错
eadf001 避免比较维度被重复解析为口语任务
f833be6 修复知识修订任务失败后卡死
9e5a2f3 稳定资料不足对比题的复查归类
```

这条主线更偏向现有线上行为：模型自由度较高、回答相对完整，但尚未具备可靠性整改分支的完整确定性控制面。

### 4.2 `fix/100题可靠性整改-第二阶段`

当前提交为 `fec17b95587a9888621f221a40e38cf4dbc9ba3b`。本机独立 worktree：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform-reliability
```

该分支完整包含 `main@9e5a2f3`，在其上新增 75 个提交，主要增加：

- 原子义务合同；
- 确定性知识域规划与检索；
- 结构化主张生成；
- 主张与引用程序化绑定；
- 高风险双重共识；
- 安全预检与无依据承诺拦截；
- 回答状态拆分；
- 模型并发、排队和阶段预算；
- 冷缓存百题验收、路由/检索金标和发布硬门禁。

不要直接把该分支合并进 `main`。第五批复测表明控制面当前过度保守，出现“已经检索到正式资料，但所有 claim 被发布门禁清空”的系统性退化。

详细报告位于该分支：

```text
docs/verification/stage-187-deterministic-model-stability-and-fifth-development-retest.md
```

### 4.3 其他平台分支

- `fix/100题可靠性整改`：第一阶段可靠性整改归档，当前远端已存在。
- `feature/lunkr-direct-integration`：历史 Lunkr/知识治理功能分支；其提交已被 `main` 包含，不应再次合并到 `main`。
- `feat/status-real-progress`：真实任务进度功能的历史分支；其提交已被 `main` 包含。
- `backup/main-before-remove-lunkr-20260724`：历史设计/验收备份分支，含 6 个不在当前 `main` 的旧提交，仅用于追溯，不应合并。

## 5. 当前可靠性验收结果

第五批 100 题在 `8e7e974` 上完成一轮真实冷复测，缓存关闭、并发 4、单题上限 180 秒，两套知识 revision 固定。

| 指标 | 实测 | 企业门槛 | 结果 |
| --- | ---: | ---: | --- |
| 链路成功率 | 99.00% | ≥99.5% | 未通过 |
| 事实义务命中率 | 81.43% | ≥95% | 未通过 |
| 高风险事实义务命中率 | 80.65% | ≥99% | 未通过 |
| 证据支持率 | 78.57% | ≥98% | 未通过 |
| 路由正确率 | 99.00% | ≥98% | 通过 |
| 完整率 | 64.29% | ≥95% | 未通过 |
| 合理拒答率 | 100% | ≥95% | 通过 |
| 无证据关键主张 | 0 | 0 | 通过 |

状态分布：76 道 `answered`、12 道 `partially_answered`、11 道 `not_covered`、1 道 `temporarily_unavailable`。

本轮只执行一次，不能计算同题三次一致率。第五批已经用于整改，因此它只能继续作为开发回归集，不能重新包装成独立盲测。

原始结果只存在于当前交接机器的临时目录，未提交 Git：

```text
C:\Users\Coremail\AppData\Local\Temp\pseagent-fifth-development-8e7e974\round-1.json
SHA-256: 613833aefa1004c95145c3b1191fe12a45defbe46d5001af028d0ffc42662ed5
```

其中可能包含完整问题、回答和证据摘录，不应直接提交公共或普通 Git 分支；如需转交，应通过公司批准的受控文件渠道。

## 6. 已确认的主要缺陷

### 6.1 确定性控制面过度收紧

当前整改分支会把部分共享动作重复拆成多个义务，也会因为模型没有逐字覆盖每个 evidence aspect 而清空已经取得的正式证据。典型现象是 observation 中仍有引用，最终答案却只剩“正式知识暂未覆盖”。

### 6.2 多轮指代与当前义务未正确分离

“这个联系人”“该限制”“按上文”等追问需要同时满足：

- 当前句决定本轮交付义务；
- 上文仅提供经过确认的实体和前提；
- 上文不能新增本轮义务；
- 也不能完全丢弃，导致 `guard_rejected/domain_plan_invalid`。

### 6.3 自动评分仍存在假阳性

部分答案只复述页面标题或问题关键词，没有实际回答，却可能因为词面命中被判为事实完整。修复系统时必须同时修复评分器，不能只优化回答去迎合现有关键词规则。

### 6.4 模型结构化输出仍有波动

第五批出现 3 次 `consensus_verify/invalid_schema` 和 3 次 `targeted_claim_revision/invalid_schema`。模型波动不是本轮退化主因，但会放大 claim 文本、引用落点和完成状态差异。

### 6.5 性能未达标

第五批首轮延迟：P50 32.5 秒、P95 122.4 秒、P99 132.9 秒、最大 145.9 秒。生成、共识验证和定向修订是主要慢尾来源。

## 7. 下一阶段建议顺序

1. 继续在 `fix/100题可靠性整改-第二阶段` 上开发，不直接修改或合并 `main`。
2. 用测试先修复多轮实体继承：当前句独占义务，上文只补实体。
3. 修复共享动作拆分：一个动作只形成一个义务，并列输出项进入该义务的 evidence aspect。
4. 将 aspect 校验改成“每个 aspect 有独立 claim/citation”，不要要求一条综合 claim 逐字复述所有维度。
5. 隔离 verifier/reviser 的 Schema 失败；单条 claim 失败不能清空其他已验证 claim。
6. 先跑第五批开发回归，至少恢复上一开发轮水平：可用率 100%、证据支持率 94.29%、完整率 75.71%，同时保持合理拒答率 100%、无证据关键主张 0。
7. 达到开发准入后，才创建全新的第六批 100 题；必须每题真实运行 3 次，不能复用第五批问题或修改题面迎合实现。
8. 第六批通过后再评估把可靠性分支合并回 `main`。

## 8. 本机运行环境

### 8.1 平台要求

- Windows PowerShell
- Node.js 24.x（平台 `package.json` 要求 `>=24 <25`）
- npm
- Rust/Cargo（构建 Knowledge Engine）
- 公司网络/VPN（访问内部 Jira/Wiki 时需要）

### 8.2 本机配置

平台本地配置文件：

```text
pseagent-platform\.env.local
pseagent-platform\config\knowledge-projects.local.json
```

它们包含模型、令牌、数据库、Knowledge Ops 和本机路径配置，均不得提交。新同事应从 `.env.example` 和运行手册重新建立自己的本机配置，不应复制原使用者的凭据或认证存储。

当前 `knowledge-projects.local.json` 指向平台目录下 Knowledge Ops 发布的 `GENERAL-B7E72CC9` runtime snapshot，而不是直接指向两个知识库工作树。更换知识 revision 后必须走发布/切换流程，不能只修改 Git HEAD 就假设运行时已经更新。

完整本机运行手册：

```text
docs/local-runbook.md
```

根目录 `README.md` 的“只完成初始化、仓库无 remote”等状态描述已经过时，接手时应以本交接文档、Git 历史和 `docs/local-runbook.md` 为准。

### 8.3 当前运行状态（2026-08-13 交接检查）

- 只有 `127.0.0.1:19849` 正在监听 Knowledge Engine；这是可靠性 worktree 启动的隔离实例。
- `19849/health` 返回 `ready`，专业库为 `64d768e...`，通用库为 `655ecd9...`，lexical/graph 均为 `ready`。
- 主分支运行手册默认使用 `127.0.0.1:19829`；交接检查时该端口没有服务。因此不要把当前 `19849` 实例误认为主分支正式运行实例。
- `coremail-knowledge-mcp` 认证状态：Coremail Wiki 已登录、Sales Wiki 可匿名访问、Jira 返回 HTTP 401。接手人需要在自己的会话中重新执行 `npm run login`，不要复制现有 auth store。

## 9. 常用构建、测试和启动命令

### 9.1 `pseagent-platform`

```powershell
Set-Location C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform
npm install
npm run typecheck
npm run build
npm test
```

快速验证：

```powershell
npm test -w @pseagent/app
npm test -w @pseagent/knowledge-ops-worker
npm run probe:live
npm run probe:coremail
npm run probe:enterprise
npm run probe:enterprise:cumulative
```

Knowledge Ops 与 Lunkr：

```powershell
npm run ops:local:start
npm run ops:admin:preview
npm run lunkr:status
npm run lunkr:start
```

不要跳过 `docs/local-runbook.md` 中的端口、进程恢复和固定 revision 检查。

### 9.2 `coremail-knowledge-mcp`

```powershell
Set-Location C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp
npm install
npm run typecheck
npm test
npm run status
npm run login
```

部署使用仓库脚本，不建议手改 MCP 客户端 JSON：

```powershell
npm run deploy:opencode
npm run deploy:codex
npm run deploy:claude
```

PSEAgent 正式集成场景不要额外把历史 MCP 注册成面向用户的第二个直接问答入口。

### 9.3 两个知识库

两个知识库主要由 Markdown、schema、raw 导入材料、测试和治理元数据组成。修改流程：

1. 明确问题是 `source_absent`，而不是检索、生成、评分或代码缺陷；
2. 只增加可追溯的正式资料；
3. 不把单题期望答案直接写成知识补丁；
4. 通过 Knowledge Ops 建立修订、验证、发布和回滚记录；
5. 更新运行时 snapshot 后核对 health 中的 revision。

## 10. 本次交接验证证据

2026-08-13 在推送前执行：

```text
pseagent-platform / @pseagent/app
42 test files passed
1416 tests passed

pseagent-platform / @pseagent/knowledge-ops-worker
20 test files passed
124 tests passed

coremail-knowledge-mcp
TypeScript build passed
smoke test passed
```

Worker 测试在 Windows 上会输出临时仓库 LF/CRLF 与长路径 warning；本次退出码为 0，测试全部通过。

可靠性分支 `8e7e974` 在第五批复测前已执行：

```text
@pseagent/app: 58 files, 1778 passed
npm run typecheck: all workspace typechecks passed
git diff --check: passed
```

## 11. 安全与凭据

以下内容不得提交、截图外传或写入交接文档正文：

- `.env`、`.env.local`；
- 模型 API Key；
- Knowledge Engine/Knowledge Ops token；
- 数据库连接串和加密密钥；
- Jira/Wiki Cookie、账号、密码和 session id；
- Lunkr SID、Cookie 和登录态；
- `C:\Users\Coremail\.config\coremail-knowledge-mcp\auth.json`；
- 本地索引、运行日志、临时桥接程序和包含知识正文的原始验收输出。

新同事必须使用自己的授权账号重新登录，不得复制前任的本机认证文件。

## 12. 接手首日检查清单

1. 分别克隆/拉取四个仓库，核对远端和提交。
2. 在平台仓库查看 `main`、`fix/100题可靠性整改-第二阶段` 和本交接文档。
3. 安装 Node.js 24 和 Rust，执行平台 typecheck/build/test。
4. 根据 `.env.example` 和 `docs/local-runbook.md` 建立自己的 `.env.local`。
5. 使用两个知识库固定 revision 启动 Knowledge Engine，确认 health 中两个项目均为 `ready`。
6. 在 `coremail-knowledge-mcp` 使用自己的账号执行 `npm run login` 和 `npm run status`。
7. 运行 `probe:live`、`probe:coremail` 和企业场景探针。
8. 阅读可靠性阶段 180 至 187 报告，复现代表性失败后再修改代码。
9. 不要直接开始第六批，也不要把第五批重新命名为盲测。
10. 任何知识写入前先证明是资料缺口，避免用知识补丁掩盖程序缺陷。

## 13. Git 交接约定

- 每个阶段单独提交，提交标题使用中文，并在提交前运行与风险相称的测试。
- 不在四个仓库之间混合提交。
- 不在原始脏工作区上运行破坏性 Git 命令；需要隔离时使用 worktree。
- 可靠性整改未通过企业门禁前不得合并到 `main`。
- 历史备份分支只用于追溯，不应重新合并。
- 本次交接没有创建 PR：当前机器没有安装 GitHub CLI；所有推送使用现有 Git remote 认证完成。

## 14. 最重要的接手提醒

项目现阶段最大的风险不是“没有系统”，而是误把测试和状态指标当成真实回答质量：

- `answered` 不一定真的回答了全部问题；
- 有引用不等于引用支持每个主张；
- 第五批是开发集，不是仍然有效的独立盲测；
- 单元测试全绿不等于企业级问答验收通过；
- 当前整改版更安全、更可审计，但过度保守，实际可用性仍低于目标。

后续工作的正确目标是：在保持合理拒答率 100% 和无证据关键主张 0 的前提下，恢复并提升事实准确率、证据支持率、完整率和三次回答一致率。
