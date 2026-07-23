# 通用售前知识库第二批更新真实验收

日期：2026-07-23

## 固定版本

- `coremail-professional`: `e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general`: `ca4ee0f8fb3c466378371c14bf3394c82a903281`
- 公司模型：`deepseek-v4-pro`
- Node.js：`v24.15.0`
- Cargo：`1.91.0`
- OpenCode：`1.14.39`

## 离线门禁

- `npm run typecheck`: 通过。
- `npm test`: PSEAgent 95、Knowledge MCP 4、Knowledge Engine 21，失败数均为 0。
- `cargo fmt --manifest-path services\knowledge-engine\Cargo.toml -- --check`: 通过。
- `cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings`: 通过。
- `npm run build`: 通过。
- `cargo build --release --manifest-path services\knowledge-engine\Cargo.toml`: 通过。
- `npm run test:regression`: 44/44 通过。
- `git diff --check`: 通过。

G03 的数据集断言先在旧 `not_covered` 契约上失败，随后仅通过更新该用例的状态、四项 SPIN 必需事实和允许来源页转绿。

## Knowledge Engine

- 发布版进程 PID：`41540`。
- `/health`: `ready`，项目数 2，两个项目 revision 均与上述固定版本完全一致。
- 鉴权搜索：项目和 revision 正确，返回 10 条，`wiki/concepts/spin四类问题.md` 排名第 1。
- 鉴权读页：项目、revision、路径均正确；正文非空；内容哈希为有效的 64 位十六进制值。

## 公司模型真实探针

`npm run probe:live` 的脱敏结果：

```text
probe=1 scope=professional status=answered refs=1 elapsed_ms=31037
probe=2 scope=general status=partially_answered refs=1 elapsed_ms=33894
probe=3 scope=normal status=answered refs=0 elapsed_ms=12976
probe=4 scope=professional status=not_covered refs=0 elapsed_ms=6558
```

## OpenCode

- `opencode mcp list`: `pseagent connected`。
- 显式使用 `coremail/deepseek-v4-pro` 的非交互调用成功；`pseagent_pse_answer` 被调用一次，返回结果包含 1 条 `presales-general` 来源。
- 一次使用 OpenCode 全局默认外层模型的预检查在工具调用前停滞；已只停止该次测试的进程树。显式固定公司模型后的必需验收通过。
- 可见交互窗口 PID：`44792`，启动时显式使用 `pseagent` agent 和 `coremail/deepseek-v4-pro`。

## 边界检查

- `.env.local` 受 Git 忽略，未记录或提交 endpoint、密钥、问题、答案和知识正文。
- `.sisyphus`、生成索引和临时日志不进入提交。
- `coremail-professional` 未修改、未重新解析。
- Challenger Sale 与 JOLT Effect 当前仅提交为不可变来源底稿，不作为已激活回答证据。
- 三个仓库均未配置 remote，本次没有 push。
