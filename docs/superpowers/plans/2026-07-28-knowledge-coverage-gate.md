# Knowledge Evidence Coverage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent related-but-non-supporting knowledge pages from producing `answered`, and present Coremail MCP output only as isolated, explicitly unreliable historical clues.

**Architecture:** The existing agent still retrieves pages and creates a structurally valid draft. A new `coverage-verifier` receives the original requirements, the draft, and exact compact text for cited pages; it produces a strict audited final that can only retain or downgrade coverage and citations. The agent formats only the audited result, while the Lunkr bridge stores a formal-only context representation that excludes `historicalAnswer`.

**Tech Stack:** TypeScript 7, Zod 4, Node.js 24, Vitest 4, existing OpenAI-compatible `ModelClient`, PSEAgent MCP, Lunkr Direct.

## Global Constraints

- Work only in `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` on `feature/lunkr-direct-integration`.
- Do not write to `coremail-professional`, `presales-general`, or `coremail-knowledge-mcp`.
- Do not add Embedding, vector infrastructure, judge services, dual-library retrieval, OpenClaw, or Lunkr MCP.
- `normal` questions remain model-only; `professional` uses only the professional library; `general` uses only the general library.
- Coremail MCP is called only after an audited formal result is exactly `not_covered`.
- Verifier unavailability or invalid output becomes `temporarily_unavailable`, not `not_covered`.
- Historical output never changes the formal status, references, or next-turn conversation context.
- Do not start or restart live services without explicit user permission.
- Do not stage `.sisyphus/` or the pre-existing unrelated `docs/local-runbook.md` change.
- Every production change follows RED → GREEN → refactor and ends in a separate Chinese commit with “完成内容” and “验证结果”.

---

### Task 1: Define the Coverage Verification Contract

**Files:**
- Modify: `apps/pseagent/src/contracts.test.ts`
- Modify: `apps/pseagent/src/contracts.ts`

**Interfaces:**
- Produces: `coverageVerificationReasonSchema`.
- Produces: `coverageVerificationActionSchema`.
- Produces: `CoverageVerificationAction`.
- Consumed by: `coverage-verifier.ts` in Task 2.

- [ ] **Step 1: Add failing contract tests**

Import `coverageVerificationActionSchema` and add:

```ts
it("accepts only strict per-requirement coverage verification results", () => {
  expect(coverageVerificationActionSchema.parse({
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "none",
      answer: "现有正文未覆盖目标协议。",
      citations: [],
      reason: "related_only",
    }],
    citations: [],
  })).toMatchObject({
    action: "verify",
    requirements: [{ id: "R1", coverage: "none" }],
  });

  expect(() => coverageVerificationActionSchema.parse({
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "complete",
      answer: "支持[1]",
      citations: [1],
      reason: "invented_reason",
    }],
    citations: [1],
  })).toThrow();
});
```

The production mutation this catches is accepting arbitrary verifier decisions or losing the per-requirement audit reason.

- [ ] **Step 2: Run contract tests and verify RED**

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts
```

Expected: FAIL because the schema export does not exist.

- [ ] **Step 3: Add the strict schema**

Use these reason literals:

```ts
export const coverageVerificationReasonSchema = z.enum([
  "direct_support",
  "explicit_negative_support",
  "partial_support",
  "related_only",
  "target_omitted",
  "unsupported_claim_removed",
]);
```

Define a strict verification requirement with `id`, `coverage`, `answer`, `citations`, and `reason`, then:

```ts
export const coverageVerificationActionSchema = z.object({
  action: z.literal("verify"),
  requirements: z.array(coverageVerificationRequirementSchema).min(1).max(6),
  citations: z.array(z.number().int().positive()).max(20),
}).strict();

export type CoverageVerificationAction =
  z.infer<typeof coverageVerificationActionSchema>;
