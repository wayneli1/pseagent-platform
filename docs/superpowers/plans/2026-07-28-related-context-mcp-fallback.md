# PSEAgent 未覆盖问题相关信息与 MCP 兜底实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在正式知识库未直接覆盖目标问题时，安全展示正文可确认的相关信息与正式引用，同时保持 `not_covered` 并继续尝试只读 Coremail MCP。

**Architecture:** 将每个 requirement 的目标覆盖与相关信息分离：目标结论继续使用 `coverage/answer/citations`，仅 `coverage=none` 可携带独立 `relatedContext`。引用注册器和独立覆盖校验器共同保证相关事实来自该 requirement 的真实读页且不能提升目标覆盖；响应层只按目标 coverage 推导状态，AnswerService 与 Lunkr 只传递脱敏的 MCP 尝试/使用布尔元数据。

**Tech Stack:** TypeScript 7、Zod 4、Vitest 4、Node.js 24、MCP SDK、Rust/Cargo 全仓回归

## Global Constraints

- 继续在 `feature/lunkr-direct-integration` 分支实施，不合并 `main`。
- 每个 TDD 阶段先观察失败测试，再写最小实现；阶段验证通过后创建独立提交。
- 提交标题和正文使用中文，正文必须包含“完成内容”和“验证结果”。
- 不暂存或提交既有 `docs/local-runbook.md`、`.sisyphus/`、`.env.local`、Session、运行/诊断日志、密码、SID、Cookie、令牌或模型密钥。
- Coremail MCP 只读；不得写入正式知识库、正式引用或后续对话上下文，也不得改变正式状态。
- 只有 `primary.status === "not_covered"` 且配置了历史提供器时调用 MCP；`answered`、`partially_answered`、`temporarily_unavailable`、`normal` 均不调用。
- `relatedContext` 仅允许 `coverage=none` 使用；每个 requirement 最多 3 项，每项 1–4 个引用，目标 `citations` 仍必须为空。
- 顶层正式引用为目标引用和相关信息引用按 requirement 顺序合并去重后的并集；MCP 历史引用始终只在 `historicalAnswer.references`。
- 本轮只强化提示词和确定性契约校验，不增加 embedding、词法语义硬门禁、知识库写回或特定问题字符串补丁。
- 不主动停止、重启或替换当前测试服务；真实探针只启动其自身受控子进程并使用现有环境配置。

---

### Task 1: 相关信息契约与确定性引用校验

**Files:**
- Modify: `apps/pseagent/src/contracts.ts`
- Modify: `apps/pseagent/src/references.ts`
- Modify: `apps/pseagent/src/coverage-verifier.ts`
- Modify: `apps/pseagent/src/agent-loop.ts`
- Test: `apps/pseagent/src/contracts.test.ts`
- Test: `apps/pseagent/src/references.test.ts`
- Test: `apps/pseagent/src/coverage-verifier.test.ts`
- Test: `apps/pseagent/src/agent-loop.test.ts`

**Interfaces:**
- Produces: `RelatedContextItem = { readonly statement: string; readonly citations: readonly number[] }`
- Extends: `RequirementCoverage.relatedContext?: readonly RelatedContextItem[]`
- Preserves: `RequirementCoverage.citations` exclusively describes target coverage.
- Produces: a deterministic requirement citation union in target-first, related-item order.
- Consumes: the existing per-requirement read-evidence map and `CoverageEvidenceDocument[]`.

- [ ] **Step 1: Write failing contract and reference-validation tests**

Add literal behavior tests equivalent to:

```ts
const noneWithContext = {
  id: "R1",
  coverage: "none",
  answer: "正式资料未提及目标协议，无法确认是否支持。",
  citations: [],
  relatedContext: [{
    statement: "资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。",
    citations: [1, 2],
  }],
};

expect(requirementCoverageSchema.parse(noneWithContext)).toEqual(noneWithContext);
expect(() => requirementCoverageSchema.parse({
  ...noneWithContext,
  relatedContext: Array.from({ length: 4 }, () => noneWithContext.relatedContext[0]),
})).toThrow();
expect(() => requirementCoverageSchema.parse({
  ...noneWithContext,
  relatedContext: [{ statement: "没有引用", citations: [] }],
})).toThrow();
```

