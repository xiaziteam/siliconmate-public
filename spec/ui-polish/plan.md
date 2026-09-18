# Implementation Plan: 硅侣2.0 UI完善（图标+文件上传+语音输入）

**Input**: Feature specification from `spec/ui-polish/spec.md`

## Summary

硅侣2.0桌面端三项UI体验完善：①从旧项目复制三傻做的硅侣品牌图标替换Tauri默认纯蓝占位符 ②补全文件上传流程——Tauri file dialog获取本地文件路径→Rust OCR模块提取图片文字→合并OCR结果和用户消息发给GLM ③语音输入按钮激活Web Speech API（macOS/Windows可用），Linux上显示不支持提示。

## Technical Context

**Language/Version**: Rust (Tauri2 backend) + TypeScript/React (frontend)  
**Primary Dependencies**: Tauri2, tauri-plugin-dialog (file picker), tesseract CLI (OCR), Web Speech API (语音输入)  
**State Management**: React useState/useCallback (existing)  
**Storage**: 临时文件 /tmp/siliconmate-stdout.txt, /tmp/siliconmate-ocr.txt  
**Testing**: 手动E2E测试（Tauri dev模式）  
**Target Platform**: macOS (primary), Windows/Linux (secondary)  
**Project Type**: Desktop app (Tauri2)  
**Performance Goals**: OCR <3s, 语音识别激活 <1s  
**Constraints**: 不强迫用户安装微信输入法; macOS优先系统自带能力; tesseract可能未安装需graceful fallback  
**Scale/Scope**: 单用户桌面应用

## Project Structure

### Documentation (this feature)

```text
spec/ui-polish/
├── spec.md              # Feature specification
├── plan.md              # This file
└── tasks.md             # Task breakdown (Phase 3)
```

### Source Code (repository root)

```text
client/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs               # 注册新命令: process_image, detect_voice_support
│   │   ├── agent_manager.rs       # 修改: 支持附件上下文(OCR结果)注入消息
│   │   ├── ocr.rs                 # 现有: extract_text(image_path) → 可能需微调
│   │   └── voice_input.rs         # 新增: 语音输入管理(状态/平台检测)
│   ├── icons/
│   │   ├── 32x32.png              # 替换: 从旧项目复制三傻图标缩放
│   │   ├── 128x128.png            # 替换
│   │   ├── 128x128@2x.png         # 替换
│   │   ├── icon.icns              # 替换: 直接复制旧项目icon.icns
│   │   └── icon.ico               # 替换: 直接复制旧项目icon.ico
│   ├── Cargo.toml                 # 新增: tauri-plugin-dialog
│   └── tauri.conf.json            # 新增: dialog插件权限
├── src/
│   ├── App.tsx                    # 修改: handleSendMessage支持图片附件
│   ├── chat.tsx                   # 修改: 文件上传流程+语音输入按钮交互
│   ├── voice.tsx                  # 现有: 不修改(语音聊天=ChatGPT透传,暂不完善)
│   └── upload.tsx                 # 现有: 可能整合到chat.tsx或保持独立
```

**Structure Decision**: 遵循现有项目架构。在现有Tauri2+React结构上增量修改，新增voice_input.rs，修改已有文件。不引入MVVM或架构重构。

## Complexity Tracking

无违规项。

## Research & Decisions

### Decision 1: 图标来源 — 复制三傻旧项目图标
- **Decision**: 从 `/Users/apple/magic-chatgpt-app/src-tauri/icons/` 复制三傻制作的硅侣图标到新项目
- **Rationale**: 三傻已在旧项目中制作了紫蓝渐变+白色设计元素的圆角图标(512x512 RGBA)，用户确认这就是硅侣品牌图标，无需重新生成
- **Alternatives considered**: 
  - Python/PIL重新生成: 不必要，已有现成图标
  - 设计师制作: 过度投入

### Decision 2: 文件选择方案
- **Decision**: 使用 `tauri-plugin-dialog` 的文件选择功能
- **Rationale**: Tauri2官方推荐方式，跨平台原生文件选择对话框，返回文件路径可直接传给Rust OCR模块
- **Alternatives considered**: 
  - HTML `<input type="file">`: 在Tauri WebView中无法获取完整文件路径
  - 自定义Rust文件对话框: 需要额外依赖

