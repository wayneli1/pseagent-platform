# PSEAgent Planning Overview 上下文设计

**日期：** 2026-07-31
**状态：** 已批准，待实施

## 目标

在不增加模型调用、检索链路或知识库文件的前提下，让 LLM Wiki 维护的
`wiki/overview.md` 参与 PSEAgent 的检索规划，提升跨页面归纳问题的证据召回。

本设计同时满足以下约束：

1. `wiki/overview.md` 继续由 LLM Wiki 所有，PSEAgent 不改写该文件。
2. overview 只帮助 Planner 识别知识域、证据面和库内术语，不是正式证据。
3. 回答模型、覆盖校验和引用系统只能依赖实际读取的业务页面。
4. Planning Context 与搜索目录、图关系和正文读取固定在同一个 Git revision。
5. 新知识只有在导入完成、验证、提交并以新 revision 重启 Knowledge Engine 后生效。
6. 不为“售前工程师职责”或其他具体问题保留生产专项分支。

## 背景与现状

当前 Knowledge Engine 在启动时加载业务页面和 schema，但 `context()` 在请求阶段
重新从磁盘读取 `purpose.md`，并将其作为 `overview` 返回。只要 `purpose.md` 存在，
真实的 `wiki/overview.md` 就不会参与规划。

当前 PSEAgent 又把这个含混的 `overview` 同时传给 Planner 和回答代理，导致：

- Planner 看不到 LLM Wiki 维护的全局知识概要；
- purpose、schema、业务页面可能不再属于同一运行时快照；
- 回答代理可以直接看到生成性概要，证据边界不够硬；
- 为补偿跨页召回，生产代码中出现了具体业务问题的专项检索、预读和固定答案。

## 所有权

| 资产 | 所有者 | PSEAgent 权限 | 用途 |
| --- | --- | --- | --- |
| `purpose.md` | 知识库 | 只读 | 范围、风险和回答边界 |
| `schema.md` | 知识库 | 只读 | 页面类型和目录结构 |
| `wiki/overview.md` | LLM Wiki | 只读 | 全局概要和已有知识上下文 |
| `planningOverview` | Knowledge Engine | 内存派生 | Planner 的导航上下文 |
| 业务页面正文 | 知识库 | 只读 | 唯一正式事实证据 |

PSEAgent 不创建第二个 overview 文件，不向知识库回写导航内容，也不改变 LLM Wiki
的导入流程。

## Planning Context V2

Knowledge Engine 的项目上下文契约改为：

```json
{
  "project": "presales-general",
  "revision": "26945059ca4b9796f2ff7c89ed84dca1c2d71641",
  "purpose": "...",
  "schema": "...",
  "planningOverview": "...",
  "planningOverviewMeta": {
    "status": "ready",
    "contentHash": "64 位小写 SHA-256",
    "rendererVersion": "planning-overview-v1",
    "originalChars": 2741,
    "exposedChars": 2741,
    "truncated": false
  }
}
```

`planningOverviewMeta.status` 只有：

- `ready`：文件存在且正文完整暴露；
- `missing`：文件不存在，`planningOverview` 为空；
- `truncated`：正文超过上限，按字符截断。

以下情况拒绝激活该知识库 revision：

- overview 不是有效 UTF-8；
- overview 以 YAML frontmatter 开始但缺少闭合分隔符；
- purpose 或 schema 缺失或无效；
- 知识目录在启动加载前后 revision 发生变化；
- `wiki`、`purpose.md` 或 `schema.md` 存在未提交修改。

## planningOverview 派生规则

Knowledge Engine 在 bootstrap 阶段执行一次确定性转换：

1. 读取 `wiki/overview.md` 原始 UTF-8 内容；
2. 计算原文件 SHA-256；
3. 如果文件以独立一行 `---` 开始，移除完整 YAML frontmatter；
4. 去除正文开头多余空白；
5. 保留正文原始语义，不做模型摘要或关键词提取；
6. 按 Unicode 字符截取最多 12,000 字符；
7. 生成状态、字符数和 renderer version；
8. 与 purpose、schema 和业务索引一起存入不可变 `ProjectIndexes`。

请求阶段禁止重新读取磁盘。一个 Knowledge Engine 进程中的 Planning Context 生命周期
等于对应项目快照的生命周期，不设置 TTL。

缓存身份由以下字段组成：

```text
project + revision + overviewContentHash + rendererVersion
```

当前实现只需要在内存中保留每个项目的一份，不建立持久化缓存。

## 模型可见边界

### Planner

Planner 接收：

- 用户问题和必要的会话上下文；
- purpose；
- schema；
- planningOverview。

