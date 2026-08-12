# 阶段 179：第五套全新百题冷验收集冻结

## 结论

第五套 100 题已在任何回答调用之前完成结构设计、历史题面排除、前批次语义指纹排除、评分合同校验和 SHA-256 封存。本阶段没有调用 `answerDetailed`，没有观察模型答案，也没有根据输出修改题目、知识、代码、必需概念或门槛。

从冻结提交开始，连续三轮共 300 次冷运行只允许读取这些文件；无论首轮结果好坏，都禁止边测边改或选择性重跑。

## 冻结对象

| 对象 | 值 |
| --- | --- |
| 题集 | `tests/e2e/enterprise-blind-acceptance-20260812-fifth.json` |
| 题集 SHA-256 | `bac4ab60afebb31874f1404de622587ac883141c64a94f1fde1a86ef8dde7b47` |
| seal | `tests/e2e/enterprise-blind-acceptance-20260812-fifth.sha256` |
| 生成器 | `scripts/build-blind-matrix-20260812-fifth.mts` |
| 生成器测试 | `scripts/build-blind-matrix-20260812-fifth.test.ts` |
| 冻结时间 | `2026-08-12T04:45:00.000Z` |
| 历史排除题面数 | 851 |
| 历史题面排除集 SHA-256 | `16492d92015b6b852e45341cf72e2b4b346dd10e46d2885b28c35fa34645676c` |
| 既有语义指纹数 | 100 |
| 既有语义指纹集 SHA-256 | `6e1a805079a002a1c38fb886a9ccb1220664a295ad3dca1fdbf3723518c9a895` |

生成 seal 时强制要求生产答案卡 catalog；缺失时生成器失败关闭。历史题面排除集包含所有 `tests/**/*.json`、生产答案卡 canonical question/aliases/regression questions，以及显式配置的旧 JSONL manifest 问题。

## 样本结构

| 层级 | 数量 | 设计重点 |
| --- | ---: | --- |
| 专业知识 | 20 | AIR 离线与版本、OAuth2、SSL、协议、多活、云转自建、UD 差异、重复发信、双轨、认证、POC、恢复、增量、网关、腾讯迁移、审计和个人配置 |
| 通用售前 | 20 | 关系分层、购买角色、价格转价值、NVC、演示资格、发现、透明边界、资源行为、渠道协作、红旗、交通灯、BATNA、让步、RFP、价值画布、阶段出口、Coach、三大问题、信任方程和 MTL |
| 混合域 | 15 | 每题显式包含专业事实与通用方法论两个独立义务，要求两个知识域和至少两条引用 |
| 多轮追问 | 15 | 8 道专业、7 道通用；每题自带独立冻结上下文，不依赖运行顺序或上一题答案 |
| 证据不足 | 15 | 9 道专业、6 道通用；要求说明缺失项目输入和补证路径，禁止制造保证或精确结论 |
| 安全边界 | 15 | 凭据、认证、伪造验收、法定留存、个人数据、生产压测、授权篡改、隐私、营销同意、商业秘密和身份冒用 |
| 合计 | 100 | 70 道可回答、30 道部分回答或拒答 |

31 道可回答题标记为高风险。门槛没有因为前四批失败而降低：可用率 99.5%、事实准确率 95%、高风险事实准确率 99%、证据支持 98%、路由 98%、完整度 95%、合理拒答 95%、三轮结论一致率 95%。

## 独立性证明

1. 100 个归一化题面哈希内部唯一。
2. 与 851 条历史测试、回归题、前四批矩阵和生产答案卡题面精确碰撞为 0。
3. 每题冻结 `entities/actions/constraints/deliverables` 四元元数据；第五批内部 100 个语义指纹唯一。
4. 第五批 100 个语义指纹与前四批可审计的 100 个既有指纹碰撞为 0。
5. 单纯改变题面措辞不会改变语义指纹，测试明确验证该性质。
6. 生成器在写盘前同时拒绝历史题面碰撞、内部语义重复和跨批次语义碰撞。

这里的语义排除只对既有矩阵中已经保存四元元数据的题目形成机器证明；更早没有语义元数据的历史题仍由归一化题面哈希排除，并在人工选题时避免复用原场景与原交付组合。

## 冻结前验证

```text
npm exec -- vitest run scripts/build-blind-matrix-20260812-fifth.test.ts
4 passed
```

```text
npm exec -- vitest run scripts/build-blind-matrix-20260812-fifth.test.ts scripts/run-blind-acceptance.test.ts scripts/blind-acceptance-contract.test.ts
64 passed
```

```json
{"type":"blind_validation","matrix":"enterprise-blind-acceptance-20260812-fifth.json","matrixSha256":"bac4ab60afebb31874f1404de622587ac883141c64a94f1fde1a86ef8dde7b47","excludedQuestionCount":851,"excludedQuestionsSha256":"16492d92015b6b852e45341cf72e2b4b346dd10e46d2885b28c35fa34645676c","caseCount":100,"layers":{"professional":20,"general":20,"mixed":15,"multi_turn":15,"insufficient_evidence":15,"safety_boundary":15}}
```

- 平台工作区测试 2,121 项通过；知识引擎 Rust 测试 42 项通过。
- 全仓 TypeScript 类型检查通过。
- `git diff --check` 通过。

## 三轮冷运行约束

- 冻结提交推送后，平台工作区必须保持清洁。
- resolver、planner、synthesizer、verifier、consensus verifier 和 answer review 六个角色全部固定为 `deepseek_v4_flash`。
- 专业知识 revision 固定为 `64d768e99f137ab149bb3f981d024b75c2dc62a6`。
- 通用知识 revision 固定为 `655ecd95fd1c2b6500810b26ccddc6035111b40a`。
- Knowledge Engine 固定为 `http://127.0.0.1:19849`，不得服务 previous version。
- `PSE_RELIABILITY_CONTROL_PLANE_ENABLED=true`。
- `PSE_QUALIFIED_CACHE_ENABLED=false`；300 条 observation 的缓存命中必须为 0。
- 并发固定为 4、单题超时 180 秒；每一轮写入独立原始文件。
- 显式删除 Knowledge Ops、反馈和发布写入环境变量。
- 三轮之间禁止修改代码、题集、seal、评分器、知识 revision、模型、并发和阈值。
- 任意失败必须进入最终报告，不得用选择性重跑替换。

## 仓库边界

- 本阶段只在 `pseagent-platform-reliability` 工作区修改平台仓库。
- 原始 `pseagent-platform` 工作区不变。
- `coremail-professional` 与 `presales-general` 知识仓库不变。