```

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts
npm run typecheck -w @pseagent/app
```

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add -- apps/pseagent/src/contracts.ts apps/pseagent/src/contracts.test.ts
git commit -m "定义正文覆盖校验契约" -m "完成内容：新增严格的逐必答项证据覆盖校验 Schema、原因码和类型，限制输出为一到六项审计结果。" -m "验证结果：PSEAgent 契约测试和类型检查通过。"
```

---

### Task 2: Build a Fail-Closed Coverage Verifier

**Files:**
- Create: `apps/pseagent/src/coverage-verifier.ts`
- Create: `apps/pseagent/src/coverage-verifier.test.ts`
- Modify: `apps/pseagent/src/prompts.ts`

**Interfaces:**
- Produces:

```ts
export interface CoverageEvidenceDocument {
  readonly requirementId: string;
  readonly citation: number;
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface CoverageVerifierInput {
  readonly question: string;
  readonly plan: KnowledgePlan;
  readonly draft: FinalAction;
  readonly evidence: readonly CoverageEvidenceDocument[];
  readonly model: ModelClient;
  readonly signal?: AbortSignal;
}

export class InvalidCoverageVerificationError extends Error {}

export async function verifyKnowledgeCoverage(
  input: CoverageVerifierInput,
): Promise<FinalAction>;
```

- Consumed by: `agent-loop.ts` in Task 3.

- [ ] **Step 1: Write failing downgrade and direct-support tests**

Create these literal fixtures:

```ts
const singleRequirementPlan: KnowledgePlan = {
  subject: "Coremail 协议支持",
  requirements: [{
    id: "R1",
    question: "是否支持目标协议",
    queries: ["Coremail 目标协议支持"],
  }],
};

const completeDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "complete",
    answer: "草稿结论[1]。",
    citations: [1],
  }],
  citations: [1],
};

const partialDraft: FinalAction = {
  action: "final",
  requirements: [{
    id: "R1",
    coverage: "partial",
    answer: "草稿仅确认部分内容[1]，其余待确认。",
    citations: [1],
  }],
  citations: [1],
};

const directEvidence: CoverageEvidenceDocument[] = [{
  requirementId: "R1",
  citation: 1,
  title: "目标能力",
  path: "wiki/concepts/目标能力.md",
  content: "正文直接确认目标能力。",
}];

function scriptedVerifier(
  ...actions: Array<CoverageVerificationAction | Error>
): ModelClient {
  let index = 0;
  return {
    completeJson: async <T>() => {
      const action = actions[index++];
      if (action instanceof Error) throw action;
      return action as T;
    },
    completeText: async () => {
      throw new Error("unexpected completeText");
    },
  };
}
```

Then add:

```ts
it("accepts a downgrade from complete to none and removes related-only citations", async () => {
  const result = await verifyKnowledgeCoverage({
    question: "Coremail 是否已经支持 2035 年量子卫星邮件协议",
    plan: singleRequirementPlan,
    draft: completeDraft,
    evidence: [{
      requirementId: "R1",
      citation: 1,
      title: "邮件系统协议基础",
      path: "wiki/concepts/邮件系统协议基础.md",
      content: "正文仅介绍 SMTP、POP3、IMAP。",
    }],
    model: scriptedVerifier({
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "none",
        answer: "现有知识正文未覆盖目标协议。",
        citations: [],
        reason: "related_only",
      }],
      citations: [],
    }),
  });

  expect(result).toEqual({
    action: "final",
    requirements: [{
      id: "R1",
      coverage: "none",
      answer: "现有知识正文未覆盖目标协议。",
      citations: [],
    }],
    citations: [],
  });
});
```

Add the direct-support case:

```ts
it("keeps complete coverage when the cited正文 directly supports the target", async () => {
  const result = await verifyKnowledgeCoverage({
    question: "Coremail 是否支持 SMTP",
    plan: singleRequirementPlan,
    draft: completeDraft,
    evidence: [{
      requirementId: "R1",
      citation: 1,
      title: "邮件系统协议基础",
      path: "wiki/concepts/邮件系统协议基础.md",
      content: "Coremail 邮件系统支持 SMTP。",
    }],
    model: scriptedVerifier({
      action: "verify",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "Coremail 支持 SMTP[1]。",
        citations: [1],
        reason: "direct_support",
      }],
      citations: [1],
    }),
  });

  expect(result.requirements[0]).toEqual({
    id: "R1",
    coverage: "complete",
    answer: "Coremail 支持 SMTP[1]。",
    citations: [1],
  });
});
```

The production mutations caught are bypassing the audit result or losing a legitimate directly supported answer.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-verifier.test.ts
```

