# Feature Specification: 硅侣鸿蒙手机版

**Created**: 2026-08-31
**Status**: Draft
**Input**: 硅侣2.0鸿蒙HarmonyOS NEXT手机客户端，云窗口架构，VPS2服务端运行free-code+OfficeCLI

## Overview

硅侣鸿蒙手机版是硅侣2.0桌面端的移动延伸，采用"云窗口"薄客户端架构——鸿蒙App只负责UI交互和网络通信，所有Agent能力（free-code + GLM + OfficeCLI）运行在鬼子虾2号VPS上。手机端通过HTTPS API与VPS通信，实现文字聊天、图片上传OCR、Office文件处理、语音输入和ChatGPT Web语音聊天透传。复用现有account服务(<VPS_IP>:8444)的账号体系。

## User Scenarios & Testing

### User Story 1 - 文字聊天对话 (Priority: P1)

用户打开硅侣App，在聊天界面输入文字消息，App通过HTTPS API将消息发送到VPS2，VPS2上的free-code通过zhipu-bridge调用GLM模型生成回复，回复通过API返回显示在手机聊天界面。

**Why this priority**: 这是硅侣的核心功能，没有聊天就没有产品价值。手机版是云窗口架构，不需要本地Agent能力。

**Independent Test**: 可以通过发送一条消息并收到GLM回复来完整测试，不依赖其他功能。

**Acceptance Scenarios**:

1. **Given** 用户已登录且网络正常, **When** 用户输入"你好"并发送, **Then** 聊天界面显示用户消息，随后显示GLM的回复（3秒内出现"正在思考"状态，10秒内收到回复）
2. **Given** 用户已登录但网络断开, **When** 用户尝试发送消息, **Then** 界面显示网络错误提示"网络不可用，请检查连接"
3. **Given** VPS2服务不可用, **When** 用户发送消息, **Then** 界面显示"服务暂时不可用"错误提示

---

### User Story 2 - 文件上传与智能处理 (Priority: P1)

用户点击上传按钮，选择任意文件（图片/Office/其他），App上传到VPS2。VPS2自动识别文件类型：图片→OCR提取文字；Office→OfficeCLI解析内容；其他→文件信息提取。处理结果与用户消息合并后交给GLM分析。一个上传按钮统一处理所有文件类型。

**Why this priority**: 文件上传是移动端高频场景，统一入口比分类按钮更简洁。服务端自动路由处理逻辑（图片OCR vs Office解析），用户无需关心后端差异。

**Independent Test**: 上传一张图片和一个Word文档，分别验证OCR结果和OfficeCLI解析结果及GLM分析回复。

**Acceptance Scenarios**:

1. **Given** 用户在聊天界面, **When** 点击📎上传按钮选择图片, **Then** 图片上传到VPS2，服务端OCR识别文字，GLM返回图片分析回复
2. **Given** 用户在聊天界面, **When** 点击📎上传按钮选择.docx/.xlsx/.pptx文件, **Then** 文件上传到VPS2，服务端OfficeCLI解析内容，GLM返回文档分析回复
3. **Given** 用户在聊天界面, **When** 点击📎上传按钮选择拍照, **Then** 调用系统相机拍照后图片进入上传流程
4. **Given** 文件过大(图片>10MB或Office>20MB), **When** 用户尝试上传, **Then** 提示"文件过大，建议压缩后上传"

---

### User Story 3 - 语音输入 (Priority: P2)

用户点击🎤按钮，鸿蒙系统语音识别将语音转为文字填入输入框，用户确认后发送。

**Why this priority**: 手机端语音输入比打字更自然，但P1功能先保证。

**Independent Test**: 点击🎤按钮说话，验证语音转文字填入输入框。

**Acceptance Scenarios**:

1. **Given** 用户在聊天界面, **When** 点击🎤按钮并说话, **Then** 语音识别文字实时填入输入框，🎤按钮变红色脉冲动画
2. **Given** 语音识别进行中, **When** 用户再次点击🎤按钮, **Then** 停止语音识别

---

### User Story 4 - ChatGPT语音聊天透传 (Priority: P2)

用户切换到语音聊天模式，App内嵌WebView加载ChatGPT Web版，用户通过ChatGPT进行语音对话。

**Why this priority**: 用户明确要求语音聊天不能阉割，这是ChatGPT Web透传功能，非GLM能力。

