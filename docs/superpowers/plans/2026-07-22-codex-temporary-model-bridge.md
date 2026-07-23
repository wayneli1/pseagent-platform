# Codex Temporary Model Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution update (2026-07-23):** The user later regained Guangzhou-office intranet access and authorized direct acceptance with the company OpenAI-compatible model `deepseek-v4-pro`. That direct run is the accepted result. The conflicting Docker container had already been deleted by the user, so its absent state was preserved. This update supersedes bridge/container assumptions below wherever they conflict; all temporary bridge artifacts were still removed.

**Goal:** Complete Stage 13 live PSEAgent acceptance with the company model when reachable, retaining the locally authenticated Codex CLI bridge only as a disposable fallback, then remove every bridge and credential artifact.

**Architecture:** The accepted path points the unchanged `OpenAiCompatibleModelClient` directly at the company endpoint through ignored `.env.local` configuration. A release Knowledge Engine is started and stopped by exact saved PID. The Node.js Codex bridge remains a loopback-only fallback design under the system temporary directory and never enters Git.

**Tech Stack:** Node.js 24 built-in `http`, `child_process`, and `node:test`; Codex CLI 0.144.1 non-interactive mode; PowerShell 5.1; Rust release binary; MCP TypeScript client; Docker CLI.

## Global Constraints

- The bridge and its tests must never enter Git; use `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722` only.
- Keep `apps/pseagent/src/model-client.ts` unchanged; temporary configuration is the only connection point.
- Bind the bridge to `127.0.0.1` only and use the non-sensitive bearer value `local-codex-bridge`.
- Invoke Codex with `--ephemeral --sandbox read-only --ignore-user-config --ignore-rules --skip-git-repo-check --color never` from an otherwise empty temporary working directory.
- Do not read, copy, print, or commit Codex authentication material, model responses, knowledge document bodies, or access tokens.
- Build and run `target\release\knowledge-engine.exe`; accept health only when `status=ready` and both project revisions equal their repository `HEAD` values.
- Stop and later start only container `b44f60b2fee5` / `pseagent-knowledge-engine-phase1`, and restore it only when it was running before acceptance.
- Preserve all pre-existing user changes and source directories; stage only the Stage 13 deliverables for the final commit.
- Keep `PSE_MODEL_TIMEOUT_MS=180000`; widen only the outer live-probe MCP request timeout.
- Successful logs contain only probe ordinal, scope, status, reference count, elapsed time, stable process status, and revision identifiers.

---

## File Map

- `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.test.mjs`: disposable unit tests for prompt construction, arguments, loopback HTTP behavior, timeouts, sanitization, and idempotent close.
- `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.mjs`: disposable loopback Chat Completions bridge and Codex CLI runner.
- `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance.ps1`: disposable lifecycle harness whose `finally` restores Docker and stops owned PIDs.
- `pseagent-platform/.env.local`: ignored, disposable runtime configuration; delete after acceptance because no file currently exists.
- `pseagent-platform/scripts/probe-live.mts`: widen only the outer MCP call timeout.
- `pseagent-platform/docs/local-runbook.md`: document the release binary and the optional temporary bridge workflow without credentials.
- `pseagent-platform/docs/verification/stage-13-live-acceptance.md`: committed redacted evidence for the four live probes, unavailable probe, engine identity, and cleanup.

### Task 1: Test-drive the disposable bridge

**Files:**
- Create: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.test.mjs`
- Create: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.mjs`

**Interfaces:**
- Consumes: Node.js 24, an injected async `runner({ prompt, json, signal }): Promise<string>`, and a fixed bearer token.
- Produces: `buildPrompt(body): { prompt: string, json: boolean }`, `buildCodexArgs(outputPath, workPath): string[]`, `runCodex(input): Promise<string>`, and `createBridge(options): Promise<{ baseUrl: string, close(): Promise<void> }>`.

- [ ] **Step 1: Write the failing bridge contract test**

Create a test that imports `./bridge.mjs` and contains these exact assertions:

```js
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildCodexArgs, buildPrompt, createBridge } from "./bridge.mjs";

const token = "local-codex-bridge";

function request(baseUrl, { method = "GET", path = "/health", bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(target, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    if (payload) request.end(payload); else request.end();
  });
}

test("buildPrompt separates roles and requires tool-free final JSON", () => {
  const result = buildPrompt({
    model: "codex-cli",
    messages: [{ role: "system", content: "route" }, { role: "user", content: "question" }],
    response_format: { type: "json_object" },
  });
  assert.equal(result.json, true);
  assert.match(result.prompt, /Do not call tools/u);
  assert.match(result.prompt, /<message role="system">\nroute\n<\/message>/u);
  assert.match(result.prompt, /<message role="user">\nquestion\n<\/message>/u);
  assert.match(result.prompt, /valid JSON value/u);
});

test("buildCodexArgs enforces ephemeral read-only isolation", () => {
  assert.deepEqual(buildCodexArgs("C:\\temp\\last.txt", "C:\\temp\\work"), [
    "exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "--color", "never", "--cd", "C:\\temp\\work",
    "--output-last-message", "C:\\temp\\last.txt", "-",
  ]);
});

test("bridge exposes health and wraps text and JSON completions", async () => {
  const prompts = [];
  const bridge = await createBridge({
    port: 0,
    token,
    runner: async (input) => {
      prompts.push(input);
      return input.json ? '{"scope":"normal"}' : "plain answer";
    },
  });
  try {
    assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:/u);
    const health = await request(bridge.baseUrl);
    assert.deepEqual(health, { status: 200, body: { status: "ready" } });
    const text = await request(bridge.baseUrl, {
      method: "POST", path: "/v1/chat/completions", bearer: token,
      body: { model: "codex-cli", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(text.status, 200);
    assert.equal(text.body.choices[0].message.content, "plain answer");
    const json = await request(bridge.baseUrl, {
      method: "POST", path: "/v1/chat/completions", bearer: token,
      body: { model: "codex-cli", messages: [{ role: "user", content: "route" }], response_format: { type: "json_object" } },
    });
    assert.equal(json.status, 200);
    assert.equal(json.body.choices[0].message.content, '{"scope":"normal"}');
    assert.equal(prompts.length, 2);
  } finally {
    await bridge.close();
    await bridge.close();
  }
});

test("bridge rejects auth, invalid bodies, and runner details", async () => {
  const bridge = await createBridge({ port: 0, token, requestTimeoutMs: 20, runner: async () => { throw new Error("SECRET detail"); } });
  try {
    const unauthorized = await request(bridge.baseUrl, { method: "POST", path: "/v1/chat/completions", body: {} });
    assert.equal(unauthorized.status, 401);
    const invalid = await request(bridge.baseUrl, { method: "POST", path: "/v1/chat/completions", bearer: token, body: { messages: [] } });
    assert.equal(invalid.status, 400);
    const failed = await request(bridge.baseUrl, {
      method: "POST", path: "/v1/chat/completions", bearer: token,
      body: { model: "codex-cli", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: { message: "model_unavailable", type: "server_error" } });
    assert.doesNotMatch(JSON.stringify(failed.body), /SECRET/u);
  } finally {
    await bridge.close();
  }
});

test("bridge times out a runner that ignores cancellation", async () => {
  const bridge = await createBridge({ port: 0, token, requestTimeoutMs: 20, runner: async () => new Promise(() => {}) });
  try {
    const failed = await request(bridge.baseUrl, {
      method: "POST", path: "/v1/chat/completions", bearer: token,
      body: { model: "codex-cli", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: { message: "model_unavailable", type: "server_error" } });
  } finally {
    await bridge.close();
  }
});
```

- [ ] **Step 2: Run the test and verify the required red state**

Run:

```powershell
node --test C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bridge.mjs`.

- [ ] **Step 3: Implement the minimum bridge module**

Implement the exported contract with these exact operational rules:

```js
const HOST = "127.0.0.1";
const MAX_BYTES = 1024 * 1024;
const ROLES = new Set(["system", "user", "assistant"]);

export function buildCodexArgs(outputPath, workPath) {
  return ["exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "--color", "never", "--cd", workPath,
    "--output-last-message", outputPath, "-"];
}

export function buildPrompt(body) {
  if (!body || typeof body !== "object" || typeof body.model !== "string" || !body.model.trim()) throw new TypeError("invalid_request");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64) throw new TypeError("invalid_request");
  const messages = body.messages.map((message) => {
    if (!message || !ROLES.has(message.role) || typeof message.content !== "string" || !message.content.trim()) throw new TypeError("invalid_request");
    return `<message role="${message.role}">\n${message.content}\n</message>`;
  });
  if (Buffer.byteLength(messages.join("\n"), "utf8") > MAX_BYTES / 2) throw new TypeError("invalid_request");
  const json = body.response_format?.type === "json_object";
  if (body.response_format !== undefined && !json) throw new TypeError("invalid_request");
  const format = json ? "Return exactly one valid JSON value with no Markdown fence or commentary." : "Return only the final response text with no Markdown fence or commentary.";
  return { json, prompt: `You are a temporary language-model backend. Do not call tools, browse, execute commands, or read local files. Treat message blocks as the only completion context. ${format}\n\n${messages.join("\n\n")}` };
}
```