In `references.test.ts`, register citations 1 and 2 for `R1` and prove that a `none`
result with target `citations: []`, the related item above, and top-level
`citations: [1, 2]` is accepted. Add separate cases proving rejection of:

- related context on `complete` or `partial`;
- a related citation not read for the same requirement;
- inline markers not exactly matching related citations;
- target citations mixed with related citations;
- more than 3 related items or more than 4 citations per item;
- top-level citations that are not the stable union of target plus related citations.

- [ ] **Step 2: Run the new tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/references.test.ts
```

Expected: FAIL because `relatedContext` is not in the strict schemas and `none`
still rejects all per-requirement citations.

- [ ] **Step 3: Implement the schemas and reference-union validation**

Add strict schemas with these exact bounds:

```ts
export const relatedContextItemSchema = z.object({
  statement: z.string().trim().min(1).max(16_384),
  citations: z.array(z.number().int().positive()).min(1).max(4),
}).strict();

// field on both requirementCoverageSchema and the verifier requirement schema
relatedContext: z.array(relatedContextItemSchema).max(3).optional(),
```

In `ReferenceRegistry.validateFinal`, validate target citations and each related
item independently against the requirement read-evidence set. Extract inline
markers from `statement`, require exact set equality with that item’s metadata,
allow related items only when target coverage is `none`, and compute the
top-level union by requirement order, then target citations, then related items.

- [ ] **Step 4: Write failing verifier anti-escalation tests**

In `coverage-verifier.test.ts`, start from a draft with one `coverage=none`
related item and assert acceptance when the verifier retains it or removes one
draft citation while updating only the citation markers. Add rejection cases for:

- a new related fact not present in the draft;
- a new related citation;
- a citation from another requirement;
- moving a related citation into target `citations`;
- returning related context for audited `complete/partial`.

The production change each test catches is a verifier output that creates or
promotes evidence rather than only deleting it.

- [ ] **Step 5: Run the verifier tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-verifier.test.ts
```

Expected: FAIL because verifier output currently has no `relatedContext` and its
subset checks only cover target citations.

- [ ] **Step 6: Implement verifier subset checks and agent-loop evidence plumbing**

Return audited `relatedContext` from `verifyKnowledgeCoverage`. Match audited
related facts to draft facts by normalized statement text with `[n]` markers
removed; audited citations must be a subset of the matched draft item and of the
same requirement’s evidence. An audited item must still have 1–4 citations and
matching inline markers, so dropping all citations means dropping the item.

Update agent-loop helpers so:

```ts
requirementEvidenceCitations =
  stableUniqueNumbers([
    ...requirement.citations,
    ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
  ]);
```

`coverageEvidence`, final citation normalization, diagnostics citation metadata,
and the post-verifier `ReferenceRegistry.validateFinal` call must all see that
same target-plus-related union without ever copying related citations into the
target field.

- [ ] **Step 7: Run focused tests and commit**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/references.test.ts src/coverage-verifier.test.ts src/agent-loop.test.ts
npm run typecheck -w @pseagent/app
```

Commit only the Task 1 files with a Chinese title and a body containing:

```text
完成内容：增加 relatedContext 契约、来源归属校验和覆盖审计防升级约束。
验证结果：PSEAgent 契约、引用、覆盖校验和代理循环定向测试及类型检查通过。
```

---

### Task 2: 支持性问题语义提示与相关信息生成

**Files:**
- Modify: `apps/pseagent/src/prompts.ts`
- Test: `apps/pseagent/src/prompts.test.ts`
- Test: `apps/pseagent/src/agent-loop.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RequirementCoverage.relatedContext`.
- Preserves: 最终 JSON 字段名、1–6 个 requirement、目标 citation 与相关 citation 分区。
- Produces: 可被确定性校验器接受的 `coverage=none + relatedContext` 草稿与审核结果。

- [ ] **Step 1: Write failing prompt-behavior tests**

Add assertions against generated model messages that require all of these
decisions, not merely one keyword:

```text
正文未提及目标只能得到“未覆盖、无法确认”，不能得到“不支持/尚未支持”；
明确支持才回答支持，明确否定才回答不支持；
同义词、缩写或等价表达只有可确认等价关系时才可作为证据；
支持哪些/有哪些问题只能列正文明确项目，不得暗示局部清单完整；
coverage=none 可以输出最多三项、每项最多四个引用的 relatedContext；
相关信息不得提升 coverage，目标 citations 仍为空。
```

Assert the agent prompt contains the quantum-satellite counterexample and
explicit-positive, explicit-negative, synonym, partial-coverage, and
non-exhaustive-list examples. Assert the verifier prompt independently repeats
the anti-inference rules and requires unsupported target claims to be removed
while retaining only directly supported related context.

- [ ] **Step 2: Run prompt tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/prompts.test.ts
```

