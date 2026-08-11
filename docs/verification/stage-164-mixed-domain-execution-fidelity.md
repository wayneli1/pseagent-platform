# 第 164 阶段：恢复混合域计划与执行保真

## 阶段结论

第二轮百题中的 15 道混合域题，旧版本首答只有 2/15 实际使用完整的 `coremail-professional + presales-general` 域集合。根因不在多域执行器，而在 TaskSpec 编译器：模型经常把“技术事实核验 + 售前治理交付”压缩成一个单域义务，执行器随后只能忠实执行错误的单域计划。

本阶段增加问题级双信号契约：只有问题同时包含明确的技术系统/事实证据任务和售前治理交付时，才确定性补齐缺失知识域。顶层 scope 不再决定最终域集合；scope 为 general 的混合题同样可以生成和执行双域计划。真实回放结果为域保真 **15/15**、可用 **15/15**、暂时不可用 **0**。

该结果证明混合域编排缺陷已收敛，但不代表回答完整性和时延已经达标。15 题中仍有 5 题为 partial，3 题超过 180 秒；这些问题进入后续义务完整性和局部重试整改。

## 修复设计

1. 将技术信号拆成“系统/产品锚点”和“事实/证据动作”两个必要条件，避免仅因问题出现 Exchange、DNS 等背景词就扩展到专业域。
2. 将成功标准、责任边界、决策记录、技术胜利、结果优先、可观察反馈、价值地图、风险触发、黄灯对话、证据门、异议预防、购买角色、小承诺、交接和剩余假设等归入通用售前治理语义。
3. 同时命中技术证据和治理交付时，在问题级检查 TaskSpec 已有域集合；只补缺失域，不重写模型已经拆好的义务。
4. 修复逻辑对 professional 和 general 两种初始 scope 都生效；纯技术和纯治理问题继续保持单域。
5. 多域执行器继续按义务计划并行启动两个隔离会话；一侧失败时把该侧义务降为 none，保留另一侧并输出 partial，不允许单侧结果冒充双域 complete。

## 确定性回归

新增 15 道原混合域问题的“模型压成单域”回归，覆盖初始 professional/general 两类 scope；无论模型只给专业域还是只给通用域，编译结果都恢复为双域。

另增加 4 个负例，确保不会仅因关键词扩域：

- `Coremail H5 支持哪些移动端能力？` 保持专业域；
- `如何用 NVC 处理客户异议并记录下一步？` 保持通用域；
- `DNS 的 TTL 是什么？` 保持专业域；
- `如何把客户事实写入客观评价标准和决策记录？` 保持通用域。

修复过程中曾使“客户现网是 Exchange，但只要求重新评估商机和下一步”的纯商业评估误入双域；通过移除无技术限定的通用“评估”信号后，该既有回归恢复为通用单域。

TaskSpec 测试最终为 277/277 通过。

## 15 题真实回放

运行模型固定为 `deepseek_v4_flash`，并发 3，单题外部观察上限 300 秒；Knowledge Ops 导入变量已删除，不产生外部评审写入。每题都检查 `execution.domainsUsed`，不是只检查顶层 scope 或编译器输出。

| 题号 | 顶层 scope | 状态 | 实际域集合 | 延迟 |
| --- | --- | --- | --- | ---: |
| B041 | general | answered | professional + general | 177,917 ms |
| B042 | professional | partially_answered | professional + general | 62,409 ms |
| B043 | professional | answered | professional + general | 113,678 ms |
| B044 | professional | answered | professional + general | 58,453 ms |
| B045 | professional | partially_answered | professional + general | 112,222 ms |
| B046 | professional | answered | professional + general | 222,429 ms |
| B047 | professional | partially_answered | professional + general | 123,132 ms |
| B048 | professional | answered | professional + general | 96,012 ms |
| B049 | general | partially_answered | professional + general | 192,929 ms |
| B050 | professional | partially_answered | professional + general | 128,150 ms |
| B051 | general | answered | professional + general | 188,275 ms |
| B052 | general | answered | professional + general | 118,210 ms |
| B053 | general | answered | professional + general | 70,524 ms |
| B054 | professional | answered | professional + general | 55,711 ms |
| B055 | professional | answered | professional + general | 41,167 ms |

汇总：域保真 15/15，可用 15/15，answered 10、partially_answered 5、temporarily_unavailable 0。`B047` 的一侧 `invalid_final` 和 `B050` 的一侧 `coverage_verifier_invalid` 均被独立降级，另一侧仍可交付。

## 验证

| 验证 | 结果 |
| --- | --- |
| TaskSpec 定向测试 | 277/277 通过 |
| 平台应用全量测试 | 47 个文件、1,519 项通过 |
| 全工作区类型检查 | 通过 |
| 全工作区生产构建 | 通过 |
| `git diff --check` | 通过 |

## 仓库边界

本阶段只修改 `pseagent-platform` 独立 worktree 中的 TaskSpec 编译与回归测试。专业知识库、通用知识库、知识 MCP 和原始脏工作树均未修改、未提交、未推送。
