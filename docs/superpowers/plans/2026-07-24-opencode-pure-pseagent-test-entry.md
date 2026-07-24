# OpenCode Pure PSEAgent Test Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the currently running plugin-polluted PSEAgent OpenCode test windows with one `--pure` window and prove that the same Chinese query reaches `pseagent_pse_answer` exactly once without keyword injection.

**Architecture:** Keep the global `oh-my-openagent` installation and configuration unchanged. Use OpenCode's process-local `--pure` flag for the temporary PSEAgent test entry, validate the route through an exported one-shot session, then launch one visible pure TUI window while preserving the existing Knowledge Engine.

**Tech Stack:** PowerShell 7/Windows PowerShell, OpenCode 1.14.39, OpenCode session export JSON, PSEAgent MCP, Knowledge Engine.

## Global Constraints

- Work only in `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` on `main`.
- Do not modify or uninstall the global `oh-my-openagent` plugin.
- Do not modify plugin files under `node_modules`.
- Do not modify PSEAgent, Knowledge Engine, Knowledge MCP, Coremail MCP, model prompts, routing, references, or history fallback.
- Do not print or commit `.env.local` values.
- Do not stop or restart Knowledge Engine PID `41540`; it must continue listening on port `19829`.
- Do not touch, merge, rebase, or clean the Lunkr/OpenClaw worktree.
- Implementation is runtime-only; no production or configuration file is created or modified.

---

### Task 1: Establish the polluted baseline and pure preflight

**Files:**
- Read: `.opencode/agents/pseagent.md`
- Read: local OpenCode session `ses_06d5683b3ffe8AbKiMMgfX34WI`
- Modify: none

**Interfaces:**
- Consumes: OpenCode CLI and its local session database.
- Produces: a recorded failing baseline plus proof that `--pure` retains the project Agent and MCP connections.

- [ ] **Step 1: Verify the failing baseline**

Run:

```powershell
$session = (& opencode export 'ses_06d5683b3ffe8AbKiMMgfX34WI' |
  Out-String | ConvertFrom-Json)
$userText = @(
  $session.messages |
    Where-Object { $_.info.role -eq 'user' } |
    Select-Object -Last 1
).parts |
  Where-Object { $_.type -eq 'text' } |
  Select-Object -ExpandProperty text
$toolNames = @(
  $session.messages.parts |
    Where-Object { $_.type -eq 'tool' } |
    Select-Object -ExpandProperty tool
)
Write-Output ('baseline_injected=' + $userText.Contains('[search-mode]'))
Write-Output ('baseline_called_pseagent=' + ($toolNames -contains 'pseagent_pse_answer'))
Write-Output ('baseline_external_search=' + (
  @($toolNames | Where-Object {
    $_ -in @('glob', 'grep', 'read', 'websearch_web_search_exa',
      'grep_app_searchGitHub')
  }).Count -gt 0
))
```

Expected:

```text
baseline_injected=True
baseline_called_pseagent=False
baseline_external_search=True
```

- [ ] **Step 2: Load local environment without printing values**

Run:

```powershell
Get-Content -LiteralPath '.env.local' | ForEach-Object {
  if ($_ -match '^\s*([^#=\s]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable(
      $matches[1],
      $matches[2],
      'Process'
    )
  }
}
```

Expected: no output.

- [ ] **Step 3: Verify pure-mode availability**

Run:

```powershell
$agents = (& opencode agent list --pure 2>&1 | Out-String)
$mcp = (& opencode mcp list --pure 2>&1 | Out-String)
Write-Output ('pure_has_pseagent=' +
  [regex]::IsMatch($agents, '(?m)^pseagent \(primary\)'))
Write-Output ('pure_pseagent_connected=' +
  [regex]::IsMatch($mcp, '(?is)pseagent.*connected'))
Write-Output ('pure_coremail_air_connected=' +
  [regex]::IsMatch($mcp, '(?is)coremail_air.*connected'))
Write-Output ('pure_plugin_agent_present=' +
  [regex]::IsMatch(
    $agents,
    '(?m)^Sisyphus -|^Hephaestus -|^Prometheus -'
  ))
```

