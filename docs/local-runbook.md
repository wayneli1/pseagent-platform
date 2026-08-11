# PSEAgent 本机运行手册

所有命令均在 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` 的 PowerShell 中执行。不要启动 Admin、Worker、Supabase、LLM Wiki App 或 public search；本运行路径只需要 Rust Knowledge Engine、只读 Knowledge MCP 子进程和唯一的 PSEAgent MCP。Coremail 历史资料 MCP 由 PSEAgent 在正式知识返回 `not_covered` 后按需启动，不要单独注册到 OpenCode。

## 1. 固定两个知识库 revision

```powershell
$expectedProfessionalRevision = '2f293528af751d8997e837b1a7569f4582a02059'
$expectedGeneralRevision = '26945059ca4b9796f2ff7c89ed84dca1c2d71641'
$professionalRevision = git -C ..\coremail-professional rev-parse HEAD
$generalRevision = git -C ..\presales-general rev-parse HEAD
if ($professionalRevision -ne $expectedProfessionalRevision) { throw 'unexpected_professional_revision' }
if ($generalRevision -ne $expectedGeneralRevision) { throw 'unexpected_general_revision' }
$professionalRevision
$generalRevision
```

## 2. 创建本机项目配置

该文件被 Git 忽略，不要提交：

```powershell
if (-not (Test-Path config\knowledge-projects.local.json)) {
  Copy-Item -LiteralPath config\knowledge-projects.example.json -Destination config\knowledge-projects.local.json
}
notepad config\knowledge-projects.local.json
```

确认两个 `rootPath` 分别指向 `coremail-professional` 和 `presales-general` 的绝对路径。

## 3. 创建本机环境文件

该文件被 Git 忽略。以下操作不会把密钥输出到终端：

```powershell
if (-not (Test-Path .env.local)) {
  Copy-Item -LiteralPath .env.example -Destination .env.local
}
notepad .env.local
```

填写主模型地址、密钥和模型名，并设置：

```text
KNOWLEDGE_PROJECTS_CONFIG=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/config/knowledge-projects.local.json
KNOWLEDGE_INDEX_ROOT=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/indexes
COREMAIL_PROFESSIONAL_REVISION=<步骤 1 的 professional revision>
PRESALES_GENERAL_REVISION=<步骤 1 的 general revision>
KNOWLEDGE_ENGINE_URL=http://127.0.0.1:19829
KNOWLEDGE_ENGINE_TOKEN=<本机随机 bearer token>
KNOWLEDGE_MCP_COMMAND=node
KNOWLEDGE_MCP_ENTRY_PATH=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/services/knowledge-mcp/dist/server.js
PSE_MODEL_TIMEOUT_MS=180000
COREMAIL_MCP_ENABLED=true
COREMAIL_MCP_COMMAND=node
COREMAIL_MCP_ENTRY_PATH=C:/Users/Coremail/.local/share/coremail-knowledge-mcp/current/dist/server.js
COREMAIL_MCP_TIMEOUT_MS=30000
PSE_DIAGNOSTICS_ENABLED=false
```

诊断轨迹默认关闭。只在本机开发排查时把 `PSE_DIAGNOSTICS_ENABLED` 改为
`true`；可选的 `PSE_DIAGNOSTICS_DIR` 必须是系统临时目录的子目录。轨迹仅记录
request ID、scope、规划项、查询、候选路径与分数、读页路径与章节标题、覆盖状态、
引用编号、停止原因和耗时，不记录模型完整回答、知识正文或认证数据。

## 4. 构建全部组件

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run build
npm --prefix ..\coremail-knowledge-mcp run typecheck
npm --prefix ..\coremail-knowledge-mcp test
npm --prefix ..\coremail-knowledge-mcp run build
```

## 5. 启动引擎、等待健康并运行真实探针

