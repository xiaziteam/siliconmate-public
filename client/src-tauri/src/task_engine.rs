//! 硅侣3.0 — 任务执行引擎
//!
//! 接收task → 三层路由 → 执行 → 回传result
//! 三层路由：原生直通(⚡) → Nuphus(🤖) → free-code(🧠)
//! 降级链：每个capability有fallback路径

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, State};

// ── 数据结构 ──

/// 任务消息（来自本地或远程）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub task_id: String,
    pub capability: String,
    pub params: Value,
    pub from: String,
    pub priority: String,
    pub timeout_secs: u32,
    pub created_at: i64,
}

/// 任务结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub task_id: String,
    pub status: String,        // "success" | "error" | "rejected" | "timeout"
    pub data: Value,
    pub screenshots: Vec<String>, // base64 encoded
    pub error_message: Option<String>,
    pub execution_tier: String,   // "native" | "nuphus" | "freecode" | "fallback"
    pub duration_ms: u64,
    pub created_at: i64,
    /// 多步执行步骤（Computer Use用）
    pub steps: Vec<TaskStep>,
}

/// 任务执行步骤
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStep {
    pub step_num: u32,
    pub action: String,        // 操作描述
    pub capability: String,    // 使用的能力
    pub status: String,        // "success" | "error" | "skipped"
    pub screenshot: Option<String>, // base64
    pub result: Value,         // 步骤结果
    pub duration_ms: u64,
}

/// 任务路由目标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RouteTier {
    NativeDirect { command: String },
    NuphusEngine { method: String },
    FreeCode { prompt: String },
    Fallback { system_cmd: String },
}

/// 能力路由表条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityRoute {
    pub capability: String,
    pub native: Option<RouteTier>,
    pub nuphus: Option<RouteTier>,
    pub fallback: Option<RouteTier>,
    pub description: String,
}

/// 能力信息（前端展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityInfo {
    pub name: String,
    pub tier: String,
    pub description: String,
    pub available: bool,
}

/// 任务引擎（串行执行队列）
pub struct TaskEngine {
    /// 是否有任务正在执行
    is_processing: Mutex<bool>,
    /// 挂起的结果（task_id → result）
    pending_results: Mutex<std::collections::HashMap<String, TaskResult>>,
    /// 挂起的远程task（等待审批，task_id → PendingRemoteTask）
    pending_remote_tasks: Mutex<std::collections::HashMap<String, PendingRemoteTask>>,
    /// 路由表
    route_table: Vec<CapabilityRoute>,
}

impl TaskEngine {
    pub fn new() -> Self {
        Self {
            is_processing: Mutex::new(false),
            pending_results: Mutex::new(std::collections::HashMap::new()),
            pending_remote_tasks: Mutex::new(std::collections::HashMap::new()),
            route_table: Self::build_route_table(),
        }
    }

    /// 构建三层路由表
    fn build_route_table() -> Vec<CapabilityRoute> {
        vec![
            CapabilityRoute {
                capability: "screenshot".into(),
                native: Some(RouteTier::NativeDirect { command: "native_screenshot".into() }),
                nuphus: Some(RouteTier::NuphusEngine { method: "screenshot".into() }),
                fallback: Some(RouteTier::Fallback { system_cmd: "screencapture".into() }),
                description: "截取屏幕截图".into(),
            },
            CapabilityRoute {
                capability: "app.open".into(),
                native: Some(RouteTier::NativeDirect { command: "native_open_app".into() }),
                nuphus: Some(RouteTier::NuphusEngine { method: "window_activate".into() }),
                fallback: Some(RouteTier::Fallback { system_cmd: "open -a".into() }),
                description: "打开应用程序".into(),
            },
            CapabilityRoute {
                capability: "file.read".into(),
                native: Some(RouteTier::NativeDirect { command: "native_read_file".into() }),
                nuphus: None,
                fallback: None,
                description: "读取文件内容".into(),
            },
            CapabilityRoute {
                capability: "shell.exec".into(),
                native: Some(RouteTier::NativeDirect { command: "native_shell_exec".into() }),
                nuphus: None,
                fallback: None,
                description: "执行Shell命令".into(),
            },
            CapabilityRoute {
                capability: "ocr".into(),
                native: Some(RouteTier::NativeDirect { command: "ocr_extract_text".into() }),
                nuphus: Some(RouteTier::NuphusEngine { method: "ocr".into() }),
                fallback: None,
                description: "OCR文字识别".into(),
            },
            CapabilityRoute {
                capability: "feishu.send".into(),
                native: Some(RouteTier::NativeDirect { command: "feishu_send_message".into() }),
                nuphus: None,
                fallback: None,
                description: "发送飞书消息".into(),
            },
            CapabilityRoute {
                capability: "clipboard.read".into(),
                native: None,
                nuphus: Some(RouteTier::NuphusEngine { method: "clipboard_read".into() }),
                fallback: Some(RouteTier::Fallback { system_cmd: "pbpaste".into() }),
                description: "读取剪贴板".into(),
            },
            CapabilityRoute {
                capability: "clipboard.write".into(),
                native: None,
                nuphus: Some(RouteTier::NuphusEngine { method: "clipboard_write".into() }),
                fallback: Some(RouteTier::Fallback { system_cmd: "pbcopy".into() }),
                description: "写入剪贴板".into(),
            },
            CapabilityRoute {
                capability: "computer.use".into(),
                native: None,
                nuphus: Some(RouteTier::NuphusEngine { method: "execute".into() }),
                fallback: None,
                description: "Computer Use完整操控".into(),
            },
        ]
    }

