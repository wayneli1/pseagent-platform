# PSEAgent 分层正式证据与跨页归纳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让通用与专业知识库在安全边界内接受有正式引用的跨页归纳，同时继续要求产品支持性、版本、兼容性、数字、授权和穷举结论具有直接正文证据，并阻止已有正式归纳答案错误降级到 Coremail MCP。

**Architecture:** 在知识规划 requirement 上增加 `direct_only | synthesis_allowed` 证据模式，检索循环据此使用 3 页或 6 页读页预算。独立覆盖校验器继续按草稿句段索引确定性重建答案，并用归纳索引子集区分直接支持与跨页归纳；AnswerService 把两者统一视为正式支持，Lunkr 只接收不含正文的覆盖计数与门槛原因。

**Tech Stack:** TypeScript 7、Node.js 24、Zod 4、Vitest 4、MCP stdio、Rust Knowledge Engine、Lunkr Direct

## Global Constraints

- 已确认设计：`docs/superpowers/specs/2026-07-30-layered-formal-evidence-design.md`。
- `general` 和 `professional` 都允许 `synthesis_allowed`，风险边界不由 scope 决定。
- `overview.md` 只用于导航和查询扩展，不注册正式 citation。
- 支持性、存在性、明确否定、版本、兼容性、数字、授权、报价、认证和穷举结论必须 `direct_only`。
- `direct_only` 每 requirement 最多读 3 页；`synthesis_allowed` 最多读 6 页。
- Coremail MCP 继续只读且低可信，不进入正式引用和下一轮会话上下文。
- 结构异常或覆盖验证异常继续关闭失败，并且不得触发 Coremail MCP。
- 不记录问题、答案、知识正文、查询词、页面标题、路径、认证数据或模型密钥到 Lunkr 生命周期日志。
- 每个任务先观察目标测试失败，再实现、验证并创建独立 Git commit。
- commit 标题和正文使用中文；正文至少包含“完成内容”和“验证结果”。
- 只暂存当前任务列出的文件；保留现有 `docs/local-runbook.md` 和 `.sisyphus/` 用户改动。
- 不创建 remote，不 push，不重写任务开始前已有提交。

---

## File Structure

### 核心契约与规划

- `apps/pseagent/src/contracts.ts`
  - 定义 `EvidenceMode`、requirement `evidenceMode` 和覆盖验证归纳索引。
- `apps/pseagent/src/knowledge-planner.ts`
  - 对受保护 requirement 执行确定性 `direct_only` 收紧，并给容量注入项固定模式。
- `apps/pseagent/src/prompts.ts`
  - 给规划器、知识 Agent 和覆盖校验器提供模式决策与跨页归纳边界。

### 检索与覆盖验证

- `apps/pseagent/src/agent-loop.ts`
  - 使用统一的按 requirement 读页预算；记录草稿和验证后覆盖摘要。
- `apps/pseagent/src/coverage-verifier.ts`
  - 校验归纳索引子集，计算直接/归纳/删除句段数，确定性添加归纳披露。
- `apps/pseagent/src/references.ts`
  - 保持实际读页引用归属校验，不新增 overview 或搜索摘要证据入口。
- `apps/pseagent/src/response.ts`
  - 保持 coverage 到最终 status 的既有推导，不因归纳方式强制降为 partial。

### MCP 门槛与可观测性

- `apps/pseagent/src/diagnostics.ts`
  - 扩展 coverage 事件和 historical gate 原因的脱敏类型。
- `apps/pseagent/src/answer-service.ts`
  - 把 direct 与 synthesized 统一为正式支持，并把覆盖摘要带到详细执行结果。
- `integrations/lunkr-direct/src/bridge.ts`
  - 透传可选覆盖计数和 gate reason。
- `integrations/lunkr-direct/src/runtime-log.ts`
  - 序列化脱敏枚举与计数。
- `scripts/lunkr-start.mts`
  - 把 `PseAnswerExecution` 覆盖摘要映射到 bridge 元数据。

### 回归与验收

- `apps/pseagent/src/layered-evidence-regression.test.ts`
  - 使用多篇正文验证职责归纳、受保护事实和 MCP 边界。
- `tests/regression/evidence-coverage.json`
  - 加入真实通用库“售前工程师职责”跨页验收语料。
- `docs/verification/layered-formal-evidence-live-acceptance.md`
  - 记录固定版本、离线验证、真实模型探针和 Lunkr 私聊结果。

---

### Task 1: Requirement 证据模式与受保护事实规划

**Files:**

