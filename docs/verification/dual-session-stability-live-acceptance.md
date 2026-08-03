# PSEAgent 双会话稳定性真实验收记录

日期：2026-08-03

最终保留实现：阶段 61 代码状态，由阶段 65 精确恢复

结论：服务稳定性通过；严格回答状态验收未通过

## 1. 验收范围

- 使用两套全新、互相独立的 PSEAgent 运行时。
- 每套运行时按相同顺序串行执行 P01–P10，共 20 次请求。
- 每题沿用 `tests/regression/questions.json` 的 `expectedScope` 和
  `expectedStatus`。
- 稳定性探针在 unavailable、异常、scope mismatch 或 status mismatch 任一计数非零时
  返回退出码 1。
- 不打印或记录回答正文、知识正文、模型密钥或会话凭据。
- 没有停止或重启运行中的 Lunkr 机器人、Knowledge Engine 或 MCP 服务。

本机两个同名 Coremail 论客窗口无法被 Windows 控制助手稳定区分，因此本次验收不是
Lunkr UI 消息通道测试，也不用于证明 `.txt` 长回答卡片的客户端展示；这里只验证机器人
回答运行时的规划、检索、覆盖校验和最终状态逻辑。

## 2. 修复前基线

| 会话 | answered | partially_answered | not_covered | final | unavailable | failures |
|---|---:|---:|---:|---:|---:|---:|
| A | 2 | 7 | 1 | 10 | 0 | 0 |
| B | 3 | 7 | 0 | 10 | 0 | 0 |

- 两套会话 scope 均为 `professional`。
- 同题 status 仅 4/10 一致。
- 旧探针虽然记录 `statusMatches=false`，仍可能退出 0，属于假通过。

## 3. 最终保留版本的双会话结果

最终保留版本包含：

- 严格探针 mismatch 判定。
- direct query 动态 evidence aspect 术语补全，包括单 aspect 查询。
- 覆盖校验删除无支持扩展句段后，按过滤答案实际覆盖的动态 aspect 重建 coverage。
- 不包含阶段 63 的规划裁剪、能力列表强制 direct 或 direct 候选扩窗。

### 3.1 汇总

| 会话 | answered | partially_answered | not_covered | final | unavailable | failures | scope mismatch | status mismatch |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 7 | 2 | 1 | 10 | 0 | 0 | 0 | 3 |
| B | 6 | 3 | 1 | 10 | 0 | 0 | 0 | 4 |

20/20 请求都以 `final` 正常结束，没有 unavailable、异常、超时或 scope 串线；但严格
`expectedStatus=answered` 只有 13/20 命中，探针按设计返回退出码 1。

### 3.2 逐题对照

| 题号 | 会话 A | A 引用数 | 会话 B | B 引用数 | 同题一致 |
|---|---|---:|---|---:|---|
| P01 | answered | 2 | answered | 3 | 是 |
| P02 | answered | 2 | answered | 3 | 是 |
| P03 | answered | 3 | partially_answered | 3 | 否 |
| P04 | answered | 3 | answered | 3 | 是 |
| P05 | partially_answered | 3 | answered | 3 | 否 |
| P06 | answered | 3 | answered | 4 | 是 |
| P07 | partially_answered | 3 | partially_answered | 3 | 是 |
| P08 | answered | 2 | partially_answered | 4 | 否 |
| P09 | answered | 3 | not_covered | 0 | 否 |
| P10 | not_covered | 0 | answered | 3 | 否 |

同题 status 为 5/10 一致。与修复前相比，完整回答从 5/20 提升到 13/20，且探针不再
假通过；但规划器和模型读页/草稿仍存在不可忽略的会话间漂移。

## 4. 阶段 63 失败实验与回退

阶段 63 曾尝试通用邻近 aspect 裁剪、产品能力列表强制 direct 以及 direct seed topK
动态扩窗。离线测试全部通过，但真实双会话退化为：

| 会话 | answered | partially_answered | not_covered | final | unavailable | failures |
|---|---:|---:|---:|---:|---:|---:|
| A | 5 | 3 | 2 | 10 | 0 | 0 |
| B | 3 | 4 | 3 | 10 | 0 | 0 |

同题 status 仅 4/10 一致，因此该实验被判定为质量回归。阶段 65 完整回退六个实现/测试
文件，并用 Git 树对比证明与阶段 63 父提交逐字一致；失败实验保留在提交历史中。

## 5. 离线验证

最终回退后的验证结果：

```text
Planner / Agent / prompts 聚焦测试：3 files，93 tests passed
PSEAgent 全量测试：21 files，462 tests passed
TypeScript typecheck：passed
Workspace build：passed
git diff --check：passed
阶段 63 父提交六文件树对比：passed
```

## 6. 最终判定与剩余边界

通过项：

- 20/20 请求正常结束。
- 0 unavailable，0 exception，0 scope mismatch。
- 探针可以可靠暴露 status mismatch，不再假通过。
- 过滤后覆盖状态重建和单 aspect 查询补全显著提高完整回答数量。
- 没有通过放松正文证据校验、强制改写 status 或固定业务页面获得提升。

未通过项：

- 严格 `expectedStatus` 只有 13/20 命中，未达到 20/20。
- 同题 status 只有 5/10 一致。
- P07 两套会话都只得到部分回答；P03、P05、P08、P09、P10 仍存在会话间规划或覆盖
  漂移。
- 本轮未完成真实 Lunkr UI 的两窗口消息发送和长回答 `.txt` 卡片展示验收。

后续不应继续叠加基于主题词的规划裁剪规则。更合适的下一步是单独设计可复用的规划结果
稳定化机制，例如在同一运行时内对相同知识范围、问题和 planning overview 使用有界缓存，
并为缓存失效、知识 revision 变化、并发去重和安全覆盖校验建立独立测试与真实验收。