Expected: FAIL because `coverage-verifier.ts` does not exist.

- [ ] **Step 3: Implement prompt payload and minimal conversion**

Add `coverageVerificationMessages` to `prompts.ts`. Its system instruction must define:

- related background is not direct support;
- omission is not proof of unsupported functionality;
- an explicit negative statement can support a negative answer;
- a documentation-gap question may be answered by explicit gap evidence;
- every retained conclusion must be supported by retained citations;
- the verifier cannot search, add citations, or upgrade draft coverage.

The user payload must be JSON containing exactly:

```ts
{
  question: input.question,
  plan: input.plan,
  draft: input.draft,
  evidence: input.evidence,
}
```

Implement one `completeJson` call with schema description `pse_coverage_verification`, strip each `reason`, and return a `FinalAction`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-verifier.test.ts
```

Expected: initial downgrade and direct-support tests PASS.

- [ ] **Step 5: Add failing invariant tests**

Add a table-driven test using these literal invalid actions:

```ts
it.each([
  ["wrong requirement", {
    action: "verify",
    requirements: [{
      id: "R2",
      coverage: "complete",
      answer: "支持[1]",
      citations: [1],
      reason: "direct_support",
    }],
    citations: [1],
  }],
  ["coverage upgrade", {
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "complete",
      answer: "支持[1]",
      citations: [1],
      reason: "direct_support",
    }],
    citations: [1],
  }],
  ["new citation", {
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "partial",
      answer: "部分支持[2]",
      citations: [2],
      reason: "partial_support",
    }],
    citations: [2],
  }],
  ["wrong top-level union", {
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "partial",
      answer: "部分支持[1]",
      citations: [1],
      reason: "partial_support",
    }],
    citations: [],
  }],
] as const)("rejects %s", async (_name, action) => {
  await expect(verifyKnowledgeCoverage({
    question: "问题",
    plan: singleRequirementPlan,
    draft: partialDraft,
    evidence: directEvidence,
    model: scriptedVerifier(action),
  })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
});
```

Add the cross-requirement evidence test:

```ts
it("rejects a citation that was not read for the audited requirement", async () => {
  const action: CoverageVerificationAction = {
    action: "verify",
    requirements: [{
      id: "R1",
      coverage: "partial",
      answer: "部分支持[1]",
      citations: [1],
      reason: "partial_support",
    }],
    citations: [1],
  };
  await expect(verifyKnowledgeCoverage({
    question: "问题",
    plan: singleRequirementPlan,
    draft: partialDraft,
    evidence: [{ ...directEvidence[0]!, requirementId: "R2" }],
    model: scriptedVerifier(action),
  })).rejects.toBeInstanceOf(InvalidCoverageVerificationError);
});
```

Add a test where the first call throws `InvalidModelPayloadError` and the repair call returns valid JSON; assert the real result is returned. Add another where both calls are invalid and assert `InvalidCoverageVerificationError`.

- [ ] **Step 6: Run invariants and verify RED**

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-verifier.test.ts
```

Expected: FAIL until semantic invariants and repair handling exist.

- [ ] **Step 7: Implement invariants and one repair**

Implement numeric coverage ranks:

```ts
const COVERAGE_RANK = { none: 0, partial: 1, complete: 2 } as const;
```

Reject an output when:

- count/order/IDs differ from the plan and draft;
- audited rank exceeds draft rank;
- any citation is outside the draft item’s citations;
- any citation is absent from that requirement’s evidence documents;
- answer inline citations differ from item citations;
- a covered item has no citation or a none item has citations;
- top-level citations differ from the stable union.

Catch only `InvalidModelPayloadError` for one repair request. Convert a second invalid payload or semantic invariant failure to `InvalidCoverageVerificationError`. Propagate `ModelUnavailableError` unchanged.

- [ ] **Step 8: Run verifier tests, app tests, and typecheck**

```powershell
npm exec -w @pseagent/app -- vitest run src/coverage-verifier.test.ts
npm run test -w @pseagent/app
npm run typecheck -w @pseagent/app
```

Expected: PASS.

- [ ] **Step 9: Commit the verifier**

```powershell
git add -- apps/pseagent/src/coverage-verifier.ts apps/pseagent/src/coverage-verifier.test.ts apps/pseagent/src/prompts.ts
git commit -m "实现独立正文覆盖校验器" -m "完成内容：新增基于实际紧凑正文的严格覆盖审计、单向降级、引用子集校验和一次 Schema 修复，模型不可用时保持失败关闭。" -m "验证结果：覆盖校验器测试、PSEAgent 全量测试和类型检查通过。"
```

---

### Task 3: Insert the Verifier Before Status Mapping

**Files:**
- Modify: `apps/pseagent/src/agent-loop.ts`
- Modify: `apps/pseagent/src/agent-loop.test.ts`
- Modify: `apps/pseagent/src/diagnostics.ts`
- Modify: `apps/pseagent/src/answer-service.ts`
- Modify: `apps/pseagent/src/answer-service.test.ts`

**Interfaces:**
- `KnowledgeAgentInput` gains optional injectable:

```ts
readonly verifyCoverage?: typeof verifyKnowledgeCoverage;
```

- Production defaults to `verifyKnowledgeCoverage`.
- Agent state stores compact content by citation for the current request only.
- Diagnostics distinguish `stage: "draft" | "verified"`.
- Stop reasons add `coverage_verifier_unavailable` and `coverage_verifier_invalid`.

- [ ] **Step 1: Preserve existing agent tests with an identity verifier**

In the `agentInput` test helper, inject:

```ts
verifyCoverage: async ({ draft }) => draft,
```

This is test isolation for existing retrieval behavior; dedicated integration tests below exercise the real verifier boundary.

- [ ] **Step 2: Add a failing agent integration regression**

Set the fake session’s `compactPage` result to:

```text
支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。
```

Script the agent draft as `complete` with citation `[1]`. Inject:

```ts
const verifyCoverage = vi.fn(async (input) => {
  expect(input.question).toContain("2035 年量子卫星邮件协议");
  expect(input.evidence).toEqual([expect.objectContaining({
    requirementId: "R1",
    citation: 1,
    content: "支持 SMTP、POP3、IMAP、HTTP/HTTPS 与 CMSP/CMTP。",
  })]);
  return {
    action: "final" as const,
    requirements: [{
      id: "R1" as const,
      coverage: "none" as const,
      answer: "现有知识正文未覆盖目标协议。",
      citations: [],
    }],
    citations: [],
  };
});
```

Call:

```ts
const result = await runKnowledgeAgent({
  ...agentInput(model, session),
  question: "Coremail 是否已经支持 2035 年量子卫星邮件协议",
  verifyCoverage,
});
```

Assert:

```ts
expect(result).toEqual({
  scope: "professional",
  status: "not_covered",
  answer: NOT_COVERED_TEXT,
  references: [],
});
```

Also assert the verifier input contains the original “2035 年量子卫星邮件协议” requirement and the compact page content.

The production mutation this catches is formatting the draft before the verifier or failing to retain read-page content.

- [ ] **Step 3: Run the agent-loop regression and verify RED**

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts
```

Expected: FAIL because `verifyCoverage` is not called.

- [ ] **Step 4: Retain evidence and invoke the verifier**

Add to agent state:

```ts
readonly evidenceContents: Map<number, {
  readonly title: string;
  readonly path: string;
  readonly content: string;
}>;
```

After `compactPage`, store the citation’s content. Build verifier documents by combining each requirement’s `citationIndexes`, `ReferenceRegistry.resolve`, and `evidenceContents`.

After existing draft structural validation:

1. record draft coverage diagnostics;
2. call `input.verifyCoverage ?? verifyKnowledgeCoverage`;
3. run `ReferenceRegistry.validateFinal` again on the audited action;
4. record verified coverage diagnostics;
5. call `formatKnowledgeFinal` only with the audited action and audited citations.

- [ ] **Step 5: Run the integration test and verify GREEN**

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add failing error-path tests**

Add these two agent-loop cases:

```ts
it.each([
  [
    new ModelUnavailableError(),
    "coverage_verifier_unavailable",
  ],
  [
    new InvalidCoverageVerificationError("invalid_verification"),
    "coverage_verifier_invalid",
  ],
] as const)("fails closed when coverage verification fails", async (error, reason) => {
  const events: DiagnosticEvent[] = [];
  const trace = {
    requestId: "coverage-test",
    record: (event: DiagnosticEvent) => events.push(event),
  };
  const session = fakeSession({
    hits: {
      "测试问题": [{ path: "wiki/r1.md" }],
      "seed-r1": [{ path: "wiki/r1.md" }],
    },
  });
  const model = scriptedAgentModel([
    read("R1", "wiki/r1.md"),
    {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "正式草稿[1]。",
        citations: [1],
      }],
      citations: [1],
    },
  ]);
  const result = await runKnowledgeAgent({
    ...agentInput(model, session),
    trace,
    verifyCoverage: async () => {
      throw error;
    },
  });

  expect(result.status).toBe("temporarily_unavailable");
  expect(events).toContainEqual({ event: "stop", reason });
});
```

Extend the existing `answer-service.test.ts` stop-reason table with the exact rows:

```ts
["coverage_verifier_unavailable", true],
["coverage_verifier_invalid", false],
```

- [ ] **Step 7: Implement diagnostics and retry classification**

Extend `PseStopReason` with:

```ts
| "coverage_verifier_unavailable"
| "coverage_verifier_invalid"
```

Add `stage: "draft" | "verified"` to coverage events. In `finishExecution`, include `coverage_verifier_unavailable` in retryable stop reasons, not `coverage_verifier_invalid`.

- [ ] **Step 8: Run PSEAgent verification**

```powershell
npm exec -w @pseagent/app -- vitest run src/agent-loop.test.ts src/answer-service.test.ts src/diagnostics.test.ts
npm run test -w @pseagent/app
npm run typecheck -w @pseagent/app
```

Expected: PASS.

- [ ] **Step 9: Commit agent integration**

```powershell
git add -- apps/pseagent/src/agent-loop.ts apps/pseagent/src/agent-loop.test.ts apps/pseagent/src/diagnostics.ts apps/pseagent/src/answer-service.ts apps/pseagent/src/answer-service.test.ts
git commit -m "接入知识正文覆盖门" -m "完成内容：知识代理在状态映射前保存并审计实际读页正文，只格式化审计结果；校验不可用和无效输出分别记录并按规则返回暂时不可用。" -m "验证结果：Agent Loop、AnswerService、诊断测试、PSEAgent 全量测试和类型检查通过。"
```

---

### Task 4: Strengthen the Historical Warning

**Files:**
- Modify: `apps/pseagent/src/contracts.test.ts`
- Modify: `apps/pseagent/src/contracts.ts`
- Modify: `apps/pseagent/src/mcp-server.test.ts`
- Modify: `apps/pseagent/src/mcp-server.ts`
- Modify: `apps/pseagent/src/coremail-historical-probe-contract.test.ts`

**Interfaces:**
- `HISTORICAL_ANSWER_WARNING` becomes the exact approved low-trust warning.
- `formatMcpText` labels the section and self-reported confidence without implying correctness.

- [ ] **Step 1: Add failing presentation assertions**

Require the rendered text to contain:

```text
⚠️ Coremail MCP 低可信历史线索（可能不正确）
```

Require the fixed warning:

```text
以下内容由 Coremail MCP 根据 Jira/Wiki 历史资料自动整理，并非正式知识库答案，也未经过产品或售前人员验证。内容可能存在较多错误、过时信息、资料缺失或版本不匹配，请仅作为继续检索的线索，不能直接用于客户答复、投标、部署、升级或变更决策。
```

Require:

```text
MCP 自报置信度：低（不代表内容正确）
```

Retain these behavior assertions:

```ts
expect(text.indexOf(result.answer)).toBeLessThan(text.indexOf(rawHistoricalAnswer));
expect(result.status).toBe("not_covered");
expect(result.references).toEqual([]);
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/mcp-server.test.ts src/coremail-historical-probe-contract.test.ts
```

Expected: FAIL on the old heading, warning, and confidence label.

- [ ] **Step 3: Implement the exact warning and labels**

Replace `HISTORICAL_ANSWER_WARNING` with the approved literal. In `formatMcpText`, use the exact heading and:

```ts
`MCP 自报置信度：${confidenceLabels[historical.confidence]}（不代表内容正确）`
```

Do not rewrite `historical.answer` or merge `historical.references` into formal references.

- [ ] **Step 4: Run app verification**

```powershell
npm exec -w @pseagent/app -- vitest run src/contracts.test.ts src/mcp-server.test.ts src/coremail-historical-probe-contract.test.ts
npm run test -w @pseagent/app
npm run typecheck -w @pseagent/app
```

Expected: PASS.

- [ ] **Step 5: Commit warning changes**

```powershell
git add -- apps/pseagent/src/contracts.ts apps/pseagent/src/contracts.test.ts apps/pseagent/src/mcp-server.ts apps/pseagent/src/mcp-server.test.ts apps/pseagent/src/coremail-historical-probe-contract.test.ts
git commit -m "强化 Coremail MCP 低可信警告" -m "完成内容：历史辅助区块改为醒目的可能不正确提示，并明确 MCP 自报置信度不代表内容正确，正式状态和引用保持隔离。" -m "验证结果：历史契约、MCP 呈现、探针契约、PSEAgent 全量测试和类型检查通过。"
```

---

### Task 5: Exclude Historical Output From Lunkr Context

**Files:**
- Modify: `integrations/lunkr-direct/src/bridge.ts`
- Modify: `integrations/lunkr-direct/src/bridge.test.ts`
- Modify: `scripts/lunkr-start.mts`

**Interfaces:**
- `LunkrBridgeDependencies<Result>` gains:

```ts
readonly formatContextAnswer?: (result: Result) => string;
```

- User-visible output still uses `formatAnswer`.
- ConversationStore uses `formatContextAnswer(result)` when supplied.
- Production Lunkr wiring uses `execution.result.answer`, which excludes `historicalAnswer`.

- [ ] **Step 1: Add a failing context-isolation test**

Use a result with:

```ts
{
  answer: "正式知识未覆盖",
  displayed: "正式知识未覆盖\n\n低可信历史错误内容",
  context: "正式知识未覆盖",
  status: "not_covered",
}
```

Create the bridge with `formatAnswer: result => result.displayed` and `formatContextAnswer: result => result.context`. Ask a second question and assert its received `conversationContext` contains `正式知识未覆盖` but not `低可信历史错误内容`.

The production mutation this catches is appending the screen-formatted historical block to ConversationStore.

- [ ] **Step 2: Run the bridge test and verify RED**

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
```