- Modify: `apps/pseagent/src/contracts.ts`
- Modify: `apps/pseagent/src/contracts.test.ts`
- Modify: `apps/pseagent/src/knowledge-planner.ts`
- Modify: `apps/pseagent/src/knowledge-planner.test.ts`
- Modify: `apps/pseagent/src/prompts.ts`
- Modify: `apps/pseagent/src/prompts.test.ts`
- Modify fixtures: `apps/pseagent/src/agent-loop.test.ts`
- Modify fixtures: `apps/pseagent/src/answer-service.test.ts`
- Modify fixtures: `apps/pseagent/src/coverage-verifier.test.ts`
- Modify fixtures: `apps/pseagent/src/evidence-coverage.test.ts`
- Modify fixtures: `apps/pseagent/src/regression.test.ts`
- Modify fixtures: `apps/pseagent/src/main-wiring.test.ts`

**Interfaces:**

- Produces:

```ts
export const evidenceModeSchema = z.enum([
  "direct_only",
  "synthesis_allowed",
]);

export type EvidenceMode = z.infer<typeof evidenceModeSchema>;

export interface KnowledgeRequirement {
  readonly id: "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
  readonly question: string;
  readonly queries: readonly string[];
  readonly evidenceMode: EvidenceMode;
}
```

- Produces: `enforceProtectedEvidenceModes(plan: KnowledgePlan): KnowledgePlan`
  inside `knowledge-planner.ts`; later tasks consume the normalized plan only.
- Does not change: final answer coverage values or public `AnswerResult`.

- [ ] **Step 1: Add failing contract and planner tests**

Add assertions equivalent to:

```ts
expect(knowledgePlanSchema.safeParse({
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责",
    queries: ["售前 工作职责"],
  }],
}).success).toBe(false);

expect(knowledgePlanSchema.parse({
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责",
    queries: ["售前 工作职责"],
    evidenceMode: "synthesis_allowed",
  }],
}).requirements[0]?.evidenceMode).toBe("synthesis_allowed");
```

In `knowledge-planner.test.ts`, make the model return these cases and assert the
normalized result:

```ts
[
  ["售前工程师的工作职责有哪些？", "synthesis_allowed"],
  ["Coremail 是否支持目标协议？", "direct_only"],
  ["Coremail 适用哪个版本？", "direct_only"],
  ["最大支持多少用户？", "direct_only"],
  ["授权和报价是多少？", "direct_only"],
  ["列出全部兼容数据库", "direct_only"],
]
```

Also assert the deterministic ten-user-scale capacity requirement contains:

```ts
evidenceMode: "direct_only"
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/knowledge-planner.test.ts src/prompts.test.ts
```

Expected: FAIL because `evidenceMode` is not in the schema, prompts do not require it,
and the capacity requirement does not set it.

- [ ] **Step 3: Add the strict schema and planner prompt**

Change the requirement schema to:

```ts
export const evidenceModeSchema = z.enum([
  "direct_only",
  "synthesis_allowed",
]);

export const knowledgeRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  question: z.string().trim().min(1).max(1_024),
  queries: z.array(z.string().trim().min(1).max(1_024)).min(1).max(3),
  evidenceMode: evidenceModeSchema,
}).strict();
```

Update `KNOWLEDGE_PLAN_SYSTEM_PROMPT` so its JSON example includes
`"evidenceMode":"synthesis_allowed"` and contains the exact protected decision table
from the design. Require mixed-risk user questions to be split into separate
requirements.

- [ ] **Step 4: Add deterministic protected-mode tightening**

After model parsing and capacity normalization, call:

```ts
function enforceProtectedEvidenceModes(plan: KnowledgePlan): KnowledgePlan {
  return knowledgePlanSchema.parse({
    ...plan,
    requirements: plan.requirements.map((requirement) => ({
      ...requirement,
      evidenceMode: requiresDirectEvidence(requirement)
        ? "direct_only"
        : requirement.evidenceMode,
    })),
  });
}
```

Use requirement question and queries, not the entire original compound question:

```ts
const PROTECTED_EVIDENCE_PATTERNS = [
  /(?:是否|能否|有没有|是否具备|是否兼容|是否适配|支不支持|支持哪些)/u,
  /(?:不支持|尚未提供|已经下线|版本|补丁|发布日期|生命周期|兼容|适配)/u,
  /(?:授权|报价|费用|采购|许可证|认证)/u,
  /(?:全部|仅有|仅支持|完整清单|最高|最低|最大|最小)/u,
  /(?:RTO|RPO|吞吐|时延|容量|性能|并发)/iu,
  /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|%)/iu,
];
```

The injected capacity requirement must be created with:

```ts
evidenceMode: "direct_only" as const,
```

- [ ] **Step 5: Update typed KnowledgePlan fixtures**

Add `evidenceMode: "direct_only"` to existing product fact fixtures and
`evidenceMode: "synthesis_allowed"` only to fixtures that explicitly test synthesis.
Do this in every fixture file listed under this task so Task 1 ends with a clean
typecheck. Do not add a schema default.

- [ ] **Step 6: Run task verification**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/knowledge-planner.test.ts src/prompts.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

Expected: focused tests PASS, PSEAgent typecheck PASS, diff check produces no output.

