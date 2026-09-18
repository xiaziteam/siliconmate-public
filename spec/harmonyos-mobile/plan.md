# Implementation Plan: 硅侣鸿蒙手机版

**Input**: Feature specification from `spec/harmonyos-mobile/spec.md`

## Summary

硅侣鸿蒙手机版采用"云窗口"薄客户端架构：鸿蒙ArkTS App只负责UI交互+网络通信，所有Agent能力（free-code+zhipu-bridge+OfficeCLI）运行在鬼子虾2号VPS上。手机端通过HTTPS API与VPS2通信，核心功能：文字聊天→文件上传统一入口（图片OCR/Office解析自动路由）→语音输入（鸿蒙CoreSpeechKit）→ChatGPT语音聊天透传（WebView）。复用现有account服务。

## Technical Context

**Language/Version**: ArkTS (HarmonyOS NEXT API 12+)
**Primary Dependencies**: @kit.CoreSpeechKit (语音识别), @kit.MediaLibraryKit (PhotoViewPicker), @kit.CoreFileKit (DocumentViewPicker+文件上传), @kit.ArkWeb (WebView), @ohos.net.http (网络请求)
**State Management**: State Management V2 (新项目, @ComponentV2 + @Param/@Local)
**Storage**: 首选项(Preferences) 存储session/token, 应用沙箱缓存消息历史
**Testing**: 手动E2E测试 (模拟器+真机)
**Target Platform**: HarmonyOS NEXT (手机, API 12+)
**Project Type**: Mobile App (鸿蒙原生)
**Performance Goals**: 消息回复<10s, 文件上传+处理<30s, 语音输入激活<2s
**Constraints**: 安装包<30MB; 不申请相册/相机权限(用系统Picker); 网络断开时显示历史消息
**Scale/Scope**: 单用户手机App, 5个页面/视图

## Project Structure

### Documentation (this feature)

```text
spec/harmonyos-mobile/
├── spec.md              # Feature specification
├── plan.md              # This file
└── tasks.md             # Task breakdown (Phase 3)
```

### Source Code (repository root)

```text
siliconmate-harmony/
├── entry/
│   └── src/main/
│       ├── ets/
│       │   ├── entryability/
│       │   │   └── EntryAbility.ets          # 应用入口,生命周期
│       │   ├── pages/
│       │   │   ├── Index.ets                  # 导航入口(Navigation)
│       │   │   ├── LoginPage.ets              # 登录页
│       │   │   ├── ChatPage.ets               # 聊天主页(消息列表+输入栏)
│       │   │   └── VoiceChatPage.ets          # ChatGPT语音聊天页(WebView)
│       │   ├── components/
│       │   │   ├── MessageBubble.ets          # 消息气泡组件
│       │   │   ├── InputBar.ets               # 输入栏(文字+📎+🎤+🗣️)
│       │   │   └── FileChip.ets               # 文件附件标识(📷/📄+状态)
│       │   ├── viewmodel/
│       │   │   └── ChatViewModel.ets          # 聊天状态管理(消息/附件/语音/发送)
│       │   ├── model/
│       │   │   └── ChatModels.ets             # 数据类型定义(Message/Attachment/VoiceState)
│       │   ├── service/
│       │   │   ├── ApiService.ets             # VPS2 HTTPS API通信
│       │   │   ├── AccountService.ets         # account服务登录/心跳
│       │   │   ├── FileUploadService.ets      # 文件选择+上传到VPS2
│       │   │   └── SpeechService.ets          # 语音识别(CoretSpeechKit)
│       │   └── common/
│       │       ├── Constants.ets              # 常量(API_URL/超时/限制)
│       │       └── HttpManager.ets            # HTTP封装(拦截器/Token/错误处理)
│       └── resources/
│           ├── base/
│           │   ├── media/                     # 硅侣品牌图标(紫蓝渐变)
│           │   ├── element/                   # string.json/color.json
│           │   └── profile/                   # module.json5权限配置
│           └── rawfile/                       # WebView HTML (ChatGPT透传页面)
├── build-profile.json5
├── hvigorfile.ts
└── oh-package.json5
```

**Structure Decision**: 选择MVVM架构。理由：5个页面+4个Service+跨页面状态(消息/附件/语音)，需要ViewModel集中管理业务逻辑。文件数量控制在6-12个ArkTS文件范围内，按职责边界分组。Model/Service/ViewModel分离确保可测试性和维护性。新项目使用State Management V2。

## Complexity Tracking

无违规项。

## Research & Decisions

### Decision 1: 云窗口架构 — 手机薄客户端+VPS2服务端Agent
- **Decision**: 鸿蒙App只做UI和网络层，所有Agent能力(free-code+zhipu-bridge+OfficeCLI)运行在VPS2上，通过HTTPS API通信
- **Rationale**: 鸿蒙手机无法运行free-code子进程；VPS2已有完整Agent栈；薄客户端架构简单可靠
- **Alternatives considered**:
  - 手机端直接调GLM API: 失去Agent能力(free-code的工具调用/OfficeCLI)
  - 手机端跑轻量Agent: 鸿蒙不支持free-code运行环境

