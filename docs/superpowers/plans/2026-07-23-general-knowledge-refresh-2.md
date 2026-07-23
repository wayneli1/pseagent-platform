# General Knowledge Refresh 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit the second user-imported general-presales corpus expansion, activate an evidence-backed SPIN regression and live probe, pin the new repository revision, and relaunch OpenCode for user testing.

**Architecture:** Preserve the three independent repositories. Repair only broken metadata/link aliases in `presales-general`, commit the imported corpus there, then pin that immutable commit in `pseagent-platform`. Validate the new SPIN page through deterministic regression, authenticated Knowledge Engine search/read, the company-model live probe, and OpenCode.

**Tech Stack:** Markdown/YAML knowledge pages, Git, Node.js 24, TypeScript/Vitest, Rust Knowledge Engine, MCP stdio, OpenCode 1.14.39, PowerShell 5.1.

## Global Constraints

- Keep `pseagent-platform`, `presales-general`, and `coremail-professional` as independent Git repositories.
- Do not modify or recommit `coremail-professional`.
- Do not create remotes, push, delete repositories, or archive the old prototype.
- Do not commit `.env.local`, generated indexes/logs, OpenCode session state, or `.sisyphus`.
- Do not enable dual-library search, judge/scoring, Supabase, Worker, Coremail MCP, public-search fallback, or knowledge writeback.
- Preserve imported raw/source prose; only repair invalid metadata or links required for a valid committed snapshot.
- Use Chinese commit subjects and Chinese bodies containing both “完成内容” and “验证结果”.
- Accept runtime health only when both project names and both exact repository revisions match.
- Challenger Sale and JOLT raw files may be committed as immutable source archives, but are not active answer evidence until derived Markdown pages cite them.

---

