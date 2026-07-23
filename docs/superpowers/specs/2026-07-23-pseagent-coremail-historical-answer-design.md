# PSEAgent Coremail MCP 历史资料辅助回答设计

日期：2026-07-23
状态：用户已逐节审核确认

## 1. 目标

当且仅当 PSEAgent 正式知识问答返回 `not_covered` 时，调用本机只读 Coremail MCP 的 `answer_coremail_knowledge`，将有 Jira/Wiki 来源支持的结果作为未经验证的历史资料独立返回。

正式知识库结论继续保持权威：

```json
{
  "status": "not_covered",
  "answer": "固定未覆盖文本",
  "references": []
}
```

历史资料只能进入可选字段 `historicalAnswer`，不得合并到正式答案，不得提升正式状态，也不得进入正式 `references`。

## 2. 已确认的使用范围

- 首期只在当前 Windows 电脑、当前用户账户下运行。
- Coremail MCP 使用用户个人 Jira/Wiki 账号；部署时完成一次本机登录，之后静默刷新。
- 账号密码不得通过聊天传递，不进入 PSEAgent 配置、日志、测试、Git 或验收记录。
- 接受 Coremail MCP 当前本机认证文件的加密方式；本期不改用 Windows Credential Manager 或 DPAPI。
- OpenCode 只作为临时测试入口。验收边界是 `pse_answer` 的文本和 `structuredContent`，不要求 OpenCode 外层模型的最终措辞逐字一致。
- 未来聊天工具直接消费 `structuredContent`，并按字段确定性渲染。
- 现有 `coremail_air` 是无关的邮件能力 MCP，保持原样。本功能只禁止把 `coremail-knowledge-mcp` 直接注册到 OpenCode。

## 3. 仓库与发布边界

### 3.1 PSEAgent 平台仓库

现有仓库：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform
```

负责：

- 历史回答数据契约和 MCP 文本渲染；
- 只读 Coremail MCP 客户端；
- `not_covered` 后的降级编排；
- 配置、运行时生命周期、探针、运行手册和验收记录。

### 3.2 Coremail MCP 源码仓库

新增独立本地 Git 仓库：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp
```

源码来自原始归档：

```text
C:\Users\Coremail\Desktop\coremail-knowledge-mcp-bootcamp-465941c.zip
SHA-256: AB45A26522D73A3A53249515CAA32973DE9C9CFA6143B0E4FDD498C04B13D439
```

原始 ZIP 保持不变。新仓库先提交未经功能修改的导入基线，再单独实现非交互认证开关。仓库不配置 remote、不 push。

### 3.3 运行版

从通过验证的 Coremail MCP 源码提交发布到：

```text
C:\Users\Coremail\.local\share\coremail-knowledge-mcp\
├── releases\
│   └── <完整 Git commit>\
└── current → 当前通过验收的 release
```

PSEAgent 只连接：

```text
C:\Users\Coremail\.local\share\coremail-knowledge-mcp\current\dist\server.js
```

禁止连接或启动 `dist/writeback-server.js`，禁止执行 Coremail MCP 的 OpenCode/Codex 部署注册脚本。

### 3.4 执行约束同步

当前 `pseagent-platform/AGENTS.md` 仍记录“三个直接子目录”和“首期不实现 Coremail MCP”。后者描述的是已完成的首期边界，但前者会在创建第四个仓库后失效。

实施计划必须先安排一个独立的平台约束更新：

- 把工作区说明更新为四个独立 Git 仓库；
- 明确 Coremail MCP 历史资料功能属于用户新批准的后续阶段；
- 保留跨仓独立暂存、独立验证、独立提交以及未经授权不创建 remote、不 push 的约束。

在该约束提交完成前，不创建第四个仓库。

## 4. 总体数据流