    /// 查询路由表
    pub fn find_route(&self, capability: &str) -> Option<&CapabilityRoute> {
        self.route_table.iter().find(|r| r.capability == capability)
    }

    /// 列出所有可用能力
    pub fn list_capabilities(&self) -> Vec<CapabilityInfo> {
        self.route_table.iter().map(|route| {
            let available = route.native.is_some() || route.nuphus.is_some() || route.fallback.is_some();
            let tier = if route.native.is_some() { "native" }
                else if route.nuphus.is_some() { "nuphus" }
                else if route.fallback.is_some() { "fallback" }
                else { "unavailable" };
            CapabilityInfo {
                name: route.capability.clone(),
                tier: tier.to_string(),
                description: route.description.clone(),
                available,
            }
        }).collect()
    }
}

impl Default for TaskEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri Commands ──

/// 本地执行task（三层路由）
#[tauri::command]
pub async fn task_execute(
    engine: State<'_, TaskEngine>,
    nuphus: State<'_, crate::nuphus_bridge::NuphusBridge>,
    permission_store: State<'_, crate::permission::PermissionStore>,
    capability: String,
    params: Value,
) -> Result<TaskResult, String> {
    let start = std::time::Instant::now();
    let task_id = uuid::Uuid::new_v4().to_string();

    // 串行执行队列检查
    {
        let processing = engine.is_processing.lock().unwrap();
        if *processing {
            return Ok(TaskResult {
                task_id,
                status: "error".into(),
                data: serde_json::json!({}),
                screenshots: vec![],
                steps: vec![],
                error_message: Some("任务队列繁忙，请稍后重试".into()),
                execution_tier: "none".into(),
                duration_ms: start.elapsed().as_millis() as u64,
                created_at: chrono::Utc::now().timestamp_millis(),
            });
        }
    }

    // 标记为处理中
    {
        let mut processing = engine.is_processing.lock().unwrap();
        *processing = true;
    }

    let mut result = match execute_task_inner(&engine, &nuphus, &capability, &params, &task_id, start).await {
        Ok(r) => r,
        Err(e) => TaskResult {
            task_id: task_id.clone(),
            status: "error".into(),
            data: serde_json::json!({}),
            screenshots: vec![],
            steps: vec![],
            error_message: Some(e),
            execution_tier: "none".into(),
            duration_ms: start.elapsed().as_millis() as u64,
            created_at: chrono::Utc::now().timestamp_millis(),
        },
    };

    // 截图结果可视化：读取截图文件转base64
    if capability == "screenshot" && result.status == "success" {
        if let Some(path) = result.data.get("path").and_then(|v| v.as_str()) {
            if let Ok(bytes) = std::fs::read(path) {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                result.screenshots = vec![b64];
            }
        }
    }

    // 清除处理标记
    {
        let mut processing = engine.is_processing.lock().unwrap();
        *processing = false;
    }

    // 存储结果
    {
        let mut pending = engine.pending_results.lock().unwrap();
        pending.insert(task_id.clone(), result.clone());
    }

    Ok(result)
}

