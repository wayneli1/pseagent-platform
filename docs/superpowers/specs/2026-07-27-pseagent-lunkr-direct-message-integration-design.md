# PSEAgent 直连 Lunkr 私聊设计

日期：2026-07-27

## 背景

PSEAgent 已在 `pseagent-platform` 中提供独立的 `answer(question, conversationContext)` 运行接口，但正式聊天入口尚未接入。此前的 `feature/lunkr-openclaw-integration` 依赖 OpenClaw Gateway、Channel、Agent binding 和插件内部路由，不再符合当前范围。

本次接入只在 `pseagent-platform` 的新分支中实现，不使用 OpenClaw、OpenCode、Codex 或其他外层 Agent harness。Lunkr 仅承担消息输入和回答输出，问答路由、知识检索、模型调用和引用继续由 PSEAgent 内部完成。

用户已确认：

- 使用专用 Lunkr 账号；
- 使用邮箱和密码登录；
- 仅在服务端强制要求时进行手机二次验证，不实现认证绕过；
- 首期只支持机器人私聊；
- 首期在当前 Windows 电脑前台运行。

## 目标

- 提供不依赖 OpenClaw 的 Lunkr 登录、Session 复用、实时私聊监听和文本回复能力。
- 每条合格私聊消息只调用一次 PSEAgent `answer()`。
- 回答始终发送回原私聊，不允许跨会话串线。
- 忽略机器人自己的消息，按消息 ID 去重，避免循环回复。
- 同一私聊内顺序处理消息，不同私聊可并行。
- 使用有界对话上下文支持连续追问，并提供 `/new` 清空当前私聊上下文。
- 密码不落盘；Session 与 Cookie 加密保存在用户目录，不进入 Git。
- 默认验证 TLS 证书，不在日志中输出密码、Cookie、SID、消息正文、回答正文或模型密钥。

## 非目标

- 不使用或兼容 OpenClaw Gateway、OpenClaw Channel API、Agent binding 或 OpenClaw 配置。
- 不接入普通群、讨论组、`/bot`、@ 提及或 Bot discussion。
- 不处理图片、语音、视频、文件和富交互卡片；首期返回固定的仅文字提示。
- 不把 Lunkr 的 226 个业务 API 全部暴露为 MCP 工具。
- 不让外层聊天入口自行调用知识工具、搜索或模型。
- 不保存邮箱密码，不尝试绕过服务端 OTP、验证码或风控要求。
- 不在首期安装 Windows 服务或计划任务；先以前台进程完成真实验收。

## 参考材料与采用边界

用户提供的 `lunkr-mcp-export-20260226_163948.zip` 包含 MIT 标记的 TypeScript、Python、Go 和 Rust 实现。TypeScript 代码已确认能够编译，并提供：

- 域名发现、RSA 密码加密、OTP 和 Lunkr Session 获取；
- Lunkr HTTP JSON API；
- Socket.IO/Engine.IO 3 实时消息连接；
- 联系人、消息和文件相关高级 API。

本项目只适配登录、Session、私聊收发所需的最小实现，不复制 MCP Server、226 API catalog、群管理或文件能力。适配时必须修正参考实现中的以下问题：

- WebSocket 不得使用 `rejectUnauthorized: false`；
- debug 日志不得输出解密后的 Cookie；
- 不启用保存密码功能；
- 测试必须使用项目现有 Vitest，而不是参考包中未配置完成的 Jest；
- HTTP、Socket.IO、消息解析和业务编排必须通过接口隔离，支持无网络单元测试。

`lunkr-skill.zip` 中未签名的 Windows CLI 只作为人工协议验证参考，不作为运行时依赖，也不提交到仓库。

## 总体架构

```text
Lunkr 私聊
  ↓ Socket.IO message event
LunkrTransport
  ↓ 规范化、仅私聊、忽略自己、去重
DirectMessageBridge
  ↓ 同会话串行、构建有界 conversationContext
PseAgentRuntime.answer(question, conversationContext)
  ↓ AnswerResult
formatMcpText
  ↓ 分段
LunkrTransport.sendText(peerUid, text)
```