```text
用户问题
  → PSEAgent ScopeRouter
  → normal：直接返回普通回答
  → professional/general：运行正式知识问答
      → answered：直接返回
      → partially_answered：直接返回
      → temporarily_unavailable：直接返回
      → not_covered：
          → Coremail MCP 未配置：返回原结果
          → 懒连接只读 Coremail MCP
          → 调用 answer_coremail_knowledge
          → 严格清洗和验证
              → 合格：在原结果上增加 historicalAnswer
              → 失败：返回原结果
```

Coremail MCP 阶段不调用任何模型。PSEAgent 不使用 PSE 模型或其他模型总结、修正、扩写或改写 Coremail MCP 的 `answer`。

## 5. 数据契约

### 5.1 固定警告

代码中使用一个共享常量保存以下固定警告：

```text
以下内容由 Coremail MCP 根据 Jira/Wiki 历史资料自动整理，未经过产品或售前人员验证。资料可能过时、不完整或不准确，请勿直接作为投标、部署、升级或变更依据。
```

契约使用字面量校验，不接受任意替代警告。

### 5.2 历史来源

```ts
export const historicalReferenceSchema = z.object({
  sourceType: z.enum(["jira", "wiki"]),
  id: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  versions: z.array(z.string().min(1)).max(20).optional(),
  status: z.string().min(1).optional(),
}).strict();
```

`versions` 保留 Jira `metadata.fix_versions` 的全部字符串值，不把多个版本压成单个不可解析字符串。

### 5.3 历史回答

```ts
export const historicalAnswerSchema = z.object({
  provider: z.literal("coremail_mcp"),
  verified: z.literal(false),
  confidence: z.enum(["low", "medium", "high"]),
  warning: z.literal(HISTORICAL_ANSWER_WARNING),
  answer: z.string().min(1).max(32_768),
  references: z.array(historicalReferenceSchema).min(1).max(20),
}).strict();
```

`answerResultSchema` 增加：

```ts
historicalAnswer: historicalAnswerSchema.optional()
```

这是向后兼容的可选字段。主 `scope`、`status`、`answer` 和 `references` 的现有类型与含义不变。

## 6. Coremail MCP 结果清洗

客户端优先读取 `structuredContent`；仅当其不存在时，才尝试把第一个文本内容解析为 JSON。

只允许映射以下公开字段：

- `answer`
- `confidence`
- `sources[].source_type`
- `sources[].id`
- `sources[].key`
- `sources[].title`
- `sources[].url`
- `sources[].updated_at`
- `sources[].metadata.status`
- `sources[].metadata.fix_versions`

不得返回或保留：

- `diagnostics`
- `structured_answer`
- `evidence_bundle`
- Jira/Wiki 正文或评论正文
- 认证信息
- 原始工具结果
- 未列入契约的 metadata

清洗规则：

1. `answer` 必须包含非空白内容，且长度不超过 32,768 个 Unicode 字符。
2. 验证时可以检查去除空白后的长度，但返回值必须保留 Coremail MCP 原始 `answer`，不得 `trim`、截断或重写。
3. `confidence="none"` 不产生 `historicalAnswer`。
4. `low`、`medium`、`high` 均允许展示，并如实标注。
5. 只接受 `source_type="jira"` 或 `"wiki"`；`"local"` 和未知类型被过滤。
6. 来源按稳定标识去重后限制为 20 条。
7. 过滤后没有 Jira/Wiki 来源时，不展示历史答案。
8. 任一顶层必需字段非法时返回 `undefined`，不得把异常细节暴露给用户。

## 7. 确定性文本渲染

没有 `historicalAnswer` 时，`formatMcpText()` 保持当前行为，只返回正式 `answer`。

存在 `historicalAnswer` 时依次输出：

1. PSEAgent 固定 `not_covered` 文本；
2. `Jira/Wiki 历史资料辅助回答` 标题；
3. 固定警告；
4. 中文可信度；
5. Coremail MCP 原始 `answer`；
6. 历史来源列表。

历史来源按可用性展示：

