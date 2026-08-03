# 论客组合附件数字标识修复与现场验收

日期：2026-08-03

## 现场现象

用户在 15:06 再次测试后仍只看到独立 TXT 卡片，且没有内容概览。机器人日志显示回答本身成功，因此可以确定组合附件路径失败并触发了 `cim.file:uploadPost` 降级。

## 根因

使用机器人自身 UID 执行真实组合附件自测时，捕获到错误：

```text
attachmentId.trim is not a function
```

Lunkr 当前生产环境的 `cim.file:prepare` 将 `attachmentId` 返回为 JSON 数字；用户提供的 MCP 参考实现和初版代码都把它假定为字符串。初版代码调用 `.trim()` 后抛出异常，桥接层按照设计降级为独立 TXT，所以客户端表现为没有概览的单独卡片。

## 修复内容

- `attachmentId` 和 `fileId` 同时兼容非空字符串与有限数字。
- 数字标识统一转换成字符串，用于查询参数、入库请求和最终附件引用。
- 非字符串附件 UID 安全降级为空字符串，与 MCP 参考实现一致。
- 回归测试使用数字 `attachmentId`，覆盖真实生产响应形态。
- 回答完成日志增加 `deliveryMode`：
  - `combined_attachment`
  - `standalone_post`
  - `segmented_text`
  - `text`

## 真实接口自测

修复后再次使用机器人自身 UID 调用完整流程：

1. `cim.file:prepare`
2. `cim.file:directData`
3. `cim.file:moveToNetFolder`
4. `cim.msg:reply`，同时包含 `content` 和 `attachments`

最终返回：

```json
{"ok":true}
```

这次验证实际访问了 Lunkr 生产接口，不是模拟响应；没有向用户聊天窗口发送诊断消息。

## 自动化验证

- PSE 工作区：465 项测试通过。
- Knowledge MCP 工作区：5 项测试通过。
- 论客直连工作区：140 项测试通过。
- TypeScript 全量共 610 项测试通过。
- 三个 TypeScript 工作区类型检查通过。
- 论客生产构建通过。
- `git diff --check` 通过。

## 部署状态

- 修复提交：`4c9beac62390da95a01f7f7c664bbdd30cbe51d2`
- 重启前最后事件为 `answered`，无处理中的问题。
- 旧机器人主进程 PID：`95896`。
- 新机器人主进程 PID：`101944`。
- 新进程启动时间：`2026-08-03 15:12:53 +08:00`。
- 新日志：`C:\Users\Coremail\AppData\Local\Temp\pseagent-lunkr-combined-fix-20260803-1513.stderr.log`。
- 就绪顺序：`lunkr.socket.connected` → `lunkr.socket.authenticated` → `pseagent.lunkr.ready`。
- 机器人主进程数：1。
- 论客账号：`configured=true`、`valid=true`。
- Knowledge Engine 及两个知识库索引均为 `ready`。

## 结论

导致组合附件必然降级的生产响应类型差异已经修复，新代码已部署。用户下一次长回答完成后，日志中的 `deliveryMode` 可直接确认实际走的是组合附件还是降级路径。
