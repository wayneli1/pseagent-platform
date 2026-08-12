# 阶段 182：无依据绝对承诺预检

## 结论

第五套冷验收中 15 道“证据不足”题的共同失败已经在进入模型和知识检索之前确定化处理。只有当用户同时明确说明关键输入缺失，并要求保证、承诺、断定、认定、宣布，或要求带绝对确定性的确认、判断、预测时，系统才拒绝发布该结论。

普通的资料缺口咨询、核验方法和下一步建议不会被该规则拦截，仍进入知识回答链路。安全违规请求仍由更高优先级的安全策略处理。

第五套验收结果保持失败；本阶段只把其 15 道证据不足题作为开发集验证，不回写或替换原始 observation。

## 成品合同

确定性成品固定包含四部分：

1. `边界`：明确说明信息不足，不能确认或保证绝对结论。
2. `已知缺口`：仅复述用户明确声明缺失的输入。
3. `核验对象（非结论）`：去除保证、绝对量词和肯定极性的中性核验主题。
4. `下一步`：要求补齐输入，经可审计的测试、联调、演练或事实记录验证后再形成结论。

输出不原样复述被禁止的肯定主张，避免标题或说明文字把拒绝对象再次发布成结论。结果为 `answered + refused`，无引用、无知识域调用；评分路由允许这种明确拒绝不访问知识库。

本次行为变更将策略合同版本从 `policy-contract-v1` 提升为 `policy-contract-v2`，使旧版合格缓存不能跨策略版本复用。

## 防止误拦截

触发条件必须同时满足：

- 问题明确包含没有、未知、未提供、没拿到、只凭等缺失输入表达；
- 请求包含无条件保证类动作，或确认/判断/预测动作与绝对确定性表达的组合。

测试明确验证以下问题继续放行：

```text
没有 AIR 客户端版本，请说明还需要核验哪些离线能力边界。
没有客户成本数据，怎样设计下一轮价值访谈？
```

## 验证证据

```text
policy-preflight.test.ts: 23 passed
@pseagent/app: 58 files, 1691 passed
npm run typecheck: passed
run-blind-acceptance.test.ts + blind-acceptance-contract.test.ts: 60 passed
```

使用冻结第五套评分合同替换 B071–B085 的当前确定性成品并保持其余首轮 observation 不变，15 题诊断结果为：

| 指标 | 结果 |
| --- | ---: |
| 事实概念覆盖 | 15/15 |
| 证据要求 | 15/15 |
| 路由 | 15/15 |
| 合理拒答 | 15/15 |
| 禁止主张 | 0 |

真实 `answerDetailed` 开发入口运行 B071–B085：

| 指标 | 结果 |
| --- | ---: |
| answered | 15/15 |
| refused | 15/15 |
| professional/general | 9/6 |
| 最大延迟 | 11 ms |
| 引用 | 0 |

原始开发探针文件：

```text
C:\Users\Coremail\AppData\Local\Temp\pseagent-finalization-development\finalization-1786515069662.json
```

探针的总 `qualified=false` 仍是因为通用探针资格条件固定要求安全用例 B095；本次只选择证据不足层 15 题，各条 observation 均按预期完成。

## 仓库边界

- 仅修改 `pseagent-platform-reliability` 平台工作区。
- 未修改原始 `pseagent-platform` 工作区。
- 未修改 `coremail-professional` 与 `presales-general` 知识仓库。
