# PSEAgent 分层正式证据与跨页归纳设计

日期：2026-07-30
状态：已确认，待实施

> 本设计是对
> `2026-07-28-related-context-mcp-fallback-design.md`
> 中“目标答案必须由正文直接支持”规则的增量修订。冲突处以本设计为准；
> “未提及不能推导为不支持”、Coremail MCP 低可信边界、正式引用隔离和
> 结构异常关闭失败等既有规则继续生效。

## 1. 背景与根因

真实问题：

> 售前工程师的工作职责有哪些？

通用售前知识库没有名为“售前工程师岗位职责”的专页，但知识库总览和多篇方法论
页面分别覆盖需求诊断、方案与价值表达、产品演示、客户关系、冲突沟通以及机会
推进。这些正式资料足以支持一份带边界声明的职责归纳。

当前链路仍把每个目标句段限制为“某一篇正文直接表述该目标”。当模型根据多篇
正式页面形成保守归纳时，独立覆盖校验器会把这些句段删除；全部句段被删除后，
通用库返回主题相邻的 `relatedContext`，专业库中的 Coremail 明确问题还可能继续
进入 Coremail MCP。

对比 llm_wiki 的实现可以确认，良好回答主要来自两项能力：

1. 项目 `overview.md` 始终进入模型上下文，帮助模型识别跨页面知识结构。
2. 模型可以迭代搜索和读页，然后直接基于多篇页面生成带引用结论，不经过
   “只接受单页直接表述”的二次降级。

PSEAgent 不能直接取消二次校验，因为专业知识库还包含支持性、版本、容量、授权
等不能依赖合理推断的高风险事实。因此根因不是“有校验器”，而是校验器只有
“直接支持/不支持”两档，缺少受约束的正式归纳类型；同时当前每 requirement
最多读取 3 页，也不足以稳定收集跨方法论答案所需的多个证据面。

## 2. 已确认的产品决策

1. `general` 和 `professional` 都允许跨页面归纳；是否允许归纳由问题事实类型
   决定，不由知识库 scope 决定。
2. 保留独立覆盖校验器和按原始句段索引确定性重建答案的安全架构。
3. 正式目标支持分为 `direct` 和 `synthesized`：
   - `direct` 表示实际读取正文直接支持目标句段。
   - `synthesized` 表示多篇实际读取正文共同支持一个保守、可追溯的归纳句段。
4. 支持性、存在性、明确否定、版本、兼容性、容量或性能数字、授权、报价以及
   穷举完整性结论必须使用 `direct`，不得由跨页归纳证明。
5. 工作职责、方法论总结、多页面对比、方案组织、能力领域、综合分析和建议允许
   使用 `synthesized`。
6. 归纳方式不决定覆盖状态。归纳结果完整满足用户要求时可以为 `complete`；
   只有明确子要求仍缺失时才为 `partial`。
7. 通过覆盖校验的 `direct` 和 `synthesized` 都属于正式支持，都会阻止
   Coremail MCP 降级。
8. `overview.md` 和知识结构摘要只用于导航、拆分证据面和扩展查询，不单独作为
   最终目标引用；最终引用必须来自实际读取的正式知识页。
9. `relatedContext` 只保留对用户当前判断有直接帮助的独立事实。仅处于同一主题
   或领域，不足以成为相关信息。
10. 运行诊断和 Lunkr 生命周期日志增加不含问题、答案或知识正文的分层证据计数，
    使检索未命中、草稿未回答和校验器删除可以被区分。

## 3. 目标与非目标

### 3.1 目标

- 让两个正式知识库可靠回答需要多篇页面共同支撑的综合问题。
- 保留专业产品事实的直接证据边界，不把“合理推断”变成产品承诺。
- 避免已有正式归纳答案仍被错误降级到 Coremail MCP。
- 让归纳答案显式披露归纳性质，并为每个实质结论提供正式引用。
- 继续由代码而不是模型决定引用集合、保留句段、覆盖状态降级和 MCP 资格。
- 用脱敏日志精确定位答案在哪个阶段从有证据变成未覆盖。

### 3.2 非目标

