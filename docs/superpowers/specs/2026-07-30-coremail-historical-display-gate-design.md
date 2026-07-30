# PSEAgent Coremail MCP 历史结果展示门禁设计

日期：2026-07-30
状态：已确认，待实施

> 本设计增量修订
> `2026-07-28-related-context-mcp-fallback-design.md`
> 与 `2026-07-30-layered-formal-evidence-design.md` 的历史展示规则。
> 正式知识优先、Coremail MCP 只读、历史结果不进入正式引用和后续会话上下文等
> 既有边界继续生效。

## 1. 背景与真实失败

真实问题：

> 对比 Exchange 邮件系统，Coremail 的优势有哪些？

正式知识链路当时返回 `not_covered`，随后 Coremail MCP 找到三项
“SMC2 高级版与 SMC1 高级版功能对比”附件。历史结果自报
`confidence=medium`，PSEAgent 因此原样展示了附件元数据、Mermaid、部署建议和
内部 Wiki URL，并被 Lunkr 拆成十条消息。

这些来源没有覆盖 Exchange，也没有提供 Coremail 与 Exchange 的产品对比证据。
问题不是警告不够醒目，而是低相关历史内容本就不应展示。

同时，该真实问题应优先由正式专业知识库回答。它作为正式知识固定回归，不作为
Coremail MCP 历史门禁的正向触发用例。历史门禁验收使用其他明确包含 Coremail、
正式知识确实未覆盖的问题。

## 2. 已确认的产品决策

1. Coremail MCP 检索完成但结果未通过展示门禁时，正文和历史来源不展示。
2. 用户应看到简短补充说明，确认系统检索过 Coremail MCP，并说明未展示原因。
3. 提示至少区分：
   - 内容与当前问题不匹配；
   - 结果置信度较低；
   - 没有找到可靠匹配内容。
4. `confidence=low` 默认不展示。
5. `confidence=medium/high` 仍须通过独立来源相关性校验，不能只信任 MCP 自报
   置信度。
6. 对比类问题必须在来源证据集合中覆盖全部比较对象。
7. 相关性只能检查来源标题、正文摘录和证据块，不能检查会复述问题的生成答案。
8. 文件名、MIME 类型、附件大小、查看附件建议和通用流程模板不能单独证明目标。
9. 默认不展示内部 URL；历史正文内和来源格式化阶段都要执行该规则。
10. 通过门禁的历史正文最多 2,000 字符、最多 3 条来源，整个历史展示区块最多
    3,000 字符。
11. Coremail MCP 超时、认证失败、连接失败或返回畸形结果时，不得谎称“已完成
    检索”；继续只展示原正式结果。
12. 历史拒绝提示、历史正文和历史来源都不得进入正式引用或下一轮会话上下文。

## 3. 范围

### 3.1 本期目标

- 在 `pseagent-platform` 消费边界阻止低置信度和主题错配的历史结果。
- 即使 Coremail MCP 未来再次返回低质量内容，PSEAgent 仍能独立关闭失败。
- 为完成但未展示的历史检索提供准确、固定、简短的用户提示。
- 在不记录问题、答案、来源标题和 URL 的前提下增加拒绝原因诊断。
- 用真实 Exchange/SMC 错配样本建立确定性回归。

### 3.2 非目标

- 本期不修改 `coremail-knowledge-mcp` 仓库的检索、排序或其他调用方行为。
- 不新增 Embedding、第二模型 judge 或公网搜索。
- 不使用“Exchange”或“SMC”单一字符串特判真实问题。
- 不把历史拒绝改成正式知识库结论，也不改变正式 `status`。
- 不提供默认可点击的内部 Jira/Wiki URL。

## 4. 数据契约

历史提供器不再用 `HistoricalAnswer | undefined` 混合表示成功、政策拒绝和运行失败，
改为可判别结果：

```ts
type HistoricalRejectionReason =
  | "topic_mismatch"
  | "low_confidence"
  | "no_reliable_source";

type HistoricalLookupResult =
  | {
      readonly outcome: "display";
      readonly answer: HistoricalAnswer;
    }
  | {
      readonly outcome: "hidden";
      readonly reason: HistoricalRejectionReason;
    }
  | {
      readonly outcome: "unavailable";
    };
```