### Decision 3: 图片处理流程
- **Decision**: 前端通过tauri-plugin-dialog获取文件路径 → invoke('process_image', {path}) → Rust端tesseract OCR → 返回OCR文本 → 合并到用户消息 → 发给GLM
- **Rationale**: OCR在Rust端执行（同步、快速），文本合并到消息中让GLM分析，无需修改agent_manager核心逻辑（只需在消息前拼接OCR结果）
- **Alternatives considered**:
  - nuphus-mcp处理图片: nuphus-mcp当前不可用/未部署在客户端
  - 直接将图片base64发给GLM: GLM-4-flash不支持视觉输入
  - 服务端视觉模型: 需额外路由，用户说不满意时再走此通道

### Decision 4: 语音输入方案
- **Decision**: 优先使用Web Speech API（`webkitSpeechRecognition`），macOS/Windows上Tauri WebView(WebKit)支持；不支持时显示平台提示
- **Rationale**: Web Speech API是浏览器原生能力，Tauri2 WebView(WebKit on macOS, WebView2 on Windows)基本支持，无需安装微信输入法或额外软件
- **Alternatives considered**:
  - macOS系统听写(NSSpeechRecognizer): 需要Tauri插件或Swift桥接，复杂度高
  - 微信输入法集成: 强迫用户安装第三方输入法，用户明确拒绝此路径
  - Whisper本地模型: 需下载模型文件(~1GB)，对桌面应用过重

### Decision 5: OCR不可用时的降级策略
- **Decision**: tesseract未安装时，提示用户安装(brew install tesseract tesseract-lang)，同时仍将文件名和类型信息发给GLM
- **Rationale**: 不因tesseract缺失而阻断用户操作，提供安装指引的同时保持功能降级可用

## Data Model

### 图片附件 (ImageAttachment)
```
ImageAttachment {
  path: String        // 本地文件绝对路径
  name: String        // 文件名
  mime_type: String   // MIME类型
  size_bytes: u64     // 文件大小
  ocr_text: Option<String>  // OCR提取结果（可能为空）
  ocr_status: OcrStatus     // Pending | Success | Failed | NotAvailable
}
```

### 语音输入状态 (VoiceInputState)
```
VoiceInputState {
  is_active: bool          // 是否正在录音
  platform: VoicePlatform  // Macos | Windows | Linux
  method: VoiceMethod      // WebSpeechApi | NotAvailable
  transcript: String       // 已识别的文字
}
```

## Contracts & Interfaces

### Rust Tauri Commands (新增/修改)

1. **`process_image(path: String) -> Result<ImageProcessResult, String>`**
   - 输入: 图片文件绝对路径
   - 输出: `ImageProcessResult { ocr_text: Option<String>, ocr_status: String, file_name: String, file_size: u64 }`
   - 逻辑: 验证文件存在→检查大小→调用tesseract OCR→返回结果
   - 错误: 文件不存在/文件过大/tesseract未安装/OCR失败

2. **`detect_voice_support() -> VoiceSupportInfo`**
   - 输入: 无
   - 输出: `VoiceSupportInfo { supported: bool, method: String, platform: String }`
   - 逻辑: 检测当前平台和可用的语音识别方式

### 前端接口 (TypeScript)

1. **chat.tsx handleFileSelect**:
   - 用户点击📎 → 调用tauri-plugin-dialog打开文件选择器(过滤图片格式)
   - 选择文件后 → invoke('process_image', {path}) → 获取OCR结果
   - 显示文件预览标识+OCR状态
   - 发送时将OCR文本合并到消息中

2. **chat.tsx handleMicInput**:
   - 用户点击🎤 → 检测平台支持 → 激活Web Speech API
   - 语音识别结果自动填入输入框
   - 再次点击停止识别
   - 按钮状态变化：默认灰→录音中红/脉冲动画

### 消息合并格式 (发给GLM的消息)

当消息包含图片OCR结果时：
```
[用户上传了图片: {filename}]
[图片文字识别结果]:
{ocr_text}

用户消息: {user_message}
```

当OCR失败时：
```
[用户上传了图片: {filename}，但文字识别未成功，请根据文件名和类型分析]

用户消息: {user_message}
```
