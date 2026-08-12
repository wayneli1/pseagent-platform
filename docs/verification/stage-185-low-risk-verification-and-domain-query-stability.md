# 阶段 185：低风险验证与分域检索稳定性

## 结论

B053 在阶段 184 后已稳定执行两个知识域，但三次回答中仍有一次缺少专业迁移边界。根因由三个机制叠加：

1. “责任人”被宽泛的“责任”规则误标为高风险，触发不必要的双重一致性裁决；
2. 专业域和通用域使用同一整句查询，专业库可能检到“结构化与非结构化数据交换”等表面相关页面；
3. 低风险 claim 若被模型复核全部剔除，正式证据虽已读取仍不会形成成品。

修复后三次关闭缓存串行运行均完整通过。

## 实施

### 风险语义收窄

- `责任人`、RACI、项目交接责任分工保持低风险；
- 合同、法律、法定、违约、赔偿语境中的责任，以及责任归属、承担、认定、边界仍为高风险；
- 高风险双重一致性裁决门槛不变。

### 混合域查询隔离

确定性混合域问题在最终领域计划中增加领域专用首查：

- 专业域提取产品、迁移、版本、协议、部署等技术线索；
- 通用域提取售前、交付、价值、风险、责任人、范围等治理线索；
- 专用查询最多占一个既有查询位，总查询数仍不超过 3；
- 线索同时加入 evidence aspect terms，总数仍不超过 8。

B053 的首查分别为：

```text
coremail-professional: 个人配置 邮件 迁移
presales-general: 售前 交付 结构化移交 风险 责任人 用户动作 可迁项
```

### 低风险验证后补位

仅当“义务-域”满足以下全部条件时，用已读正式页面的精确段落补位：

- 最终零条可发布 claim；
- 存在绑定到该义务和域的正式证据；
- 风险为 low；
- 非 customer_input；
- 非答案卡模板替代路径。

高风险验证拒绝不会被该机制绕过；部分 aspect 缺失但仍有 claim 时也不会补位，因此真实不完整仍保持 partial。

## 验证证据

```text
domain-plan.test.ts + atomic-obligation.test.ts + reliable-answer-pipeline.test.ts: 44 passed
claim-evidence-graph.test.ts + response.test.ts 与相关管线测试: 50 passed
@pseagent/app: 58 files, 1721 passed
npm run typecheck: passed
```

修复后三次关闭缓存串行运行 B053：

| 轮次 | 状态 | 域 | 引用 | 四组必需概念 | 延迟 |
| --- | --- | --- | ---: | --- | ---: |
| 1 | answered | professional + general | 2 | 4/4 | 41,509 ms |
| 2 | answered | professional + general | 2 | 4/4 | 39,187 ms |
| 3 | answered | professional + general | 2 | 4/4 | 29,711 ms |

四组概念为个人配置、日程/规则/通讯录、交接/移交、风险/责任人。每轮域级 synthesis 调用数为 2，无额外无界重试。

## 仓库边界

- 仅修改 `pseagent-platform-reliability` 平台工作区。
- 未修改原始 `pseagent-platform` 工作区。
- 未修改 `coremail-professional` 与 `presales-general` 知识仓库。
