# PSEAgent 直连 Lunkr 私聊实施计划

**目标：** 在 `feature/lunkr-direct-integration` 分支中实现不依赖 OpenClaw 的 Lunkr 专用账号私聊入口，并在当前 Windows 电脑完成前台真实验收。

**架构：** Lunkr Socket.IO 客户端只接收并规范化私聊消息；Bridge 完成自身消息过滤、去重、权限、同会话串行和有界上下文；每条消息调用一次嵌入式 PSEAgent `answer()`；回答由最小 Lunkr HTTP API 分段发回原私聊。

**技术栈：** Node.js 24、TypeScript 7、Vitest 4、原生 HTTPS、`ws`、AES-256-GCM、现有 PSEAgent/Knowledge MCP/Knowledge Engine。

## 全局约束

- 只在 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` 的 `feature/lunkr-direct-integration` 分支工作。
- 不使用 OpenClaw、OpenCode 或 Codex 作为运行时，不安装或修改其插件。
- 不读取、复制或恢复已删除的 Lunkr/OpenClaw 分支实现。
- 用户提供的 Lunkr MCP 导出包只作为协议和最小客户端参考，不导入 226 API catalog 或 MCP Server。
- 不运行用户提供的未签名 `lunkr-cli.exe`。
- 密码、SID、Cookie、二维码、消息正文、回答正文和模型密钥不得进入 Git、测试快照或验收记录。
- 服务端未要求 OTP 时不触发二次验证；服务端强制要求时不得绕过。
- 每个阶段先验证再使用中文标题和正文创建独立 commit。
- 保留用户已有未跟踪目录 `.sisyphus/`。

## 阶段 30：设计与基线

**文件：**

- 新增设计规格。
- 新增本实施计划。

**验证：**

```powershell
git diff --check
rg -n "OpenClaw|私聊|邮箱密码|OTP|TLS|answer\\(" docs/superpowers/specs/2026-07-27-pseagent-lunkr-direct-message-integration-design.md
git status --short
```

**提交：**

```text
阶段 30：确定纯 Lunkr 私聊接入设计
```

## 阶段 31：建立 Lunkr 传输核心

**文件：**

- 新增 `integrations/lunkr-direct` workspace。
- 新增 contracts、config、redaction、session-store、HTTP client。
- 修改根 workspace、`.env.example`、`.gitignore` 和第三方说明。

**测试：**

- 配置默认值和拒绝非法值。
- AES-256-GCM round trip、错误设备密钥拒绝解密。
- 日志脱敏不泄露密码、SID、Cookie 和 Token。
- HTTPS 默认验证 TLS。

**验证：**

```powershell
npm install
npm exec -w @pseagent/lunkr-direct -- vitest run src/config.test.ts src/redaction.test.ts src/session-store.test.ts src/http-client.test.ts
npm run typecheck
git diff --check
```

**提交：**

```text
阶段 31：建立 Lunkr 安全传输核心
```

## 阶段 32：实现邮箱密码登录与 Session

**文件：**

- 新增域名发现、RSA 密码加密、Webmail 登录、条件式 OTP、Lunkr Session 转换。
- 新增 `lunkr:login` 和 `lunkr:status` 命令。
- 新增登录测试。

**测试：**

- 未要求 OTP 时不调用二次验证接口。
- `FA_NEED_DYNAMIC_PWD` 时等待用户确认并校验状态。
- 密码错误最多重试三次。
- 成功后只保存加密 SID/Cookie，不保存密码。
- status 只输出结构化非秘密状态。

**验证：**

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/auth.test.ts src/status.test.ts
npm run typecheck
npm run build
git diff --check
```

**提交：**

```text
阶段 32：实现 Lunkr 安全登录与会话复用
```

## 阶段 33：实现实时私聊收发

**文件：**

- 新增 Lunkr 最小文本发送 API。
- 新增 Engine.IO 3 / Socket.IO 客户端。
- 新增消息规范化、文本分段和 transport。

**测试：**

- 握手、升级、auth、ready、ping/pong 和断线重连。
- message payload 字符串/对象解析。
- 只接受可确认的私聊，拒绝群和未知类型。
- 忽略自身消息，附件标记正确。
- 长回答按 1,000 字符边界分段并保持接收者一致。

**验证：**

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/socket-client.test.ts src/message-normalizer.test.ts src/lunkr-api.test.ts
npm run typecheck
npm run build
git diff --check
```

**提交：**

```text
阶段 33：打通 Lunkr 实时私聊收发
```

## 阶段 34：连接 PSEAgent

**文件：**

- 为 `@pseagent/app` 增加嵌入式 runtime 导出。
- 新增 conversation store、dedupe、per-peer queue 和 bridge。
- 新增 `lunkr:start` 前台入口。

**测试：**

- 每条消息只调用一次 `answer()`。
- 同一 peer 串行，不同 peer 上下文隔离。
- 重复消息和自身消息不调用 PSEAgent。
- `/new`、`/help`、附件固定回复。
- PSEAgent 失败时固定回复且不写入上下文。
- 发送重试不重复调用 PSEAgent。

**验证：**

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/conversation-store.test.ts src/bridge.test.ts
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
git diff --check
```

**提交：**

```text
阶段 34：接通 Lunkr 私聊与 PSEAgent
```

## 阶段 35：Windows 前台运行与离线就绪

**文件：**

- 更新 `docs/local-runbook.md`。
- 新增离线就绪记录。
- 增加安全扫描和完整回归证据。

**验证：**

```powershell
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
rg -n -i "openclaw" integrations/lunkr-direct scripts/lunkr-*.mts
git status --short
```

预期 `openclaw` 搜索无结果；Git 状态只包含本阶段文档和用户原有 `.sisyphus/`。

**提交：**

```text
阶段 35：完成纯 Lunkr 私聊离线就绪
```

## 阶段 36：本机真实登录和私聊验收

本阶段需要用户在真实 PowerShell 中输入专用账号邮箱和密码。不得通过聊天、日志或命令参数传递密码。

**命令：**

```powershell
npm run lunkr:login
npm run lunkr:status
npm run lunkr:start
```

**验收：**

- 专用账号登录和 Session 复用。
- 单轮私聊只回复一次。
- 连续追问和 `/new`。
- 第二个私聊用户的上下文隔离。
- 附件固定回复、群消息不响应、自身消息不循环。
- 前台进程重启后 Session 继续可用。

真实验收只记录：

```text
login.configured
session.valid
socket.connected
socket.authenticated
dm.received
pse.scope
pse.status
pse.referenceCount
reply.sent
duplicateReplyCount
selfLoopCount
elapsedMs
```

**提交：**

```text
阶段 36：完成 Lunkr 私聊真实验收
```
