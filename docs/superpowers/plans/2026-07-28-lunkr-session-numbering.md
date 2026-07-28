# Lunkr Session Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Lunkr user’s visible question numbering restart at `#1` after `/new` or 24 hours of accepted-question inactivity while preserving epoch isolation and silent idle resets.

**Architecture:** `PeerScheduler` remains the owner of per-peer epoch, numbering, active work, and pending work. `LunkrPseBridge` owns the accepted-question activity clock because it alone distinguishes commands, attachments, duplicates, rejected submissions, and valid questions. Runtime events carry the hidden epoch and reset reason without logging message content.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, existing `@pseagent/lunkr-direct` workspace.

## Global Constraints

- Work only in `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` on `feature/lunkr-direct-integration`.
- Do not start or restart Lunkr or Knowledge Engine without explicit user permission.
- Do not modify or stage `.sisyphus/`.
- Preserve the existing uncommitted `docs/local-runbook.md` change unless the relevant task explicitly needs a non-overlapping edit.
- `LUNKR_SESSION_IDLE_MS` defaults to exactly `86400000`.
- `/new` resets numbering and context visibly; idle expiry resets them silently.
- `/help`, attachments, blank input, duplicate events, and `peer_full` rejection do not extend inactivity.
- State remains in memory; process restart begins again at `#1`.
- Every production change follows RED → GREEN → refactor and ends in a separate Chinese commit with “完成内容” and “验证结果”.

---

### Task 1: Reset Scheduler Numbering With the Epoch

**Files:**
- Modify: `integrations/lunkr-direct/src/peer-scheduler.test.ts`
- Modify: `integrations/lunkr-direct/src/peer-scheduler.ts:127-153`

**Interfaces:**
- Consumes: existing `PeerScheduler.reset(peerUid): PeerResetResult`.
- Produces: `reset()` increments `epoch`, cancels old work, and sets the peer’s `nextQuestionId` to `1`.

- [ ] **Step 1: Change the existing reset regression to require `#1`**

Replace the post-reset assertion in `peer-scheduler.test.ts`:

```ts
const next = scheduler.submit("a", {
  accept: async () => undefined,
  work: async () => undefined,
});
expect(next).toMatchObject({ questionId: 1, epoch: 1 });
await next.completion;
```

The production mutation this catches is omitting `state.nextQuestionId = 1` during reset.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/peer-scheduler.test.ts
```

Expected: FAIL because the actual post-reset question ID is `3`.

- [ ] **Step 3: Implement the minimal reset**

In `PeerScheduler.reset`, immediately after incrementing the epoch:

```ts
state.epoch += 1;
state.nextQuestionId = 1;
```

- [ ] **Step 4: Run focused and workspace tests**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/peer-scheduler.test.ts
npm run test -w @pseagent/lunkr-direct
```

Expected: both PASS with no warnings.

- [ ] **Step 5: Commit the scheduler boundary**

```powershell
git add -- integrations/lunkr-direct/src/peer-scheduler.ts integrations/lunkr-direct/src/peer-scheduler.test.ts
git commit -m "重置 Lunkr 会话问题编号" -m "完成内容：PeerScheduler 在会话 epoch 重置时同步把下一个问题编号恢复为 1，并保留旧任务取消和迟到结果隔离。" -m "验证结果：Lunkr PeerScheduler 聚焦测试及 Lunkr Direct 全量测试通过。"
```

---

### Task 2: Add the 24-Hour Idle Configuration

**Files:**
- Modify: `integrations/lunkr-direct/src/config.test.ts`
- Modify: `integrations/lunkr-direct/src/config.ts:4-46`
- Modify: `.env.example`

**Interfaces:**
- Produces: `LunkrDirectConfig.sessionIdleMs: number`.
- Produces: environment variable `LUNKR_SESSION_IDLE_MS`, positive integer, default `86_400_000`.
- Consumed by: Task 3 `LunkrPseBridge`.

- [ ] **Step 1: Add failing default, override, and validation assertions**

Add to the secure-default test:

```ts
expect(config.sessionIdleMs).toBe(86_400_000);
```

Add a focused test:

```ts
it("loads a positive session idle duration", () => {
  expect(loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "2500" }).sessionIdleMs)
    .toBe(2_500);
  expect(() => loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "0" }))
    .toThrow("正整数");
  expect(() => loadLunkrConfig({ LUNKR_SESSION_IDLE_MS: "1.5" }))
    .toThrow("正整数");
});
```

The production mutation this catches is a missing or non-positive idle duration.

- [ ] **Step 2: Run config tests and verify RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/config.test.ts
```

Expected: TypeScript/Vitest FAIL because `sessionIdleMs` is absent.

- [ ] **Step 3: Implement config loading**

Add to `LunkrDirectConfig`:

```ts
readonly sessionIdleMs: number;
```

Add to `loadLunkrConfig`:

```ts
sessionIdleMs: positiveInteger(env, "LUNKR_SESSION_IDLE_MS", 86_400_000),
```

Add to `.env.example`:

```text
LUNKR_SESSION_IDLE_MS=86400000
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/config.test.ts
npm run typecheck -w @pseagent/lunkr-direct
```

Expected: PASS.

- [ ] **Step 5: Commit configuration**

```powershell
git add -- .env.example integrations/lunkr-direct/src/config.ts integrations/lunkr-direct/src/config.test.ts
git commit -m "增加 Lunkr 会话闲置配置" -m "完成内容：新增默认 24 小时的 LUNKR_SESSION_IDLE_MS 正整数配置，并写入示例环境变量。" -m "验证结果：Lunkr 配置测试和工作区类型检查通过。"
```

---

### Task 3: Silently Expire Idle Peer Sessions

**Files:**
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Modify: `integrations/lunkr-direct/src/bridge.ts:30-320`

**Interfaces:**
- Consumes: `config.sessionIdleMs`, `PeerScheduler.reset`, injected `now(): number`.
- Produces: an in-memory `Map<string, number>` of last accepted question times.
- Produces: manual and idle reset through one internal `resetPeerState(peerUid, reason)` path.

- [ ] **Step 1: Update the shared test config**

Add:

```ts
sessionIdleMs: 86_400_000,
```

Extend `createBridge` to accept an injected clock:

```ts
function createBridge(options: {
  readonly answer: Answer;
  readonly sendText: (peerUid: string, text: string) => Promise<void>;
  readonly config?: Partial<LunkrDirectConfig>;
  readonly now?: () => number;
}) {
  return new LunkrPseBridge(
    { ...config, ...options.config },
    {
      answer: options.answer,
      formatAnswer: (result) => result.answer,
      describeResult: (result) => ({
        status: result.status,
        retryable: result.retryable ?? false,
        stopReason: result.stopReason,
        referenceCount: 0,
      }),
      sendText: options.sendText,
    },
    options.now,
  );
}
```

- [ ] **Step 2: Add a failing exact-boundary idle test**

```ts
it("silently starts at #1 when accepted-question inactivity reaches the limit", async () => {
  let now = 1_000;
  const answer = vi.fn<Answer>(async () => answered("回答"));
  const sendText = vi.fn(async () => undefined);
  const bridge = createBridge({
    answer,
    sendText,
    config: { sessionIdleMs: 1_000 },
    now: () => now,
  });

  await bridge.handle(message("m1", "#a#U", "第一问"));
  now = 1_999;
  await bridge.handle(message("m2", "#a#U", "第二问"));
  now = 2_999;
  await bridge.handle(message("m3", "#a#U", "第三问"));

  expect(sentTexts(sendText)).toContain("已收到问题 #2，正在处理。");
  expect(sentTexts(sendText)).toContain("已收到问题 #1，正在处理。");
  expect(sentTexts(sendText)).not.toContain(
    "已开始新会话，之前处理中和排队的问题已取消。",
  );
  expect(answer.mock.calls[2]?.[1]).toBeUndefined();
});
```

The production mutation this catches is using process-lifetime numbering or `>` instead of `>=` at the boundary.

- [ ] **Step 3: Run bridge tests and verify RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
```

Expected: FAIL because the third question is currently `#3` and receives old context.

- [ ] **Step 4: Implement accepted-question activity tracking**

Add:

```ts
private readonly lastAcceptedQuestionAt = new Map<string, number>();
```