- [ ] **Step 7: Commit Task 1**

Stage only this task’s listed files, inspect `git diff --cached --name-only`, then:

```powershell
git commit -m "功能：为知识要求增加证据模式" `
  -m "完成内容：新增 direct_only 与 synthesis_allowed 严格契约，规划器按事实风险拆分并确定性收紧支持性、版本、兼容性、数字、授权和穷举问题。" `
  -m "验证结果：契约、规划器和提示词定向测试通过，PSEAgent 类型检查及 git diff --check 通过。"
```

---

### Task 2: 自适应检索与读页预算

**Files:**

- Modify: `apps/pseagent/src/agent-loop.ts`
- Modify: `apps/pseagent/src/agent-loop.test.ts`
- Modify: `apps/pseagent/src/evidence-coverage.test.ts`
- Modify: `apps/pseagent/src/prompts.ts`
- Modify: `apps/pseagent/src/prompts.test.ts`

**Interfaces:**

- Consumes: `KnowledgeRequirement.evidenceMode` from Task 1.
- Produces:

```ts
export const DIRECT_ONLY_READ_LIMIT = 3;
export const SYNTHESIS_ALLOWED_READ_LIMIT = 6;

export function readLimitFor(
  requirement: KnowledgeRequirement,
): number;
```

- Keeps unchanged: 3 supplemental searches, 2-page batch read, 1 graph action,
  total turn limit, deadline, duplicate-action rejection and two no-gain rounds.

- [ ] **Step 1: Add failing budget tests**

Create one `direct_only` plan with seven candidates and script four reads. Assert only
the first three reach `session.readPage`.

Create one `synthesis_allowed` plan with seven candidates and script seven reads.
Assert the first six reach `session.readPage`, the seventh is rejected, and the model
observation reports `remainingReads: 0`.

Add a coverage-gate test where a synthesis draft remains incomplete after three reads
and an unread fourth candidate exists; assert the loop asks for another action instead
of finalizing or exhausting the fixed three-page gate.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts src/evidence-coverage.test.ts src/prompts.test.ts
```

Expected: FAIL because every requirement still uses `MAX_READS_PER_REQUIREMENT = 3`.

- [ ] **Step 3: Implement one read-limit function**

Replace the fixed read constant with:

```ts
export const DIRECT_ONLY_READ_LIMIT = 3;
export const SYNTHESIS_ALLOWED_READ_LIMIT = 6;

export function readLimitFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? SYNTHESIS_ALLOWED_READ_LIMIT
    : DIRECT_ONLY_READ_LIMIT;
}
```

Use `readLimitFor(requirementState.requirement)` at every current fixed-read call site:

- single-page read admission;
- batch read admission;
- `remainingReads`;
- `pendingEvidenceReviews`;
- `hasAvailableToolAction`;
- `countRemainingToolActions`.

Do not change supplemental search, graph or global turn constants.

- [ ] **Step 4: Add synthesis evidence-facet prompt rules**

In `KNOWLEDGE_AGENT_SYSTEM_PROMPT`, add explicit instructions:

```text
overview 只用于识别证据面和扩展查询，不能作为最终引用。
synthesis_allowed 应从实际候选页收集不同证据面；已有页面集中在同一相邻主题时继续检索。
证据面足够或连续无新增收益时停止，不得为了耗尽六页而读取重复页面。
direct_only 仍只接受实际读取正文的直接结论。
```

Assert those boundaries in `prompts.test.ts`.

- [ ] **Step 5: Run task verification**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts src/evidence-coverage.test.ts src/prompts.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

Expected: focused tests PASS, typecheck PASS, diff check empty.

- [ ] **Step 6: Commit Task 2**

```powershell
git commit -m "功能：按证据模式扩展跨页检索" `
  -m "完成内容：直接事实保持三页上限，跨页归纳使用六页上限，并统一批量读取、剩余动作和覆盖补读的预算判断；overview 仅用于证据面导航。" `
  -m "验证结果：Agent 循环、证据覆盖和提示词定向测试通过，PSEAgent 类型检查及 git diff --check 通过。"
```

---

### Task 3: 分层覆盖校验与确定性归纳披露

**Files:**

- Modify: `apps/pseagent/src/contracts.ts`
- Modify: `apps/pseagent/src/contracts.test.ts`
- Modify: `apps/pseagent/src/coverage-verifier.ts`
- Modify: `apps/pseagent/src/coverage-verifier.test.ts`
- Modify: `apps/pseagent/src/prompts.ts`
- Modify: `apps/pseagent/src/prompts.test.ts`
- Modify: `apps/pseagent/src/agent-loop.ts`
- Modify: `apps/pseagent/src/agent-loop.test.ts`
- Modify: `apps/pseagent/src/regression.test.ts`

**Interfaces:**

- Consumes: normalized `KnowledgePlan` and actual `CoverageEvidenceDocument[]`.
- Produces:

```ts
export const SYNTHESIS_DISCLOSURE =
  "根据正式知识库中多篇资料综合归纳：";

