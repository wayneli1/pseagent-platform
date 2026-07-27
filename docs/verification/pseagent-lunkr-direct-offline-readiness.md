# PSEAgent 直连 Lunkr 离线就绪记录

日期：2026-07-27  
分支：`feature/lunkr-direct-integration`

## 范围

- 新增纯 Lunkr 专用账号私聊入口。
- 不使用 OpenClaw、OpenCode、Codex 或其他外层运行时。
- 保留既有 OpenCode 临时测试配置和历史验收资料，不修改其行为。
- 首期只支持 Windows 前台运行、所有用户私聊文字、内存上下文和固定附件提示。

## 阶段提交

```text
d37743f36c6fd703f5d1d34646e2288b763919ac  设计与实施计划
cfaed7906d6aac877629cf77281e1be2fc52aaa7  安全传输核心
5b3c19a65f023d4e34700420af5832478ee4a12b  邮箱登录与 Session
33b185e9dccebef8199c5dd8c36ed0da5f145239  实时私聊收发
e9a417d393ec774d8ac87231dc327f8a47069400  PSEAgent Bridge
```

## 离线验证

```powershell
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path services/knowledge-engine/Cargo.toml -- --check
cargo clippy --manifest-path services/knowledge-engine/Cargo.toml --all-targets -- -D warnings
git diff --check
```

结果：

- PSEAgent：15 个测试文件，145 项通过。
- Knowledge MCP：2 个测试文件，4 项通过。
- Lunkr Direct：11 个测试文件，32 项通过。
- Knowledge Engine：21 项 Rust 单元、集成和文档测试通过。
- TypeScript typecheck、全量 build、Rust fmt 和 Clippy 全部通过。
- Lunkr 专项覆盖配置、脱敏、Session 加密、登录、条件式 OTP、状态、
  Socket.IO 帧、私聊规范化、分段发送、上下文隔离、去重、串行和发送重试。

## 安全检查

```powershell
rg -n -i "openclaw" integrations/lunkr-direct scripts -g "lunkr-*.mts"
rg -n "rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED" integrations/lunkr-direct
rg -n "LUNKR_PASSWORD|password\s*[:=]\s*['\\"][^'\\"]+" integrations/lunkr-direct scripts
npm audit --omit=dev
```

结果：

- 正式 Lunkr 运行代码无 OpenClaw 引用。
- 未关闭 HTTPS 或 WSS 证书校验。
- 测试账号和密码未进入仓库。
- 新增的 XML 和 WebSocket 直接依赖使用已修复版本。
- `npm audit` 剩余 2 项中危提示来自既有 MCP SDK 的间接 Hono 依赖；强制
  修复会降级 MCP SDK，未在本阶段改变既有 PSEAgent 依赖。

## 尚未完成

离线实现已就绪。真实验收仍需在本机交互式 PowerShell 中完成：

```powershell
npm run lunkr:login
npm run lunkr:status
npm run lunkr:start
```

真实验收只记录结构化状态和计数，不记录账号密码、消息正文、回答正文、SID、
Cookie、模型密钥或知识内容。