Before `scheduler.submit` in `acceptQuestion`:

```ts
this.expireIdleSession(message.peerUid, receivedAt);
```

After `submit`, only when `receipt.questionId !== undefined`:

```ts
this.lastAcceptedQuestionAt.set(message.peerUid, receivedAt);
```

Implement:

```ts
private expireIdleSession(peerUid: string, now: number): void {
  const lastAcceptedAt = this.lastAcceptedQuestionAt.get(peerUid);
  if (
    lastAcceptedAt === undefined ||
    now - lastAcceptedAt < this.config.sessionIdleMs
  ) {
    return;
  }
  this.resetPeerState(peerUid, "idle");
}
```

Refactor manual `/new` so both paths call a synchronous `resetPeerState` that resets scheduler, context, and last-accepted time. Only the manual wrapper sends the user confirmation.

- [ ] **Step 5: Run bridge tests and verify GREEN**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add no-extension and peer-isolation regressions**

Add this control-message test:

```ts
it("does not extend idle activity for help attachments blank or duplicate events", async () => {
  let now = 0;
  const answer = vi.fn<Answer>(async () => answered("回答"));
  const sendText = vi.fn(async () => undefined);
  const bridge = createBridge({
    answer,
    sendText,
    config: { sessionIdleMs: 1_000 },
    now: () => now,
  });

  await bridge.handle(message("q1", "#a#U", "第一问"));
  now = 400;
  await bridge.handle(message("help", "#a#U", "/help", "help"));
  now = 600;
  await bridge.handle({ ...message("file", "#a#U", ""), hasAttachments: true });
  now = 800;
  await bridge.handle(message("blank", "#a#U", "   "));
  now = 900;
  await bridge.handle(message("q1", "#a#U", "重复事件"));
  now = 1_000;
  await bridge.handle(message("q2", "#a#U", "第二问"));

  expect(sentTexts(sendText)).toContain("已收到问题 #1，正在处理。");
  expect(answer.mock.calls[1]?.[1]).toBeUndefined();
});
```

Add this peer-isolation test:

```ts
it("expires each peer independently", async () => {
  let now = 0;
  const answer = vi.fn<Answer>(async () => answered("回答"));
  const sendText = vi.fn(async () => undefined);
  const bridge = createBridge({
    answer,
    sendText,
    config: { sessionIdleMs: 1_000 },
    now: () => now,
  });

  await bridge.handle(message("a1", "#a#U", "A1"));
  now = 600;
  await bridge.handle(message("b1", "#b#U", "B1"));
  now = 1_000;
  await bridge.handle(message("a2", "#a#U", "A2"));
  now = 1_100;
  await bridge.handle(message("b2", "#b#U", "B2"));

  const receipts = sentTexts(sendText).filter((text) => text.startsWith("已收到问题"));
  expect(receipts).toEqual([
    "已收到问题 #1，正在处理。",
    "已收到问题 #1，正在处理。",
    "已收到问题 #1，正在处理。",
    "已收到问题 #2，正在处理。",
  ]);
});
```

Add this queue-full activity test:

```ts
it("does not refresh idle activity when a full peer queue rejects a question", async () => {
  let now = 0;
  const first = deferred<TestResult>();
  const answer = vi.fn<Answer>(async (question) =>
    question === "Q1" ? first.promise : answered(question));
  const sendText = vi.fn(async () => undefined);
  const bridge = createBridge({
    answer,
    sendText,
    config: { sessionIdleMs: 1_000 },
    now: () => now,
  });

  const handles = [bridge.handle(message("q1", "#a#U", "Q1"))];
  await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
  for (let index = 2; index <= 6; index += 1) {
    handles.push(bridge.handle(message(`q${index}`, "#a#U", `Q${index}`)));
  }
  now = 900;
  handles.push(bridge.handle(message("q7", "#a#U", "Q7")));
  now = 1_000;
  const fresh = bridge.handle(message("q8", "#a#U", "Q8"));

  first.resolve(answered("Q1"));
  await Promise.all([...handles, fresh]);
  expect(sentTexts(sendText)).toContain("已收到问题 #1，前面还有 1 个问题，已加入队列。");
  expect(answer.mock.calls.some((call) => call[0] === "Q7")).toBe(false);
});
```

