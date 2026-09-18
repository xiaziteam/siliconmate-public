# Feature Specification: 硅侣Agent能力升级

**Created**: 2026-09-13  
**Status**: Draft  
**Input**: 硅侣从IM工具升级为虾群级Agent——一句话解决，界面操作，远程协作

## Overview

硅侣当前是一个完整的IM应用（聊天/好友/群聊/文件），但只具备"信息传达"能力——收到消息只显示给人看，人自己操作。本次升级将硅侣从"聊天工具"进化为"虾群Agent"：收到任务消息后本地自主执行，执行结果回传，多个硅侣之间可远程协作完成复杂任务。

### 核心原则：不造轮子，整合现有顶级能力；原生直通，极速极省；已有能力Agent化

硅侣不自己开发Agent引擎，而是整合三层已有能力，并叠加自己独有的"原生直通"优势：

| 层 | 能力来源 | 硅侣角色 | 典型场景 |
|---|---------|---------|---------|
| **最高智商层** | free-code（VPS鬼子虾2号） | 深度思考时调用 | 复杂推理/代码生成 |
| **Computer Use层** | Nuphus引擎 | 通用操作时调用 | 未知界面操控/Workflow |
| **原生直通层** | 硅侣已有能力Agent化 | 高频操作瞬间完成 | 见下表 |

**硅侣已有但未Agent化的能力**（72个Tauri命令，scene_router已实现路由）：

| 已有能力 | 实现方式 | Agent化后的一句话场景 |
|---------|---------|---------------------|
| ⚡ OCR | Apple Vision(macOS) / ML Kit(Android) | "识别这张图上的文字" |
| ⚡ 飞书输出 | lark-cli发消息/建文档 | "把这个发到飞书群里"/"新建飞书文档" |
| ⚡ Office CLI | VPS OfficeCLI读/写docx/xlsx/pptx | "读一下这个Excel"/"生成PPT" |
| ⚡ 语音输入 | macOS原生录音+转文字 | "开始录音"（已有，语音按钮触发） |
| ⚡ ChatGPT桥接 | Obscura Cookie注入+WebView | "问ChatGPT xxx" |
| ⚡ 截屏 | screencapture(macOS) | "截屏"（需新增命令） |
| ⚡ 打开APP | osascript(macOS)/Intent(Android) | "打开微信"（需新增命令） |
| ⚡ Shell执行 | Process::Command | "运行ls -la"（需新增命令） |
| ⚡ 读文件 | Tauri文件API | "读/tmp/test.txt"（需新增命令） |
| ⚡ SMCP通讯 | 26个SMCP命令 | "让pantom帮我截屏"（需task协议） |
| 🤖 深度思考 | VPS AgentChat + free-code | "深度分析这个问题"（已有） |

**关键洞察**：硅侣已有scene_router做智能路由，已有72个Tauri命令，已有OCR/飞书/Office/ChatGPT/语音等能力。缺的不是"能力"，缺的是：
1. SMCP task协议——让这些能力可以被远程触发
2. 执行引擎封装——让这些能力收到task时自动执行而非只显示
3. 少量新命令——截屏/打开APP/Shell/读文件（macOS已有基础，Android需新增）
4. Nuphus整合——当已有能力不够时，调用通用Computer Use

**硅侣的杀手锏——原生直通**：普通Computer Use方案（截屏→最强模型→理解→操作→再截屏）读微信未读消息需要5-6轮模型调用，耗时30秒+，token大量消耗。硅侣通过系统API（NotificationListenerService / Accessibility Service）直接读取，0.1秒完成，零模型调用，零token消耗。

- **free-code** 放VPS上当"最强大脑"，深度思考时上场，不需要魔改
- **Nuphus** 作通用Computer Use引擎，复杂/未知界面操控时调用，不需要魔改
- **已有能力Agent化** — OCR/飞书/Office/ChatGPT/语音→加task协议即可远程触发
- **硅侣原生** 做高频特定操作，直通系统API，这是独有的效率优势

### 用户愿景

用户只需一句话，AI理解意图、拆解为操作、调用本地能力执行、结果自动回传。同时界面保留手动操作入口——懂操作的人可以精确控制，不懂的人一句话也能达成。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 一句话操控本机 (Priority: P1)

用户在硅侣对话中输入"截个屏给我看"，硅侣调用Nuphus引擎执行截屏，截图直接显示在对话中。无需手动操作，一句话完成。

**Why this priority**: Agent能力的最基础证明——硅侣不再只是"帮你传话"，而是"帮你干活"。截屏是最安全的只读操作，且Nuphus已有完整实现，整合成本最低。

**Independent Test**: 在macOS硅侣对话中输入截屏指令，验证截图自动出现在对话中。纯本地闭环，不依赖远程。

**Acceptance Scenarios**:

1. **Given** 用户在硅侣对话中, **When** 用户输入"截屏"或"截图给我看", **Then** 硅侣调用Nuphus DesktopClient截屏，截图出现在对话消息中，附带文字"已截屏"
2. **Given** 用户在硅侣对话中, **When** 用户输入"截屏并发给pantom", **Then** 硅侣截屏后通过SMCP发送给好友pantom，pantom端收到截图消息
3. **Given** Nuphus引擎不可用, **When** 输入截屏指令, **Then** 硅侣降级调用系统screencapture命令（macOS），不崩溃

---

### User Story 2 - 远程派任务 (Priority: P2)

用户A对硅侣说"让pantom帮我在他电脑上找一下report.txt"，A的硅侣通过SMCP将任务发给pantom的硅侣，pantom的硅侣调用本地Nuphus引擎搜索文件，找到后回传结果给A。

**Why this priority**: 虾群协作的核心——Agent间不只是传聊天消息，而是传任务并自主执行。这是硅侣区别于Nuphus的关键能力（Nuphus没有多账户协作）。

**Independent Test**: 两个硅侣账号互为好友，一方发送任务消息，另一方自动执行并回传结果。可独立于Nuphus整合测试（用简单Tauri命令如"读文件"替代Nuphus操作）。

**Acceptance Scenarios**:

1. **Given** A和B互为SMCP好友, **When** A对硅侣说"让B读一下/tmp/test.txt", **Then** B的硅侣收到task消息，自动读取文件内容，result回传给A，A看到文件内容
2. **Given** A发送任务给B, **When** B未授权此类操作, **Then** B端弹出审批，同意后执行，拒绝后A收到"对方拒绝"
3. **Given** A发送任务给B, **When** B执行失败（文件不存在）, **Then** A收到result: {status: "error", message: "文件不存在"}

---

### User Story 3 - 本机App操控 (Priority: P3)

用户对硅侣说"打开微信"，硅侣调用Nuphus DesktopClient打开APP。用户说"给张三发微信说你好"，Nuphus引擎截屏→识别→操作→发送，全程截图记录。

**Why this priority**: "达到真人操作"的关键，但需要Nuphus完整集成（含视觉理解+操作链）。P1截屏是基础，P3是完整形态。

**Independent Test**: macOS上说"打开Finder"，验证Finder窗口弹出。Android上说"打开设置"，验证设置APP启动。

**Acceptance Scenarios**:

1. **Given** 用户在macOS硅侣中, **When** 说"打开Finder", **Then** Nuphus DesktopClient激活Finder，硅侣回复"已打开Finder"
2. **Given** 用户在Android硅侣中, **When** 说"打开设置", **Then** Intent启动设置APP，硅侣回复"已打开设置"
3. **Given** 用户说"给张三发微信说你好", **When** Nuphus执行多步操作, **Then** 每步截图展示在对话中，最终确认消息已发送

---

### User Story 4 - 技能声明与发现 (Priority: P3)

每个硅侣在SMCP注册时声明本机能力（基于Nuphus集成状态），好友可查看。发送任务时系统只投递给有对应能力的硅侣。

**Why this priority**: 虾群协作的发现机制。P1/P2用"盲发+失败回退"，技能声明是后续优化。

**Independent Test**: 两个硅侣互为好友，一方查看另一方能力列表，确认正确。

**Acceptance Scenarios**:

1. **Given** 硅侣A声明能力["screenshot","file.read","app.open"], **When** B查看A的能力, **Then** B看到三项能力
2. **Given** B想让A截屏, **When** B发送截屏任务, **Then** 系统确认A有截屏能力，正常投递
3. **Given** B想让A拍照但A无此能力, **When** B发送拍照任务, **Then** 系统提示"对方不支持拍照"

---

### Edge Cases