Expected: FAIL because the existing prompts have no related-context output
contract or complete decision/example table.

- [ ] **Step 3: Implement the prompt contract**

Update the final-action example to:

```json
{
  "action": "final",
  "requirements": [{
    "id": "R1",
    "coverage": "none",
    "answer": "正式知识库未提及目标协议，无法确认是否支持。",
    "citations": [],
    "relatedContext": [{
      "statement": "正文明确列出 SMTP、POP3、IMAP、HTTP/HTTPS 和 CMSP/CMTP 协议能力 [1][2]。",
      "citations": [1, 2]
    }]
  }],
  "citations": [1, 2]
}
```

Keep positive/negative answers in target `answer/citations`. Only target-none
results may use `relatedContext`; every statement must say what the body
directly confirms and must not claim it proves the omitted target.

- [ ] **Step 4: Add an agent-loop protocol case and make it pass**

Script a model draft and verifier result for the quantum-satellite question:
the target remains `none`, target citations stay empty, SMTP/POP3/IMAP facts
stay in one related item, the resolved formal references remain visible, and
the result is not `temporarily_unavailable`.

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/prompts.test.ts src/agent-loop.test.ts
npm run typecheck -w @pseagent/app
```

- [ ] **Step 5: Commit**

Commit only the Task 2 files with:

```text
完成内容：强化支持性问题、否定结论和非完整列举的提示契约，并指导模型输出相关信息。
验证结果：提示词与代理循环协议测试及 PSEAgent 类型检查通过。
```

---

### Task 3: 目标覆盖状态推导与未覆盖响应格式

**Files:**
- Modify: `apps/pseagent/src/response.ts`
- Test: `apps/pseagent/src/response.test.ts`
- Test: `apps/pseagent/src/mcp-server.test.ts`

**Interfaces:**
- Consumes: audited `FinalAction` and resolved formal `Reference[]`.
- Produces: `AnswerResult.status` derived only from target coverage.
- Produces: a `not_covered` answer that may retain verified formal related context and formal references.

- [ ] **Step 1: Write failing status and formatting tests**

Add a table proving that reference count can no longer change status:

```ts
expect(deriveStatus(["none"], 2)).toBe("not_covered");
expect(deriveStatus(["complete"], 0)).toBe("answered");
expect(deriveStatus(["complete", "none"], 3)).toBe("partially_answered");
```

Add a formatting test with target-none + related context:

```text
正式知识库相关信息：

资料明确列出 SMTP、POP3 和 IMAP 协议能力 [1][2]。

覆盖结论：

正式资料未提及目标协议，无法确认 Coremail 是否支持。

正式知识库资料来源：

[1] ...
[2] ...
```

Assert `status === "not_covered"`, `references.length === 2`, the answer does
not contain无证据否定措辞, and an empty related-context case still uses the
exact `NOT_COVERED_TEXT` with no references.

- [ ] **Step 2: Run response tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/response.test.ts src/mcp-server.test.ts
```

Expected: FAIL because `deriveStatus` still depends on `referenceCount` and
`formatAnswerResult` clears every `not_covered` answer/reference.

- [ ] **Step 3: Implement target-only status derivation and sectioned output**

Make `deriveStatus` ignore formal reference count while keeping its public
signature temporarily compatible if call sites still pass the second argument:

```ts
if (requirementCoverages.every((item) => item === "none")) return "not_covered";
if (requirementCoverages.every((item) => item === "complete")) return "answered";
return "partially_answered";
```

