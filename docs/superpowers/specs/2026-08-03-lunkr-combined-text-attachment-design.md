# 论客长回答文字与附件组合消息设计

日期：2026-08-03

## 背景

当前长回答先通过 `cim.msg:reply` 发送内容概览，再通过 `cim.file:uploadPost` 发送 TXT 卡片。两个接口各自产生一条消息，因此论客必然显示为两个独立窗口。

用户提供的 Lunkr MCP 导出项目包含 `sendfile` 实现，证明论客支持在一次 `cim.msg:reply` 中同时提交 `content` 和 `attachments`。本次改为真实 TXT 附件上传，再用组合回复一次性发送概览和附件。

## 目标效果

同一个论客消息窗口中依次显示：

```text
问题 #1 已处理完成
本次回答涵盖：压测场景设计、关键性能指标、协议服务分析。完整内容见附件。

[问题#1-完整回答.txt]
```

短回答逻辑保持不变。

## 原生四步协议

### 1. 准备上传

调用 `cim.file:prepare`：

- `uid`：私聊场景使用机器人自己的 `selfUid` 作为网盘归属。
- `composeId`：本次上传的唯一组合标识。
- `fileName`：`问题#N-完整回答.txt`。
- `size`：UTF-8 编码后的字节数，而不是 JavaScript 字符数。
- `contentType`：`text/plain`，与 MCP 对 `.txt` 的 MIME 检测结果保持一致；正文编码仍固定为 UTF-8。

响应必须为 `S_OK` 且包含 `attachmentId`。

### 2. 上传二进制正文

向 `cim.file:directData` 发送 UTF-8 字节：

- 请求体使用 `application/octet-stream`，不得 JSON 序列化。
- 查询参数包含 `composeId`、`attachmentId`、`offset=0` 和上传归属 UID。
- 请求仍受 HTTPS、连接超时和会话 Cookie 约束。
- 合并响应中的 `Set-Cookie`，供后续步骤继续使用。

### 3. 转入网盘

调用 `cim.file:moveToNetFolder`，响应必须为 `S_OK` 且包含 `fileId`。保存响应中的附件 UID；未返回时按 MCP 参考实现使用空字符串。

### 4. 发送组合消息

调用一次 `cim.msg:reply`：

```json
{
  "uid": "对方 UID",
  "clientMid": "稳定的 UUID",
  "content": "内容概览",
  "attachments": [
    { "fileId": "上传结果", "uid": "附件 UID" }
  ]
}
```

`content` 和 `attachments` 位于同一请求体中，因此客户端将其渲染在同一个消息窗口。

## 重试与降级

1. 四步组合上传只创建一次附件。
2. 最终 `cim.msg:reply` 可使用同一个 `clientMid` 重试，避免重传文件并利用服务端消息去重能力。
3. 组合流程仍失败时，降级为现有 `cim.file:uploadPost` 独立 TXT 卡片。
4. 独立 TXT 连续失败时，发送附件失败提示，再降级为编号分段文本。
5. 组合发送前不再单独发送概览，避免正常路径出现两个窗口，也避免上传前遗留孤立提示。

## 接口调整

- `SecureHttpClient` 增加原始二进制请求并解析 JSON 响应的能力。
- `LunkrApi` 增加“概览 + UTF-8 TXT”组合发送方法，保留现有 `sendPost` 作为降级。
- `LunkrBridgeDependencies` 增加组合附件发送依赖。
- `scripts/lunkr-start.mts` 把组合发送依赖装配到实际 Lunkr API。

## 安全与边界

- 继续只允许 `#U` 私聊目标。
- 文件名、正文和概览均不能为空。
- 概览必须在单条普通消息上限内；不对概览做再次分段，否则无法保持单窗口。
- 所有端点继续限制为配置中的 HTTPS Lunkr 基地址。
- 不在磁盘创建临时 TXT，直接上传内存中的 UTF-8 字节。
- 保留原有整题时限、问答逻辑、上下文存储和事件记录。

## 验收标准

- HTTP 客户端测试证明二进制正文未被 JSON 化，查询参数、Cookie 和响应解析正确。
- Lunkr API 测试逐步验证 `prepare`、`directData`、`moveToNetFolder`、组合 `reply` 的请求体。
- 测试覆盖中文 UTF-8 字节数、缺少 `attachmentId/fileId`、任一步骤失败及输入限制。
- Bridge 测试证明成功路径不再单独发送概览，组合失败降级独立 TXT，独立 TXT 再失败才分段。
- TypeScript 全量测试、三个工作区类型检查和 `git diff --check` 通过。
- 机器人重启后保持单实例，连接、认证、ready、账号和 Knowledge Engine 状态正常。
