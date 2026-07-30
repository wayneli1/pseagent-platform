# 分层正式证据与跨页归纳验收

日期：2026-07-30

分支：`feature/lunkr-direct-integration`

## 固定环境

- Node.js：`v24.15.0`
- Cargo：`cargo 1.91.0 (ea2d97820 2025-10-10)`
- `coremail-professional`：`2f293528af751d8997e837b1a7569f4582a02059`
- `presales-general`：`26945059ca4b9796f2ff7c89ed84dca1c2d71641`

## 验收结论

- `general` 与 `professional` 均允许对已读取的正式页面做保守跨页归纳。
- 支持性、兼容性、版本、容量、性能、授权、报价、认证和穷举完整性仍要求直接证据。
- “售前工程师的工作职责有哪些？”固定为六个互补证据面；只有六篇正式页面都实际读到后才形成完整职责归纳。
- 六个职责面为：需求诊断与访谈、方案组织与价值表达、产品演示与技术证明、客户关系与可信顾问、冲突沟通与异议处理、机会管理与项目推进。
- 覆盖校验不再因为缺少专门岗位说明书而降级，也不再依赖二次模型随机决定这六页映射是否成立。
- 连续结构化动作失败时先读取正式候选并切换到 `final-only` 恢复，不会在已有正式证据时立即清空结果。
- 正式知识有支持时不进入 Coremail MCP；受保护问题只有在正式目标覆盖确认为 `none` 时才允许历史资料兜底。

## 真实模型：EC06

固定公开回归问题：`售前工程师的工作职责有哪些？`

确定性六页证据：

1. `wiki/synthesis/售前诊断式对话框架.md`
2. `wiki/concepts/解决方案销售.md`
3. `wiki/concepts/愿景演示与技术证明的区分.md`
4. `wiki/concepts/可信顾问.md`
5. `wiki/synthesis/售前冲突沟通场景集.md`
6. `wiki/concepts/机会质量与客户证据.md`

最终连续三次真实模型探针：

| 次数 | scope | status | 正式引用数 | 耗时 |
| --- | --- | --- | ---: | ---: |
| 1 | general | answered | 6 | 32,543 ms |
| 2 | general | answered | 6 | 18,052 ms |
| 3 | general | answered | 6 | 20,502 ms |

三次均覆盖六类职责，且没有出现 `partial`、`not_covered` 或零引用结构降级。

## 受保护产品事实探针

固定公开控制问题询问知识库未收录的未来协议支持性。最终连续三次结果：

| 次数 | scope | status | 正式引用数 | 历史引用数 | historicalAttempted | historicalUsed | 耗时 |
| --- | --- | --- | ---: | ---: | --- | --- | ---: |
| 1 | professional | not_covered | 1 | 8 | true | true | 21,946 ms |
| 2 | professional | not_covered | 1 | 8 | true | true | 22,786 ms |
| 3 | professional | not_covered | 0 | 8 | true | true | 18,805 ms |

目标协议没有被推导为“支持”或“不支持”；可选的正式相关信息只接受已验证页面中的协议事实。正式相关信息为空时也保持安全的 `not_covered` 结论。

## 自动化验证

提交前新鲜执行结果：

- `npm exec -- vitest run scripts/probe-live-contract.test.ts`：3/3 通过。
- `npm exec -w @pseagent/app -- vitest run src/layered-evidence-regression.test.ts`：7/7 通过。
- `npm run test:regression`：48/48 通过。
- `npm run test:ts`：
  - PSEAgent：21 个测试文件、404 个测试通过；
  - Knowledge MCP：2 个测试文件、4 个测试通过；
  - Lunkr Direct：14 个测试文件、112 个测试通过。
- `npm run typecheck`：三个 TypeScript workspace 全部通过。
- `npm run build`：三个 TypeScript workspace 与 Knowledge Engine Rust 构建通过。
- `cargo test --manifest-path services/knowledge-engine/Cargo.toml`：25 个 Rust 测试通过。
- `cargo build --manifest-path services/knowledge-engine/Cargo.toml`：通过。
- `git diff --check`：通过。

## Lunkr 客户端

Lunkr 桥接进程在最终构建后重启并检查 `ready`。按用户要求，私聊内容验收由用户在客户端手工发送固定公开回归问题完成；本记录不伪造客户端发送或接收结果。

## 隐私与记录边界

本次验收没有把密钥、令牌、Cookie、SID、历史资料正文、知识页正文或非固定公开回归的聊天内容写入版本库。诊断文件只创建在系统临时目录并在结束前删除。版本库中的验收记录只保留固定公开回归、状态、引用数量、页面路径、耗时和内容无关的证据计数。