语义：

- `display`：检索完成并通过全部门禁。
- `hidden`：检索完成，但因展示政策拒绝；可以向用户显示固定提示。
- `unavailable`：超时、认证、连接、取消或畸形结果；不显示“检索完成”提示。

`AnswerResult` 增加可选、严格的历史提示：

```ts
interface HistoricalNotice {
  readonly provider: "coremail_mcp";
  readonly searched: true;
  readonly displayed: false;
  readonly reason: HistoricalRejectionReason;
}
```

`historicalAnswer` 与 `historicalNotice` 互斥。正式 `scope`、`status`、`answer` 和
`references` 不因二者变化。

## 5. 展示门禁

### 5.1 输入

门禁输入为当前问题和 Coremail MCP 的结构化原始结果。来源校验字段限定为：

- `source_type`
- `title`
- `excerpt`
- `evidence_blocks[].text`
- `evidence_blocks[].summary`
- `evidence_blocks[].next_action`
- `score`

URL、更新时间、附件大小、MIME 类型、来源数量和生成答案不能产生主题命中。

### 5.2 核心概念规范化

确定性规范化包含：

- 英文和数字标识符小写化；
- 全角/半角标点归一；
- 已知产品别名使用通用别名表归一，例如
  `Microsoft Exchange`、`MS Exchange` 与 `Exchange`；
- 中文问题提取去停用词后的连续概念片段和中英文产品标识；
- “对比、比较、相比、区别、优劣、vs、versus”等识别为比较关系。

本期采用高精度、可解释的实体与关键词门禁，不增加第二模型。无法可靠确定语义
相关性时按不展示处理。

### 5.3 对比问题

对比问题必须从问题中解析至少两个比较对象。来源证据集合必须同时覆盖全部对象。

例如：

```text
问题对象：Coremail、Exchange
来源对象：Coremail、SMC1、SMC2
缺失对象：Exchange
结果：topic_mismatch
```

对象可以由不同来源分别覆盖，但只有文件名、附件元数据或来源 URL 命中时不算
有效覆盖。

### 5.4 非对比问题

非对比问题至少要求：

1. 来源证据包含当前问题的核心产品/实体；并且
2. 来源证据包含至少一个去除泛化词后的目标概念；并且
3. 来源存在可用于回答的正文摘录或证据块，而不是纯附件元数据或操作建议。

“Coremail”“功能”“支持”“问题”等高频域词不能单独让来源通过。

### 5.5 置信度与拒绝原因

门禁同时评估相关性和自报置信度：

- 无 Jira/Wiki 可靠来源：`no_reliable_source`。
- 来源主题不满足目标：`topic_mismatch`。
- 主题满足但 `confidence=low`：`low_confidence`。
- 主题满足且 `confidence=medium/high`：进入清理和长度限制后展示。

如果同时存在主题错配和低置信度，优先返回 `topic_mismatch`，因为它更准确描述
为什么内容不能回答问题。

## 6. 用户展示

### 6.1 固定提示

`topic_mismatch`：

> 补充说明：已检索 Coremail MCP 历史资料，但检索内容与当前问题不匹配，因此未展示。

`low_confidence`：

> 补充说明：已检索 Coremail MCP 历史资料，但结果置信度较低，因此未展示。

`no_reliable_source`：

> 补充说明：已检索 Coremail MCP 历史资料，但未找到与当前问题可靠匹配的内容。

提示追加在正式答案之后，不显示警告大段、MCP 正文、历史来源或内部 URL。

### 6.2 通过门禁的历史区块

- 保留现有低可信警告和自报置信度标签。
- 删除历史正文中的 `http://`、`https://` 和内部 URL 行。
- 历史来源只显示类型、Jira key/Wiki id、标题、更新时间、状态和版本。
- 不显示 `reference.url`。
- 正文按段落边界截断到 2,000 字符。
- 来源按原顺序去重后最多保留 3 条。
- 最终历史区块超过 3,000 字符时继续按字段优先级收缩，不能依赖 Lunkr 分片掩盖
  超长输出。

## 7. AnswerService 与 Lunkr

`historicalAttempted` 表示已调用提供器。

`historicalUsed` 只在 `outcome=display` 且 `historicalAnswer` 实际附加时为 `true`。
`outcome=hidden` 时：

