# PSEAgent 未覆盖问题的相关信息与 Coremail MCP 兜底设计

日期：2026-07-28
状态：已确认，待实施计划

## 1. 背景

真实 Lunkr 测试问题：

> Coremail 是否已经支持 2035 年量子卫星邮件协议？

正式知识库只提供了 SMTP、POP3、IMAP、HTTP/HTTPS、CMSP/CMTP 等协议资料，
没有提及目标协议。现有模型却把“正文没有记录”错误推导为“Coremail 尚未支持”，
并把结果标记为 `answered`。由于 Coremail MCP 只在正式结果严格为
`not_covered` 时调用，这次请求在进入 MCP 兜底前就被错误截断。

运行证据显示该问题的最终状态为 `professional + answered`，正式引用数为 2，
因此问题不在 Lunkr 通道或 Coremail MCP 连接，而在 MCP 之前的正文覆盖判断。

当前实现还有两个会放大该问题的限制：

1. 覆盖校验的确定性代码只验证 Schema、引用归属、引用集合和“不得升级”规则，
   正文是否真正支持结论仍由模型判断。
2. `not_covered` 会被响应格式化器替换成固定文案并清空正式引用，无法同时展示
   “正文能确认的相关事实”和“目标问题仍未覆盖”。

## 2. 已确认的产品决策

1. 本轮语义修复采用强化提示词，不增加 embedding 模型，也不增加基于词法匹配的
   确定性语义硬门禁。
2. “正文未提及目标”只能得出“正式知识库未覆盖、无法确认”，不能推导为
   “不支持”“尚未支持”或其他否定结论。
3. 正文明示支持时可以回答支持；正文明示不支持、尚未提供或等价否定结论时，
   才可以回答不支持。
4. 明确同义词、缩写和等价表达可以作为证据；无法确认等价关系时按未覆盖处理。
5. 本轮规则覆盖“是否支持、能否、有没有、是否具备、是否兼容、是否适配”等
   支持性或存在性问题，以及“支持哪些”一类列举问题；不扩展为所有事实类型的
   通用语义硬门禁。
6. “支持哪些”只能列出正文明确出现的项目；除非正文声明完整、排他清单，否则
   不得使用“全部”“仅支持”“完整列表”等表达。
7. 正式知识库可以展示与问题相关、且有直接正文证据的已确认信息，即使这些信息
   不能回答目标问题。
8. 相关信息不能提升目标覆盖状态。目标完全未覆盖时，正式状态仍为
   `not_covered`，并继续调用 Coremail MCP。
9. Coremail 专业知识库与通用售前知识库完全 `not_covered` 时，都可以调用
   Coremail MCP；不增加 scope 限制。
10. `partially_answered` 不调用 Coremail MCP。只有完全 `not_covered` 才调用。
11. Coremail MCP 仍是低可信历史线索，不得改变正式状态或正式知识库结论，
    也不得进入下一轮 Lunkr 会话上下文。

## 3. 目标与非目标

### 3.1 目标

- 显著降低模型把“未提及”误判为“不支持”的概率。
- 在目标未覆盖时，仍向用户展示正文能够确认的有用相关事实和正式引用。
- 保持 `not_covered` 的 MCP 兜底语义，不因相关引用存在而跳过 MCP。
- 让运行日志能够区分“未调用 MCP”“已调用但无有效结果”“已调用并展示”。
- 用固定单元测试和真实 `mimo-v2.5-pro` 验收覆盖本次真实问题。

### 3.2 非目标

- 不增加向量检索或 embedding 模型。
- 不把 Coremail MCP 结果写入正式知识库、正式引用或下一轮上下文。
- 不允许 Coremail MCP 的自报置信度提升正式答案可信度。
- 不用针对“2035 年量子卫星邮件协议”的字符串特判修复问题。
- 不在本轮建立覆盖所有事实命题的确定性语义证明系统。

## 4. 核心概念

每个知识 requirement 分离两个概念：