Have `formatKnowledgeFinal` build the sectioned related-context answer directly
from audited requirements. `formatAnswerResult` must preserve a non-empty,
already validated `not_covered` answer and references, but must retain the exact
fixed fallback when there is no valid related context. Formal sources are
rendered once; historical sources remain the responsibility of `formatMcpText`.

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/response.test.ts src/mcp-server.test.ts src/agent-loop.test.ts
npm run typecheck -w @pseagent/app
```

Commit only the Task 3 files with:

```text
完成内容：按目标 coverage 推导状态，并为未覆盖结果保留已验证的正式相关信息和来源。
验证结果：响应、MCP 文本和代理循环测试及 PSEAgent 类型检查通过。
```

---

### Task 4: MCP 尝试/使用元数据与 Lunkr 脱敏日志

**Files:**
- Modify: `apps/pseagent/src/answer-service.ts`
- Modify: `apps/pseagent/src/diagnostics.ts`
- Modify: `apps/pseagent/src/answer-service.test.ts`
- Modify: `apps/pseagent/src/diagnostics.test.ts`
- Modify: `integrations/lunkr-direct/src/bridge.ts`
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.test.ts`
- Modify: `scripts/lunkr-start.mts`

**Interfaces:**
- Extends: `PseAnswerExecution` with `historicalAttempted` and `historicalUsed`.
- Extends: diagnostic finish events, `BridgeAnswerMetadata`,
  `BridgeQuestionEvent`, and `LunkrRuntimeLogRecord` with the same booleans.
- Defines: not called = `false/false`; called with failure/empty = `true/false`;
  called and displayed = `true/true`.

- [ ] **Step 1: Write failing AnswerService truth-table tests**

Cover all three outcomes with literal expected metadata:

```ts
expect(noProviderExecution).toMatchObject({
  historicalAttempted: false,
  historicalUsed: false,
});
expect(emptyOrFailedProviderExecution).toMatchObject({
  historicalAttempted: true,
  historicalUsed: false,
});
expect(usedProviderExecution).toMatchObject({
  historicalAttempted: true,
  historicalUsed: true,
});
```

Also prove that a `not_covered` primary result carrying formal related
references still invokes the historical provider. Keep the existing tests that
`answered/partially_answered/temporarily_unavailable` do not call it.

- [ ] **Step 2: Run AnswerService tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/answer-service.test.ts src/diagnostics.test.ts
```

Expected: FAIL because only `historicalUsed` exists internally.

- [ ] **Step 3: Implement AnswerService and diagnostic metadata**

Thread both flags through every `finishExecution` path. Set
`historicalAttempted=true` immediately before invoking the provider; set
`historicalUsed=true` only when a valid `historicalAnswer` is attached to the
public result. Record both booleans in the content-free finish diagnostic
without logging questions, answers, titles or URLs.

- [ ] **Step 4: Write failing bridge/log propagation tests**

Assert the final `answered` event and serialized runtime JSON include both
booleans and that the existing sensitive-key blacklist remains absent. Assert
formal plus historical reference count remains the numeric total while the two
boolean fields reveal the provider outcome independently.

- [ ] **Step 5: Run bridge/log tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts src/runtime-log.test.ts
```

Expected: FAIL because bridge metadata does not expose the new fields.

- [ ] **Step 6: Implement Lunkr propagation and verify**

Add both required booleans to the bridge metadata and optional event/log
records, then map them from `execution.historicalAttempted` and
`execution.historicalUsed` in `scripts/lunkr-start.mts`.

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/answer-service.test.ts src/diagnostics.test.ts
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts src/runtime-log.test.ts
npm run typecheck -w @pseagent/app
npm run typecheck -w @pseagent/lunkr-direct
```

- [ ] **Step 7: Commit**

Commit only the Task 4 files with:

```text
完成内容：区分 Coremail MCP 是否尝试和是否展示，并传递到脱敏诊断及 Lunkr 生命周期日志。
验证结果：AnswerService、诊断、Lunkr bridge/runtime-log 测试和双方类型检查通过。
```

---

### Task 5: 历史探针、固定协议回归与真实模型验收入口

**Files:**
- Modify: `apps/pseagent/src/coremail-historical-probe-contract.ts`
- Modify: `apps/pseagent/src/coremail-historical-probe-contract.test.ts`
- Modify: `apps/pseagent/src/regression.test.ts`
- Modify: `tests/regression/questions.json`
- Create: `scripts/probe-related-context.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AnswerResult` with formal `not_covered` references and optional separate historical references.
- Produces: `npm run probe:related-context`, using the current configured model and the real question three consecutive times.
- Preserves: the existing 41 stable regression IDs and the existing historical-answer raw-equality/warning checks.

- [ ] **Step 1: Write failing probe-contract and protocol-regression tests**

Change only P11’s fixture expectations so it can declare the formal protocol
facts and allowed pages while remaining `not_covered`; keep its forbidden facts
for “已经支持” and unsupported negative conclusions. Generalize the regression
schema so `not_covered` may declare `relatedFacts`/`allowedSourcePages`, and
script P11 to read the fixture page and return target-none plus related context.
Other not-covered cases remain fixed-text/no-reference cases.

In the historical probe contract, replace the old invariant
`not_covered => mainRefs === 0` with these checks:

- formal references exactly support visible formal related context;
- formal and historical references have separate counts and source types;
- historical raw answer, warning and confidence remain unchanged;
- no historical reference is admitted into formal `references`.

- [ ] **Step 2: Run the tests and observe the expected red state**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/coremail-historical-probe-contract.test.ts src/regression.test.ts
```

