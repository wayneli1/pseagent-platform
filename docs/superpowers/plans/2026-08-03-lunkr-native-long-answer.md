# Lunkr 原生长回答帖子实施计划

日期：2026-08-03

**目标：** 保留短回答普通文本体验，把超过 Lunkr 单条限制的最终回答改为一个
`cim.file:uploadPost` 纯文本卡片，并在帖子发送失败时安全降级为现有结构化分段。

**架构：** `LunkrApi` 只增加最小 `sendPost()` 协议适配；Bridge 继续拥有回答呈现
决策、发送重试、epoch 门禁和上下文写入；`AnswerPresenter` 继续提供确定性规范化和
文本分段；启动入口只把现有 API 实例的新方法注入 Bridge。

## 全局约束

- 只修改 `pseagent-platform` 仓库，不读取或复制旧 PSEAgent 实现。
- 用户提供的 Lunkr MCP/Skill ZIP 只作为只读协议资料，不进入运行时和 Git。
- 不修改 PSEAgent 路由、规划、知识检索、证据验证、回答格式或知识库。
- 不停止或重启正在运行的 Lunkr、Knowledge Engine 或其他服务。
- 保留 `cim.msg:reply` 的 API 级安全分段和 Bridge 的结构化分段降级。
- 不记录帖子标题以外的回答内容；运行日志继续禁止正文、UID 和凭据。
- `.sisyphus/` 和用户已修改的 `docs/local-runbook.md` 不混入无关阶段。
- 每阶段先验证，再以中文标题和包含“完成内容”“验证结果”的中文正文提交。

## 阶段 53：冻结原生长回答设计

**文件：**

- 新建 `docs/superpowers/specs/2026-08-03-lunkr-native-long-answer-design.md`
- 新建 `docs/superpowers/plans/2026-08-03-lunkr-native-long-answer.md`

**步骤：**

1. 明确短文本、长帖子和文本降级的唯一选择规则。
2. 明确 `uploadPost` 请求体、私聊限制、标题和正文规范化。
3. 明确失败、取消、上下文和至少一次投递语义。
4. 执行：

```powershell
rg -n "T[B]D|T[O]DO|F[I]XME|待[定]" docs/superpowers/specs/2026-08-03-lunkr-native-long-answer-design.md docs/superpowers/plans/2026-08-03-lunkr-native-long-answer.md
git diff --check -- docs/superpowers/specs/2026-08-03-lunkr-native-long-answer-design.md docs/superpowers/plans/2026-08-03-lunkr-native-long-answer.md
```

5. 只暂存两份新文档并提交阶段 53。

## 阶段 54：实现 Lunkr 原生帖子 API

**文件：**

- 修改 `integrations/lunkr-direct/src/lunkr-api.ts`
- 修改 `integrations/lunkr-direct/src/lunkr-api.test.ts`

**接口：**

```ts
sendPost(peerUid: string, title: string, content: string): Promise<void>;
```

**步骤：**

1. 先增加失败测试：
   - 合法私聊只发送一次 `cim.file:uploadPost`；
   - 请求体为 `{ uid, fileInfo: { title, content } }`；
   - 非 `#U`、空标题、空正文、HTTP 错误和非 `S_OK` 被拒绝；
   - 现有 `sendText()` 分段测试继续通过。
2. 运行聚焦测试并确认新增用例失败。
3. 用现有 `SecureHttpClient.lunkr()` 实现最小方法，不增加 CLI、MCP 或第二套认证。
4. 验证：

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/lunkr-api.test.ts
npm exec -w @pseagent/lunkr-direct -- tsc -p tsconfig.json --noEmit
git diff --check -- integrations/lunkr-direct/src/lunkr-api.ts integrations/lunkr-direct/src/lunkr-api.test.ts
```

5. 只暂存 API 和测试并提交阶段 54。

## 阶段 55：接入长回答选择、降级与运行说明

**文件：**

- 修改 `integrations/lunkr-direct/src/answer-presenter.ts`
- 修改 `integrations/lunkr-direct/src/answer-presenter.test.ts`
- 修改 `integrations/lunkr-direct/src/bridge.ts`
- 修改 `integrations/lunkr-direct/src/bridge.test.ts`
- 修改 `scripts/lunkr-start.mts`
- 修改 `docs/local-runbook.md`

**接口：**

```ts
interface LunkrBridgeDependencies<Result> {
  sendText(peerUid: string, text: string): Promise<void>;
  sendPost(peerUid: string, title: string, content: string): Promise<void>;
}
```

**步骤：**

1. 增加 Presenter 规范化函数测试，保证帖子正文与分段重建正文一致。
2. 增加 Bridge 测试：
   - 单段只发普通文本；
   - 多段只发一个帖子；
   - 标题包含问题编号；
   - 帖子失败三次后回退全部文本段；
   - 成功和失败时的上下文、取消门禁保持正确。
3. 运行聚焦测试并确认新增行为失败。
4. 实现 Bridge 选择与帖子重试；降级不重新调用 PSEAgent。
5. 在启动入口注入 `api.sendPost()`。
6. 在用户已有 `docs/local-runbook.md` 修改之上，只把长回答说明更新为原生帖子和
   失败降级；暂存前逐行核对，避免提交用户其他未提交段落。
7. 运行：

```powershell
npm exec -w @pseagent/lunkr-direct -- vitest run src/answer-presenter.test.ts src/bridge.test.ts src/lunkr-api.test.ts
npm exec -w @pseagent/lunkr-direct -- vitest run src
npm run typecheck
npm run test:ts
npm run build --workspaces --if-present
git diff --check
```

8. 检查 staged diff 只包含本阶段实现、测试、接线和自己修改的运行说明；提交阶段 55。

## 真实验收边界

本计划默认完成离线实现和自动化验证。真实 Lunkr 验收会改变正在运行服务状态，必须在
阶段 55 提交后报告结果并单独取得用户许可，才能停止旧进程、启动新代码和发送测试
问题。未获许可时不得自行执行真实发送。
