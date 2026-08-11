# 阶段 176：第四套全新百题冷验收集冻结

## 结论

第四套百题已在任何回答调用之前完成生成、历史题面查重、语义指纹去重、结构校验和
SHA-256 封存。本阶段没有调用 `answerDetailed`，没有观察模型回答，也没有根据结果
修改题目、知识库、代码或评分规则。

三轮 300 次冷运行开始后，题面、期望、评分器、代码提交、知识 revision、模型、策略
版本和 release ID 全部冻结；每题每轮只保留第一次输出，不选优、不边跑边改。

## 冻结对象

- 题集：`tests/e2e/enterprise-blind-acceptance-20260812-fourth.json`
- 题集 SHA-256：`0229592b40cdf6d488fca4977d1956b23efb2106f6190431bb224fdad965d725`
- seal：`tests/e2e/enterprise-blind-acceptance-20260812-fourth.sha256`
- 生成器：`scripts/build-blind-matrix-20260812.mts`
- 生成 seal 时强制提供生产 `PSE_ANSWER_CARD_CATALOG_PATH`，缺失时生成器拒绝执行
- 历史排除题面数：751（包含生产答案卡 catalog）
- 历史排除集合 SHA-256：`d7b5cdb90010f25d5e41ae0d47181ba4dacb12bfa2c937785b4f9cbdb0f31e81`
- 冻结时间：`2026-08-12T01:30:00.000Z`

## 样本结构

| 层级 | 题数 | 说明 |
| --- | ---: | --- |
| 专业知识 | 20 | 归档、GT 灰名单、DMZ、Usertransport、数据库、Ukey、认证与报价等 |
| 通用售前 | 20 | SPIN、Mom Test、JOLT、MEDDPICC、NVC、Fit、Champion 与高层销售等 |
| 混合域 | 15 | 每题同时要求一个专业事实义务和一个方法论交付物 |
| 多轮追问 | 15 | 8 道专业、7 道通用，全部自带冻结上文 |
| 证据不足 | 15 | 9 道专业、6 道通用，要求说明缺口和补证路径 |
| 安全边界 | 15 | 授权、凭据、审计、隐私、商业秘密和反贿赂边界 |
| 合计 | 100 | 70 道可回答，30 道部分回答或拒答 |

37 道可回答题标记为高风险；混合域要求两个知识域、至少两条正式引用。

## 独立性与可审计性

1. 100 个归一化题面哈希全部唯一。
2. 与 751 条历史测试、回归题和生产答案卡相关题面的精确哈希碰撞为 0。
3. 每题冻结 `entities/actions/constraints/deliverables` 四元元数据；100 个规范化语义
   指纹全部唯一，单纯改写题面不会绕过去重。
4. 六层分布固定为 `20/20/15/15/15/15`。
5. 15 道多轮题全部包含独立上下文，不依赖上一题运行结果或执行顺序。
6. 题集生成器、校验测试、题集 JSON 与 seal 一并提交；冻结后不再修改。

## 已执行校验

```text
npm exec -- vitest run scripts/build-blind-matrix-20260812.test.ts
4 passed
```

```json
{"type":"blind_validation","matrix":"enterprise-blind-acceptance-20260812-fourth.json","matrixSha256":"0229592b40cdf6d488fca4977d1956b23efb2106f6190431bb224fdad965d725","excludedQuestionCount":751,"excludedQuestionsSha256":"d7b5cdb90010f25d5e41ae0d47181ba4dacb12bfa2c937785b4f9cbdb0f31e81","caseCount":100,"layers":{"professional":20,"general":20,"mixed":15,"multi_turn":15,"insufficient_evidence":15,"safety_boundary":15}}
```

## 冷运行约束

- 平台仓库必须是干净的固定提交。
- 六个模型角色全部固定为 `deepseek_v4_flash`。
- 专业知识 revision 固定为 `64d768e99f137ab149bb3f981d024b75c2dc62a6`。
- 通用知识 revision 固定为 `655ecd95fd1c2b6500810b26ccddc6035111b40a`。
- 使用隔离 Knowledge Engine `http://127.0.0.1:19849`。
- `PSE_RELIABILITY_CONTROL_PLANE_ENABLED=true`。
- `PSE_QUALIFIED_CACHE_ENABLED=false`，300 条 observation 的缓存命中总数必须为 0。
- 显式清空知识运营、反馈和发布写入变量。
- 并发固定为 4；三轮顺序轮换，超时和失败也保留为真实结果。
