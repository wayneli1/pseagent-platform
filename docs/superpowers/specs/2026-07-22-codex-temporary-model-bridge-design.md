# Codex 临时本机模型桥接设计

**状态：** 已由用户于 2026-07-22 批准。

## 目标

在无法访问公司模型的本机环境中，用当前已登录的 Codex CLI 临时完成 PSEAgent 第 13 阶段真实问答验收。验收后删除桥接程序、临时环境文件和输出，不把 Codex 提供方加入正式运行时代码；公司 OpenAI-compatible 模型接口保持不变。

Codex 官方的非交互模式支持 `codex exec`、复用已保存的 CLI 登录、`--ephemeral`、只读 sandbox 和机器可读输出：<https://learn.chatgpt.com/docs/non-interactive-mode>。

## 非目标

- 不提交 `CodexCliModelClient` 或长期模型切换功能。
- 不改变路由、Agent Loop、引用规则或知识库边界。
- 不使用固定假模型代替真实问答。
- 不读取、复制或提交 Codex 登录凭据。
- 不停止或删除与本次端口冲突无关的容器。

## 架构

临时桥接程序位于系统临时目录并只监听 `127.0.0.1` 的临时端口，对 PSEAgent 暴露最小的 `POST /v1/chat/completions` 接口。现有 `OpenAiCompatibleModelClient` 不做任何改动，只通过临时 `.env.local` 把 `PSE_MODEL_BASE_URL` 指向桥接地址。

每个请求按以下流程处理：

1. 严格校验 Chat Completions 请求大小、消息角色和必需字段。
2. 把 system/user/assistant 消息按明确分隔符组装成一次性提示，并声明不得使用工具、不得读取本机文件。
3. 在独立空临时目录中通过 stdin 调用 `codex exec -`，使用 `--ephemeral --sandbox read-only --ignore-user-config --ignore-rules --skip-git-repo-check --color never`。
4. JSON 请求要求只输出 JSON；普通请求要求只输出最终文本。桥接只读取 Codex 最终消息，不转发进度、stderr、推理或会话标识。
5. 把最终文本包装成现有客户端需要的 `choices[0].message.content` 响应。

桥接串行执行请求，单次 Codex 子进程有明确超时和取消；PSEAgent Agent Loop 本身仍负责最多 8 轮、4 次检索和失败收口。临时 live probe 的 MCP 请求超时单独放宽，以容纳 Codex CLI 的启动和网络回退延迟，不改变正式 OpenCode 配置的 180 秒限制。

## 安全与生命周期

- 桥接仅绑定 loopback，不接受远端连接，API key 使用无敏感性的本机占位值。
- Codex 子进程运行在空目录、只读 sandbox 中，并忽略用户配置和规则；它只能看到本次消息中显式提供的上下文。
- stderr 被排空但不回显，日志不包含问题、回答、知识正文、访问令牌或 Codex 会话信息。
- 启动前记录 `pseagent-knowledge-engine-phase1` 容器是否正在运行；只在其确实运行时临时停止，验收 `finally` 中恢复同一容器。
- 新 Rust 引擎使用 release 构建、两个目标仓库当前 HEAD 和本机只读 token；健康检查必须同时验证 `status=ready`、两个项目名及 revision，防止误连旧引擎。
- 故障演练停止本次保存 PID 的新引擎，只调用一个专业问题并验证固定 unavailable 文本；随后清理桥接、临时 `.env.local`、临时输出和本次进程。
- 若原先已存在 `.env.local`，先备份并在结束时原样恢复；当前环境经检查不存在该文件。

## 错误处理

- Codex CLI 非零退出、超时、空输出、非 JSON 输出或过大输出统一返回稳定的上游失败，不泄漏 stderr。
- 桥接启动失败时不停止旧容器；旧容器已停止后发生任何失败都必须进入恢复逻辑。
- 若专业问题不能引用 `wiki/concepts/coremail-ai助手.md`，立即停止验收并诊断，不放宽引用校验或启用模型先验兜底。
- 如果旧容器恢复失败，保留明确的容器 ID 和状态并立即报告，不把第 13 阶段标记完成。

## 测试与验收

桥接实现遵循 TDD：先在系统临时目录创建 Node 内置测试，覆盖 loopback 绑定、请求校验、消息组装、Codex 参数、JSON/文本包装、超时、错误脱敏和幂等关闭；确认测试因桥接模块缺失而失败后，再实现最小桥接并运行通过。桥接不进入仓库。

真实验收顺序：

1. 验证本机 Codex CLI 登录和最小非交互输出。
2. 临时停止并记录旧容器。
3. 启动新 release Knowledge Engine，并验证真实 revision、search 和 read。
4. 启动临时 Codex 桥接和 PSEAgent，运行四条 live probe。
5. 停止新引擎，运行专业问题 unavailable probe。
6. 在 `finally` 中删除临时桥接和环境文件、停止本次进程并恢复旧容器。
7. 运行全量 TypeScript/Rust 检查和三仓库清洁检查，写入实际验收记录，再提交第 13 阶段。

成功标准保持原计划不变：P01 为 professional 且 answered/partially_answered 并至少一个有效专业引用；G01 为 general/not_covered；N02 为 normal/answered；M03 为 professional/not_covered；引擎停止后的专业问题为 temporarily_unavailable 且无引用。所有摘要只记录 scope、status、引用数和耗时。
