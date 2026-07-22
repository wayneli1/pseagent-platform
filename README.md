# Coremail PSEAgent Platform

这是 Coremail 售前问答新平台的唯一代码工作仓。后续开发、测试、提交和对话默认工作目录为：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform
```

桌面总目录包含三个并列、互相独立且当前无 remote 的 Git 仓库：

```text
C:\Users\Coremail\Desktop\Coremail-PSE\
├─ pseagent-platform\       # PSEAgent、Knowledge MCP、Knowledge Engine 与测试
├─ coremail-professional\   # Coremail 专业售前知识库
└─ presales-general\        # 通用售前知识库；首期允许是健康空库
```

`Coremail-PSE` 总目录本身不是 Git 仓库，也不使用 submodule。旧 PSEAgent 原型不复制、不继续开发、不作为代码移植来源；原目录保持原状。

## 当前状态

当前只完成新三仓初始化和文档迁移，尚未开始问答运行代码实现。下一步从实施计划的 Task 1 开始，每个阶段必须验证后单独使用中文标题和中文正文提交。

## 核心文档

- [设计规格](docs/superpowers/specs/2026-07-22-pseagent-single-entry-dual-kb-agent-loop-design.md)
- [实施计划](docs/superpowers/plans/2026-07-22-pseagent-single-entry-dual-kb-agent-loop.md)
- [初始化基线](docs/bootstrap-baseline.md)
- [第三方说明](THIRD_PARTY_NOTICES.md)

第一阶段只打通单入口只读问答：`professional/general/normal` 三值路由、单库绑定、有界 Agent Loop、确定性引用和唯一 `pse_answer` MCP。评分、judge、自动审核、自动生成 Markdown 和知识写回均不在首期范围内。
