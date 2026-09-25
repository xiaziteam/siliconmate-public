# 硅侣 SiliconMate

AI 助手 — 安卓客户端 + macOS 桌面端 (WebView/Kotlin + Tauri2 + Rust + React)

## 功能概览

- **云算力聊天**: 手机端 AI 对话由服务端模型池驱动
  (POST /v1/chat, 多轮上下文服务端会话维持, 90s 超时/95s 客户端中止)
- **激活门禁**: 未激活=免费本地模式; 激活码绑定后解锁云端功能
  (/v1/activate/bind, 幂等绑定, 账号级开关)
- **SMCP 执行器** (手机作为被调度方):
  - 能力: im(消息)/tunnel(隧道)/notify(通知)/screenshot(无障碍截图)/ocr(ML Kit)/device_control(触控)
  - 任务回路: 消费型轮询(Kotlin 3s) → 本地权限策略(allow/deny/ask) → 审批弹窗/系统通知
    → 执行回传(type:result) → 120s 看门狗超时兜底
  - 审批现场持久化: 进程死亡/冷启动不丢待审批任务
- **好友系统**: SM-ID 搜索加好友/同意/拒绝, 好友申请系统通知(去重仅一次)+红点,
  主界面+侧栏双入口, 群聊
- **连接状态三态**: 未激活/已连接/离线 — 10s 真实心跳驱动, 断网自动感知恢复
- **SMCP 通讯协议**: Agent 间消息总线, 详见 `docs/SMCP-v0.1.md`

## 构建 Android APK

推 tag 或手动触发 GitHub Actions (`.github/workflows/build-android.yml`) 即可构建:

```bash
git tag v0.0.1 && git push origin v0.0.1
```

本地构建:

```bash
# 构建前端
cd client && npm ci && npm run build && cd ..

# 拷贝前端产物到 Android assets
mkdir -p android/app/src/main/assets/dist
cp -R client/dist/* android/app/src/main/assets/dist/

# Gradle 构建 (需要 JDK 17 / Android SDK 34 / NDK 27)
cd android && gradle assembleDebug
```

## 桌面端 (macOS)

```bash
cd client
npm install
cd src-tauri && cargo build && cd ..
npm run tauri dev
```

> 注: 桌面端依赖 [nuphus](https://github.com/mrpulor-gh/nuphus) (path dependency),
> 需先克隆到 `Cargo.toml` 中配置的本地路径。

## 目录结构

```
android/   Android 客户端 (Kotlin + WebView + React assets)
client/    React 前端 + Tauri2 桌面壳 (src-tauri/)
docs/      SMCP 协议文档
```

## 环境变量

参考 `.env.example`。API Key 一律运行时注入, 不入仓。