Planner 必须把 planningOverview 当作导航数据，只能用来：

- 识别用户问题可能涉及的知识域；
- 生成动态证据面；
- 采用知识库内部术语扩展查询；
- 判断应该采用直接证据还是跨页归纳。

Planner 不得输出答案、引用、页面路径、内部 URL、页码或来源文件编号。

### 回答代理

回答代理不接收 planningOverview，只接收：

- 用户问题；
- Planner 生成的 requirement、evidence aspect 和查询；
- 候选页元数据；
- 实际读页结果和引用注册表；
- 剩余检索预算。

因此，即使 overview 中存在一句产品结论，只要没有实际读取支持它的业务页面，该结论
就不能进入答案。

### 覆盖校验

覆盖校验只接收动态 evidence aspect、答案段落和实际读页证据。它可以保留、删除
答案段落并报告 aspect 覆盖情况，但不得创建新的业务事实或完整答案。

## 动态证据计划

每个 requirement 的目标结构为：

```json
{
  "id": "R1",
  "question": "用户明确提出的必答内容",
  "evidenceMode": "synthesis_allowed",
  "evidenceAspects": [
    {
      "id": "A1",
      "label": "运行时生成的证据面",
      "terms": ["库内术语一", "库内术语二"]
    }
  ],
  "queries": [
    {
      "text": "完整语义查询",
      "aspectIds": ["A1"]
    }
  ]
}
```

约束：

- 每个 requirement 最多三个查询；
- aspect ID 在 requirement 内唯一；
- query 引用的 aspect ID 必须存在；
- `synthesis_allowed` 的查询覆盖互补证据面，不得只是同义改写；
- `direct_only` 仍要求支持性、否定、版本、兼容性、容量、性能、授权、报价、
  认证和穷举性声明具备直接正文证据；
- 所有 evidence aspect 和查询都在运行时生成，生产代码不得按具体业务问题匹配。

## 检索与读页

原问题和最多三个规划查询继续使用现有词法检索、图关系扩展和 RRF，不新增工具。

查询携带 `aspectIds`，融合后的候选记录其可能覆盖的动态证据面。读页选择同时考虑：

- RRF 相关性；
- 尚未覆盖的 evidence aspect；
- 页面类型；
- 与已读页面的主题重复程度；
- requirement 的剩余搜索和读页预算。

搜索结果仍然不是证据。只有成功读取并通过相同 project/revision 校验的页面可以注册引用。

## 更新和发布

新知识发布过程：

1. LLM Wiki 导入新源文件；
2. 等待所有导入和页面合并完成；
3. 验证业务页面、index、overview 和队列状态；
4. 在对应知识库创建新 Git commit；
5. 更新 Knowledge Engine 的项目 revision 启动参数；
6. 重启 Knowledge Engine；
7. bootstrap 原子加载新索引和 Planning Context；
8. 健康检查通过后接收新请求。

运行中的旧进程忽略磁盘变化，避免一个回答混用两批知识。

## 降级和可观测性

缺少 overview 时：

- `planningOverview` 为空；
- 状态为 `missing`；
- Planner 仍可根据问题、purpose 和 schema 生成查询；
- 原问题检索继续执行；
- 不影响 direct-only 问题的基本可用性。

结构化日志只记录：

- project 和 revision；
- planning overview status、hash、字符数和 renderer version；
- requirement、aspect 和 query 数量；
- 各 aspect 的候选和已读覆盖状态。

日志不记录 overview 全文、用户答案正文或内部认证信息。

## 非目标

- 不修改或冻结 LLM Wiki 的 `wiki/overview.md`；
- 不新增 `planning-overview.md` 文件；
- 不增加向量库、Embedding 或第二条导航检索；
- 不增加 Planner 之外的模型调用；
- 不允许 overview 成为引用；
- 不实现运行中文件监听或自动热重载；
- 不在本阶段修复 LLM Wiki 自身的 overview 自动维护实现；
- 不为单个问题、岗位或产品写固定证据面和答案。

## 验收

1. Knowledge Engine 启动后修改磁盘 overview，不改变当前 context。
2. 新 revision 重启后，planningOverview 与该 revision 同步更新。
3. YAML frontmatter 不进入 Planner，正文完整保留到 12,000 字符。
4. 回答代理的模型输入中不存在 planningOverview。
5. 所有引用仍来自相同 revision 下实际读取的业务页面。
6. “售前工程师职责”及其改写无需生产专项关键词即可通过。
7. “Coremail 对比 Exchange”读取正式直接页面，不进入 Coremail MCP。
8. 受保护事实和真实未覆盖问题维持原有严格证据边界。
9. 没有新增模型调用、搜索链路或检索查询预算。
