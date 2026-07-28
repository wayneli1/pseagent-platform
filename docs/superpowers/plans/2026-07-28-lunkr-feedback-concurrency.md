# Lunkr 回执、四用户并发与会话重置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机 Windows 的 Lunkr Direct 私聊入口中实现即时问题回执、每用户编号与队列、最多 4 个活跃用户的公平并发、可靠的 `/new` 取消与上下文清理，以及带编号的结构化长回答。

**Architecture:** 保持 Lunkr 只是消息通道、PSEAgent 继续独立负责路由和知识问答。消息规范化层只识别已证明的文本形态；新的 `PeerScheduler` 管理内存态问题编号、epoch、每用户 FIFO 和 4 用户公平调度；Bridge 负责回执、300 秒预算内的一次有界重试、取消门禁和上下文写入；Presenter 在发送前生成不超过 Lunkr 限制且带问题编号的消息段。

**Tech Stack:** Windows PowerShell、Node.js 24、TypeScript 7、Vitest 4、现有 `@pseagent/lunkr-direct`、现有嵌入式 PSEAgent runtime、原生 `AbortController`/`AbortSignal`、Node.js `crypto`。

## Global Constraints

- 只在 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` 的 `feature/lunkr-direct-integration` 分支工作。
- 当前未提交的证据覆盖检索改动属于阶段 44；必须先按原计划验证并单独提交阶段 44，绝不能把这些文件混入本计划的 Lunkr commit。
- 本计划主要修改 `integrations/lunkr-direct`、`scripts/lunkr-start.mts`、`.env.example` 和 Lunkr 运行/验收文档；只允许在 PSEAgent 的 `AnswerService`/embedded runtime 边界增加非公开的重试元数据，不修改路由、规划、检索、回答格式、知识库、Knowledge MCP 或 Knowledge Engine 逻辑。
- 不使用 OpenClaw、OpenCode 或 Lunkr MCP 作为运行时；两个用户提供的 ZIP 仅作为只读协议资料。
- 本机同时执行问题的不同 Lunkr 用户最多为 `4`；同一用户同一时刻最多执行 `1` 题。
- 每个用户最多保留 `5` 道尚未开始的问题；第 6 道等待题不分配编号。
- 问题编号按用户从 `#1` 开始，仅存在于当前 Node.js 进程，进程重启后重置；`/new` 不重置编号。
- `/new` 必须立即增加该用户 epoch、中止当前题、丢弃等待题、清空上下文，并禁止旧 epoch 晚到结果回发或写入上下文。
- 每道题从接收起共享 `300_000 ms` 总预算；只有 embedded runtime 明确返回 `retryable=true` 的临时故障允许在剩余预算内重试一次，最多执行两次 PSEAgent 调用。
- 不增加处理中定时心跳。
- 运行日志不得出现原始 UID、问题、回答、知识正文、密码、验证码、SID、Cookie、Session 或模型密钥。
- `.sisyphus/` 是用户已有未跟踪目录，不读取、不修改、不暂存。
- 未取得用户当次明确许可，不停止或重启正在运行的 Lunkr 和 Knowledge Engine 服务；真实验收需要加载新代码时必须先请求许可。
- 每个阶段先运行列出的验证，再用中文标题和中文正文单独提交；commit 正文必须原样包含“完成内容”和“验证结果”，并向用户报告完整 commit hash。

## File Map

- Create `integrations/lunkr-direct/src/peer-scheduler.ts`: 每用户问题编号、epoch、等待上限、AbortController、4 用户公平轮转和槽位释放。
- Create `integrations/lunkr-direct/src/peer-scheduler.test.ts`: 用可控 Promise 验证串行、4 用户上限、公平、队列上限和取消。
- Create `integrations/lunkr-direct/src/answer-presenter.ts`: 引用排序、来源排序、Markdown 边界分段和问题编号前缀。
- Create `integrations/lunkr-direct/src/answer-presenter.test.ts`: 验证消息长度、段号、列表完整性、来源块和字符顺序。
- Create `integrations/lunkr-direct/src/runtime-log.ts`: 每进程随机盐、UID 哈希和内容无关 JSONL 事件。
- Create `integrations/lunkr-direct/src/runtime-log.test.ts`: 验证日志字段和敏感内容不存在。
- Modify `integrations/lunkr-direct/src/contracts.ts`: 增加严格的 `DirectCommand`，不改变问题正文。
- Modify `integrations/lunkr-direct/src/config.ts`: 增加 `maxActivePeers=4` 与 `maxPendingPerPeer=5`。
- Modify `integrations/lunkr-direct/src/config.test.ts`: 验证默认值、自定义值和非法正整数。
- Modify `integrations/lunkr-direct/src/auth.test.ts`: 为严格配置 fixture 补入两个并发字段。
- Modify `integrations/lunkr-direct/src/bridge.test.ts`: 为严格配置 fixture 补入两个并发字段，后续阶段再扩展行为测试。
- Modify `integrations/lunkr-direct/src/lunkr-api.test.ts`: 为严格配置 fixture 补入两个并发字段。
- Modify `integrations/lunkr-direct/src/message-normalizer.ts`: 在保留原问题文本的同时，通过 NFKC、BOM/零宽字符清理识别精确命令。
- Modify `integrations/lunkr-direct/src/message-normalizer.test.ts`: 增加 `/new` 真实字段、全角斜杠、零宽字符、BOM、首尾空白和非命令反例。
- Delete `integrations/lunkr-direct/src/peer-queue.ts`: 被有界、公平、可取消的 `PeerScheduler` 替代。
- Modify `integrations/lunkr-direct/src/bridge.ts`: 接入 scheduler、即时回执、排队启动提示、`/new`、重试、epoch 门禁、Presenter 和结构化事件。
- Modify `integrations/lunkr-direct/src/bridge.test.ts`: 覆盖全部用户可见协议、取消、重试、失败、去重和上下文隔离。
- Modify `integrations/lunkr-direct/src/lunkr-api.ts`: 保留 API 级安全兜底分段，但让 Bridge 发送的已编号段不被二次拆分。
- Modify `integrations/lunkr-direct/src/lunkr-api.test.ts`: 验证单段精确发送和兜底分段。
- Modify `integrations/lunkr-direct/src/index.ts`: 导出 scheduler、presenter 和 runtime logger。
- Modify `apps/pseagent/src/diagnostics.ts`: 复用现有内容无关 stop reason 类型，不增加正文日志。
- Modify `apps/pseagent/src/answer-service.ts`: 增加只供 embedded runtime 使用的 `answerDetailed()` 与重试判定。
- Modify `apps/pseagent/src/answer-service.test.ts`: 验证模型临时不可用可重试、稳定契约错误不可重试。
- Modify `apps/pseagent/src/main.ts`: 在保持 MCP `answer()` 不变的前提下导出 `answerDetailed()`。
- Modify `apps/pseagent/src/embedded.ts`: 只向嵌入式调用方导出详细结果类型。
- Modify `scripts/lunkr-start.mts`: 传递 AbortSignal、结果元数据、结构化日志和两个并发配置。
- Modify `.env.example`: 记录 `LUNKR_MAX_ACTIVE_PEERS=4`、`LUNKR_MAX_PENDING_PER_PEER=5`。
- Modify `docs/local-runbook.md`: 更新回执、队列、`/new` 和 Windows 前台验收步骤。
- Create `docs/verification/pseagent-lunkr-feedback-concurrency-acceptance.md`: 只记录无正文的自动化与真实验收证据。

---

### Task 1: 阶段 45——冻结已确认设计与实施边界

**Files:**
- Create: `docs/superpowers/specs/2026-07-28-lunkr-feedback-concurrency-design.md`
- Create: `docs/superpowers/plans/2026-07-28-lunkr-feedback-concurrency.md`

**Interfaces:**
- Consumes: 已确认设计中的固定话术、4 用户上限、5 道等待上限、300 秒预算和 `/new` 语义。
- Produces: 后续阶段唯一允许使用的设计规格和逐步实施计划。

