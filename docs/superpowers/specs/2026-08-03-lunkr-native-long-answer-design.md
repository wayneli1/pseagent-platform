# Lunkr 原生长回答帖子设计

日期：2026-08-03

状态：已确认，待实施

## 1. 背景

当前 Lunkr Direct 在回答超过 `LUNKR_MESSAGE_MAX_CHARS`（默认 1,000 字符）时，
由 `AnswerPresenter` 生成带 `问题 #N（i/总数）` 前缀的多个文本段，再逐段调用
`cim.msg:reply`。该方式保证了消息不超限和引用顺序稳定，但一个完整回答会占据多个
聊天窗口，阅读和视觉体验不佳。

用户提供的 `lunkr-mcp-export-20260226_163948.zip` 证明 Lunkr 已提供
`cim.file:uploadPost` 长消息接口。参考实现对超过 1,000 字符的消息自动调用该接口，
请求只包含接收者 UID，以及带标题和正文的 `fileInfo`。Lunkr 客户端把结果显示为
支持在线预览和下载的纯文本卡片。`lunkr-skill.zip` 的通用 `sendfile` 能力仅作为
附件协议参考；机器人长回答不需要创建或上传本地临时文件。

## 2. 目标

- 短回答继续使用现有 `cim.msg:reply`，保持聊天内直接可读。
- 原本需要两个或更多文本段的长回答改为一个原生纯文本帖子卡片。
- 帖子标题稳定包含问题编号，便于用户识别、预览和下载。
- 帖子正文保持完整回答、引用顺序、资料来源和历史资料提示不变。
- 帖子发送失败时降级到现有结构化文本分段，避免丢失已经生成的回答。
- 只有最终回答完整发送成功后才写入连续对话上下文。
- 不改变 PSEAgent 路由、规划、检索、证据审计、回答状态或知识库逻辑。

## 3. 非目标

- 不把 Lunkr MCP、Skill CLI 或其二进制加入运行时依赖。
- 不实现用户上传附件、群聊、图片、文件或语音问答。
- 不为长回答创建本地 TXT 临时文件。
- 不改变即时回执、排队、问题编号、`/new`、重试预算或会话隔离语义。
- 不在本阶段停止、重启或真实发送当前运行中的 Lunkr 服务。

## 4. 协议选择

### 4.1 短回答

先用现有 `presentAnswer(questionId, answer, messageMaxChars)` 完成引用排序、来源排序、
换行规范化和长度计算。若返回数组只有一项，继续调用：

```text
cim.msg:reply
```

用户看到：

```text
问题 #13 的回答：

<回答正文>
```

### 4.2 长回答

若 `presentAnswer()` 返回两个或更多分段，不再逐段发送。改为调用：

```text
cim.file:uploadPost
```

请求体：

```json
{
  "uid": "<原私聊用户 UID>",
  "fileInfo": {
    "title": "PSEAgent 问题 #13 的完整回答.txt",
    "content": "<规范化后的完整回答正文>"
  }
}
```

正文使用与短回答一致的 `normalizeCitationOrder()` 结果，但不加入分段编号。问题编号
由标题承载。帖子发送仍只允许目标为 `#U` 私聊用户，并通过现有
`SecureHttpClient`、Session、Cookie、TLS 和域名限制发送。

### 4.3 失败降级

帖子发送沿用现有三次短重试。全部失败后，在确认任务 epoch 仍有效的前提下，回退到
`presentAnswer()` 已生成的结构化分段，并逐段调用 `sendText()`。降级不重新调用
PSEAgent，也不改变答案正文。

若降级分段仍有任一段发送失败，本题不写入上下文，错误按现有脱敏路径上抛。由于
Lunkr 协议没有提供本项目已确认可用的幂等键，网络响应丢失时帖子重试或降级存在极低
概率的重复显示风险；本阶段保持与现有文本发送相同的至少一次投递语义。

## 5. 组件边界

### 5.1 `LunkrApi`

新增：

```ts
sendPost(peerUid: string, title: string, content: string): Promise<void>;
```

职责仅包括私聊 UID 校验、空标题/正文拒绝、调用 `cim.file:uploadPost` 和校验
`S_OK`。它不决定回答长短、不生成标题、不修改正文，也不负责文本降级。

### 5.2 `LunkrPseBridge`

依赖新增：

```ts
sendPost(peerUid: string, title: string, content: string): Promise<void>;
```

Bridge 在格式化完整答案后选择文本或帖子，负责帖子标题、重试、epoch 门禁、失败
降级和成功后的上下文写入。

### 5.3 `AnswerPresenter`

保留现有 `presentAnswer()` 作为短回答呈现和帖子失败降级实现。新增或复用一个只做
引用、来源和换行规范化的公开函数，保证帖子正文与分段正文的字符内容一致。

### 5.4 启动接线

`scripts/lunkr-start.mts` 把同一个 `LunkrApi` 实例的 `sendText()` 和 `sendPost()`
注入 Bridge。不得启动 MCP 子进程或 Skill CLI，也不得建立第二套 Lunkr Session。

## 6. 用户可见行为

| 条件 | 最终回答形态 |
|---|---|
| 加前缀后不超过单条限制 | 一条普通文本消息 |
| 需要两个或更多文本段 | 一张可在线预览的 TXT 长回答卡片 |
| 长帖子发送失败但文本降级成功 | 原有带 `i/总数` 的多段文本 |
| 长帖子和文本降级均失败 | 不写上下文，按现有发送错误处理 |

即时“已收到问题 #N”回执和排队开始提示保持原样，因此本设计只减少最终回答占用的
消息窗口数量。

## 7. 测试与验收

### 7.1 API 单元测试

- `sendPost()` 只向 `#U` 私聊发送一个 `cim.file:uploadPost` 请求。
- 请求体严格包含 `uid` 和 `fileInfo.title/content`。
- HTTP、业务码、空标题、空正文和非私聊 UID 失败。
- `sendText()` 的现有安全分段行为不变。

### 7.2 Bridge 单元测试

- 单段回答只调用 `sendText()`，不调用 `sendPost()`。
- 多段回答只调用一次 `sendPost()`，不发送回答分段。
- 帖子标题包含正确问题编号和 `.txt` 后缀。
- 帖子正文保持规范化引用、资料来源和全部回答字符。
- 帖子三次失败后按现有分段顺序降级。
- 帖子成功、降级成功后写入的上下文仍是不含标题和编号前缀的答案正文。
- 发送失败和 `/new` 取消不写上下文，不回发旧 epoch 结果。

### 7.3 自动化验收

- Lunkr Direct 全量 Vitest、TypeScript typecheck 和 build 通过。
- PSEAgent TypeScript 回归不受影响。
- `git diff --check` 和秘密扫描通过。

### 7.4 真实验收

真实发送需要用户另行允许重启当前 Lunkr 前台进程。验收至少包含：

1. 短回答仍为一条普通文本；
2. 长回答只出现一张 TXT 卡片，标题问题编号正确；
3. 在线预览包含完整正文、引用和资料来源；
4. 连续追问仍使用纯答案正文作为上下文；
5. 运行日志不包含回答正文、原始 UID 或凭据。
