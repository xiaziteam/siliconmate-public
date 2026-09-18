# Implementation Plan: 硅侣Agent能力升级

**Input**: Feature specification from `spec/agent-capability/spec.md`

## Summary

将硅侣从IM工具升级为虾群级Agent：实现SMCP task/result消息协议，将已有72个Tauri命令Agent化，扩展scene_router支持task路由，新增macOS原生直通命令，整合Nuphus DesktopClient作为Computer Use引擎。全平台路线：macOS→Linux→Windows→Android→鸿蒙→iPhone，本次先实现macOS。

## Technical Context

**Language/Version**: Rust 1.80+ (Tauri2后端), TypeScript/React (前端), Kotlin (Android), Swift (macOS OCR)
**Primary Dependencies**: Tauri 2, Nuphus DesktopClient (nuphus crate via local path), desktop-api crate, tokio, serde_json, reqwest
**State Management**: Tauri管理状态(RwLock<Mutex>)，前端React useState
**Storage**: SMCP消息存储(account-service VPS)，本地任务队列(内存)
**Testing**: 手动测试 + CI build-all.yml三平台构建验证
**Target Platform**: 第一期macOS，后续Linux/Windows/Android/鸿蒙/iPhone
**Project Type**: 桌面+移动端应用(Tauri2 + Kotlin Android)
**Performance Goals**: 原生直通<0.5秒，Nuphus Computer Use<5秒，远程任务端到端<10秒
**Constraints**: 不魔改Nuphus，不魔改free-code；高危操作必须二次确认
**Scale/Scope**: 单用户桌面Agent，SMCP互联2-10个好友

## Project Structure

### Documentation (this feature)

```text
spec/agent-capability/
├── spec.md              # Phase 1 需求规格
├── plan.md              # 本文件 (Phase 2 架构设计)
└── tasks.md             # Phase 3 任务拆解
```

### Source Code (repository root)

```text
siliconmate/
├── client/
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs                 # 模块注册，新增task_engine/nuphus_bridge/native_cmds
│   │   │   ├── task_engine.rs          # 🆕 任务执行引擎：接收task→路由→执行→回传result
│   │   │   ├── nuphus_bridge.rs        # 🆕 Nuphus DesktopClient桥接：初始化+命令转发
│   │   │   ├── native_cmds.rs          # 🆕 macOS原生直通：screenshot/open_app/shell_exec/read_file
│   │   │   ├── permission.rs           # 🆕 远程任务审批：权限规则存储+弹窗+三档策略
│   │   │   ├── scene_router.rs         # 🔄 扩展：新增TaskRoute，支持task消息路由
│   │   │   ├── agent_manager.rs        # 🔄 微调：支持task触发的agent调用
│   │   │   ├── smcp.rs                 # 🔄 扩展：新增task/result消息类型处理
│   │   │   ├── obscura.rs              # ✅ 保留：ChatGPT桥接
│   │   │   ├── ocr.rs                  # ✅ 保留：OCR能力
│   │   │   ├── feishu_output.rs        # ✅ 保留：飞书输出
│   │   │   ├── voice_input.rs          # ✅ 保留：语音输入
│   │   │   ├── server_connector.rs     # ✅ 保留：VPS深度思考
│   │   │   ├── tunnel.rs               # ✅ 保留：VPN隧道
│   │   │   ├── account.rs              # ✅ 保留：账号管理
│   │   │   ├── output_filter.rs        # ✅ 保留：输出过滤
│   │   │   └── Cargo.toml              # 🔄 新增nuphus crate依赖
│   │   └── tauri.conf.json             # ✅ 保留
│   └── src/
│       ├── App.tsx                     # 🔄 扩展：task消息渲染+审批弹窗
│       ├── chat.tsx                    # 🔄 扩展：Agent结果消息样式(⚡/🤖/🧠图标)
│       ├── smcp.ts                     # 🔄 扩展：task/result消息类型前端处理
│       ├── sidebar.tsx                 # ✅ 保留
│       ├── login.tsx                   # ✅ 保留
│       ├── voice.tsx                   # ✅ 保留
│       └── conversation.ts             # ✅ 保留
├── server/                             # ✅ 保留：VPS后端不变
└── .github/workflows/build-all.yml     # ✅ 保留：CI不变
```

