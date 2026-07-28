# PSEAgent 证据覆盖与引用根治验收

日期：2026-07-27

分支：`feature/lunkr-direct-integration`

## 验收边界

- 当前不使用 embedding；检索仍以 Knowledge Engine 的词法检索和受控查询扩展为主。
- PSEAgent 自身目标、架构、运行方式和边界属于普通问题，由 Agent 自身回答，不搜索 Coremail 专业库或通用售前库。
- Coremail 专业问题先查专业知识库；只有专业库对整个问题判定为 `not_covered` 时，才允许回退通用售前知识库。部分覆盖不得跨库补齐。
- Lunkr 只负责私聊消息的收发，不参与问题分类、知识检索、上下文管理或答案生成。
- 专业答案必须展示可追溯引用；每个拆分后的需求都必须由该需求实际读取过的页面支撑。
- 单次回答最长等待 300 秒。

## 根因与修复

此前回答遗漏并不是某一个页面缺失，而是“复杂问题拆分、检索、读页、生成、引用校验”之间缺少逐需求约束：

1. 只搜索拆分后的短查询时，原问题中的实体、规模和限定词会丢失。
2. 搜索命中不等于模型读取；模型可能只读到概览页，遗漏容量表、镜像机制或迁移注意事项等互补页面。
3. 一个需求读到的页面曾可能被另一个需求直接复用，导致引用看似存在、实际没有独立证据链。
4. 最终答案按整段自由生成，无法保证每个需求都回答并携带自己的引用。
5. 引用校验只检查“页面是否在本轮出现过”，粒度不足以阻止跨需求借用引用。
6. 同义表述、标题优先级和产品实体页排序不足，造成“功能介绍”“POC 注意事项”“迁移工具流程”等问法漏召回。

本阶段完成的根治措施：

- 把完整原问题合并进每个需求的检索，同时保留拆分查询。
- 为每个需求并行读取最多 2 个互补页面；单需求最多 3 次直接读页，并设置全局批量上限。
- 共享读页不占直接读页额度，但只有目标需求独立检索到该页面时才能作为其证据。
- 优先使用整理后的概念页、实体页、对比页和综合页，再考虑原始资料。
- 增加小范围、可审计的查询扩展，如“注意事项→要点”“操作步骤→操作流程”“POC→POC 测试要点”，以及迁移工具定向查询。
- 对“核心能力、核心功能、有哪些功能、详细介绍功能、是什么”等问法，提高产品实体页优先级。
- 将所有实际执行过的扩展查询纳入标题覆盖度排序，避免扩展命中后仍选错页面。
- 用户明确给出规模且问题还包含拓扑、容灾或同步时，把容量规模拆成独立需求，防止被架构描述吞掉。
- 最终输出改为逐需求结构化答案，每个需求必须内联引用；运行时再合并成用户答案。
- 从内联引用派生引用元数据，并按需求校验“该引用是否由本需求实际读取”；失败时返回精确原因。
- 诊断日志移除答案正文，只保留状态、耗时、引用数量和校验结果。

## 五个问题的真实模型证据

每个问题均验证原问和等价改写问法，共 10 个样本。`direct` 表示该次真实调用直接按当时验收规则通过；`replay` 表示保留真实模型答案和真实引用不变，仅在验收规则补入有知识页依据的等价术语或等价来源后离线复核通过。replay 没有修改答案内容，也没有放宽缺失需求。

| 样本 | 主题 | 范围 / 状态 | 引用数 | 耗时 | 结果 |
| --- | --- | --- | ---: | ---: | --- |
| EC01.1 | PSEAgent 目标与整体架构 | normal / answered | 0 | 4,854 ms | direct 通过 |
| EC01.2 | PSEAgent、Lunkr 与 OpenClaw 的关系 | normal / answered | 0 | 6,527 ms | direct 通过 |
| EC02.1 | Coremail AI 助手功能与资料边界 | professional / answered | 2 | 72,979 ms | direct 通过 |
| EC02.2 | AI 助手能力、版本与授权边界 | professional / answered | 2 | 43,389 ms | direct 通过 |
| EC03.1 | 10 万用户容量、多活、容灾与镜像同步 | professional / answered | 8 | 约 98,489 ms | replay 通过 |
| EC03.2 | 容量参考、本地多活边界与镜像同步 | professional / answered | 4 | 141,987 ms | replay 通过 |
| EC04.1 | Domino 迁移环境、工具流程与特殊事项 | professional / answered | 5 | 165,079 ms | direct 通过 |
| EC04.2 | Domino 迁移准备清单 | professional / answered | 5 | 148,875 ms | replay 通过 |
| EC05.1 | CACTER 网关功能与 POC 注意事项 | professional / answered | 4 | 58,386 ms | direct 通过 |
| EC05.2 | 安全网关能力与选型测试避坑 | professional / answered | 4 | 78,822 ms | direct 通过 |