### Decision 2: VPS2 HTTP API网关
- **Decision**: 在VPS2上新建轻量HTTP API网关(Node.js/Python)，接收手机端请求，内部调用free-code处理并返回结果
- **Rationale**: 手机端需要一个稳定的HTTPS入口，网关负责认证→调用free-code→返回结果
- **Alternatives considered**:
  - 复用zhipu-bridge: zhipu-bridge只做Anthropic↔智谱翻译，不处理文件上传/OfficeCLI
  - SSH直连: 手机端无法SSH，且不安全

### Decision 3: 文件上传统一入口
- **Decision**: 一个📎按钮，调用PhotoViewPicker(图片)+DocumentViewPicker(Office)，服务端根据文件类型自动路由：图片→OCR, Office→OfficeCLI
- **Rationale**: 用户无需关心后端处理逻辑，一个按钮搞定所有文件；系统Picker无需申请相册/相机权限
- **Alternatives considered**:
  - 分离图片/Office按钮: 增加UI复杂度，用户选择成本高
  - 自定义文件管理器: 需申请敏感权限，审核困难

### Decision 4: 语音输入 — 鸿蒙CoreSpeechKit
- **Decision**: 使用@kit.CoreSpeechKit的speechRecognizer实现实时语音转文字，需申请ohos.permission.MICROPHONE权限
- **Rationale**: 鸿蒙原生语音识别，支持中英文，实时转写，延迟低(<2s)
- **Alternatives considered**:
  - Web Speech API: 鸿蒙WebView中不可靠
  - 第三方语音SDK: 增加依赖和包体积

### Decision 5: ChatGPT语音聊天 — WebView透传
- **Decision**: 使用@kit.ArkWeb的Web组件加载ChatGPT Web版(chat.openai.com)，用户直接在WebView内进行语音对话
- **Rationale**: ChatGPT Web版自带语音对话功能，WebView透传最简单；VPS2可做反向代理解决网络限制
- **Alternatives considered**:
  - ChatGPT API语音: 需要API key+TTS，非Web版体验
  - 本地语音模型: 质量不如ChatGPT，且包体积大

### Decision 6: 网络通信 — @ohos.net.http封装
- **Decision**: 封装HttpManager统一处理HTTPS请求，内置拦截器(Token自动携带/401重试/超时/错误处理)
- **Rationale**: 统一网络层管理，Token自动刷新，错误统一处理
- **Alternatives considered**:
  - axios/第三方HTTP库: 鸿蒙生态不成熟，原生API更稳定

### Decision 7: 账号体系 — 复用现有account服务
- **Decision**: 复用<VPS_IP>:8444的account服务，登录获取sessionId，30分钟心跳保活
- **Rationale**: 与桌面版同一套账号，无需新建用户体系
- **Alternatives considered**:
  - 新建鸿蒙专用账号: 增加开发成本和用户注册负担
  - 无登录模式: 不安全，无法区分用户

## Data Model

### ChatMessage
```
ChatMessage {
  id: string              // 唯一ID
  role: 'user' | 'assistant'
  content: string         // 消息文本
  attachments: FileAttachment[]  // 附件列表
  timestamp: number       // 时间戳
  status: 'sending' | 'sent' | 'received' | 'error'
  isStreaming: boolean    // 是否流式输出中
}
```

### FileAttachment
```
FileAttachment {
  uri: string             // 本地URI (picker返回)
  fileName: string        // 文件名
  fileSize: number        // 字节大小
  mimeType: string        // MIME类型
  fileType: 'image' | 'office' | 'other'  // 分类
  uploadStatus: 'pending' | 'uploading' | 'success' | 'failed'
  uploadProgress: number  // 0-100
  processResult: string   // 服务端处理结果(OCR文本/Office解析内容)
}
```

### SessionInfo
```
SessionInfo {
  sessionId: string
  vpsUrl: string          // VPS2 API地址
  isLoggedIn: boolean
  lastHeartbeat: number
}
```

### VoiceState
```
VoiceState {
  isRecording: boolean
  isAvailable: boolean     // 语音识别是否可用
  transcript: string       // 已识别文字
}
```

## Contracts & Interfaces

### VPS2 HTTPS API (手机端→服务端)

1. **POST /api/chat**
   - 请求: `{ message: string, attachments?: AttachmentInfo[], sessionId: string }`
   - 响应: `{ reply: string, status: 'success' | 'error' }`
   - 逻辑: 网关调用free-code处理消息+附件，返回GLM回复

2. **POST /api/upload**
   - 请求: `multipart/form-data` (文件+sessionId)
   - 响应: `{ fileId: string, processResult: string, fileType: string }`
   - 逻辑: 上传文件到VPS2，服务端自动识别类型并处理(OCR/OfficeCLI)

3. **GET /api/health**
   - 响应: `{ ok: boolean, service: string }`
   - 逻辑: VPS2健康检查

### Account服务 (手机端→account服务)

4. **POST /api/login** (复用现有)
   - 请求: `{ username: string, password: string }`
   - 响应: `{ sessionId: string, token: string }`

5. **POST /api/heartbeat** (复用现有)
   - 请求: `{ sessionId: string }`
   - 响应: `{ status: 'alive' }`

### 前端内部接口 (ViewModel→Service)

6. **ChatViewModel.sendMessage(text, attachments?)**
   - 调用ApiService.chat(), 处理loading状态和错误

7. **FileUploadService.selectAndUpload(context)**
   - 先调PhotoViewPicker/DocumentViewPicker, 再调ApiService.upload()

8. **SpeechService.startListening() / stopListening()**
   - 创建speechRecognizer引擎, 设置回调, 开始/停止监听
