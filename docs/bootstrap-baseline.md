# Coremail-PSE 初始化基线

日期：2026-07-22

## 目录与仓库

- 总目录：`C:\Users\Coremail\Desktop\Coremail-PSE`
- 总目录不包含 `.git`。
- `pseagent-platform`、`coremail-professional`、`presales-general` 是三个独立 Git 仓库。
- 三个新仓初始化时均未配置 remote，也未执行 push。

## 知识库来源 revision

- 专业库目标：`C:\Users\Coremail\Desktop\Coremail-PSE\coremail-professional`
- 专业库初始 revision：`fbd11614cf586ec82ad38f5189ea380d04213de4`
- 通用库目标：`C:\Users\Coremail\Desktop\Coremail-PSE\presales-general`
- 通用库初始 revision：`71c8690785280e86e22967771ce4c6de2aad9370`

两个知识库均通过本地独立克隆创建，初始工作树干净。原专业库、原通用库及旧 PSEAgent 原型未被移动、删除或修改。

## 平台仓边界

`pseagent-platform` 是全新 Git 历史，不继承旧原型的应用代码、混合目录或提交历史。首次提交只包含：

- 最新设计规格与实施计划；
- 项目执行约束和仓库说明；
- 初始化基线、第三方许可与忽略规则。

后续运行代码必须根据新设计和测试契约重新实现。

## 上游设计参考

- 仓库：`https://github.com/nashsu/llm_wiki`
- 已记录参考 revision：`e8bdec6e81e65a25c9862638515f3edb4f59bd1f`
- 许可：GPL-3.0

该上游只作为 Agent Loop、搜索/读页和引用边界的设计依据；初始化提交未复制上游应用源码。