- 不取消独立覆盖校验器。
- 不把搜索摘要、标题、RRF 分数、知识图谱边或模型先验作为最终证据。
- 不允许 `overview.md` 在未读取实际知识页时单独证明目标答案。
- 不实现任意开放式推理、常识补全或互联网搜索。
- 不改变 Coremail MCP 的只读、低可信、不可进入正式引用或后续会话上下文边界。
- 不用“售前工程师”“工作职责”等具体字符串特判某一个真实问题。

## 4. 分层证据模型

### 4.1 Requirement 证据模式

知识规划器为每个 requirement 输出：

```ts
type EvidenceMode = "direct_only" | "synthesis_allowed";

interface KnowledgeRequirement {
  readonly id: `R${1 | 2 | 3 | 4 | 5 | 6}`;
  readonly question: string;
  readonly queries: readonly string[];
  readonly evidenceMode: EvidenceMode;
}
```

一个 requirement 只能选择一个模式。复合问题中，如果不同子要求具有不同风险，
规划器必须拆成不同 requirement。例如：

```text
“Coremail 的主要能力有哪些，并给出支持的最大用户数”

R1 主要能力概览
  evidenceMode = synthesis_allowed

R2 支持的最大用户数
  evidenceMode = direct_only
```

### 4.2 必须 direct_only 的受保护事实

下列结论必须由实际正文直接表达：

- 是否支持、能否实现、有没有、是否具备、是否适配。
- 明确的“不支持”“尚未提供”“已经下线”等否定事实。
- 产品版本、补丁版本、发布日期和生命周期。
- 操作系统、浏览器、数据库、协议或第三方产品兼容性。
- 用户数、并发数、吞吐、时延、容量、性能、RTO、RPO 等数字。
- 授权、报价、费用、采购、许可证范围。
- 安全或合规认证的获得、覆盖范围和有效性。
- “全部”“仅有”“完整清单”“最高”“最低”等穷举或边界结论。

规划器应将这类 requirement 标为 `direct_only`。独立覆盖校验器仍必须再次识别
受保护事实；即使规划器误标为 `synthesis_allowed`，也只能按 `direct` 判断，
不能保留为 `synthesized`。

### 4.3 允许 synthesis_allowed 的问题

以下类型可以从多篇正式正文进行保守归纳：

- 岗位职责、工作领域、能力域和方法论总结。
- 多篇知识页的共同主题、差异和互补关系。
- 基于正式步骤、原则和场景组织出的方案框架。
- 不包含受保护事实的综合分析、注意事项和建议。
- 用户明确要求“综合知识库”“归纳”“总结”时的多页答案。

允许归纳不代表允许补充常识。每个归纳句段仍必须能由该 requirement 实际读取的
引用页面共同推出。

## 5. 规划与检索

### 5.1 规划器

规划提示词增加 `evidenceMode` 决策表和复合问题拆分示例。Schema 对
`evidenceMode` 使用严格枚举，不通过字符串猜测或缺省值静默放宽。

现有确定性容量 requirement 注入逻辑必须显式写入：

```ts
evidenceMode: "direct_only"
```

原因是容量和硬件配置属于受保护数字与规格事实。

### 5.2 Overview 的职责

知识库 overview 继续提供给规划器和知识 Agent，但用途限定为：

- 识别知识库覆盖的概念域。
- 把综合问题拆成多个证据面。
- 生成更精确的语义查询。
- 发现应读取的概念页、综合页、对比页或实体页。

overview 内容不能直接注册成正式 citation，也不能在没有实际读页的情况下让
requirement 获得 `complete`、`partial`、`direct` 或 `synthesized`。

### 5.3 自适应读页预算

每个 requirement 的读页预算由 `evidenceMode` 决定：

```ts
const DIRECT_ONLY_READ_LIMIT = 3;
const SYNTHESIS_ALLOWED_READ_LIMIT = 6;
```

其他边界继续保持：

- 每 requirement 最多 3 次补充搜索。
- 每 requirement 最多 1 次知识图谱动作。
- 批量读页每次最多 2 页。
- 总 Agent turn 上限和 270 秒活跃截止时间继续生效。
- 重复工具动作继续拒绝。
- 连续两轮无新增候选或证据时停止补充搜索。

所有读取预算判断、剩余动作计数、coverage gate 补读判断和向模型展示的
`remainingReads` 必须调用同一个 `readLimitFor(requirement)`，禁止保留散落的固定
常量判断。

### 5.4 综合问题的证据收集

