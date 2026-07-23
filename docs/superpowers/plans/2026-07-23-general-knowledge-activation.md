# General Knowledge Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit the user-imported general presales corpus, activate at least one evidence-backed `general` regression and live probe, pin the new repository revision, and relaunch OpenCode for another real test.

**Architecture:** Keep the three repositories independent. First validate and commit the imported content in `presales-general`; then use that immutable commit hash in the platform regression corpus, ignored runtime configuration, release Knowledge Engine, live MCP probe, and OpenCode client. Preserve single-library routing and require every answered general result to cite only `presales-general`.

**Tech Stack:** Markdown/YAML knowledge pages, Git, Node.js 24, TypeScript/Vitest, Rust Knowledge Engine, MCP stdio, OpenCode 1.14.39, PowerShell 5.1.

## Global Constraints

- Do not stage or commit across repository boundaries.
- Do not modify or recommit the professional knowledge repository.
- Do not add judge, scoring, Supabase, Worker, Coremail MCP, public-search fallback, or knowledge writeback.
- Do not commit `.env.local`, model credentials, generated indexes, OpenCode runtime state, or `.sisyphus`.
- Use Chinese commit subjects and Chinese bodies containing both `完成内容` and `验证结果`.
- Stop only the previously recorded OpenCode and Knowledge Engine PIDs; restart only owned processes.
- Accept engine health only when both project names and both exact repository revisions match.

---

### Task 1: Validate and commit the imported general corpus

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general`

**Files:**
- Modify: `purpose.md`
- Modify: `schema.md`
- Modify: `wiki/log.md`
- Modify: `wiki/methods/NVC四要素表达法.md`
- Modify link targets in:
  - `wiki/concepts/愿景重构.md`
  - `wiki/sources/04_Great_Demo_完整知识底稿.md`
  - `wiki/concepts/机会质量与客户证据.md`
  - `wiki/concepts/潜在需求与明确需求.md`
  - `wiki/concepts/痛点链与组织影响.md`
  - `wiki/concepts/解决方案销售.md`
  - `wiki/concepts/诊断式销售.md`
  - `wiki/concepts/购买愿景.md`
  - `wiki/concepts/评估计划与成功标准.md`
  - `wiki/concepts/销售角色与权力地图.md`
  - `wiki/concepts/阶段证据管理.md`
- Commit the existing imported files under:
  - `raw/sources`
  - `wiki/comparison`
  - `wiki/comparisons`
  - `wiki/concepts`
  - `wiki/methods`
  - `wiki/sources`
  - `wiki/synthesis`
- Commit the imported navigation updates:
  - `wiki/index.md`
  - `wiki/overview.md`

**Interfaces:**
- Consumes: the user-imported four raw source files and 49 body pages.
- Produces: one clean immutable `presales-general` revision with resolvable Wiki links and schema-conformant metadata.

- [ ] **Step 1: Stop only the owned pre-import test processes**

Verify PIDs `12048` and `62896` still identify OpenCode and the release Knowledge Engine. Stop those exact PIDs and verify port `19829` is free.

- [ ] **Step 2: Run the corpus audit and confirm RED**

Run a read-only Node audit that:

- requires every body page to start with YAML frontmatter;
- requires `type`, `title`, `created`, `updated`, `tags`, and `sources`;
- accepts only the types listed in `schema.md`;
- resolves body Wiki links case-insensitively against page stems and titles;
- resolves every `related` metadata entry against an existing page;
- verifies every `sources` filename exists under `raw/sources`;
- rejects embedded credentials, internal model endpoint values, private keys, and Coremail product content in body pages;
- requires `purpose.md` not to claim the library is currently empty;
- requires `wiki/log.md` to contain no embedded second frontmatter.

Expected RED evidence before editing:

```text
invalid_type=wiki/methods/NVC四要素表达法.md:methodology
unresolved_links=30
duplicate_log_frontmatter=true
purpose_claims_empty=true
```

- [ ] **Step 3: Apply the minimal metadata and link repair**

Make only these semantic changes:

- change `NVC四要素表达法.md` from `type: methodology` to `type: concept`;
- update `purpose.md` to state that reliable general presales pages are now available and that uncovered questions still return `not_covered`;
- update `schema.md` to describe uncovered healthy searches rather than a healthy empty library;
- remove the embedded `type: log` frontmatter block from the middle of `wiki/log.md`;
- replace unresolved body aliases with existing canonical pages and remove invalid `related` entries that do not name an existing page:

```text
购买愿景创建 -> 购买愿景
成功标准 -> 评估计划与成功标准
机会退出判断 -> 机会质量与客户证据
潜在需求转化 -> 潜在需求与明确需求
Pain Chain -> 痛点链与组织影响
Pain Sheet -> 痛点链与组织影响
诊断先于方案 -> 诊断式销售
Sponsor 与权力角色识别 -> 销售角色与权力地图
Sponsor与权力角色识别 -> 销售角色与权力地图
共同评估计划 -> 评估计划与成功标准
端到端八阶段流程 -> 端到端项目销售
华为销售法 -> 华为销售法体系总览
```

Do not rewrite raw source text or explanatory body prose.

- [ ] **Step 4: Re-run the audit and inspect the staged corpus**

Expected:

```text
body_pages=49
raw_sources=4
invalid_types=0
unresolved_links=0
missing_sources=0
sensitive_hits=0
```

Also run:

```powershell
git diff --check
git status --short
git diff --stat
```

- [ ] **Step 5: Commit the general knowledge repository**

Stage only the imported corpus and the metadata/link repairs:

```powershell
git add -- purpose.md schema.md raw/sources wiki/index.md wiki/log.md wiki/overview.md wiki/comparison wiki/comparisons wiki/concepts wiki/methods wiki/sources wiki/synthesis
git diff --cached --check
git commit -m '阶段 14：启用通用售前知识库' `
  -m '完成内容：提交四套通用售前知识底稿、49 个知识页、导航更新及元数据和链接修复。' `
  -m '验证结果：页面 schema、来源关系、Wiki 链接、敏感信息和仓库边界检查全部通过。'