```powershell
$engineProcess = $null
try {
  Get-Content -LiteralPath .env.local | ForEach-Object {
    if ($_ -match '^\s*([^#=\s]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }

  $engineExe = (Resolve-Path target\release\knowledge-engine.exe).Path
  $stdoutLog = Join-Path $PWD 'knowledge-engine.stdout.log'
  $stderrLog = Join-Path $PWD 'knowledge-engine.stderr.log'
  $engineProcess = Start-Process -FilePath $engineExe -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  $ready = $false
  do {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:19829/health' -TimeoutSec 2
      $snapshots = @{}
      foreach ($snapshot in @($health.projects)) {
        $snapshots[$snapshot.project] = $snapshot.revision
      }
      $ready = $health.status -eq 'ready' `
        -and $snapshots.Count -eq 2 `
        -and $snapshots['coremail-professional'] -eq $expectedProfessionalRevision `
        -and $snapshots['presales-general'] -eq $expectedGeneralRevision
    } catch {
      $ready = $false
    }
    if (-not $ready) { Start-Sleep -Seconds 1 }
  } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if (-not $ready) { throw 'knowledge_engine_identity_timeout' }

  npm run probe:live
  if ($LASTEXITCODE -ne 0) { throw 'live_probe_failed' }
  npm run probe:coremail
  if ($LASTEXITCODE -ne 0) { throw 'coremail_historical_probe_failed' }
} finally {
  if ($null -ne $engineProcess -and -not $engineProcess.HasExited) {
    Stop-Process -Id $engineProcess.Id
    Wait-Process -Id $engineProcess.Id -ErrorAction SilentlyContinue
  }
}
```

默认探针按 `tests/regression/evidence-coverage.json` 执行五题黄金集，预期输出五行
脱敏摘要；设置 `PSE_PROBE_INCLUDE_PARAPHRASES=1` 时同时执行五个同义改写。知识题
必须为 `answered` 并包含黄金集规定的证据页，PSEAgent 自身题必须为 `normal` 且
引用为零，每题耗时不得超过 300 秒。历史摘要必须保持主结果 `not_covered` 和
`main_refs=0`，同时满足 `history_refs>=1`、`raw_equal=true`、`warning=true`。
输出不得包含问题、完整答案、来源标题、URL、知识页正文、内网地址或密钥。

## 6. 演练引擎不可用

确认上一步保存的精确 PID 已停止，然后只调用一个专业问题：

```powershell
$env:PSE_PROBE_EXPECT_UNAVAILABLE = '1'
try {
  npm run probe:live
  if ($LASTEXITCODE -ne 0) { throw 'unavailable_probe_failed' }
} finally {
  Remove-Item Env:PSE_PROBE_EXPECT_UNAVAILABLE -ErrorAction SilentlyContinue
}
```

预期 `scope=professional status=temporarily_unavailable refs=0`，且工具内部校验用户文本严格等于“知识问答服务暂时不可用，请稍后重试。”。

## 7. Coremail 历史资料运行版与认证

Coremail MCP 源码是独立、无 remote 的仓库：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp
```

运行版按源码完整提交哈希发布，PSEAgent 只连接 `current`：

```text
C:\Users\Coremail\.local\share\coremail-knowledge-mcp\
├── releases\
│   └── <完整 Git commit>\
└── current → releases\<完整 Git commit>
```

首次部署只在本机完成一次认证。账号和密码只输入本机隐藏提示，不写入 `.env.local`、日志、测试或 Git：

```powershell
Set-Location C:\Users\Coremail\.local\share\coremail-knowledge-mcp\current
npm run login
node scripts\coremail-auth.mjs status
```

如果 Jira/Wiki 强制返回 SSO 302，使用官方隔离浏览器流程并在弹出的临时窗口扫码；程序会在 Jira 和所有配置 Wiki 都验证成功后保存本机加密会话并自动关闭窗口：

```powershell
node scripts\coremail-auth.mjs login-browser
node scripts\coremail-auth.mjs status
```