- Jira/Wiki 类型；
- Jira key 或 Wiki/page id；
- 标题；
- 更新时间；
- 状态；
- 全部适用/修复版本；
- 内部链接。

正式 `references` 与历史来源永不合并。原始 Markdown 和 Mermaid 保留；未来聊天界面负责进行安全的 Markdown/Mermaid 渲染，不执行不受信任的 HTML 或脚本。

## 8. 只读 Coremail MCP 客户端

PSEAgent 新增内部接口：

```ts
export interface HistoricalAnswerProvider {
  answer(question: string, signal?: AbortSignal): Promise<HistoricalAnswer | undefined>;
  close(): Promise<void>;
}
```

客户端不暴露通用 `call()`。内部唯一允许的工具名是：

```text
answer_coremail_knowledge
```

固定参数：

```ts
{
  question,
  intent: "auto",
  limit: 8,
  includeComments: true,
  commentMode: "relevant",
  profileRanking: true,
  explainRanking: false,
  includeRelationExpansion: true,
  relationDepth: 1,
  diagnosticsLevel: "summary",
}
```

客户端行为：

- 构造时不连接；
- 第一次 `not_covered` 调用时才校验入口并启动 stdio 子进程；
- `tools/list` 必须包含 `answer_coremail_knowledge`；
- 并发首调共享连接过程；
- 多次调用复用已连接客户端；
- 连接失败后清理状态，后续请求允许重新连接；
- 单次调用使用配置超时并同时服从上游 `AbortSignal`；
- 超时或传输损坏时关闭失效客户端和子进程；
- `close()` 幂等；
- 空答案、非法结果、无 Jira/Wiki 来源和所有运行错误均返回 `undefined`。

客户端错误不得抛到 `AnswerService` 之外。

## 9. 非交互认证

现有 Coremail MCP `dist/server.js` 在认证异常时可能自动执行凭据刷新、浏览器 Cookie 导入并启动临时浏览器。为满足本机聊天使用的无感要求，Coremail MCP 仓库增加：

```text
KNOWLEDGE_AUTH_INTERACTIVE=true
```

默认值为 `true`，保持现有客户端兼容性。

当 PSEAgent 显式设置为 `false` 时：

- 允许读取本机认证文件；
- 允许使用已保存账号密码执行静默刷新；
- 禁止调用 `import-browser` 或 `login-browser`；
- 禁止启动 Edge/Chrome；
- 禁止等待用户完成 SSO；
- 静默刷新失败时立即返回认证失败；
- 即使误调用 `auth_login`，也不得进入浏览器登录分支。

部署时由用户在本机终端运行官方登录命令并通过隐藏输入完成一次初始化。PSEAgent 不负责收集、保存或传递账号密码。

用户已确认接受 Coremail MCP 当前认证文件的本机加密方式。本期通过以下边界降低风险：

- 仅限当前 Windows 用户和本机；
- 认证文件不复制、不提交、不进入验收记录；
- PSEAgent 子进程使用默认认证文件路径；
- 密码失效时历史功能降级，不把认证错误显示给聊天用户。

## 10. 隐私与子进程环境

PSEAgent 启动 Coremail MCP 时使用 Node 所需的标准系统环境，并强制设置：

```text
AI_ADOPTION_ENABLED=false
KNOWLEDGE_ENABLE_CACHE=false
KNOWLEDGE_AUTH_INTERACTIVE=false
```

不得向 Coremail MCP 子进程传递：

- `PSE_MODEL_BASE_URL`
- `PSE_MODEL_API_KEY`
- `PSE_MODEL_NAME`
- Knowledge Engine Token
- 本轮 `conversationContext`
- 其他不属于 Coremail MCP 的应用密钥

只把本轮 `question` 作为固定工具参数发送。依赖上文的追问应由调用方改写成可独立理解的问题，本期不把整段聊天记录传入 Jira/Wiki 检索。

关闭 AI Adoption 和 Coremail MCP 本地知识缓存是强制行为，不允许被普通 PSEAgent 配置误开启。