- [ ] **Step 7: Run the new tests and complete GREEN**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
npm run test -w @pseagent/lunkr-direct
```

Expected: PASS.

- [ ] **Step 8: Commit idle behavior**

```powershell
git add -- integrations/lunkr-direct/src/bridge.ts integrations/lunkr-direct/src/bridge.test.ts
git commit -m "实现 Lunkr 闲置会话重置" -m "完成内容：按用户记录成功提交问题时间，在达到闲置阈值时静默重置 epoch、编号、队列和上下文；命令、附件、空消息、重复与队列满拒绝不延长会话。" -m "验证结果：Lunkr Bridge 聚焦测试和 Lunkr Direct 全量测试通过。"
```

---

### Task 4: Log Epoch and Reset Reason Without Content

**Files:**
- Modify: `integrations/lunkr-direct/src/bridge.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.test.ts`

**Interfaces:**
- Produces: `BridgeQuestionEvent.sessionEpoch?: number`.
- Produces: `BridgeQuestionEvent.resetReason?: "manual" | "idle"`.
- Runtime record retains only lifecycle metadata and the salted peer hash.

- [ ] **Step 1: Add failing runtime-log assertions**

Update the answered fixture:

```ts
sessionEpoch: 2,
```

Update the cancelled fixture:

```ts
sessionEpoch: 3,
resetReason: "idle",
```

Require the parsed record to contain those literal values while the existing forbidden-field assertions stay unchanged.

Use these exact assertions:

```ts
const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
expect(parsed.sessionEpoch).toBe(3);
expect(parsed.resetReason).toBe("idle");
expect(Object.keys(parsed)).not.toEqual(expect.arrayContaining([
  "question",
  "answer",
  "content",
  "uid",
  "cookie",
  "sid",
  "token",
]));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/runtime-log.test.ts
```

Expected: TypeScript/Vitest FAIL because the event fields do not exist.

- [ ] **Step 3: Implement event propagation**

Add optional fields to `BridgeQuestionEvent` and `LunkrRuntimeLogRecord`:

```ts
readonly sessionEpoch?: number | undefined;
readonly resetReason?: "manual" | "idle" | undefined;
```

Populate `sessionEpoch` from `AdmissionNotice.epoch`, `QuestionStart.epoch`, and `PeerResetResult.epoch`. Populate `resetReason` only on reset/cancel events.

- [ ] **Step 4: Run Lunkr verification**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/runtime-log.test.ts src/bridge.test.ts
npm run typecheck -w @pseagent/lunkr-direct
npm run build -w @pseagent/lunkr-direct
```

Expected: PASS.

- [ ] **Step 5: Commit observability**

```powershell
git add -- integrations/lunkr-direct/src/bridge.ts integrations/lunkr-direct/src/runtime-log.ts integrations/lunkr-direct/src/runtime-log.test.ts
git commit -m "记录 Lunkr 隐藏会话代次" -m "完成内容：在脱敏生命周期日志中增加 sessionEpoch 与 manual/idle 重置原因，不记录消息正文或真实 UID。" -m "验证结果：运行日志、Bridge 测试、类型检查和构建通过。"
```

---

### Task 5: Lunkr Session Numbering Verification Gate

**Files:**
- Verify only; do not start live services.

**Interfaces:**
- Validates all preceding Lunkr tasks as one deliverable.

- [ ] **Step 1: Run full automated verification**

```powershell
npm run test -w @pseagent/lunkr-direct
npm run typecheck -w @pseagent/lunkr-direct
npm run build -w @pseagent/lunkr-direct
git diff --check
```

Expected: all commands PASS; `git diff --check` prints nothing.

- [ ] **Step 2: Inspect repository scope**

```powershell
git status --short
git log -5 --oneline
```

Expected: only the pre-existing `docs/local-runbook.md` modification and `.sisyphus/` remain outside committed work.

- [ ] **Step 3: Report the stage**

Report every implementation commit’s full hash, Chinese summary, exact verification commands, and results. Do not start Lunkr until the user explicitly authorizes live acceptance.
