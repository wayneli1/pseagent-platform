# Coremail MCP 历史展示门禁真实验收

日期：2026-07-30

## 验收目标

1. “Coremail 对比 Exchange”必须由正式知识库回答，不能进入
   Coremail MCP 历史兜底。
2. 正式知识库未覆盖的问题可以检索 Coremail MCP；若来源与问题不匹配
   或置信度低，只显示固定提示，不显示历史正文、来源或内部 URL。
3. Coremail MCP 启动失败时不能声称已经完成检索。
4. 正式知识库已经回答时不能启动 Coremail MCP。

## 正式知识库控制用例

问题：

> 对比 Exchange 邮件系统，Coremail 的优势有哪些？

命令：

```text
npm run probe:exchange-comparison
```

结果：

```text
probe=EC07.1 scope=professional status=answered refs=5 elapsed_ms=37293
```

探针同时校验：

- 回答包含个性化定制、TCO、现场服务、安全能力和客观对比边界；
- 至少引用一个正式专业知识页；
- 不出现“Exchange 完全不支持定制”“Exchange 完全不支持安全功能”等
  绝对化表述。

## Coremail MCP 拒绝展示用例

问题：

> Coremail 是否支持 2035 年量子卫星邮件协议？

命令：

```text
npm run probe:coremail
```

结果：

```text
historical status=not_covered outcome=hidden main_refs=1 history_refs=0 reason=topic_mismatch elapsed_ms=22221
```

用户可见结果只追加以下固定提示：

```text
补充说明：已检索 Coremail MCP 历史资料，但检索内容与当前问题不匹配，因此未展示。
```

探针会将 PSEAgent 的结构化结果和 Coremail MCP 直连结果分别取回，
使用与生产相同的相关性门禁重新判断，并校验最终文本中没有历史正文和内部 URL。

## 故障与短路用例

Coremail MCP 入口损坏：

```text
broken_path startup=true history_exposed=false main_refs=2
```

正式知识库已覆盖：

```text
covered_query coremail_started=false
```

前者允许正式知识库返回相关信息，但不显示历史正文，也不显示“已检索
Coremail MCP”的提示；后者证明正式答案不会启动历史检索进程。