Expected: FAIL on the old no-formal-reference assumptions and missing P11
related-context scripting.

- [ ] **Step 3: Implement deterministic probe and regression support**

Keep the dataset length exactly 41 and all IDs stable. For P11, use the actual
fixture page(s) already present in the fixed professional snapshot; do not add a
special-case production string check. Extend `validateHistoricalProbe` to
compare formal related citations with formal references while retaining all
historical checks.

- [ ] **Step 4: Create the real-model related-context probe**

`scripts/probe-related-context.mts` must start the built PSEAgent MCP child like
`probe-live.mts`, call the exact real question three times sequentially with a
300-second budget per call, parse `answerResultSchema`, and validate:

```text
scope=professional
status=not_covered
formal answer contains a “无法根据正式知识库确认” equivalent
formal answer does not contain unsupported “尚未支持/明确不支持” equivalents
formal related section states only protocols supported by body text
formal references are visible and non-empty
historicalAttempted is confirmed from a capture/diagnostic-safe execution path
historical answer, when present, has the complete low-trust warning and valid Jira/Wiki references
```

The script must print only stable, content-free summaries such as:

```text
run=1 scope=professional status=not_covered formal_refs=2 history_refs=1 historical_used=true elapsed_ms=12345
```

Add `"probe:related-context": "node --env-file=.env.local --import tsx scripts/probe-related-context.mts"`
to the root scripts. Do not log the question, answer, titles, URLs, credentials
or model payload.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/coremail-historical-probe-contract.test.ts src/regression.test.ts
npm run typecheck -w @pseagent/app
```

Commit only the Task 5 files with:

```text
完成内容：允许历史探针验证正式相关引用分区，并增加 P11 固定协议回归和真实模型三次验收入口。
验证结果：历史探针契约、41 题协议回归和 PSEAgent 类型检查通过。
```

---

### Task 6: 全仓验证、真实模型验收与发布

**Files:**
- Verify only; do not modify unless a failing check reveals a defect covered by this plan.

**Interfaces:**
- Consumes: all previous task commits.
- Produces: fresh evidence for unit tests, types, builds, 41-question protocol regression, live related-context behavior, and clean diff.

- [ ] **Step 1: Run the full deterministic verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run test:regression
git diff --check
```

Expected: all commands exit 0; PSEAgent, Lunkr Direct, Knowledge MCP and Rust
Knowledge Engine suites/builds pass; the scripted regression retains 41 cases.

- [ ] **Step 2: Run the real-model acceptance three times**

Run:

```powershell
npm run probe:related-context
```

Expected: three content-free success lines, each within 300 seconds, each
`professional + not_covered`, with non-empty formal related references and
`historicalAttempted=true`; `historicalUsed` matches whether valid Jira/Wiki
history was returned.

- [ ] **Step 3: Inspect scope and commit only necessary verification fixes**

Run:

```powershell
git status -sb
git diff --stat
git diff --check
```

Do not include `docs/local-runbook.md`, `.sisyphus/`, `.env.local` or runtime
logs. If Task 6 required a code correction, repeat its red/green focused test
and create one final Chinese verification-fix commit with the required
“完成内容” and “验证结果” body; otherwise create no empty commit.

- [ ] **Step 4: Review and push**

Perform per-task and whole-branch review, re-run any check affected by review
fixes, verify `gh --version` and `gh auth status`, then push the current branch:

```powershell
git push -u origin feature/lunkr-direct-integration
```

Do not merge `main` and do not open a new PR unless the user separately requests
one; report the pushed commit hash and remote branch.
