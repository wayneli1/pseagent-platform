# 通用售前知识库真实验收记录

日期：2026-07-23

## 固定版本

- `coremail-professional`: `e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general`: `60d88323b8d6a464f5fc7810846af618ed052d70`
- 公司模型：`deepseek-v4-pro`
- Node.js：`v24.15.0`
- Cargo：`1.91.0`
- OpenCode：`1.14.39`

本记录不包含模型地址、API Key、本机 bearer token、完整问题、答案正文或知识页正文。

## 离线验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过：PSEAgent 94 项、Knowledge MCP 4 项、Knowledge Engine 21 项 |
| `cargo fmt --manifest-path services\knowledge-engine\Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings` | 通过 |
| `npm run build` | 通过 |
| `cargo build --release --manifest-path services\knowledge-engine\Cargo.toml` | 通过 |
| `npm run test:regression` | 通过：43 项断言、40 个固定问题 ID |
| `git diff --check` | 通过 |

一次并行运行 `cargo test` 与 `cargo clippy` 时，Windows 共享 target 目录出现瞬时测试产物缺失；失败用例单独复现通过，后续 Rust 验证保持串行。

新鲜全量验证还复现了 bootstrap 测试夹具的临时目录碰撞：同一进程的并行测试在 Windows 时钟未前进时可能得到相同路径。先以固定相同时间戳的测试确认 RED，再给测试专用目录名追加进程内原子序号；聚焦测试及完整测试随后通过。生产 bootstrap 行为未改变。

## Knowledge Engine

- release 进程 PID：`70440`
- 健康状态：`ready`
- 健康响应只包含两个预期项目，且 revision 与“固定版本”一致。
- 通用库认证 search：HTTP 200，revision 匹配，返回 5 个候选并包含目标页。
- 通用库认证 read：HTTP 200，项目、revision、目标路径匹配，正文非空，内容哈希为合法 64 位十六进制值。
- 端口 `19829` 只有该引擎监听。

## 公司模型只读探针

| 序号 | scope | status | 引用数 | 耗时 |
|---|---|---|---:|---:|
| 1 | `professional` | `answered` | 1 | 20292 ms |
| 2 | `general` | `answered` | 2 | 48557 ms |
| 3 | `normal` | `answered` | 0 | 7486 ms |
| 4 | `professional` | `not_covered` | 0 | 6146 ms |

探针同时校验了引用项目、revision、内容哈希，以及 `not_covered` 的固定文本。没有启用跨库检索、独立 judge、评分、Coremail MCP、公网兜底、Supabase、Worker 或知识写回。

## OpenCode

- `opencode mcp list`：`pseagent connected`
- 非交互 G01：实际调用 `pseagent_pse_answer` 并返回带通用库引用的答案。
- 交互进程 PID：`39532`
- 验收结束时，OpenCode 交互进程和 Knowledge Engine 均保持运行，供用户继续测试。

## 仓库与本机状态

- 专业库保持固定 revision 且无修改。
- 通用库保持固定 revision 且无修改。
- `.env.local` 继续由 Git 忽略，只用于用户要求的本机测试。
- 生成索引和既有 `.sisyphus` 运行目录不进入提交。
- 三个仓库均未创建 remote，未执行 push。
