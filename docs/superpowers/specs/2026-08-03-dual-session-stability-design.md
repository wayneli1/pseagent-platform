# PSEAgent 双会话稳定性与直接证据查询修复设计

日期：2026-08-03
状态：根据真实双会话验收结果确认
适用仓库：`C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

## 1. 背景

两套独立 PSEAgent 运行时会话并发执行相同的 P01–P10 专业问题，每个会话按顺序
执行 10 题。20 次请求全部在 300 秒内以 `final` 结束，没有
`temporarily_unavailable`、进程异常或 scope 串线；但结果暴露两个稳定性缺陷：

1. 只有 5/20 次满足语料中的 `expectedStatus=answered`。
2. 同一问题在两个会话间有 6/10 个 status 不一致。
3. P05“Coremail 如何支持邮件审计”曾在一个会话中返回 `not_covered`，而后续两套
   定向诊断会话均读取审计正式页面并返回 `answered`，说明知识存在但召回链路会波动。
4. P02“Coremail XT6 常见部署方式有哪些”在两次诊断中都只返回
   `partially_answered`。原问题直接检索的前 20 名没有进入预期的单机、
   多机部署页；使用规划证据面应携带的“单机部署、多机部署”术语后，两页稳定进入
   第 1、2 名。
5. `scripts/probe-stability.mts` 已记录 `scopeMatches/statusMatches=false`，但汇总和退出码
   只检查 unavailable 与 exception，导致明显预期偏差仍以退出码 0 通过。

## 2. 目标

- 让稳定性探针对 scope/status 预期偏差返回失败退出码。
- 让 `direct_only` 查询确定性携带其已映射动态 evidence aspect 的区分术语。
- 提升具体产品事实与类别问题的正式页面召回，不增加模型调用、搜索次数或读页预算。
- 保持覆盖校验关闭失败；不得为了达到 `answered` 而放松直接证据或删除
  `partially_answered/not_covered`。
- 用同一组 P01–P10 再执行两个独立会话，逐题核对稳定性。

## 3. 非目标

- 不为 P02、P05、部署或审计问题写生产专项答案、页面路径或固定证据面。
- 不修改 LLM Wiki 所有的 `wiki/overview.md`，不改知识库内容或 revision。
- 不增加 Embedding、互联网检索、额外 Judge 或额外模型调用。
- 不把搜索结果、aspect 标签或 planning overview 当作正式引用。
- 不把所有安全的 partial 强制改写成 answered。
- 不停止或重启当前 Lunkr 机器人；本阶段针对问答运行时与可重复探针。

## 4. 真实验收基线

### 4.1 会话 A

- `answered=2`
- `partially_answered=7`
- `not_covered=1`
- `final=10`
- `unavailable=0`
- `failures=0`

### 4.2 会话 B

- `answered=3`
- `partially_answered=7`
- `not_covered=0`
- `final=10`
- `unavailable=0`
- `failures=0`

两个会话 scope 均为 `professional`，均未调用历史资料。该基线证明服务可用和会话隔离
正常，但检索与 status 稳定性未达到语料预期。

## 5. 稳定性探针判定

新增一个无 I/O 的判定模块，输入每条安全记录中的：

- 是否发生调用异常；
- 是否为 `temporarily_unavailable`；
- 配置了 expectedScope 时是否匹配；
- 配置了 expectedStatus 时是否匹配。

汇总新增：

```ts
scopeMismatches: number;
statusMismatches: number;
```

以下任一计数大于零时进程退出码必须为 1：

```text
unavailable
failures
scopeMismatches
statusMismatches
```

没有配置预期值的记录不算 mismatch。探针继续不打印回答正文、查询、知识正文或凭据。

## 6. 直接证据查询规范化

规划器已经为每个 requirement 生成动态：

```ts
evidenceAspects[].terms
queries[].aspectIds
```

当前只对 `synthesis_allowed` 的宽泛规划进行查询平衡和术语补全；`direct_only` 查询可能
引用某个 aspect ID，却没有把该 aspect 的区分术语写进 query text。无 Embedding 的
词法检索无法仅凭 ID 推断同义类别，因此会错失标题明确的正式页面。

新增确定性规范化：

1. 只处理最终已收紧为 `direct_only` 的 requirement。
2. 对每条 query，按其 `aspectIds` 顺序找到对应 aspect。
3. 每个 aspect 最多追加两个尚未出现在 query 中的 `terms`。
4. 术语按规划器原顺序去重；不创建新术语、不读取页面路径、不使用题号或业务特判。
5. 查询仍限制为 1,024 字符，query 数量、aspect 映射和 requirement 数量不变。
6. 完成规范化后再次通过严格 `knowledgePlanSchema` 校验。

示例：

```text
query: Coremail XT6 常见部署方式
aspect A1 terms: 单机部署、单节点
aspect A2 terms: 多机部署、分布式部署