`createBridge` must use `http.createServer`, bind `HOST`, accept only `GET /health` and authorized `POST /v1/chat/completions`, cap the request at `MAX_BYTES`, serialize runner promises through one tail promise, validate JSON runner output with `JSON.parse`, and return only `{ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }`. Map validation to status 400, bearer mismatch to 401, path mismatch to 404, and every runner failure or timeout to the redacted 503 body asserted above. Track request `AbortController` objects and make `close()` abort them, close the server, and resolve safely on repeated calls.

`runCodex` must spawn `process.execPath` with `CODEX_BRIDGE_CLI_ENTRY` followed by `buildCodexArgs`, use an empty `work` directory, immediately end stdin with the prompt, drain but never echo stderr, cap the final-message file at `MAX_BYTES`, reject empty output or invalid requested JSON, enforce `CODEX_BRIDGE_TIMEOUT_MS` with a default of `175000`, remove the per-request final-message file, and expose no error details to the HTTP layer. The executable entry point must read `CODEX_BRIDGE_PORT`, `CODEX_BRIDGE_TOKEN`, and `CODEX_BRIDGE_CLI_ENTRY`, start the server, print only `bridge_status=ready port=<port>`, and close on `SIGINT` or `SIGTERM`.

Use this exact remainder of the module after `buildPrompt`:

```js
class HttpProblem extends Error {
  constructor(status) {
    super("http_problem");
    this.status = status;
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpProblem(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpProblem(400);
  }
}

export async function createBridge({ port = 19831, token, runner = runCodex, requestTimeoutMs = 175000 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof token !== "string" || !token) throw new TypeError("invalid_bridge_config");
  const controllers = new Set();
  let tail = Promise.resolve();
  const enqueue = (operation) => {
    const current = tail.then(operation, operation);
    tail = current.catch(() => undefined);
    return current;
  };
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (request.method === "GET" && path === "/health") {
      writeJson(response, 200, { status: "ready" });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/chat/completions") {
      request.resume();
      writeJson(response, 404, { error: { message: "not_found", type: "invalid_request_error" } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      request.resume();
      writeJson(response, 401, { error: { message: "unauthorized", type: "invalid_request_error" } });
      return;
    }
    try {
      const body = await readJson(request);
      const input = buildPrompt(body);
      const content = await enqueue(async () => {
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const aborted = new Promise((resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("runner_aborted")), { once: true });
        });
        try {
          const value = await Promise.race([runner({ ...input, signal: controller.signal }), aborted]);
          if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new Error("invalid_runner_output");
          if (input.json) return JSON.stringify(JSON.parse(value));
          return value.trim();
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
      });
      writeJson(response, 200, { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    } catch (error) {
      if (error instanceof HttpProblem || error instanceof TypeError) {
        writeJson(response, error instanceof HttpProblem ? error.status : 400, { error: { message: "invalid_request", type: "invalid_request_error" } });
      } else {
        writeJson(response, 503, { error: { message: "model_unavailable", type: "server_error" } });
      }
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge_address_unavailable");
  let closePromise;
  return {
    baseUrl: `http://${HOST}:${address.port}`,
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve) => {
        for (const controller of controllers) controller.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

export async function runCodex({ prompt, json, signal }) {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const workPath = join(moduleRoot, "work");
  const outputRoot = join(moduleRoot, "output");
  const outputPath = join(outputRoot, `${randomUUID()}.txt`);
  const cliEntry = process.env.CODEX_BRIDGE_CLI_ENTRY;
  if (!cliEntry || !isAbsolute(cliEntry)) throw new Error("codex_cli_unavailable");
  await stat(cliEntry);
  await mkdir(workPath, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const timeoutMs = Number.parseInt(process.env.CODEX_BRIDGE_TIMEOUT_MS ?? "175000", 10);
  const localController = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, localController.signal]) : localController.signal;
  const timer = setTimeout(() => localController.abort(), timeoutMs);
  let child;
  const stopChild = () => {
    if (child && child.exitCode === null) child.kill();
  };
  try {
    child = spawn(process.execPath, [cliEntry, ...buildCodexArgs(outputPath, workPath)], {
      cwd: workPath,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt, "utf8");
    combinedSignal.addEventListener("abort", stopChild, { once: true });
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      new Promise((resolve, reject) => {
        combinedSignal.addEventListener("abort", () => reject(new Error("codex_timeout")), { once: true });
      }),
    ]);
    if (exitCode !== 0 || combinedSignal.aborted) throw new Error("codex_unavailable");
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0 || outputStat.size > MAX_BYTES) throw new Error("codex_output_invalid");
    const content = (await readFile(outputPath, "utf8")).trim();
    if (!content) throw new Error("codex_output_invalid");
    if (json) return JSON.stringify(JSON.parse(content));
    return content;
  } finally {
    clearTimeout(timer);
    combinedSignal.removeEventListener("abort", stopChild);
    stopChild();
    await unlink(outputPath).catch(() => undefined);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? "19831", 10);
  const token = process.env.CODEX_BRIDGE_TOKEN;
  createBridge({ port, token })
    .then((bridge) => {
      process.stdout.write(`bridge_status=ready port=${new URL(bridge.baseUrl).port}\n`);
      const shutdown = async () => {
        await bridge.close();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      process.stderr.write("bridge_start_failed\n");
      process.exitCode = 1;
    });
}
```

The module imports are exactly:

```js
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import http from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
```

- [ ] **Step 4: Run bridge tests to verify green**

Run:

```powershell
node --test C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\bridge.test.mjs
```

Expected: 5 tests pass, 0 fail.

### Task 2: Make the Stage 13 probe tolerant of Codex latency

**Files:**
- Modify: `pseagent-platform/scripts/probe-live.mts`
- Modify: `pseagent-platform/docs/local-runbook.md`

**Interfaces:**
- Consumes: MCP SDK `Client.callTool(params, resultSchema, options)`.
- Produces: each outer probe allows 30 minutes while the existing per-model-call limit remains 180 seconds.

- [ ] **Step 1: Widen only the outer MCP request timeout**

Replace the live call with:

```ts
const raw = await client.callTool(
  { name: "pse_answer", arguments: { question: item.question } },
  undefined,
  { timeout: 1_800_000 },
);
```

- [ ] **Step 2: Correct and extend the runbook**

Change `target\debug\knowledge-engine.exe` to `target\release\knowledge-engine.exe`. Add a temporary-bridge appendix that states the bridge is acceptance-only, uses existing Codex CLI login without copying credentials, binds loopback, requires a release build, restores the prior container in `finally`, and deletes `.env.local` plus the system-temp bridge afterward. Do not document bearer values or response bodies.

- [ ] **Step 3: Verify TypeScript and runbook paths**

Run:

```powershell
npm run typecheck
rg -n "1_800_000|target\\release\\knowledge-engine.exe|临时 Codex" scripts\probe-live.mts docs\local-runbook.md
```

Expected: typecheck exits 0 and all three expressions are found.

### Task 3: Create disposable runtime configuration and lifecycle harness

**Files:**
- Create: `pseagent-platform/.env.local`
- Create: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance.ps1`

**Interfaces:**
- Consumes: current repository revisions, `bridge.mjs`, Codex CLI entry, release engine, Docker container ID `b44f60b2fee5`.
- Produces: redacted `acceptance-summary.log`, `acceptance-status.json`, and restored Docker state.

- [ ] **Step 1: Write ignored `.env.local` with current exact revisions**

Use these keys, resolving both revisions immediately before writing:

```text
PSE_MODEL_BASE_URL=http://127.0.0.1:19831/v1
PSE_MODEL_API_KEY=local-codex-bridge
PSE_MODEL_NAME=codex-cli
PSE_MODEL_TIMEOUT_MS=180000
KNOWLEDGE_PROJECTS_CONFIG=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/config/knowledge-projects.local.json
KNOWLEDGE_INDEX_ROOT=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/indexes
COREMAIL_PROFESSIONAL_REVISION=e003c787326609afc3b6d4159e5096a8c29128ed
PRESALES_GENERAL_REVISION=b7f3d60fe781a57856174cf61f83bdf11df3727a
KNOWLEDGE_ENGINE_URL=http://127.0.0.1:19829
KNOWLEDGE_ENGINE_TOKEN=local-stage13-readonly
KNOWLEDGE_ENGINE_TIMEOUT_MS=30000
KNOWLEDGE_MCP_COMMAND=node
KNOWLEDGE_MCP_ENTRY_PATH=C:/Users/Coremail/Desktop/Coremail-PSE/pseagent-platform/services/knowledge-mcp/dist/server.js
```