密码失效或会话过期时重复上述流程。PSEAgent 子进程固定强制：

```text
AI_ADOPTION_ENABLED=false
KNOWLEDGE_ENABLE_CACHE=false
KNOWLEDGE_AUTH_INTERACTIVE=false
```

因此问答请求不会启动浏览器，不启用 Coremail MCP 缓存或 AI Adoption，也不会把模型密钥、Knowledge Engine Token 或整段对话传给 Coremail MCP。只发送本轮问题，历史回答不经过第二次模型改写。

Coremail MCP 不可用、认证失败、超时或结果不合格时，PSEAgent 原样返回正式 `not_covered`，不会改成 `temporarily_unavailable`。本机 stderr 只允许以下脱敏错误码：

```text
coremail_mcp_timeout
coremail_mcp_connect_failed
coremail_mcp_auth_failed
coremail_mcp_invalid_result
coremail_mcp_closed
```

禁止把 `coremail-knowledge-mcp` 直接注册到 OpenCode；OpenCode 只连接 `pseagent`。已有 `coremail_air` 是独立邮件能力，保持原样，与本功能无关。

从同一个 PowerShell 加载本机环境后启动临时测试入口；不要把 `.env.local` 的值复制进 OpenCode 配置：

```powershell
Get-Content -LiteralPath .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#=\s]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
opencode mcp list
opencode . --agent pseagent --model coremail/deepseek-v4-pro
```

预期 `pseagent connected`、没有直接 `coremail-knowledge-mcp` 条目，并且既有 `coremail_air` 保持原状。

## 8. 最终仓库与源目录检查

```powershell
git status --short
git -C ..\coremail-professional status --short
git -C ..\presales-general status --short
git -C ..\coremail-knowledge-mcp status --short
git -C ..\coremail-knowledge-mcp remote
Test-Path C:\Users\Coremail\Desktop\coremail-presales-wiki\coremail-presales-wiki
Test-Path C:\Users\Coremail\Desktop\generalKnowledgebase
Test-Path C:\Users\Coremail\Desktop\coremail-presales-wiki-pseagent
Test-Path ..\coremail-professional
Test-Path ..\presales-general
```

本流程不会移动或删除任何旧目录；本地 `.env.local`、项目配置、索引和日志均保持未跟踪且被忽略。

## 9. 临时 Codex 模型桥接（仅验收使用）

仅当无法访问公司模型、且需要完成一次本机验收时，才可使用临时 Codex 桥接。桥接复用已经登录的 Codex CLI，但不得读取、复制或提交登录凭据；它只监听 `127.0.0.1`，验收期间仍由现有 OpenAI-compatible 模型客户端通过临时 `.env.local` 调用。

开始前必须使用 release Knowledge Engine，并记录占用 `19829` 端口的原容器 ID 与运行状态。桥接健康后才能临时停止该容器；所有成功或失败路径都必须在 `finally` 中停止本次保存 PID 的进程，并在原容器先前处于运行状态时恢复同一个容器。不要停止其他容器。

验收记录只保留 scope、status、引用数量、耗时、revision 与恢复状态，不保留问题、回答、知识正文、访问令牌、Codex stderr 或会话信息。验收结束后删除 `.env.local`、系统临时目录中的桥接程序/测试/日志以及本次产生的临时输出；本步骤不把 Codex 接入加入正式运行时代码。

## 10. Lunkr 私聊正式入口（Windows 前台）

Lunkr 是独立的正式聊天入口，不经过 OpenCode、Codex 或任何外层 Agent
harness。现有 `opencode.json`、`.opencode/` 和历史 OpenCode 验收资料只保留为
旧测试入口；启动 Lunkr 时不需要运行或修改 OpenCode。

运行文件边界如下：