```text
targetCoverage
  用户目标命题是否被正式知识正文直接回答。

relatedContext
  正文能够直接确认、与问题有关，但不能回答目标命题的独立事实。
```

示例：

```text
targetCoverage = none

relatedContext = [
  {
    statement:
      "Coremail 资料明确列出了 SMTP、POP3、IMAP、HTTP/HTTPS 和
       CMSP/CMTP 等协议能力 [1][2]。",
    citations: [1, 2]
  }
]
```

`relatedContext` 的引用只证明这条相关事实，不证明目标协议受支持或不受支持。

## 5. 数据契约

### 5.1 Requirement 输出

在现有 requirement coverage 输出中增加可选的相关信息列表：

```ts
interface RelatedContextItem {
  readonly statement: string;
  readonly citations: readonly number[];
}

interface RequirementCoverage {
  readonly id: string;
  readonly coverage: "complete" | "partial" | "none";
  readonly answer: string;
  readonly citations: readonly number[];
  readonly relatedContext?: readonly RelatedContextItem[];
}
```

约束：

- `coverage=none` 时，目标 `citations` 仍必须为空。
- `relatedContext` 的引用独立存放，不得混入目标 `citations`。
- 每项相关信息至少包含一个引用，最多包含 4 个引用。
- 每个 requirement 最多展示 3 项相关信息，避免用大量相关内容掩盖未覆盖结论。
- 每条 statement 必须带与 `citations` 完全一致的内联 `[n]` 标记。
- 顶层展示引用集合等于目标引用和相关信息引用按 requirement 顺序合并去重后的
  并集。
- 首期只允许 `coverage=none` 使用 `relatedContext`。`complete/partial` 继续使用
  目标 answer 表达已确认内容，避免出现两个事实区域。

`AnswerResult.references` 因此允许在 `status=not_covered` 时非空，但这些引用必须
全部来自已验证的正式 `relatedContext`。Coremail MCP 的历史引用继续只存在于
`historicalAnswer.references`，两类引用不得混合。现有历史探针中
“`not_covered` 必须 `mainRefs=0`”的旧断言改为验证正式引用与 relatedContext
引用完全一致，同时继续验证历史引用至少有一项、原文未改写和警告完整。

### 5.2 覆盖校验输出

独立覆盖校验器必须返回审计后的 `relatedContext`。它只能：

- 保留或删除草稿中的相关信息；
- 删除相关信息中的引用；
- 降低目标 coverage；
- 删除目标引用。

它不得新增相关事实、新增引用、升级目标 coverage，或把相关引用移动到目标引用。

## 6. 提示词设计

### 6.1 知识回答 Agent

知识回答提示词增加支持性命题决策表，并要求在生成答案前进行不输出的内部检查：

1. 从用户原问题中识别目标能力、协议、功能、版本或兼容对象。
2. 只检查实际读取的正文；标题、搜索摘要、候选分数和模型先验不能单独证明目标。
3. 正文明示支持目标时，才允许输出支持结论。
4. 正文明示不支持、尚未提供或等价否定时，才允许输出否定结论。
5. 正文未提目标或只提相关能力时，目标必须为 `coverage=none`。
6. 可以把正文直接支持的相关事实放入 `relatedContext`，但必须明确说明这些事实
   不能确认目标命题。
7. 列举问题只输出正文明确出现的项目，不宣称局部清单是全部清单。

提示词必须包含以下反例：

```text
问题：
Coremail 是否支持 2035 年量子卫星邮件协议？

正文：
系统支持 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP。

错误：
知识库没有记录，因此 Coremail 尚未支持该协议。

正确：
上述资料没有提及“2035 年量子卫星邮件协议”，因此无法根据正式知识库
确认是否支持。协议清单只能作为有引用的 relatedContext。
```

还必须包含明确支持、明确否定、同义表达、部分覆盖和非完整列举的正反例。

### 6.2 独立覆盖校验器

覆盖校验提示词要求忽略草稿的自信措辞，重新逐项检查：

