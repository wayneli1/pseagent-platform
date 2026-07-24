# OpenCode 纯净 PSEAgent 测试入口设计

日期：2026-07-24

## 背景

OpenCode 是 PSEAgent 当前的临时测试入口，正式接入目标仍是用户后续选择的聊天工具。现有 OpenCode 全局加载 `oh-my-openagent` 插件；该插件的 `keyword-detector` 会把中文“列出”等词识别为搜索命令，在用户问题前注入 `[search-mode]`。因此外层模型绕过 `pseagent_pse_answer`，改用文件搜索和公网搜索自行组织答案，违反单入口和证据约束。

内层 PSEAgent、Knowledge Engine、Knowledge MCP 和 Coremail 历史资料降级链路不在本次修改范围内。

## 目标

- PSEAgent 的临时 OpenCode 测试窗口不加载任何外部 OpenCode 插件。
- 用户问题原样进入项目定义的 `pseagent` Agent，不出现关键词提示注入。
- 每个问题只调用一次 `pseagent_pse_answer`。
- OpenCode 逐字返回 PSEAgent 工具结果，不自行搜索、扩写或重组引用。
- 继续使用现有公司模型、`pseagent` MCP 和独立的 `coremail_air` MCP。

## 方案

仅 PSEAgent 测试窗口使用 OpenCode 官方 `--pure` 启动参数：

```powershell
opencode . --pure --agent pseagent --model coremail/deepseek-v4-pro
```

该参数只影响本次 OpenCode 进程。全局 `oh-my-openagent` 插件及其配置保持不变，其他 OpenCode 用途仍可正常使用插件能力。

启动前继续从本机已忽略的 `.env.local` 加载运行变量，不把变量值复制到 OpenCode 配置、文档、日志或 Git。

## 进程处理

1. 精确识别命令行包含 `--agent pseagent` 和目标公司模型的现有非纯净 OpenCode 进程。
2. 关闭这些临时测试进程及其专用 PowerShell 宿主；OpenCode 已持久化的会话记录保留。
3. 不停止 Knowledge Engine，不占用或重建其监听端口。
4. 启动一个新的可见 PowerShell 窗口，并在其中运行纯净 OpenCode 命令。

## 验收

使用与故障记录相同的问题“列出 Coremail AI 的新功能特性”做真实复验：

- `--pure` 下仍能加载项目 `pseagent` Agent。
- `pseagent` 和 `coremail_air` 均保持连接。
- 会话中的用户文本不包含 `[search-mode]` 或其他插件注入。
- 工具调用列表只包含一次 `pseagent_pse_answer`。
- 不出现 `glob`、`grep`、`read`、`websearch` 或 GitHub 搜索调用。
- 最终文本与 `pseagent_pse_answer` 返回文本一致。
- Knowledge Engine PID 和监听状态保持不变。

如果任一条件不成立，停止验收并保留证据，不通过修改内层 PSEAgent 来掩盖 OpenCode 入口问题。

## 非目标

- 不卸载或全局禁用 `oh-my-openagent`。
- 不修改插件安装目录或 `node_modules`。
- 不修改 PSEAgent 知识问答提示词、路由、引用或历史资料逻辑。
- 不合并、变基或清理 Lunkr/OpenClaw 工作树。
- 不把 OpenCode 作为未来聊天工具接入的正式依赖。