当 `evidenceMode=synthesis_allowed` 时，Agent 提示词要求：

1. 根据 overview 和候选页面识别用户问题所需的不同证据面。
2. 优先读取能分别覆盖这些证据面的概念页、综合页、对比页或实体页。
3. 已有页面都集中在同一相邻主题、但尚未覆盖主要证据面时，继续搜索或读页。
4. 证据面已足以形成保守答案，或继续检索连续无新增收益时停止。
5. 不为了耗尽 6 页预算而读取重复或低相关页面。

## 6. 草稿与独立覆盖校验

### 6.1 草稿规则

知识 Agent 生成 `complete/partial` 目标句段时：

- `direct_only` requirement 的每个实质句段必须有直接正文证据。
- `synthesis_allowed` requirement 可以生成多页归纳句段，但引用必须覆盖形成该
  归纳所需的页面。
- 不得把“资料未提及”改写成“不支持”“没有”或其他明确否定。
- 不得把局部页面集合描述成完整、排他的知识库清单。
- 不得把模型常识、搜索摘要或页面标题写入正式答案。
- 草稿不自行声明最终支持类型，支持类型由独立校验器决定。

### 6.2 校验决策契约

保留现有目标句段索引协议，并增加归纳句段索引：

```ts
interface CoverageVerificationRequirement {
  readonly id: string;
  readonly targetDecision: "retain" | "retain_partial" | "not_covered";
  readonly retainedTargetSegmentIndexes: readonly number[];
  readonly synthesizedTargetSegmentIndexes: readonly number[];
  readonly retainedRelatedContextIndexes: readonly number[];
  readonly reason:
    | "direct_support"
    | "explicit_negative_support"
    | "synthesized_support"
    | "partial_support"
    | "related_only"
    | "target_omitted"
    | "unsupported_claim_removed";
}
```

确定性约束：

- `synthesizedTargetSegmentIndexes` 必须是
  `retainedTargetSegmentIndexes` 的有序子集，不能重复或越界。
- 草稿 requirement 为 `direct_only` 时，
  `synthesizedTargetSegmentIndexes` 必须为空。
- 受保护事实句段无论规划模式是什么，都不得进入
  `synthesizedTargetSegmentIndexes`。
- `retain` 仍要求保留全部目标句段。
- `retain_partial` 仍要求至少保留一个、但不能保留全部目标句段。
- `not_covered` 的两个目标索引数组都必须为空。
- 直接支持句段由“已保留索引减去归纳索引”确定。
- 验证器不能输出、改写或新增 answer、statement、citation 或引用页面。

### 6.3 synthesized 的判定标准

目标句段只有同时满足以下条件才能标记为 `synthesized`：

1. requirement 允许归纳，且句段不包含受保护事实。
2. 至少一篇实际读取正文提供关键前提；需要多篇共同成立的结论必须引用全部关键
   前提页面。
3. 句段是对正文信息的分类、概括或保守组合，不比正文表达更强。
4. 删除模型常识后，句段仍能仅依赖引用正文成立。
5. 引用不是只介绍相邻主题，而是对该归纳结论具有实质支撑。
6. 多篇页面存在冲突时，不得合成为单一确定结论；答案必须披露冲突，或删除该
   句段。

例如，分别介绍诊断式销售、演示方法、可信顾问和机会推进的页面，可以共同支持
“售前职责包括需求诊断、产品演示、客户关系和机会推进”的归纳；介绍报价冲突和
投诉场景的两篇页面，不能单独支持一份完整岗位职责清单。

### 6.4 确定性重建与披露

代码继续只按索引复制草稿原始句段、保持原顺序并重新聚合内联引用。

只要某个 requirement 保留了至少一个 `synthesized` 句段，代码在该 requirement
答案前加入固定披露：

> 根据正式知识库中多篇资料综合归纳：

披露文本不是事实声明，不新增 citation。它不得被模型省略，也不得暗示知识库
存在正式岗位说明书、厂商规范或完整清单。

### 6.5 覆盖状态

- `retain`：保留草稿的 `complete` 或 `partial`。
- `retain_partial`：代码确定为 `partial`。
- `not_covered`：代码确定为 `none`。
- 是否含 `synthesized` 不自动改变 `complete` 为 `partial`。
- 最终全局状态仍只由各 requirement 的 coverage 推导。