### Task 1: Validate, repair, and commit the imported corpus

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general`

**Files:**
- Modify imported navigation: `wiki/index.md`, `wiki/log.md`, `wiki/overview.md`
- Add imported raw sources:
  - `raw/sources/01_SPIN_Selling_完整知识底稿.txt`
  - `raw/sources/02_The_Trusted_Advisor_完整知识底稿.txt`
  - `raw/sources/03_The_Challenger_Sale_完整知识底稿.txt`
  - `raw/sources/04_The_JOLT_Effect_完整知识底稿.txt`
- Add the 25 imported Markdown pages under `wiki/comparisons`, `wiki/concepts`, `wiki/sources`, and `wiki/synthesis`
- Repair the `trust-equation` alias in:
  - `wiki/index.md`
  - `wiki/comparisons/trusted-advisor与诊断式销售的互补.md`
  - `wiki/concepts/亲密感-商业关系.md`
  - `wiki/concepts/从服务到顾问关系.md`
  - `wiki/concepts/倾听与复述.md`
  - `wiki/concepts/共同界定问题.md`
  - `wiki/concepts/可信顾问.md`
  - `wiki/concepts/小承诺与可靠性.md`
  - `wiki/concepts/边界与困难对话.md`
  - `wiki/concepts/透明的专业建议.md`
  - `wiki/concepts/降低自我导向.md`
  - `wiki/sources/02_The_Trusted_Advisor_完整知识底稿.md`
  - `wiki/synthesis/可信顾问场景应对手册.md`
  - `wiki/synthesis/可信顾问方法总览.md`

**Interfaces:**
- Consumes: the user-imported four raw source files, 25 body pages, and three navigation changes.
- Produces: one clean immutable `presales-general` commit whose metadata, sources, body Wiki links, and `related` entries resolve.

- [ ] **Step 1: Confirm the owned old test processes are stopped**

Verify the previously recorded Knowledge Engine and OpenCode PIDs before stopping them. Require port `19829` to be free before rebuilding.

- [ ] **Step 2: Record the pre-repair corpus audit**

Run a read-only audit that:

- accepts only `concept`, `source`, `synthesis`, `comparison`, and `query`;
- requires `type`, `title`, `created`, `updated`, `tags`, and `sources`;
- resolves body Wiki links and `related` entries against page stems or titles;
- treats `[[#local-anchor]]` as a valid same-page link;
- verifies every declared source exists under `raw/sources`;
- scans body and raw files for credentials, the configured internal endpoint, private keys, and Coremail product facts.

Expected pre-repair result:

```text
body_pages=74
raw_sources=8
invalid_types=0
missing_metadata=0
missing_sources=0
sensitive_hits=0
coremail_hits=0
unresolved trust-equation body links=6
unresolved trust-equation related entries=13
```

- [ ] **Step 3: Repair only the broken canonical alias**

In the listed files:

- replace body `[[trust-equation|...]]` links with `[[trust-equation信任方程|...]]`;
- replace `trust-equation` values inside `related` arrays with `trust-equation信任方程`.

Do not rewrite imported explanatory prose or any raw source.

- [ ] **Step 4: Re-run the complete audit**

Require:

```text
body_pages=74
raw_sources=8
invalid_types=0
missing_metadata=0
unresolved_links=0
unresolved_related=0
missing_sources=0
sensitive_hits=0
coremail_hits=0
```

Record that `03_The_Challenger_Sale_完整知识底稿.txt` and `04_The_JOLT_Effect_完整知识底稿.txt` are unreferenced source archives, not active evidence.

- [ ] **Step 5: Stage and commit only the general repository**

Run:

```powershell
git status --short
git diff --check
git add -- raw/sources wiki/index.md wiki/log.md wiki/overview.md wiki/comparisons wiki/concepts wiki/sources wiki/synthesis
git diff --cached --check
```

Scan the staged diff for credentials, endpoint values, and private keys without printing matches. Commit:

```powershell
git commit -m '阶段 16：扩充通用售前方法库' `
  -m '完成内容：提交 SPIN、可信顾问及后续来源底稿，新增通用售前知识页并修复元数据和链接。' `
  -m '验证结果：页面 schema、来源关系、Wiki 链接、敏感信息和仓库边界检查全部通过。'
```

---

### Task 2: Pin the new revision and activate the SPIN regression

**Repository:** `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`

**Files:**
- Modify: `apps/pseagent/src/regression.test.ts`
- Modify: `tests/regression/questions.json`
- Modify: `scripts/probe-live.mts`
- Modify: `docs/local-runbook.md`
- Modify: `docs/superpowers/specs/2026-07-22-pseagent-single-entry-dual-kb-agent-loop-design.md`
- Modify: `docs/superpowers/plans/2026-07-22-pseagent-single-entry-dual-kb-agent-loop.md`
- Add: `docs/superpowers/plans/2026-07-23-general-knowledge-refresh-2.md`
- Add after live acceptance: `docs/verification/general-kb-refresh-2-live-acceptance.md`
- Update but do not stage: `.env.local`

**Interfaces:**
- Consumes: the Task 1 commit and `wiki/concepts/spin四类问题.md`.
- Produces: a deterministic G03 SPIN regression, a live probe that exercises the new corpus, pinned documentation/configuration, and redacted evidence.

- [ ] **Step 1: Add the failing G03 activation assertion**

Add a dataset assertion requiring G03 to be a general answered case whose project is `presales-general`, whose required facts are the four SPIN question types, and whose allowed page is `wiki/concepts/spin四类问题.md`.

Run:

```powershell
npm run test:regression
```

Expected: fail only because G03 is still `not_covered`.

- [ ] **Step 2: Activate G03 minimally**

Change G03 to:

```json
{
  "id": "G03",
  "question": "售前如何发现客户的隐性需求",
  "expectedScope": "general",
  "expectedStatus": "answered",
  "allowedProjects": ["presales-general"],
  "requiredFacts": ["情境问题", "问题问题", "暗示问题", "需求效益问题"],
  "forbiddenFacts": ["Coremail"],
  "allowedSourcePages": ["wiki/concepts/spin四类问题.md"]
}
```

Run `npm run test:regression` and require all 40 fixed IDs and all assertions to pass.

- [ ] **Step 3: Update the live and revision contracts**

- Replace the general live-probe question with G03 while preserving `answered|partially_answered` and at least one general reference.
- Replace the previous general revision in `.env.local` and `docs/local-runbook.md`.
- Update the current activation notes in the design and implementation plan with the new revision, SPIN/Trusted Advisor coverage, and the two archival-only raw sources.

---

### Task 3: Rebuild, accept, commit, and relaunch OpenCode

**Repositories:**
- `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`
- `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general`
- `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-professional`

**Files:**
- Create after acceptance: `docs/verification/general-kb-refresh-2-live-acceptance.md`

**Interfaces:**
- Consumes: both exact knowledge repository revisions and the ignored company-model configuration.
- Produces: a platform commit, a ready Knowledge Engine, and an interactive OpenCode session.

- [ ] **Step 1: Run the full offline suite serially**

Run:

```powershell
npm run typecheck
npm test
cargo fmt --manifest-path services\knowledge-engine\Cargo.toml -- --check
cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings
npm run build
cargo build --release --manifest-path services\knowledge-engine\Cargo.toml
npm run test:regression
git diff --check
```

- [ ] **Step 2: Start and identify the release Knowledge Engine**

Start only `target\release\knowledge-engine.exe` with `.env.local`, save its exact PID, and wait up to 15 minutes. Require `ready` with:

```text
coremail-professional=e003c787326609afc3b6d4159e5096a8c29128ed
presales-general=<Task 1 commit>
```

Run authenticated search/read for `wiki/concepts/spin四类问题.md`; require matching project, revision, path, non-empty body, and a valid 64-character content hash.

- [ ] **Step 3: Run real company-model and OpenCode checks**

Run `npm run probe:live`; require:

```text
professional answered|partially_answered refs>=1
general answered|partially_answered refs>=1
normal answered refs=0
professional not_covered refs=0
```

Run `opencode mcp list` and require `pseagent connected`. Run one non-interactive G03 request, then launch `opencode . --agent pseagent` with the ignored environment loaded.

- [ ] **Step 4: Record redacted evidence and commit the platform**

Record revisions, health identity, SPIN search/read results, redacted live summary lines, OpenCode connectivity, verification commands, and runtime PIDs. Do not record endpoint, keys, prompts, answers, or knowledge bodies.

Stage only the eight tracked platform changes plus this plan and the new evidence file. Exclude `.env.local`, indexes, logs, and `.sisyphus`. Commit:

```powershell
git commit -m '阶段 17：启用第二批通用售前知识' `
  -m '完成内容：固定新版通用库 revision，激活 SPIN 正向回归和真实探针，并同步运行与设计文档。' `
  -m '验证结果：全量 TypeScript/Rust 检查、40 题回归、双库 live probe 和 OpenCode MCP 连接全部通过。'
```

- [ ] **Step 5: Final audit**

Require:

- general and professional repositories clean at exact fixed revisions;
- platform clean except the pre-existing `.sisyphus` runtime directory and ignored local/generated files;
- zero remotes and no pushes;
- exactly one Knowledge Engine listener on port `19829`;
- owned Knowledge Engine and OpenCode processes running for the user.