## 11. PSEAgent 编排

`AnswerService` 的正式回答流程先完整结束：

```ts
const primary = await runPrimaryAnswer();
```

只有以下条件全部成立时才调用历史提供器：

- `primary.status === "not_covered"`
- 已配置 `HistoricalAnswerProvider`

成功时：

```ts
return { ...primary, historicalAnswer };
```

失败或没有合格历史答案时：

```ts
return primary;
```

必须返回原来的 `primary` 对象，不重建或改写字段。`answered`、`partially_answered`、`normal` 和 `temporarily_unavailable` 均不得调用历史提供器。

## 12. 配置

`.env.example` 增加：

```text
COREMAIL_MCP_ENABLED=false
COREMAIL_MCP_COMMAND=node
COREMAIL_MCP_ENTRY_PATH=C:/Users/Coremail/.local/share/coremail-knowledge-mcp/current/dist/server.js
COREMAIL_MCP_TIMEOUT_MS=30000
```

校验规则：

- `COREMAIL_MCP_ENABLED` 只接受明确的 `true` 或 `false`；
- 关闭时，command 和 entry path 可以缺失；
- 启用时，command 和绝对 entry path 必填；
- timeout 为 1,000–120,000 毫秒，默认 30,000；
- entry path 必须是绝对路径；
- 入口文件必须为 `dist/server.js`；
- 明确拒绝 `writeback-server.js`。

账号密码和 Coremail MCP 认证数据不进入 PSEAgent `.env.local`。

## 13. 生命周期与故障隔离

PSEAgent 启动时继续同步连接现有 Knowledge MCP，但不连接 Coremail MCP。Coremail MCP 配置或运行异常不得阻止 PSEAgent 启动。

关闭运行时时，并行、独立关闭：

- PSE MCP server；
- Knowledge MCP client；
- Coremail MCP client（如果曾启动）。

任一关闭失败不影响其他组件。`close()` 必须幂等。

Coremail MCP 所有错误对用户静默。PSEAgent 本机 stderr 只允许输出有限脱敏错误码：

```text
coremail_mcp_timeout
coremail_mcp_connect_failed
coremail_mcp_auth_failed
coremail_mcp_invalid_result
coremail_mcp_closed
```

不得输出问题、答案、来源标题、URL、账号、密码、Cookie、Token、认证路径内容或底层异常正文。

Coremail MCP 不可用时，主结果不得从 `not_covered` 变成 `temporarily_unavailable`。

## 14. 测试设计

### 14.1 Coremail MCP 仓库

先运行原始测试建立基线，再完成红绿验证：

- 默认交互模式保持现有认证恢复行为；
- 非交互模式允许静默凭据刷新；
- 非交互模式禁止 `import-browser`；
- 非交互模式禁止 `login-browser`；
- 非交互模式禁止启动浏览器或进入 SSO 等待；
- 静默刷新失败时返回认证失败；
- 其他只读知识工具行为不变；
- TypeScript 类型检查、单元测试和构建全部通过。

### 14.2 PSEAgent 契约与渲染

- 没有 `historicalAnswer` 时文本输出不变；
- 有历史回答时按固定顺序渲染；
- 固定警告不可替换；
- 主 `not_covered` 字段与正式引用不变；
- 历史来源与正式引用完全隔离；
- 多个版本完整展示；
- 原始 Markdown/Mermaid 保留。

### 14.3 PSEAgent 客户端

- 懒连接；
- 并发首连只启动一次；
- 连接复用；
- 只调用固定工具和固定参数；
- 不传模型密钥或对话上下文；
- 优先解析 `structuredContent`；
- 文本 JSON 仅作为兼容回退；
- 正确映射 Jira/Wiki 来源；
- 过滤 `local` 和未知来源；
- `low` 可展示；
- `none` 不展示；
- 无 Jira/Wiki 来源不展示；
- 多版本数组完整映射；
- 原始答案和 Mermaid 逐字保留；
- 超长、空白和非法结果返回 `undefined`；
- 超时、连接失败、认证失败返回 `undefined`；
- 日志只有脱敏错误码；
- `close()` 幂等。