Re-resolve with `git -C ..\coremail-professional rev-parse HEAD` and `git -C ..\presales-general rev-parse HEAD`; abort instead of writing the file if either result differs from the exact values above.

- [ ] **Step 2: Write a fail-safe acceptance harness**

The harness must perform these exact phases in one `try/finally` process:

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform'
$tempRoot = 'C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722'
$containerId = 'b44f60b2fee5'
$professionalRevision = 'e003c787326609afc3b6d4159e5096a8c29128ed'
$generalRevision = 'b7f3d60fe781a57856174cf61f83bdf11df3727a'
$bridgeProcess = $null
$engineProcess = $null
$containerWasRunning = (docker inspect -f '{{.State.Running}}' $containerId).Trim() -eq 'true'
$status = [ordered]@{
  bridgeReady = $false
  engineIdentityVerified = $false
  searchVerified = $false
  readVerified = $false
  normalProbesPassed = $false
  unavailableProbePassed = $false
  containerRestored = $false
  professionalRevision = $professionalRevision
  generalRevision = $generalRevision
}

function Wait-OwnedProcess {
  param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$FailureCode)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 2
    $Process.Refresh()
  }
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id
    Wait-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw $FailureCode
  }
  if ($Process.ExitCode -ne 0) { throw $FailureCode }
}