export interface CoverageVerificationSummary {
  readonly id: string;
  readonly reason: CoverageVerificationReason;
  readonly retainedDirectSegmentCount: number;
  readonly retainedSynthesizedSegmentCount: number;
  readonly removedSegmentCount: number;
}
```

- Extends each verification requirement with:

```ts
readonly synthesizedTargetSegmentIndexes: readonly number[];
```

- [ ] **Step 1: Add failing schema and verifier tests**

Add a synthesis plan and a two-segment draft:

```ts
const synthesisPlan: KnowledgePlan = {
  subject: "售前职责",
  requirements: [{
    id: "R1",
    question: "售前工程师的工作职责有哪些",
    queries: ["售前 工作职责"],
    evidenceMode: "synthesis_allowed",
  }],
};
```

Cover these decisions:

```ts
{
  targetDecision: "retain",
  retainedTargetSegmentIndexes: [0, 1],
  synthesizedTargetSegmentIndexes: [0, 1],
  retainedRelatedContextIndexes: [],
  reason: "synthesized_support",
}
```

Assert:

- the answer begins with `SYNTHESIS_DISCLOSURE`;
- original target text and citation order are unchanged;
- coverage stays `complete`;
- callback counts are direct `0`, synthesized `2`, removed `0`;
- synthesis indexes outside retained indexes fail;
- duplicate or unordered synthesis indexes fail;
- `direct_only` plus non-empty synthesis indexes fails;
- mixed `[direct=0, synthesized=1]` reports both counts;
- missing key evidence causes the verifier decision to remove that segment;
- all existing direct, explicit-negative, partial and related-only cases still pass.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/coverage-verifier.test.ts src/prompts.test.ts
```

Expected: FAIL because the decision schema has no synthesis indexes or reason and
materialization has no fixed disclosure.

- [ ] **Step 3: Extend the strict decision schema**

Add:

```ts
export const coverageVerificationReasonSchema = z.enum([
  "direct_support",
  "explicit_negative_support",
  "synthesized_support",
  "partial_support",
  "related_only",
  "target_omitted",
  "unsupported_claim_removed",
]);
```

Add `synthesizedTargetSegmentIndexes` with the same unique, strictly increasing
validation as retained indexes. Do not add a compatibility default: all scripted
verifier decisions must be updated explicitly.

- [ ] **Step 4: Validate synthesis indexes deterministically**

Inside `validateVerification`, enforce:

```ts
const retained = new Set(decision.retainedTargetSegmentIndexes);
if (decision.synthesizedTargetSegmentIndexes.some((index) => !retained.has(index))) {
  return `synthesized_segments_must_be_retained:${decision.id}`;
}
if (
  planned.evidenceMode === "direct_only" &&
  decision.synthesizedTargetSegmentIndexes.length > 0
) {
  return `direct_only_cannot_synthesize:${decision.id}`;
}
if (
  decision.targetDecision === "not_covered" &&
  decision.synthesizedTargetSegmentIndexes.length > 0
) {
  return `not_covered_cannot_synthesize:${decision.id}`;
}
```

Update reason normalization so a retained decision containing synthesis indexes yields
`synthesized_support`; keep `partial_support` for `retain_partial`.

- [ ] **Step 5: Materialize the answer and summary**

For each decision:

```ts
const synthesized = new Set(decision.synthesizedTargetSegmentIndexes);
const retainedDirectSegmentCount =
  decision.retainedTargetSegmentIndexes.filter((index) => !synthesized.has(index)).length;
const retainedSynthesizedSegmentCount = synthesized.size;
const removedSegmentCount =
  segments.length - decision.retainedTargetSegmentIndexes.length;
```

When synthesized count is greater than zero, prefix the rebuilt requirement answer with
`SYNTHESIS_DISCLOSURE`. The prefix must be inserted by code after copying original
segments; it must not alter citations or add a reference.

Change `onVerified` to receive `CoverageVerificationSummary[]`.

- [ ] **Step 6: Strengthen knowledge and verifier prompts**

Add direct/synthesized decision rules and the protected-fact table. Include these
explicit examples:

- multiple diagnostic selling, demo, trust and opportunity pages may support a
  conservative duties summary;
- quotation-conflict pages alone do not prove a complete duties list;
- absent support, version, capacity or licensing text cannot be synthesized;
- page conflicts must be disclosed rather than collapsed into one fact;
- `relatedContext` must directly narrow the user’s decision, not merely share a topic.

The verifier must still output only decision fields and indexes.

- [ ] **Step 7: Update every scripted verifier decision**

Add:

```ts
synthesizedTargetSegmentIndexes: [],
```

to existing direct and not-covered decisions in `coverage-verifier.test.ts`,
`agent-loop.test.ts`, `contracts.test.ts` and `regression.test.ts`. Use a non-empty
array only in new synthesis cases.

