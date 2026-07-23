# PSEAgent Lunkr/OpenClaw Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Windows 电脑上，把专用 Lunkr 账号收到的纯文字消息通过 OpenClaw 转发给现有 PSEAgent `pse_answer`，并把 PSEAgent 最终文本原样回复到原会话。

**Architecture:** 使用 `@coremail/lunkr-openclaw` 提供 Lunkr 登录、消息触发和发送能力；OpenClaw 使用本地 stdio MCP 启动 PSEAgent；独立的 `pseagent` OpenClaw Agent 只能使用探测得到的 PSEAgent 工具，并受专用 `AGENTS.md` 约束。Knowledge Engine 由当前 Windows 用户的登录计划任务常驻，PSEAgent 及其下游 MCP 由 OpenClaw 按需启动。

**Tech Stack:** Windows 11、PowerShell 7/Windows PowerShell、Node.js 24、TypeScript 7、Vitest 4、OpenClaw `2026.7.1-2`、`@coremail/lunkr-openclaw` `1.2.3`、现有 PSEAgent MCP/Knowledge MCP/Rust Knowledge Engine。

## Global Constraints

- 只在 `pseagent-platform` 仓库新增或修改 Lunkr 接入文件。
- `coremail-professional`、`presales-general` 和 `coremail-knowledge-mcp` 保持只读、保持既有 revision，不创建提交。
- 当前主工作树已有用户未提交修改。执行 Task 1 前必须先使用 `superpowers:using-git-worktrees`，从包含本计划的提交创建独立 feature worktree；不得 stash、覆盖或提交当前主工作树的修改。
- 每次只实施一个 Task。顺序固定为：写失败测试 → 运行并确认按预期失败 → 写最小实现 → 运行定向验证和规定回归 → 检查暂存范围 → 创建中文 commit → 报告完整 commit hash、完成内容和验证结果 → 才能进入下一个 Task。
- 每个 commit 标题和正文均使用中文，正文至少包含“完成内容”和“验证结果”。
- 账号密码、二维码、Cookie、SID、token、API key、模型密钥、问题正文、回答正文、会话正文和知识页正文不得进入 Git、测试夹具或日志。
- 不自动覆盖冲突的 OpenClaw、Lunkr 或 Windows 计划任务配置；发现同名但来源不一致时停止。
- 当前家庭网络阶段只完成 Task 1–9。Task 9 提交并报告后必须停止；Task 10–13 等用户回到公司、模型端点可达且可以本机扫码时再执行。
- 不把 mock、dry-run 或离线测试描述为真实 Lunkr/LLM 验收通过。
- 第一版不修改 `apps/pseagent` 的 MCP 对外契约，也不派生 Lunkr 插件。若真实验收稳定复现漏调、重复调用或改写答案，停止发布并另立方案 B 设计。

## Exact File Structure

```text
pseagent-platform/
├─ apps/
│  └─ pseagent/                                  # 保持现有对外契约
├─ integrations/
│  └─ openclaw-lunkr/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ tsconfig.build.json
│     ├─ src/
│     │  ├─ contracts.ts
│     │  ├─ redaction.ts
│     │  ├─ redaction.test.ts
│     │  ├─ process-runner.ts
│     │  ├─ process-runner.test.ts
│     │  ├─ preflight.ts
│     │  ├─ preflight.test.ts
│     │  ├─ openclaw-config.ts
│     │  ├─ openclaw-config.test.ts
│     │  ├─ agent-workspace.ts
│     │  ├─ agent-workspace.test.ts
│     │  ├─ windows-service.ts
│     │  ├─ windows-service.test.ts
│     │  ├─ setup.ts
│     │  ├─ setup.test.ts
│     │  ├─ status.ts
│     │  ├─ status.test.ts
│     │  ├─ verify.ts
│     │  ├─ verify.test.ts
│     │  └─ cli.ts
│     ├─ templates/
│     │  └─ AGENTS.md
│     └─ windows/
│        ├─ run-knowledge-engine.ps1
│        └─ install-knowledge-engine-task.ps1
├─ scripts/
│  ├─ setup-openclaw-lunkr.mts
│  ├─ status-openclaw-lunkr.mts
│  └─ verify-openclaw-lunkr.mts
├─ docs/
│  ├─ local-runbook.md
│  ├─ verification/
│  │  ├─ pseagent-lunkr-openclaw-offline-readiness.md
│  │  └─ pseagent-lunkr-openclaw-live-acceptance.md
│  └─ superpowers/
│     ├─ specs/
│     │  └─ 2026-07-24-pseagent-lunkr-openclaw-integration-design.md
│     └─ plans/
│        └─ 2026-07-24-pseagent-lunkr-openclaw-integration.md
├─ package.json
└─ package-lock.json
```

## Execution Preflight

这部分是 Task 1 之前的执行门禁，不产生代码提交。

- [ ] 在当前主工作树运行 `git status --short`，保存屏幕输出，确认用户已有修改仍存在。
- [ ] 使用 `superpowers:using-git-worktrees` 创建独立 worktree，建议分支名 `feature/lunkr-openclaw-integration`。
- [ ] 在新 worktree 运行 `git rev-parse HEAD`，确认至少包含设计提交 `f80790120372674748281998e014a91666179e38` 和本计划提交。
- [ ] 在四个仓库分别运行 `git status --short` 和 `git rev-parse HEAD`，记录以下只读基线：

```text
coremail-professional  e003c787326609afc3b6d4159e5096a8c29128ed
presales-general       ca4ee0f8fb3c466378371c14bf3394c82a903281
coremail-knowledge-mcp 8422f0da7f729758a69d8f2ebb3627d13d760deb
```

- [ ] 在新 worktree 运行基线验证：

```powershell
npm run typecheck
npm test
npm run build
```

预期：命令退出码均为 `0`。若基线失败，先按 `superpowers:systematic-debugging` 判断是否为既有失败；不得把既有失败混入 Task 1。

---