Expected:

```text
pure_has_pseagent=True
pure_pseagent_connected=True
pure_coremail_air_connected=True
pure_plugin_agent_present=False
```

### Task 2: Run the pure real-answer acceptance

**Files:**
- Read: OpenCode one-shot session export created by this task.
- Modify: none

**Interfaces:**
- Consumes: environment loaded by Task 1, project `pseagent` Agent, company model, and connected `pseagent` MCP.
- Produces: a session proving unmodified input, a single PSEAgent tool call, no external search tools, and a final answer produced from the PSEAgent result.

- [ ] **Step 1: Run the exact regression question in pure mode**

Run:

```powershell
$acceptanceTitle = 'PSEAgent pure acceptance - 2026-07-24'
$runOutput = & opencode run `
  --pure `
  --agent pseagent `
  --model coremail/deepseek-v4-pro `
  --title $acceptanceTitle `
  --format json `
  '列出 Coremail AI 的新功能特性' 2>&1
if ($LASTEXITCODE -ne 0) {
  throw 'pure_opencode_acceptance_failed'
}
```

Expected: exit code `0`. Do not print `$runOutput`, because it can contain answer text.

- [ ] **Step 2: Resolve and export the exact acceptance session**

Run:

```powershell
$sessions = (& opencode session list -n 10 --format json |
  Out-String | ConvertFrom-Json)
$acceptanceSession = @(
  $sessions |
    Where-Object { $_.title -eq $acceptanceTitle } |
    Sort-Object updated -Descending
)[0]
if ($null -eq $acceptanceSession) {
  throw 'pure_acceptance_session_missing'
}
$export = (& opencode export $acceptanceSession.id |
  Out-String | ConvertFrom-Json)
```

Expected: one matching session resolves and exports successfully.

- [ ] **Step 3: Assert the route and output contract**

Run:

```powershell
$userMessages = @(
  $export.messages |
    Where-Object { $_.info.role -eq 'user' }
)
$userText = @(
  $userMessages[-1].parts |
    Where-Object { $_.type -eq 'text' } |
    Select-Object -ExpandProperty text
) -join "`n"
$toolParts = @(
  $export.messages.parts |
    Where-Object { $_.type -eq 'tool' }
)
$toolNames = @($toolParts | Select-Object -ExpandProperty tool)
$finalText = @(
  $export.messages[-1].parts |
    Where-Object { $_.type -eq 'text' } |
    Select-Object -ExpandProperty text
) -join "`n"

$inputUnchanged =
  $userText -eq '列出 Coremail AI 的新功能特性'
$singlePseCall =
  $toolNames.Count -eq 1 -and
  $toolNames[0] -eq 'pseagent_pse_answer'
$noExternalTools =
  @($toolNames | Where-Object {
    $_ -in @(
      'glob',
      'grep',
      'read',
      'websearch_web_search_exa',
      'grep_app_searchGitHub'
    )
  }).Count -eq 0
$hasFinalAnswer = -not [string]::IsNullOrWhiteSpace($finalText)

Write-Output ('pure_input_unchanged=' + $inputUnchanged)
Write-Output ('pure_single_pse_call=' + $singlePseCall)
Write-Output ('pure_no_external_tools=' + $noExternalTools)
Write-Output ('pure_has_final_answer=' + $hasFinalAnswer)

if (-not (
  $inputUnchanged -and
  $singlePseCall -and
  $noExternalTools -and
  $hasFinalAnswer
)) {
  throw 'pure_route_contract_failed'
}
```

Expected:

```text
pure_input_unchanged=True
pure_single_pse_call=True
pure_no_external_tools=True
pure_has_final_answer=True
```

- [ ] **Step 4: Verify the engine was not restarted**

Run:

```powershell
$engineAlive =
  $null -ne (Get-Process -Id 41540 -ErrorAction SilentlyContinue)