- [ ] **Step 8: Run task verification**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/coverage-verifier.test.ts src/prompts.test.ts src/agent-loop.test.ts src/regression.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

Expected: all focused tests PASS, typecheck PASS, diff check empty.

- [ ] **Step 9: Commit Task 3**

```powershell
git commit -m "功能：校验并保留正式跨页归纳" `
  -m "完成内容：覆盖校验器新增归纳句段索引与严格子集规则，按原始句段确定性重建直接和归纳证据，并由代码添加跨页归纳披露。" `
  -m "验证结果：契约、覆盖校验、提示词、Agent 循环和协议回归定向测试通过，PSEAgent 类型检查及 git diff --check 通过。"
```

---

### Task 4: 正式支持门槛与 PSEAgent 脱敏诊断

**Files:**

- Modify: `apps/pseagent/src/diagnostics.ts`
- Modify: `apps/pseagent/src/diagnostics.test.ts`
- Modify: `apps/pseagent/src/agent-loop.ts`
- Modify: `apps/pseagent/src/agent-loop.test.ts`
- Modify: `apps/pseagent/src/answer-service.ts`
- Modify: `apps/pseagent/src/answer-service.test.ts`
- Modify: `apps/pseagent/src/main-wiring.test.ts`
- Modify: `apps/pseagent/src/coremail-historical-probe-contract.test.ts`

**Interfaces:**

- Consumes: `CoverageVerificationSummary` from Task 3.
- Produces optional fields on `PseAnswerExecution`:

```ts
readonly draftCoverage?: readonly Coverage[];
readonly verifiedCoverage?: readonly Coverage[];
readonly retainedDirectSegmentCount?: number;
readonly retainedSynthesizedSegmentCount?: number;
readonly removedSegmentCount?: number;
readonly historicalGateReason?: HistoricalGateReason;
```

- Produces:

```ts
type HistoricalGateReason =
  | "eligible"
  | "question_not_explicit_coremail"
  | "formal_verification_incomplete"
  | "formal_support_present"
  | "structural_fallback";
```

- [ ] **Step 1: Add failing diagnostics and gate tests**

Add a trace test with:

```ts
{
  event: "coverage",
  stage: "verified",
  requirements: [{
    id: "R1",
    evidenceMode: "synthesis_allowed",
    coverage: "complete",
    citations: [1, 2],
    retainedDirectSegmentCount: 0,
    retainedSynthesizedSegmentCount: 2,
    removedSegmentCount: 0,
  }],
  citations: [1, 2],
  stopReason: "final",
}
```

Assert the JSONL record contains only modes, coverage, citation IDs and counts, and does
not contain answer text or evidence body.

In `answer-service.test.ts`, assert:

- direct or synthesized verified coverage sets `verifiedHasFormalSupport`;
- `direct_formal_evidence_present` is no longer accepted;
- gate reason is `formal_support_present`;
- explicit Coremail plus verified all-none remains `eligible`;
- relatedContext citations alone do not set formal support;
- structural fallback remains ineligible;
- detailed execution exposes draft/verified coverage and aggregate segment counts.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/diagnostics.test.ts src/answer-service.test.ts src/main-wiring.test.ts src/coremail-historical-probe-contract.test.ts
```

Expected: FAIL because diagnostics and execution results lack the new fields and the
old gate reason is still named `direct_formal_evidence_present`.

- [ ] **Step 3: Record coverage modes and counts**

Extend `DiagnosticEvent` coverage requirements with `evidenceMode` and optional counts.
Update `recordCoverage` so draft entries contain mode/coverage/citations and verified
entries additionally copy the summary counts by requirement ID.

`OutcomeTrace.record` must store:

```ts
draftCoverage
verifiedCoverage
retainedDirectSegmentCount
retainedSynthesizedSegmentCount
removedSegmentCount
formalCoverageVerified
verifiedHasFormalSupport
```

`verifiedHasFormalSupport` is true when a verified requirement retains at least one
direct or synthesized target segment. It must not use total reference count, because
relatedContext references are not target support.

- [ ] **Step 4: Rename and tighten the historical gate**

Replace:

```ts
if (trace.verifiedHasDirectEvidence) {
  return "direct_formal_evidence_present";
}
```

with:

```ts
if (trace.verifiedHasFormalSupport) {
  return "formal_support_present";
}
```

Keep the existing order:

```text
structural fallback
→ verification incomplete
→ formal support present
→ question lacks explicit Coremail
→ eligible
```

Do not infer Coremail from conversation history.

- [ ] **Step 5: Expose content-free execution metadata**

Have `finishExecution` copy the optional trace summary onto every knowledge execution.
Normal answers may omit these fields. Set `historicalGateReason` only when the gate was
actually evaluated; do not invent `eligible` for answered or partial results.

- [ ] **Step 6: Run task verification**

Run:

```powershell
npm exec -w @pseagent/app -- vitest run src/diagnostics.test.ts src/agent-loop.test.ts src/answer-service.test.ts src/main-wiring.test.ts src/coremail-historical-probe-contract.test.ts
npm run typecheck -w @pseagent/app
git diff --check
```

Expected: focused tests PASS, typecheck PASS, diff check empty.

- [ ] **Step 7: Commit Task 4**

```powershell
git commit -m "修复：仅在无正式支持时进入历史兜底" `
  -m "完成内容：将直接证据与合规跨页归纳统一计为正式支持，收紧 Coremail MCP 门槛，并记录草稿、验证覆盖和句段计数的脱敏诊断。" `
  -m "验证结果：诊断、Agent、AnswerService、主装配和历史探针契约测试通过，PSEAgent 类型检查及 git diff --check 通过。"
