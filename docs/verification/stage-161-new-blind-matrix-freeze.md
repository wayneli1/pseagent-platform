# 阶段 161：全新百题盲测矩阵封存

日期：2026-08-11

## 结论

已建立一套新的 100 题独立验收矩阵。该矩阵没有复用 2026-08-10 的旧百题题面，也没有复用历史 E2E、回归题或答案卡标准问法；在首次调用 `pse_answer` 前完成结构校验、排除碰撞和哈希封存。

本阶段只封存题面和金标准，不运行回答链路，不根据系统表现调整期望。

## 分层

| 分层 | 题数 |
| --- | ---: |
| 专业知识 | 20 |
| 通用售前 | 20 |
| 综合多域 | 15 |
| 多轮追问 | 15 |
| 证据不足 | 15 |
| 安全边界 | 15 |
| 合计 | 100 |

其中有 24 道“可回答且高风险”的题，确保高风险事实准确率不是空分母。

## 防泄露与封存结果

运行环境使用原平台工作区的只读 `.env.local`，从 `tests`、答案卡目录和已登记的历史 JSONL 中汇总排除题面：

```json
{
  "matrixSha256": "269da24543bd0335aebec79413d6c867aeb3ea336a22efc69cbceeba400764f2",
  "excludedQuestionCount": 451,
  "excludedQuestionsSha256": "66c37e860a1605ce8ac8e93bf73b9a158c85764a77233512fe43b640d70b0da7"
}
```

规范化精确碰撞为 0。新题与旧百题的字符二元组 Jaccard 最高相似度为 0.3333，未发现改写后与旧题等价的高相似题面。

## 验证命令

```powershell
$env:PSE_BLIND_MATRIX_PATH='tests/e2e/enterprise-blind-acceptance-20260811.json'
$env:PSE_BLIND_SEAL_PATH='tests/e2e/enterprise-blind-acceptance-20260811.sha256'
$env:PSE_BLIND_VALIDATE_ONLY='true'
node --env-file=..\pseagent-platform\.env.local --import tsx scripts/run-blind-acceptance.mts
```

结果：100 题结构合法，六层数量符合设计，451 道排除问法无碰撞，封存哈希匹配。

## 冻结规则

- 本提交推送后才允许运行第一轮真实回答。
- 三轮运行期间固定代码提交、模型和两个知识库修订。
- 首次运行后不修改题面、必答概念、禁止主张、分层或阈值。
- 若结果未达标，保留原始报告并将失败题转为下一轮开发集；本矩阵不得边测边改。