## Task 1：建立 integration workspace、公共契约和脱敏边界

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `integrations/openclaw-lunkr/package.json`
- Create: `integrations/openclaw-lunkr/tsconfig.json`
- Create: `integrations/openclaw-lunkr/tsconfig.build.json`
- Create: `integrations/openclaw-lunkr/src/contracts.ts`
- Create: `integrations/openclaw-lunkr/src/redaction.ts`
- Test: `integrations/openclaw-lunkr/src/redaction.test.ts`

### Step 1：先写失败测试

- [ ] 为 `redactText` 写 Vitest 用例，覆盖：
  - `Bearer` token；
  - `apiKey`、`token`、`password`、`cookie`、`sid` 的 `key=value` 和 JSON 形式；
  - URL 查询参数；
  - 普通错误码、组件名和状态文本不被误删。

测试契约：

```ts
import { describe, expect, it } from "vitest";
import { redactText } from "./redaction.js";

describe("redactText", () => {
  it("removes credentials without removing operational status", () => {
    const input =
      'status=temporarily_unavailable token="secret" Authorization: Bearer abc.def cookie=session-1';

    const output = redactText(input);

    expect(output).toContain("status=temporarily_unavailable");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("abc.def");
    expect(output).not.toContain("session-1");
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/redaction.test.ts
```

预期：因 workspace 或模块尚未完成而失败；失败原因必须与缺少实现一致。

### Step 2：写最小实现

- [ ] 将 `integrations/openclaw-lunkr` 加入根 `workspaces`。
- [ ] package 名固定为 `@pseagent/openclaw-lunkr`，脚本与现有 workspace 保持一致：

```json
{
  "name": "@pseagent/openclaw-lunkr",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  }
}
```

- [ ] `contracts.ts` 定义后续所有模块共用的唯一类型来源：

```ts
export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

export type CheckState = "ok" | "warning" | "blocked" | "deferred";

export interface CheckResult {
  readonly id: string;
  readonly state: CheckState;
  readonly summary: string;
}

export interface PlannedAction {
  readonly id: string;
  readonly mutates: boolean;
  readonly command: CommandSpec;
}
```

- [ ] `redactText` 只返回脱敏字符串，不记录、不缓存输入。统一替换值为 `[REDACTED]`。
- [ ] TypeScript 配置继承根 `tsconfig.base.json`；构建输出到 `dist`，构建配置排除 `*.test.ts`。
- [ ] 运行 `npm install --package-lock-only` 更新 workspace lock 元数据，不升级无关依赖。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/redaction.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
npm run typecheck
git diff --check
git status --short
```

预期：全部验证退出码为 `0`；`git status` 只出现本 Task 文件。

- [ ] 只暂存本 Task 文件并检查：

```powershell
git add package.json package-lock.json integrations/openclaw-lunkr/package.json integrations/openclaw-lunkr/tsconfig.json integrations/openclaw-lunkr/tsconfig.build.json integrations/openclaw-lunkr/src/contracts.ts integrations/openclaw-lunkr/src/redaction.ts integrations/openclaw-lunkr/src/redaction.test.ts
git diff --cached --stat
git diff --cached --check
```

- [ ] 创建中文提交：

```powershell
git commit -m "Lunkr Task 1：建立接入包与脱敏契约" -m "完成内容：新增 OpenClaw/Lunkr workspace、公共命令契约和敏感信息脱敏测试。" -m "验证结果：定向 Vitest、workspace 类型检查、根类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 2 的条件：commit 成功、完整 hash 已报告、工作树无本 Task 未提交文件。

---

## Task 2：实现无 shell 拼接的命令执行器和 dry-run 记录器

**Files:**

- Create: `integrations/openclaw-lunkr/src/process-runner.ts`
- Test: `integrations/openclaw-lunkr/src/process-runner.test.ts`

### Step 1：先写失败测试

- [ ] 测试以下行为：
  - `RecordingCommandRunner` 记录结构化 `executable`/`args`，不执行进程；
  - `NodeCommandRunner` 分离传递参数，`shell` 必须为 `false`；
  - stdout/stderr 正确收集；
  - 超时返回非零结果且 stderr 只包含脱敏摘要；
  - Windows 子进程使用隐藏窗口。

核心测试：

