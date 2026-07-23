# 项目执行约束

1. 默认工作目录是 `C:\Users\Coremail\Desktop\Coremail-PSE\pseagent-platform`。
2. 总目录 `C:\Users\Coremail\Desktop\Coremail-PSE` 不是 Git 仓库；四个直接子目录是独立 Git 仓库，不得跨仓暂存或提交。
3. 旧 PSEAgent 原型及其未提交修改保持原状，不读取或复制旧实现作为新运行代码来源。
4. 未经用户单独授权，不创建 remote、不推送、不删除或归档原目录。
5. 每完成一个阶段性任务，必须先执行计划规定的验证，再创建单独 commit。
6. commit 标题和正文必须使用中文；正文至少包含“完成内容”和“验证结果”。
7. 每个阶段完成后必须向用户报告阶段编号、完整 commit 哈希、中文摘要、验证命令和结果。
8. 专业知识库不重新上传或全量解析 PDF；从已提交 Markdown 建索引。通用库首期允许健康空库。
9. 已完成的首期不实现双库同时检索、评分、judge、Supabase 审核、Worker、Coremail MCP/公网兜底或自动知识写回；用户批准的后续阶段仅允许按已确认设计接入只读 Coremail MCP 历史资料辅助回答。
10. 实施前读取最新设计规格和实施计划；若用户改变范围，先同步更新新平台仓中的文档。
11. `coremail-knowledge-mcp` 仅用于只读 Jira/Wiki 历史资料；不得连接 writeback 入口，不得把认证数据、缓存或运行日志提交到任一仓库。