/// 内部执行逻辑
async fn execute_task_inner(
    engine: &TaskEngine,
    nuphus: &crate::nuphus_bridge::NuphusBridge,
    capability: &str,
    params: &Value,
    task_id: &str,
    start: std::time::Instant,
) -> Result<TaskResult, String> {
    let route = engine.find_route(capability)
        .ok_or_else(|| format!("不支持的能力: {}", capability))?;

    // 高危操作拦截：shell.exec需要检查黑名单
    if capability == "shell.exec" {
        if let Some(cmd) = params.get("command").and_then(|v| v.as_str()) {
            let dangerous_patterns = [
                "rm -rf /", "rm -rf /*", "format", "mkfs",
                "dd if=", "sms", "SMS", "发送短信",
            ];
            let cmd_lower = cmd.to_lowercase();
            for pattern in &dangerous_patterns {
                if cmd_lower.contains(pattern) {
                    return Ok(TaskResult {
                        task_id: task_id.to_string(),
                        status: "error".into(),
                        data: serde_json::json!({}),
                        screenshots: vec![],
                        steps: vec![],
                        error_message: Some("高危操作需界面确认".into()),
                        execution_tier: "none".into(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        created_at: chrono::Utc::now().timestamp_millis(),
                    });
                }
            }
        }
    }

    // 三层路由：native → nuphus → fallback
    // 层1: 原生直通
    if let Some(ref tier) = route.native {
        match execute_native_tier(tier, params).await {
            Ok(data) => return Ok(TaskResult {
                task_id: task_id.to_string(),
                status: "success".into(),
                data,
                screenshots: vec![],
                steps: vec![],
                error_message: None,
                execution_tier: "native".into(),
                duration_ms: start.elapsed().as_millis() as u64,
                created_at: chrono::Utc::now().timestamp_millis(),
            }),
            Err(e) => {
                // 原生失败，继续尝试下一层
                eprintln!("[task_engine] native tier failed for {}: {}, trying next", capability, e);
            }
        }
    }

    // 层2: Nuphus
    if let Some(ref tier) = route.nuphus {
        match execute_nuphus_tier(nuphus, tier, params).await {
            Ok(data) => return Ok(TaskResult {
                task_id: task_id.to_string(),
                status: "success".into(),
                data,
                screenshots: vec![],
                steps: vec![],
                error_message: None,
                execution_tier: "nuphus".into(),
                duration_ms: start.elapsed().as_millis() as u64,
                created_at: chrono::Utc::now().timestamp_millis(),
            }),
            Err(e) => {
                eprintln!("[task_engine] nuphus tier failed for {}: {}, trying fallback", capability, e);
            }
        }
    }

    // 层3: Fallback系统命令
    if let Some(ref tier) = route.fallback {
        match execute_fallback_tier(tier, params).await {
            Ok(data) => return Ok(TaskResult {
                task_id: task_id.to_string(),
                status: "success".into(),
                data,
                screenshots: vec![],
                steps: vec![],
                error_message: Some("Nuphus不可用，降级系统命令".into()),
                execution_tier: "fallback".into(),
                duration_ms: start.elapsed().as_millis() as u64,
                created_at: chrono::Utc::now().timestamp_millis(),
            }),
            Err(e) => {
                return Ok(TaskResult {
                    task_id: task_id.to_string(),
                    status: "error".into(),
                    data: serde_json::json!({}),
                    screenshots: vec![],
                    steps: vec![],
                    error_message: Some(format!("所有执行层均失败: {}", e)),
                    execution_tier: "none".into(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    created_at: chrono::Utc::now().timestamp_millis(),
                });
            }
        }
    }

    // 无可用执行层
    Ok(TaskResult {
        task_id: task_id.to_string(),
        status: "error".into(),
        data: serde_json::json!({}),
    screenshots: vec![],
    steps: vec![],
    error_message: Some("能力不可用，无可用执行层".into()),
        execution_tier: "none".into(),
        duration_ms: start.elapsed().as_millis() as u64,
        created_at: chrono::Utc::now().timestamp_millis(),
    })
}

/// 执行原生直通层
async fn execute_native_tier(tier: &RouteTier, params: &Value) -> Result<Value, String> {
    match tier {
        RouteTier::NativeDirect { command } => {
            match command.as_str() {
                "native_screenshot" => {
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    crate::native_cmds::do_native_screenshot(path)
                        .and_then(|result| serde_json::to_value(result).map_err(|e| e.to_string()))
                        .map_err(|e| format!("截图失败: {}（确认屏幕权限已授予）", e))
                }
                "native_open_app" => {
                    let app_name = params.get("app_name")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少app_name参数")?;
                    crate::native_cmds::do_native_open_app(app_name)
                        .and_then(|result| serde_json::to_value(result).map_err(|e| e.to_string()))
                        .map_err(|e| format!("打开应用失败: {}（确认应用名称正确）", e))
                }
                "native_shell_exec" => {
                    let command = params.get("command")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少command参数")?;
                    let timeout = params.get("timeout")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(30) as u32;
                    crate::native_cmds::do_native_shell_exec(command, timeout)
                        .and_then(|result| serde_json::to_value(result).map_err(|e| e.to_string()))
                        .map_err(|e| {
                            if e.contains("超时") {
                                format!("命令执行超时({}秒): {}", timeout, e)
                            } else if e.contains("黑名单") || e.contains("危险") {
                                format!("高危操作被拦截: {}", e)
                            } else {
                                format!("命令执行失败: {}", e)
                            }
                        })
                }
                "native_read_file" => {
                    let path = params.get("path")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少path参数")?;
                    crate::native_cmds::do_native_read_file(path)
                        .and_then(|result| serde_json::to_value(result).map_err(|e| e.to_string()))
                        .map_err(|e| {
                            if e.contains("禁止") || e.contains("敏感") {
                                format!("文件访问被拒绝: {}", e)
                            } else if e.contains("不存在") {
                                format!("文件不存在: {}", path)
                            } else if e.contains("过大") {
                                format!("文件过大(超过1MB): {}", path)
                            } else {
                                format!("读取文件失败: {}", e)
                            }
                        })
                }
                "ocr_extract_text" => {
                    let image_path = params.get("image_path")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少image_path参数")?;
                    crate::ocr::extract_text(image_path.to_string())
                        .map(|text| serde_json::json!({ "text": text }))
                        .map_err(|e| format!("OCR识别失败: {}（确认图片路径正确且格式支持）", e))
                }
                "feishu_send_message" => {
                    Err("飞书发送需通过feishu_output模块，请使用飞书专用指令".into())
                }
                _ => Err(format!("未知原生命令: {}", command)),
            }
        }
        _ => Err("非原生层".into()),
    }
}

/// 执行Nuphus层
async fn execute_nuphus_tier(
    nuphus: &crate::nuphus_bridge::NuphusBridge,
    tier: &RouteTier,
    params: &Value,
) -> Result<Value, String> {
    match tier {
        RouteTier::NuphusEngine { method } => {
            crate::nuphus_bridge::do_nuphus_execute(nuphus, method, params).await
        }
        _ => Err("非Nuphus层".into()),
    }
}

/// 执行Fallback系统命令层
async fn execute_fallback_tier(tier: &RouteTier, params: &Value) -> Result<Value, String> {
    match tier {
        RouteTier::Fallback { system_cmd } => {
            match system_cmd.as_str() {
                "screencapture" => {
                    // macOS screencapture
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let path = format!("/tmp/siliconmate-screenshot-{}.png", ts);
                    let output = tokio::process::Command::new("screencapture")
                        .args(["-x", &path])
                        .output()
                        .await
                        .map_err(|e| format!("screencapture失败: {}", e))?;
                    if output.status.success() {
                        Ok(serde_json::json!({ "success": true, "path": path }))
                    } else {
                        Err(format!("screencapture失败: {}", String::from_utf8_lossy(&output.stderr)))
                    }
                }
                "open -a" => {
                    let app_name = params.get("app_name")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少app_name参数")?;
                    let output = tokio::process::Command::new("open")
                        .args(["-a", app_name])
                        .output()
                        .await
                        .map_err(|e| format!("open命令失败: {}", e))?;
                    if output.status.success() {
                        Ok(serde_json::json!({ "success": true }))
                    } else {
                        Err(format!("open -a失败: {}", String::from_utf8_lossy(&output.stderr)))
                    }
                }
                "pbpaste" => {
                    let output = tokio::process::Command::new("pbpaste")
                        .output()
                        .await
                        .map_err(|e| format!("pbpaste失败: {}", e))?;
                    let text = String::from_utf8_lossy(&output.stdout).to_string();
                    Ok(serde_json::json!({ "text": text }))
                }
                "pbcopy" => {
                    let text = params.get("text")
                        .and_then(|v| v.as_str())
                        .ok_or("缺少text参数")?;
                    let mut child = tokio::process::Command::new("pbcopy")
                        .stdin(std::process::Stdio::piped())
                        .spawn()
                        .map_err(|e| format!("pbcopy启动失败: {}", e))?;
                    if let Some(mut stdin) = child.stdin.take() {
                        use tokio::io::AsyncWriteExt;
                        stdin.write_all(text.as_bytes()).await.map_err(|e| format!("pbcopy写入失败: {}", e))?;
                    }
                    child.wait().await.map_err(|e| format!("pbcopy等待失败: {}", e))?;
                    Ok(serde_json::json!({ "success": true }))
                }
                _ => Err(format!("未知fallback命令: {}", system_cmd)),
            }
        }
        _ => Err("非fallback层".into()),
    }
}

/// 发送task给好友（含能力匹配检查）
#[tauri::command]
pub async fn task_send(
    smcp_state: State<'_, crate::smcp::SmcpState>,
    friend_id: String,
    capability: String,
    params: Value,
) -> Result<Value, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let (from, uid) = {
        let cfg = smcp_state.config.read().await;
        (
            cfg.as_ref().map(|c| c.agent_id.clone()).unwrap_or_else(|| "unknown".into()),
            cfg.as_ref().map(|c| c.user_id.clone()).unwrap_or_default(),
        )
    };

    // 能力匹配检查：先查询目标好友是否有此能力
    let cap_check = crate::smcp::smcp_post_internal(
        smcp_state.inner(),
        "/agent/capabilities",
        &uid,
        serde_json::json!({ "agent_id": friend_id }),
    ).await;

    match cap_check {
        Ok(cap_data) => {
            // 检查返回的能力列表是否包含所需capability（兼容 {name:...} 对象和纯字符串两种格式）
            let empty: Vec<Value> = vec![];
            let caps = cap_data.get("capabilities")
                .and_then(|c| c.as_array())
                .unwrap_or(&empty);
            let cap_names: Vec<String> = caps.iter()
                .filter_map(|c| c.as_str().map(String::from).or_else(|| c.get("name").and_then(|n| n.as_str()).map(String::from)))
                .collect();
            if !cap_names.is_empty() && !cap_names.contains(&capability) {
                return Ok(serde_json::json!({
                    "ok": false,
                    "error": format!("对方不支持 {} 能力", capability),
                    "available_capabilities": cap_names,
                }));
            }
        }
        Err(e) => {
            // 能力查询失败，仍然发送（best-effort）
            eprintln!("[task_engine] capability check failed for {}: {}, sending anyway", friend_id, e);
        }
    }

    // receiver收到task后的二次校验由handle_remote_task完成

    crate::smcp::smcp_message_send(
        smcp_state,
        from.clone(),
        friend_id.clone(),
        String::new(),
        "task".to_string(),
        "task.execute".to_string(),
        serde_json::json!({
            "task_id": task_id,
            "capability": capability,
            "params": params,
            "from": from,
        }),
    ).await
}

/// 轮询task结果
#[tauri::command]
pub fn task_result_poll(
    engine: State<'_, TaskEngine>,
    task_id: String,
) -> Result<Option<TaskResult>, String> {
    let pending = engine.pending_results.lock().unwrap();
    Ok(pending.get(&task_id).cloned())
}

/// 列出本机可用能力
#[tauri::command]
pub fn task_list_capabilities(
    engine: State<'_, TaskEngine>,
) -> Result<Vec<CapabilityInfo>, String> {
    Ok(engine.list_capabilities())
}

/// 取消task
#[tauri::command]
pub fn task_cancel(
    engine: State<'_, TaskEngine>,
    task_id: String,
) -> Result<Value, String> {
    let mut pending = engine.pending_results.lock().unwrap();
    pending.remove(&task_id);
    Ok(serde_json::json!({ "success": true }))
}

/// 远程task接收处理：权限检查 → 自动执行/审批/拒绝
/// 由smcp message_poll调用的内部方法
pub async fn handle_remote_task(
    app: &tauri::AppHandle,
    engine: &TaskEngine,
    nuphus: &crate::nuphus_bridge::NuphusBridge,
    permission_store: &crate::permission::PermissionStore,
    task_id: &str,
    from_agent: &str,
    capability: &str,
    params: &Value,
) -> Option<TaskResult> {
    // 检查权限
    let policy = permission_store.check_policy(from_agent, capability);

    match policy.as_str() {
        "allow" => {
            // 自动执行
            let start = std::time::Instant::now();
            match execute_task_inner(engine, nuphus, capability, params, task_id, start).await {
                Ok(mut result) => {
                    // 截图可视化
                    if capability == "screenshot" && result.status == "success" {
                        if let Some(path) = result.data.get("path").and_then(|v| v.as_str()) {
                            if let Ok(bytes) = std::fs::read(path) {
                                use base64::Engine;
                                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                result.screenshots = vec![b64];
                            }
                        }
                    }
                    Some(result)
                }
                Err(e) => Some(TaskResult {
                    task_id: task_id.to_string(),
                    status: "error".into(),
                    data: serde_json::json!({}),
                    screenshots: vec![],
                    steps: vec![],
                    error_message: Some(e),
                    execution_tier: "none".into(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    created_at: chrono::Utc::now().timestamp_millis(),
                }),
            }
        }
        "deny" => {
            // 直接拒绝
            Some(TaskResult {
                task_id: task_id.to_string(),
                status: "rejected".into(),
                data: serde_json::json!({}),
                screenshots: vec![],
                steps: vec![],
                error_message: Some("权限策略禁止执行".into()),
                execution_tier: "none".into(),
                duration_ms: 0,
                created_at: chrono::Utc::now().timestamp_millis(),
            })
        }
        _ => {
            // "ask" → 弹审批弹窗，存入挂起队列
            {
                let mut pending = engine.pending_remote_tasks.lock().unwrap();
                pending.insert(task_id.to_string(), PendingRemoteTask {
                    task_id: task_id.to_string(),
                    from_agent: from_agent.to_string(),
                    capability: capability.to_string(),
                    params: params.clone(),
                    created_at: chrono::Utc::now().timestamp_millis(),
                });
            }
            crate::smcp::emit_task_approval_request(app, from_agent, capability, task_id, params);
            None // 不立即返回结果，等待用户审批
        }
    }
}

/// 挂起的远程task（等待审批）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRemoteTask {
    pub task_id: String,
    pub from_agent: String,
    pub capability: String,
    pub params: Value,
    pub created_at: i64,
}

/// 检查远程task审批超时（30分钟）
/// 超时的task自动回传timeout结果
#[tauri::command]
pub async fn task_check_timeouts(
    engine: State<'_, TaskEngine>,
    smcp_state: State<'_, crate::smcp::SmcpState>,
) -> Result<Vec<String>, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let timeout_ms: i64 = 30 * 60 * 1000; // 30分钟
    let mut expired_tasks: Vec<String> = vec![];

    let to_timeout: Vec<PendingRemoteTask> = {
        let pending = engine.pending_remote_tasks.lock().unwrap();
        pending.values()
            .filter(|t| now - t.created_at > timeout_ms)
            .cloned()
            .collect()
    };

    for task in &to_timeout {
        // 直接调用SMCP HTTP API回传超时结果
        let cfg = smcp_state.config.read().await;
        let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
        let from = cfg.as_ref().map(|c| c.agent_id.as_str()).unwrap_or("unknown");

        let body = serde_json::json!({
            "from_agent": from,
            "to_agent": task.from_agent,
            "to_user": "",
            "type": "result",
            "method": "task.result",
            "params": {
                "task_id": task.task_id,
                "status": "timeout",
                "data": {},
                "screenshots": [],
                "execution_tier": "none",
                "duration_ms": 0,
                "error_message": "审批超时(30分钟)",
                "from": from,
            },
        });

        let url = "https://locatenotify.online/v1/smcp/message/send";
        let _ = smcp_state.http
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-Account-Id", uid)
            .json(&body)
            .send()
            .await;

        expired_tasks.push(task.task_id.clone());
    }

    // 移除超时任务
    if !expired_tasks.is_empty() {
        let mut pending = engine.pending_remote_tasks.lock().unwrap();
        for id in &expired_tasks {
            pending.remove(id);
        }
    }

    Ok(expired_tasks)
}