因此“售前工程师的工作职责有哪些？”可以在职责领域得到充分覆盖时返回
`answered`；如果用户还要求知识库没有覆盖的企业职级或考核指标，则相应
requirement 为 `partial` 或 `none`。

## 7. RelatedContext

`relatedContext` 继续只能用于 `coverage=none`，但增加“决策有用性”要求：

- statement 必须由实际正文直接支持。
- statement 必须能直接缩小用户当前问题的判断范围、提供替代路径或指出明确资料
  边界。
- 仅与问题共享产品名、岗位名、方法论领域或上位主题，不足以保留。
- relatedContext 不能作为 `synthesized` 的替代品，也不能阻止合法跨页归纳。

“售前职责”问题中，报价质疑和投诉场景如果不能直接支撑职责归纳，应删除而不是
作为 relatedContext 展示；存在足够方法论页面时，应直接生成正式归纳答案。

## 8. Coremail MCP 门槛

`OutcomeTrace.verifiedHasDirectEvidence` 改为
`verifiedHasFormalSupport`。正式支持包括：

```text
保留的 direct 目标句段
或
保留的 synthesized 目标句段
```

MCP 条件修改为：

```text
primary.status === "not_covered"
&& historicalProvider 已配置
&& 正式覆盖验证正常完成
&& 所有 requirement 都没有任何保留的 direct 或 synthesized 目标句段
&& 当前问题文本明确包含 Coremail
&& 当前结果不是结构异常安全降级
```

历史门槛原因中的：

```text
direct_formal_evidence_present
```

改为：

```text
formal_support_present
```

通过校验的归纳答案不调用 Coremail MCP。`relatedContext` 仍不属于目标正式支持；
它不能单独阻止一个满足其他严格条件的 Coremail 完全未覆盖问题进入 MCP。

## 9. 可观测性

### 9.1 PSEAgent 诊断

`coverage` 诊断事件继续不记录问题、答案或正文，并增加：

```ts
interface CoverageDiagnosticRequirement {
  readonly id: string;
  readonly evidenceMode: "direct_only" | "synthesis_allowed";
  readonly coverage: "complete" | "partial" | "none";
  readonly citations: readonly number[];
  readonly retainedDirectSegmentCount?: number;
  readonly retainedSynthesizedSegmentCount?: number;
  readonly removedSegmentCount?: number;
}
```

`draft` 阶段记录 coverage 和引用；`verified` 阶段额外记录三类句段计数。

### 9.2 AnswerService 与 Lunkr 生命周期

`PseAnswerExecution` 和 Lunkr `answered/failed` 生命周期元数据增加以下可选字段：

```ts
readonly draftCoverage?: readonly ("complete" | "partial" | "none")[];
readonly verifiedCoverage?: readonly ("complete" | "partial" | "none")[];
readonly retainedDirectSegmentCount?: number;
readonly retainedSynthesizedSegmentCount?: number;
readonly removedSegmentCount?: number;
readonly historicalGateReason?:
  | "eligible"
  | "question_not_explicit_coremail"
  | "formal_verification_incomplete"
  | "formal_support_present"
  | "structural_fallback";
```

运行日志只记录这些枚举、布尔值和计数，不记录问题、答案、知识正文、页面标题、
路径、查询词、SID、Cookie、密码或密钥。

这组字段应能区分：

- 草稿已经 `none`。
- 草稿有答案但被校验器全部删除。
- 校验后保留了直接证据。
- 校验后保留了跨页归纳。
- 最终是否以及为什么具备 MCP 资格。

## 10. 错误处理与关闭失败

- 规划器连续输出非法 `evidenceMode` 时，沿用知识规划失败路径，不静默改成
  `synthesis_allowed`。
- 覆盖验证器输出非法、重复、越界或不满足子集关系的归纳索引时，按既有修复流程
  重试；连续失败后确定性 `not_covered`，且不得触发 MCP。
- 覆盖验证器网络或模型不可用时继续返回 `temporarily_unavailable`。
- `direct_only` requirement 出现归纳索引时视为非法校验决策，不降格接受。
- 受保护事实被标为 `synthesized` 时，校验器必须删除；若模型决策违反契约，
  修复失败后关闭失败。