Expected: TypeScript/Vitest FAIL because `formatContextAnswer` is unsupported and the display text enters context.

- [ ] **Step 3: Implement separate display and context formatting**

In `processQuestion`, keep:

```ts
const answer = this.dependencies.formatAnswer(result).trim();
```

Before appending, derive:

```ts
const contextAnswer = (
  this.dependencies.formatContextAnswer?.(result) ?? answer
).trim();
```

Append only when `contextAnswer !== ""`:

```ts
this.conversations.append(message.peerUid, {
  question,
  answer: contextAnswer,
});
```

In `scripts/lunkr-start.mts`, add:

```ts
formatContextAnswer: (execution) => execution.result.answer,
```

- [ ] **Step 4: Run Lunkr and cross-workspace verification**

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/bridge.test.ts
npm run test -w @pseagent/lunkr-direct
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit context isolation**

```powershell
git add -- integrations/lunkr-direct/src/bridge.ts integrations/lunkr-direct/src/bridge.test.ts scripts/lunkr-start.mts
git commit -m "隔离 Lunkr 历史辅助上下文" -m "完成内容：Lunkr 屏幕继续展示完整历史辅助区块，但 ConversationStore 只保存正式 PSEAgent 回答，低可信历史内容不进入后续追问。" -m "验证结果：Bridge 测试、Lunkr Direct 全量测试、全仓类型检查和构建通过。"
```