- [ ] **Step 1: 确认阶段 44 已独立完成**

Run:

```powershell
git log -1 --pretty=format:"%H%n%s%n%b"
git status --short
```

Expected: 最新提交是已经验证的阶段 44；工作区不再包含阶段 44 的 PSEAgent/Knowledge Engine 源码修改，只允许保留本计划两份文档与用户的 `.sisyphus/`。

- [ ] **Step 2: 检查规格和计划没有占位符、秘密或越界文件**

Run:

```powershell
rg -n "T[B]D|T[O]DO|F[I]XME|待[定]|以后实[现]" docs/superpowers/specs/2026-07-28-lunkr-feedback-concurrency-design.md docs/superpowers/plans/2026-07-28-lunkr-feedback-concurrency.md
rg -n -i "@coremail\.cn|Coremail\+[0-9]{4}|qwe[0-9]{6}|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}" docs/superpowers/specs/2026-07-28-lunkr-feedback-concurrency-design.md docs/superpowers/plans/2026-07-28-lunkr-feedback-concurrency.md
git diff --check -- docs/superpowers/specs/2026-07-28-lunkr-feedback-concurrency-design.md docs/superpowers/plans/2026-07-28-lunkr-feedback-concurrency.md
```

Expected: 两次 `rg` 都无匹配；`git diff --check` 退出码为 0。

- [ ] **Step 3: 只暂存两份文档并核对 staged diff**

Run:

```powershell
git add -- docs/superpowers/specs/2026-07-28-lunkr-feedback-concurrency-design.md docs/superpowers/plans/2026-07-28-lunkr-feedback-concurrency.md
git diff --cached --name-only
```

Expected: 只列出上述两个路径。

- [ ] **Step 4: 提交阶段 45**

Run:

```powershell
git commit -m "阶段 45：冻结 Lunkr 回执与并发设计" -m "完成内容：确认即时回执、每用户编号、四用户公平并发、每用户五题等待上限、会话 epoch、/new 取消语义、长回答呈现和隐私日志边界。`n`n验证结果：文档占位符与敏感信息扫描无匹配，git diff --check 通过，暂存范围仅包含设计规格和实施计划。"
```

Expected: commit 成功，正文包含“完成内容”和“验证结果”。

---

### Task 2: 阶段 46——配置与精确命令规范化

**Files:**
- Modify: `integrations/lunkr-direct/src/config.ts`
- Modify: `integrations/lunkr-direct/src/config.test.ts`
- Modify: `integrations/lunkr-direct/src/contracts.ts`
- Modify: `integrations/lunkr-direct/src/message-normalizer.ts`
- Modify: `integrations/lunkr-direct/src/message-normalizer.test.ts`
- Modify: `integrations/lunkr-direct/src/auth.test.ts`
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Modify: `integrations/lunkr-direct/src/lunkr-api.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `normalizeDirectMessage(event, selfUid, now)` 和现有 `LunkrDirectMessage`。
- Produces: `LunkrDirectConfig.maxActivePeers: number`、`maxPendingPerPeer: number`；`LunkrDirectMessage.command?: "help" | "new"`。

- [ ] **Step 1: 写配置失败测试**

在 `config.test.ts` 的默认值测试中增加：

```ts
expect(config.maxActivePeers).toBe(4);
expect(config.maxPendingPerPeer).toBe(5);
```

并增加：

```ts
it("loads positive peer concurrency limits", () => {
  expect(loadLunkrConfig({
    LUNKR_MAX_ACTIVE_PEERS: "3",
    LUNKR_MAX_PENDING_PER_PEER: "7",
  })).toMatchObject({
    maxActivePeers: 3,
    maxPendingPerPeer: 7,
  });
  expect(() => loadLunkrConfig({ LUNKR_MAX_ACTIVE_PEERS: "0" }))
    .toThrow("正整数");
  expect(() => loadLunkrConfig({ LUNKR_MAX_PENDING_PER_PEER: "-1" }))
    .toThrow("正整数");
});
```

- [ ] **Step 2: 运行配置测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/config.test.ts
```

Expected: FAIL，提示 `maxActivePeers`/`maxPendingPerPeer` 不存在或值不是预期值。

- [ ] **Step 3: 增加两个配置字段**

在 `LunkrDirectConfig` 中增加：

```ts
readonly maxActivePeers: number;
readonly maxPendingPerPeer: number;
```

在 `loadLunkrConfig()` 返回值中增加：

```ts
maxActivePeers: positiveInteger(env, "LUNKR_MAX_ACTIVE_PEERS", 4),
maxPendingPerPeer: positiveInteger(env, "LUNKR_MAX_PENDING_PER_PEER", 5),
```

在 `.env.example` 的 Lunkr 配置区增加：

```dotenv
LUNKR_MAX_ACTIVE_PEERS=4
LUNKR_MAX_PENDING_PER_PEER=5
```

在 `auth.test.ts`、`bridge.test.ts` 和 `lunkr-api.test.ts` 所有声明为
`LunkrDirectConfig` 的固定配置对象中增加：

```ts
maxActivePeers: 4,
maxPendingPerPeer: 5,
```

- [ ] **Step 4: 写命令规范化失败测试**

在 `message-normalizer.test.ts` 增加参数化测试，命令仅由 `command` 字段表达，`text` 仍保留清理首尾空白后的原始正文：

```ts
it.each([
  ["/new", "new"],
  ["  /new  ", "new"],
  ["\uFEFF/new", "new"],
  ["/\u200Bnew", "new"],
  ["／new", "new"],
  ["/help", "help"],
] as const)("recognizes exact normalized command %j", (subject, command) => {
  expect(normalizeDirectMessage({
    topic: "inbox",
    payload: {
      msgId: `command-${command}-${subject.length}`,
      sourceId: "#peer#U",
      from: { uid: "#peer#U" },
      subject,
    },
  }, "#bot#U")).toMatchObject({ command });
});

it.each(["/new 请继续", "前缀/new", "/newer", "```/new```"])(
  "does not widen command matching for %j",
  (subject) => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: `ordinary-${subject}`,
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        subject,
      },
    }, "#bot#U")).not.toHaveProperty("command");
  },
);
```

资料包只证明 `payload` 是 JSON 字符串且正文可位于 `content`；再增加一例：

```ts
it("recognizes /new from the documented string payload content field", () => {
  expect(normalizeDirectMessage({
    topic: "inbox",
    payload: JSON.stringify({
      msgId: "documented-new",
      sourceId: "#peer#U",
      from: "#peer#U",
      content: "/new",
    }),
  }, "#bot#U")).toMatchObject({ command: "new" });
});
```

- [ ] **Step 5: 运行规范化测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/message-normalizer.test.ts
```

Expected: FAIL，现有消息没有 `command` 字段。

- [ ] **Step 6: 实现窄范围命令识别**

在 `contracts.ts` 增加：

```ts
export type DirectCommand = "help" | "new";
```

并在 `LunkrDirectMessage` 中增加：

```ts
readonly command?: DirectCommand;
```

在 `message-normalizer.ts` 增加：

```ts
const INVISIBLE_COMMAND_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;