- 读页达到 6 页、总 turn 或截止时间耗尽时，不得因预算扩大而绕过现有安全终止。
- 多页面冲突无法安全披露时，删除冲突句段，不选择其中一方作为确定事实。

## 11. 测试与验收

### 11.1 契约与规划测试

1. requirement 必须显式包含合法 `evidenceMode`。
2. 工作职责、方法论总结和综合分析示例为 `synthesis_allowed`。
3. 支持性、版本、兼容性、数字、授权和完整清单示例为 `direct_only`。
4. 混合风险问题被拆成不同 evidence mode 的 requirement。
5. 确定性容量 requirement 始终为 `direct_only`。
6. 校验决策只允许归纳索引是保留索引的有序子集。

### 11.2 Agent 与检索测试

1. `direct_only` 最多读取 3 页。
2. `synthesis_allowed` 最多读取 6 页。
3. `remainingReads`、批量读页、coverage gate 和剩余工具动作使用同一预算函数。
4. overview 只扩展证据面，不注册 citation。
5. 连续无新增收益、重复动作、turn 和 deadline 边界继续生效。

### 11.3 覆盖校验测试

1. 多篇正文共同支持的职责归纳被标为 `synthesized` 并保留。
2. 归纳句段缺少关键前提引用时被删除。
3. 相邻主题页面不能证明目标归纳。
4. `direct_only` requirement 不能保留归纳句段。
5. 规划器误标时，支持性、版本、容量、授权和穷举结论仍不能通过归纳。
6. 同一答案可以同时保留 direct 和 synthesized 句段。
7. 只删除部分句段时返回 `partial`；全部合法句段保留时可以为 `complete`。
8. 有归纳句段时出现固定披露，无归纳句段时不出现。
9. 页面冲突不会被合成为单一确定结论。

### 11.4 MCP 与日志测试

1. 任一 requirement 存在 direct 或 synthesized 正式支持时不调用 MCP。
2. 全部 requirement 均无正式支持、显式包含 Coremail 且验证正常完成时才调用。
3. relatedContext 不等于目标正式支持。
4. 结构异常降级仍不调用 MCP。
5. 诊断和 Lunkr 日志包含分层计数与 gate reason，且不含正文或敏感信息。

### 11.5 固定业务回归

通用知识库问题：

> 售前工程师的工作职责有哪些？

必须满足：

- scope 为 `general`。
- 使用多个实际读取的正式页面形成职责领域归纳。
- status 为 `answered`，或在明确子要求缺失时为 `partially_answered`。
- 显示“根据正式知识库中多篇资料综合归纳”边界。
- 每个实质职责句段有有效正式引用。
- 不返回仅主题相邻的 relatedContext。
- 不调用 Coremail MCP。

专业知识库控制用例：

- 一个确实需要多篇专业页面共同回答、但不包含受保护事实的问题：
  允许正式归纳，不调用 MCP。
- “Coremail 是否支持知识库未记载的目标能力？”：
  不得归纳支持或不支持，保持 `not_covered`，满足严格条件时可以调用 MCP。
- 版本、容量、兼容性、授权和完整清单问题：
  继续要求直接正文证据。

### 11.6 全仓验证

- PSEAgent 定向测试和类型检查。
- PSEAgent 全量测试。
- Lunkr Direct 定向测试和类型检查。
- 全仓 TypeScript 测试、类型检查与构建。
- Rust 全套测试和构建。
- `git diff --check`。

真实模型验收继续遵守单题 300 秒总预算。先运行固定业务回归，再通过 Lunkr 私聊
复测“售前工程师的工作职责有哪些？”，检查回答、正式引用、分层计数以及
`historicalAttempted=false`。

## 12. 分阶段提交边界

实施必须按可独立审查和验证的任务拆分，每个任务完成后立即创建独立 Git commit：

1. 契约、规划器和证据模式。
2. 自适应检索与读页预算。
3. 分层覆盖校验和归纳披露。
4. MCP 正式支持门槛和 PSEAgent 诊断。
5. Lunkr 生命周期可观测性。
6. 固定业务回归、真实验收记录和最终全仓验证。

所有 commit 标题和正文使用中文；正文至少包含“完成内容”和“验证结果”。只暂存
当前任务明确列出的文件，不得混入工作区已有的用户改动，不创建 remote，不推送。
