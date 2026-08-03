# PSEAgent 企业级问答链路与可解释缺口设计

日期：2026-08-03  
状态：已确认，开始实施  
适用仓库：`C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

## 1. 背景

真实多轮与多模型验收已经证明，当前不稳定不是某一个模型或某一个业务问题造成的：

- 一个问题只能选择 `professional/general/normal` 中的一个 scope，不能按必答项组合专业库与通用售前库；
- 会话上下文只是历史问答文本拼接，没有先把追问还原成可独立处理的问题；
- 模型生成的规划缺少“用户明确对象和交付项必须全部保留”的确定性守卫；
- 完整原问题的候选会混入每个 requirement，单一实体或泛化主题可能挤占其他明确对象；
- coverage 只有 `complete/partial/none`，不能区分知识缺失、客户输入不足、候选未读、来源冲突和服务异常；
- `partially_answered` 会被响应层追加固定的“知识库尚未覆盖问题的其余部分”，无法向用户说明具体边界。

既有阶段 63 的真实失败还证明，不能继续通过题目关键词裁剪、页面专项规则或固定业务维度修补检索。新设计必须把用户显式要求编译成稳定契约，让模型负责语义理解，让代码负责不可破坏的不变量。

## 2. 目标

1. 将当前问题和必要的会话状态解析为独立问题，避免上一轮答案污染规划与检索。
2. 建立一次生成、全链路复用的 `TaskSpec`，显式记录用户对象、交付项和覆盖单元。
3. 按交付项选择一个或多个知识域，隔离专业事实、通用方法和客户输入。
4. 按覆盖单元公平检索、读页和扩展来源，避免全局候选相互挤占。
5. 建立 `EvidenceLedger` 与结构化 `CoverageGap`，精确说明缺什么、为什么缺和下一步。
6. 对事实保持严格直接证据，对综合建议采用宽容语义校验，不要求答案逐字一致。
7. 新问题无法回答时受控降级，不把检索未完成或客户信息不足伪装成知识库缺失。
8. 保持现有 Lunkr 长答案附件、只读知识库、Coremail MCP 安全边界和外部兼容协议。

## 3. 非目标

- 不写 Exchange、华为、比亚迪、POC 或任何客户专用生产分支。
- 不将固定对比维度、固定销售字段或固定答案写入业务代码。
- 不放宽数字、版本、功能、兼容性、授权、认证等受保护事实的直接证据要求。
- 不把搜索结果、标题、overview、图关系或模型先验作为正式引用。
- 不修改知识库内容、revision 或导入流程。
- 不让模型直接决定“知识库确实没有”；该结论必须由检索账本确定性归因。

## 4. 核心流水线

```text
原始问题 + 结构化会话状态
  -> QuestionResolver
  -> ResolvedQuestion
  -> TaskCompiler
  -> TaskSpecGuard
  -> DomainRouter（按交付项）
  -> RetrievalCoordinator（按覆盖单元）
  -> EvidenceLedger
  -> Draft Composer
  -> Coverage Verifier
  -> GapAnalyzer
  -> Response Formatter
```

所有下游组件使用同一个 `ResolvedQuestion.standaloneQuestion` 和同一份 `TaskSpec`。原始问题仅用于展示、审计和解析纠错，不再由不同组件各自重新理解。

## 5. QuestionResolver 与会话状态

```ts
interface ResolvedQuestion {
  readonly rawQuestion: string;
  readonly standaloneQuestion: string;
  readonly contextUsed: boolean;
  readonly inheritedSubjects: readonly string[];
  readonly corrections: readonly {
    readonly original: string;
    readonly normalized: string;
    readonly confidence: "high" | "medium";
  }[];
}
```

规则：

- 补全“它、这个方案、还有华为呢”等指代和省略，但不得创造用户未表达的新事实；
- 当前问题明确更换主体时，当前问题优先；
- 只在高置信度且不改变用户意图时纠正常见术语误写；
- 解析失败时保守使用原问题，不阻断普通单轮问题；
- 诊断只记录字符数、是否使用上下文和纠错数量，不记录问题正文。

Lunkr 会话存储改为结构化用户轮次。回答正文不再进入规划上下文；可保留由已验证 `TaskSpec` 派生的主体、对象和未解决覆盖单元。`/new` 与空闲过期继续清除全部状态。

## 6. TaskSpec 与完整性守卫

```ts
type DeliverableKind =
  | "fact"
  | "comparison"
  | "diagnosis"
  | "recommendation"
  | "procedure"
  | "risk_assessment";