## 目录设计

```text
pseagent-platform/
├─ apps/
│  └─ pseagent/
│     └─ package.json                  # 导出嵌入式 runtime 与响应格式化接口
├─ integrations/
│  └─ lunkr-direct/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ tsconfig.build.json
│     └─ src/
│        ├─ contracts.ts               # Transport、消息、问答接口
│        ├─ redaction.ts               # 日志脱敏
│        ├─ config.ts                  # 非秘密运行配置
│        ├─ session-store.ts           # 加密 Session/Cookie
│        ├─ http-client.ts             # TLS HTTPS 与 Cookie 处理
│        ├─ auth.ts                    # 邮箱密码登录与条件式 OTP
│        ├─ lunkr-api.ts               # Session 验证和文本发送
│        ├─ socket-client.ts           # Engine.IO 3 / Socket.IO 实时连接
│        ├─ message-normalizer.ts       # 事件负载转私聊消息
│        ├─ conversation-store.ts       # 有界内存上下文
│        ├─ bridge.ts                   # 去重、串行和问答编排
│        ├─ cli.ts                      # login/status/start
│        └─ *.test.ts
├─ scripts/
│  ├─ lunkr-login.mts
│  ├─ lunkr-status.mts
│  └─ lunkr-start.mts
└─ docs/
   ├─ local-runbook.md
   └─ verification/
      ├─ pseagent-lunkr-direct-offline-readiness.md
      └─ pseagent-lunkr-direct-live-acceptance.md
```

## 登录与认证

### 登录命令

用户在真实 PowerShell 中运行：

```powershell
npm run lunkr:login
```

流程：

1. 提示输入专用账号邮箱。
2. 从邮箱域名发现 Coremail 服务地址。
3. 获取服务端 RSA 公钥并在本地加密密码。
4. 登录 Webmail。
5. 若返回 `FA_NEED_DYNAMIC_PWD`，提示用户在手机端完成二次确认后继续；未要求时不进入该流程。
6. 将 Webmail Session 转换为 Lunkr Session。
7. 验证 Lunkr Session。
8. 加密保存 Lunkr SID、Cookie、账号标识和设备信息。
9. 立即清除内存中的密码引用，不保存密码。

测试环境不等于可以跳过基础登录认证。实现不得伪造认证结果或关闭服务端安全检查。

### Session 文件

默认位置：

```text
%USERPROFILE%\.config\pseagent-lunkr\session.json
```

保存字段：

- 版本号；
- 账号邮箱；
- 自身 Lunkr UID；
- 设备 UUID；
- 加密后的 SID；
- 加密后的 Cookie；
- 创建时间和最后验证时间。

加密使用 AES-256-GCM。密钥由稳定设备 UUID、Windows 主机名和当前系统用户名派生。日志只允许输出 `configured=true/false`、`valid=true/false` 和非敏感错误码。

## 私聊消息契约

规范化后的入站消息：

```ts
interface LunkrDirectMessage {
  readonly messageId: string;
  readonly senderUid: string;
  readonly peerUid: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly hasAttachments: boolean;
}
```

只接受满足全部条件的事件：

- Socket.IO 事件名为 `message`；
- payload 可解析；
- 消息来源为私聊用户 UID；
- 发送者不是机器人自身 UID；
- 消息 ID 未处理；
- 文本非空。

群、讨论组、频道和无法确认类型的事件默认拒绝，不通过猜测路由。

打开聊天窗口、已读回执、输入状态、在线状态、送达回执等控制事件必须静默
忽略，不得被规范化为用户消息，也不得向用户发送“当前仅支持文字私聊。”
提示。空数组、空对象或 `null` 的附件容器不算真实附件。只有附件字段中
实际存在文件信息，或消息类型明确为图片、文件、语音、音频、视频、卡片等
非文字内容时，才标记 `hasAttachments=true`。

## 触发、权限与固定命令

专用账号的合格私聊文本自动触发 PSEAgent，不要求 `/bot`。

