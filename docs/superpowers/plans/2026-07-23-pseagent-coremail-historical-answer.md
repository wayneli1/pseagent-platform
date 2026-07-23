# PSEAgent Coremail MCP Historical Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仅在 PSEAgent 正式知识问答返回 `not_covered` 后，通过本机只读 Coremail MCP 返回有 Jira/Wiki 来源支持、未经验证且与正式答案完全隔离的历史资料辅助回答。

**Architecture:** 使用两个独立源码仓库完成正式协议接入：Coremail MCP 仓库提供可测试的非交互认证模式，PSEAgent 仓库提供严格只读、懒连接、固定工具调用的历史资料提供器。正式 PSEAgent 结果始终保持权威；Coremail MCP 的原始答案仅进入可选 `historicalAnswer`，失败时原对象原样返回。

**Tech Stack:** Windows PowerShell、Git、Node.js 24、TypeScript 7（PSEAgent）、TypeScript 5.4（Coremail MCP）、Zod 4、MCP TypeScript SDK 1.29、Node `node:test`、Vitest 4、stdio MCP。

## Global Constraints

- 设计规格为 `docs/superpowers/specs/2026-07-23-pseagent-coremail-historical-answer-design.md`，实施前必须确认其状态为“用户已逐节审核确认”。
- PSEAgent 仓库固定为 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`。
- Coremail MCP 新仓库固定为 `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp`。
- 原始 ZIP 固定为 `C:\Users\Coremail\Desktop\coremail-knowledge-mcp-bootcamp-465941c.zip`，SHA-256 必须等于 `AB45A26522D73A3A53249515CAA32973DE9C9CFA6143B0E4FDD498C04B13D439`。
- 原始 ZIP 不得修改、覆盖或删除。
- 两个源码仓库独立暂存、独立验证、独立提交；不得跨仓提交。
- 两个仓库均不创建 remote、不 push。
- 首期仅支持当前 Windows 电脑和当前本机用户，使用用户个人 Jira/Wiki 账号。
- 接受现有 Coremail MCP 本机认证文件加密方式；本期不迁移到 Windows Credential Manager 或 DPAPI。
- `.env.local`、`.env`、认证文件、Cookie、Token、账号密码、索引、缓存、日志、`node_modules` 和 `.sisyphus` 不进入提交。
- Coremail MCP 只允许发布和连接 `dist/server.js`，禁止启动或连接 `dist/writeback-server.js`。
- 不执行 Coremail MCP 的 `deploy:opencode`、`deploy:codex`、`deploy:claude` 或 `deploy:all`。
- 不把 `coremail-knowledge-mcp` 直接注册到 OpenCode；现有无关 `coremail_air` 保持不变。
- Coremail MCP 子进程必须强制使用 `AI_ADOPTION_ENABLED=false`、`KNOWLEDGE_ENABLE_CACHE=false`、`KNOWLEDGE_AUTH_INTERACTIVE=false`。
- 账号密码只允许用户在本机官方登录命令的隐藏输入中填写，不得要求用户粘贴到聊天。
- 只把本轮 `question` 传给 Coremail MCP，不传 `conversationContext`。
- 只有 `not_covered` 调用历史提供器；`answered`、`partially_answered`、`normal` 和 `temporarily_unavailable` 均不得调用。
- `historicalAnswer` 必须至少有一条 Jira/Wiki 来源；`local`、未知来源、`confidence="none"`、空答案和超长答案均不展示。
- `low`、`medium`、`high` 均允许展示；历史答案最大 32,768 个字符。
- 不调用模型二次总结、改写或补充 Coremail MCP 原始答案。
- 用户可见失败始终静默降级；本机日志只能记录固定脱敏错误码。
- 不接入 Judge、评分或人工审核系统；不修改现有 Agent Loop、Rust Knowledge Engine、内部 Knowledge MCP 或知识库内容。
- 每个阶段提交前运行该任务列出的完整验证；提交标题和正文使用中文，正文包含“完成内容”和“验证结果”。

---

## File and Responsibility Map

### PSEAgent platform

- `AGENTS.md`：记录四仓库工作区和后续 Coremail MCP 阶段边界。
- `apps/pseagent/src/contracts.ts`：定义固定警告、历史来源和历史回答 Zod 契约。
- `apps/pseagent/src/contracts.test.ts`：验证严格契约、来源隔离、confidence 和长度边界。
- `apps/pseagent/src/mcp-server.ts`：确定性渲染正式未覆盖文本和独立历史区块。
- `apps/pseagent/src/mcp-server.test.ts`：验证文本顺序、原始 Markdown/Mermaid 和 structuredContent。
- `apps/pseagent/src/coremail-mcp-client.ts`：只读、懒连接、固定工具调用和结果清洗。
- `apps/pseagent/src/coremail-mcp-client.test.ts`：验证客户端状态机、环境白名单、结果过滤、超时和脱敏。
- `apps/pseagent/src/answer-service.ts`：只在正式 `not_covered` 后编排历史提供器。
- `apps/pseagent/src/answer-service.test.ts`：验证触发矩阵和失败时对象身份不变。
- `apps/pseagent/src/config.ts`：解析条件启用的 Coremail MCP 配置。
- `apps/pseagent/src/config.test.ts`：验证布尔值、绝对只读入口和 timeout。
- `apps/pseagent/src/main.ts`：创建懒客户端并隔离三个关闭路径。
- `apps/pseagent/src/main-wiring.test.ts`：验证不在启动阶段连接、环境隔离和幂等关闭。
- `.env.example`：记录非敏感 Coremail MCP 开关、命令、入口和超时。
- `scripts/probe-live.mts`：让现有探针向 PSEAgent 子进程传递非敏感 Coremail 配置。
- `scripts/probe-coremail-historical.mts`：执行历史回答原文一致性和结构化真实验收。
- `apps/pseagent/src/coremail-historical-probe-contract.ts`：提供真实探针复用的纯验收断言。
- `apps/pseagent/src/coremail-historical-probe-contract.test.ts`：用离线夹具验证探针成功和拒绝条件。
- `package.json`：增加独立的 `probe:coremail` 命令。
- `docs/local-runbook.md`：记录双仓库构建、发布、登录和无感降级流程。
- `docs/verification/coremail-historical-answer-live-acceptance.md`：保存脱敏真实验收证据。

### Coremail MCP

- `.gitignore`：排除依赖、认证、缓存、索引和日志。
- `.env.example`：记录 `KNOWLEDGE_AUTH_INTERACTIVE`，不记录账号密码。
- `README.md`：说明非交互模式的行为和安全边界。
- `src/utils/auth-interactivity.ts`：统一解析是否允许浏览器认证。
- `src/tools/auth-control.ts`：让 `auth_login` 在非交互模式下只做静默刷新。
- `src/server.ts`：让普通知识工具的自动认证恢复在非交互模式下永不导入浏览器 Cookie或等待 SSO。
- `scripts/coremail-auth.mjs`：在命令层阻止 `import-browser` 和 `login-browser` 启动浏览器。
- `tests/non-interactive-auth.test.mjs`：使用 Node 内置测试验证默认兼容、静默刷新和浏览器禁用。
- `package.json`：把可执行定向测试接到 `npm test`。
- `dist/**`：由同一源码提交构建的运行产物。

---

### Task 1: 同步 PSEAgent 工作区与阶段约束

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Modify: `AGENTS.md`
- Reference: `docs/superpowers/specs/2026-07-23-pseagent-coremail-historical-answer-design.md`

**Interfaces:**
- Consumes: 用户已批准的双仓库设计。
- Produces: 允许后续创建第四个独立仓库的明确执行边界。

- [ ] **Step 1: 确认设计提交和当前工作区**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git remote
Select-String -LiteralPath docs\superpowers\specs\2026-07-23-pseagent-coremail-historical-answer-design.md `
  -Pattern '状态：用户已逐节审核确认'
```

Expected:

- branch 为 `main`；
- HEAD 至少包含设计提交 `477bb8073e570d3b75c80b7de90865fde1c88916`；
- 只允许预先存在的 `?? .sisyphus/`；
- remote 输出为空；
- 设计状态命中一次。

- [ ] **Step 2: 先写约束检查并确认旧文本不满足**

Run:

```powershell
$agents = Get-Content -Raw -Encoding UTF8 -LiteralPath AGENTS.md
if ($agents -notmatch '四个直接子目录') { throw 'missing_four_repo_rule' }
if ($agents -notmatch '后续阶段.*Coremail MCP') { throw 'missing_followup_coremail_phase' }
```

Expected: 以 `missing_four_repo_rule` 失败。

- [ ] **Step 3: 最小更新 AGENTS.md**

将第 2、9 条改为以下含义，并增加第四仓库边界：

```markdown
2. 总目录 `C:\Users\Coremail\Desktop\Coremail-PSE` 不是 Git 仓库；四个直接子目录是独立 Git 仓库，不得跨仓暂存或提交。
9. 已完成的首期不实现 Coremail MCP/公网兜底或自动知识写回；用户批准的后续阶段仅允许按已确认设计接入只读 Coremail MCP 历史资料辅助回答。
11. `coremail-knowledge-mcp` 仅用于只读 Jira/Wiki 历史资料；不得连接 writeback 入口，不得把认证数据、缓存或运行日志提交到任一仓库。
```

保留其他现有约束原文。

- [ ] **Step 4: 运行约束检查并确认通过**

Run:

```powershell
$agents = Get-Content -Raw -Encoding UTF8 -LiteralPath AGENTS.md
if ($agents -notmatch '四个直接子目录') { throw 'missing_four_repo_rule' }
if ($agents -notmatch '后续阶段.*只读 Coremail MCP') { throw 'missing_followup_coremail_phase' }
if ($agents -notmatch '不得连接 writeback') { throw 'missing_writeback_rule' }
git diff --check
```

Expected: exit 0，`git diff --check` 无输出。

- [ ] **Step 5: 精确提交约束更新**

Run:

```powershell
git add -- AGENTS.md
git diff --cached --check
git diff --cached --name-only
git commit -m "阶段 23：同步历史资料功能执行约束" `
  -m "完成内容：将工作区更新为四个独立仓库，并明确后续只读 Coremail MCP 阶段边界。" `
  -m "验证结果：仓库数量、只读入口和禁止 writeback 约束检查全部通过。"
git rev-parse HEAD
```

Expected: 暂存文件只有 `AGENTS.md`，提交成功并输出完整哈希。

---

### Task 2: 从原始 ZIP 创建 Coremail MCP 基线仓库

**Repository to create:** `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp`

**Files:**
- Import: `C:\Users\Coremail\Desktop\coremail-knowledge-mcp-bootcamp-465941c.zip`
- Create repository metadata: `.git`
- Local-only exclude: `.git/info/exclude`

**Interfaces:**
- Consumes: 固定 ZIP 和 Task 1 的四仓库约束。
- Produces: `main` 分支上的可构建 Coremail MCP 原始基线提交。

- [ ] **Step 1: 验证原始 ZIP 和目标路径**

Run in `C:\Users\Coremail\Desktop\Coremail-PSE`:

```powershell
$zip = 'C:\Users\Coremail\Desktop\coremail-knowledge-mcp-bootcamp-465941c.zip'
$target = 'C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp'
$workspace = (Resolve-Path 'C:\Users\Coremail\Desktop\Coremail-PSE').Path
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
if ($actualHash -ne 'AB45A26522D73A3A53249515CAA32973DE9C9CFA6143B0E4FDD498C04B13D439') {
  throw 'unexpected_coremail_zip_hash'
}
if (Test-Path -LiteralPath $target) { throw 'coremail_repo_target_already_exists' }
if (-not $target.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'coremail_repo_target_outside_workspace'
}
```

Expected: exit 0；目标目录尚不存在。

- [ ] **Step 2: 安全解压并移动唯一包根目录**

Run in the same PowerShell:

```powershell
$extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('coremail-mcp-import-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractRoot | Out-Null
try {
  Expand-Archive -LiteralPath $zip -DestinationPath $extractRoot
  $packageRoot = Join-Path $extractRoot 'coremail-knowledge-mcp-bootcamp-465941c'
  $resolvedExtract = (Resolve-Path -LiteralPath $extractRoot).Path
  $resolvedPackage = (Resolve-Path -LiteralPath $packageRoot).Path
  if (-not $resolvedPackage.StartsWith($resolvedExtract + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'unexpected_package_root'
  }
  Move-Item -LiteralPath $resolvedPackage -Destination $target
} finally {
  if (Test-Path -LiteralPath $extractRoot) {
    $resolvedTemp = (Resolve-Path -LiteralPath $extractRoot).Path
    $systemTemp = (Resolve-Path ([System.IO.Path]::GetTempPath())).Path
    if (-not $resolvedTemp.StartsWith($systemTemp + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'refusing_to_clean_non_temp_path'
    }
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
```

Expected: 目标目录存在，原始 ZIP 仍存在且哈希不变。

- [ ] **Step 3: 初始化独立仓库和本地排除**

Run in the new target:

```powershell
git init -b main
$excludePath = git rev-parse --git-path info/exclude
Add-Content -LiteralPath $excludePath -Value @(
  'node_modules/'
  '.env'
  '*.log'
)
git remote
```

Expected: 初始化 `main`；remote 输出为空。`.git/info/exclude` 只属于本地仓库元数据，不进入提交。

- [ ] **Step 4: 安装依赖并建立可验证基线**

Run:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
$testFiles = @(Get-ChildItem -LiteralPath tests -File -ErrorAction SilentlyContinue)
if ($testFiles.Count -ne 0) { throw 'unexpected_tests_in_source_archive' }
```

Expected:

- install、typecheck、build 均 exit 0；
- ZIP 源码归档确实没有 `tests/` 文件。

Do not run `npm test` in this baseline task: the imported `package.json` references omitted `tests/smoke.mjs` and `tests/run-all.mjs`. Task 3 adds a real executable test suite before the functional change is committed.

- [ ] **Step 5: 扫描导入内容**

Run:

```powershell
$trackedCandidates = @(rg --files -g '!node_modules' -g '!.git')
$secretHits = @(rg -n -l `
  -e 'sk-[A-Za-z0-9_-]{16,}' `
  -e 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' `
  -e '(?i)(password|cookie|token|authorization)\s*[:=]\s*["''][^"'']+["'']' `
  -- $trackedCandidates 2>$null)
$packageEnvFile = Test-Path -LiteralPath '.env'
[pscustomobject]@{
  candidateFiles = $trackedCandidates.Count
  secretHitFiles = $secretHits.Count
  packageEnvFile = $packageEnvFile
} | Format-List
if ($secretHits.Count -ne 0) { throw 'sensitive_content_in_import' }
if ($packageEnvFile) { throw 'package_env_must_not_be_imported' }
```

Expected: `secretHitFiles=0`、`packageEnvFile=False`。不得输出认证文件内容。

- [ ] **Step 6: 提交原始基线**

Run:

```powershell
git add -A
git diff --cached --check
git status --short
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne
  'AB45A26522D73A3A53249515CAA32973DE9C9CFA6143B0E4FDD498C04B13D439') {
  throw 'source_zip_changed'
}
git commit -m "导入 Coremail MCP 原始基线" `
  -m "完成内容：按固定 SHA-256 导入原始发布包，并保留只读 server、源码、配置和预构建产物。" `
  -m "验证结果：依赖安装、类型检查、构建和敏感信息扫描通过；原发布包未包含其脚本引用的 tests 文件。"
git rev-parse HEAD
git remote
```

Expected: 提交成功、输出完整哈希、remote 为空；`node_modules` 不进入提交。

---

### Task 3: 为 Coremail MCP 增加非交互认证模式

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp`

**Files:**
- Create: `.gitignore`
- Create: `src/utils/auth-interactivity.ts`
- Create: `tests/non-interactive-auth.test.mjs`
- Modify: `src/tools/auth-control.ts`
- Modify: `src/server.ts`
- Modify: `scripts/coremail-auth.mjs`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Rebuild: `dist/server.js`, `dist/tools/auth-control.js`, `dist/utils/auth-interactivity.js` and associated generated maps/files

**Interfaces:**
- Consumes: `KNOWLEDGE_AUTH_INTERACTIVE` from child process environment.
- Produces: `interactiveAuthEnabled(env?: NodeJS.ProcessEnv): boolean`; default `true`, explicit `"false"` means no browser auth.

- [ ] **Step 1: 写入失败的环境解析测试**

Create `tests/non-interactive-auth.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { interactiveAuthEnabled } from "../dist/utils/auth-interactivity.js";
import { createAuthLoginHandler } from "../dist/tools/auth-control.js";

const failedStatus = {
  ok: false,
  health_check_ok: false,
  auth_store: "redacted",
  auth_store_exists: true,
  auth_revision: "revision",
  sso_login_url: "redacted",
  next_action: "auth_login",
  jira: { configured: true, enabled: true, ok: false, endpoints: [] },
  wiki: { configured: false, enabled: false, ok: true, endpoints: [] },
  wikis: {},
  auth_failure: true,
};

test("interactive authentication defaults on and explicit false disables it", () => {
  assert.equal(interactiveAuthEnabled({}), true);
  assert.equal(interactiveAuthEnabled({ KNOWLEDGE_AUTH_INTERACTIVE: "true" }), true);
  assert.equal(interactiveAuthEnabled({ KNOWLEDGE_AUTH_INTERACTIVE: "false" }), false);
  assert.equal(interactiveAuthEnabled({ KNOWLEDGE_AUTH_INTERACTIVE: " FALSE " }), false);
});

test("auth_login never starts login-browser in non-interactive mode", async () => {
  const commands = [];
  const handler = createAuthLoginHandler({
    interactive: false,
    runCommand: async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    },
    readStatus: async (extra = {}) => ({ ...failedStatus, ...extra }),
    resetContext: () => undefined,
  });

  const result = await handler();

  assert.deepEqual(commands, ["refresh"]);
  assert.equal(result.ok, false);
  assert.equal(result.browser_login_used, false);
});

test("interactive mode preserves the existing browser recovery branch", async () => {
  const commands = [];
  const statuses = [
    { ...failedStatus, ok: false },
    { ...failedStatus, ok: true, auth_failure: false, next_action: "none" },
  ];
  const handler = createAuthLoginHandler({
    interactive: true,
    runCommand: async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    },
    readStatus: async (extra = {}) => ({ ...statuses.shift(), ...extra }),
    resetContext: () => undefined,
  });

  const result = await handler();

  assert.deepEqual(commands, ["refresh", "login-browser"]);
  assert.equal(result.browser_login_used, true);
});

test("auth script refuses both browser-capable commands before launch", () => {
  for (const command of ["import-browser", "login-browser"]) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/coremail-auth.mjs",
        command,
        "--quiet",
        "--json",
        "--cdp-url=http://127.0.0.1:1",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, KNOWLEDGE_AUTH_INTERACTIVE: "false" },
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interactive_auth_disabled/u);
  }
});

test("ordinary tool recovery refreshes before every browser-capable branch", () => {
  const source = readFileSync(
    new URL("../src/server.ts", import.meta.url),
    "utf8",
  );
  const loopStart = source.indexOf("refreshAttempts += 1;");
  const nonInteractiveStart = source.indexOf(
    "if (!allowInteractiveAuth)",
    loopStart,
  );
  const browserStart = source.indexOf(
    "if (authFailure && shouldTryBrowserImportFirst(authFailure))",
    loopStart,
  );
  assert.ok(loopStart >= 0);
  assert.ok(nonInteractiveStart > loopStart);
  assert.ok(browserStart > nonInteractiveStart);
  const branch = source.slice(nonInteractiveStart, browserStart);
  assert.match(branch, /refreshLocalAuth/u);
  assert.match(branch, /continue;/u);
  assert.doesNotMatch(branch, /maybeImportBrowserAuth|waitForSsoRecovery/u);
});
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run:

```powershell
npm run build
node --test tests\non-interactive-auth.test.mjs
```

Expected: FAIL，因为 `dist/utils/auth-interactivity.js` 或 `createAuthLoginHandler` 尚不存在。

- [ ] **Step 3: 实现统一环境解析**

Create `src/utils/auth-interactivity.ts`:

```ts
export function interactiveAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.KNOWLEDGE_AUTH_INTERACTIVE?.trim().toLowerCase() !== "false";
}
```

在 `.env.example` 增加：

```text
KNOWLEDGE_AUTH_INTERACTIVE=true
```

在 `README.md` 配置章节说明：

```markdown
- `KNOWLEDGE_AUTH_INTERACTIVE=false`：允许读取本机认证文件并静默刷新，但禁止浏览器 Cookie 导入、`login-browser` 和 SSO 等待。适用于后台服务；刷新失败时由调用方降级。
```

- [ ] **Step 4: 把 auth_login 改造成可测试且非交互安全的处理器**

Modify `src/tools/auth-control.ts`:

```ts
import { interactiveAuthEnabled } from "../utils/auth-interactivity.js";

export interface AuthLoginHandlerDependencies {
  readonly interactive: boolean;
  readonly runCommand: typeof runAuthCommand;
  readonly readStatus: typeof authStatus;
  readonly resetContext: typeof resetToolContext;
}

export function createAuthLoginHandler(
  overrides: Partial<AuthLoginHandlerDependencies> = {},
): ToolDefinition["handler"] {
  const dependencies: AuthLoginHandlerDependencies = {
    interactive: interactiveAuthEnabled(),
    runCommand: runAuthCommand,
    readStatus: authStatus,
    resetContext: resetToolContext,
    ...overrides,
  };

  return async () => {
    let refreshError: string | undefined;
    try {
      await dependencies.runCommand("refresh", ["--quiet"], refreshTimeoutMs);
      dependencies.resetContext();
    } catch (error) {
      refreshError = sanitizeErrorMessage(error);
    }

    const afterRefreshStatus = await dependencies.readStatus({
      refresh_attempted: true,
      browser_login_used: false,
      ...(refreshError === undefined ? {} : { refresh_error: refreshError }),
    });
    const afterRefresh = {
      ...afterRefreshStatus,
      refreshed: afterRefreshStatus.ok,
      browser_login_used: false,
    };
    if (afterRefresh.ok || !dependencies.interactive) return afterRefresh;

    const services = failingAuthServices(afterRefreshStatus);
    await dependencies.runCommand(
      "login-browser",
      services.length > 0 ? [`--services=${services.join(",")}`] : [],
      browserLoginTimeoutMs,
    );
    dependencies.resetContext();
    const afterBrowserLogin = await dependencies.readStatus({
      refresh_attempted: true,
      browser_login_used: true,
      ...(refreshError === undefined ? {} : { refresh_error: refreshError }),
    });
    return {
      ...afterBrowserLogin,
      refreshed: afterBrowserLogin.ok,
      browser_login_used: true,
    };
  };
}
```

Replace only `authLoginTool.handler` with:

```ts
handler: createAuthLoginHandler()
```

Keep `auth_status` and `auth_refresh` behavior unchanged.

- [ ] **Step 5: 禁止普通工具自动进入浏览器恢复**

Modify `src/server.ts`:

```ts
import { interactiveAuthEnabled } from "./utils/auth-interactivity.js";

const allowInteractiveAuth = interactiveAuthEnabled();
```

Inside the automatic recovery loop, immediately after incrementing `refreshAttempts`, add a separate non-interactive branch before any `shouldTryBrowserImportFirst()` logic:

```ts
if (!allowInteractiveAuth) {
  lastRefreshResult = await refreshLocalAuth(authServices);
  if (!lastRefreshResult.ok && !lastRefreshResult.refreshed) {
    throw new Error(authRecoveryMessage(
      `Jira/Wiki authentication could not be refreshed non-interactively. ${sanitizeErrorMessage(authFailure)}`,
      lastRefreshResult,
    ));
  }
  resetToolContext();
  continue;
}
```

The existing browser import and SSO wait branches remain unchanged and are reachable only when `allowInteractiveAuth === true`.

- [ ] **Step 6: 在认证脚本入口增加防御性阻断**

Modify `scripts/coremail-auth.mjs`:

```js
function interactiveAuthEnabled() {
  return String(process.env.KNOWLEDGE_AUTH_INTERACTIVE || "true")
    .trim()
    .toLowerCase() !== "false";
}

function requireInteractiveAuth(command) {
  if (!interactiveAuthEnabled()) {
    throw new Error(`interactive_auth_disabled:${command}`);
  }
}
```

Insert `requireInteractiveAuth("login-browser");` as the first executable
statement of the existing `cmdLoginBrowser()` body. Insert
`requireInteractiveAuth("import-browser");` as the first executable statement
of the existing `importBrowserCookies()` body. Apply these exact insertions:

```diff
async function cmdLoginBrowser() {
+  requireInteractiveAuth("login-browser");
  const services = configuredImportServices();

async function importBrowserCookies({ quiet = false } = {}) {
+  requireInteractiveAuth("import-browser");
  const timeoutMs = importBrowserTimeoutMs();
```

Do not move, rewrite, or delete the remainder of either function.

Do not add the guard to `login`, `refresh`, `status` or `diagnose-wiki`; silent credential login and refresh must continue working.

- [ ] **Step 7: 接入可执行测试命令并增加 Git 排除**

Create `.gitignore`:

```gitignore
node_modules/
.env
*.log
data/cache/*
!data/cache/.gitkeep
data/index/*
!data/index/.gitkeep
```

Modify only these `package.json` scripts:

```json
{
  "test": "npm run test:unit",
  "test:unit": "npm run build && node --test tests/*.test.mjs"
}
```

Keep deployment, login and writeback scripts unchanged.

- [ ] **Step 8: 构建并运行完整 Coremail MCP 验证**

Run:

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

Expected:

- typecheck exit 0；
- 5 个非交互认证测试全部通过；
- build exit 0；
- diff check 无输出；
- 测试过程中没有出现 Edge/Chrome 新进程或窗口。

- [ ] **Step 9: 审计构建产物与敏感信息**

Run:

```powershell
git status --short
$diff = git diff --no-ext-diff
$text = $diff -join "`n"
[pscustomobject]@{
  secretPatterns = ([regex]::Matches($text, 'sk-[A-Za-z0-9_-]{16,}')).Count
  privateKeyPatterns = ([regex]::Matches($text, 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')).Count
  browserDisableMentions = ([regex]::Matches($text, 'KNOWLEDGE_AUTH_INTERACTIVE')).Count
} | Format-List
```

Expected: secret/private key 均为 0；源码、测试、文档和对应 `dist` 产物可见；`.env`、认证文件、缓存、日志和 `node_modules` 不在状态中。

- [ ] **Step 10: 提交非交互认证功能**

Run:

```powershell
git add -- .gitignore .env.example README.md package.json `
  src\utils\auth-interactivity.ts src\tools\auth-control.ts src\server.ts `
  scripts\coremail-auth.mjs tests\non-interactive-auth.test.mjs dist
git diff --cached --check
git commit -m "增加 Coremail MCP 非交互认证模式" `
  -m "完成内容：允许本机凭据静默刷新，并在后台模式下禁止浏览器导入、浏览器登录和 SSO 等待。" `
  -m "验证结果：类型检查、5 项非交互认证测试、构建和敏感信息扫描全部通过。"
git rev-parse HEAD
git status --short
git remote
```

Expected: 提交成功；工作区干净；remote 为空。

---

### Task 4: 增加 PSEAgent 历史回答契约与渲染

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Modify: `apps/pseagent/src/contracts.ts`
- Modify: `apps/pseagent/src/contracts.test.ts`
- Modify: `apps/pseagent/src/mcp-server.ts`
- Modify: `apps/pseagent/src/mcp-server.test.ts`

**Interfaces:**
- Produces: `HISTORICAL_ANSWER_WARNING`, `HistoricalReference`, `HistoricalAnswer`, optional `AnswerResult.historicalAnswer`, `formatMcpText(result)`.
- Consumes: 现有 `AnswerResult`、`NOT_COVERED_TEXT`。

- [ ] **Step 1: 写入失败的契约测试**

Extend imports in `contracts.test.ts` and add:

```ts
import {
  HISTORICAL_ANSWER_WARNING,
  answerResultSchema,
  historicalAnswerSchema,
} from "./contracts.js";

const historical = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "low",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史资料原文",
  references: [{
    sourceType: "jira",
    id: "10001",
    key: "CMHA-1097",
    title: "镜像版本记录",
    url: "https://jira.example.test/browse/CMHA-1097",
    updatedAt: "2026-07-20",
    versions: ["5.0", "5.1"],
    status: "已解决",
  }],
} as const;

it("keeps historical answers separate and requires verifiable Jira/Wiki sources", () => {
  const parsed = answerResultSchema.parse({
    scope: "professional",
    status: "not_covered",
    answer: "固定未覆盖文本",
    references: [],
    historicalAnswer: historical,
  });
  expect(parsed.references).toEqual([]);
  expect(parsed.historicalAnswer?.references[0]?.versions).toEqual(["5.0", "5.1"]);

  expect(() => historicalAnswerSchema.parse({ ...historical, confidence: "none" })).toThrow();
  expect(() => historicalAnswerSchema.parse({ ...historical, references: [] })).toThrow();
  expect(() => historicalAnswerSchema.parse({
    ...historical,
    references: [{ sourceType: "local", title: "本地来源" }],
  })).toThrow();
  expect(() => historicalAnswerSchema.parse({
    ...historical,
    warning: "可省略的警告",
  })).toThrow();
  expect(() => historicalAnswerSchema.parse({
    ...historical,
    answer: "x".repeat(32_769),
  })).toThrow();
});
```

- [ ] **Step 2: 写入失败的文本渲染测试**

Change the MCP test import to include `formatMcpText`, then add:

```ts
it("renders an isolated historical section without rewriting Markdown or Mermaid", () => {
  const rawHistoricalAnswer = [
    "原始历史答案。",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
  ].join("\n");
  const result: AnswerResult = {
    scope: "professional",
    status: "not_covered",
    answer: "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。",
    references: [],
    historicalAnswer: {
      provider: "coremail_mcp",
      verified: false,
      confidence: "low",
      warning: HISTORICAL_ANSWER_WARNING,
      answer: rawHistoricalAnswer,
      references: [{
        sourceType: "jira",
        key: "CMHA-1097",
        title: "镜像版本记录",
        updatedAt: "2026-07-20",
        versions: ["5.0", "5.1"],
        status: "已解决",
        url: "https://jira.example.test/browse/CMHA-1097",
      }],
    },
  };

  const text = formatMcpText(result);

  expect(text).toContain(result.answer);
  expect(text).toContain("Jira/Wiki 历史资料辅助回答");
  expect(text).toContain(HISTORICAL_ANSWER_WARNING);
  expect(text).toContain("可信度：低");
  expect(text).toContain(rawHistoricalAnswer);
  expect(text).toContain("版本：5.0、5.1");
  expect(text.indexOf(result.answer)).toBeLessThan(text.indexOf(rawHistoricalAnswer));
  expect(result.references).toEqual([]);
});
```

- [ ] **Step 3: 运行聚焦测试并确认失败**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/mcp-server.test.ts
```

Expected: FAIL，因为历史契约、固定警告和渲染尚不存在。

- [ ] **Step 4: 实现严格历史契约**

Add to `contracts.ts` before `answerResultSchema`:

```ts
export const HISTORICAL_ANSWER_WARNING =
  "以下内容由 Coremail MCP 根据 Jira/Wiki 历史资料自动整理，未经过产品或售前人员验证。资料可能过时、不完整或不准确，请勿直接作为投标、部署、升级或变更依据。";

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

export const historicalAnswerSchema = z.object({
  provider: z.literal("coremail_mcp"),
  verified: z.literal(false),
  confidence: z.enum(["low", "medium", "high"]),
  warning: z.literal(HISTORICAL_ANSWER_WARNING),
  answer: z.string().min(1).max(32_768),
  references: z.array(historicalReferenceSchema).min(1).max(20),
}).strict();
```

Extend `answerResultSchema`:

```ts
historicalAnswer: historicalAnswerSchema.optional(),
```

Export:

```ts
export type HistoricalReference = z.infer<typeof historicalReferenceSchema>;
export type HistoricalAnswer = z.infer<typeof historicalAnswerSchema>;
```

- [ ] **Step 5: 实现确定性渲染**

Modify `mcp-server.ts` imports and replace `formatMcpText()`:

```ts
import type {
  AnswerResult,
  HistoricalReference,
} from "./contracts.js";

const confidenceLabels = {
  low: "低",
  medium: "中",
  high: "高",
} as const;

export function formatMcpText(result: AnswerResult): string {
  if (!result.historicalAnswer) return result.answer;
  const historical = result.historicalAnswer;
  return [
    result.answer,
    "Jira/Wiki 历史资料辅助回答",
    historical.warning,
    `可信度：${confidenceLabels[historical.confidence]}`,
    historical.answer,
    "历史来源：",
    ...historical.references.map(formatHistoricalReference),
  ].join("\n\n");
}

function formatHistoricalReference(
  reference: HistoricalReference,
  index: number,
): string {
  const identity = reference.key ?? reference.id;
  const heading = [
    `${index + 1}. ${reference.sourceType === "jira" ? "Jira" : "Wiki"}`,
    identity,
    `《${reference.title}》`,
  ].filter((part): part is string => part !== undefined).join(" ");
  const details = [
    reference.updatedAt ? `更新时间：${reference.updatedAt}` : undefined,
    reference.status ? `状态：${reference.status}` : undefined,
    reference.versions?.length ? `版本：${reference.versions.join("、")}` : undefined,
    reference.url ? `链接：${reference.url}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [heading, ...details].join("\n");
}
```

Do not inspect or transform `historical.answer`.

- [ ] **Step 6: 运行聚焦和全量 PSEAgent 测试**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/mcp-server.test.ts
npm exec -w @pseagent/app -- vitest run src
npm run typecheck
git diff --check
```

Expected: 聚焦测试、PSEAgent 全量测试和 typecheck 全部通过；diff check 无输出。

- [ ] **Step 7: 提交契约与渲染**

Run:

```powershell
git add -- apps/pseagent/src/contracts.ts apps/pseagent/src/contracts.test.ts `
  apps/pseagent/src/mcp-server.ts apps/pseagent/src/mcp-server.test.ts
git diff --cached --check
git commit -m "阶段 24：增加历史资料回答契约" `
  -m "完成内容：增加严格历史回答字段、Jira/Wiki 多版本来源和固定未验证警告渲染。" `
  -m "验证结果：契约、MCP 渲染、PSEAgent 全量测试和类型检查全部通过。"
git rev-parse HEAD
```

Expected: 只提交四个列出的文件。

---

### Task 5: 实现只读 Coremail MCP 历史资料客户端

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Create: `apps/pseagent/src/coremail-mcp-client.ts`
- Create: `apps/pseagent/src/coremail-mcp-client.test.ts`

**Interfaces:**
- Consumes: `HistoricalAnswer`, `HistoricalReference`, `HISTORICAL_ANSWER_WARNING`.
- Produces: `HistoricalAnswerProvider`, `StdioCoremailHistoricalAnswerProvider`, `sanitizeCoremailHistoricalAnswer`, `coremailKnowledgeArguments`.

- [ ] **Step 1: 写入失败的结果清洗测试**

Create `coremail-mcp-client.test.ts` with imports and fixtures:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  StdioCoremailHistoricalAnswerProvider,
  coremailKnowledgeArguments,
  sanitizeCoremailHistoricalAnswer,
} from "./coremail-mcp-client.js";

const rawAnswer = [
  "原始答案",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
].join("\n");

const validRaw = {
  answer: rawAnswer,
  confidence: "low",
  sources: [
    {
      source_type: "jira",
      id: "10001",
      key: "CMHA-1097",
      title: "镜像版本记录",
      url: "https://jira.example.test/browse/CMHA-1097",
      updated_at: "2026-07-20",
      metadata: { status: "已解决", fix_versions: ["5.0", "5.1"] },
    },
    {
      source_type: "local",
      id: "local-1",
      title: "本地索引",
      url: "https://local.example.test/1",
    },
  ],
  diagnostics: { secret: "must-not-leak" },
};

describe("sanitizeCoremailHistoricalAnswer", () => {
  it("preserves the raw answer and maps only Jira/Wiki public fields", () => {
    const result = sanitizeCoremailHistoricalAnswer(validRaw);
    expect(result?.answer).toBe(rawAnswer);
    expect(result?.confidence).toBe("low");
    expect(result?.references).toEqual([{
      sourceType: "jira",
      id: "10001",
      key: "CMHA-1097",
      title: "镜像版本记录",
      url: "https://jira.example.test/browse/CMHA-1097",
      updatedAt: "2026-07-20",
      status: "已解决",
      versions: ["5.0", "5.1"],
    }]);
    expect(result).not.toHaveProperty("diagnostics");
  });

  it.each([
    { ...validRaw, confidence: "none" },
    { ...validRaw, answer: "" },
    { ...validRaw, answer: " \n " },
    { ...validRaw, answer: "x".repeat(32_769) },
    { ...validRaw, sources: [] },
    { ...validRaw, sources: [{ source_type: "local", title: "仅本地" }] },
    { ...validRaw, sources: [{ source_type: "unknown", title: "未知来源" }] },
  ])("rejects unsupported or unverifiable output", (value) => {
    expect(sanitizeCoremailHistoricalAnswer(value)).toBeUndefined();
  });

  it("maps Wiki identifiers without retaining unlisted metadata", () => {
    expect(sanitizeCoremailHistoricalAnswer({
      ...validRaw,
      sources: [{
        source_type: "wiki",
        id: "page-1",
        title: "历史 Wiki",
        metadata: { status: "有效", secret_field: "discard" },
      }],
    })?.references).toEqual([{
      sourceType: "wiki",
      id: "page-1",
      title: "历史 Wiki",
      status: "有效",
    }]);
  });

  it("builds the one fixed tool argument shape", () => {
    expect(coremailKnowledgeArguments("当前问题")).toEqual({
      question: "当前问题",
      intent: "auto",
      limit: 8,
      includeComments: true,
      commentMode: "relevant",
      profileRanking: true,
      explainRanking: false,
      includeRelationExpansion: true,
      relationDepth: 1,
      diagnosticsLevel: "summary",
    });
  });
});
```

- [ ] **Step 2: 写入失败的客户端生命周期测试**

Append fakes and tests:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type FakeMcpResult = {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

function fakeClient(
  result: FakeMcpResult = { structuredContent: validRaw },
) {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: [
        { name: "answer_coremail_knowledge" },
        { name: "auth_login" },
        { name: "search_jira" },
      ],
    })),
    callTool: vi.fn(async (
      _request: { name: string; arguments: Record<string, unknown> },
      _resultSchema?: undefined,
      _options?: { signal?: AbortSignal },
    ) => result),
    close: vi.fn(async () => undefined),
  };
}

describe("StdioCoremailHistoricalAnswerProvider", () => {
  it("is lazy, memoizes concurrent connect, and only calls the fixed tool", async () => {
    const gate = deferred<void>();
    const client = fakeClient();
    client.connect.mockImplementation(() => gate.promise);
    const transportFactory = vi.fn(() => ({ stderr: null }));
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: transportFactory,
        reportError: vi.fn(),
      },
    );
    expect(client.connect).not.toHaveBeenCalled();

    const first = provider.answer("问题一");
    const second = provider.answer("问题二");
    gate.resolve();
    await Promise.all([first, second]);

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments("问题一"),
        },
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments("问题二"),
        },
      ]),
    );
    for (const call of client.callTool.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(call[2]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(transportFactory).toHaveBeenCalledOnce();
  });

  it("forces a minimal child environment without PSE model secrets", async () => {
    const client = fakeClient();
    const createTransport = vi.fn(() => ({ stderr: null }));
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport,
        defaultEnvironment: () => ({
          PATH: "safe-path",
          PSE_MODEL_API_KEY: "must-not-pass",
        }),
        reportError: vi.fn(),
      },
    );

    await provider.answer("问题");

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      command: "node",
      args: ["C:\\runtime\\dist\\server.js"],
      env: {
        PATH: "safe-path",
        AI_ADOPTION_ENABLED: "false",
        KNOWLEDGE_ENABLE_CACHE: "false",
        KNOWLEDGE_AUTH_INTERACTIVE: "false",
      },
      stderr: "pipe",
    }));
  });

  it("returns undefined and reports only a safe code on invalid output", async () => {
    const reportError = vi.fn();
    const client = fakeClient({ structuredContent: { answer: "无来源", confidence: "none", sources: [] } });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError,
      },
    );

    await expect(provider.answer("问题")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith("coremail_mcp_invalid_result");
  });

  it("closes the underlying client once", async () => {
    const client = fakeClient();
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError: vi.fn(),
      },
    );
    await provider.answer("问题");
    await provider.close();
    await provider.close();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
```

Add these tests inside the same `describe` block:

```ts
it("uses text JSON only when structuredContent is absent", async () => {
  const client = fakeClient({ content: [{ type: "text", text: JSON.stringify(validRaw) }] });
  const provider = new StdioCoremailHistoricalAnswerProvider(
    "C:\\runtime\\dist\\server.js",
    {
      command: "node",
      timeoutMs: 30_000,
      validateEntry: () => "C:\\runtime\\dist\\server.js",
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
      reportError: vi.fn(),
    },
  );

  await expect(provider.answer("问题")).resolves.toMatchObject({ answer: rawAnswer });
});

it("prefers structuredContent and does not parse fallback text when both exist", async () => {
  const client = fakeClient({
    structuredContent: validRaw,
    content: [{ type: "text", text: "not-json" }],
  });
  const provider = new StdioCoremailHistoricalAnswerProvider(
    "C:\\runtime\\dist\\server.js",
    {
      command: "node",
      timeoutMs: 30_000,
      validateEntry: () => "C:\\runtime\\dist\\server.js",
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
      reportError: vi.fn(),
    },
  );

  await expect(provider.answer("问题")).resolves.toMatchObject({ answer: rawAnswer });
});

it("rejects a tool list without answer_coremail_knowledge", async () => {
  const reportError = vi.fn();
  const client = fakeClient();
  client.listTools.mockResolvedValue({ tools: [{ name: "search_jira" }] });
  const provider = new StdioCoremailHistoricalAnswerProvider(
    "C:\\runtime\\dist\\server.js",
    {
      command: "node",
      timeoutMs: 30_000,
      validateEntry: () => "C:\\runtime\\dist\\server.js",
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
      reportError,
    },
  );

  await expect(provider.answer("问题")).resolves.toBeUndefined();
  expect(reportError).toHaveBeenCalledWith("coremail_mcp_connect_failed");
  expect(client.close).toHaveBeenCalledOnce();
});

it("aborts on timeout, closes the broken client, and permits a later reconnect", async () => {
  const reportError = vi.fn();
  const firstClient = fakeClient();
  firstClient.callTool.mockImplementation(async (_request, _resultSchema, options) =>
    await new Promise<never>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) {
        reject(new Error("missing_abort_signal"));
        return;
      }
      const rejectOnAbort = () => reject(signal.reason);
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener("abort", rejectOnAbort, { once: true });
    }));
  const secondClient = fakeClient();
  const clients = [firstClient, secondClient];
  const createClient = vi.fn(() => {
    const client = clients.shift();
    if (!client) throw new Error("unexpected_client_generation");
    return client;
  });
  const provider = new StdioCoremailHistoricalAnswerProvider(
    "C:\\runtime\\dist\\server.js",
    {
      command: "node",
      timeoutMs: 5,
      validateEntry: () => "C:\\runtime\\dist\\server.js",
      createClient,
      createTransport: () => ({ stderr: null }),
      reportError,
    },
  );

  await expect(provider.answer("第一次")).resolves.toBeUndefined();
  expect(reportError).toHaveBeenLastCalledWith("coremail_mcp_timeout");
  expect(firstClient.close).toHaveBeenCalledOnce();

  await expect(provider.answer("第二次")).resolves.toMatchObject({ answer: rawAnswer });
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(secondClient.callTool).toHaveBeenCalledOnce();
});

it("classifies authentication failures without reporting the raw message", async () => {
  const reportError = vi.fn();
  const client = fakeClient();
  client.callTool.mockRejectedValue(
    new Error("401 authentication failed: secret response body"),
  );
  const provider = new StdioCoremailHistoricalAnswerProvider(
    "C:\\runtime\\dist\\server.js",
    {
      command: "node",
      timeoutMs: 30_000,
      validateEntry: () => "C:\\runtime\\dist\\server.js",
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
      reportError,
    },
  );

  await expect(provider.answer("问题")).resolves.toBeUndefined();
  expect(reportError).toHaveBeenCalledWith("coremail_mcp_auth_failed");
  expect(JSON.stringify(reportError.mock.calls)).not.toContain("secret response body");
});
```

These tests use only injected fakes; they must not launch a process or access the network.

- [ ] **Step 3: 运行聚焦测试并确认失败**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/coremail-mcp-client.test.ts
```

Expected: FAIL because `coremail-mcp-client.ts` does not exist.

- [ ] **Step 4: 实现固定参数和结果清洗**

Create `coremail-mcp-client.ts` with these public exports:

```ts
import { statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  HISTORICAL_ANSWER_WARNING,
  historicalAnswerSchema,
  type HistoricalAnswer,
  type HistoricalReference,
} from "./contracts.js";

export interface HistoricalAnswerProvider {
  answer(question: string, signal?: AbortSignal): Promise<HistoricalAnswer | undefined>;
  close(): Promise<void>;
}

export type CoremailMcpErrorCode =
  | "coremail_mcp_timeout"
  | "coremail_mcp_connect_failed"
  | "coremail_mcp_auth_failed"
  | "coremail_mcp_invalid_result"
  | "coremail_mcp_closed";

export function coremailKnowledgeArguments(question: string) {
  return {
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
  } as const;
}
```

Use tolerant external schemas that discard unknown fields:

```ts
const rawSourceSchema = z.object({
  source_type: z.string(),
  id: z.string().optional(),
  key: z.string().optional(),
  title: z.string().min(1),
  url: z.string().optional(),
  updated_at: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const rawAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.string(),
  sources: z.array(z.unknown()),
}).passthrough();
```

Implement:

```ts
export function sanitizeCoremailHistoricalAnswer(
  input: unknown,
): HistoricalAnswer | undefined {
  const parsed = rawAnswerSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { answer, confidence } = parsed.data;
  if (answer.trim().length === 0 || answer.length > 32_768) return undefined;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    return undefined;
  }

  const seen = new Set<string>();
  const references: HistoricalReference[] = [];
  for (const raw of parsed.data.sources) {
    const source = rawSourceSchema.safeParse(raw);
    if (!source.success) continue;
    if (source.data.source_type !== "jira" && source.data.source_type !== "wiki") continue;
    const metadata = source.data.metadata;
    const versions = Array.isArray(metadata?.fix_versions)
      ? metadata.fix_versions.filter((value): value is string =>
        typeof value === "string" && value.length > 0).slice(0, 20)
      : undefined;
    const status = typeof metadata?.status === "string" && metadata.status.length > 0
      ? metadata.status
      : undefined;
    const key = [
      source.data.source_type,
      source.data.key ?? source.data.id ?? source.data.url ?? source.data.title,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      sourceType: source.data.source_type,
      title: source.data.title,
      ...(source.data.id ? { id: source.data.id } : {}),
      ...(source.data.key ? { key: source.data.key } : {}),
      ...(source.data.url ? { url: source.data.url } : {}),
      ...(source.data.updated_at ? { updatedAt: source.data.updated_at } : {}),
      ...(versions?.length ? { versions } : {}),
      ...(status ? { status } : {}),
    });
    if (references.length === 20) break;
  }
  if (references.length === 0) return undefined;

  return historicalAnswerSchema.parse({
    provider: "coremail_mcp",
    verified: false,
    confidence,
    warning: HISTORICAL_ANSWER_WARNING,
    answer,
    references,
  });
}
```

- [ ] **Step 5: 实现懒连接状态机和最小子进程环境**

Define these internal MCP facades:

```ts
type McpClientFacade = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  }>;
  close(): Promise<void>;
};

type TransportFacade = {
  stderr?: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
};
```

Add the dependency contract and safe internal error:

```ts
export interface CoremailMcpClientDependencies {
  readonly command: string;
  readonly timeoutMs: number;
  readonly createClient?: () => McpClientFacade;
  readonly createTransport?: (options: StdioServerParameters) => TransportFacade;
  readonly defaultEnvironment?: () => Record<string, string>;
  readonly validateEntry?: (entryPath: string) => string;
  readonly reportError?: (code: CoremailMcpErrorCode) => void;
}

class CoremailMcpClientError extends Error {
  constructor(readonly code: CoremailMcpErrorCode) {
    super(code);
    this.name = "CoremailMcpClientError";
  }
}
```

Add the complete provider. It selects Node's standard environment from
`getDefaultEnvironment()`, removes every key beginning with `PSE_MODEL_`,
`KNOWLEDGE_ENGINE_`, or `KNOWLEDGE_MCP_`, and then forces the three safety flags:

```ts
export class StdioCoremailHistoricalAnswerProvider
implements HistoricalAnswerProvider {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly createClient: () => McpClientFacade;
  private readonly createTransport: (
    options: StdioServerParameters,
  ) => TransportFacade;
  private readonly defaultEnvironment: () => Record<string, string>;
  private readonly validateEntry: (entryPath: string) => string;
  private readonly reportError: (code: CoremailMcpErrorCode) => void;
  private readonly closedClients = new WeakSet<McpClientFacade>();
  private state: "idle" | "connecting" | "connected" | "closing" | "closed" =
    "idle";
  private generation = 0;
  private client?: McpClientFacade;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(
    private readonly entryPath: string,
    dependencies: CoremailMcpClientDependencies,
  ) {
    this.command = dependencies.command;
    this.timeoutMs = dependencies.timeoutMs;
    this.createClient = dependencies.createClient ?? (() =>
      new Client({
        name: "pseagent-coremail-history",
        version: "0.1.0",
      }) as unknown as McpClientFacade);
    this.createTransport = dependencies.createTransport ?? ((options) =>
      new StdioClientTransport(options) as TransportFacade);
    this.defaultEnvironment =
      dependencies.defaultEnvironment ?? getDefaultEnvironment;
    this.validateEntry = dependencies.validateEntry ?? validateCoremailEntry;
    this.reportError = dependencies.reportError ??
      ((code) => process.stderr.write(`${code}\n`));
  }

  async answer(
    question: string,
    signal?: AbortSignal,
  ): Promise<HistoricalAnswer | undefined> {
    if (this.state === "closing" || this.state === "closed") {
      this.reportError("coremail_mcp_closed");
      return undefined;
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error("coremail_mcp_timeout")),
      this.timeoutMs,
    );
    timer.unref();
    const requestSignal = signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, signal]);

    try {
      await raceWithAbort(this.connect(), requestSignal);
      const client = this.client;
      if (!client || this.state !== "connected") {
        throw new CoremailMcpClientError("coremail_mcp_connect_failed");
      }
      const result = await client.callTool(
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments(question),
        },
        undefined,
        { signal: requestSignal },
      );
      let raw: unknown;
      if (result.structuredContent !== undefined) {
        raw = result.structuredContent;
      } else {
        const text = result.content?.find((item) => item.type === "text")?.text;
        if (text === undefined) {
          throw new CoremailMcpClientError("coremail_mcp_invalid_result");
        }
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          throw new CoremailMcpClientError("coremail_mcp_invalid_result");
        }
      }
      const historical = sanitizeCoremailHistoricalAnswer(raw);
      if (historical === undefined) {
        throw new CoremailMcpClientError("coremail_mcp_invalid_result");
      }
      return historical;
    } catch (error) {
      if (signal?.aborted && !timeoutController.signal.aborted) {
        await this.resetBrokenConnection();
        return undefined;
      }
      const code = classifyCoremailError(
        error,
        timeoutController.signal.aborted,
      );
      if (
        code !== "coremail_mcp_invalid_result" &&
        code !== "coremail_mcp_closed"
      ) {
        await this.resetBrokenConnection();
      }
      this.reportError(code);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return;
    this.state = "closing";
    this.generation += 1;
    const client = this.client;
    const connecting = this.connectPromise;
    this.client = undefined;
    this.connectPromise = undefined;
    this.closePromise = (async () => {
      if (client) await this.closeClient(client);
      await connecting?.catch(() => undefined);
      this.state = "closed";
    })();
    return this.closePromise;
  }

  private async connect(): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      throw new CoremailMcpClientError("coremail_mcp_closed");
    }
    if (this.state === "connected") return;
    if (this.connectPromise) return this.connectPromise;

    this.state = "connecting";
    const generation = ++this.generation;
    const connecting = this.startConnection(generation);
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = undefined;
    }
  }

  private async startConnection(generation: number): Promise<void> {
    let client: McpClientFacade | undefined;
    try {
      const entry = this.validateEntry(this.entryPath);
      client = this.createClient();
      this.client = client;
      const transport = this.createTransport({
        command: this.command,
        args: [entry],
        env: this.childEnvironment(),
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => undefined);
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) =>
        tool.name === "answer_coremail_knowledge")) {
        throw new CoremailMcpClientError("coremail_mcp_connect_failed");
      }
      if (
        generation !== this.generation ||
        this.state === "closing" ||
        this.state === "closed"
      ) {
        throw new CoremailMcpClientError("coremail_mcp_closed");
      }
      this.state = "connected";
    } catch (error) {
      if (client) await this.closeClient(client);
      if (this.client === client) this.client = undefined;
      if (
        generation === this.generation &&
        this.state !== "closing" &&
        this.state !== "closed"
      ) {
        this.state = "idle";
      }
      throw error;
    }
  }

  private childEnvironment(): Record<string, string> {
    const child: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.defaultEnvironment())) {
      if (
        name.startsWith("PSE_MODEL_") ||
        name.startsWith("KNOWLEDGE_ENGINE_") ||
        name.startsWith("KNOWLEDGE_MCP_")
      ) {
        continue;
      }
      child[name] = value;
    }
    return {
      ...child,
      AI_ADOPTION_ENABLED: "false",
      KNOWLEDGE_ENABLE_CACHE: "false",
      KNOWLEDGE_AUTH_INTERACTIVE: "false",
    };
  }

  private async resetBrokenConnection(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    this.client = undefined;
    this.connectPromise = undefined;
    if (this.state !== "closing" && this.state !== "closed") {
      this.state = "idle";
    }
    if (client) await this.closeClient(client);
  }

  private async closeClient(client: McpClientFacade): Promise<void> {
    if (this.closedClients.has(client)) return;
    this.closedClients.add(client);
    await client.close().catch(() => undefined);
  }
}
```

Add the entry, abort, and error-classification helpers:

```ts
function validateCoremailEntry(entryPath: string): string {
  if (!path.isAbsolute(entryPath)) throw new Error("coremail_mcp_invalid_entry");
  const normalized = path.normalize(entryPath);
  if (
    path.basename(normalized).toLowerCase() !== "server.js" ||
    path.basename(path.dirname(normalized)).toLowerCase() !== "dist"
  ) {
    throw new Error("coremail_mcp_invalid_entry");
  }
  if (!statSync(normalized).isFile()) throw new Error("coremail_mcp_invalid_entry");
  return normalized;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function classifyCoremailError(
  error: unknown,
  timedOut: boolean,
): CoremailMcpErrorCode {
  if (timedOut) return "coremail_mcp_timeout";
  if (error instanceof CoremailMcpClientError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/(?:401|302|authentication|credentials|sso)/iu.test(message)) {
    return "coremail_mcp_auth_failed";
  }
  return "coremail_mcp_connect_failed";
}
```

No branch may pass a raw error to `reportError()` or to the caller.

- [ ] **Step 6: 运行客户端测试并修正到全部通过**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/coremail-mcp-client.test.ts
npm run typecheck
```

Expected: all client tests pass；typecheck exit 0。

- [ ] **Step 7: 运行全量 TypeScript 测试和敏感输出扫描**

Run:

```powershell
npm run test:ts
git diff --check
$diff = git diff --no-ext-diff
$text = $diff -join "`n"
[pscustomobject]@{
  secretPatterns = ([regex]::Matches($text, 'sk-[A-Za-z0-9_-]{16,}')).Count
  internalIpPatterns = ([regex]::Matches($text, '192\.168\.')).Count
  privateKeyPatterns = ([regex]::Matches($text, 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')).Count
} | Format-List
```

Expected: TypeScript 全量测试通过；三类敏感模式均为 0。

- [ ] **Step 8: 提交客户端**

Run:

```powershell
git add -- apps/pseagent/src/coremail-mcp-client.ts `
  apps/pseagent/src/coremail-mcp-client.test.ts
git diff --cached --check
git commit -m "阶段 25：增加只读 Coremail MCP 客户端" `
  -m "完成内容：实现固定工具调用、懒连接、来源清洗、非交互子进程环境和失败降级。" `
  -m "验证结果：客户端定向测试、TypeScript 全量测试、类型检查和敏感信息扫描全部通过。"
git rev-parse HEAD
```

Expected: 只提交两个客户端文件。

---

### Task 6: 接入 AnswerService、配置和运行时

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Modify: `apps/pseagent/src/answer-service.ts`
- Modify: `apps/pseagent/src/answer-service.test.ts`
- Modify: `apps/pseagent/src/config.ts`
- Modify: `apps/pseagent/src/config.test.ts`
- Modify: `apps/pseagent/src/main.ts`
- Modify: `apps/pseagent/src/main-wiring.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `HistoricalAnswerProvider`, `StdioCoremailHistoricalAnswerProvider`.
- Produces: conditional `AppConfig.coremailMcp` and runtime-managed historical provider.

- [ ] **Step 1: 写入失败的 AnswerService 触发矩阵测试**

Add helpers and tests to `answer-service.test.ts`:

```ts
import type { HistoricalAnswerProvider } from "./coremail-mcp-client.js";
import {
  HISTORICAL_ANSWER_WARNING,
  type AnswerResult,
  type HistoricalAnswer,
} from "./contracts.js";

const historical: HistoricalAnswer = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "low",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史原文",
  references: [{ sourceType: "jira", key: "CMHA-1097", title: "镜像版本记录" }],
};

function knowledgeService(primary: AnswerResult, provider?: HistoricalAnswerProvider) {
  const model = { completeText: vi.fn() } as unknown as ModelClient;
  const router = { route: vi.fn(async () => primary.scope) };
  const knowledge = { open: vi.fn(async () => ({ project: "coremail-professional" })) };
  const runAgent = vi.fn(async () => primary);
  return {
    service: new AnswerService({
      model,
      router,
      knowledge,
      runAgent,
      ...(provider ? { historicalProvider: provider } : {}),
    }),
    runAgent,
  };
}

it.each(["answered", "partially_answered", "temporarily_unavailable"] as const)(
  "does not call historical data for %s",
  async (status) => {
    const provider = { answer: vi.fn(), close: vi.fn() };
    const primary: AnswerResult = {
      scope: "professional",
      status,
      answer: "正式结果",
      references: status === "temporarily_unavailable" ? [] : [{
        index: 1,
        project: "coremail-professional",
        title: "正式来源",
        path: "wiki/page.md",
        revision: "a".repeat(40),
        contentHash: "b".repeat(64),
      }],
    };
    const { service } = knowledgeService(primary, provider);
    await expect(service.answer("问题")).resolves.toBe(primary);
    expect(provider.answer).not.toHaveBeenCalled();
  },
);

it("adds historicalAnswer only after not_covered and passes no conversation context", async () => {
  const provider = {
    answer: vi.fn(async () => historical),
    close: vi.fn(async () => undefined),
  };
  const primary: AnswerResult = {
    scope: "professional",
    status: "not_covered",
    answer: "固定未覆盖文本",
    references: [],
  };
  const { service } = knowledgeService(primary, provider);

  const result = await service.answer("当前问题", "不得传出的上下文");

  expect(provider.answer).toHaveBeenCalledWith("当前问题", undefined);
  expect(result).toEqual({ ...primary, historicalAnswer: historical });
  expect(result.references).toEqual([]);
});

it("returns the identical primary object when historical lookup fails", async () => {
  const provider = {
    answer: vi.fn(async () => { throw new Error("secret failure"); }),
    close: vi.fn(async () => undefined),
  };
  const primary: AnswerResult = {
    scope: "general",
    status: "not_covered",
    answer: "固定未覆盖文本",
    references: [],
  };
  const { service } = knowledgeService(primary, provider);
  await expect(service.answer("问题")).resolves.toBe(primary);
});
```

In the existing `answers normal questions without opening a knowledge session`
test, add:

```ts
const historicalProvider: HistoricalAnswerProvider = {
  answer: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};
```

Pass `historicalProvider` into that test's `new AnswerService({...})` dependency
object and add:

```ts
expect(historicalProvider.answer).not.toHaveBeenCalled();
```

- [ ] **Step 2: 写入失败的条件配置测试**

Extend `config.test.ts`:

```ts
const baseEnv = {
  PSE_MODEL_BASE_URL: "https://model.example/v1",
  PSE_MODEL_API_KEY: "secret",
  PSE_MODEL_NAME: "model",
  PSE_MODEL_TIMEOUT_MS: "60000",
  KNOWLEDGE_MCP_COMMAND: "node",
  KNOWLEDGE_MCP_ENTRY_PATH: "C:\\app\\server.js",
};

it("keeps Coremail MCP disabled without requiring its command or path", () => {
  expect(loadConfig({ ...baseEnv, COREMAIL_MCP_ENABLED: "false" }).coremailMcp)
    .toEqual({ enabled: false });
});

it("requires the exact absolute read-only server entry when enabled", () => {
  const config = loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "true",
    COREMAIL_MCP_COMMAND: "node",
    COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
    COREMAIL_MCP_TIMEOUT_MS: "30000",
  });
  expect(config.coremailMcp).toEqual({
    enabled: true,
    command: "node",
    entryPath: "C:\\runtime\\dist\\server.js",
    timeoutMs: 30_000,
  });
  expect(() => loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "true",
    COREMAIL_MCP_COMMAND: "node",
    COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\writeback-server.js",
  })).toThrow();
  expect(() => loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "falsey",
  })).toThrow();
});
```

Add the exact timeout boundary test:

```ts
it.each(["999", "120001"])(
  "rejects an out-of-range Coremail MCP timeout: %s",
  (timeout) => {
    expect(() => loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "true",
      COREMAIL_MCP_COMMAND: "node",
      COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
      COREMAIL_MCP_TIMEOUT_MS: timeout,
    })).toThrow();
  },
);

it("rejects missing, blank, or relative enabled Coremail configuration", () => {
  expect(() => loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "true",
  })).toThrow();
  expect(() => loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "true",
    COREMAIL_MCP_COMMAND: " ",
    COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
  })).toThrow();
  expect(() => loadConfig({
    ...baseEnv,
    COREMAIL_MCP_ENABLED: "true",
    COREMAIL_MCP_COMMAND: "node",
    COREMAIL_MCP_ENTRY_PATH: "dist\\server.js",
  })).toThrow();
});
```

- [ ] **Step 3: 写入失败的运行时懒启动与关闭测试**

Extend `main-wiring.test.ts` dependencies with:

```ts
const historicalProvider = {
  answer: vi.fn(async () => undefined),
  close: vi.fn(async () => { throw new Error("close failure"); }),
};
const createHistoricalProvider = vi.fn(() => historicalProvider);
```

Use enabled config and assert:

```ts
expect(createHistoricalProvider).toHaveBeenCalledOnce();
expect(historicalProvider.answer).not.toHaveBeenCalled();

await runtime.close();
await runtime.close();

expect(historicalProvider.close).toHaveBeenCalledOnce();
expect(caller.close).toHaveBeenCalledOnce();
expect(closeServer).toHaveBeenCalledOnce();
```

The test must still pass when the historical close rejects.

- [ ] **Step 4: 运行聚焦测试并确认失败**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run `
  src/answer-service.test.ts src/config.test.ts src/main-wiring.test.ts
```

Expected: FAIL because `historicalProvider` and `coremailMcp` config are not wired.

- [ ] **Step 5: 实现 AnswerService 编排**

Modify the constructor dependency type:

```ts
readonly historicalProvider?: HistoricalAnswerProvider;
```

After `runAgent(input)`:

```ts
const primary = await this.dependencies.runAgent(input);
if (
  primary.status !== "not_covered" ||
  this.dependencies.historicalProvider === undefined
) {
  return primary;
}
try {
  const historicalAnswer =
    await this.dependencies.historicalProvider.answer(question, signal);
  return historicalAnswer === undefined
    ? primary
    : { ...primary, historicalAnswer };
} catch {
  return primary;
}
```

Keep this inner `try/catch` inside the existing primary-answer `try`; Coremail failures must never reach `temporaryUnavailableResult()`.

- [ ] **Step 6: 实现条件配置**

In `config.ts`, parse the existing base fields first, then return:

```ts
export type CoremailMcpConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly command: string;
      readonly entryPath: string;
      readonly timeoutMs: number;
    };

export type AppConfig = z.infer<typeof baseEnvSchema> & {
  readonly coremailMcp: CoremailMcpConfig;
};
```

Use exact boolean parsing:

```ts
const enabled = z.enum(["true", "false"])
  .default("false")
  .parse(env.COREMAIL_MCP_ENABLED) === "true";
```

When enabled, validate:

```ts
const command = z.string().trim().min(1).parse(env.COREMAIL_MCP_COMMAND);
const entryPath = z.string().trim().min(1).parse(env.COREMAIL_MCP_ENTRY_PATH);
const timeoutMs = z.coerce.number().int().min(1_000).max(120_000)
  .default(30_000).parse(env.COREMAIL_MCP_TIMEOUT_MS);
if (!path.isAbsolute(entryPath)) throw new Error("COREMAIL_MCP_ENTRY_PATH must be absolute.");
if (
  path.basename(entryPath).toLowerCase() !== "server.js" ||
  path.basename(path.dirname(entryPath)).toLowerCase() !== "dist"
) {
  throw new Error("COREMAIL_MCP_ENTRY_PATH must target dist/server.js.");
}
```

Return `{ ...base, coremailMcp }`.

- [ ] **Step 7: 实现运行时依赖和关闭隔离**

Add to `PseRuntimeDependencies`:

```ts
readonly createHistoricalProvider?: (
  config: Extract<CoremailMcpConfig, { enabled: true }>,
) => HistoricalAnswerProvider;
```

Create the provider only when enabled:

```ts
const historicalProvider = config.coremailMcp.enabled
  ? (dependencies.createHistoricalProvider ?? defaultCreateHistoricalProvider)(
      config.coremailMcp,
    )
  : undefined;
```

Pass it to `AnswerService` only when defined. Do not call `answer()` or connect during runtime construction.

Default factory:

```ts
function defaultCreateHistoricalProvider(
  config: Extract<CoremailMcpConfig, { enabled: true }>,
): HistoricalAnswerProvider {
  return new StdioCoremailHistoricalAnswerProvider(config.entryPath, {
    command: config.command,
    timeoutMs: config.timeoutMs,
  });
}
```

Add `historicalProvider?.close()` as its own `Promise.allSettled()` item in runtime shutdown. If setup fails after provider construction, best-effort close both knowledge caller and historical provider before rethrowing.

- [ ] **Step 8: 更新非敏感配置示例**

Append to `.env.example`:

```text
COREMAIL_MCP_ENABLED=false
COREMAIL_MCP_COMMAND=node
COREMAIL_MCP_ENTRY_PATH=C:/Users/Coremail/.local/share/coremail-knowledge-mcp/current/dist/server.js
COREMAIL_MCP_TIMEOUT_MS=30000
```

Do not add account, password, Cookie, auth store contents, AI Adoption, cache or interactive flags; those three child flags are hard-coded safe values.

- [ ] **Step 9: 运行聚焦与全量离线验证**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run `
  src/answer-service.test.ts src/config.test.ts src/main-wiring.test.ts
npm run typecheck
npm test
npm run build
npm run test:regression
git diff --check
```

Expected:

- focused tests pass；
- PSEAgent、Knowledge MCP、Knowledge Engine 全部 0 failures；
- build exit 0；
- regression 全部通过；
- diff check 无输出。

If the existing Windows Rust `http_api` temporary-directory collision appears, rerun `cargo test --manifest-path services\knowledge-engine\Cargo.toml --test http_api -- --test-threads=1` to diagnose, then rerun the unmodified default `npm test`; do not change unrelated Rust code in this feature.

- [ ] **Step 10: 提交服务、配置和运行时**

Run:

```powershell
git add -- .env.example apps/pseagent/src/answer-service.ts `
  apps/pseagent/src/answer-service.test.ts apps/pseagent/src/config.ts `
  apps/pseagent/src/config.test.ts apps/pseagent/src/main.ts `
  apps/pseagent/src/main-wiring.test.ts
git diff --cached --check
git commit -m "阶段 26：接入 Coremail 历史资料降级链路" `
  -m "完成内容：仅在 not_covered 后调用历史提供器，并实现条件配置、懒启动和关闭隔离。" `
  -m "验证结果：编排、配置、运行时测试、全量测试、构建和固定回归全部通过。"
git rev-parse HEAD
```

Expected: 只提交列出的七个路径。

---

### Task 7: 发布运行版、完成真实验收并恢复用户入口

**Repositories:**
- Source: `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp`
- Platform: `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Create: `scripts/probe-coremail-historical.mts`
- Create: `apps/pseagent/src/coremail-historical-probe-contract.ts`
- Create: `apps/pseagent/src/coremail-historical-probe-contract.test.ts`
- Modify: `scripts/probe-live.mts`
- Modify: `package.json`
- Modify: `docs/local-runbook.md`
- Create: `docs/verification/coremail-historical-answer-live-acceptance.md`
- Local-only: `.env.local`
- External release: `C:\Users\Coremail\.local\share\coremail-knowledge-mcp\releases\<commit>`
- External junction: `C:\Users\Coremail\.local\share\coremail-knowledge-mcp\current`

**Interfaces:**
- Consumes: verified Coremail MCP commit、verified PSEAgent build、existing local auth store。
- Produces: stable `current/dist/server.js` and a sanitized live acceptance record.

- [ ] **Step 1: 最终验证两个源码提交**

Run:

```powershell
$coremailRepo = 'C:\Users\Coremail\Desktop\Coremail-PSE\coremail-knowledge-mcp'
$platformRepo = 'C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform'

git -C $coremailRepo status --short
git -C $coremailRepo remote
git -C $coremailRepo rev-parse HEAD
npm --prefix $coremailRepo run typecheck
npm --prefix $coremailRepo test
npm --prefix $coremailRepo run build

git -C $platformRepo status --short
git -C $platformRepo remote
git -C $platformRepo rev-parse HEAD
npm --prefix $platformRepo run typecheck
npm --prefix $platformRepo test
npm --prefix $platformRepo run build
npm --prefix $platformRepo run test:regression
```

Expected:

- Coremail repo clean、无 remote、typecheck/test/build 通过；
- platform 只允许 `?? .sisyphus/`、无 remote、全部验证通过。

- [ ] **Step 2: 发布不可变运行目录**

Run in PowerShell:

```powershell
$source = (Resolve-Path -LiteralPath $coremailRepo).Path
$commit = git -C $source rev-parse HEAD
$runtimeRoot = 'C:\Users\Coremail\.local\share\coremail-knowledge-mcp'
$releases = Join-Path $runtimeRoot 'releases'
$release = Join-Path $releases $commit
$current = Join-Path $runtimeRoot 'current'

New-Item -ItemType Directory -Force -Path $releases | Out-Null
if (Test-Path -LiteralPath $release) { throw 'release_already_exists' }
New-Item -ItemType Directory -Path $release | Out-Null

foreach ($name in @('package.json', 'package-lock.json', 'README.md', '.env.example')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination $release
}
foreach ($name in @('config', 'data', 'dist', 'scripts', 'vendor')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination $release -Recurse
}

Push-Location $release
try {
  npm ci --omit=dev --ignore-scripts
} finally {
  Pop-Location
}

if (Test-Path -LiteralPath $current) {
  $currentItem = Get-Item -LiteralPath $current -Force
  if (-not ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'refusing_to_replace_non_link_current'
  }
  Remove-Item -LiteralPath $current -Force
}
New-Item -ItemType Junction -Path $current -Target $release | Out-Null

$entry = Join-Path $current 'dist\server.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw 'published_server_missing'
}
```

Expected: `current` is a junction to the exact commit release；`dist/server.js` exists；no source repository file is modified。

- [ ] **Step 3: 完成一次本机认证初始化**

Run from the release directory in a visible interactive terminal:

```powershell
Set-Location -LiteralPath $release
npm run login
```

Expected:

- user types the personal account and password only into the hidden local prompt；
- Jira and configured Wikis report successful login；
- default auth store is updated；
- no password appears in terminal history or transcript。

This is a user checkpoint. Do not continue until the user confirms login succeeded. Never ask the user to send the password through chat.

- [ ] **Step 4: 增加非敏感本机 PSEAgent 配置**

Ensure the ignored `pseagent-platform\.env.local` contains:

```text
COREMAIL_MCP_ENABLED=true
COREMAIL_MCP_COMMAND=node
COREMAIL_MCP_ENTRY_PATH=C:/Users/Coremail/.local/share/coremail-knowledge-mcp/current/dist/server.js
COREMAIL_MCP_TIMEOUT_MS=30000
```

Preserve all existing model and Knowledge Engine settings. Do not print `.env.local`. Verify only key names:

```powershell
$required = @(
  'COREMAIL_MCP_ENABLED',
  'COREMAIL_MCP_COMMAND',
  'COREMAIL_MCP_ENTRY_PATH',
  'COREMAIL_MCP_TIMEOUT_MS'
)
$names = Get-Content -LiteralPath .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#=\s]+)=') { $matches[1] }
}
$missing = @($required | Where-Object { $_ -notin $names })
if ($missing.Count -ne 0) { throw "missing_coremail_env_keys:$($missing -join ',')" }
if ((git check-ignore .env.local) -ne '.env.local') { throw 'env_local_not_ignored' }
```

Expected: no missing keys；`.env.local` ignored；no values printed。

- [ ] **Step 5: 增加专用脱敏真实探针**

Create `scripts/probe-coremail-historical.mts` with the complete probe:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { answerResultSchema } from "../apps/pseagent/src/contracts.js";
import { coremailKnowledgeArguments } from "../apps/pseagent/src/coremail-mcp-client.js";
import { validateHistoricalProbe } from
  "../apps/pseagent/src/coremail-historical-probe-contract.js";
import { NOT_COVERED_TEXT } from "../apps/pseagent/src/response.js";

const question = "请说明 Jira 工单 CMHA-1097 的修改内容和适用镜像版本。";
const coveredQuestion = "列出 Coremail AI 助手的新功能特性";
const mode = process.env.PSE_COREMAIL_PROBE_MODE ?? "historical";
const inheritedNames = [
  "PSE_MODEL_BASE_URL",
  "PSE_MODEL_API_KEY",
  "PSE_MODEL_NAME",
  "PSE_MODEL_TIMEOUT_MS",
  "KNOWLEDGE_MCP_COMMAND",
  "KNOWLEDGE_MCP_ENTRY_PATH",
  "KNOWLEDGE_ENGINE_URL",
  "KNOWLEDGE_ENGINE_TOKEN",
  "KNOWLEDGE_ENGINE_TIMEOUT_MS",
  "KNOWLEDGE_ENGINE_ALLOW_REMOTE",
  "COREMAIL_MCP_ENABLED",
  "COREMAIL_MCP_COMMAND",
  "COREMAIL_MCP_ENTRY_PATH",
  "COREMAIL_MCP_TIMEOUT_MS",
] as const;
const safeFailureCodes = new Set([
  "missing_coremail_entry",
  "unexpected_outer_tool_list",
  "unexpected_coremail_tool_list",
  "unexpected_primary_status",
  "unexpected_primary_answer",
  "unexpected_primary_references",
  "missing_historical_answer",
  "missing_historical_reference",
  "unexpected_historical_source_type",
  "unexpected_historical_warning",
  "unexpected_historical_confidence",
  "missing_direct_historical_reference",
  "historical_answer_rewritten",
  "unexpected_probe_mode",
  "coremail_probe_not_enabled",
  "broken_path_fallback_changed",
  "covered_query_changed",
  "covered_query_started_coremail",
  "refusing_probe_temp_cleanup",
]);

async function probe(): Promise<void> {
  const pseEnvironment = getDefaultEnvironment();
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) pseEnvironment[name] = value;
  }
  if (!["historical", "broken_path", "covered"].includes(mode)) {
    throw new Error("unexpected_probe_mode");
  }
  if (pseEnvironment.COREMAIL_MCP_ENABLED !== "true") {
    throw new Error("coremail_probe_not_enabled");
  }

  let temporaryRoot: string | undefined;
  let markerPath: string | undefined;
  let activeQuestion = question;
  if (mode === "broken_path") {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "pse-coremail-broken-"));
    pseEnvironment.COREMAIL_MCP_ENTRY_PATH = path.join(
      temporaryRoot,
      "missing",
      "dist",
      "server.js",
    );
  } else if (mode === "covered") {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "pse-coremail-covered-"));
    const sentinelDist = path.join(temporaryRoot, "dist");
    mkdirSync(sentinelDist);
    markerPath = path.join(temporaryRoot, "started.marker");
    const sentinelEntry = path.join(sentinelDist, "server.js");
    writeFileSync(
      sentinelEntry,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");\n`,
      "utf8",
    );
    pseEnvironment.COREMAIL_MCP_ENTRY_PATH = sentinelEntry;
    activeQuestion = coveredQuestion;
  }
  const pseTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/pseagent/dist/main.js"],
    env: pseEnvironment,
    stderr: "pipe",
  });
  pseTransport.stderr?.on("data", () => undefined);

  const pseClient = new Client({
    name: "pseagent-coremail-live-probe",
    version: "0.1.0",
  });
  let directClient: Client | undefined;

  try {
    await pseClient.connect(pseTransport);
    const pseTools = await pseClient.listTools();
    if (pseTools.tools.length !== 1 || pseTools.tools[0]?.name !== "pse_answer") {
      throw new Error("unexpected_outer_tool_list");
    }

    if (mode !== "historical") {
      const raw = await pseClient.callTool(
        { name: "pse_answer", arguments: { question: activeQuestion } },
        undefined,
        { timeout: 1_800_000 },
      );
      const result = answerResultSchema.parse(raw.structuredContent);
      if (mode === "broken_path") {
        if (
          result.status !== "not_covered" ||
          result.answer !== NOT_COVERED_TEXT ||
          result.references.length !== 0 ||
          result.historicalAnswer !== undefined
        ) {
          throw new Error("broken_path_fallback_changed");
        }
        process.stdout.write(
          "broken_path startup=true fallback_unchanged=true\n",
        );
        return;
      }
      if (
        (result.status !== "answered" &&
          result.status !== "partially_answered") ||
        result.references.length === 0 ||
        result.historicalAnswer !== undefined
      ) {
        throw new Error("covered_query_changed");
      }
      if (markerPath && existsSync(markerPath)) {
        throw new Error("covered_query_started_coremail");
      }
      process.stdout.write("covered_query coremail_started=false\n");
      return;
    }

    const coremailEntry = process.env.COREMAIL_MCP_ENTRY_PATH;
    if (!coremailEntry) throw new Error("missing_coremail_entry");
    const directEnvironment = {
      ...getDefaultEnvironment(),
      AI_ADOPTION_ENABLED: "false",
      KNOWLEDGE_ENABLE_CACHE: "false",
      KNOWLEDGE_AUTH_INTERACTIVE: "false",
    };
    const directTransport = new StdioClientTransport({
      command: process.env.COREMAIL_MCP_COMMAND ?? process.execPath,
      args: [coremailEntry],
      env: directEnvironment,
      stderr: "pipe",
    });
    directTransport.stderr?.on("data", () => undefined);
    directClient = new Client({
      name: "coremail-direct-live-probe",
      version: "0.1.0",
    });
    await directClient.connect(directTransport);
    const directTools = await directClient.listTools();
    if (!directTools.tools.some((tool) => tool.name === "answer_coremail_knowledge")) {
      throw new Error("unexpected_coremail_tool_list");
    }

    const started = performance.now();
    const pseRaw = await pseClient.callTool(
      { name: "pse_answer", arguments: { question } },
      undefined,
      { timeout: 1_800_000 },
    );
    const directRaw = await directClient.callTool(
      {
        name: "answer_coremail_knowledge",
        arguments: coremailKnowledgeArguments(question),
      },
      undefined,
      { timeout: 60_000 },
    );
    const summary = validateHistoricalProbe(
      pseRaw.structuredContent,
      directRaw.structuredContent,
    );
    const elapsedMs = Math.round(performance.now() - started);
    process.stdout.write(
      `historical status=not_covered main_refs=${summary.mainRefs}` +
      ` history_refs=${summary.historyRefs} confidence=${summary.confidence}` +
      ` raw_equal=${summary.rawEqual} warning=${summary.warning}` +
      ` elapsed_ms=${elapsedMs}\n`,
    );
  } finally {
    await Promise.allSettled([
      pseClient.close(),
      ...(directClient ? [directClient.close()] : []),
    ]);
    if (temporaryRoot) {
      const resolvedRoot = path.resolve(temporaryRoot);
      const resolvedTemp = `${path.resolve(tmpdir())}${path.sep}`;
      if (!resolvedRoot.startsWith(resolvedTemp)) {
        throw new Error("refusing_probe_temp_cleanup");
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

probe().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = safeFailureCodes.has(message) ? message : "unclassified";
  process.stderr.write(`probe_coremail_historical_failed code=${code}\n`);
  process.exitCode = 1;
});
```

Both child stderr streams are drained without printing. Failure output is restricted to an allowlist of symbolic codes and never includes raw error messages.

- [ ] **Step 6: 更新现有探针和 npm 命令**

Add these names to `scripts/probe-live.mts` `inheritedNames`:

```ts
"COREMAIL_MCP_ENABLED",
"COREMAIL_MCP_COMMAND",
"COREMAIL_MCP_ENTRY_PATH",
"COREMAIL_MCP_TIMEOUT_MS",
```

Do not add Coremail auth credentials or child safety flags.

Add to root `package.json` scripts:

```json
"probe:coremail": "node --env-file=.env.local --import tsx scripts/probe-coremail-historical.mts"
```

- [ ] **Step 7: 增加离线探针契约测试**

Do not make the real probe run in `npm test`. Create
`apps/pseagent/src/coremail-historical-probe-contract.ts`; no `tsconfig` change is
needed because this location is already inside the app source root:

```ts
import { z } from "zod";
import {
  HISTORICAL_ANSWER_WARNING,
  answerResultSchema,
} from "./contracts.js";
import { NOT_COVERED_TEXT } from "./response.js";

const directHistoricalAnswerSchema = z.object({
  answer: z.string().min(1).max(32_768),
  confidence: z.enum(["low", "medium", "high"]),
  sources: z.array(z.object({
    source_type: z.string(),
  }).passthrough()).min(1),
}).passthrough();

export function validateHistoricalProbe(
  pseInput: unknown,
  directInput: unknown,
) {
  const pseResult = answerResultSchema.parse(pseInput);
  const directResult = directHistoricalAnswerSchema.parse(directInput);
  if (pseResult.status !== "not_covered") {
    throw new Error("unexpected_primary_status");
  }
  if (pseResult.answer !== NOT_COVERED_TEXT) {
    throw new Error("unexpected_primary_answer");
  }
  if (pseResult.references.length !== 0) {
    throw new Error("unexpected_primary_references");
  }
  const historical = pseResult.historicalAnswer;
  if (!historical) throw new Error("missing_historical_answer");
  if (historical.references.length < 1) {
    throw new Error("missing_historical_reference");
  }
  if (!historical.references.every((reference) =>
    reference.sourceType === "jira" || reference.sourceType === "wiki")) {
    throw new Error("unexpected_historical_source_type");
  }
  if (historical.warning !== HISTORICAL_ANSWER_WARNING) {
    throw new Error("unexpected_historical_warning");
  }
  if (historical.confidence !== directResult.confidence) {
    throw new Error("unexpected_historical_confidence");
  }
  if (!directResult.sources.some((source) =>
    source.source_type === "jira" || source.source_type === "wiki")) {
    throw new Error("missing_direct_historical_reference");
  }
  if (historical.answer !== directResult.answer) {
    throw new Error("historical_answer_rewritten");
  }
  return {
    mainRefs: pseResult.references.length,
    historyRefs: historical.references.length,
    confidence: historical.confidence,
    rawEqual: true as const,
    warning: true as const,
  };
}
```

Create `apps/pseagent/src/coremail-historical-probe-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HISTORICAL_ANSWER_WARNING } from "./contracts.js";
import { validateHistoricalProbe } from
  "./coremail-historical-probe-contract.js";
import { NOT_COVERED_TEXT } from "./response.js";

const historical = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "medium",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史资料原文",
  references: [{
    sourceType: "jira",
    key: "CMHA-1097",
    title: "测试历史记录",
    versions: ["5.0"],
  }],
} as const;
const pseFixture = {
  scope: "professional",
  status: "not_covered",
  answer: NOT_COVERED_TEXT,
  references: [],
  historicalAnswer: historical,
} as const;
const directFixture = {
  answer: "历史资料原文",
  confidence: "medium",
  sources: [{
    source_type: "jira",
    key: "CMHA-1097",
    title: "测试历史记录",
  }],
} as const;

describe("validateHistoricalProbe", () => {
  it("accepts an unchanged sourced historical answer", () => {
    expect(validateHistoricalProbe(pseFixture, directFixture)).toEqual({
      mainRefs: 0,
      historyRefs: 1,
      confidence: "medium",
      rawEqual: true,
      warning: true,
    });
  });

  it.each([
    [
      "rewritten answer",
      { ...pseFixture, historicalAnswer: { ...historical, answer: "changed" } },
      directFixture,
    ],
    [
      "no historical answer",
      { ...pseFixture, historicalAnswer: undefined },
      directFixture,
    ],
    [
      "primary promoted",
      { ...pseFixture, status: "answered" },
      directFixture,
    ],
    [
      "direct result without Jira/Wiki",
      pseFixture,
      {
        ...directFixture,
        sources: [{ source_type: "local", title: "本地记录" }],
      },
    ],
  ])("rejects %s", (_label, pseValue, directValue) => {
    expect(() => validateHistoricalProbe(pseValue, directValue)).toThrow();
  });
});
```

The real script imports this source module through the existing `tsx` loader:

```text
scripts/probe-coremail-historical.mts
  -> apps/pseagent/src/coremail-historical-probe-contract.ts
```

Run the focused offline test:

```powershell
npm exec -w @pseagent/app -- vitest run `
  src/coremail-historical-probe-contract.test.ts
```

Expected: all validator fixture tests pass without starting PSEAgent, Coremail MCP,
a browser, or the network.

- [ ] **Step 8: 构建并运行离线门禁**

Run in platform:

```powershell
npm run typecheck
npm test
npm run build
npm run test:regression
cargo fmt --manifest-path services\knowledge-engine\Cargo.toml -- --check
cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings
git diff --check
```

Expected: all commands exit 0。

- [ ] **Step 9: 运行现有和历史真实探针**

Confirm the release Knowledge Engine is healthy at the fixed revisions recorded in the current runbook, then run:

```powershell
npm run probe:live
npm run probe:coremail
```

Expected:

- existing professional/general/normal/not-covered probes retain their primary status and formal reference rules；
- historical probe reports `status=not_covered`、`main_refs=0`、`history_refs>=1`、`raw_equal=true`、`warning=true`；
- no question, answer, source title, URL, endpoint or credential is printed。

- [ ] **Step 10: 演练关闭、坏路径和非触发场景**

The dependency tests from Tasks 5–6 remain the exact process-start-count proof.
Run all three live probe modes with a process-only mode variable and compare
browser process IDs:

```powershell
$previousMode = [Environment]::GetEnvironmentVariable(
  'PSE_COREMAIL_PROBE_MODE',
  'Process'
)
$browserBefore = @(
  Get-Process -Name msedge,chrome -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id
)
try {
  Remove-Item Env:\PSE_COREMAIL_PROBE_MODE -ErrorAction SilentlyContinue
  npm run probe:coremail

  $env:PSE_COREMAIL_PROBE_MODE = 'broken_path'
  npm run probe:coremail

  $env:PSE_COREMAIL_PROBE_MODE = 'covered'
  npm run probe:coremail
} finally {
  if ($null -eq $previousMode) {
    Remove-Item Env:\PSE_COREMAIL_PROBE_MODE -ErrorAction SilentlyContinue
  } else {
    $env:PSE_COREMAIL_PROBE_MODE = $previousMode
  }
}
$browserAfter = @(
  Get-Process -Name msedge,chrome -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id
)
$newBrowserIds = @($browserAfter | Where-Object { $_ -notin $browserBefore })
if ($newBrowserIds.Count -ne 0) { throw 'noninteractive_browser_started' }
'noninteractive browser_started=false'
```

Do not alter `.env.local`. The probe itself creates and removes the bad path and
covered-query sentinel under the system temporary directory. Expected additional
output:

```text
broken_path startup=true fallback_unchanged=true
covered_query coremail_started=false
noninteractive browser_started=false
```

- [ ] **Step 11: 更新运行手册和脱敏验收记录**

Update `docs/local-runbook.md` with:

- two-repository build commands；
- immutable release and `current` junction structure；
- one-time local `npm run login` checkpoint；
- four PSEAgent Coremail config keys；
- forced no-telemetry/no-cache/non-interactive behavior；
- manual auth renewal procedure；
- fallback behavior and troubleshooting error codes；
- explicit prohibition on registering Coremail knowledge MCP directly in OpenCode；
- existing `coremail_air` remains unrelated and unchanged。

Create `docs/verification/coremail-historical-answer-live-acceptance.md` containing only:

- date；
- full Coremail MCP and platform commit hashes；
- ZIP SHA-256；
- fixed knowledge revisions；
- Node/Cargo/OpenCode/company model names；
- offline command pass counts；
- sanitized existing probe summaries；
- sanitized historical probe summary；
- raw equality、fixed warning、no second model path、no browser、bad path fallback and covered-query lazy-start booleans；
- Knowledge Engine/OpenCode PIDs；
- `.env.local` ignored、cache/telemetry disabled、no remote、no push。

Do not include the live question, answer, Jira/Wiki titles, URLs, endpoint, username, password, Cookie, Token or auth error body.

- [ ] **Step 12: 重启临时 OpenCode 测试入口**

Build first. Resolve and verify the exact current OpenCode PID and command line before stopping only that process tree. Keep Knowledge Engine running. Start:

```powershell
opencode . --agent pseagent --model coremail/deepseek-v4-pro
```

Verify:

```powershell
opencode mcp list
```

Expected:

- `pseagent connected`；
- no direct `coremail-knowledge-mcp` entry；
- existing `coremail_air` remains connected or otherwise unchanged；
- visible OpenCode process uses explicit `pseagent` and company model；
- Knowledge Engine PID and listener remain unchanged。

- [ ] **Step 13: 最终双仓库审计**

Run:

```powershell
git status --short
git remote
git -C ..\coremail-professional status --short
git -C ..\presales-general status --short
git -C ..\coremail-knowledge-mcp status --short
git -C ..\coremail-knowledge-mcp remote
git diff --check
```

Expected:

- platform only has intended Task 7 files plus pre-existing `.sisyphus/`；
- both knowledge repositories are clean and unchanged；
- Coremail MCP source repository is clean；
- all remote outputs are empty；
- no generated release、auth、cache、log or environment file is staged。

- [ ] **Step 14: 提交部署、探针和验收文档**

Run:

```powershell
git add -- package.json scripts/probe-live.mts `
  scripts/probe-coremail-historical.mts `
  apps/pseagent/src/coremail-historical-probe-contract.ts `
  apps/pseagent/src/coremail-historical-probe-contract.test.ts `
  docs/local-runbook.md `
  docs/verification/coremail-historical-answer-live-acceptance.md
git diff --cached --check
git diff --cached --name-only
git commit -m "阶段 27：完成历史资料辅助回答真实验收" `
  -m "完成内容：发布只读 Coremail MCP、增加脱敏探针和运行手册，并恢复 OpenCode 临时测试入口。" `
  -m "验证结果：双仓库离线门禁、公司模型历史回答、原文一致性、无浏览器和失败降级验收全部通过。"
git rev-parse HEAD
```

Expected: 暂存列表只包含上述七个文件；`.env.local`、`.sisyphus` 和外部 release 不进入提交。

- [ ] **Step 15: 报告最终状态**

Report:

- Task 1、3–7 每个 PSEAgent 阶段的完整 commit hash；
- Task 2–3 两个 Coremail MCP commit 的完整 hash；
- 每阶段中文摘要；
- 实际运行的验证命令和通过数量；
- Coremail MCP release hash/current target；
- Knowledge Engine 和 OpenCode PID；
- `coremail_air` 未修改；
- no remote、no push；
- 用户现在可以从 OpenCode 临时入口进行测试。