```

---

### Task 5: Lunkr 生命周期覆盖可观测性

**Files:**

- Modify: `integrations/lunkr-direct/src/bridge.ts`
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.ts`
- Modify: `integrations/lunkr-direct/src/runtime-log.test.ts`
- Modify: `scripts/lunkr-start.mts`

**Interfaces:**

- Consumes: optional fields on `PseAnswerExecution` from Task 4.
- Adds the same optional fields to `BridgeAnswerMetadata`,
  `BridgeQuestionEvent` and `LunkrRuntimeLogRecord`.
- Does not change message text, retry behavior, queue scheduling or conversation context.

- [ ] **Step 1: Add failing bridge and runtime-log tests**

Make `describeResult` return:

```ts
{
  scope: "general",
  status: "answered",
  retryable: false,
  stopReason: "final",
  referenceCount: 4,
  historicalAttempted: false,
  historicalUsed: false,
  draftCoverage: ["complete"],
  verifiedCoverage: ["complete"],
  retainedDirectSegmentCount: 1,
  retainedSynthesizedSegmentCount: 3,
  removedSegmentCount: 0,
}
```

Assert the emitted `answered` event and serialized runtime record contain these exact
values and omit `historicalGateReason` because the MCP gate was not evaluated. Add a
separate `not_covered` general result whose gate reason is
`question_not_explicit_coremail`. Also assert serialization does not contain a
supplied sentinel question, answer, evidence body, query, path or authentication token.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts src/runtime-log.test.ts
```

Expected: FAIL because bridge and runtime log contracts do not include the new fields.

- [ ] **Step 3: Extend bridge metadata without changing behavior**

Add optional fields to all three interfaces and copy them in `answered` and `failed`
event construction only when present. Keep existing mandatory fields unchanged.

Do not add these values to chat message formatting or stored conversation context.

- [ ] **Step 4: Map PSE execution metadata in the startup script**

In `scripts/lunkr-start.mts`, extend `describeResult` with direct property copies:

```ts
draftCoverage: execution.draftCoverage,
verifiedCoverage: execution.verifiedCoverage,
retainedDirectSegmentCount: execution.retainedDirectSegmentCount,
retainedSynthesizedSegmentCount:
  execution.retainedSynthesizedSegmentCount,
removedSegmentCount: execution.removedSegmentCount,
historicalGateReason: execution.historicalGateReason,
```

Do not read diagnostic files or answer text to construct these fields.

- [ ] **Step 5: Run task verification**

Run:

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts src/runtime-log.test.ts
npm run typecheck -w @pseagent/lunkr-direct
npm run typecheck -w @pseagent/app
git diff --check
```

Expected: Lunkr tests PASS, both workspace typechecks PASS, diff check empty.

- [ ] **Step 6: Commit Task 5**

```powershell
git commit -m "功能：记录 Lunkr 分层证据结果" `
  -m "完成内容：Lunkr 生命周期日志透传草稿与验证覆盖、直接和归纳句段计数及历史门槛原因，不改变消息、队列或会话行为。" `
  -m "验证结果：Bridge 和运行日志定向测试通过，Lunkr Direct 与 PSEAgent 类型检查及 git diff --check 通过。"
```

---

### Task 6: 固定业务回归、真实验收与全仓验证

**Files:**

- Create: `apps/pseagent/src/layered-evidence-regression.test.ts`
- Modify: `tests/regression/evidence-coverage.json`
- Create: `scripts/probe-live-contract.ts`
- Create: `scripts/probe-live-contract.test.ts`
- Modify: `scripts/probe-live.mts`
- Create: `scripts/probe-layered-evidence.mts`
- Modify: `package.json`
- Create: `docs/verification/layered-formal-evidence-live-acceptance.md`

**Interfaces:**

- Consumes all behavior from Tasks 1–5.
- Adds a portable npm script without a new dependency:

```json
"probe:layered-evidence": "node --env-file=.env.local --import tsx scripts/probe-layered-evidence.mts"
```

- Produces:

```ts
export function assertMinimumReferenceCount(
  actual: number,
  minimum: number | undefined,
): void;
```

The helper throws `new Error("insufficient_reference_count")` only when a configured
minimum is not met.

- [ ] **Step 1: Add the failing scripted business regression**

In `layered-evidence-regression.test.ts`, construct six actual read-page fixtures:

```ts
const dutyPages = [
  "wiki/synthesis/售前诊断式对话框架.md",
  "wiki/concepts/解决方案销售.md",
  "wiki/concepts/愿景演示与技术证明的区分.md",
  "wiki/concepts/可信顾问.md",
  "wiki/synthesis/售前冲突沟通场景集.md",
  "wiki/concepts/机会质量与客户证据.md",
] as const;
```

The scripted answer must cover:

```text
需求诊断与访谈
方案组织与价值表达
产品演示与技术证明
客户关系建立与深化
冲突沟通与异议处理
机会管理与项目推进
```

The verifier decision must retain all target segments as synthesized. Assert:

- scope `general`;
- status `answered`;
- answer begins with `SYNTHESIS_DISCLOSURE`;
- all six responsibility domains are present;
- references come only from `presales-general` and the six read pages;
- no `relatedContext`;
- `historicalAttempted === false`;
- synthesized count is non-zero.

In the same file add protected controls:

- `Coremail 是否支持未记载协议` cannot retain synthesized indexes;
- version, capacity and licensing requirements are normalized to `direct_only`;
- an unrelated quotation-conflict page cannot alone retain the duties segment;
- conflicting pages are either both disclosed or the target segment is removed.

Also create `scripts/probe-live-contract.test.ts` before its implementation:

