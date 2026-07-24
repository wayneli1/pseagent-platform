# PSEAgent Coremail 历史资料辅助回答真实验收

日期：2026-07-24

## 固定版本

- Coremail MCP 源码提交：`8422f0da7f729758a69d8f2ebb3627d13d760deb`
- PSEAgent 历史降级运行时提交：`fc115f3c426674c3051305ef261b0937153c2aae`
- 验收时 `main` 基线提交：`c70744135df814e1feca728c46d2a5c8c031de8c`
- Coremail MCP 原始 ZIP SHA-256：`AB45A26522D73A3A53249515CAA32973DE9C9CFA6143B0E4FDD498C04B13D439`
- `coremail-professional` revision：`e003c787326609afc3b6d4159e5096a8c29128ed`
- `presales-general` revision：`ca4ee0f8fb3c466378371c14bf3394c82a903281`
- Node.js：`v24.15.0`
- Cargo：`1.91.0`
- OpenCode：`1.14.39`
- 公司模型：`deepseek-v4-pro`

## 不可变运行版与认证

- `current` 指向 Coremail MCP 完整提交对应的不可变 release：`true`
- 发布入口存在：`true`
- Jira 与两个配置 Wiki 在验收前均通过会话验证：`true`
- 认证文件、账号、密码、Cookie 和认证异常正文未进入仓库或本记录：`true`

## 离线门禁

- Coremail MCP：typecheck 通过，单元测试 `5/5`，build 通过。
- PSEAgent：typecheck 通过，测试 `145/145`。
- Knowledge MCP：测试 `4/4`。
- Knowledge Engine：测试 `21/21`，格式检查和 Clippy 均通过。
- 固定回归：`44/44`。
- 平台与 Coremail MCP build：通过。
- 所有离线门禁失败数：`0`。

## 既有真实探针

```text
probe=1 scope=professional status=answered refs=1 elapsed_ms=26804
probe=2 scope=general status=answered refs=1 elapsed_ms=18980
probe=3 scope=normal status=answered refs=0 elapsed_ms=10747
probe=4 scope=professional status=not_covered refs=0 elapsed_ms=23916
```

## 历史资料真实探针

```text
historical status=not_covered main_refs=0 history_refs=1 confidence=medium raw_equal=true warning=true elapsed_ms=8833
broken_path startup=true fallback_unchanged=true
covered_query coremail_started=false
noninteractive browser_started=false
```

- PSEAgent 历史答案与 Coremail MCP 原始答案逐字符一致：`true`
- 固定历史资料警告存在：`true`
- 正式状态未提升、正式引用保持为空：`true`
- 历史来源至少一条且仅来自 Jira/Wiki：`true`
- 历史阶段没有第二模型改写路径：`true`
- Coremail MCP 失败时保留原始 `not_covered`：`true`
- 正式知识命中时不启动 Coremail MCP：`true`
- 非交互问答未启动浏览器：`true`

## 运行进程

- Knowledge Engine PID：`41540`
- OpenCode PID：`52104`
- Knowledge Engine 在 OpenCode 重启前后保持同一 PID：`true`
- OpenCode 显式使用 `pseagent` 和公司模型：`true`
- `pseagent connected`：`true`
- `coremail_air` 保持连接且未修改：`true`
- OpenCode 未直接注册 Coremail 知识 MCP：`true`

## 边界检查

- `.env.local` 被 Git 忽略：`true`
- Coremail MCP 子进程强制关闭 AI Adoption：`true`
- Coremail MCP 子进程强制关闭本地知识缓存：`true`
- Coremail MCP 子进程强制非交互认证：`true`
- 平台和 Coremail MCP 源码仓库均无 remote：`true`
- 本次未执行 push：`true`
- 验收记录未保存问题、回答、来源标题、内部链接、模型服务地址或任何凭据：`true`