```

Record the resulting 40-character commit hash.

---

### Task 2: Activate a cited general regression and probe contract

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Modify: `apps/pseagent/src/regression.test.ts`
- Modify: `tests/regression/questions.json`
- Modify: `scripts/probe-live.mts`
- Modify: `docs/local-runbook.md`
- Modify: `docs/superpowers/specs/2026-07-22-pseagent-single-entry-dual-kb-agent-loop-design.md`
- Modify: `docs/superpowers/plans/2026-07-22-pseagent-single-entry-dual-kb-agent-loop.md`
- Create: `docs/verification/general-kb-live-acceptance.md`
- Commit: `docs/superpowers/plans/2026-07-23-general-knowledge-activation.md`
- Update but do not commit: `.env.local`

**Interfaces:**
- Consumes: the Task 1 `presales-general` commit hash and `wiki/synthesis/售前诊断式对话框架.md`.
- Produces: a fixed `G01` general-positive regression contract, a citation-enforcing live probe, updated revision pinning, and redacted acceptance evidence.

- [ ] **Step 1: Write the failing general-activation regression assertion**

Add this dataset-level assertion before changing the dataset:

```ts
it("contains an evidence-backed answered general case", () => {
  const answeredGeneral = cases.filter(
    (item) => item.expectedScope === "general" && item.expectedStatus === "answered",
  );
  expect(answeredGeneral.length).toBeGreaterThan(0);
  for (const item of answeredGeneral) {
    expect(item.allowedProjects).toEqual(["presales-general"]);
    expect(item.requiredFacts.length).toBeGreaterThan(0);
    expect(item.allowedSourcePages.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run the focused regression and confirm RED**

Run:

```powershell
npm run test:regression
```

Expected: FAIL only because there is no `general/answered` case yet.

- [ ] **Step 3: Activate G01 minimally**

Change only `G01` to:

```json
{
  "id": "G01",
  "question": "如何开展厂商无关的售前需求访谈",
  "expectedScope": "general",
  "expectedStatus": "answered",
  "allowedProjects": ["presales-general"],
  "requiredFacts": ["事实", "假设", "未知"],
  "forbiddenFacts": ["Coremail"],
  "allowedSourcePages": ["wiki/synthesis/售前诊断式对话框架.md"]
}
```

Run `npm run test:regression` again. Expected: 40 IDs and all regression assertions pass; the G01 fake session searches and reads only `presales-general`.

- [ ] **Step 4: Update the live-probe contract**

For the G01 probe:

- allow only `answered` or `partially_answered`;
- require at least one `presales-general` reference;
- retain stable text checks for all `not_covered` and `temporarily_unavailable` cases;
- retain redacted output containing only ordinal, scope, status, reference count, and elapsed time.

- [ ] **Step 5: Update fixed revision documentation**

Replace the old general revision with the Task 1 commit hash in `.env.local` and `docs/local-runbook.md`. Update the design and implementation plan to record that the general library is activated, while uncovered general questions still return `not_covered`.

---

### Task 3: Rebuild, run real acceptance, commit, and relaunch OpenCode

**Repositories:**
- `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`
- `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general`
- `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-professional`

**Files:**
- Modify after a reproduced Windows test-isolation failure: `services/knowledge-engine/src/bootstrap.rs`
- Create after acceptance: `docs/verification/general-kb-live-acceptance.md`

**Interfaces:**
- Consumes: both exact knowledge repository commits and the company-model `.env.local`.
- Produces: a clean platform commit, redacted live evidence, and a ready interactive OpenCode session.

- [ ] **Step 1: Run the complete offline suite**

Run:

```powershell
npm run typecheck
npm test
cargo fmt --manifest-path services\knowledge-engine\Cargo.toml --check
cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings
npm run build
npm run test:regression
git diff --check
```

Expected: all commands exit 0.

If the parallel bootstrap fixtures reproduce a Windows temporary-directory collision, first add a failing test that forces an unchanged timestamp, then append an in-process atomic sequence to the test-only temporary path. Do not change production bootstrap behavior.

- [ ] **Step 2: Start the release Knowledge Engine and verify identity**

Start only `target\release\knowledge-engine.exe` with `.env.local`, save its exact PID, and wait up to 15 minutes. Require:

```text
status=ready
coremail-professional=e003c787326609afc3b6d4159e5096a8c29128ed
presales-general=<Task 1 commit hash>
```

Run an authenticated search and read for `wiki/synthesis/售前诊断式对话框架.md`; require matching project, revision, path, and content hash.

- [ ] **Step 3: Run the real model probes**

Run `npm run probe:live`. Require, in order:

```text
professional answered|partially_answered refs>=1
general answered|partially_answered refs>=1
normal answered refs=0
professional not_covered refs=0
```

Do not retain prompts, answers, raw knowledge content, or credentials.

- [ ] **Step 4: Verify the OpenCode client path**

Load `.env.local` into the launching PowerShell process and run:

```powershell
opencode mcp list
```

Require `pseagent connected`. Then run one non-interactive G01 request through `opencode run --agent pseagent`, record only scope/status/reference count if available, and launch:

```powershell
opencode . --agent pseagent
```

- [ ] **Step 5: Write redacted evidence and commit the platform**

Record both knowledge revisions, engine identity, general search/read success, live summary lines, OpenCode MCP connectivity, commands and exit statuses, and cleanup/runtime state. Do not record endpoint, Key, prompt, answer, or body text.

Stage only:

```powershell
git add -- apps/pseagent/src/regression.test.ts services/knowledge-engine/src/bootstrap.rs tests/regression/questions.json scripts/probe-live.mts docs/local-runbook.md docs/superpowers/specs/2026-07-22-pseagent-single-entry-dual-kb-agent-loop-design.md docs/superpowers/plans/2026-07-22-pseagent-single-entry-dual-kb-agent-loop.md docs/superpowers/plans/2026-07-23-general-knowledge-activation.md docs/verification/general-kb-live-acceptance.md
git diff --cached --check
git commit -m '阶段 15：激活通用售前真实问答' `
  -m '完成内容：固定新版通用库 revision，增加通用正向回归与引用校验，并完成公司模型和 OpenCode 真实测试。' `
  -m '验证结果：全量 TypeScript/Rust 检查、40 题回归、双库 live probe 和 OpenCode MCP 连接全部通过。'
```

- [ ] **Step 6: Final audit**

Require:

- all three repositories clean except ignored `.env.local`, generated indexes, and the pre-existing untracked `.sisyphus` runtime directory;
- no remotes were created and nothing was pushed;
- the professional repository remains at its original fixed revision;
- the interactive OpenCode process and owned Knowledge Engine process are running for the user’s test;
- port `19829` has exactly one listener.