---

### Task 6: Add the Fixed Regression and Full Verification

**Files:**
- Modify: `tests/regression/questions.json`
- Modify: `apps/pseagent/src/regression.test.ts`
- Verify: all workspaces and Rust Knowledge Engine.

**Interfaces:**
- Adds the literal question “Coremail 是否已经支持 2035 年量子卫星邮件协议” with `professional/not_covered`, no required facts, and no allowed source pages.

- [ ] **Step 1: Add the failing regression fixture**

Add a case with a new stable ID and:

```json
{
  "id": "P11",
  "question": "Coremail 是否已经支持 2035 年量子卫星邮件协议",
  "expectedScope": "professional",
  "expectedStatus": "not_covered",
  "allowedProjects": ["coremail-professional"],
  "requiredFacts": [],
  "forbiddenFacts": ["已经支持", "明确不支持"],
  "allowedSourcePages": []
}
```

Update the dataset length assertion to the new literal count.

- [ ] **Step 2: Run regression and verify RED**

```powershell
npm run test:regression
```

Expected: FAIL before the count and scripted fixture expectations are synchronized.

- [ ] **Step 3: Make only the fixture-count adjustment**

Change the literal `.length(40)` to `.length(41)`. Do not weaken evidence assertions.

- [ ] **Step 4: Run full verification**

