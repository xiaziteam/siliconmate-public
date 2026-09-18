# 硅侣 SiliconMate V4.1.0

AI助手 — 安卓云算力架构 + macOS桌面 (Tauri2 + Rust + React)

## V4.1.0 安卓云算力架构 (新增)

**手机变身云端 AI 算力节点与远程执行器** — 激活后手机接入虾群 IM 网络，
好友硅侣可远程调度你的手机执行任务（截图/OCR/屏幕操控），全链路审批可控。

- **云算力聊天**: 手机端 AI 对话由服务端 opencode 免费模型池驱动
  (POST /v1/chat, 多轮上下文服务端会话维持, 90s 超时/95s 客户端中止)
- **激活门禁**: 未激活=免费本地模式; 激活码绑定后解锁云端功能
  (/v1/activate/bind, 幂等绑定, 账号级开关)
- **SMCP 执行器** (手机作为被调度方):
  - 能力: im(消息)/tunnel(隧道)/notify(通知)/screenshot(无障碍截图)/ocr(ML Kit)/device_control(触控)
  - 任务回路: 消费型轮询(Kotlin 3s) → 本地权限策略(allow/deny/ask) → 审批弹窗/系统通知
    → 执行回传(type:result) → 120s 看门狗超时兜底
  - 审批现场持久化: 进程死亡/冷启动不丢待审批任务
- **虾群好友**: SM-ID 搜索加好友/同意/拒绝, 好友申请系统通知(去重仅一次)+红点,
  主界面+侧栏双入口, 群聊
- **连接状态三态**: 未激活/已连接/离线 — 10s 真实心跳驱动, 断网自动感知恢复

详见 `docs/V4.1-CLOUD-ARCH.md`

## V3.0 架构 (桌面端)

- **客户端**: Tauri2桌面壳 + React前端 + Rust后端
- **服务端**: VPS2部署 (free-code + zhipu-bridge + AgentChat)
- **通信**: MCP Proxy WebSocket + SSH exec

## 场景路由 (7级优先级)

1. 语音 → Obscura CDP (ChatGPT Voice直通)
2. Office读取 → 服务端 (server_office_read)
3. Office创建 → 服务端 (server_office_create)
4. 视觉分析 → 本地 (claude -p + 图片base64)
5. 图片OCR → 本地 (Tesseract)
6. 深度思考 → 服务端 (server_deep_think)
7. 普通文本 → 本地 (claude -p → GLM-4-Flash)

## 快速开始

```bash
# 客户端开发
cd client
npm install
cd src-tauri && cargo build && cd ..
npm run tauri dev

# 安卓端: Android Studio 打开 android/ 工程构建 APK
# (WebView 加载 client 构建产物, NativeBridge 适配 __TAURI__ invoke)

# 服务端部署 (凭证经 scripts/.deploy.env 注入, 模板见 .deploy.env.example)
./scripts/deploy-v4_1-server.sh all
```

## V3.0 融合来源

- **siliconmate-v2**: 场景路由 + 输出过滤 + MCP代理 + AgentChat + React UI
- **magic-chatgpt-app**: 账号服务 + ChatGPT编排器 + Cookie同步 + sing-box隧道

详见 `docs/V3-FUSION-PLAN.md`