10 个样本都在 300 秒上限内完成。EC03 的容量验收同时接受资料概述中的“约 30 台”和配置表逐项求和得到的“32 台”，但不接受只回答某一类服务器数量；双副本/双机互备等表述也只作为同一知识事实的等价表达。EC04 对迁移工具采用资料中可验证的 `migrateX`、`DTS` 或 `domino-migrate.jar` 路线，不以单一工具名排除其他有效路线。

真实模型多轮执行中发现并修复过一次批量读页参数上限与 schema 不一致的问题。模型仍可能偶发输出不符合动作协议并被安全降级为 `temporarily_unavailable`；这属于模型调用波动，不能伪装成知识库已回答。当前证据说明：在模型按协议完成调用时，五类问题的需求覆盖、证据归属、引用和时限均通过。

## 自动化验证

以下命令已于 2026-07-28 在当前分支重新执行通过：

- `npm test`
  - PSEAgent：18 个测试文件、210 个测试通过
  - Knowledge MCP：2 个测试文件、4 个测试通过
  - Lunkr Direct：11 个测试文件、32 个测试通过
  - Knowledge Engine Rust：25 个测试通过
- `npm run typecheck`：全部 workspace 通过
- `npm run build`：全部 workspace 与 Rust build 通过
- `cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check`：通过
- `cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings`：通过
- `npm run test:regression`：45/45 通过
- `node --import tsx --test scripts/probe-selection.test.ts`：4/4 通过
- probe 脚本严格 TypeScript 检查：通过
- `git diff --check`：通过

## 知识库版本与最终在线验收

回归语料和本地运行说明已固定到：

- `coremail-professional`：`2f293528af751d8997e837b1a7569f4582a02059`
- `presales-general`：`26945059ca4b9796f2ff7c89ed84dca1c2d71641`

上表 10 个真实模型样本最初是在不打断服务的前提下，由当时仍在运行的旧 Knowledge Engine 快照产生：

- `coremail-professional`：`e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general`：`ca4ee0f8fb3c466378371c14bf3394c82a903281`

在用户明确授权后，最终在线切换与验收已经完成：

1. 本机忽略配置已固定为上述两个最终 revision。
2. `127.0.0.1:19829/health` 于 2026-07-28 返回 `ready`，并确认：
   - `coremail-professional` 实际 revision 为 `2f293528af751d8997e837b1a7569f4582a02059`；
   - `presales-general` 实际 revision 为 `26945059ca4b9796f2ff7c89ed84dca1c2d71641`；
   - 两个项目的 lexical 与 graph 状态均为 `ready`。
3. Lunkr 加密 Session 状态检查为 `configured=true`、`valid=true`。
4. 用户已通过真实 Lunkr 私聊完成多题问答，验证了消息接收、PSEAgent 调用、专业/通用知识回答、资料来源展示和连续上下文链路。
5. 真实聊天同时暴露了“长时间无即时回执、同用户多题无法直观看出对应关系、长回答分段损坏、`/new` 未可靠清理上下文”等消息通道体验问题；这些问题不属于本阶段检索与证据门禁缺陷，已单独进入后续 Lunkr 回执、四用户并发和会话重置设计。

阶段 44 最终自动化结果为：

- TypeScript：PSEAgent 210 个、Knowledge MCP 4 个、Lunkr Direct 32 个测试通过；
- Rust：Knowledge Engine 25 个测试通过，包含最终固定快照的真实召回测试；
- 协议回归：45/45 通过；
- probe 选择测试：4/4 通过；
- workspace typecheck、probe 严格 TypeScript 检查、build、Rust fmt、clippy 和 `git diff --check` 均通过。

本次最终核对时 Knowledge Engine 仍在运行；未发现正在运行的 Lunkr Node 入口，因此本轮没有自行启动、停止或重启任何服务。阶段 44 未写入两个知识库仓库，未把账号、密码、验证码、答案正文或本机临时结果路径写入版本库；`.sisyphus/` 不属于提交范围。