### 14.4 服务、配置与运行时

- 只有 `not_covered` 调用一次历史提供器；
- 其他状态调用零次；
- 历史失败时逐字段且逐对象保持原结果；
- 禁用配置时不创建历史客户端；
- 启用配置时执行条件校验；
- 运行时启动不连接 Coremail MCP；
- 运行时关闭三个组件且相互隔离；
- Coremail MCP 关闭失败不影响 Knowledge MCP 和 PSE MCP。

## 15. 真实验收

真实验收使用计划中的 Jira 工单问题作为受控用例，但证据文件不保存问题正文。

成功条件：

- PSEAgent 主结果仍为 `status="not_covered"`；
- 主 `answer` 仍为固定未覆盖文本；
- 主 `references=[]`；
- `historicalAnswer.provider="coremail_mcp"`；
- `historicalAnswer.verified=false`；
- confidence 为 `low`、`medium` 或 `high`；
- 历史答案非空且不超过 32,768 字符；
- 至少一条 Jira/Wiki 历史来源；
- 用户文本包含固定警告；
- PSEAgent 历史答案与 Coremail MCP 原始 `answer` 逐字符相同；
- 历史阶段没有第二次模型调用；
- 禁用或破坏 Coremail MCP 路径后仍返回原始 `not_covered`；
- 正常知识库回答不启动 Coremail MCP；
- 认证异常时不启动浏览器；
- OpenCode 不直接注册 `coremail-knowledge-mcp`；
- 现有 `coremail_air` 和其他无关 MCP 保持不变。

脱敏验收记录只保存：

- 两个仓库的完整提交哈希；
- PSEAgent 固定知识库 revisions；
- Node、Cargo、OpenCode 和公司模型名称；
- 状态、历史来源数量、可信度；
- 原文一致性、无第二模型、无浏览器等布尔检查；
- 耗时、进程身份和配置边界检查结果。

不得保存问题、回答、工单/Wiki 正文、内网 endpoint、账号、密码、Cookie、Token 或认证异常正文。

## 16. 提交顺序

设计规格先在 `pseagent-platform` 单独提交，之后才进入实施。

实施阶段按以下顺序创建独立中文提交：

1. PSEAgent 工作区与阶段执行约束同步；
2. Coremail MCP 原始 ZIP 导入基线；
3. Coremail MCP 非交互认证开关与测试；
4. PSEAgent 历史回答契约与渲染；
5. PSEAgent 只读 Coremail MCP 客户端；
6. PSEAgent 服务、配置和运行时接入；
7. 部署、探针、运行手册和脱敏真实验收。

每个提交正文必须包含“完成内容”和“验证结果”。两个源码仓库均不配置 remote、不 push。

## 17. 明确不实施

- 不把历史答案合并进正式回答；
- 不把历史来源放入正式 `references`；
- 不根据历史资料可信度提升正式状态；
- 不在 `partially_answered` 后查询历史资料；
- 不传 `conversationContext`；
- 不使用模型二次总结或改写历史答案；
- 不显示没有 Jira/Wiki 来源的历史答案；
- 不接受 `local` 来源；
- 不启用 Coremail MCP 缓存或 AI Adoption 统计；
- 不在问答请求中打开浏览器；
- 不接入写回、缓存同步、Judge、评分或人工审核系统；
- 不修改 Rust Knowledge Engine、内部 Knowledge MCP、Agent Loop 或现有知识库检索与引用逻辑；
- 不修改或移除现有 `coremail_air`；
- 不把 `coremail-knowledge-mcp` 直接注册到 OpenCode；
- 不在本期强化 Coremail MCP 认证文件的加密实现；
- 不创建 remote，不 push。