```text
integrations/lunkr-direct/  Lunkr 登录、Session、Socket、私聊 Bridge
scripts/lunkr-login.mts     首次交互登录
scripts/lunkr-status.mts    非敏感 Session 状态
scripts/lunkr-start.mts     Windows 前台机器人
apps/pseagent/src/embedded.ts  PSEAgent 正式嵌入式接口
```

### 10.1 构建并准备 PSEAgent 环境

完成本手册第 2 至 5 节，确保 `.env.local`、两个知识库 revision、Knowledge
MCP 构建产物和监听 `127.0.0.1:19829` 的 Knowledge Engine 均已就绪。然后：

```powershell
npm install
npm run typecheck
npm run build
```

`lunkr:start` 读取现有 `.env.local`，因此模型和知识库配置只维护一份。Lunkr
本身只负责私聊输入输出，不参与 PSEAgent 的路由、检索、模型调用或引用生成。

### 10.2 首次登录专用账号

在真实可见的 PowerShell 中执行：

```powershell
npm run lunkr:login
```

邮箱和密码只在隐藏的交互提示中输入。程序不会把密码保存到环境变量、Session
文件或日志。若服务端没有要求二次验证，流程直接完成；只有服务端返回
`FA_NEED_DYNAMIC_PWD` 时才提示在其他设备完成验证，不尝试绕过服务端策略。
该分支是 OTP/另一设备登录确认，不需要扫码，也不是邮箱验证码；确认完成后在
PowerShell 按回车继续。部分 Coremail 部署把登录 Cookie 放在响应字段而不是
`Set-Cookie` 响应头中，直连实现兼容两种形式，并在校验邮箱 Session 时继续携带
该 Cookie。

成功后只把 Lunkr SID 和 Cookie 以 AES-256-GCM 加密保存在：

```text
%USERPROFILE%\.config\pseagent-lunkr\session.json
```

密钥绑定当前 Windows 用户、主机和设备 UUID。复制到其他用户或电脑后不能解密。

### 10.3 检查 Session

```powershell
npm run lunkr:status
```

预期：

```json
{
  "configured": true,
  "valid": true,
  "email": "<专用账号>",
  "selfUid": "<Lunkr UID>",
  "lastVerifiedAt": "<ISO 时间>"
}
```

输出不包含密码、SID 或 Cookie。`valid=false` 时重新执行 `npm run
lunkr:login`。

### 10.4 启动私聊机器人

保持 Knowledge Engine 运行，在另一个 PowerShell 中执行：

```powershell
npm run lunkr:start
```

就绪顺序：

```text
lunkr.socket.connected
lunkr.socket.authenticated
pseagent.lunkr.ready
```

任何能私聊专用账号的用户都可直接发送文字，不需要 `/bot`。每个用户以 Lunkr
私聊 UID 隔离上下文；同一用户的消息顺序处理，不同用户可以并行。上下文最多
保留最近 6 轮和 12,000 字符，只存在当前进程内存中，进程重启后清空。

支持命令：

```text
/help  查看使用说明
/new   清空当前用户的连续对话上下文
```

群消息和机器人自身消息不响应。图片、文件和语音暂时只回复“当前仅支持文字私聊。”。
长回答优先作为一张可在线预览和下载的 TXT 纯文本卡片发回同一用户；只有
Lunkr 原生帖子连续三次发送失败时，才降级为不超过 1,000 字符且带同一问题
编号和 `当前段/总段数` 的文本段。

按 `Ctrl+C` 正常停止。程序会关闭 Lunkr Socket、PSEAgent、Knowledge MCP
子进程和只读 Coremail 历史资料子进程，但不会停止单独运行的 Knowledge Engine。

### 10.5 安全排障

- `尚未登录 Lunkr`：执行 `npm run lunkr:login`。
- `Lunkr Session 已失效`：重新登录，不要手工编辑 Session 文件。
- `PSEAgent Lunkr 启动失败`：先检查 `npm run lunkr:status` 和 Knowledge
  Engine 健康状态。