规范化后：
Coremail XT6 常见部署方式 单机部署 单节点 多机部署 分布式部署
```

这些词来自当次模型规划，不是生产代码中的领域知识。

## 7. 安全边界

- 查询增强只影响候选召回，不直接改变 coverage 或 status。
- 最终引用仍必须来自相同 project/revision 下实际读取成功的页面。
- `direct_only` 仍由独立覆盖校验器逐句验证，未支持句段继续删除。
- aspect terms 仍只是导航信号，不能作为正文证据。
- P05 的一次异常不通过固定审计页解决；只能通过通用查询契约降低波动。
- 用户已有 `docs/local-runbook.md` 和 `.sisyphus/` 修改不得暂存或提交。

## 8. 验收

### 8.1 离线

- 稳定性 verdict 单元测试覆盖 status mismatch、scope mismatch、未配置预期和正常通过。
- Planner 测试证明 direct query 会补齐其映射 aspect 的术语，且不改变
  synthesis query 的既有平衡行为。
- PSEAgent 聚焦测试、全量测试、类型检查和工作区构建通过。

### 8.2 真实模型

1. 两套独立诊断会话并发复测 P02，确认预期单机、多机页面进入正式引用并检查 status。
2. 两套独立会话再次并发执行相同 P01–P10。
3. 要求 20/20 无异常、无 unavailable、scope 全部匹配。
4. status mismatch 必须由探针以非零退出码暴露；不得再假通过。
5. 对仍为 partial 的问题区分“安全且真实的知识缺口”和“预期页面未召回”。

Windows 控制助手无法稳定绑定本机两个同名 Coremail 论客窗口，因此本轮双会话验收使用
两套独立 PSEAgent 运行时；不以 UI 自动化结果冒充消息通道结论。

## 9. 复测暴露的第二层状态漂移

阶段 58 后的两套独立运行时复测仍出现明显状态漂移：会话 A 为
`answered=6/partially_answered=4`，会话 B 为
`answered=2/partially_answered=7/not_covered=1`，同题 status 仅 4/10 一致。
两套会话仍均为 10/10 `final`，没有 unavailable、异常或 scope 串线。

隔离诊断进一步确认：

- P04 已读取 `wiki/comparison/第三方邮件系统迁移方式对比.md`。草稿为
  `complete`，覆盖校验器保留三条直接支持句段、删除一条无支持扩展句段后，将整项
  降为 `partial`。
- P05 已读取 `wiki/concepts/审计管理.md`。过滤后的保留句段覆盖 4/4 动态
  evidence aspect，但因为删除了三条无支持扩展句段，整项仍被固定映射为 `partial`。

这说明旧契约把“草稿曾包含应删除的句段”和“过滤后的答案仍缺少用户所问内容”混为
一谈。前者是校验器成功清理草稿，后者才应决定最终 coverage。

## 10. 过滤后覆盖状态重建

覆盖校验器继续只允许模型选择保留索引，代码继续确定性复制保留句段、删除未支持
句段。`retain_partial` 不再无条件等于最终 `partial`；代码在完成过滤后按动态
evidence aspect 重建 coverage。

只有同时满足以下全部条件，过滤后的 requirement 才可恢复为 `complete`：

1. 至少保留一个目标句段，且保留引用均属于该 requirement 的实际读页证据。
2. `coveredAspectCount` 等于规划的 evidence aspect 总数。
3. `missingAspectCount` 为 0。
4. 覆盖计数必须由保留句段的语义表达与其引用正文的 aspect 归属共同确认，不能只依赖
   搜索标签、标题或未保留草稿。
5. 校验决策不是 `not_covered`；没有保留句段时绝不恢复。

单 aspect requirement 也必须生成 `coveredAspectCount/missingAspectCount`，不得因
数量为一而隐藏覆盖缺口。若任一 aspect 未覆盖，或过滤后没有正式支持句段，仍分别保持
`partial` 或 `none`。

恢复 `complete` 不会把被删除句段放回答案，也不会改变校验 reason、删除数量或引用
集合。诊断仍保留 `partial_support` 与 `removedSegmentCount`，用于识别模型草稿质量；
最终 status 只表达过滤后对用户问题的覆盖程度。

## 11. 单证据面直接查询补全

阶段 58 只在一条 direct query 映射多个 aspect 时追加动态 terms。实际复测中，规划器
有时把宽泛问题收敛成单个 aspect；此时同一问题仍可能因查询未带区分术语而漏掉正式
页面。

因此 direct query 术语补全扩展到一个或多个 aspect：

- 仍只使用当次规划的 `evidenceAspects[].terms`，不写题号、业务答案或固定页面。
- 每个映射 aspect 最多追加两个 query 中尚未出现的 term。
- 查询数、aspect 映射、模型调用、读页预算和 1,024 字符上限不变。
- `synthesis_allowed` 的既有查询平衡逻辑不变。

## 12. 修订验收

- 覆盖校验单测必须证明：删除无支持扩展句段后，若过滤答案仍覆盖全部规划 aspect，
  则返回 `complete`；缺少任一 aspect 时仍为 `partial`；全部删除时仍为 `none`。
- 单 aspect 的覆盖计数必须可见，且 direct query 会追加其缺失动态术语。
- 再运行两套独立会话的同一 P01–P10，并逐题比较 status；探针 mismatch 继续以非零
  退出码暴露，不因本修订放宽预期。