export function recognizeDirectCommand(text: string): DirectCommand | undefined {
  const normalized = text
    .normalize("NFKC")
    .replace(INVISIBLE_COMMAND_CHARACTERS, "")
    .trim();
  if (normalized === "/new") return "new";
  if (normalized === "/help") return "help";
  return undefined;
}
```

构造返回消息时只在识别成功时加入：

```ts
const command = recognizeDirectCommand(text);
return {
  id,
  peerUid,
  senderUid,
  timestamp,
  text: text.trim(),
  hasAttachments,
  ...(command === undefined ? {} : { command }),
};
```

不要增加 HTML/Markdown 剥离，不递归猜测未知富文本对象。若真实验收仍失败，只记录正文来源字段、值类型、长度以及 `NFKC/零宽字符` 布尔变化，再补一条精确 fixture。

- [ ] **Step 7: 验证并提交阶段 46**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/config.test.ts src/message-normalizer.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
git diff --check -- .env.example integrations/lunkr-direct/src/config.ts integrations/lunkr-direct/src/config.test.ts integrations/lunkr-direct/src/contracts.ts integrations/lunkr-direct/src/message-normalizer.ts integrations/lunkr-direct/src/message-normalizer.test.ts integrations/lunkr-direct/src/auth.test.ts integrations/lunkr-direct/src/bridge.test.ts integrations/lunkr-direct/src/lunkr-api.test.ts
git add -- .env.example integrations/lunkr-direct/src/config.ts integrations/lunkr-direct/src/config.test.ts integrations/lunkr-direct/src/contracts.ts integrations/lunkr-direct/src/message-normalizer.ts integrations/lunkr-direct/src/message-normalizer.test.ts integrations/lunkr-direct/src/auth.test.ts integrations/lunkr-direct/src/bridge.test.ts integrations/lunkr-direct/src/lunkr-api.test.ts
git diff --cached --name-only
```

Expected: 测试和 typecheck 通过；staged diff 只包含本任务文件。

Run:

```powershell
git commit -m "阶段 46：增加 Lunkr 并发配置与命令规范化" -m "完成内容：新增四用户并发和每用户五题等待配置，并以 NFKC、BOM 与零宽字符清理实现 /new、/help 的精确命令识别。`n`n验证结果：Lunkr config 与 message normalizer 测试通过，TypeScript 类型检查通过，git diff --check 通过。"
```

---

### Task 3: 阶段 47——可取消的四用户公平调度器

**Files:**
- Create: `integrations/lunkr-direct/src/peer-scheduler.ts`
- Create: `integrations/lunkr-direct/src/peer-scheduler.test.ts`
- Modify: `integrations/lunkr-direct/src/index.ts`

**Interfaces:**
- Consumes: `maxActivePeers`、`maxPendingPerPeer`。
- Produces:

```ts
export type AdmissionKind =
  | "started"
  | "peer_queued"
  | "global_queued"
  | "peer_full";

export interface QuestionStart {
  readonly peerUid: string;
  readonly questionId: number;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly startedFromQueue: boolean;
}

export interface AdmissionReceipt {
  readonly kind: AdmissionKind;
  readonly questionId?: number;
  readonly epoch: number;
  readonly ahead: number;
  readonly completion: Promise<void>;
}

export interface QuestionCallbacks {
  readonly accept: (receipt: Omit<AdmissionReceipt, "completion">) => Promise<void>;
  readonly work: (start: QuestionStart) => Promise<void>;
}

export interface PeerResetResult {
  readonly epoch: number;
  readonly activeCancelled: boolean;
  readonly pendingCancelled: number;
}
```

`PeerScheduler.submit(peerUid, callbacks)` 先保留 admission 并返回 receipt；只有 `callbacks.accept()` 成功后才允许调用 `callbacks.work()`。`reset(peerUid)` 增加 epoch、abort 活动题并删除等待题；`isCurrent(peerUid, epoch)` 为 Bridge 的晚到结果门禁。
Scheduler 还必须提供只读的 `activePeerCount: number`，供 Bridge 生成内容无关事件。

- [ ] **Step 1: 写同用户串行和 4 用户上限失败测试**

在新建的 `peer-scheduler.test.ts` 中使用 `deferred()` 控制完成顺序：

```ts
it("runs at most four distinct peers and serializes each peer", async () => {
  const scheduler = new PeerScheduler(4, 5);
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  const submit = (peerUid: string, label: string) =>
    scheduler.submit(peerUid, {
      accept: async () => undefined,
      work: async () => {
        started.push(label);
        const gate = deferred();
        gates.set(label, gate);
        await gate.promise;
      },
    });

  const a1 = submit("a", "a1");
  const a2 = submit("a", "a2");
  const b1 = submit("b", "b1");
  const c1 = submit("c", "c1");
  const d1 = submit("d", "d1");
  const e1 = submit("e", "e1");

  await vi.waitFor(() => expect(started).toEqual(
    expect.arrayContaining(["a1", "b1", "c1", "d1"]),
  ));
  expect(started).not.toContain("a2");
  expect(started).not.toContain("e1");
  expect(a1.kind).toBe("started");
  expect(a2).toMatchObject({ kind: "peer_queued", ahead: 1 });
  expect(e1.kind).toBe("global_queued");
});
```

- [ ] **Step 2: 写公平轮转、等待上限和释放失败测试**

增加三类断言：

```ts
it("moves a peer with remaining work behind other waiting peers", async () => {
  // a1、b1 占满两个槽；a2 在 a 后，c1 在全局等待。
  // 释放 a1 后必须先开始 c1；a2 只能在下一次释放后开始。
});

it("rejects the sixth pending question without allocating an id", () => {
  // 活动题 1 道、等待题 5 道后再 submit。
  // receipt.kind === "peer_full"，questionId === undefined。
});

it.each(["success", "failure", "abort"] as const)(
  "releases the peer slot after %s",
  async (ending) => {
    // work resolve、throw 或被 reset abort 后，等待用户均可开始。
  },
);
```

具体编号断言：

```ts
expect(receipts.slice(0, 6).map((receipt) => receipt.questionId))
  .toEqual([1, 2, 3, 4, 5, 6]);
expect(rejected.questionId).toBeUndefined();
expect(scheduler.submit("a", {
  accept: async () => undefined,
  work: async () => undefined,
}).questionId).toBe(7);
```

- [ ] **Step 3: 写 `/new` epoch 与取消失败测试**

```ts
it("increments epoch, aborts active work, drops pending work, and keeps numbering", async () => {
  const scheduler = new PeerScheduler(1, 5);
  let activeSignal!: AbortSignal;
  const active = scheduler.submit("a", {
    accept: async () => undefined,
    work: async ({ signal }) => {
      activeSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  const pending = scheduler.submit("a", {
    accept: async () => undefined,
    work: async () => {
      throw new Error("pending work must not run");
    },
  });
  await vi.waitFor(() => expect(activeSignal).toBeInstanceOf(AbortSignal));

  expect(scheduler.reset("a")).toEqual({
    epoch: 1,
    activeCancelled: true,
    pendingCancelled: 1,
  });
  expect(activeSignal.aborted).toBe(true);
  await expect(Promise.all([active.completion, pending.completion]))
    .resolves.toEqual([undefined, undefined]);

  const next = scheduler.submit("a", {
    accept: async () => undefined,
    work: async () => undefined,
  });
  expect(next).toMatchObject({ questionId: 3, epoch: 1 });
});
```

再增加 admission 回执失败测试：

```ts
it("never starts work when acceptance delivery fails", async () => {
  const work = vi.fn(async () => undefined);
  const receipt = new PeerScheduler(1, 5).submit("a", {
    accept: async () => {
      throw new Error("ack send failed");
    },
    work,
  });
  await expect(receipt.completion).rejects.toThrow("ack send failed");
  expect(work).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: 运行新测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/peer-scheduler.test.ts
```

Expected: FAIL，`peer-scheduler.ts` 尚不存在。

- [ ] **Step 5: 实现 scheduler 状态和入队结果**

在 `peer-scheduler.ts` 使用以下状态，不把问题正文保存到 scheduler：

```ts
interface ScheduledQuestion {
  readonly questionId: number;
  readonly epoch: number;
  readonly callbacks: QuestionCallbacks;
  readonly completion: Deferred<void>;
  accepted: boolean;
}

interface PeerState {
  nextQuestionId: number;
  epoch: number;
  active?: {
    readonly question: ScheduledQuestion;
    readonly controller: AbortController;
  };
  readonly pending: ScheduledQuestion[];
  readyQueued: boolean;
}
```

`submit()` 的关键规则：

```ts
if (state.pending.length >= maxPendingPerPeer) {
  return peerFullReceipt(state.epoch);
}
const questionId = state.nextQuestionId++;
const ahead = (state.active === undefined ? 0 : 1) + state.pending.length;
// 新用户且有空槽 -> started；同用户已有工作 -> peer_queued；
// 新用户但 4 个活跃用户已满 -> global_queued。
```

