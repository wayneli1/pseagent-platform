# PSEAgent 知识回答深度提示词真实验收

日期：2026-07-23

## 变更边界

- 仅扩充内层 PSEAgent 的知识问答系统提示词。
- 未修改 OpenCode、路由、接口、Knowledge Engine 或知识库内容。
- 回答深度按问题类型自适应，并继续受知识证据边界、引用和 coverage 契约约束。

## 固定版本

- `coremail-professional`：`e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general`：`ca4ee0f8fb3c466378371c14bf3394c82a903281`
- 公司模型：`deepseek-v4-pro`
- Node.js：`v24.15.0`
- Cargo：`1.91.0`
- OpenCode：`1.14.39`

## 测试驱动验证

- 首次红灯：新增回答深度契约测试后，因提示词尚未包含“在已读取的知识证据范围内充分回答用户问题”而按预期失败。
- 首次绿灯：加入事实、方法、方案/部署/架构、用户深度要求和证据边界规则后，定向测试 12/12 通过。
- 真实模型验收发现方案答案未稳定显式给出风险与待确认项；先补强测试，测试按预期转红。
- 提示词进一步要求详细方案显式包含“主要风险”和“待确认项”，证据不足时明确标记“知识证据不足，待确认”；定向测试恢复为 12/12 通过。

## 离线门禁

- `npm run typecheck`：通过。
- `npm test`：PSEAgent 96、Knowledge MCP 4、Knowledge Engine 21，失败数均为 0。
- `cargo fmt --manifest-path services\knowledge-engine\Cargo.toml -- --check`：通过。
- `cargo clippy --manifest-path services\knowledge-engine\Cargo.toml --all-targets -- -D warnings`：通过。
- `npm run build`：通过。
- `cargo build --release --manifest-path services\knowledge-engine\Cargo.toml`：通过。
- `npm run test:regression`：44/44 通过。
- `git diff --check`：通过。

一次提交前的默认 `npm test` 在既有 `http_api` 测试夹具清理阶段遇到临时目录 `NotFound`。根因是并行测试使用进程号、同名项目和时钟值拼接临时目录，可能在 Windows 时钟粒度下发生同名碰撞；串行隔离复测 2/2 通过，随后不加串行参数的默认全量套件也通过。本次按提示词限定范围未修改 Rust 测试代码。

## Knowledge Engine

- 发布版进程 PID：`41540`。
- `/health`：`ready`，项目数 2，两个项目的 revision 均与上述固定版本完全一致。
- 验收过程中未重启或替换 Knowledge Engine。

## 公司模型真实探针

既有四类探针的脱敏结果：

```text
probe=1 scope=professional status=answered refs=1 elapsed_ms=21508
probe=2 scope=general status=partially_answered refs=1 elapsed_ms=26839
probe=3 scope=normal status=answered refs=0 elapsed_ms=7885
probe=4 scope=professional status=not_covered refs=0 elapsed_ms=4868
```

首次全量探针的第 4 项遇到一次 `temporarily_unavailable`；隔离复测返回预期的 `not_covered`，随后全量重跑得到上述结果，因此未据此修改代码。

回答深度对比的脱敏结果：

```text
fact concise=true refs=1
method brief refs=1
method detailed richer=true steps=true cautions=true refs=2
solution expanded=true implementation=true risks=true confirmations=true refs=1
```

补强提示词后的方案单项复测：

```text
status=partially_answered refs=2 expanded=true implementation=true risks=true confirmations=true chars=5124
```

验收记录只保存状态、引用数量、结构布尔值、耗时和长度，不保存测试问题、模型回答或知识正文。

## OpenCode

- 可见交互进程 PID：`12088`。
- 启动时显式使用 `pseagent` agent 和 `coremail/deepseek-v4-pro`。
- `opencode mcp list`：`pseagent connected`。
- PSEAgent 子进程已从当前构建重新启动；Knowledge Engine 保持原进程运行。

## 边界检查

- `.env.local` 受 Git 忽略；验收记录和提交不包含 endpoint、密钥、问题正文、回答正文或知识正文。
- `.sisyphus`、生成索引和临时日志不进入提交。
- 两个知识库仓库未修改。
- 三个仓库均未配置 remote，本次不执行 push。