interface AnswerObligation {
  readonly id: `O${number}`;
  readonly label: string;
  readonly targetEntities: readonly string[];
  readonly required: boolean;
}

interface TaskDeliverable {
  readonly id: `D${number}`;
  readonly label: string;
  readonly kind: DeliverableKind;
  readonly evidencePolicy: "direct" | "synthesis" | "customer_input";
  readonly domains: readonly KnowledgeDomain[];
  readonly obligations: readonly AnswerObligation[];
}

interface TaskSpec {
  readonly subject: string;
  readonly entities: readonly string[];
  readonly deliverables: readonly TaskDeliverable[];
}
```

TaskCompiler 可由结构化模型提出草案，但 `TaskSpecGuard` 必须确定性保证：

- 问题明确点名的实体至少进入一个必答 obligation；
- 并列对象不得无理由丢失；
- 互不替代的提问动作和交付目标必须分别保留；
- 受保护事实不得标记为自由归纳；
- 客户项目事实不足不得归类为知识缺失；
- 可选的 planning aspect 不得升级成用户必答项；
- 校验失败先请求一次结构修复，仍失败时生成保守回退 TaskSpec，而不是继续使用残缺规划。

实体目录由知识库页面标题、别名和标签动态构建；未知实体保留用户原文并标记低置信度，不在代码中维护客户名单。

## 7. 按交付项的多知识域路由

内部知识域为：

```ts
type KnowledgeDomain = "coremail-professional" | "presales-general";
```

一个 deliverable 可以绑定一个或两个知识域，但 claim 必须保持域归属：

- 产品功能、版本、部署、具体客户案例进入专业域；
- 售前访谈、机会判断、价值表达和项目推进进入通用域；
- 混合问题分别检索，不能用通用方法证明产品事实，也不能用产品案例直接证明赢率；
- 外部 `scope/status` 在兼容期保留，内部新增 `domainsUsed`，避免一次性破坏 Lunkr 与 MCP 契约。

## 8. 覆盖单元驱动检索

每个 `AnswerObligation` 形成独立覆盖单元和查询包：

```ts
interface QueryBundle {
  readonly obligationId: string;
  readonly exactEntityQueries: readonly string[];
  readonly semanticQueries: readonly string[];
}
```

确定性规则：

- 每个明确对象至少获得一次独立查询和公平候选额度；
- 完整原问题只作发现，不再无条件把候选灌入所有 requirement；
- 全局候选必须通过对象和主题归属检查才能进入覆盖单元；
- 实体摘要页是入口，不是详细问题的终点；所需信息仍缺失时沿 `related/sources` 读取正式源页；
- 未关联对象的案例只能标记为补充类比，不能替代目标事实；
- 读页预算按覆盖单元和证据风险分配，并受全局截止时间约束；
- 有相关候选尚未读取时只能归类为检索未完成，不能归类为知识不存在。

## 9. EvidenceLedger 与覆盖判断

```ts
interface EvidenceLedgerUnit {
  readonly obligationId: string;
  readonly domain: KnowledgeDomain;
  readonly queries: readonly QueryRecord[];
  readonly candidates: readonly CandidateRecord[];
  readonly reads: readonly ReadRecord[];
  readonly supportedClaims: readonly SupportedClaim[];
  readonly status: "supported" | "partial" | "unsupported";
}
```

证据策略不对称：

- 功能、数字、版本、存在性、兼容性和穷举结论继续逐句直接核验；
- 诊断、方法、建议和多页综合允许保守归纳；
- verifier 只判断主要结论与用户明确 obligation，不要求逐字复述 aspect label；
- 同义表达、顺序变化和合理详略差异不构成缺口；
- 资料冲突必须披露，不能合成为单一确定结论。

## 10. CoverageGap

知识覆盖度与案例可判断性必须分开：

```ts
type KnowledgeCoverage = "complete" | "partial" | "none";
type CaseAssessability = "sufficient" | "insufficient" | "conflicting" | "not_applicable";
```

```ts
interface CoverageGap {
  readonly id: string;
  readonly deliverableId: string;
  readonly obligationId: string;
  readonly gapClass:
    | "knowledge"
    | "retrieval"
    | "source"
    | "input"
    | "ambiguity"
    | "conflict"
    | "freshness";
  readonly reason:
    | "no_matching_page"
    | "read_pages_do_not_support"
    | "summary_only"
    | "external_source_only"
    | "candidate_not_read"
    | "retrieval_budget_exhausted"
    | "access_denied"
    | "tool_unavailable"
    | "conflicting_sources"
    | "stale_or_unconfirmed"
    | "ambiguous_question"
    | "required_customer_input_missing"
    | "unsupported_claim_removed";
  readonly subject: string;
  readonly missingAspect: string;
  readonly affectsConclusion: boolean;
  readonly confirmedBoundary?: string;
  readonly nextAction?: string;
}
```

归因优先级：

1. 客户输入不足或问题歧义，归为 `input/ambiguity`；
2. 候选未读、预算、截止时间和工具失败，归为 `retrieval`；
3. 只有摘要或外部源未接入，归为 `source`；
4. 资料冲突或过旧，归为 `conflict/freshness`；
5. 只有必要查询成功、相关候选均已核验且正文仍无支持时，才归为 `knowledge`。

最终展示必须包含“对象 + 缺失信息 + 原因”，最多合并为三组。`input` 缺口不自动把知识回答降为 `partially_answered`；全未覆盖时也不得丢弃逐项 gap。

## 11. POC 机会问题的通用处理

“客户在 POC 阶段、销售获取不到客户侧信息，赢率如何、怎样提升”应拆成：

- 当前是否具备量化赢率的证据；
- 缺少哪些客户侧变量；
- 如何取得最小客户证据并改造 POC 推进；
- 判断边界和下一步验证。

正确状态可以是：

```text
knowledgeCoverage = complete
caseAssessability = insufficient
winRate = not_assessable
forecastConfidence = low
riskSignal = high
```

系统不得无依据输出百分比，也不得把客户输入不足写成知识库未覆盖。缺失字段和行动建议来自当次问题契约与实际读取的售前方法正文，不写死在生产代码。

## 12. 模型适配与故障隔离

模型角色在接口上分离：resolver、planner、synthesizer、verifier 可以先共用同一配置，后续独立替换。供应商适配层声明 JSON 能力、推理标签、上下文和超时；受控移除 `<think>` 与代码围栏后仍必须通过严格 Schema。

端到端模型比较拆成：

1. 固定问题比较 TaskSpec；
2. 固定 TaskSpec 比较确定性检索；
3. 固定 EvidenceLedger 比较答案表达。

这样可以区分拆题、检索和生成问题，避免把所有波动归因于模型。

## 13. 可观测性与隐私

按 requestId 记录脱敏诊断：

- resolved 是否使用上下文、字符数和纠错数；
- deliverable、obligation、domain 数量与完整性守卫结果；
- 每个覆盖单元的查询、候选、读页和失败计数；
- coverage、caseAssessability、gapClass/reason；
- verifier 保留/删除计数、模型角色、耗时和停止原因。

日志不得记录问题、答案、知识正文、认证信息或密钥。诊断必须支持同一请求的链路回放。

## 14. 兼容迁移

- 阶段一以 shadow 方式生成 `ResolvedQuestion/TaskSpec`，记录一致性但不改变生产答案；
- 通过离线与真实回归后再让路由、检索和 verifier 使用新契约；
- 现有 `KnowledgePlan`、`scope/status` 和 Lunkr 元数据在兼容期保留适配层；
- 每一阶段都有独立开关和回退点；真实质量下降时回退该阶段，不改写 Git 历史。

## 15. 验收原则

- 显式对象和交付项召回率为 100%；
- 受保护事实无支持输出为 0；
- 有未读相关候选时错误声明知识缺失为 0；
- 客户输入不足与知识缺失分类准确；
- 多轮追问能还原主体且不继承上一轮错误答案；
- 同一 EvidenceLedger 下允许措辞不同，但核心方向、引用和边界一致；
- 场景族覆盖并列实体、混合知识域、追问、错别字、客户输入不足、真正知识缺失、检索未完成、来源冲突、过期资料和模型结构输出异常。