`submit()` 构造 receipt 后在微任务中调用 `callbacks.accept()`。只有 accept resolve
才把题目标记为 `accepted=true` 并调用 `drain()`；accept reject 必须删除该题、
释放其预留槽位、继续调度其他用户，并让 `receipt.completion` reject。

`drain()` 只从 `readyPeers` 头部取用户；每次只启动该用户一题。题目 `finally` 后：

```ts
this.activePeers.delete(peerUid);
state.active = undefined;
if (state.pending.length > 0) this.enqueueReadyPeer(peerUid, state);
this.drain();
```

无论 work resolve、reject 或 abort 都必须在 `finally` 释放槽位。work 的 rejection
原样传给 `completion`，由 Socket 事件入口的现有 `.catch()` 记录脱敏失败；被
`reset()` 删除且从未开始的 pending completion 直接 resolve。

- [ ] **Step 6: 实现 reset 与晚到结果门禁**

`reset(peerUid)` 必须按原子顺序：

```ts
state.epoch += 1;
state.active?.controller.abort("lunkr_new_session");
const pendingCancelled = state.pending.length;
for (const question of state.pending.splice(0)) {
  question.completion.resolve();
}
removePeerFromReadyQueue(peerUid);
return {
  epoch: state.epoch,
  activeCancelled: state.active !== undefined,
  pendingCancelled,
};
```

活动题 abort 后仍占用真实槽位，直到其 Promise settle，避免底层取消尚未生效时实际并发超过 4。`isCurrent(peerUid, epoch)` 只比较当前 state epoch。

- [ ] **Step 7: 替换导出并删除旧 PeerQueue**

从 `index.ts` 删除：

```ts
export * from "./peer-queue.js";
```

增加：

```ts
export * from "./peer-scheduler.js";
```

本阶段保留 `peer-queue.ts` 供尚未迁移的 Bridge 使用；Task 6 在 Bridge 切换到
`PeerScheduler` 后删除旧文件。不要创建把两种接口伪装成同一类型的兼容层。

- [ ] **Step 8: 验证并提交阶段 47**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/peer-scheduler.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
git diff --check -- integrations/lunkr-direct/src/peer-scheduler.ts integrations/lunkr-direct/src/peer-scheduler.test.ts integrations/lunkr-direct/src/index.ts
git add -- integrations/lunkr-direct/src/peer-scheduler.ts integrations/lunkr-direct/src/peer-scheduler.test.ts integrations/lunkr-direct/src/index.ts
git diff --cached --name-only
```

Expected: scheduler 测试和 typecheck 通过；staged diff 不含 Bridge 或 PSEAgent 文件。

Run:

```powershell
git commit -m "阶段 47：实现 Lunkr 四用户公平调度" -m "完成内容：实现每用户编号、同用户串行、最多四个活跃用户、公平轮转、五题等待上限、epoch 取消和可靠槽位释放。`n`n验证结果：PeerScheduler 单元测试通过，Lunkr Direct TypeScript 类型检查通过，git diff --check 通过。"
```

---

### Task 4: 阶段 48——带编号的结构化长回答呈现

**Files:**
- Create: `integrations/lunkr-direct/src/answer-presenter.ts`
- Create: `integrations/lunkr-direct/src/answer-presenter.test.ts`
- Modify: `integrations/lunkr-direct/src/lunkr-api.ts`
- Modify: `integrations/lunkr-direct/src/lunkr-api.test.ts`
- Modify: `integrations/lunkr-direct/src/index.ts`

**Interfaces:**
- Consumes: 格式化后的完整 PSEAgent 文本、`questionId`、`messageMaxChars`。
- Produces:

```ts
export function normalizeCitationOrder(text: string): string;
export function presentAnswer(
  questionId: number,
  answer: string,
  maxChars: number,
): string[];
```

- [ ] **Step 1: 写单段和多段前缀失败测试**

```ts
it("prefixes a short answer with its question id", () => {
  expect(presentAnswer(13, "简短回答", 1_000)).toEqual([
    "问题 #13 的回答：\n\n简短回答",
  ]);
});