```ts
import { describe, expect, it } from "vitest";
import { assertMinimumReferenceCount } from "./probe-live-contract.js";

describe("assertMinimumReferenceCount", () => {
  it("rejects a real probe below its configured formal reference minimum", () => {
    expect(() => assertMinimumReferenceCount(3, 4))
      .toThrowError("insufficient_reference_count");
  });

  it("accepts an omitted or satisfied minimum", () => {
    expect(() => assertMinimumReferenceCount(0, undefined)).not.toThrow();
    expect(() => assertMinimumReferenceCount(4, 4)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the new tests and observe RED**

Run:

```powershell
npm exec -- vitest run scripts/probe-live-contract.test.ts apps/pseagent/src/layered-evidence-regression.test.ts
```

Expected: FAIL because `scripts/probe-live-contract.ts` does not exist. The layered
business regression may already pass after Tasks 1–5; its pre-fix RED evidence is the
captured real Lunkr result documented in the design.

- [ ] **Step 3: Add EC06 to the real evidence corpus**

Append:

```json
{
  "id": "EC06",
  "variants": [
    {
      "question": "售前工程师的工作职责有哪些？",
      "requiredFacts": [
        ["需求诊断", "需求访谈"],
        ["方案组织", "解决方案"],
        ["产品演示", "技术证明"],
        ["客户关系", "可信顾问"],
        ["冲突沟通", "异议处理"],
        ["机会管理", "项目推进"]
      ]
    },
    {
      "question": "请综合知识库说明售前工程师通常承担哪些核心工作。",
      "requiredFacts": [
        ["需求诊断", "需求访谈"],
        ["方案组织", "解决方案"],
        ["产品演示", "技术证明"],
        ["客户关系", "可信顾问"],
        ["冲突沟通", "异议处理"],
        ["机会管理", "项目推进"]
      ]
    }
  ],
  "expectedScope": "general",
  "expectedStatus": "answered",
  "requirements": [
    {
      "id": "R1",
      "question": "售前工程师的核心职责领域",
      "queries": ["售前工程师 工作职责 方法论", "售前 需求 方案 演示 关系 机会推进"],
      "expectedEvidencePages": [
        "wiki/synthesis/售前诊断式对话框架.md",
        "wiki/concepts/解决方案销售.md",
        "wiki/concepts/愿景演示与技术证明的区分.md",
        "wiki/concepts/可信顾问.md",
        "wiki/synthesis/售前冲突沟通场景集.md",
        "wiki/concepts/机会质量与客户证据.md"
      ],
      "requiredFacts": [
        ["需求诊断", "需求访谈"],
        ["方案组织", "解决方案"],
        ["产品演示", "技术证明"],
        ["客户关系", "可信顾问"],
        ["冲突沟通", "异议处理"],
        ["机会管理", "项目推进"]
      ]
    }
  ],
  "requiredFacts": [
    ["需求诊断", "需求访谈"],
    ["方案组织", "解决方案"],
    ["产品演示", "技术证明"],
    ["客户关系", "可信顾问"],
    ["冲突沟通", "异议处理"],
    ["机会管理", "项目推进"]
  ],
  "forbiddenFacts": [
    "正式岗位说明书明确规定",
    "所有企业都必须",
    "完整职责清单"
  ],
  "maxElapsedMs": 300000
}
```

The live probe accepts any one page from each expected group. If the planner keeps one
requirement, the single group above requires only one of the listed pages; therefore
the acceptance document must additionally inspect visible citations and require at
least four distinct formal references. Add a safe `minReferenceCount?: number` field
to the probe corpus type and validator, set EC06 to `4`, and leave existing cases
without the field.

- [ ] **Step 4: Implement the reference-count contract and focused probe command**

Create `scripts/probe-live-contract.ts`:

```ts
export function assertMinimumReferenceCount(
  actual: number,
  minimum: number | undefined,
): void {
  if (minimum !== undefined && actual < minimum) {
    throw new Error("insufficient_reference_count");
  }
}
```

Import and call it from `scripts/probe-live.mts` after parsing the answer and before
printing the safe result line. Add `minReferenceCount?: number` to `GoldenCase`, copy it
into each selected probe, and add `insufficient_reference_count` to
`safeFailureCodes`.

Create `scripts/probe-layered-evidence.mts`:

```ts
process.env.PSE_PROBE_CASE = "EC06";
process.env.PSE_PROBE_VARIANT ??= "1";
await import("./probe-live.mts");
```

Add:

```json
"probe:layered-evidence": "node --env-file=.env.local --import tsx scripts/probe-layered-evidence.mts"
```

Update `probe-live.mts` to enforce optional `minReferenceCount` with safe failure code
`insufficient_reference_count`; do not print answer text or page content.

- [ ] **Step 5: Run offline task verification**

Run serially:

```powershell
npm exec -- vitest run scripts/probe-live-contract.test.ts
npm exec -w @pseagent/app -- vitest run src/layered-evidence-regression.test.ts
npm run test:regression
npm run test:ts
npm run typecheck
npm run build
cargo test --manifest-path services/knowledge-engine/Cargo.toml
cargo build --manifest-path services/knowledge-engine/Cargo.toml
git diff --check
```

Expected: all TypeScript suites PASS, all workspace typechecks PASS, TypeScript and
Rust builds PASS, Rust tests PASS, diff check empty.

- [ ] **Step 6: Run real-model acceptance**

With the existing local environment and knowledge engine:

```powershell
npm run probe:layered-evidence
```

Expected safe output:

```text
probe=EC06.1 scope=general status=answered refs=<at-least-4> elapsed_ms=<under-300000>
```

Run the protected Coremail historical probe already provided by the repository:

```powershell
npm run probe:related-context
```

Expected: the unrecorded support question remains formally `not_covered`; no
unsupported positive or negative product conclusion appears; strict MCP eligibility
behavior remains intact.

Finally send the exact Lunkr private-chat question:

```text
售前工程师的工作职责有哪些？
```

Inspect only the response and content-free runtime event. Require:

```text
scope=general
status=answered
retainedSynthesizedSegmentCount>0
historicalAttempted=false
```

- [ ] **Step 7: Write the acceptance record**

Create `docs/verification/layered-formal-evidence-live-acceptance.md` with:

- exact PSEAgent, professional KB and general KB revisions;
- Node and Cargo versions;
- every command from Steps 5–6 and pass/fail result;
- EC06 scope, status, reference count, elapsed time and content-free evidence counts;
- protected Coremail probe status and MCP booleans;
- Lunkr question number, scope, status, reference count and evidence counts;
- explicit statement that no key, token, cookie, SID, question text beyond the fixed
  public regression, answer body or knowledge body was recorded.

- [ ] **Step 8: Commit Task 6**

Stage only the new regression, corpus/probe changes, package script and acceptance
record. Then:

```powershell
git commit -m "测试：验证跨页归纳与直接证据边界" `
  -m "完成内容：新增售前职责跨页回归、受保护产品事实控制用例、真实模型聚焦探针和 Lunkr 验收记录。" `
  -m "验证结果：PSEAgent 与全仓 TypeScript 测试、类型检查、构建、Rust 测试与构建、真实模型探针、历史兜底探针及 Lunkr 私聊验收通过。"
```

---

## Final Review Gate

完成六个任务后，不再修改代码，执行 `superpowers:verification-before-completion`
要求的新鲜验证：

```powershell
git status --short
git log -8 --pretty=format:"%H %s"
npm run test:ts
npm run typecheck
npm run build
cargo test --manifest-path services/knowledge-engine/Cargo.toml
cargo build --manifest-path services/knowledge-engine/Cargo.toml
git diff --check
```

确认：

- 六个实施任务各有一个中文 commit；
- 每个 commit 正文含“完成内容”和“验证结果”；
- `docs/local-runbook.md` 和 `.sisyphus/` 仍保持用户原有未提交状态；
- 没有 remote 创建或 push；
- 最终汇报列出每个阶段编号、完整 commit 哈希、中文摘要、验证命令和结果。