**Structure Decision**: 遵循现有项目架构。硅侣是已有Tauri2项目，不引入MVVM或目录重组。新增4个Rust模块(task_engine/nuphus_bridge/native_cmds/permission)对应新功能，修改3个现有模块(scene_router/smcp/agent_manager)做扩展。前端在现有chat.tsx/smcp.ts/App.tsx上增量修改。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 引入nuphus整个crate | 需要DesktopClient的28个方法做Computer Use | 只抄screenshot一个方法？→不够，Computer Use需要mouse_click/keyboard_type/window_activate等全套 |

## Research & Decisions

### Decision 1: Nuphus整合方式 — Cargo workspace本地path引用

**Decision**: 在siliconmate的Cargo.toml中添加 `nuphus = { path = "/Users/apple/nuphus/src" }` 依赖，直接引用本地Nuphus crate

**Rationale**:
- Nuphus代码库在本机 `/Users/apple/nuphus/`，crate结构完整（nuphus lib + desktop-api + nuphus-browser + nuphus-index）
- Cargo path引用零拷贝、编译缓存共享、改了nuphus源码立刻生效
- 不需要git submodule维护，不需要发布到crates.io
- DesktopClient 28个方法直接可用：screenshot/mouse_click/keyboard_type/clipboard/window_activate/ocr/perceive/find_text等

**Alternatives considered**:
- git submodule → 多一层维护，且nuphus就在本机无此需求
- 独立进程调用nuphus CLI → 延迟高、进程管理复杂、无法共享DesktopClient实例
- 只抄DesktopClient代码 → 维护两份代码、后续nuphus更新无法同步

### Decision 2: 任务执行引擎架构 — TaskEngine单模块

**Decision**: 新建task_engine.rs作为任务执行核心，三层路由逻辑集中在此

**Rationale**:
- 任务执行是全新能力，与现有scene_router职责不同：scene_router决定"消息走哪条路"，task_engine决定"task怎么执行+结果怎么回传"
- 三层路由（原生直通→Nuphus→free-code）逻辑集中管理，便于调试和维护
- task引擎需要管理：任务队列（串行执行）、审批流程、降级策略、超时处理

**Alternatives considered**:
- 在scene_router里加task分支 → 职责混淆，scene_router是路由不是执行引擎
- 每个能力模块自己处理task → 分散，无法统一管理队列/审批/降级

### Decision 3: SMCP task/result消息格式

**Decision**: 扩展现有SmcpMessage，新增type: "task"和type: "result"

**Rationale**:
- SMCP消息通道已通，只需扩展消息类型
- task消息包含：task_id, capability(能力名), params(参数), from(发起方)
- result消息包含：task_id, status(success/error/rejected/timeout), data(结果数据), screenshots(执行截图)
- 复用现有message_send/message_poll通道，不需要新建协议

**Alternatives considered**:
- 独立WebSocket长连接 → 过度设计，SMCP已支持消息传递
- HTTP回调 → 需要公网可达，NAT穿透问题

### Decision 4: 远程任务审批 — 三档策略+本地存储

**Decision**: permission.rs管理审批规则，JSON文件存储在 `~/.siliconmate/permissions.json`

**Rationale**:
- 远程任务涉及安全，必须有用户审批
- 三档策略：allow(始终允许)、ask(每次询问)、deny(始终拒绝)
- 按好友+操作类型组合存储，如 `{ "pantom": { "screenshot": "allow", "shell_exec": "ask" } }`
- ask档触发系统通知弹窗，用户点击同意/拒绝

**Alternatives considered**:
- 全部ask → 高频操作太烦
- 全部allow → 不安全
- 服务端管理 → 本地数据更安全，不经过网络

### Decision 5: Nuphus DesktopClient桥接 — 单例模式

**Decision**: nuphus_bridge.rs维护一个全局DesktopClient实例，Tauri命令通过AppHandle访问

**Rationale**:
- DesktopClient::new()初始化需要加载YOLO模型等资源，不宜每次调用都创建
- 单例模式+Mutex保证线程安全
- 桥接层隔离nuphus实现细节，task_engine只调用桥接层接口

