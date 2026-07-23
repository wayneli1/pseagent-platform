# PSEAgent 本机运行手册

所有命令均在 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` 的 PowerShell 中执行。不要启动 Admin、Worker、Supabase、Coremail MCP、LLM Wiki App 或 public search；本运行路径只需要 Rust Knowledge Engine、只读 Knowledge MCP 子进程和唯一的 PSEAgent MCP。

## 1. 固定两个知识库 revision

```powershell
$expectedProfessionalRevision = 'e003c787326609afc3b6d4159e5096a8c29128ed'
$expectedGeneralRevision = '60d88323b8d6a464f5fc7810846af618ed052d70'
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
```

## 4. 构建全部组件

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run build
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
} finally {
  if ($null -ne $engineProcess -and -not $engineProcess.HasExited) {
    Stop-Process -Id $engineProcess.Id
    Wait-Process -Id $engineProcess.Id -ErrorAction SilentlyContinue
  }
}
```

预期四行摘要分别为：professional 的 answered/partially_answered 且至少一个引用、general 的 answered/partially_answered 且至少一个引用、normal 的 answered、professional 未公告问题的 not_covered。输出不得包含完整答案、知识页正文或密钥。

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

## 7. 最终仓库与源目录检查

```powershell
git status --short
git -C ..\coremail-professional status --short
git -C ..\presales-general status --short
Test-Path C:\Users\Coremail\Desktop\coremail-presales-wiki\coremail-presales-wiki
Test-Path C:\Users\Coremail\Desktop\generalKnowledgebase
Test-Path C:\Users\Coremail\Desktop\coremail-presales-wiki-pseagent
Test-Path ..\coremail-professional
Test-Path ..\presales-general
```

本流程不会移动或删除任何旧目录；本地 `.env.local`、项目配置、索引和日志均保持未跟踪且被忽略。

## 8. 临时 Codex 模型桥接（仅验收使用）

仅当无法访问公司模型、且需要完成一次本机验收时，才可使用临时 Codex 桥接。桥接复用已经登录的 Codex CLI，但不得读取、复制或提交登录凭据；它只监听 `127.0.0.1`，验收期间仍由现有 OpenAI-compatible 模型客户端通过临时 `.env.local` 调用。

开始前必须使用 release Knowledge Engine，并记录占用 `19829` 端口的原容器 ID 与运行状态。桥接健康后才能临时停止该容器；所有成功或失败路径都必须在 `finally` 中停止本次保存 PID 的进程，并在原容器先前处于运行状态时恢复同一个容器。不要停止其他容器。

验收记录只保留 scope、status、引用数量、耗时、revision 与恢复状态，不保留问题、回答、知识正文、访问令牌、Codex stderr 或会话信息。验收结束后删除 `.env.local`、系统临时目录中的桥接程序/测试/日志以及本次产生的临时输出；本步骤不把 Codex 接入加入正式运行时代码。
