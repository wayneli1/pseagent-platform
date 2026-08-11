# 第 163 阶段：收敛最终结果误杀与模型排队失败

## 阶段结论

本阶段针对第二轮百题验收暴露的 `invalid_final`、`coverage_verifier_invalid` 和模型排队失败进行整改。固定 20 题发布质量门禁最终达到 **20/20**，平均分 1.0，可用性失败 0、安全失败 0，P95 80,944 ms、P99 81,714 ms，发布门禁通过。

该结果只证明固定发布回归集和本阶段根因已收敛，不代表第二轮百题失败已经被重新验收通过。第二轮 100 题已经转为开发集，后续仍须完成混合域保真、义务完整性、评分器和当前修订检索金标整改，再使用另一套全新 100 题独立验收。

## 根因与修复

1. `QG-PRO-CANONICAL` 的直接操作条件实际已经出现，但对象位于动作之前，旧守卫只接受“动作在前、对象在后”，导致 `operational_condition_missing`。现已支持两种自然语序。
2. `B019` 的“容量：”“有效期：”被确定性覆盖核验器当成无引用事实主张，导致 `verification_claim_citation_invalid`。现已把短冒号标题绑定到后续带引用事实段。
3. 比较题草稿缺少一侧时，验证器即使保留了全部可保留片段，仍重复调用最多 5 次；这些调用不可能补写草稿。现改为立即保守降级为 partial 并明确缺口。
4. 验证后残留的无主语比较句会让整题失败。现仅删除歧义比较句并重新计算引用；无法保留证据的单个义务降为 none，不清空其他义务。
5. 正式框架的一项结构缺陷会放大成整题 `temporarily_unavailable`。现只降级仍未通过结构检查的义务，保留其他已验证义务。
6. 禁止主张检测只看短前缀，把“不能直接承诺高级备份适用于任意数据规模”误判为正向承诺。现按句段、转折和否定谓词判断，同时继续拦截双重否定和转折后的真实承诺。
7. “根据 [1] 所示内容，建议……”包含实质结论，却被“不得只让用户看引用”的守卫误杀。现只拦截整段纯引用委托；纯委托义务确定性降为 none，不让整份回答失败。
8. 默认模型并发为 3，而发布门禁同时运行 4 个会话组；15 秒本地排队超时造成可恢复请求被过早丢弃。默认排队预算调整为 60 秒，仍受 540 秒主动截止和 570 秒请求截止约束。
9. 所有覆盖核验拒绝路径补充具体原因，避免只留下笼统的 `coverage_verifier_invalid`。

## 真实运行证据

第一次 20 题复核为 16/20：3 题因本地模型队列超时不可用，1 题因否定语境的禁止主张误杀不可用；P95 154,839 ms，门禁失败。

修复排队和否定语境后，第二次复核为 19/20：上一轮 4 个失败全部恢复；新出现的 `QG-SAFE-COLLOQUIAL` 因 `requirement_answer_delegates_to_citation` 误杀而不可用，P95 249,228 ms，门禁仍失败。

收窄引用委托判定后，先按 `robustness_safety` 原会话顺序复现前三题：canonical、alias、colloquial 均为 answered，colloquial 不再产生验证拒绝。最终再次执行完整并发门禁：

| 指标 | 结果 | 门槛 | 判定 |
| --- | ---: | ---: | --- |
| 完成数 | 20/20 | 20/20 | 通过 |
| 用例通过数 | 20/20 | 20/20 | 通过 |
| 平均分 | 1.0 | 1.0 | 通过 |
| 可用性失败 | 0 | 0 | 通过 |
| 安全失败 | 0 | 0 | 通过 |
| P95 | 80,944 ms | ≤120,000 ms | 通过 |
| P99 | 81,714 ms | ≤180,000 ms | 通过 |
| 一致性检查 | 2/2 | 2/2 | 通过 |

模型固定为 `deepseek_v4_flash`，TaskSpec、多域执行、答案卡 exact/family 均为 active。运行时通过删除不完整的 Knowledge Ops 导入变量关闭外部写入，只执行真实回答和本地报告落盘。

## 静态与全量验证

| 验证 | 结果 |
| --- | --- |
| 相关定向测试 | 6 个文件、327 项通过 |
| 全量 TypeScript | 108 个文件、1,965 项通过 |
| 全工作区类型检查 | 通过 |
| 全工作区生产构建 | 通过 |
| Rust 知识引擎 | 39 项通过 |
| `git diff --check` | 通过 |

## 原始证据

| 证据 | 路径 | SHA-256 |
| --- | --- | --- |
| 16/20 失败报告 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786428615206.json` | `3ffe18b05a71b67aff9e174431ecad5536df09faf0758d007601ceaadfa18a93` |
| 19/20 失败报告 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786429515535.json` | `415749766897e713939880ae9a1356f9b29be226a793632d70c4ce71a03817a8` |
| 20/20 最终报告 | `C:\Users\Coremail\AppData\Local\Temp\pseagent-release-quality\release-quality-1786431054584.json` | `508d8ab6f9392680418cc979e0853fed8244b93f1665a38d4f3cb1be12a6907f` |

## 仓库边界

本阶段只修改 `pseagent-platform` 的独立 worktree `pseagent-platform-reliability`。`coremail-professional`、`presales-general`、`coremail-knowledge-mcp` 和原始脏工作树均未修改、未提交、未推送。
