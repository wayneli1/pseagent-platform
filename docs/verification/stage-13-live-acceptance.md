# Stage 13 live acceptance

- Date: 2026-07-23 (Asia/Shanghai)
- Model mode: company OpenAI-compatible endpoint, direct connection
- Model: `deepseek-v4-pro`
- Temporary Codex bridge: not running during the accepted run
- Knowledge engine: local release binary on loopback
- Conflicting Docker container: absent before the run; the absent state was preserved

## Runtime and repository baselines

- Node.js: `v24.15.0`
- npm: `11.12.1`
- Rust: `rustc 1.91.0`, `cargo 1.91.0`
- Platform pre-Stage-13 HEAD: `0b0e1206425c4fd1c1d1d98e6342a08dc341dc44`
- Professional knowledge HEAD: `e003c787326609afc3b6d4159e5096a8c29128ed`
- General knowledge HEAD: `b7f3d60fe781a57856174cf61f83bdf11df3727a`

## Fixed knowledge snapshots

- `coremail-professional`: `e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general`: `b7f3d60fe781a57856174cf61f83bdf11df3727a`

The engine health response contained exactly these two projects and revisions. An authenticated UTF-8 search located the fixed professional document, and an authenticated read returned the same project, revision, and path.

## Compatibility defects found and fixed

Live testing showed that the route prompt did not state its required fixed `action` field, the knowledge-agent prompt did not state the exact tool-action shapes, final-only state was not exposed to the model, and inline citation markers were not explicitly tied to the `citations` array. Contract tests were added before each prompt fix. The live company model then produced schema-valid route, tool, and final actions, including matching inline citation markers.

## Accepted probe summaries

```text
probe=1 scope=professional status=answered refs=1 elapsed_ms=21215
probe=2 scope=general status=not_covered refs=0 elapsed_ms=16278
probe=3 scope=normal status=answered refs=0 elapsed_ms=10655
probe=4 scope=professional status=not_covered refs=0 elapsed_ms=6121
probe=1 scope=professional status=temporarily_unavailable refs=0 elapsed_ms=1772
```

The first four lines were produced with the knowledge engine running. The engine was then stopped and the fifth line verified the stable temporary-unavailable behavior. No prompts, answers, knowledge content, API keys, or raw model responses are retained in this evidence.

The accepted process invoked only the company model, PSEAgent MCP, read-only Knowledge MCP, and the local release Knowledge Engine. Judge/quality scoring, Coremail MCP, public web search, Supabase, Worker, Admin, review/publish, and knowledge writeback calls were all zero.

## Final automated verification

- `npm run typecheck`: exit 0.
- `npm test`: exit 0; PSEAgent 93 tests, Knowledge MCP 4 tests, and the complete Rust suite passed.
- `cargo fmt --manifest-path services\knowledge-engine\Cargo.toml --check`: exit 0.
- `cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings`: exit 0.
- `npm run build`: exit 0.
- `npm run test:regression`: exit 0; only `src/regression.test.ts` ran, covering 40 stable question IDs with 42 assertions.
- `git diff --check`: exit 0.

One earlier concurrent full-suite invocation encountered a transient Windows permission error while a Rust test removed its private temporary directory. The exact failing test passed immediately, and the subsequently recorded standalone Rust suite and fresh complete `npm test` both passed without source changes.

Both knowledge repositories were clean with no remotes. The three legacy source directories and both materialized knowledge repositories remained present and were not moved or deleted.

## Cleanup

- Removed the ignored `.env.local`, including the temporary company-model credential.
- Removed the complete temporary Codex bridge and diagnostic directory.
- Stopped the owned local knowledge-engine process.
- Confirmed that loopback ports `19829` and `19831` were free after cleanup.
- Did not recreate the user-deleted conflicting Docker container. Docker Desktop was not running during the final audit; the accepted pre-run absence and free `19829` listener state were preserved.