it("labels every long-answer chunk with the same id and total count", () => {
  const chunks = presentAnswer(13, [
    "第一段。".repeat(60),
    "",
    "第二段。".repeat(60),
  ].join("\n"), 180);
  expect(chunks.length).toBeGreaterThan(1);
  chunks.forEach((chunk, index) => {
    expect(chunk.startsWith(`问题 #13（${index + 1}/${chunks.length}）\n\n`))
      .toBe(true);
    expect(chunk.length).toBeLessThanOrEqual(180);
  });
});
```

- [ ] **Step 2: 写 Markdown、来源和引用排序失败测试**

```ts
it("does not split a normal markdown list item", () => {
  const answer = [
    "建议：",
    "",
    "1. 第一项包含完整说明。",
    "2. 第二项包含完整说明。",
    "3. 第三项包含完整说明。",
  ].join("\n");
  const chunks = presentAnswer(2, answer, 55);
  expect(chunks.join("\n")).not.toMatch(/\n问题 #2（\d+\/\d+）\n\n项/u);
});

it("sorts adjacent citations and source entries without renumbering", () => {
  const answer = [
    "结论 [2][1][2]。",
    "",
    "资料来源：",
    "[2] 第二来源 — presales-general/b.md",
    "[1] 第一来源 — presales-general/a.md",
  ].join("\n");
  const rendered = presentAnswer(7, answer, 1_000).join("\n");
  expect(rendered).toContain("结论 [1][2]。");
  expect(rendered.indexOf("[1] 第一来源"))
    .toBeLessThan(rendered.indexOf("[2] 第二来源"));
});

it("preserves body character order after removing only presentation prefixes", () => {
  const answer = "甲段。\n\n乙段。\n\n资料来源：\n[1] 来源";
  const chunks = presentAnswer(9, answer, 30);
  const reconstructed = chunks
    .map((chunk) => chunk.replace(/^问题 #9（\d+\/\d+）\n\n/u, ""))
    .join("\n\n");
  expect(reconstructed.replace(/\n+/gu, "\n"))
    .toBe(normalizeCitationOrder(answer).replace(/\n+/gu, "\n"));
});
```

- [ ] **Step 3: 运行 Presenter 测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/answer-presenter.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现稳定的引用和来源排序**

只排序连续引用组和明确的“资料来源：”编号行：

```ts
export function normalizeCitationOrder(text: string): string {
  const citations = text.replace(
    /(?:\[\d+\]){2,}/gu,
    (group) => [...group.matchAll(/\[(\d+)\]/gu)]
      .map((match) => Number(match[1]))
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((left, right) => left - right)
      .map((value) => `[${value}]`)
      .join(""),
  );
  return sortNumberedSourceLines(citations);
}
```

`sortNumberedSourceLines()` 只能排序标题精确为 `资料来源：` 后、形如 `^\[(\d+)\]\s` 的连续行；遇到空行、非编号行或下一个标题立即结束，不能重写来源编号。

- [ ] **Step 5: 实现结构化分段和稳定总段数**

分段顺序固定为：

1. “资料来源”整体块；
2. Markdown 列表项；
3. 空行分隔段落；
4. 中文/英文完整句；
5. 单个不可拆超长块的硬字符边界。

先把正文解析成 `AtomicBlock[]`，再用贪心装箱。总段数会影响前缀长度，因此迭代直到段数稳定：

```ts
let expectedTotal = 1;
for (let pass = 0; pass < 4; pass += 1) {
  const prefixLength = `问题 #${questionId}（${expectedTotal}/${expectedTotal}）\n\n`.length;
  const bodies = packBlocks(blocks, maxChars - prefixLength);
  if (bodies.length === expectedTotal) return addChunkPrefixes(questionId, bodies);
  expectedTotal = bodies.length;
}
return addChunkPrefixes(questionId, packBlocks(
  blocks,
  maxChars - `问题 #${questionId}（${expectedTotal}/${expectedTotal}）\n\n`.length,
));
```

如果最终只有一段，必须使用 `问题 #N 的回答：`；多段必须使用 `问题 #N（i/总数）`。每个返回字符串都断言非空且 `length <= maxChars`。

- [ ] **Step 6: 保留 LunkrApi 的安全兜底但避免二次拆分**

`LunkrApi.sendText()` 继续调用 `splitText()`，因此 Presenter 生成的每段只触发一次 API 请求；为此增加测试：

```ts
it("sends one API request for an already bounded presented chunk", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ code: "S_OK" })),
  );
  const api = new LunkrApi({ ...config, messageMaxChars: 100 }, session, fetchImpl);
  await api.sendText("#peer#U", "问题 #1 的回答：\n\n短回答");
  expect(fetchImpl).toHaveBeenCalledOnce();
});
```

不得删除 API 层兜底；命令回复或未来调用方仍需要它。

- [ ] **Step 7: 验证并提交阶段 48**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/answer-presenter.test.ts src/lunkr-api.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
git diff --check -- integrations/lunkr-direct/src/answer-presenter.ts integrations/lunkr-direct/src/answer-presenter.test.ts integrations/lunkr-direct/src/lunkr-api.ts integrations/lunkr-direct/src/lunkr-api.test.ts integrations/lunkr-direct/src/index.ts
git add -- integrations/lunkr-direct/src/answer-presenter.ts integrations/lunkr-direct/src/answer-presenter.test.ts integrations/lunkr-direct/src/lunkr-api.ts integrations/lunkr-direct/src/lunkr-api.test.ts integrations/lunkr-direct/src/index.ts
git diff --cached --name-only
```

Expected: Presenter/API 测试和 typecheck 通过；staged diff 仅包含本任务文件。

Run:

```powershell
git commit -m "阶段 48：改进 Lunkr 长回答呈现" -m "完成内容：为单段和多段回答增加问题编号，按 Markdown、段落、句子和来源块安全分段，并稳定排序连续引用和资料来源。`n`n验证结果：AnswerPresenter 与 LunkrApi 测试通过，TypeScript 类型检查通过，git diff --check 通过。"
```

---

### Task 5: 阶段 49——暴露非公开的 PSEAgent 重试元数据

**Files:**
- Modify: `apps/pseagent/src/diagnostics.ts`
- Modify: `apps/pseagent/src/answer-service.ts`
- Modify: `apps/pseagent/src/answer-service.test.ts`
- Modify: `apps/pseagent/src/main.ts`
- Modify: `apps/pseagent/src/embedded.ts`

**Interfaces:**
- Consumes: 现有 `AnswerResult`、现有内容无关 `DiagnosticEvent.stop.reason` 和 `ModelUnavailableError`/`InvalidModelPayloadError`。
- Produces:

```ts
export interface PseAnswerExecution {
  readonly result: AnswerResult;
  readonly retryable: boolean;
  readonly stopReason: PseStopReason | "final" | "unknown_unavailable";
}
```

`AnswerService.answer()` 和 MCP structured content 保持原样；新增
`AnswerService.answerDetailed(question, context?, signal?)` 只供本进程内的
Lunkr embedded runtime 使用。

- [ ] **Step 1: 写临时与稳定错误分类失败测试**

在 `answer-service.test.ts` 增加：

```ts
it("marks model unavailability as retryable without changing public answer", async () => {
  const model = {
    completeText: vi.fn(async () => {
      throw new ModelUnavailableError("model_unavailable_503");
    }),
  } as unknown as ModelClient;
  const service = new AnswerService({
    model,
    router: { route: vi.fn(async () => "normal" as const) },
    planner: createPlanner(),
    knowledge: { open: vi.fn() },
    runAgent: vi.fn(),
  });
  const execution = await service.answerDetailed("普通问题");
  expect(execution).toMatchObject({
    retryable: true,
    stopReason: "model_unavailable",
    result: { status: "temporarily_unavailable" },
  });
  await expect(service.answer("普通问题")).resolves.toMatchObject({
    status: "temporarily_unavailable",
  });
});

it("does not retry a stable invalid model payload", async () => {
  const model = {
    completeText: vi.fn(async () => {
      throw new InvalidModelPayloadError("invalid_schema");
    }),
  } as unknown as ModelClient;
  const service = new AnswerService({
    model,
    router: { route: vi.fn(async () => "normal" as const) },
    planner: createPlanner(),
    knowledge: { open: vi.fn() },
    runAgent: vi.fn(),
  });
  await expect(service.answerDetailed("普通问题")).resolves.toMatchObject({
    retryable: false,
    stopReason: "invalid_model_payload",
    result: { status: "temporarily_unavailable" },
  });
});
```

- [ ] **Step 2: 写 agent stop reason 捕获失败测试**

```ts
it.each([
  ["model_unavailable", true],
  ["seed_unavailable", true],
  ["invalid_model_payload", false],
  ["invalid_final", false],
  ["turn_budget_exhausted", false],
] as const)("maps agent stop %s to retryable=%s", async (reason, retryable) => {
  const service = createKnowledgeService({
    runAgent: vi.fn<AgentRunner>(async (input) => {
      input.trace.record({ event: "stop", reason });
      return temporaryUnavailableResult("professional");
    }),
  });
  await expect(service.answerDetailed("产品问题")).resolves.toMatchObject({
    retryable,
    stopReason: reason,
    result: { status: "temporarily_unavailable" },
  });
});
```

`createKnowledgeService()` 必须在测试文件中完整构造 model、router、planner、
knowledge 和 runAgent；不能依赖真实服务。

- [ ] **Step 3: 运行 AnswerService 测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/answer-service.test.ts
```

Expected: FAIL，`answerDetailed()` 和 `PseAnswerExecution` 尚不存在。

- [ ] **Step 4: 提取并复用 stop reason 类型**

在 `diagnostics.ts` 增加：

```ts
export type PseStopReason =
  | "seed_unavailable"
  | "routing_or_planning_unavailable"
  | "model_unavailable"
  | "invalid_model_payload"
  | "invalid_final"
  | "turn_budget_exhausted";
```

把 `DiagnosticEvent` 的 stop 分支改为：

```ts
| { readonly event: "stop"; readonly reason: PseStopReason }
```

不增加任何问题、回答或 UID 字段。

- [ ] **Step 5: 实现详细结果但保持公共 answer 不变**

在 `answer-service.ts` 增加一个包装现有 trace 的记录器：

```ts
class OutcomeTrace implements DiagnosticTrace {
  stopReason?: PseStopReason;

  constructor(private readonly delegate: DiagnosticTrace) {}

  get requestId(): string {
    return this.delegate.requestId;
  }

  record(event: DiagnosticEvent): void {
    if (event.event === "stop") this.stopReason = event.reason;
    this.delegate.record(event);
  }
}
```

把原 `answer()` 主体移动到 `answerDetailed()`，所有成功出口返回：

```ts
return {
  result,
  retryable: false,
  stopReason: "final",
};
```

临时不可用出口通过以下纯函数分类：

```ts
function executionForUnavailable(
  result: AnswerResult,
  stopReason: PseStopReason | undefined,
): PseAnswerExecution {
  const reason = stopReason ?? "unknown_unavailable";
  return {
    result,
    retryable: reason === "model_unavailable" || reason === "seed_unavailable",
    stopReason: reason,
  };
}
```

在最外层 catch 中按异常类型记录：

```ts
const reason: PseStopReason =
  error instanceof ModelUnavailableError
    ? "model_unavailable"
    : error instanceof InvalidModelPayloadError
      ? "invalid_model_payload"
      : "routing_or_planning_unavailable";
recordDiagnostic(trace, { event: "stop", reason });
```

未知错误不标记 retryable，避免对认证、配置和稳定程序错误盲目重试。公共方法只做：

```ts
async answer(
  question: string,
  conversationContext?: string,
  signal?: AbortSignal,
): Promise<AnswerResult> {
  return (await this.answerDetailed(question, conversationContext, signal)).result;
}
```

- [ ] **Step 6: 从 embedded runtime 暴露详细方法**

在 `PseAgentRuntime` 增加：

```ts
readonly answerDetailed: AnswerService["answerDetailed"];
```

`createPseAgentRuntime()` 返回同一个 service 绑定的 `answer` 与 `answerDetailed`；
MCP server 继续只接收 `answer`。`embedded.ts` 增加：

```ts
export type { PseAnswerExecution } from "./answer-service.js";
```

不得把 `retryable` 或 `stopReason` 加进 `AnswerResult` schema 或 MCP
`structuredContent`。

- [ ] **Step 7: 验证并提交阶段 49**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/answer-service.test.ts src/main-wiring.test.ts src/mcp-server.test.ts
npm exec -w @pseagent/app -- tsc -p tsconfig.json --noEmit
git diff --check -- apps/pseagent/src/diagnostics.ts apps/pseagent/src/answer-service.ts apps/pseagent/src/answer-service.test.ts apps/pseagent/src/main.ts apps/pseagent/src/embedded.ts
git add -- apps/pseagent/src/diagnostics.ts apps/pseagent/src/answer-service.ts apps/pseagent/src/answer-service.test.ts apps/pseagent/src/main.ts apps/pseagent/src/embedded.ts
git diff --cached --name-only
```

Expected: AnswerService、runtime wiring、MCP 测试和 typecheck 通过；staged
diff 只包含 PSEAgent 边界文件，不包含 agent-loop、planner、references 或知识库文件。

Run:

```powershell
git commit -m "阶段 49：暴露 PSEAgent 内部重试元数据" -m "完成内容：在不改变 MCP AnswerResult 的前提下增加 embedded answerDetailed，区分模型临时不可用、种子检索不可用与稳定契约错误。`n`n验证结果：AnswerService、runtime wiring 与 MCP 测试通过，PSEAgent 类型检查通过，git diff --check 通过。"
```

---

### Task 6: 阶段 50——Bridge 即时回执、排队与 `/new`

**Files:**
- Modify: `integrations/lunkr-direct/src/bridge.ts`
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Delete: `integrations/lunkr-direct/src/peer-queue.ts` if the compatibility shim still exists

**Interfaces:**
- Consumes: `PeerScheduler`、`presentAnswer()`、`LunkrDirectMessage.command`。
- Produces:

```ts
export interface BridgeAnswerMetadata {
  readonly scope?: string;
  readonly status?: string;
  readonly retryable: boolean;
  readonly stopReason?: string;
  readonly referenceCount: number;
}

export interface BridgeQuestionEvent {
  readonly type:
    | "received"
    | "queued"
    | "started"
    | "answered"
    | "failed"
    | "cancelled";
  readonly peerUid: string;
  readonly questionId?: number;
  readonly pendingCount: number;
  readonly activePeerCount: number;
  readonly scope?: string;
  readonly status?: string;
  readonly stopReason?: string;
  readonly elapsedMs?: number;
  readonly referenceCount?: number;
}
```

`LunkrBridgeDependencies.answer` 改为：

```ts
readonly answer: (
  question: string,
  conversationContext?: string,
  signal?: AbortSignal,
) => Promise<Result>;
readonly describeResult: (result: Result) => BridgeAnswerMetadata;
readonly onEvent?: (event: BridgeQuestionEvent) => void;
```

这里的 `Result` 在真实启动入口中是 `PseAnswerExecution`；测试可使用等价的
小型对象。Bridge 只通过 `formatAnswer(result)` 和 `describeResult(result)`
访问结果，不把 PSEAgent 内部元数据写进对话上下文。

- [ ] **Step 1: 重写测试基线为即时回执协议**

把原来“每题只发送答案”的断言改为：

```ts
await bridge.handle(message("m1", "#a#U", "第一问"));
expect(sendText.mock.calls.map((call) => call[1])).toEqual([
  "已收到问题 #1，正在处理。",
  "问题 #1 的回答：\n\n第一问:empty",
]);
```

第二问必须收到 `#2`；下一次 `answer` 的 context 包含第一问，但不包含任何回执或编号前缀。

- [ ] **Step 2: 写同用户排队和全局繁忙失败测试**

```ts
it("acknowledges peer-local and global waiting states", async () => {
  // a1 保持运行，再发 a2，断言：
  // 已收到问题 #2，前面还有 1 个问题，已加入队列。
  // a2 真正启动时只发送一次：问题 #2 已开始处理。
  //
  // a、b、c、d 各运行一题，再发 e1，断言：
  // 已收到问题 #1，当前服务繁忙，已进入等待队列。
  // 槽位释放后 e1 只发送一次：问题 #1 已开始处理。
});
```

再增加每用户等待满 5 题：

```ts
expect(lastReply).toBe("当前已有较多问题等待处理，请稍后再发送。");
expect(answer).not.toHaveBeenCalledWith("第七题", expect.anything(), expect.anything());
```

- [ ] **Step 3: 写 `/new` 取消和晚到结果失败测试**

使用一个忽略 abort、稍后仍 resolve 的假 answer，证明 epoch 门禁有效：

```ts
it("/new cancels active and pending work and suppresses late old-epoch results", async () => {
  const oldResult = deferred<{ answer: string; status: string }>();
  const bridge = createBridge({
    answer: vi.fn()
      .mockImplementationOnce(async () => oldResult.promise)
      .mockResolvedValue({ answer: "新回答", status: "answered" }),
  });
  const active = bridge.handle(message("old-1", "#a#U", "旧问题"));
  const pending = bridge.handle(message("old-2", "#a#U", "旧排队问题"));
  await bridge.handle({ ...message("new", "#a#U", "/new"), command: "new" });
  expect(lastSentText()).toBe("已开始新会话，之前处理中和排队的问题已取消。");

  oldResult.resolve({ answer: "不应回发", status: "answered" });
  await Promise.all([active, pending]);
  expect(allSentText()).not.toContain("不应回发");

  await bridge.handle(message("fresh", "#a#U", "新问题"));
  expect(answer.mock.calls.at(-1)?.[1]).toBeUndefined();
  expect(allSentText()).toContain("已收到问题 #3，正在处理。");
});
```

同时断言 `/new` 不取消另一个用户、`/help` 不取消任何题，命令和附件不消耗编号。

- [ ] **Step 4: 写回执发送失败测试**

```ts
it("does not start PSEAgent when the immediate acknowledgment cannot be sent", async () => {
  const sendText = vi.fn().mockRejectedValue(new Error("send failed"));
  const bridge = createBridge({ sendText });
  await expect(bridge.handle(message("m1", "#a#U", "问题"))).rejects.toThrow();
  expect(answer).not.toHaveBeenCalled();
});
```

该测试复用 Task 3 已确定的 admission 接口：

```ts
submit(
  peerUid,
  {
    accept: (receipt) => Promise<void>,
    work: (start) => Promise<void>,
  },
): AdmissionReceipt;
```

调度器必须 await `accept()`；失败时移除该题并释放/轮转槽位，Bridge 不需要临时修改 scheduler 接口。

- [ ] **Step 5: 写一次有界重试失败测试**

使用 fake timers 或注入 `now`，不要真实等待：

```ts
it("retries one temporarily unavailable result within one 300-second budget", async () => {
  const answer = vi.fn()
    .mockResolvedValueOnce({
      answer: "知识问答服务暂时不可用，请稍后重试。",
      status: "temporarily_unavailable",
    })
    .mockResolvedValueOnce({ answer: "恢复后的回答", status: "answered" });
  await bridge.handle(message("m1", "#a#U", "问题"));
  expect(answer).toHaveBeenCalledTimes(2);
  expect(answer.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  expect(answer.mock.calls[1]?.[2]).toBeInstanceOf(AbortSignal);
  expect(allSentText()).toContain("问题 #1 的回答：\n\n恢复后的回答");
});

it("never performs a third attempt and does not add failed context", async () => {
  // 两次 temporarily_unavailable 后仅发送：
  // 问题 #1 处理失败：知识问答服务暂时不可用，请稍后重试。
  // 下一题 context 仍为空。
});
```

认证/配置失败发生在 Bridge 构造前，不进入重试；稳定回答结果、`not_covered` 和 `partially_answered` 均不得重试。

- [ ] **Step 6: 运行 Bridge 测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
```

Expected: FAIL，现有 Bridge 没有编号回执、全局上限、epoch 取消或 Presenter。

- [ ] **Step 7: 实现命令优先级与问题 admission**

`handle()` 的固定顺序：

```ts
if (!this.dedupe.accept(message.id)) return Promise.resolve();
if (message.command === "new") return this.resetPeer(message.peerUid);
if (message.command === "help") return this.sendWithRetry(message.peerUid, HELP_TEXT);
if (message.hasAttachments) {
  return this.sendWithRetry(message.peerUid, "当前仅支持文字私聊。");
}
if (message.text.trim() === "") return Promise.resolve();
return this.acceptQuestion(message);
```

`acceptQuestion()` 根据 receipt.kind 发送且只发送以下固定回执：

```ts
started: `已收到问题 #${id}，正在处理。`
peer_queued: `已收到问题 #${id}，前面还有 ${ahead} 个问题，已加入队列。`
global_queued: `已收到问题 #${id}，当前服务繁忙，已进入等待队列。`
peer_full: "当前已有较多问题等待处理，请稍后再发送。"
```

只有排队题在实际开始时发送 `问题 #N 已开始处理。`；直接开始的题不重复发送 started 提示。

- [ ] **Step 8: 实现共享预算、重试、epoch 门禁和上下文写入**

`acceptQuestion()` 在调用 scheduler 之前创建共享截止时间：

```ts
const deadlineAt = this.now() + 300_000;
const receipt = this.scheduler.submit(peerUid, {
  accept: (admission) => this.sendAdmissionReply(peerUid, admission),
  work: (start) => this.processQuestion(message, start, deadlineAt),
});
```

排队时间、即时回执发送、PSEAgent 调用和一次重试共同消耗这 300 秒。
`processQuestion()` 不得重新计算截止时间：

```ts
const context = this.conversations.context(peerUid);
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const remainingMs = deadlineAt - this.now();
  if (remainingMs <= 0) break;
  const budgetSignal = AbortSignal.timeout(remainingMs);
  const signal = AbortSignal.any([start.signal, budgetSignal]);
  result = await this.dependencies.answer(question, context, signal);
  metadata = this.dependencies.describeResult(result);
  if (!metadata.retryable || attempt === 2) break;
}
```

在每个异步边界后执行：

```ts
if (start.signal.aborted || !this.scheduler.isCurrent(peerUid, start.epoch)) {
  return;
}
```

只有非 `temporarily_unavailable` 且回答成功发完后才：

```ts
this.conversations.append(peerUid, { question, answer });
```

最终失败固定发送：

```text
问题 #N 处理失败：知识问答服务暂时不可用，请稍后重试。
```

多段答案逐段 `await sendWithRetry()`；任何一段发送失败都不得重新调用 PSEAgent，也不得写入上下文。

- [ ] **Step 9: 实现 `/new` 固定回复**

```ts
private async resetPeer(peerUid: string): Promise<void> {
  const reset = this.scheduler.reset(peerUid);
  this.conversations.clear(peerUid);
  this.emit({
    type: "cancelled",
    peerUid,
    pendingCount: reset.pendingCancelled,
    activePeerCount: this.scheduler.activePeerCount,
  });
  await this.sendWithRetry(
    peerUid,
    "已开始新会话，之前处理中和排队的问题已取消。",
  );
}
```

旧任务即使忽略 AbortSignal 并成功返回，也必须被 epoch 门禁静默丢弃，不发送失败提示。

- [ ] **Step 10: 验证并提交阶段 50**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/peer-scheduler.test.ts src/bridge.test.ts src/conversation-store.test.ts src/message-normalizer.test.ts src/answer-presenter.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
git diff --check -- integrations/lunkr-direct/src/bridge.ts integrations/lunkr-direct/src/bridge.test.ts integrations/lunkr-direct/src/peer-queue.ts
git add -- integrations/lunkr-direct/src/bridge.ts integrations/lunkr-direct/src/bridge.test.ts integrations/lunkr-direct/src/peer-queue.ts
git diff --cached --name-only
```

Expected: Bridge 相关测试和 typecheck 通过；旧 `PeerQueue` 不再被 Bridge 引用；staged diff 只包含本任务文件。

Run:

```powershell
git commit -m "阶段 50：完成 Lunkr 回执队列与会话取消" -m "完成内容：实现即时编号回执、用户内排队提示、全局繁忙提示、开始提示、300 秒内一次重试、/new 中止与 epoch 晚到结果门禁。`n`n验证结果：Scheduler、Bridge、会话、命令和 Presenter 测试通过，Lunkr Direct 类型检查通过，git diff --check 通过。"
```

---

### Task 7: 阶段 51——内容无关日志与运行时接线

**Files:**
- Create: `integrations/lunkr-direct/src/runtime-log.ts`
- Create: `integrations/lunkr-direct/src/runtime-log.test.ts`
- Modify: `integrations/lunkr-direct/src/index.ts`
- Modify: `scripts/lunkr-start.mts`

**Interfaces:**
- Consumes: `BridgeQuestionEvent`。
- Produces:

```ts
export interface LunkrRuntimeLogRecord {
  readonly event: BridgeQuestionEvent["type"];
  readonly peer: string;
  readonly questionId?: number;
  readonly pendingCount: number;
  readonly activePeerCount: number;
  readonly scope?: string;
  readonly status?: string;
  readonly stopReason?: string;
  readonly elapsedMs?: number;
  readonly referenceCount?: number;
}

export function createRuntimeLogger(
  write: (line: string) => void,
  salt?: Uint8Array,
): (event: BridgeQuestionEvent) => void;
```

- [ ] **Step 1: 写日志隐私失败测试**

```ts
it("hashes peers and never serializes message content or credentials", () => {
  const lines: string[] = [];
  const log = createRuntimeLogger((line) => lines.push(line), new Uint8Array(32).fill(7));
  log({
    type: "answered",
    peerUid: "#secret-peer#U",
    questionId: 3,
    pendingCount: 1,
    activePeerCount: 4,
    scope: "general",
    status: "answered",
    stopReason: "final",
    elapsedMs: 12_345,
    referenceCount: 2,
  });
  const serialized = lines.join("");
  expect(serialized).not.toContain("#secret-peer#U");
  expect(serialized).not.toContain("password");
  expect(serialized).toContain('"questionId":3');
  expect(serialized).toContain('"referenceCount":2');
});

it("uses a stable peer hash only within one logger instance", () => {
  // 同一 logger 的同一 peer hash 相同；不同 salt 的 logger hash 不同。
});
```

- [ ] **Step 2: 运行日志测试并确认 RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/runtime-log.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现每进程加盐 HMAC 日志**

核心实现：

```ts
import { createHmac, randomBytes } from "node:crypto";

export function createRuntimeLogger(
  write: (line: string) => void,
  salt: Uint8Array = randomBytes(32),
) {
  return (event: BridgeQuestionEvent): void => {
    const peer = createHmac("sha256", salt)
      .update(event.peerUid)
      .digest("hex")
      .slice(0, 16);
    const { peerUid: _peerUid, type: eventName, ...fields } = event;
    write(`${JSON.stringify({ event: eventName, peer, ...fields })}\n`);
  };
}
```

`BridgeQuestionEvent` 类型本身不得包含 `question`、`answer`、`content`、`uid`、`cookie`、`sid` 或 `token` 字段。

- [ ] **Step 4: 在启动脚本中接入真实 AnswerResult 元数据**

`scripts/lunkr-start.mts` 增加：

```ts
const logQuestionEvent = createRuntimeLogger((line) => process.stderr.write(line));

const bridge = new LunkrPseBridge(config, {
  answer: runtime.answerDetailed,
  formatAnswer: (execution) => formatMcpText(execution.result),
  describeResult: (execution) => ({
    scope: execution.result.scope,
    status: execution.result.status,
    retryable: execution.retryable,
    stopReason: execution.stopReason,
    referenceCount:
      execution.result.references.length +
      (execution.result.historicalAnswer?.references.length ?? 0),
  }),
  sendText: (peerUid, text) => api.sendText(peerUid, text),
  onEvent: logQuestionEvent,
});
```

删除旧的每条消息 `lunkr.dm.received`/`replied` 泛化日志，保留 socket 状态和启动失败日志；Bridge 事件取代它们并携带无正文编号和队列状态。

- [ ] **Step 5: 验证并提交阶段 51**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/runtime-log.test.ts src/bridge.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
npm exec -w @pseagent/app -- tsc -p tsconfig.json --noEmit
rg -n "\b(question|answer|content|senderUid|password|cookie|sid|token)\b\s*[?:]" integrations/lunkr-direct/src/runtime-log.ts
git diff --check -- integrations/lunkr-direct/src/runtime-log.ts integrations/lunkr-direct/src/runtime-log.test.ts integrations/lunkr-direct/src/index.ts scripts/lunkr-start.mts
git add -- integrations/lunkr-direct/src/runtime-log.ts integrations/lunkr-direct/src/runtime-log.test.ts integrations/lunkr-direct/src/index.ts scripts/lunkr-start.mts
git diff --cached --name-only
```

Expected: 日志、Bridge 测试与两个 workspace typecheck 通过；`rg` 无匹配，运行日志记录类型不存在正文或凭据字段；`peerUid` 只允许在 HMAC 输入和随后丢弃的解构中出现；staged diff 只包含本任务文件。

Run:

```powershell
git commit -m "阶段 51：接入 Lunkr 内容无关运行日志" -m "完成内容：增加每进程加盐用户哈希和结构化问题生命周期日志，并在 Windows Lunkr 启动入口接入回答状态、停止原因、耗时与引用数。`n`n验证结果：RuntimeLog 与 Bridge 测试通过，Lunkr Direct 和 PSEAgent 类型检查通过，敏感字段扫描与 git diff --check 通过。"
```

---

### Task 8: 阶段 52——完整回归、文档与真实 Lunkr 验收

**Files:**
- Modify: `docs/local-runbook.md`
- Create: `docs/verification/pseagent-lunkr-feedback-concurrency-acceptance.md`

**Interfaces:**
- Consumes: 阶段 46–51 的完整实现和现有固定 Knowledge Engine revisions。
- Produces: 可重复的 Windows 操作说明和不含消息正文/凭据的验收证据。

- [ ] **Step 1: 更新运行手册**

在 Lunkr 部分明确写入：

```text
默认最多同时处理 4 个不同用户；同一用户严格串行，最多等待 5 题。
问题会先收到 #N 回执；排队题开始时会收到单独的开始提示。
/new 会取消该用户当前题和等待题，并清空上下文；不影响其他用户。
问题编号只在当前进程有效，重启后从 #1 重新开始。
```

同时记录配置：

```dotenv
LUNKR_MAX_ACTIVE_PEERS=4
LUNKR_MAX_PENDING_PER_PEER=5
```

- [ ] **Step 2: 运行 Lunkr 定向回归**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src
```

Expected: Lunkr Direct 全部测试通过；至少覆盖 config、normalizer、scheduler、presenter、bridge、runtime log、API、socket、auth 和 session。

- [ ] **Step 3: 运行 TypeScript 全量回归**

Run:

```powershell
npm run typecheck
npm run test:ts
npm run build --workspaces --if-present
```

Expected: 三条命令全部通过。此命令不构建正在运行的 Rust 服务可执行文件，因此不要求停止 Knowledge Engine。

- [ ] **Step 4: 运行 Rust 非破坏性回归**

Run:

```powershell
cargo test --manifest-path services/knowledge-engine/Cargo.toml
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
```

Expected: Rust 测试、格式与 clippy 通过。若 Windows 因正在运行的 Knowledge Engine 锁定可执行文件而失败，记录锁定证据并请求用户允许停止服务后重跑；不得自行停止。

- [ ] **Step 5: 运行范围和秘密扫描**

Run:

```powershell
rg -n -i "openclaw|opencode|lunkr mcp" integrations/lunkr-direct scripts/lunkr-start.mts
rg -n -i "@coremail\.cn|Coremail\+[0-9]{4}|qwe[0-9]{6}|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}" integrations/lunkr-direct scripts/lunkr-start.mts docs/local-runbook.md docs/verification/pseagent-lunkr-feedback-concurrency-acceptance.md
git diff --check
```

Expected: 两次 `rg` 无新增运行依赖或真实凭据匹配；`git diff --check` 通过。

- [ ] **Step 6: 请求服务重启许可**

向用户报告自动化验证结果，并明确询问是否允许：

```text
1. 停止当前 Lunkr 前台进程；
2. 使用现有已加密 Session 启动新代码；
3. 保持 Knowledge Engine 当前 revision 不变；
4. 完成场景 A、C、D，以及至少两个真实用户的场景 B。
```

没有明确许可则停在此步，不执行 kill、stop、restart 或重新登录。

- [ ] **Step 7: 获得许可后重启 Lunkr 并执行真实场景**

先只读确认 PID 和端口，再仅停止已确认的 Lunkr 进程；不要停止 Knowledge Engine。启动：

```powershell
npm run lunkr:status
npm run lunkr:start
```

真实验收：

1. 同一用户连续发送 SPIN 与价格异议两题，核对 `#1/#2`、排队数、开始提示和答案对应关系。
2. 一个长问题核对所有段均含同一问题编号和 `i/总数`，列表与“资料来源”没有在项目中间断开。
3. CACTER 问题、POC 追问、`/new`、旧上下文追问，核对旧任务取消且新问题不继承 CACTER。
4. 至少两个真实用户并行提问；另用自动化 5 个假 UID 证明第 5 用户等待。
5. 发送重复消息 ID fixture，确认不重复编号、回执或回答。

- [ ] **Step 8: 记录内容无关验收证据**

`docs/verification/pseagent-lunkr-feedback-concurrency-acceptance.md` 只允许记录：

```text
timestamp
scenario
questionIds
ackCount
startNoticeCount
answerChunkCount
activePeerPeak
pendingPeak
scope
status
stopReason
elapsedMs
referenceCount
duplicateReplyCount
lateReplyAfterNewCount
contextLeakAfterNew
result
```

不得粘贴真实问题、回答、UID、邮箱、SID、Cookie 或日志原文中的凭据。

- [ ] **Step 9: 提交阶段 52**

Run:

```powershell
git add -- docs/local-runbook.md docs/verification/pseagent-lunkr-feedback-concurrency-acceptance.md
git diff --cached --name-only
git diff --cached --check
git commit -m "阶段 52：完成 Lunkr 并发与回执真实验收" -m "完成内容：更新 Windows 运行手册，并完成即时回执、四用户并发、公平排队、/new 取消、长回答分段和隐私日志的自动化与真实 Lunkr 验收。`n`n验证结果：Lunkr Direct、TypeScript、Rust 回归通过，真实场景 A/B/C/D 通过，敏感信息扫描无匹配，验收记录不包含消息正文或凭据。"
```

Expected: staged diff 只包含运行手册和验收记录；提交成功。

- [ ] **Step 10: 向用户报告最终状态**

报告以下内容：

```text
阶段 45–52 的完整 commit hash
每个阶段的中文摘要
各验证命令的通过数量
真实 Lunkr 场景 A/B/C/D 结果
当前 Lunkr 与 Knowledge Engine 是否仍在运行
未实现的非目标：群聊、附件问答、持久化队列、分布式调度、OpenClaw、Lunkr MCP
```
