# PSEAgent 答案卡与知识运营平台实施计划

日期：2026-08-05
对应设计：`docs/superpowers/specs/2026-08-05-answer-card-knowledge-ops-platform-design.md`

## 执行纪律

1. 每个阶段只暂存该阶段明确列出的文件，先验证再提交。
2. 所有 commit 标题和正文使用中文；正文至少包含“完成内容”和“验证结果”。
3. 不暂存现有 `docs/local-runbook.md` 修改和 `.sisyphus/`。
4. 三个 Git 仓库独立提交，不跨仓暂存。
5. 所有新在线能力先 shadow，再精确激活，最后语义问题族激活。
6. 每阶段保留独立 feature flag 或清晰回滚点。

## 阶段78：设计与验收合同

交付：

- 新增答案卡与知识运营平台设计；
- 新增本实施计划；
- 固化在线回答面、控制面、双库边界、隐私、发布和验收要求。

验证：

```powershell
git diff --check -- docs/superpowers/specs/2026-08-05-answer-card-knowledge-ops-platform-design.md docs/superpowers/plans/2026-08-05-answer-card-knowledge-ops-platform.md
```

## 阶段79：共享治理契约与结构化答案

交付：

- 创建 `packages/knowledge-governance-contracts`；
- 定义 AnswerCard、QuestionFamily、FeedbackCase、Approval、Regression、ReleaseManifest Schema；
- 创建 StructuredAnswer AST、稳定去重和最终渲染器；
- coverage 只按 required obligation 聚合；
- 替换跨域字符串拼接，保持外部 AnswerResult 兼容；
- 单元测试覆盖重复段落、编号、引用和部分必答项。

验证：共享契约测试、PSEAgent 定向测试、全量 TypeScript 类型检查和测试。

## 阶段80：答案卡在线编排

交付：

- AnswerCardRegistry、ExactMatcher、FamilyMatcher、TaskSpecAdapter；
- 卡片目录绑定知识发布 revision 和哈希；
- exact、family、partial、none 匹配结果；
- shadow、exact active、family active 开关；
- 命中后仍进入 DomainPlan、AgentLoop 和 verifier；
- 诊断只记录 card id 哈希、匹配类型和置信等级。

验证：匹配和反例测试、TaskSpec Guard 测试、双域集成测试、全量测试。

## 阶段81：知识引擎治理元数据与检索

交付：

- Rust 文档模型解析答案卡治理字段；
- 标题、别名、问题族、标签和正文分字段打分；
- 仅 approved query 可进入答案卡检索；
- 普通知识页兼容现有 pending 迁移期；
- HTTP/MCP 可选 page type、review status、search mode 契约；
- snapshot/revision 继续严格固定。

验证：Rust catalog/lexical/service/http 测试、MCP 契约测试、真实知识快照检索测试。

## 阶段82：专业库答案卡治理

交付：

- Schema 增加版本化 query 答案卡字段；
- 将 `wiki/query` 迁移到 `wiki/queries` 并修复链接；
- 选择证据完整的高频页面升级为首批 approved 卡片；
- 增加别名、必答项、禁答项、owner、review due 和回归 id。

验证：frontmatter 校验、链接检查、Git clean/revision 检查、真实检索。

## 阶段83：通用库答案卡治理

交付：

- Schema 增加 query 类型；
- 创建 `wiki/queries`；
- 从高频售前方法建立首批 approved 卡片；
- 不包含 Coremail 产品事实。

验证：frontmatter、领域边界、链接和真实检索检查。

## 阶段84：Lunkr 反馈入口

交付：

- `/feedback` 命令解析和反馈类型；
- 回答 request id 和短期 FeedbackReceiptStore；
- 命令不分配新问题 id；
- 原文仅在主动反馈时持久化；
- 伪匿名用户标识和审计入口；
- 无运营服务时反馈失败不影响问答。

验证：命令、过期、重复、隐私和 Bridge 并发测试。

## 阶段85：运营数据层与 Worker

交付：

- PostgreSQL migration；
- feedback、card revision、review、approval、regression、release、audit、job 数据访问层；
- RBAC 和职责分离；
- PostgreSQL 后台任务领取；
- 路径白名单 Git worktree、Schema 校验和 diff；
- 回归任务、发布清单、只读快照和回滚；
- Worker 不进入在线回答依赖。

验证：数据层测试、权限矩阵、并发 job、路径安全、Git fixture、发布和回滚集成测试。

## 阶段86：知识运营管理后台