**Alternatives considered**:
- 每次调用new() → 资源浪费，YOLO模型重复加载
- Tauri managed state → 与现有AgentManager模式一致，可行但桥接层更灵活

### Decision 6: 全平台路线规划

**Decision**: 六平台分三期，macOS先行

| 期 | 平台 | 核心任务 | 预估 |
|---|------|---------|------|
| **第一期** | macOS | task协议+Nuphus整合+原生直通+Agent化 | 2周 |
| **第二期** | Linux + Windows | Nuphus DesktopClient天然跨平台，直接复用 | 1周 |
| **第三期** | Android | Kotlin原生直通+SMCP task协议 | 2周 |
| **远期** | 鸿蒙 + iPhone | ArkTS/Swift原生直通 | 待定 |

**Rationale**: 
- macOS先行因为开发机就是Mac，调试最快
- Nuphus DesktopClient已支持macOS/Linux/Windows三平台，第二期几乎零成本
- Android需要Kotlin实现原生直通（截屏/Intent/NotificationListenerService），工作量大
- 鸿蒙和iPhone当前无优先级，远期规划

**Alternatives considered**:
- 全平台同步开发 → 资源分散，macOS验证慢
- 先做Android → 开发效率低，调试困难

## Data Model

### TaskMessage（任务消息）

```
TaskMessage {
  task_id: String          // UUID, 唯一标识
  capability: String       // 能力名: "screenshot" | "file.read" | "app.open" | "shell.exec" | "ocr" | ...
  params: Value            // 参数: { path: "/tmp/test.txt" } 或 { app: "Finder" }
  from: String             // 发起方agent_id
  priority: String         // "high" | "normal" | "low"
  timeout_secs: u32        // 超时秒数, 默认30
  created_at: i64          // 时间戳
}
```

### TaskResult（任务结果）

```
TaskResult {
  task_id: String          // 对应task_id
  status: String           // "success" | "error" | "rejected" | "timeout"
  data: Value              // 结果数据: 文本/JSON
  screenshots: Vec<String> // 执行截图base64列表（可视化）
  error_message: String?   // 错误信息
  execution_tier: String   // "native" | "nuphus" | "freecode" | "fallback"（用了哪层）
  duration_ms: u64         // 执行耗时
  created_at: i64          // 时间戳
}
```

### PermissionRule（权限规则）

```
PermissionRule {
  friend_id: String        // 好友ID
  capability: String       // 能力名, "*"表示所有
  policy: String           // "allow" | "ask" | "deny"
}
```

存储格式 (`~/.siliconmate/permissions.json`):
```
{
  "rules": [
    { "friend_id": "pantom", "capability": "screenshot", "policy": "allow" },
    { "friend_id": "pantom", "capability": "shell_exec", "policy": "ask" },
    { "friend_id": "*", "capability": "*", "policy": "ask" }
  ],
  "default_policy": "ask"
}
```

### SkillDeclaration（技能声明）

```
SkillDeclaration {
  agent_id: String
  capabilities: Vec<CapabilityInfo>
  platform: String         // "macos" | "linux" | "windows" | "android"
  nuphus_available: bool   // Nuphus引擎是否可用
}

CapabilityInfo {
  name: String             // "screenshot" | "file.read" | "app.open" | ...
  tier: String             // "native" | "nuphus" | "freecode"
  description: String      // "截取屏幕截图"
}
```

### TaskRoute（任务路由，扩展scene_router）

```
TaskRoute {
  capability: String       // 要执行的能力
  tier: RouteTier          // 路由到哪一层
}

RouteTier:
  - NativeDirect { command: String }     // 原生直通，指定Tauri命令名
  - NuphusEngine { method: String }      // Nuphus DesktopClient方法名
  - FreeCode { prompt: String }          // free-code深度思考
  - Fallback { system_cmd: String }      // 降级系统命令
```

## Contracts & Interfaces

### 新增Tauri命令清单

#### task_engine.rs (5个命令)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `task_execute` | `{ capability, params }` | `TaskResult` | 本地执行task，走三层路由 |
| `task_send` | `{ friend_id, capability, params }` | `{ task_id }` | 发送task给好友 |
| `task_result_poll` | `{ task_id }` | `TaskResult?` | 轮询task结果 |
| `task_list_capabilities` | `{}` | `Vec<CapabilityInfo>` | 列出本机可用能力 |
| `task_cancel` | `{ task_id }` | `{ success }` | 取消task |