- 目标是否真的出现在正文命题中；
- “未找到”“未记录”“没有资料”是否被错误转换成“不支持”；
- 引用是否只是在介绍相邻概念；
- 相关事实是否可脱离目标结论独立成立；
- 列举答案是否错误暗示完整性。

当正文未回答目标时，校验器必须：

- 把目标 coverage 降为 `none`；
- 清空目标 citations；
- 删除不受支持的目标结论；
- 只保留正文直接支持的 `relatedContext`；
- 在 answer 中明确“无法根据正式知识库确认”，不得写“不支持”。

## 7. 状态与响应格式

### 7.1 状态推导

状态只能由目标 requirement coverage 推导，不能再由总引用数决定：

```text
所有 requirement 为 none
  → not_covered

所有 requirement 为 complete
  → answered

其余组合
  → partially_answered
```

结构校验继续保证 `complete/partial` 目标必须有引用，因此不再需要通过
`referenceCount === 0` 反向推导覆盖状态。

相关引用即使存在，也不能把 `not_covered` 改为 `answered` 或
`partially_answered`。

### 7.2 用户展示

目标完全未覆盖且存在相关信息时：

```text
正式知识库相关信息：

Coremail 资料明确列出了 SMTP、POP3、IMAP、HTTP/HTTPS 和
CMSP/CMTP 等协议能力 [1][2]。

覆盖结论：

上述资料没有提及“2035 年量子卫星邮件协议”，因此目前无法根据
正式知识库确认 Coremail 是否支持该协议。

正式知识库资料来源：
[1] ...
[2] ...
```

然后按现有逻辑调用 Coremail MCP。有有效结果时继续追加：

```text
⚠️ Coremail MCP 低可信历史线索（可能不正确）

<现有低可信警告>
<MCP 自报置信度，不代表内容正确>
<历史答案与历史来源>
```

没有有效 MCP 结果时，只展示正式相关信息、覆盖结论和正式资料来源。

目标完全未覆盖且没有可靠相关信息时，保留现有固定未覆盖文案，然后尝试 MCP。

## 8. Coremail MCP 调用规则

MCP 调用条件保持为：

```text
primary.status === "not_covered"
&& historicalProvider 已配置
```

不增加 scope 限制。专业知识库和通用售前知识库均遵循该规则。

以下状态不调用 MCP：

- `answered`
- `partially_answered`
- `temporarily_unavailable`
- `normal` 普通回答

`not_covered` 是否带正式相关引用不影响 MCP 调用。

MCP 超时、连接失败、认证失败、结果无有效 Jira/Wiki 来源时，正式结果保持不变，
不向用户展示不完整历史内容。

## 9. 错误处理

- 单条 relatedContext 引用无效、不是实际读页引用、内联标记不一致或引用越权时，
  丢弃该条相关信息。
- 丢弃相关信息不得把目标 `not_covered` 改为临时不可用，也不得阻止 MCP 尝试。
- 覆盖校验器整体不可用或连续两次输出无效时，继续沿用当前关闭失败策略，返回
  `temporarily_unavailable`，不调用 MCP。
- MCP 失败时返回正式 `not_covered` 结果；如果正式相关信息有效，则继续展示。
- 发送失败、取消或 `/new` 仍不得写入上下文。
- 正式相关信息可以进入下一轮上下文；Coremail MCP 历史线索继续不得进入。

## 10. 可观测性

AnswerService 的脱敏执行元数据增加：

```ts
readonly historicalAttempted: boolean;
readonly historicalUsed: boolean;
```

语义：

- `historicalAttempted=false`：没有调用 MCP。
- `historicalAttempted=true, historicalUsed=false`：调用过 MCP，但失败、超时或没有
  可展示的有效结果。
- `historicalAttempted=true, historicalUsed=true`：调用成功并向用户展示了低可信
  历史线索。

Lunkr `answered` 生命周期日志传递这两个布尔字段。日志继续只记录加盐用户哈希、
问题编号、会话代次、scope、status、停止原因、耗时、引用数和布尔结果，不记录
问题、答案、知识正文、来源标题、URL、SID、Cookie、密码或模型密钥。