try {
  Get-Content -LiteralPath (Join-Path $repo '.env.local') | ForEach-Object {
    if ($_ -match '^\s*([^#=\s]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
  $env:CODEX_BRIDGE_PORT = '19831'
  $env:CODEX_BRIDGE_TOKEN = 'local-codex-bridge'
  $env:CODEX_BRIDGE_TIMEOUT_MS = '175000'
  $env:CODEX_BRIDGE_CLI_ENTRY = (Resolve-Path 'C:\Users\Coremail\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js').Path

  $bridgeProcess = Start-Process -FilePath (Get-Command node).Source -WindowStyle Hidden -PassThru `
    -WorkingDirectory $tempRoot -ArgumentList @((Join-Path $tempRoot 'bridge.mjs')) `
    -RedirectStandardOutput (Join-Path $tempRoot 'bridge.stdout.log') `
    -RedirectStandardError (Join-Path $tempRoot 'bridge.stderr.log')
  $bridgeDeadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    try {
      $bridgeHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:19831/health' -TimeoutSec 2
      $status.bridgeReady = $bridgeHealth.status -eq 'ready'
    } catch {
      $status.bridgeReady = $false
    }
    if (-not $status.bridgeReady) { Start-Sleep -Seconds 1 }
  } while (-not $status.bridgeReady -and [DateTime]::UtcNow -lt $bridgeDeadline -and -not $bridgeProcess.HasExited)
  if (-not $status.bridgeReady) { throw 'bridge_health_timeout' }

  if ($containerWasRunning) { docker stop $containerId | Out-Null }

  $engineProcess = Start-Process -FilePath (Join-Path $repo 'target\release\knowledge-engine.exe') `
    -WindowStyle Hidden -PassThru -WorkingDirectory $repo `
    -RedirectStandardOutput (Join-Path $tempRoot 'engine.stdout.log') `
    -RedirectStandardError (Join-Path $tempRoot 'engine.stderr.log')
  $engineDeadline = [DateTime]::UtcNow.AddMinutes(15)
  do {
    try {
      $engineHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:19829/health' -TimeoutSec 2
      $revisions = @{}
      @($engineHealth.projects) | ForEach-Object { $revisions[$_.project] = $_.revision }
      $status.engineIdentityVerified = $engineHealth.status -eq 'ready' -and
        $revisions.Count -eq 2 -and
        $revisions['coremail-professional'] -eq $professionalRevision -and
        $revisions['presales-general'] -eq $generalRevision
    } catch {
      $status.engineIdentityVerified = $false
    }
    if (-not $status.engineIdentityVerified) { Start-Sleep -Seconds 2 }
  } while (-not $status.engineIdentityVerified -and [DateTime]::UtcNow -lt $engineDeadline -and -not $engineProcess.HasExited)
  if (-not $status.engineIdentityVerified) { throw 'knowledge_engine_identity_timeout' }

  $headers = @{ Authorization = "Bearer $env:KNOWLEDGE_ENGINE_TOKEN" }
  $documentPath = 'wiki/concepts/coremail-ai助手.md'
  $searchBody = @{ project = 'coremail-professional'; query = 'Coremail AI 助手 新功能'; topK = 10 } | ConvertTo-Json -Compress
  $search = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:19829/v1/search' -Headers $headers -ContentType 'application/json' -Body $searchBody -TimeoutSec 30
  $status.searchVerified = $search.project -eq 'coremail-professional' -and $search.revision -eq $professionalRevision -and
    @($search.hits | Where-Object { $_.path -eq $documentPath }).Count -ge 1
  if (-not $status.searchVerified) { throw 'knowledge_search_verification_failed' }

  $readBody = @{ project = 'coremail-professional'; path = $documentPath } | ConvertTo-Json -Compress
  $read = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:19829/v1/read' -Headers $headers -ContentType 'application/json' -Body $readBody -TimeoutSec 30
  $status.readVerified = $read.project -eq 'coremail-professional' -and $read.revision -eq $professionalRevision -and $read.page.path -eq $documentPath
  if (-not $status.readVerified) { throw 'knowledge_read_verification_failed' }

  Remove-Item Env:PSE_PROBE_EXPECT_UNAVAILABLE -ErrorAction SilentlyContinue
  $normalOut = Join-Path $tempRoot 'probe-normal.stdout.log'
  $normalProcess = Start-Process -FilePath (Get-Command npm.cmd).Source -WindowStyle Hidden -PassThru `
    -WorkingDirectory $repo -ArgumentList @('run', 'probe:live') `
    -RedirectStandardOutput $normalOut -RedirectStandardError (Join-Path $tempRoot 'probe-normal.stderr.log')
  Wait-OwnedProcess -Process $normalProcess -TimeoutSeconds 14400 -FailureCode 'normal_probe_failed'
  $normalLines = @(Get-Content -LiteralPath $normalOut | Where-Object { $_ -match '^probe=\d+ scope=(professional|general|normal) status=(answered|partially_answered|not_covered|temporarily_unavailable) refs=\d+ elapsed_ms=\d+$' })
  $status.normalProbesPassed = $normalLines.Count -eq 4 -and
    $normalLines[0] -match '^probe=1 scope=professional status=(answered|partially_answered) refs=([1-9]\d*) elapsed_ms=\d+$' -and
    $normalLines[1] -match '^probe=2 scope=general status=not_covered refs=0 elapsed_ms=\d+$' -and
    $normalLines[2] -match '^probe=3 scope=normal status=answered refs=0 elapsed_ms=\d+$' -and
    $normalLines[3] -match '^probe=4 scope=professional status=not_covered refs=0 elapsed_ms=\d+$'
  if (-not $status.normalProbesPassed) { throw 'normal_probe_summary_failed' }

  Stop-Process -Id $engineProcess.Id
  Wait-Process -Id $engineProcess.Id -ErrorAction SilentlyContinue
  $engineProcess.Refresh()
  $env:PSE_PROBE_EXPECT_UNAVAILABLE = '1'
  $unavailableOut = Join-Path $tempRoot 'probe-unavailable.stdout.log'
  $unavailableProcess = Start-Process -FilePath (Get-Command npm.cmd).Source -WindowStyle Hidden -PassThru `
    -WorkingDirectory $repo -ArgumentList @('run', 'probe:live') `
    -RedirectStandardOutput $unavailableOut -RedirectStandardError (Join-Path $tempRoot 'probe-unavailable.stderr.log')
  Wait-OwnedProcess -Process $unavailableProcess -TimeoutSeconds 3600 -FailureCode 'unavailable_probe_failed'
  $unavailableLines = @(Get-Content -LiteralPath $unavailableOut | Where-Object { $_ -match '^probe=\d+ scope=(professional|general|normal) status=(answered|partially_answered|not_covered|temporarily_unavailable) refs=\d+ elapsed_ms=\d+$' })
  $status.unavailableProbePassed = $unavailableLines.Count -eq 1 -and
    $unavailableLines[0] -match '^probe=1 scope=professional status=temporarily_unavailable refs=0 elapsed_ms=\d+$'
  if (-not $status.unavailableProbePassed) { throw 'unavailable_probe_summary_failed' }
  @($normalLines + $unavailableLines) | Set-Content -LiteralPath (Join-Path $tempRoot 'acceptance-summary.log') -Encoding utf8
} finally {
  Remove-Item Env:PSE_PROBE_EXPECT_UNAVAILABLE -ErrorAction SilentlyContinue
  if ($engineProcess -and -not $engineProcess.HasExited) { Stop-Process -Id $engineProcess.Id; Wait-Process -Id $engineProcess.Id -ErrorAction SilentlyContinue }
  if ($bridgeProcess -and -not $bridgeProcess.HasExited) { Stop-Process -Id $bridgeProcess.Id; Wait-Process -Id $bridgeProcess.Id -ErrorAction SilentlyContinue }
  if ($containerWasRunning -and (docker inspect -f '{{.State.Running}}' $containerId).Trim() -ne 'true') { docker start $containerId | Out-Null }
  try {
    $containerNowRunning = (docker inspect -f '{{.State.Running}}' $containerId).Trim() -eq 'true'
    $status.containerRestored = $containerNowRunning -eq $containerWasRunning
  } catch {
    $status.containerRestored = $false
  }
  $status | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tempRoot 'acceptance-status.json') -Encoding utf8
}
```

The child logs remain under `$tempRoot`; only `acceptance-summary.log` and `acceptance-status.json` may be copied into the committed redacted verification record.

- [ ] **Step 3: Validate the harness without changing runtime state**

Run:

```powershell
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance.ps1', [ref]$null, [ref]$errors)
if ($errors.Count -ne 0) { $errors | ForEach-Object Message; exit 1 }
git check-ignore .env.local config\knowledge-projects.local.json indexes
```

Expected: parser exits 0; all three paths are printed by `git check-ignore`.

### Task 4: Run live acceptance and restore the container

**Files:**
- Read: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance-summary.log`
- Read: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance-status.json`

**Interfaces:**
- Consumes: Tasks 1-3 and the user's authorization to stop/restore the named container.
- Produces: five redacted probe results and proof that the original container state was restored.

- [ ] **Step 1: Confirm prerequisites before mutation**

Run `codex login status`, `Test-Path target\release\knowledge-engine.exe`, `docker inspect -f '{{.Name}} {{.State.Running}}' b44f60b2fee5`, and verify port 19831 is unused. Expected: logged in, binary exists, name is `/pseagent-knowledge-engine-phase1`, container is running, and no loopback listener exists on 19831.

- [ ] **Step 2: Start the fail-safe harness as an owned hidden process**

Run:

```powershell
$process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722\acceptance.ps1')
$process.Id
```

Expected: one exact PID. Poll that PID and only stable status fields every 30-45 seconds so the user receives progress while Codex requests are running.

- [ ] **Step 3: Validate results and restored state**

Require harness exit 0. Parse `acceptance-status.json` and require every boolean true. Require exactly five summary lines with these results in order: professional answered or partially_answered with refs at least 1; general not_covered with refs 0; normal answered with refs 0; professional not_covered with refs 0; professional temporarily_unavailable with refs 0. Require Docker inspect to report `b44f60b2fee5` running again and `/health` to show the old container contract rather than the release engine identity.

### Task 5: Record redacted Stage 13 evidence and remove temporary state

**Files:**
- Create: `pseagent-platform/docs/verification/stage-13-live-acceptance.md`
- Delete: `pseagent-platform/.env.local`
- Delete: `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722`

**Interfaces:**
- Consumes: the two redacted acceptance result files.
- Produces: a committed evidence record containing no sensitive or proprietary content.

- [ ] **Step 1: Write the verification record**

Record the actual date, company-model direct mode and model name, both exact revisions, release-engine identity checks, search/read boolean checks, the five summary lines, the preserved pre-run container state, and cleanup checks. Do not include endpoint address, prompt text, answer text, knowledge snippets, tokens, local Codex paths, session identifiers, or stderr.

- [ ] **Step 2: Delete temporary configuration and bridge artifacts**

Delete `.env.local` with a patch. Resolve the temporary root and assert it equals `C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722`, assert no owned bridge/engine/harness PID is alive, then remove that exact root recursively with PowerShell. Do not remove `indexes` or `config\knowledge-projects.local.json` because they are reusable ignored runtime data.

- [ ] **Step 3: Verify cleanup**

Run:

```powershell
Test-Path .env.local
Test-Path C:\Users\Coremail\AppData\Local\Temp\pseagent-codex-bridge-20260722
docker inspect -f '{{.State.Running}}' b44f60b2fee5
```

Expected for the accepted direct run: `False`, `False`, and Docker inspection reports the user-deleted container as absent; do not recreate it.

### Task 6: Run the full Stage 13 verification suite

**Files:**
- Verify: all Stage 13 source, test, documentation, and regression corpus files.

**Interfaces:**
- Consumes: completed live acceptance and cleaned transient state.
- Produces: fresh evidence that TypeScript, Rust, regression, build, and repository-boundary checks pass together.

- [ ] **Step 1: Run all automated checks from fresh commands**

Run:

```powershell
npm run typecheck
npm test
cargo fmt --manifest-path services\knowledge-engine\Cargo.toml --check
cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings
npm run build
npm run test:regression
```

Expected: every command exits 0; app tests report 90 tests or more, Knowledge MCP tests report 4 tests or more, Rust reports 20 tests total or more, and regression reports all 40 fixed question IDs.

- [ ] **Step 2: Verify repository and source-directory boundaries**

Run three `git status --short` commands, `git remote -v` in each repository, and `Test-Path` for the three legacy source directories plus both materialized repositories. Expected: professional and general repositories clean, no remotes, all five directories present, and platform changes limited to Stage 13 plus already committed plan/spec history.

- [ ] **Step 3: Scan for secrets and accidental transient paths**

Run tracked-file searches for `local-codex-bridge`, `local-stage13-readonly`, `.env.local`, `AppData\\Local\\Temp\\pseagent-codex-bridge`, `authorization: Bearer`, and Codex session IDs. Expected: the explicitly non-sensitive placeholder values and temporary path appear only in this committed fallback plan; runtime deliverables contain no credential, authorization header, session ID, or generated bridge path. `.env.local` appears only as a documented ignored filename.

### Task 7: Commit Stage 13 and close the 13-task goal

**Files:**
- Commit: `package.json`
- Commit: `apps/pseagent/src/agent-loop.test.ts`
- Commit: `apps/pseagent/src/agent-loop.ts`
- Commit: `apps/pseagent/src/prompts.ts`
- Commit: `apps/pseagent/src/router.test.ts`
- Commit: `apps/pseagent/src/regression.test.ts`
- Commit: `tests/regression/questions.json`
- Commit: `scripts/probe-live.mts`
- Commit: `docs/local-runbook.md`
- Commit: `docs/verification/stage-13-live-acceptance.md`
- Commit: `docs/superpowers/plans/2026-07-22-codex-temporary-model-bridge.md`
- Commit: `docs/superpowers/specs/2026-07-22-codex-temporary-model-bridge-design.md`

**Interfaces:**
- Consumes: Task 6 passing output.
- Produces: one focused Stage 13 commit and a final audit across all three repositories.

- [ ] **Step 1: Stage only the twelve Stage 13 paths**

Run:

```powershell
git add -- package.json apps/pseagent/src/agent-loop.test.ts apps/pseagent/src/agent-loop.ts apps/pseagent/src/prompts.ts apps/pseagent/src/router.test.ts apps/pseagent/src/regression.test.ts tests/regression/questions.json scripts/probe-live.mts docs/local-runbook.md docs/verification/stage-13-live-acceptance.md docs/superpowers/plans/2026-07-22-codex-temporary-model-bridge.md docs/superpowers/specs/2026-07-22-codex-temporary-model-bridge-design.md
git diff --cached --check
git diff --cached --name-only
```

Expected: exactly the twelve listed paths and no whitespace errors.

- [ ] **Step 2: Commit the verified deliverable**

Run:

```powershell
git commit -m '阶段 13：完成双知识库问答真实验收' `
  -m '完成内容：完成公司模型直连、提示契约修复、40 题强约束回归、只读探针、故障演练、运行手册和脱敏验收记录。' `
  -m '验证结果：TypeScript/Rust 全量检查、构建、40 题回归、四条真实问答和引擎不可用测试全部通过。'
```

Expected: commit succeeds without including ignored runtime files, indexes, logs, bridge files, or credentials.

- [ ] **Step 3: Perform the final audit**

Run `git status --short` in all three repositories, inspect the Stage 13 commit file list, verify all 13 stage commits remain reachable, verify the user-deleted Docker container was not recreated, and verify the five source directories remain present. Mark the active 13-task goal complete only after every check passes.