```ts
it("records a command without executing it", async () => {
  const runner = new RecordingCommandRunner();
  const spec = {
    executable: "openclaw",
    args: ["mcp", "probe", "pseagent", "--json"],
  } as const;

  const result = await runner.run(spec);

  expect(result.exitCode).toBe(0);
  expect(runner.commands).toEqual([spec]);
});
```

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/process-runner.test.ts
```

### Step 2：写最小实现

- [ ] `NodeCommandRunner` 使用 `node:child_process.spawn`：

```ts
const child = spawn(spec.executable, [...spec.args], {
  cwd: spec.cwd,
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

- [ ] 超时只终止当前子进程；不使用 `taskkill /T /F`，不递归清理目录。
- [ ] 捕获 `ENOENT` 并转换为稳定的非零 `CommandResult`，不把异常对象中的环境变量打印出来。
- [ ] `RecordingCommandRunner` 的默认结果为成功，可按 command id 注入预设结果，供后续 setup/status 测试使用。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/process-runner.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
git diff --check
```

- [ ] 暂存并提交：

```powershell
git add integrations/openclaw-lunkr/src/process-runner.ts integrations/openclaw-lunkr/src/process-runner.test.ts
git diff --cached --check
git commit -m "Lunkr Task 2：实现安全命令执行边界" -m "完成内容：新增无 shell 拼接的进程执行器、超时处理和 dry-run 记录器。" -m "验证结果：进程执行定向测试、类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 3 的条件：完整 hash 已报告，且未提前创建 Task 3 文件。

---

## Task 3：实现离线/在线两种 preflight

**Files:**

- Create: `integrations/openclaw-lunkr/src/preflight.ts`
- Test: `integrations/openclaw-lunkr/src/preflight.test.ts`

### Step 1：先写失败测试

- [ ] 使用临时目录和 fake runner 覆盖：
  - Node 版本满足 `>=24.15.0 <25`；
  - OpenClaw 不存在时，offline 模式为 `deferred`，live 模式为 `blocked`；
  - PSEAgent `dist/main.js`、Knowledge Engine release exe、`.env.local`、本地项目配置缺失时报具体 id；
  - `.env.local` 只检查必需 key 是否存在，不读取到报告；
  - Knowledge Engine `/health` 必须 ready 且返回两个固定 revision；
  - 三个只读仓库 revision 不匹配时 blocked；
  - 报告不包含 env 值、token、URL 查询密钥。

预期固定 revision：

```ts
export const EXPECTED_REVISIONS = {
  professional: "e003c787326609afc3b6d4159e5096a8c29128ed",
  general: "ca4ee0f8fb3c466378371c14bf3394c82a903281",
} as const;
```

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/preflight.test.ts
```

### Step 2：写最小实现

- [ ] 导出稳定 API：

```ts
export interface PreflightOptions {
  readonly mode: "offline" | "live";
  readonly projectRoot: string;
  readonly professionalRepo: string;
  readonly generalRepo: string;
  readonly historicalRepo: string;
  readonly runner: CommandRunner;
  readonly fetchHealth: () => Promise<unknown>;
}

export interface PreflightReport {
  readonly checks: readonly CheckResult[];
  readonly canApplyOffline: boolean;
  readonly canRunLiveAcceptance: boolean;
}

export function runPreflight(
  options: PreflightOptions,
): Promise<PreflightReport>;
```

- [ ] 用 `process.versions.node` 检查当前 Node，用 runner 检查 `openclaw --version` 和三个 repo 的 `git rev-parse HEAD`。
- [ ] `.env.local` 解析器只返回 key 集合；报告中不得回显值。
- [ ] `/health` 只保留 `ready`、revision、组件状态；错误先经 `redactText`。
- [ ] historical repo 在本阶段只要求路径存在、Git 干净和执行时记录完整 revision，不新增写操作。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/preflight.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
npm run typecheck
git diff --check
```

- [ ] 提交：

```powershell
git add integrations/openclaw-lunkr/src/preflight.ts integrations/openclaw-lunkr/src/preflight.test.ts
git diff --cached --check
git commit -m "Lunkr Task 3：实现接入前置检查" -m "完成内容：新增离线和在线 preflight，校验版本、构建产物、健康状态与只读知识库 revision。" -m "验证结果：preflight 定向测试、全仓类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 4 的条件：离线缺少 OpenClaw 只产生 deferred，真实联调缺少 OpenClaw 会 blocked；两种模式均有测试证明。

---

## Task 4：实现 OpenClaw MCP、Agent 和绑定的结构化配置计划

**Files:**

- Create: `integrations/openclaw-lunkr/src/openclaw-config.ts`
- Test: `integrations/openclaw-lunkr/src/openclaw-config.test.ts`

### Step 1：先写失败测试

- [ ] 覆盖以下命令计划：
  - 注册 PSEAgent stdio MCP，command 为当前 Node 绝对路径，cwd 为项目绝对路径；
  - 参数为由 `projectRoot` 解析出的绝对 `.env.local` 路径和 `apps/pseagent/dist/main.js`；
  - MCP filter 只保留 `pse_answer`，timeout 为 1800 秒；
  - probe JSON 中只允许一个逻辑工具 `pse_answer`；
  - 解析并返回实际 namespaced tool name；
  - 创建 `pseagent` Agent；
  - 绑定 `lunkr-openclaw:default`；
  - 已存在且匹配时 unchanged；
  - 已存在但 command、cwd、tool filter、workspace 或 binding 不匹配时 conflict，绝不覆盖。

probe 解析测试至少包含：

```ts
const probe = {
  tools: [{ name: "mcp__pseagent__pse_answer" }],
};

expect(parsePseToolName(probe)).toBe("mcp__pseagent__pse_answer");
```

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/openclaw-config.test.ts
```

### Step 2：写最小实现

- [ ] 命令构造函数只返回 `CommandSpec`，不得执行：

```ts
export function buildMcpAddCommand(input: {
  readonly nodeExecutable: string;
  readonly projectRoot: string;
}): CommandSpec;

export function buildMcpProbeCommand(): CommandSpec;
export function buildAgentAddCommand(workspace: string): CommandSpec;
export function buildAgentBindCommand(): CommandSpec;
export function parsePseToolName(value: unknown): string;
```

- [ ] OpenClaw 目标状态固定为：

```text
MCP id: pseagent
Agent id: pseagent
Agent workspace: C:\Users\Coremail\.openclaw\workspace-pseagent
Channel binding: lunkr-openclaw:default
Logical exposed tool: pse_answer
```

- [ ] 执行阶段必须先运行以下帮助命令并把发现的参数差异收敛在此模块；其他模块不得散落 OpenClaw CLI 字符串：

```powershell
openclaw mcp add --help
openclaw mcp probe --help
openclaw agents add --help
openclaw agents bind --help
openclaw config get --help
openclaw config set --help
```

- [ ] `parsePseToolName` 对零个、多个或非 `pse_answer` 工具均抛出稳定错误；不得“取第一个凑合使用”。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/openclaw-config.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
git diff --check
```

- [ ] 提交：

```powershell
git add integrations/openclaw-lunkr/src/openclaw-config.ts integrations/openclaw-lunkr/src/openclaw-config.test.ts
git diff --cached --check
git commit -m "Lunkr Task 4：生成 OpenClaw 受控配置" -m "完成内容：新增 PSEAgent MCP、专用 Agent、工具探测和 Lunkr 账号绑定的结构化配置计划与冲突保护。" -m "验证结果：OpenClaw 配置定向测试、类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 5 的条件：实际工具名只能来自 probe，代码中不存在硬编码 namespaced tool name。

---

## Task 5：生成专用 Agent workspace 和最小工具策略

**Files:**

- Create: `integrations/openclaw-lunkr/templates/AGENTS.md`
- Create: `integrations/openclaw-lunkr/src/agent-workspace.ts`
- Test: `integrations/openclaw-lunkr/src/agent-workspace.test.ts`

### Step 1：先写失败测试

- [ ] 测试生成结果必须包含：
  - probe 得到的实际工具名恰好进入一条允许规则；
  - 每条有效文字消息只调用一次工具；
  - 当前消息映射为 `question`；
  - 仅同 session 最近用户消息和机器人最终答复进入 `conversationContext`；
  - 32 KiB 从最旧消息开始裁剪；
  - 首轮省略 `conversationContext`；
  - 工具成功时原样发送工具文本；
  - 工具失败时固定回复“问答服务暂时不可用，请稍后重试。”；
  - 非文字消息固定回复“当前仅支持文字消息。”；
  - 禁止模型自行回答、总结、润色、补答；
  - 禁止 shell、文件写入、浏览器、其他 MCP、跨 Agent 调用。
- [ ] 测试渲染后的 `AGENTS.md` 不残留内部插值标记。
- [ ] 测试同路径现有文件完全一致时 unchanged，不一致时 conflict，不覆盖。

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/agent-workspace.test.ts
```

### Step 2：写最小实现

- [ ] 模板使用唯一生产插值标记 `__PSE_TOOL_NAME__`；写文件前必须替换并验证标记消失。
- [ ] 导出：

```ts
export function renderAgentInstructions(toolName: string): string;

export function buildAgentToolPolicy(input: {
  readonly agentId: "pseagent";
  readonly toolName: string;
}): Readonly<Record<string, unknown>>;

export function compareWorkspaceFile(
  current: string | undefined,
  desired: string,
): "create" | "unchanged" | "conflict";
```

- [ ] 工具策略默认拒绝，仅允许实际 PSEAgent tool 和 OpenClaw 运行所需的最小内建能力。
- [ ] `AGENTS.md` 不包含公司知识、问题示例、真实账号或模型配置。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/agent-workspace.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
git diff --check
```

- [ ] 提交：

```powershell
git add integrations/openclaw-lunkr/templates/AGENTS.md integrations/openclaw-lunkr/src/agent-workspace.ts integrations/openclaw-lunkr/src/agent-workspace.test.ts
git diff --cached --check
git commit -m "Lunkr Task 5：约束专用问答 Agent" -m "完成内容：新增专用 Agent 指令模板、实际工具名注入、上下文边界和最小工具策略。" -m "验证结果：Agent workspace 定向测试、类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 6 的条件：模板和工具策略测试能证明“只调用一次、原样回复、失败不补答”的配置意图；真实行为留到 Task 12 验收。

---

## Task 6：实现 Knowledge Engine Windows 登录计划任务

**Files:**

- Create: `integrations/openclaw-lunkr/windows/run-knowledge-engine.ps1`
- Create: `integrations/openclaw-lunkr/windows/install-knowledge-engine-task.ps1`
- Create: `integrations/openclaw-lunkr/src/windows-service.ts`
- Test: `integrations/openclaw-lunkr/src/windows-service.test.ts`

### Step 1：先写失败测试

- [ ] 覆盖：
  - 固定任务名 `Coremail-PSE-KnowledgeEngine`；
  - action 使用隐藏的 `powershell.exe` 执行受版本控制的 runner；
  - trigger 为当前 Windows 用户登录；
  - runner 从项目根 `.env.local` 加载环境，并前台执行 release exe；
  - 任务描述中包含项目绝对路径和稳定标记 `managed-by=pseagent-openclaw-lunkr`；
  - 同名任务描述和 action 匹配时 unchanged；
  - 同名非本项目任务为 conflict；
  - dry-run 只返回命令，不调用 `Register-ScheduledTask`；
  - 脚本不打印 `.env.local` 内容。

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/windows-service.test.ts
```

### Step 2：写最小实现

- [ ] `run-knowledge-engine.ps1` 使用 `Resolve-Path -LiteralPath` 验证项目根、env 文件和 exe 均在目标项目内；逐行加载 env 时跳过空行和注释，不输出值。
- [ ] 直接调用：

```powershell
& $engineExecutable
exit $LASTEXITCODE
```

- [ ] 安装脚本先用 `Get-ScheduledTask -TaskName` 读取现状。匹配则退出 `0`；冲突则退出非零且不 unregister。
- [ ] action 使用：

```powershell
New-ScheduledTaskAction `
  -Execute (Get-Command powershell.exe).Source `
  -Argument $runnerArguments
```

- [ ] TypeScript 模块只负责构造查询、安装和状态检查的 `CommandSpec`，所有执行走 `CommandRunner`。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/windows-service.test.ts
npm exec -w @pseagent/openclaw-lunkr -- tsc -p tsconfig.json --noEmit
powershell.exe -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('integrations/openclaw-lunkr/windows/run-knowledge-engine.ps1',[ref]$null,[ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }"
powershell.exe -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('integrations/openclaw-lunkr/windows/install-knowledge-engine-task.ps1',[ref]$null,[ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }"
git diff --check
```

- [ ] 提交：

```powershell
git add integrations/openclaw-lunkr/windows integrations/openclaw-lunkr/src/windows-service.ts integrations/openclaw-lunkr/src/windows-service.test.ts
git diff --cached --check
git commit -m "Lunkr Task 6：管理知识引擎登录启动" -m "完成内容：新增 Knowledge Engine 受控启动脚本、Windows 登录计划任务和同名冲突保护。" -m "验证结果：计划任务定向测试、PowerShell 语法检查、类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 7 的条件：本 Task 仅验证脚本和 dry-run，尚未在真实 Windows 任务计划中创建任务。

---

## Task 7：实现幂等 setup 编排和根命令

**Files:**

- Create: `integrations/openclaw-lunkr/src/setup.ts`
- Create: `integrations/openclaw-lunkr/src/setup.test.ts`
- Create: `integrations/openclaw-lunkr/src/cli.ts`
- Create: `scripts/setup-openclaw-lunkr.mts`
- Modify: `package.json`
- Modify: `package-lock.json`

### Step 1：先写失败测试

- [ ] fake runner 场景覆盖：
  - `--dry-run` 只记录动作，不改变临时文件和系统状态；
  - offline 模式缺少 OpenClaw 时输出 deferred，但仍能验证仓库内产物；
  - apply 顺序为 preflight → MCP 状态 → MCP 注册/校验 → probe → workspace → Agent → tool policy → binding → Windows task；
  - 完全匹配的第二次执行全部 unchanged；
  - 任一 conflict 立即停止，后续 mutation 不执行；
  - 交互式 Lunkr setup/扫码不由离线 setup 伪造；
  - 输出全部经过 `redactText`。

测试中的关键断言：

```ts
expect(result.actions.map((action) => action.id)).toEqual([
  "openclaw.mcp",
  "openclaw.mcp-probe",
  "openclaw.agent-workspace",
  "openclaw.agent",
  "openclaw.tool-policy",
  "openclaw.binding",
  "windows.knowledge-engine-task",
]);
expect(result.deferred).toContain("lunkr.account-login");
```

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/setup.test.ts
```

### Step 2：写最小实现

- [ ] 导出：

```ts
export interface SetupOptions {
  readonly mode: "offline" | "live";
  readonly apply: boolean;
  readonly projectRoot: string;
  readonly runner: CommandRunner;
}

export interface SetupResult {
  readonly checks: readonly CheckResult[];
  readonly actions: readonly PlannedAction[];
  readonly deferred: readonly string[];
  readonly changed: boolean;
}

export function runSetup(options: SetupOptions): Promise<SetupResult>;
```

- [ ] `cli.ts` 支持 `setup --dry-run` 和 `setup --apply`，默认是 `--dry-run`；未明确 `--apply` 不执行系统写操作。
- [ ] 根脚本固定为：

```json
{
  "lunkr:setup": "node --env-file=.env.local --import tsx scripts/setup-openclaw-lunkr.mts"
}
```

- [ ] wrapper 只解析项目根和转发参数，业务逻辑全部在 workspace。
- [ ] setup 不执行 `openclaw lunkr setup`、二维码登录或密码登录；这些是 Task 11 的人工交互。
- [ ] setup 不安装全局 OpenClaw；只给出经版本固定的建议命令。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/setup.test.ts
npm run lunkr:setup -- --dry-run --mode offline
npm run typecheck
git diff --check
```

预期：家庭网络/未安装 OpenClaw 时 dry-run 退出 `0`，明确显示 OpenClaw、Lunkr 登录和真实 LLM 为 deferred；不产生用户目录配置。

- [ ] 提交：

```powershell
git add package.json package-lock.json integrations/openclaw-lunkr/src/setup.ts integrations/openclaw-lunkr/src/setup.test.ts integrations/openclaw-lunkr/src/cli.ts scripts/setup-openclaw-lunkr.mts
git diff --cached --check
git commit -m "Lunkr Task 7：实现幂等接入编排" -m "完成内容：新增 dry-run 默认的 setup 编排、冲突即停策略和根命令入口。" -m "验证结果：setup 定向测试、离线 dry-run、全仓类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 8 的条件：重复 dry-run 结果稳定，真实用户目录、OpenClaw 配置和 Windows 任务均未改变。

---

## Task 8：实现只读 status 和分层 verify

**Files:**

- Create: `integrations/openclaw-lunkr/src/status.ts`
- Create: `integrations/openclaw-lunkr/src/status.test.ts`
- Create: `integrations/openclaw-lunkr/src/verify.ts`
- Create: `integrations/openclaw-lunkr/src/verify.test.ts`
- Create: `scripts/status-openclaw-lunkr.mts`
- Create: `scripts/verify-openclaw-lunkr.mts`
- Modify: `integrations/openclaw-lunkr/src/cli.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

### Step 1：先写失败测试

- [ ] `status` 测试：
  - 始终只读；
  - 检查构建产物、Knowledge Engine health、计划任务、Gateway、MCP、Agent binding、Lunkr agent account；
  - 组件未安装时返回结构化状态而非抛出未处理异常；
  - 不回显账号邮箱、SID 或 session 内容。
- [ ] `verify` 测试：
  - `offline` 运行仓库契约检查和 dry-run；
  - `live` 必须显式传入 `--live`；
  - 未传 `--live` 绝不触发模型、二维码或消息发送；
  - live 前置条件不足时返回 blocked，不改配置。

- [ ] 运行并确认失败：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/status.test.ts src/verify.test.ts
```

### Step 2：写最小实现

- [ ] CLI 入口：

```text
setup  --dry-run|--apply --mode offline|live
status --mode offline|live --json
verify --offline
verify --live
```

- [ ] 根脚本：

```json
{
  "lunkr:status": "node --env-file=.env.local --import tsx scripts/status-openclaw-lunkr.mts",
  "lunkr:verify": "node --env-file=.env.local --import tsx scripts/verify-openclaw-lunkr.mts"
}
```

- [ ] JSON 输出只包含：

```ts
interface SafeStatus {
  readonly component: string;
  readonly state: CheckState;
  readonly code: string;
  readonly durationMs?: number;
}
```

- [ ] 账号字段仅允许 `configured: boolean`、`connected: boolean`、`boundAgentId: "pseagent" | null`，不得输出邮箱或 user id。

### Step 3：验证并提交

- [ ] 运行：

```powershell
npm exec -w @pseagent/openclaw-lunkr -- vitest run src/status.test.ts src/verify.test.ts
npm run lunkr:status -- --mode offline --json
npm run lunkr:verify -- --offline
npm run typecheck
git diff --check
```

- [ ] 提交：

```powershell
git add package.json package-lock.json integrations/openclaw-lunkr/src/cli.ts integrations/openclaw-lunkr/src/status.ts integrations/openclaw-lunkr/src/status.test.ts integrations/openclaw-lunkr/src/verify.ts integrations/openclaw-lunkr/src/verify.test.ts scripts/status-openclaw-lunkr.mts scripts/verify-openclaw-lunkr.mts
git diff --cached --check
git commit -m "Lunkr Task 8：补齐状态与验证命令" -m "完成内容：新增只读 status、显式分层 verify、脱敏 JSON 输出和根命令入口。" -m "验证结果：状态与验证定向测试、离线命令、全仓类型检查和 diff 检查通过。"
git rev-parse HEAD
```

进入 Task 9 的条件：`status` 无写操作，`verify --offline` 不访问真实模型、不扫码、不发 Lunkr 消息。

---

## Task 9：完成离线文档、全量回归和公司联调就绪门禁

**Files:**

- Modify: `docs/local-runbook.md`
- Create: `docs/verification/pseagent-lunkr-openclaw-offline-readiness.md`

### Step 1：先写文档契约测试

- [ ] 在现有文档契约测试方式中增加检查，或用一次性只读命令验证 runbook 必须包含：
  - 组件职责和启动顺序；
  - `npm run lunkr:setup -- --dry-run --mode offline`；
  - Task 10 才能运行的 OpenClaw 安装命令；
  - Lunkr 扫码、Agent Account 绑定、Bot discussion 命令；
  - status/verify；
  - 固定非文字和服务不可用回复；
  - 日志脱敏要求；
  - 安全回滚顺序；
  - 明确声明当前只完成离线阶段。
- [ ] 先运行文档检查并确认因章节尚未添加而失败。

### Step 2：写文档和离线证据

- [ ] 在 runbook 中记录固定版本：

```text
Node.js: 24.15.x
OpenClaw: 2026.7.1-2
@coremail/lunkr-openclaw: 1.2.3
```

- [ ] 记录真实安装/登录命令，但注明 Task 10/11 才执行：

```powershell
npm install --global openclaw@2026.7.1-2
openclaw plugins install @coremail/lunkr-openclaw@1.2.3
openclaw lunkr setup
openclaw lunkr agent-bind --self --agent-id pseagent
openclaw gateway restart
```

- [ ] 记录 Bot discussion 管理：

```powershell
openclaw lunkr bot-create "PSE 问答"
openclaw lunkr bot-list --json
openclaw lunkr bot-delete "PSE 问答"
openclaw lunkr help
```

- [ ] `offline-readiness` 只记录日期、commit、命令、退出码、测试数量、组件状态和 deferred 原因；不得复制测试问题或答案。
- [ ] 明确写入：

```text
离线阶段状态：完成
整体 Lunkr 接入状态：未完成
等待条件：公司内网模型可达、专用 Lunkr 账号本机扫码、真实消息与重启恢复验收
```

### Step 3：全量验证

- [ ] 使用 `superpowers:verification-before-completion`，运行：

```powershell
npm run typecheck
npm test
npm run build
npm run lunkr:setup -- --dry-run --mode offline
npm run lunkr:status -- --mode offline --json
npm run lunkr:verify -- --offline
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
git diff --check
```

- [ ] 检查另外三个仓库：

```powershell
git -C ..\coremail-professional status --short
git -C ..\coremail-professional rev-parse HEAD
git -C ..\presales-general status --short
git -C ..\presales-general rev-parse HEAD
git -C ..\coremail-knowledge-mcp status --short
git -C ..\coremail-knowledge-mcp rev-parse HEAD
```

预期：三个仓库均无新增修改，revision 与执行基线一致。

### Step 4：提交并停止

- [ ] 提交：

```powershell
git add docs/local-runbook.md docs/verification/pseagent-lunkr-openclaw-offline-readiness.md
git diff --cached --check
git commit -m "Lunkr Task 9：完成离线接入就绪验证" -m "完成内容：补充 Windows 运维手册、固定安装与登录流程，并记录脱敏的离线就绪证据。" -m "验证结果：TypeScript 与 Rust 全量测试、构建、lint、离线 dry-run、状态检查和三仓只读核验通过。"
git rev-parse HEAD
git status --short
```

**强制停止点：** 报告 Task 9 完整 hash 后停止。不得在家庭网络继续 Task 10，不得把后续任务标记完成。

---

## Task 10（公司内网延期）：安装 OpenClaw、配置真实模型并应用 PSEAgent 本地接入

**Preconditions:**

- 当前电脑已回到公司内网；
- `.env.local` 的真实模型端点可达；
- 用户明确允许执行本机 OpenClaw 安装和配置；
- Task 1–9 均已有独立 commit；
- 当前 feature worktree 干净。

**Files:**

- Create: `docs/verification/pseagent-lunkr-openclaw-live-acceptance.md`
- Modify only if CLI compatibility requires: `integrations/openclaw-lunkr/src/openclaw-config.ts`
- Test only if code changes: `integrations/openclaw-lunkr/src/openclaw-config.test.ts`

### Step 1：验证公司模型和本地知识服务

- [ ] 运行：

```powershell
npm run probe:live
Invoke-RestMethod -Uri http://127.0.0.1:19829/health -Method Get
```

预期：`probe:live` 退出 `0`；health 为 ready，两个 revision 正确。失败时停止 Task，不安装/登录 Lunkr。

### Step 2：安装固定版本并核对 CLI

- [ ] 运行：

```powershell
npm install --global openclaw@2026.7.1-2
openclaw --version
openclaw onboard --install-daemon
openclaw gateway status
openclaw mcp add --help
openclaw mcp probe --help
openclaw agents add --help
openclaw agents bind --help
```

预期版本为 `2026.7.1-2`。若帮助参数与 Task 4 契约不一致，先写失败测试、修正 `openclaw-config.ts`、跑回归；不直接手工绕过代码。

### Step 3：配置 OpenClaw 模型并应用非账号配置

- [ ] 通过 OpenClaw 官方 onboarding/config 流程配置公司模型。密钥只在本机交互流程输入，不写入计划、终端转录或 Git。
- [ ] 运行：

```powershell
npm run lunkr:setup -- --dry-run --mode live
npm run lunkr:setup -- --apply --mode live
openclaw mcp doctor pseagent --probe
openclaw agents list --bindings
npm run lunkr:status -- --mode live --json
```

预期：PSEAgent MCP probe 只暴露逻辑工具 `pse_answer`；专用 Agent 存在；尚未登录 Lunkr 时账号状态为 deferred/blocked，不伪装 connected。

### Step 4：记录、验证并提交

- [ ] 在 live acceptance 文档记录版本、probe 工具数、binding 目标、状态码和耗时；不记录模型密钥、工具完整输入输出。
- [ ] 运行受影响定向测试和：

```powershell
npm run typecheck
npm test
git diff --check
```

- [ ] 提交：

```powershell
git add docs/verification/pseagent-lunkr-openclaw-live-acceptance.md
# 只有发生 CLI 兼容性修复时，才逐个 git add 本 Task 实际修改的源码和测试文件。
git diff --cached --check
git commit -m "Lunkr Task 10：完成公司环境基础接入" -m "完成内容：安装固定版本 OpenClaw，配置真实模型，并应用和探测 PSEAgent MCP 与专用 Agent。" -m "验证结果：真实模型探针、MCP doctor、Agent binding 状态和全量回归通过。"
git rev-parse HEAD
```

进入 Task 11 的条件：真实模型和 PSEAgent MCP 均可用，Lunkr 尚未登录也不算失败。

---

## Task 11（公司内网延期）：安装 Lunkr 插件、扫码专用账号并绑定 Agent

**Files:**

- Modify: `docs/verification/pseagent-lunkr-openclaw-live-acceptance.md`
- Modify code/tests only when实际 CLI 与已验证契约不一致。

### Step 1：安装插件并扫码

- [ ] 在用户可看到的本机终端执行：

```powershell
openclaw plugins install @coremail/lunkr-openclaw@1.2.3
openclaw lunkr setup
```

- [ ] 用户使用专用机器人账号扫码。不得让用户在聊天中发送密码、Cookie、SID、token 或二维码截图。

### Step 2：把专用账号绑定到 `pseagent`

- [ ] 运行：

```powershell
openclaw lunkr agent-bind --self --agent-id pseagent
openclaw lunkr agent-list
openclaw agents bind --agent pseagent --bind lunkr-openclaw:default
openclaw agents list --bindings
openclaw gateway restart
npm run lunkr:status -- --mode live --json
```

预期：当前 Lunkr 账号已连接、绑定 agent id 为 `pseagent`，OpenClaw channel account binding 指向 `pseagent`。

### Step 3：创建 Bot discussion

- [ ] 运行：

```powershell
openclaw lunkr bot-create "PSE 问答"
openclaw lunkr bot-list --json
```

- [ ] 保存 discussion 的存在状态即可；不把 group id、成员或聊天内容写入 Git。

### Step 4：提交

- [ ] 更新 live acceptance，仅记录：

```text
plugin.version=1.2.3
account.configured=true
account.connected=true
account.boundAgentId=pseagent
channel.binding=lunkr-openclaw:default -> pseagent
botDiscussion.configured=true
```

- [ ] 运行：

```powershell
npm run lunkr:status -- --mode live --json
npm run lunkr:verify -- --offline
git diff --check
```

- [ ] 提交：

```powershell
git add docs/verification/pseagent-lunkr-openclaw-live-acceptance.md
git diff --cached --check
git commit -m "Lunkr Task 11：完成专用账号登录与绑定" -m "完成内容：安装 Lunkr 插件，扫码登录专用账号，绑定 pseagent，并创建受控 Bot discussion。" -m "验证结果：账号连接、Agent binding、Gateway 重启和脱敏状态检查通过。"
git rev-parse HEAD
```

进入 Task 12 的条件：专用账号在线，私聊、普通群和 Bot discussion 三种测试入口已准备好。

---

## Task 12（公司内网延期）：真实文字消息、上下文和故障语义验收

**Files:**

- Modify: `docs/verification/pseagent-lunkr-openclaw-live-acceptance.md`
- Modify code/tests only when验收暴露可修复且仍属于方案 A 的缺陷。

### Step 1：正常路径

- [ ] 使用不含客户敏感信息的内部测试题执行并只记录结构化结果：
  1. 专用账号私聊发送纯文字，不带 `/bot`，应回复；
  2. 同一私聊发送代词追问，应利用同 session 上下文；
  3. 第二个测试用户私聊，不得获得第一个用户上下文；
  4. 普通群不 @ 机器人，不应回复；
  5. 普通群 @ 机器人，应回复；
  6. `[Bot-PSE 问答]` 内不 @，应回复；
  7. 图片、文件、语音各一次，只回复“当前仅支持文字消息。”，不调用 `pse_answer`；
  8. 空白消息不调用 `pse_answer`。

### Step 2：调用次数和原样返回

- [ ] 对每条有效入站消息检查脱敏日志/trace：
  - `pse_answer` 调用次数恰好为 1；
  - OpenClaw 没有调用其他业务工具；
  - 回复文本与 PSEAgent tool result 字节级一致；
  - 不包含 OpenClaw 自行补充的前后缀；
  - session key 在不同私聊和群之间隔离；
  - 上下文未超过 32 KiB。

任一项稳定复现失败：停止 Task 12，不提交“通过”；按设计第 15.3 节评估方案 B。

### Step 3：故障路径

- [ ] 暂时阻断模型端点或使用现有安全故障注入方式，验证：
  - 用户收到 PSEAgent 现有 `temporarily_unavailable` 语义；
  - 外层 Agent 不自行补答；
  - 恢复端点后无需重建 MCP/Agent/Lunkr 配置。
- [ ] 暂时停止 Knowledge Engine，验证专业/通用问答得到既有暂时不可用语义；恢复服务后再次成功。
- [ ] 不通过删除配置、清除 session 或 purge 插件来制造故障。

### Step 4：记录并提交

- [ ] live acceptance 每个场景只记录：

```text
case id
timestamp
session type
expected status
actual status
pse_answer call count
citation count
duration ms
pass/fail
```

- [ ] 运行：

```powershell
npm run lunkr:status -- --mode live --json
npm run lunkr:verify -- --live
npm run typecheck
npm test
git diff --check
```

- [ ] 提交：

```powershell
git add docs/verification/pseagent-lunkr-openclaw-live-acceptance.md
# 若验收产生代码修复，先用 git status --short 列出文件，再逐个 git add 本 Task 实际修改的源码、测试和必要 lockfile；禁止 add 整个目录。
git diff --cached --check
git commit -m "Lunkr Task 12：通过真实消息闭环验收" -m "完成内容：完成私聊、普通群、Bot discussion、多轮隔离、非文字和故障恢复的真实消息验收。" -m "验证结果：每条有效消息单次调用 pse_answer、原样回复、会话隔离、真实 live verify 和全量回归通过。"
git rev-parse HEAD
```

进入 Task 13 的条件：所有真实消息用例均通过；暂存区不包含本机账号/session 文件。

---

## Task 13（公司内网延期）：Windows 重启恢复、最终审计和交付

**Files:**

- Modify: `docs/verification/pseagent-lunkr-openclaw-live-acceptance.md`
- Modify: `docs/local-runbook.md` only if recovery steps need correction.

### Step 1：Gateway 重启恢复

- [ ] 运行：

```powershell
openclaw gateway restart
npm run lunkr:status -- --mode live --json
```

- [ ] 从三个入口各发一条安全测试消息，确认账号、MCP、Agent binding 和 Bot discussion 都无需重建。

### Step 2：Windows 重新登录恢复

- [ ] 保存工作、确保没有未提交内容后，由用户确认执行 Windows 注销/重新登录。
- [ ] 登录后检查：

```powershell
Get-ScheduledTask -TaskName Coremail-PSE-KnowledgeEngine
Invoke-RestMethod -Uri http://127.0.0.1:19829/health -Method Get
openclaw gateway status
npm run lunkr:status -- --mode live --json
```

- [ ] 再发一条真实私聊，确认端到端恢复。

### Step 3：安全和仓库审计

- [ ] 使用 `superpowers:verification-before-completion` 运行：

```powershell
npm run typecheck
npm test
npm run build
npm run lunkr:verify -- --live
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
git grep -n -I -E "(Bearer [A-Za-z0-9._-]+|api[_-]?key[=:]|password[=:]|cookie[=:]|sid[=:])" -- . ":(exclude)package-lock.json"
git diff --check
```

- [ ] 再次核对三个只读仓库状态和 revision 均未改变。
- [ ] 检查 `git status --short`，确认 `.env.local`、`.openclaw`、`.lunkr`、session、二维码、日志和索引未进入 Git。

### Step 4：最终提交

- [ ] 在 live acceptance 写入最终状态和恢复证据，不写消息正文。
- [ ] 提交：

```powershell
git add docs/verification/pseagent-lunkr-openclaw-live-acceptance.md docs/local-runbook.md
git diff --cached --check
git commit -m "Lunkr Task 13：完成重启恢复与最终验收" -m "完成内容：验证 Gateway 重启和 Windows 重新登录后的自动恢复，并完成安全与多仓边界审计。" -m "验证结果：真实端到端消息、全量测试构建、Rust lint、敏感信息扫描和只读仓库核验通过。"
git rev-parse HEAD
git status --short
```

整体完成条件：Task 1–13 各自有独立中文 commit，真实 Lunkr、真实公司 LLM、三种消息入口和两种重启恢复全部通过。未满足任一项时，只报告实际完成阶段。

---

## Task Commit Report Template

每个 Task 完成后，向用户报告：

```text
Task：Lunkr Task N
状态：已完成 / 被阻塞
Commit：完整 40 位 hash
完成内容：中文摘要
验证命令：
- 命令一 → 退出码/测试数量/关键状态
- 命令二 → 退出码/关键状态
仓库边界：pseagent-platform 的本 Task 文件；其他三个仓库未修改
下一步：只有 commit 成功后才进入 Task N+1
```

## Final Acceptance Matrix

| 能力 | 离线证据 | 真实证据 | 完成 Task |
| --- | --- | --- | --- |
| OpenClaw/PSEAgent MCP 配置幂等 | fake runner、dry-run、冲突测试 | `mcp doctor --probe` | 4、7、10 |
| 实际 namespaced tool allowlist | probe parser 测试 | OpenClaw probe 与 Agent policy | 4、5、10 |
| 专用 Lunkr 账号 | 仅状态契约 | 扫码、connected、agent-bind | 8、11 |
| 私聊无需 `/bot` | Agent 指令契约 | 真实私聊 | 5、12 |
| 普通群只在 @ 时触发 | Agent 指令与插件契约 | 真实普通群 | 5、12 |
| Bot discussion 无需 @ | 配置契约 | 真实 Bot discussion | 7、11、12 |
| 每条消息只调用一次 | 指令测试 | trace/call count | 5、12 |
| PSEAgent 文本原样回复 | 指令测试 | tool result/回复比对 | 5、12 |
| 多轮与会话隔离 | 指令和上下文边界测试 | 双用户、群组实测 | 5、12 |
| 仅处理文字 | 固定回复测试 | 图片/文件/语音实测 | 5、12 |
| Knowledge Engine 登录启动 | 脚本与任务冲突测试 | Windows 重新登录 | 6、13 |
| OpenClaw Gateway 恢复 | 状态契约 | Gateway 重启和重新登录 | 8、13 |
| 敏感信息不入库 | redaction 测试和 Git 扫描 | live acceptance 脱敏审计 | 1、9、13 |