首期提供：

- `/new`：清空当前 peer 的内存上下文并固定回复“已开始新会话。”；
- `/help`：返回简短使用说明；
- 非文字或带附件消息：固定回复“当前仅支持文字私聊。”。

上述固定提示仅针对用户实际发送的非文字内容；会话打开、已读、typing、
presence 等客户端或服务端控制事件一律不回复。

可选环境变量 `LUNKR_DM_ALLOWLIST` 使用逗号分隔 UID。未配置时允许向专用账号发起私聊的用户；配置后仅允许列表内用户。

## 对话上下文

每个 `peerUid` 独立保存最近 6 轮用户与机器人文本。上下文总字符数上限为 12,000，超过时从最旧轮次开始删除。上下文只保存在当前进程内存中，Windows 进程重启后清空。

调用规则：

```text
answer(currentQuestion, boundedConversationContext)
```

只有调用成功并完成回复后才把本轮用户问题和回答写入上下文。失败回复不进入上下文。

## 并发、去重与故障

- 按 `peerUid` 建立 Promise 队列，同一私聊严格串行。
- 消息 ID 使用有界 TTL 集合去重，默认保留 10,000 条或 24 小时。
- PSEAgent 单次调用沿用现有模型和知识服务超时。
- 发送失败最多重试两次；不得重复调用 PSEAgent。
- Socket 断线使用指数退避重连，最大 120 秒。
- Session 失效时停止重连并提示重新执行 `npm run lunkr:login`。
- 启动和停止使用 `AbortSignal`，关闭时依次停止收消息、等待当前处理、关闭 PSEAgent runtime。

## 输出格式

复用 `formatMcpText()`，保留现有答案和历史资料辅助内容。Lunkr 单条文本按不超过 1,000 字符分段，优先在段落或换行边界切分；所有分段仍发送回同一 `peerUid`。

## 配置

新增非秘密配置项：

```text
LUNKR_SESSION_PATH
LUNKR_DM_ALLOWLIST
LUNKR_CONNECT_TIMEOUT_MS
LUNKR_RECONNECT_MAX_MS
LUNKR_MESSAGE_DEDUPE_TTL_MS
LUNKR_MESSAGE_DEDUPE_MAX
LUNKR_CONTEXT_MAX_TURNS
LUNKR_CONTEXT_MAX_CHARS
```

邮箱、密码、SID、Cookie 不进入 `.env.local`。密码只通过交互式隐藏输入获取。

## Windows 运行方式

首期以前台 PowerShell 运行：

```powershell
npm run lunkr:status
npm run lunkr:start
```

`lunkr:start` 从 `.env.local` 加载现有 PSEAgent 变量，连接 Knowledge MCP、公司模型和 Lunkr。真实私聊验收完成后再单独设计登录计划任务或 Windows 服务，不在首期提前创建系统级持久化。

## 验收

### 离线

- TypeScript typecheck、Vitest、build 和现有 Rust 测试全部通过。
- 登录响应、OTP 分支、Session 加密、Socket 帧解析、私聊识别、忽略自己、去重、同 peer 串行、上下文隔离和分段发送均有无网络测试。
- 打开聊天窗口、已读、typing、presence 和空附件容器均被静默忽略；真实附件仍只回复固定文字提示。
- 仓库不存在密码、SID、Cookie、消息正文或回答正文。
- 运行时代码不包含 `openclaw` 命令、依赖或配置路径。

### 真实

1. 专用账号登录成功，Session 文件已创建且密码未保存。
2. `lunkr:status` 报告 Session 有效。
3. 用户向专用账号发送一条私聊文本，机器人只回复一次。
4. 连续追问能使用同一私聊上下文。
5. 另一个用户私聊时上下文不串线。
6. 机器人回复不会触发自身再次回答。
7. `/new` 后上下文清空。
8. 群消息和附件不进入 PSEAgent。
9. 重启前台进程后能够复用 Session 并继续接收私聊。

验收记录只保存结构化状态、scope、status、引用数量、耗时和版本，不保存消息或回答正文。