/// 获取挂起的远程task（审批弹窗用）
#[tauri::command]
pub fn task_get_pending_remote(
    engine: State<'_, TaskEngine>,
) -> Result<Vec<PendingRemoteTask>, String> {
    let pending = engine.pending_remote_tasks.lock().unwrap();
    Ok(pending.values().cloned().collect())
}

/// 移除已审批的挂起远程task
#[tauri::command]
pub fn task_remove_pending_remote(
    engine: State<'_, TaskEngine>,
    task_id: String,
) -> Result<Value, String> {
    let mut pending = engine.pending_remote_tasks.lock().unwrap();
    pending.remove(&task_id);
    Ok(serde_json::json!({ "success": true }))
}

/// 多步执行（Computer Use用）
/// steps: [{ "capability": "app.open", "params": { "app_name": "WeChat" } }, ...]
/// 每步执行后emit `task-step` 事件给前端，包含截图
#[tauri::command]
pub async fn task_multi_step_execute(
    engine: State<'_, TaskEngine>,
    nuphus: State<'_, crate::nuphus_bridge::NuphusBridge>,
    permission_store: State<'_, crate::permission::PermissionStore>,
    app: tauri::AppHandle,
    task_id: String,
    steps: Vec<Value>,
) -> Result<TaskResult, String> {
    let start = std::time::Instant::now();
    let mut executed_steps: Vec<TaskStep> = vec![];
    let mut all_success = true;

    // 串行执行队列检查
    {
        let processing = engine.is_processing.lock().unwrap();
        if *processing {
            return Ok(TaskResult {
                task_id,
                status: "error".into(),
                data: serde_json::json!({}),
                screenshots: vec![],
                steps: vec![],
                error_message: Some("任务队列繁忙".into()),
                execution_tier: "none".into(),
                duration_ms: start.elapsed().as_millis() as u64,
                created_at: chrono::Utc::now().timestamp_millis(),
            });
        }
    }

    {
        let mut processing = engine.is_processing.lock().unwrap();
        *processing = true;
    }

    for (i, step_value) in steps.iter().enumerate() {
        let step_num = (i + 1) as u32;
        let capability = step_value.get("capability")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let step_params = step_value.get("params").cloned().unwrap_or(serde_json::json!({}));
        let step_description = step_value.get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(capability);

        let step_start = std::time::Instant::now();
        let step_result = execute_task_inner(&engine, &nuphus, capability, &step_params, &task_id, step_start).await;

        let (status, result_data, screenshot, step_duration) = match step_result {
            Ok(mut r) => {
                // 截图可视化
                let ss = if capability == "screenshot" && r.status == "success" {
                    if let Some(path) = r.data.get("path").and_then(|v| v.as_str()) {
                        if let Ok(bytes) = std::fs::read(path) {
                            use base64::Engine;
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                            r.screenshots = vec![b64.clone()];
                            Some(b64)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    r.screenshots.first().cloned()
                };
                (r.status.clone(), r.data.clone(), ss, r.duration_ms)
            }
            Err(e) => {
                all_success = false;
                ("error".into(), serde_json::json!({ "error": e }), None, step_start.elapsed().as_millis() as u64)
            }
        };

        let task_step = TaskStep {
            step_num,
            action: step_description.to_string(),
            capability: capability.to_string(),
            status: status.clone(),
            screenshot: screenshot.clone(),
            result: result_data.clone(),
            duration_ms: step_duration,
        };

        // Emit task-step事件给前端实时展示
        let _ = app.emit("task-step", serde_json::json!({
            "task_id": task_id,
            "step": task_step,
        }));

        executed_steps.push(task_step);

        // 步骤失败则终止
        if status != "success" {
            all_success = false;
            break;
        }

        // 步骤间等待一小段（模拟人类操作间隔）
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // 清除处理标记
    {
        let mut processing = engine.is_processing.lock().unwrap();
        *processing = false;
    }

    // 收集所有截图
    let all_screenshots: Vec<String> = executed_steps.iter()
        .filter_map(|s| s.screenshot.clone())
        .collect();

    let result = TaskResult {
        task_id: task_id.clone(),
        status: if all_success { "success" } else { "error" }.into(),
        data: serde_json::json!({ "total_steps": steps.len(), "completed_steps": executed_steps.len() }),
        screenshots: all_screenshots,
        steps: executed_steps,
        error_message: if all_success { None } else { Some("多步执行部分失败".into()) },
        execution_tier: "multi_step".into(),
        duration_ms: start.elapsed().as_millis() as u64,
        created_at: chrono::Utc::now().timestamp_millis(),
    };

    // 存储结果
    {
        let mut pending = engine.pending_results.lock().unwrap();
        pending.insert(task_id.clone(), result.clone());
    }

    Ok(result)
}
