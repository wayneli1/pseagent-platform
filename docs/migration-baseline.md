# 三仓迁移基线

日期：2026-07-22

## 目标仓库

| 仓库 | 绝对路径 | 基线 revision |
|---|---|---|
| 专业知识库 | `C:\Users\Coremail\Desktop\Coremail-PSE\coremail-professional` | `e003c787326609afc3b6d4159e5096a8c29128ed` |
| 通用知识库 | `C:\Users\Coremail\Desktop\Coremail-PSE\presales-general` | `71c8690785280e86e22967771ce4c6de2aad9370` |
| PSEAgent 平台 | `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform` | `8c0cb180d7c3fac441620538197f0b04edea6f3d` |

## 边界

- 总目录 `C:\Users\Coremail\Desktop\Coremail-PSE` 不是 Git 仓库。
- 三个直接子目录分别是独立 Git 仓库，且均未配置 remote。
- 原专业知识库、原通用知识库和旧 PSEAgent 原型不再作为新平台的运行依赖或代码移植来源。
- 未经单独授权，不创建远程仓库、不推送，也不移动、删除或归档原目录。