**Independent Test**: 切换到语音聊天模式，验证WebView加载ChatGPT Web并支持语音交互。

**Acceptance Scenarios**:

1. **Given** 用户在聊天界面, **When** 点击🗣️语音聊天按钮, **Then** 界面切换到WebView模式加载ChatGPT Web版
2. **Given** ChatGPT WebView已加载, **When** 用户点击ChatGPT语音按钮说话, **Then** ChatGPT进行语音对话

---

### User Story 5 - 登录与账号 (Priority: P1)

用户使用现有account服务登录，手机端与桌面端共享同一账号体系。

**Why this priority**: 登录是所有功能的前提。

**Independent Test**: 输入账号密码登录，验证成功进入聊天界面。

**Acceptance Scenarios**:

1. **Given** 用户未登录, **When** 打开App, **Then** 显示登录界面
2. **Given** 用户输入正确凭据, **When** 点击登录, **Then** 登录成功进入聊天界面
3. **Given** 用户已登录, **When** 30分钟后台保活心跳, **Then** 会话保持有效

### Edge Cases

- 网络切换（WiFi↔4G/5G）时消息发送如何处理？→ 显示重试提示
- VPS2响应超时（>30秒）如何处理？→ 显示超时提示+重试按钮
- 图片/Office文件上传中断？→ 显示上传失败+重试
- ChatGPT Web版需要登录但session过期？→ 提示用户重新登录ChatGPT

## Requirements

### Functional Requirements

- **FR-001**: App MUST通过HTTPS API与VPS2通信，发送用户消息并接收Agent回复
- **FR-002**: App MUST支持文字聊天，消息发送后显示"思考中"状态，回复流式/完整显示
- **FR-003**: App MUST提供统一文件上传按钮，支持图片（相册+拍照）和Office文件（.docx/.xlsx/.pptx），服务端自动路由处理逻辑
- **FR-004**: App MUST支持语音输入，使用鸿蒙系统语音识别能力将语音转为文字
- **FR-005**: App MUST支持ChatGPT Web语音聊天透传，通过内嵌WebView加载ChatGPT
- **FR-006**: App MUST复用现有account服务(<VPS_IP>:8444)进行登录认证
- **FR-007**: App MUST显示硅侣品牌图标（紫蓝渐变虾风格，对齐桌面版）
- **FR-008**: App MUST在VPS2不可用时显示友好错误提示
- **FR-009**: App MUST支持消息历史本地缓存，断网时可查看历史消息
- **FR-010**: App MUST在文件上传时显示上传进度和大小限制提示

### Key Entities

- **ChatMessage**: 消息记录（角色/内容/时间戳/附件信息/发送状态）
- **FileAttachment**: 附件（类型/文件名/大小/上传状态/OCR结果/Office解析结果）
- **SessionInfo**: 会话信息（sessionId/心跳状态/VPS2连接状态）
- **VoiceState**: 语音状态（录音中/空闲/平台支持检测）

## Success Criteria

### Measurable Outcomes

- **SC-001**: 用户从打开App到发出第一条消息并收到回复，全程<15秒（含登录）
- **SC-002**: 文件上传+服务端处理(OCR/OfficeCLI)+GLM回复完整流程<30秒
- **SC-003**: 语音输入激活到文字填入输入框<2秒
- **SC-004**: ChatGPT WebView加载完成<5秒
- **SC-005**: App在鸿蒙手机上安装包<30MB

## Assumptions

- 鬼子虾2号VPS(<VPS_IP>)运行free-code + zhipu-bridge + OfficeCLI，通过HTTPS API对外服务
- VPS2上需要部署一个轻量HTTP API网关，接收手机端请求并调用free-code处理
- 用户手机有稳定的4G/5G/WiFi网络
- 鸿蒙系统语音识别能力(speechRecognizer API)可用于语音输入
- ChatGPT Web版可在鸿蒙WebView中正常加载和语音交互
- 现有account服务(<VPS_IP>:8444)可从手机端HTTPS访问
- OfficeCLI已在VPS2上部署可用

## Open Questions

- VPS2上的HTTP API网关需要新建还是复用现有服务？(需要确认API设计)
- ChatGPT Web版是否需要在VPS2上做代理转发（避免手机端直连ChatGPT的网络限制）？
- 手机端是否需要消息加密传输？(account服务已是HTTPS)