#### nuphus_bridge.rs (4个命令)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `nuphus_screenshot` | `{ path?, region? }` | `{ success, path }` | Nuphus截屏 |
| `nuphus_execute` | `{ method, params }` | `Value` | 通用Nuphus方法调用 |
| `nuphus_status` | `{}` | `{ available, version }` | Nuphus引擎状态 |
| `nuphus_ocr` | `{ image_path }` | `{ text }` | Nuphus OCR（PaddleOCR） |

#### native_cmds.rs (4个命令)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `native_screenshot` | `{ path? }` | `{ success, path }` | macOS screencapture截屏 |
| `native_open_app` | `{ app_name }` | `{ success }` | macOS osascript打开APP |
| `native_shell_exec` | `{ command, timeout? }` | `{ stdout, stderr, exit_code }` | Shell命令执行 |
| `native_read_file` | `{ path, encoding? }` | `{ content, size }` | 读取文件内容 |

#### permission.rs (3个命令)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `permission_check` | `{ friend_id, capability }` | `{ policy }` | 检查权限策略 |
| `permission_set` | `{ friend_id, capability, policy }` | `{ success }` | 设置权限规则 |
| `permission_list` | `{}` | `Vec<PermissionRule>` | 列出所有规则 |

### SMCP消息扩展

在smcp.rs的SmcpMessage中扩展：

```
// 现有 type: "notify"（聊天消息）
// 新增 type: "task"
SmcpMessage {
  type: "task",
  method: "task.execute",
  params: {
    task_id: "uuid-xxx",
    capability: "screenshot",
    params: { region: "full" }
  }
}

// 新增 type: "result"
SmcpMessage {
  type: "result",
  method: "task.result",
  params: {
    task_id: "uuid-xxx",
    status: "success",
    data: { path: "/tmp/screenshot-xxx.png" },
    screenshots: ["base64..."],
    execution_tier: "nuphus",
    duration_ms: 1200
  }
}
```

### 三层路由决策逻辑

```
收到task(capability, params):
  1. 查原生直通表 → 命中? → native_cmds执行 → 返回result(tier: "native")
  2. 查Nuphus能力表 → 命中? → nuphus_bridge执行 → 返回result(tier: "nuphus")
  3. 查降级表 → 命中? → fallback系统命令 → 返回result(tier: "fallback")
  4. 都没命中 → free-code深度思考 → 返回result(tier: "freecode")
  5. free-code也不可用 → 返回error("能力不可用")
```

原生直通能力表（macOS第一期）：

| capability | native_cmds命令 | Nuphus方法 | fallback |
|-----------|----------------|-----------|----------|
| screenshot | native_screenshot | nuphus_screenshot | screencapture |
| app.open | native_open_app | window_activate | open -a |
| file.read | native_read_file | — | cat |
| shell.exec | native_shell_exec | — | 直接执行 |
| ocr | ocr.extract_text | nuphus_ocr | — |
| feishu.send | feishu_send_message | — | — |
| feishu.doc | feishu_create_doc | — | — |
| clipboard.read | — | clipboard_read | pbpaste |
| clipboard.write | — | clipboard_write | pbcopy |

### 前端消息渲染约定

Agent执行结果消息在对话中的视觉区分：

| 层 | 图标 | 边框色 | 示例 |
|---|------|--------|------|
| ⚡ 原生直通 | ⚡ | 绿色(#4CAF50) | "⚡ 已截屏 (0.3秒)" |
| 🤖 Nuphus | 🤖 | 蓝色(#2196F3) | "🤖 已打开Finder (1.2秒)" |
| 🧠 深度思考 | 🧠 | 紫色(#9C27B0) | "🧠 分析完成 (8秒)" |
| ⚠️ 降级 | ⚠️ | 橙色(#FF9800) | "⚠️ Nuphus不可用，降级系统命令" |

## Changelog

- 2026-09-13: 初始plan.md创建，基于Phase 1 spec + 代码库摸底