$engineListening =
  @(Get-NetTCPConnection `
    -State Listen `
    -LocalPort 19829 `
    -ErrorAction SilentlyContinue |
    Where-Object OwningProcess -eq 41540).Count -gt 0
Write-Output ('engine_alive=' + $engineAlive)
Write-Output ('engine_listening=' + $engineListening)
```

Expected:

```text
engine_alive=True
engine_listening=True
```

### Task 3: Replace the polluted windows with one visible pure window

**Files:**
- Modify: none

**Interfaces:**
- Consumes: verified pure command from Task 2 and exact process metadata.
- Produces: one visible PSEAgent OpenCode TUI process with `--pure`, while leaving global plugin configuration and Knowledge Engine unchanged.

- [ ] **Step 1: Resolve only the polluted PSEAgent OpenCode processes**

Run:

```powershell
$polluted = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'opencode.exe' -and
      $_.CommandLine -like '*--agent pseagent*' -and
      $_.CommandLine -like '*--model coremail/deepseek-v4-pro*' -and
      $_.CommandLine -notlike '*--pure*'
    }
)
$pollutedParentIds = @(
  $polluted |
    Select-Object -ExpandProperty ParentProcessId -Unique
)
Write-Output ('polluted_process_count=' + $polluted.Count)
```

Expected: count is at least `1`. Stop if any resolved process lacks all three required command-line conditions.

- [ ] **Step 2: Stop the exact polluted processes and their dedicated hosts**

Run:

```powershell
foreach ($process in $polluted) {
  Stop-Process -Id $process.ProcessId -ErrorAction Stop
}
foreach ($parentId in $pollutedParentIds) {
  $parent = Get-CimInstance Win32_Process `
    -Filter "ProcessId=$parentId" `
    -ErrorAction SilentlyContinue
  if (
    $null -ne $parent -and
    $parent.Name -eq 'powershell.exe' -and
    $parent.CommandLine -like '*--agent pseagent*'
  ) {
    Stop-Process -Id $parentId -ErrorAction Stop
  }
}
```

Expected: all exact non-pure PSEAgent OpenCode processes exit. No other OpenCode process is stopped.

- [ ] **Step 3: Launch one visible pure PSEAgent window**

Run:

```powershell
$project =
  'C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform'
$before = @(
  Get-Process -Name opencode -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id
)
$launchScript = @'
Set-Location -LiteralPath 'C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform'
Get-Content -LiteralPath '.env.local' | ForEach-Object {
  if ($_ -match '^\s*([^#=\s]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
$Host.UI.RawUI.WindowTitle = 'PSEAgent OpenCode Pure (main)'
opencode . --pure --agent pseagent --model coremail/deepseek-v4-pro
'@
$hostProcess = Start-Process `
  -FilePath 'powershell.exe' `
  -WorkingDirectory $project `
  -ArgumentList @('-NoLogo', '-NoExit', '-Command', $launchScript) `
  -PassThru

$newIds = @()
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  $after = @(
    Get-Process -Name opencode -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty Id
  )
  $newIds = @($after | Where-Object { $_ -notin $before })
  if ($newIds.Count -gt 0) {
    break
  }
}
if ($newIds.Count -ne 1) {
  throw 'pure_opencode_window_start_failed'
}
```

Expected: one new OpenCode process.

- [ ] **Step 4: Verify the launched command and final repository state**

Run:

```powershell
$newProcess = Get-CimInstance Win32_Process `
  -Filter "ProcessId=$($newIds[0])"
$command = [string]$newProcess.CommandLine
$pureCommand =
  $command.Contains('--pure') -and
  $command.Contains('--agent pseagent') -and
  $command.Contains('--model coremail/deepseek-v4-pro')
$trackedDiffCount = @(git diff HEAD --name-only).Count

Write-Output ('pure_window_alive=' + ($null -ne $newProcess))
Write-Output ('pure_window_command=' + $pureCommand)
Write-Output ('tracked_diff_count=' + $trackedDiffCount)
git status --short
```

Expected:

```text
pure_window_alive=True
pure_window_command=True
tracked_diff_count=0
?? .sisyphus/
```

No implementation commit is created because Tasks 1–3 intentionally make no repository change.