交付：

- 创建 `apps/knowledge-ops`；
- 运营总览、工单、三栏审核、答案卡、知识浏览、冲突、回归、发布、审计、权限页面；
- 桌面数据密集布局和移动降级；
- 键盘导航、可见焦点、状态文本、loading/error/empty state；
- 所有 mutation 做服务端鉴权和输入校验。

视觉基线：Slate 中性色、蓝色操作强调、4/8px 间距、36-40px 表格行、240px 侧栏、56px 顶栏、150-250ms 非阻塞状态过渡。

验证：构建、类型、组件测试、页面路由、权限、375/768/1024/1440 布局和可访问性检查。

## 阶段87：企业回归重构

交付：

- 删除问题复述可通过 obligation 的纯关键词漏洞；
- 结构、证据、安全和语义四层评测；
- 每卡片生成同义问法、错别字、追问、反例、过期和缺证据场景；
- 覆盖专业、通用、混合、多问、多轮、冲突、过期、输入不足和格式；
- 人工金标准与自动检查分开记录。

验证：评测器反作弊单元测试、固定回归、四会话二十题和扩展场景族。

## 阶段88：端到端验收

交付：

- 三仓全量构建、测试和 diff 检查；
- 管理后台不可用、数据库不可用、Worker 不可用的在线隔离验证；
- 发布与回滚演练；
- 隐私、RBAC、路径安全和审计验证；
- deepseek_v4_flash 四会话真实问题验收；
- 性能报告和上线结论。

只有设计中的每条验收原则都有当前文件、命令输出、运行记录或真实模型结果证明时，才允许声明整体完成。

## 阶段89：快捷反馈与品牌化问答交互

交付：

- 保留 `/feedback`，新增 `/q 1-4` 和可选问题编号语法；
- 新增 `/status`，只展示当前用户可靠的处理中、排队中和空闲状态；
- 选项 1-3 分别对应有用、错误和缺失，选项 4 必须携带用户候选正确答案；
- 回答交付完成后单独发送反馈菜单，短回答、长回答附件和降级分段路径行为一致；
- 即时回执改为 PSEAgent 自有的“检索并核对相关资料”文案，并只提示 `/status`、`/new`、`/help`；
- 扩展共享反馈契约、加密反馈载荷和 PostgreSQL 兼容迁移；
- 管理后台区分普通评论与用户候选答案；
- 格式错误、过期、重复和反馈服务失败均给出可恢复提示，且不影响在线问答。

验证：共享契约测试、Lunkr 命令与 Bridge 测试、Knowledge Ops 服务与迁移测试、管理后台类型检查和构建、全量 TypeScript 类型检查。

## 阶段137：Lunkr 真实任务进度

交付：

- 从现有脱敏 `DiagnosticEvent` 派生独立的用户可见进度快照，不读取或转发问题、答案、查询词、知识路径、正文和模型原始载荷；
- `AnswerService.answerDetailed` 增加可选的进度观察器，观察器异常不得改变诊断或回答路径；
- Bridge 以用户、会话代次和问题编号保存处理耗时、流程阶段、需求数、检索完成数、证据读取数、覆盖核验数和最后更新时间；
- `/status` 合并 PeerScheduler 的真实处理/排队状态与回答管线快照，尚未知的计数不展示；
- `/new`、完成、失败、取消和重试正确重置或清理快照，进度不跨 Bridge 重启持久化；
- 不展示无法证明的百分比和预计完成时间，不展示模型思维链。

验证：进度转换单元测试、Bridge 状态与并发/取消测试、Lunkr Direct 与 PSEAgent 定向测试、全量 TypeScript 类型检查和测试、`git diff --check`。

## 阶段145：答案卡问题族映射与复查纠偏

交付：

- `family/partial` 保留用户 TaskSpec 的证据类型、客户输入状态、来源文本和知识域；
- 仅在主题、证据角色和知识域能够唯一解释时绑定卡片义务，消除零相似度首任务兜底；
- 不兼容或重复卡片义务使用独立 obligation，映射仍不唯一时安全返回 `binding_unmapped`；
- 激活摘要携带脱敏 Guard issue code；
- 独立复查按真实 `exact/family/partial` 类型展示治理链路告警，不再把问题族命中称为精确命中。

验证：答案卡适配、在线集成、诊断脱敏、独立复查和 Worker 定向测试，PSEAgent 与 Worker 类型检查，全量 TypeScript 测试及 `git diff --check`。