```text
historicalAttempted=true
historicalUsed=false
historicalNoticeShown=true
historicalRejectedReason=<固定枚举>
```

Lunkr 展示使用完整格式化结果，但进入 `ConversationStore` 的仍只是正式
`result.answer`。历史拒绝提示也不得进入后续上下文。

## 8. 诊断与隐私

PSEAgent 执行元数据和 Lunkr 生命周期可以增加：

```ts
readonly historicalNoticeShown?: boolean;
readonly historicalRejectedReason?: HistoricalRejectionReason;
readonly historicalRequiredSubjectCount?: number;
readonly historicalMatchedSubjectCount?: number;
```

日志不得记录：

- 问题正文；
- 提取出的具体主题词；
- 历史答案正文；
- 来源标题、路径或 URL；
- Jira key、Wiki id；
- 认证与会话信息。

## 9. 错误处理

- 取消、超时、认证失败、连接失败：`unavailable`，保留正式结果，不显示完成提示。
- MCP 输出缺少基础字段或无法解析：`unavailable`。
- MCP 明确返回 `confidence=none` 且来源为空：`hidden/no_reliable_source`。
- 单条非法来源被丢弃；全部来源被丢弃时为 `hidden/no_reliable_source`。
- URL 清理后答案为空：`hidden/no_reliable_source`。
- 相关性分析异常：关闭失败为 `hidden/topic_mismatch`，不得展示原始历史正文。

## 10. 测试与验收

### 10.1 固定单元回归

1. Exchange/Coremail 问题搭配 SMC1/SMC2 附件来源：
   `topic_mismatch`，不附加历史正文和 URL。
2. 主题相关但 `confidence=low`：
   `low_confidence`。
3. `confidence=none`、空来源：
   `no_reliable_source`。
4. 主题相关且 `confidence=medium/high`：
   展示清理后的历史正文。
5. 历史正文和来源中的 URL 均不出现在可见文本。
6. 正文、来源数和整个区块满足 2,000/3/3,000 边界。
7. 超时、认证失败和畸形输出不显示“已检索完成”。
8. 历史拒绝提示不进入下一轮 Lunkr 上下文。
9. Exchange/Coremail 正式知识回归继续由正式知识库回答，不调用 MCP。

### 10.2 历史兜底探针

真实 MCP 探针使用另一个满足以下条件的问题：

- 明确包含 Coremail；
- 正式知识覆盖验证正常完成；
- 正式知识确实没有目标支持；
- 能稳定触发 Coremail MCP；
- 不与 Exchange/Coremail 正式知识控制用例重叠。

探针同时确认：

- 调用成功且不合格时显示固定提示；
- `historicalAttempted=true`；
- `historicalUsed=false`；
- 拒绝原因符合结果；
- 不显示历史正文和 URL。

### 10.3 全仓验证

- PSEAgent 定向测试、全量测试、类型检查和构建。
- Lunkr Direct 定向测试、全量测试、类型检查和构建。
- Knowledge MCP 全量测试和构建。
- Knowledge Engine Rust 测试和构建。
- 固定协议回归。
- 正式 Exchange/Coremail 知识探针。
- 独立 Coremail MCP 历史门禁探针。
- `git diff --check`。

## 11. 发布与提交约束

- 实施继续在 `feature/lunkr-direct-integration` 分支完成。
- 每个阶段验证后单独提交。
- commit 标题和正文使用中文，正文包含“完成内容”和“验证结果”。
- 不提交 `.env.local`、Session、日志、缓存、用户现有
  `docs/local-runbook.md` 修改或 `.sisyphus/`。
- 未经用户另行要求不推送。

## 12. 成功标准

1. 正式知识能够回答 Exchange/Coremail 对比时，直接返回正式答案，不调用 MCP。
2. 历史来源只覆盖 SMC1/SMC2 时，用户只看到正式未覆盖结论和主题错配提示。
3. `confidence=low` 的历史正文默认不可见。
4. `medium/high` 不能绕过来源主题门禁。
5. 用户能知道 MCP 已完成检索以及结果为何未展示。
6. 内部 URL 不默认显示，历史区块长度受全局边界控制。
7. 历史正文和拒绝提示都不污染正式引用或后续会话上下文。