开发诊断继续记录 draft/verified coverage 和固定 reason，不记录正文。真实模型
验收期间临时启用诊断；正式运行是否长期启用仍由环境配置控制。

## 11. TDD 与验收

### 11.1 单元与协议测试

必须先观察红灯，再实现：

1. `coverage=none` 可以携带独立 relatedContext，但目标 citations 必须为空。
2. relatedContext 引用必须属于对应 requirement 的实际读页集合。
3. 校验器不得新增相关信息或相关引用。
4. 无效 relatedContext 被丢弃，不影响目标 `not_covered`。
5. `not_covered` 可以保留正式相关信息和正式引用。
6. 相关引用不能把状态升级为 `answered/partially_answered`。
7. `not_covered` 带相关引用时仍调用 Coremail MCP。
8. MCP 失败时保留正式相关信息和未覆盖结论。
9. MCP 历史内容仍不进入下一轮 Lunkr 上下文。
10. `historicalAttempted/historicalUsed` 正确区分三种调用结果。
11. 明确支持和明确否定问题仍为 `answered` 且不调用 MCP。
12. “支持哪些”不得把局部清单描述为完整清单。
13. 固定回归不得再通过 identity verifier 绕过本问题的覆盖校验路径；该问题使用
    专门的覆盖校验脚本或独立测试夹具验证降级和 MCP 触发。
14. 历史探针允许 `not_covered` 携带正式 relatedContext 引用，但必须继续保证正式
    引用和 MCP 历史引用分区、计数和来源互不混淆。

### 11.2 真实模型验收

使用当前配置的 `mimo-v2.5-pro` 对真实问题连续执行 3 次。每题继续遵守 300 秒
总预算。

每次必须满足：

- scope 为 `professional`；
- 正式 status 为 `not_covered`；
- 不出现“尚未支持”“明确不支持”或等价无证据否定；
- 正式相关信息只陈述正文明确支持的协议事实；
- 正式相关信息具有可见正式引用；
- `historicalAttempted=true`；
- MCP 返回有效 Jira/Wiki 结果时，`historicalUsed=true` 且展示完整低可信警告；
- MCP 无有效结果时，`historicalUsed=false`，正式结果保持可用。

还需要执行控制用例：

- 一个正文明示支持的问题：`answered`，不调用 MCP。
- 一个正文明示否定的合成单元用例：`answered`，不调用 MCP。
- 一个“支持哪些”问题：只列出明确项目，不宣称完整性。
- 一个通用售前库完全未覆盖问题：`not_covered`，同样尝试 Coremail MCP。

### 11.3 全仓验证

- PSEAgent 全量测试与类型检查。
- Lunkr Direct 全量测试、类型检查和构建。
- Knowledge MCP 全量测试与构建。
- Rust Knowledge Engine 全量测试与构建。
- 41 题固定协议回归。
- `git diff --check`。

## 12. 发布与运行约束

- 实施继续在 `feature/lunkr-direct-integration` 分支完成，不合并 `main`。
- 每个 TDD 阶段独立提交，提交标题和正文使用中文，正文包含“完成内容”和
  “验证结果”。
- 不提交 `.env.local`、Session、运行日志、诊断日志、密码、SID、Cookie 或令牌。
- 不修改知识库仓库内容。
- 当前测试服务是否停止、重启或继续运行，必须服从用户的明确指令；设计和计划
  阶段不主动重启。

## 13. 成功标准

本设计完成后，真实问题的用户体验必须满足：

1. 正式知识库提供有引用的相关协议信息。
2. 正式结论明确表示目标协议未覆盖、无法确认是否支持。
3. 不再把“没有资料”写成“不支持”。
4. 正式状态保持 `not_covered`。
5. 两个知识库的完全未覆盖结果都能触发 Coremail MCP。
6. 用户可以通过脱敏日志确认 MCP 是否尝试、是否展示。
7. MCP 内容保持低可信分区，不改变正式结论，不污染下一轮上下文。
