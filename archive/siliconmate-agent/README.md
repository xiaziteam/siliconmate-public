# 硅侣1.0 — FastAPI薄壳 (已归档)

**归档日期**: 2026-08-29
**归档原因**: 硅侣1.0采用FastAPI薄壳+远程Server架构，无法运行本地工具（nuphus-mcp），存在单点故障。硅侣2.0改用双Agent架构（客户端free-code + 服务端free-code Server），消除了这些限制。

## 架构对比

| 特性 | 硅侣1.0 | 硅侣2.0 |
|------|---------|---------|
| 客户端 | FastAPI薄壳 + WebView | Tauri2 + free-code SDK子进程 |
| Agent | 远程Server单进程 | 双Agent（客户端+服务端） |
| 本地工具 | ❌ 无法运行 | ✅ nuphus-mcp 38工具 |
| 离线可用 | ❌ 依赖VPS | ✅ 日常对话独立运行 |
| 深度思考 | ❌ | ✅ AgentChat多AI协作 |
| OCR | ❌ | ✅ tesseract本地OCR |
| Office处理 | ❌ | ✅ 服务端OfficeCLI |

## 参考价值

1. 登录UI和账号逻辑 — account-client Rust crate
2. Tauri2窗口配置和极简界面风格
3. Obscura CDP透传方案（chatgpt.html）
4. WebSocket交互模式

## 代码位置

原代码在 `/tmp/magic-chatgpt-app/`，本目录仅作标记。2.0已从1.0搬运核心组件：
- account-client → client/src-tauri/ (Cargo.toml依赖)
- chatgpt.html → client/chatgpt.html
- Obscura binary → client/binaries/
