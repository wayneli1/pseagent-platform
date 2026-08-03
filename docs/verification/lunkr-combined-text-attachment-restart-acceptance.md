# 论客文字附件同窗发送与重启验收记录

日期：2026-08-03

## 验收对象

- 协议设计提交：`e63da4ebca9b1c8302ee75620f7ee8163821c4cf`
- 实现提交：`6d4f41e9d65445c65d358a9c1477819cf1158674`
- 分支：`feature/lunkr-direct-integration`

## 实现结果

- 长回答不再提前发送独立概览消息。
- TXT 正文以内存 UTF-8 字节上传，不创建临时文件。
- 上传流程依次调用 `cim.file:prepare`、`cim.file:directData`、`cim.file:moveToNetFolder`。
- 最终通过一次 `cim.msg:reply` 同时提交 `content` 和 `attachments`，使内容概览与 TXT 附件属于同一条论客消息。
- 最终回复最多重试 3 次，所有重试复用同一个 `clientMid`，不重复上传文件。
- 组合流程失败时降级为独立 `cim.file:uploadPost`；独立 TXT 再失败时提示并分段发送。
- 概览文案中的“见下方 TXT 附件”已改为“见附件”，适配同窗布局。

## 自动化验证

- HTTP 客户端测试验证二进制正文未被 JSON 序列化、查询参数和 Cookie 正确。
- Lunkr API 测试验证中文 UTF-8 字节数、四步请求体、Cookie 更新、稳定 `clientMid` 重试、输入限制和缺失 ID 失败。
- Bridge 测试验证组合成功、独立 TXT 降级和分段文本降级。
- PSE 工作区：465 项测试通过。
- Knowledge MCP 工作区：5 项测试通过。
- 论客直连工作区：140 项测试通过。
- TypeScript 全量共 610 项测试通过。
- 三个 TypeScript 工作区类型检查通过。
- 论客生产构建通过。
- `git diff --check` 通过。

## 安全重启

- 重启前最后一个问题事件为 `answered`，无处理中的问题。
- 精确停止旧机器人主进程 PID `20000` 及其专属进程树。
- 未停止独立 Knowledge Engine，未重启论客桌面客户端。
- 新机器人主进程 PID：`95896`。
- 新进程启动时间：`2026-08-03 15:00:30 +08:00`。
- 新日志：`C:\Users\Coremail\AppData\Local\Temp\pseagent-lunkr-combined-20260803-1500.stderr.log`。
- 就绪顺序：`lunkr.socket.connected` → `lunkr.socket.authenticated` → `pseagent.lunkr.ready`。

## 运行状态

- 论客机器人主进程数：1。
- 运行代码已确认暴露 `sendTextFile` 组合附件方法。
- 论客账号：`configured=true`、`valid=true`。
- Knowledge Engine：`status=ready`。
- `coremail-professional` 和 `presales-general` 的词法索引、图索引均为 `ready`。

## 结论

文字与 TXT 附件同窗发送已经部署到当前机器人。未主动向任何联系人发送验收消息；最终客户端视觉效果由用户下一次长回答测试确认。重启清空了内存会话状态，下一次提问编号从 `#1` 开始。
