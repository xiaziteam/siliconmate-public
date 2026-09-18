# Feature Specification: 硅侣2.0 UI完善（图标+文件上传+语音输入）

**Created**: 2026-08-30  
**Status**: Draft  
**Input**: 用户反馈三项UI缺失：①Dock图标显示纯蓝色占位符而非硅侣品牌图标 ②文件上传按钮点了没完善流程——用户上传图片后不能让GLM看到/分析图片 ③语音输入（🎤）按钮点了没反应，期望像微信输入法那样点即用

## Overview

硅侣2.0桌面端(E2E已跑通)的三个UI体验完善：应用图标从Tauri默认纯蓝占位符替换为硅侣品牌图标；文件上传流程补全——用户上传图片后通过客户端nuphus-mcp+OCR提取文字，将图片描述信息连同用户消息发给GLM分析；语音输入按钮激活系统语音听写功能，让用户可以用语音输入文字。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 应用图标显示硅侣品牌 (Priority: P1)

用户在macOS Dock上看到硅侣应用时，应该看到硅侣品牌图标（虾/硅基生命元素），而不是Tauri默认的纯蓝色方块。这是用户对应用的第一印象，当前纯蓝色方块无法识别是硅侣应用。

**Why this priority**: 应用图标是用户识别和定位应用的首要途径，纯蓝占位符严重影响专业感和品牌辨识度

**Independent Test**: 在macOS Dock或Launchpad中查看硅侣应用图标，确认显示的是硅侣品牌图标而非纯蓝色方块

**Acceptance Scenarios**:

1. **Given** 硅侣应用正在运行, **When** 用户查看Dock栏, **Then** 看到硅侣品牌图标（含虾/硅基生命元素），而非纯蓝色方块
2. **Given** 用户通过Launchpad搜索硅侣, **When** 找到硅侣应用, **Then** 应用图标清晰可辨、与品牌一致

---

### User Story 2 - 图片上传与OCR分析 (Priority: P1)

用户想让硅侣分析一张图片（如截图、文档照片），点击📎按钮选择图片→图片上传→OCR提取文字→连同用户消息一起发给GLM→GLM基于提取的文字内容回复分析结果。如果用户对OCR结果不满意，可以进一步要求视觉分析（走服务端更强模型）。

**Why this priority**: 图片识别是核心场景之一（截图文字提取、文档识别等），当前📎按钮虽然有文件选择器但没有后续处理流程

**Independent Test**: 上传一张含文字的图片，硅侣通过OCR提取文字并由GLM给出分析

**Acceptance Scenarios**:

1. **Given** 用户在聊天界面, **When** 点击📎按钮选择一张含中文的图片, **Then** 图片缩略图显示在输入框上方，标注为"📷 图片"
2. **Given** 图片已选择且用户输入了问题（如"这个图片讲了什么"）, **When** 点击发送, **Then** 系统通过OCR提取图片文字，将OCR结果和用户问题合并发给GLM，GLM基于提取内容回复
3. **Given** 图片已选择且用户未输入问题, **When** 点击发送, **Then** 系统自动OCR提取文字，将OCR结果发给GLM，GLM自动分析图片内容
4. **Given** OCR提取失败（如纯图形无文字）, **When** 发送消息, **Then** 系统提示"图片未识别到文字"，仍将文件信息发给GLM处理
5. **Given** 用户对OCR结果不满意, **When** 用户说"请用视觉分析", **Then** 系统通过场景路由将图片提交给服务端更强模型

---

### User Story 3 - 语音输入 (Priority: P2)

用户点击🎤按钮后，应该能像微信语音输入一样开始说话→语音转文字→文字填入输入框。在macOS上优先使用系统自带的语音听写功能（无需安装微信输入法）；如果系统语音听写不可用，使用Web Speech API作为备选；Linux上两者都不可用时，显示"当前平台暂不支持语音输入"提示。

**Why this priority**: 语音输入是重要的交互方式，但相比图标和文件上传优先级略低，且有平台兼容性挑战

**Independent Test**: 点击🎤按钮后开始说话，语音转文字后显示在输入框中

**Acceptance Scenarios**:

1. **Given** 用户在macOS上使用硅侣, **When** 点击🎤按钮, **Then** 激活macOS系统语音听写，用户说话后文字自动填入输入框
2. **Given** 系统语音听写不可用（如权限未授权）, **When** 点击🎤按钮, **Then** 自动降级到Web Speech API语音识别
3. **Given** macOS上两种方式都不可用, **When** 点击🎤按钮, **Then** 显示提示"语音输入暂不可用，请检查系统权限设置"
4. **Given** 用户在Linux上使用硅侣, **When** 点击🎤按钮, **Then** 显示提示"Linux平台暂不支持语音输入，需自行开发语音识别模块"
5. **Given** 语音输入正在进行中, **When** 再次点击🎤按钮, **Then** 停止语音识别，已识别的文字保留在输入框中

---

### Edge Cases

- 上传非图片文件（PDF/Office/文本）时如何处理？→ 走现有的场景路由逻辑（Office→服务端，其他→客户端读取）
- 上传多张图片时如何处理？→ 逐个OCR，合并所有OCR结果
- 上传超大图片（>100MB）时？→ 提示文件过大，建议压缩后上传
- 语音输入中途用户切换到其他应用？→ 暂停/停止语音识别
- 图标在深色/浅色模式下是否清晰？→ 图标设计需在两种模式下都可识别

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 应用图标MUST使用硅侣品牌图标，替代当前Tauri默认纯蓝色占位符
- **FR-002**: 图标MUST包含所有Tauri要求的尺寸：32x32、128x128、128x128@2x(256x256)、icns(macOS)、ico(Windows)
- **FR-003**: 用户点击📎按钮MUST能选择本地文件（图片/文档/其他）
- **FR-004**: 用户选择图片后MUST显示图片预览标识（缩略图或文件名+类型标签）
- **FR-005**: 发送含图片的消息时MUST先通过OCR提取图片文字，然后将OCR结果和用户消息合并发给GLM
- **FR-006**: 用户未输入问题只上传图片时MUST自动发送OCR结果让GLM分析
- **FR-007**: OCR失败时MUST提示用户"图片未识别到文字"，并仍将文件信息发给GLM
- **FR-008**: 🎤按钮点击后MUST激活语音输入功能，将识别文字填入输入框
- **FR-009**: macOS上MUST优先使用系统语音听写（Accessibility/Speech Recognition API）
- **FR-010**: 系统语音听写不可用时MUST降级到Web Speech API
- **FR-011**: Linux上MUST显示"暂不支持语音输入"提示
- **FR-012**: 语音输入激活/停止状态MUST有视觉反馈（按钮变色/动画）
- **FR-013**: 上传图片的完整路径MUST传递给Rust后端OCR模块（ocr.rs extract_text）
- **FR-014**: 文件选择器MUST支持图片格式过滤（png/jpg/jpeg/gif/bmp/webp/svg）
- **FR-015**: Tauri前端获取文件路径后MUST通过invoke调用Rust命令处理文件

### Key Entities

- **图片附件**: 用户上传的图片文件，属性包含本地路径、文件名、MIME类型、文件大小
- **OCR结果**: tesseract从图片提取的文字文本，属性包含提取文字内容、是否成功、耗时
- **语音识别状态**: 当前语音输入的激活/停止状态，属性包含是否激活、使用的识别方式（系统听写/Web Speech/不可用）

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Dock栏硅侣图标可辨识为硅侣品牌，5个测试者中4个能通过图标识别应用
- **SC-002**: 上传含中文图片后3秒内OCR提取完成，GLM基于OCR结果给出相关回复
- **SC-003**: macOS上点击🎤按钮1秒内激活语音输入，用户说话后文字出现在输入框中
- **SC-004**: 所有三个功能（图标/上传/语音）在首次使用时无需额外安装软件（除tesseract外）

## Assumptions

- macOS系统语音听写功能可通过Tauri WebView的Web Speech API或系统调用激活
- tesseract CLI已安装或可在首次使用OCR时提示安装（brew install tesseract tesseract-lang）
- nuphus-mcp在客户端本地运行，可处理图片文件
- 硅侣品牌图标素材需由用户提供或用程序生成简约风格
- 语音聊天（ChatGPT透传）暂不在本feature范围内
- Web Speech API在Tauri2 WebView(WebKit)中基本可用

## Open Questions

- 硅侣品牌图标的具体设计方案？用户说"之前已经做好了"但当前icons/目录全是Tauri默认纯蓝占位符，需要确认图标源文件位置或由程序生成
- macOS系统语音听写的最佳调用方式？需验证Tauri2 WebView中Web Speech API的可用性和macOS Dictation的集成方式
- nuphus-mcp是否已具备图片处理能力？如果nuphus-mcp不可用，OCR是唯一图片处理通道
