# 可配置问题时限与机器人重启验收记录

日期：2026-08-03

## 验收对象

- 阶段 68 设计提交：`4393ff8d1e2f666c570bd02c70eae38631e08092`
- 阶段 69 实现提交：`0fde8973fdacfdb65bf4c9323cececc8e26d467c`
- 分支：`feature/lunkr-direct-integration`

## 自动化验证

- PSE 工作区：21 个测试文件、465 项测试通过。
- Knowledge MCP 工作区：2 个测试文件、5 项测试通过。
- 论客直连工作区：16 个测试文件、131 项测试通过。
- TypeScript 合计：39 个测试文件、601 项测试通过。
- 三个 TypeScript 工作区类型检查全部通过。
- `git diff --check` 通过。

说明：阶段 69 提交信息中的“603 项”是根据两次定向命令输出相加得到，定向命令实际仍各自执行了整个工作区，因而重复计算了 2 项；以全量命令的 601 项为最终准确结果。

## 本机配置

`.env.local` 已配置且经实际配置解析器读取确认：

- `PSE_MODEL_TIMEOUT_MS=180000`
- `PSE_ACTIVE_DEADLINE_MS=540000`
- `PSE_REQUEST_TIMEOUT_MS=570000`
- `LUNKR_QUESTION_BUDGET_MS=600000`

顺序满足 `180 秒单次模型 < 540 秒主动收尾 < 570 秒 PSE 请求 < 600 秒论客整题`。`.env.local` 被 Git 忽略，未提交密钥或本机凭据。

## 安全重启

- 重启前精确核对旧机器人主进程 PID `91776` 及其专属子进程树。
- 仅停止该论客机器人进程树；未停止独立 Knowledge Engine，未重启论客桌面客户端。
- 新机器人主进程 PID：`9800`。
- 新进程启动时间：`2026-08-03 14:16:42 +08:00`。
- 新标准错误日志：`C:\Users\Coremail\AppData\Local\Temp\pseagent-lunkr-1386ca243bbf41e2949df96b66b6c90c.stderr.log`。
- 日志就绪顺序：`lunkr.socket.connected` → `lunkr.socket.authenticated` → `pseagent.lunkr.ready`。

## 运行状态

- 论客机器人主进程数：1。
- 论客账号配置状态：`configured=true`、`valid=true`。
- 账号：`ud20@coremail.cn`，UID：`#26605007#U`。
- Knowledge Engine：`status=ready`。
- `coremail-professional`：词法索引和图索引均为 `ready`。
- `presales-general`：词法索引和图索引均为 `ready`。

## 结论

新时限配置已经进入当前运行中的论客机器人。复杂问题现在最多可使用 540 秒完成 Agent 主动收尾、570 秒完成 PSE 请求，论客层保留到 600 秒；超过 1000 字的成功回答仍沿用 `.txt` 上传逻辑，上传失败才降级为分段文本。

重启会清空内存会话状态，因此用户下一次提问的问题编号会重新从 `#1` 开始。