- AI无法理解意图 → 回复"我没理解，你可以试试：截屏 / 打开xxx / 读文件xxx"
- Nuphus引擎不可用 → 降级到系统命令（screencapture/osascript），不崩溃
- 远程任务审批超时 → 显示"等待审批中..."，30分钟后自动取消
- 执行出错（权限不足/APP崩溃）→ 截屏+错误信息回传
- 多任务同时到达 → 串行排队执行
- 危险操作（删除/格式化/发短信）→ 二次确认，零遗漏

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 硅侣MUST实现SMCP task/result消息协议——task消息交给执行引擎而非聊天UI，result消息自动回传
- **FR-002**: 硅侣MUST将已有72个Tauri命令Agent化——收到task时自动调用对应命令，结果回传。已有能力（OCR/飞书/Office/ChatGPT/语音）无需重写，只加task协议层
- **FR-003**: 硅侣MUST扩展scene_router支持task路由——收到task消息时，按能力名路由到对应Tauri命令或Nuphus
- **FR-004**: 硅侣MUST新增macOS原生直通命令：screenshot(截屏)、open_app(打开APP)、shell_exec(执行命令)、read_file(读文件)——基于系统API，零模型依赖
- **FR-005**: 硅侣MUST新增Android原生直通能力：截屏(MediaProjection)、打开APP(Intent)、读通知(NotificationListenerService)、读文件
- **FR-006**: 硅侣MUST整合Nuphus DesktopClient作为macOS/Linux通用Computer Use引擎——当原生直通能力不够时调用（复杂界面操控/Workflow）
- **FR-007**: 硅侣MUST保留free-code(VPS)深度思考对接——已有功能，不需要改动
- **FR-008**: 硅侣MUST实现能力路由优先级——原生直通(⚡最快)→Nuphus(🤖通用)→free-code(🧠最强)
- **FR-009**: 硅侣MUST支持远程任务审批——收到task时弹窗请求用户同意，支持"始终允许/每次询问/始终拒绝"三档
- **FR-010**: 硅侣MUST将执行过程可视化——关键步骤截图展示在对话中，透明可查
- **FR-011**: 硅侣MUST禁止高危操作（删除/格式化/发短信）除非界面二次确认
- **FR-012**: 硅侣MUST在Nuphus引擎不可用时降级到系统命令，不崩溃
- **FR-013**: 硅侣SHOULD支持技能声明——注册时发布本机能力列表（含原生直通+Nuphus能力），好友可查询
- **FR-014**: 硅侣SHOULD支持"你能做什么"指令——列出当前可用能力，区分⚡秒级和🤖需模型

### Key Entities

- **Agent Capability（能力）**: 硅侣本机可执行的操作，由Nuphus DesktopClient提供（macOS/Linux）或Android执行器提供。按平台分组，注册时声明。
- **Task Message（任务消息）**: SMCP消息的一种类型（type: "task"），包含task_id、目标能力、参数、发起方。与聊天消息共享传输通道，但接收方交给执行引擎而非聊天UI。
- **Task Result（任务结果）**: 执行后回传的消息（type: "result"），包含task_id、状态（success/error/rejected）、产出物（图片/文本/文件引用）。
- **Permission Rule（权限规则）**: 用户预设的审批策略——哪些好友/哪些操作可自动执行，哪些需实时审批。三档：allow/ask/deny。
- **Skill Declaration（技能声明）**: 注册时发布的自我描述，包含本机Nuphus集成状态和能力列表。
- **Execution Engine（执行引擎）**: 本地干活的核心，三层路由：①原生直通（系统API直调，毫秒级，零token）②Nuphus DesktopClient（通用Computer Use，需模型理解）③free-code（VPS深度思考，最强但最慢）。硅侣不造轮子，只做路由和调用。
- **Native Direct（原生直通）**: 硅侣独有的效率优势。通过系统API直接执行高频操作，不经过任何模型。Android: NotificationListenerService读通知、Accessibility读UI树、Intent打开APP。macOS: screencapture截屏、osascript打开APP、Process执行命令。这是硅侣区别于所有Computer Use方案的核心差异化。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 用户输入"截屏"后3秒内截图出现在对话中（macOS，Nuphus DesktopClient）
- **SC-002**: 远程任务端到端延迟<10秒（简单任务如读文件，不含审批等待时间）
- **SC-003**: 审批弹窗显示到可操作<1秒
- **SC-004**: 100%高危操作触发二次确认
- **SC-005**: Nuphus引擎不可用时降级到系统命令，零崩溃
- **SC-006**: 执行过程100%可视化（截图记录在对话中）

## Assumptions

- Nuphus代码库完整存在于 `/Users/apple/nuphus/`，可直接复用其DesktopClient/Agent引擎/MCP/Workflow
- 硅侣不重写Nuphus，而是作为调用方整合（crate引入或submodule）
- 硅侣现有LLM通道复用于Agent指令解析，不需要单独的NLU引擎
- VPS AgentChat已实现高阶推理，硅侣的深度思考功能已对接
- SMCP消息通道已通，只需扩展task/result类型
- Android端Accessibility Service已有基础（闲鱼自动化），可扩展
- macOS端AppleScript/osascript已有系统权限
- Android端Accessibility Service需用户手动授权（系统限制）
- 初期AI意图识别用关键词匹配+LLM兜底的混合方案

## Open Questions

- [NEEDS CLARIFICATION: Nuphus整合方式——Cargo workspace本地path引用 vs git submodule？建议本地path引用（nuphus就在本机/Users/apple/nuphus/），但需确认Nuphus crate的Cargo.toml是否可作为依赖直接引入]
- [NEEDS CLARIFICATION: Agent指令与聊天消息的UI呈现——建议混排+视觉区分（原生直通结果带⚡图标+绿色边框，Nuphus结果带🤖图标+蓝色边框，深度思考带🧠图标+紫色边框），是否认可？]
- [NEEDS CLARIFICATION: Android端原生直通优先实现哪些？建议第一期：读通知+截屏+打开APP+读文件（约2-3天），完整Accessibility操作链（点击/滑动/输入）放第二期（约1-2周）]