```powershell
npm run test:regression
npm run test:ts
npm run typecheck
npm run build
cargo test --manifest-path services/knowledge-engine/Cargo.toml
git diff --check
```

Expected: all PASS; no warnings that change behavior.

- [ ] **Step 5: Commit regression evidence**

```powershell
git add -- tests/regression/questions.json apps/pseagent/src/regression.test.ts
git commit -m "增加正文未覆盖回归问题" -m "完成内容：把 2035 年量子卫星邮件协议加入固定专业问题回归，要求正式结果 not_covered、零正式证据且禁止推断支持或不支持。" -m "验证结果：固定回归、全量 TypeScript 测试、类型检查、构建和 Knowledge Engine Rust 测试通过。"
```

---

### Task 7: Final Review and Live-Acceptance Handoff

**Files:**
- Verify only.

- [ ] **Step 1: Review scope and secrets**

```powershell
git status --short
git log -12 --oneline
git diff --check
git diff --cached --word-diff=porcelain | rg -n "(@coremail\\.cn|PSE_MODEL_API_KEY=\\S+|password\\s*[:=]\\s*\\S+)"
```

Expected: no credential-like additions; unrelated files remain unstaged.

- [ ] **Step 2: Report every stage**

For each commit, report the full hash, Chinese summary, verification command, and result.

- [ ] **Step 3: Stop before live service mutation**

Do not start Lunkr or Knowledge Engine. Ask the user for explicit permission before live acceptance with `/new`, an abbreviated idle threshold, the fixed 2035 question, Coremail MCP warning presentation, and follow-up context isolation.