- Socket 断开后按指数退避自动重连，最大等待时间由
  `LUNKR_RECONNECT_MAX_MS` 控制。
- 日志只记录连接、收到私聊、回复成功或脱敏错误，不记录消息正文、回答正文、
  密码、SID、Cookie 或模型密钥。

## 11. 百题独立冷验收

冷验收只能在已提交且工作区干净的平台仓库中运行。三轮必须使用同一代码提交、
题集 seal、模型、知识 revision、策略版本和 release ID；任何一项漂移都会使批次
失效。生产合格答案缓存必须关闭，缓存命中数必须为零。

在启动每一轮前，在同一个 PowerShell 中显式设置以下环境。知识运营、反馈、发布
令牌全部置空，避免验收向外部系统写入数据：

```powershell
$env:PSE_BLIND_MATRIX_PATH='tests/e2e/enterprise-blind-acceptance-20260812-fourth.json'
$env:PSE_BLIND_SEAL_PATH='tests/e2e/enterprise-blind-acceptance-20260812-fourth.sha256'
$env:PSE_BLIND_BATCH_DIR="$env:TEMP\pseagent-blind-acceptance-fourth"
$env:PSE_BLIND_CONCURRENCY='4'
$env:PSE_BLIND_TIMEOUT_MS='180000'
$env:PSE_MODEL_NAME='deepseek_v4_flash'
$env:PSE_RESOLVER_MODEL_NAME='deepseek_v4_flash'
$env:PSE_PLANNER_MODEL_NAME='deepseek_v4_flash'
$env:PSE_SYNTHESIZER_MODEL_NAME='deepseek_v4_flash'
$env:PSE_VERIFIER_MODEL_NAME='deepseek_v4_flash'
$env:PSE_CONSENSUS_VERIFIER_MODEL_NAME='deepseek_v4_flash'
$env:PSE_RELIABILITY_CONTROL_PLANE_ENABLED='true'
$env:PSE_QUALIFIED_CACHE_ENABLED='false'
$env:PSE_RELEASE_ID='release-20260812-fourth'
$env:COREMAIL_PROFESSIONAL_REVISION='64d768e99f137ab149bb3f981d024b75c2dc62a6'
$env:PRESALES_GENERAL_REVISION='655ecd95fd1c2b6500810b26ccddc6035111b40a'
$env:KNOWLEDGE_OPS_BASE_URL=''
$env:KNOWLEDGE_OPS_SERVICE_TOKEN=''
$env:KNOWLEDGE_OPS_FEEDBACK_URL=''
$env:KNOWLEDGE_OPS_FEEDBACK_TOKEN=''
$env:PSE_FEEDBACK_PSEUDONYMIZATION_KEY=''
$env:KNOWLEDGE_OPS_RELEASE_TOKEN=''
```

先只校验题集与 seal，不调用模型：

```powershell
$env:PSE_BLIND_VALIDATE_ONLY='true'
npm run probe:blind-acceptance
Remove-Item Env:PSE_BLIND_VALIDATE_ONLY
```

确认 Knowledge Engine 为本次隔离实例且监听 `127.0.0.1:19849` 后，顺序执行三轮；
轮次之间不得修改代码、题集、环境身份或知识索引：

```powershell
$env:KNOWLEDGE_ENGINE_URL='http://127.0.0.1:19849'
$env:PSE_BLIND_ROUND='1'
npm run probe:blind-acceptance
$env:PSE_BLIND_ROUND='2'
npm run probe:blind-acceptance
$env:PSE_BLIND_ROUND='3'
npm run probe:blind-acceptance
```

最终报告的 `runtimeIdentity.cacheMode` 必须是 `cold_disabled`，`scorerVersion` 必须
是 `3`，300 条 observation 的缓存命中总数必须为零。暖缓存性能测试必须另建批次，
不得合并进事实准确率、首次输出或三轮一致率。
