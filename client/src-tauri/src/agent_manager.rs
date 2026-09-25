//! 硅侣3.0 — 客户端Agent进程管理
//!
//! 管理free-code SDK的per-request调用：
//! - send_message: 每次spawn `claude -p --output-format stream-json` 处理一条消息
//! - 读取stdout流式JSON，通过output_filter管道过滤后返回
//! - 通过zhipu-bridge(:15731)连接GLM模型
//!
//! free-code提供完整Agent能力：工具调用、MCP、多轮上下文、文件操作
//!
//! 输出管道: free-code stdout → output_filter::parse_and_filter → DisplayMessage → 前端

use std::sync::Mutex;

/// Agent状态
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum AgentStatus {
    Idle,
    Processing,
    Error(String),
}

/// Agent管理器（无状态per-request模式）
pub struct AgentManager {
    status: Mutex<AgentStatus>,
    /// 是否有任务正在执行
    is_processing: Mutex<bool>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            status: Mutex::new(AgentStatus::Idle),
            is_processing: Mutex::new(false),
        }
    }
}

/// 向Agent发送消息并获取回复
///
/// Per-request模式：每次spawn新的free-code进程
/// free-code通过zhipu-bridge连接GLM，保留完整Agent能力
#[tauri::command]
pub async fn send_message(
    manager: tauri::State<'_, AgentManager>,
    message: String,
    ocr_context: Option<String>,
) -> Result<String, String> {
    // Check if already processing
    {
        let processing = manager.is_processing.lock().unwrap();
        if *processing {
            return Err("Agent正在处理中，请稍后".into());
        }
    }

    // Mark as processing
    {
        let mut processing = manager.is_processing.lock().unwrap();
        *processing = true;
    }
    {
        let mut status = manager.status.lock().unwrap();
        *status = AgentStatus::Processing;
    }

    let result = run_agent(&message, ocr_context.as_deref()).await;

    // Clear processing flag
    {
        let mut processing = manager.is_processing.lock().unwrap();
        *processing = false;
    }
    {
        let mut status = manager.status.lock().unwrap();
        *status = match &result {
            Ok(_) => AgentStatus::Idle,
            Err(e) => AgentStatus::Error(e.clone()),
        };
    }

    result
}

/// 运行free-code Agent处理单条消息
async fn run_agent(message: &str, ocr_context: Option<&str>) -> Result<String, String> {
    // If OCR context provided, prepend it to the message
    let full_message = if let Some(ctx) = ocr_context {
        format!("{}\n\n用户消息: {}", ctx, message)
    } else {
        message.to_string()
    };
    
    let msg = full_message;
    
    // Use spawn_blocking to run the synchronous command in a background thread
    // This avoids issues with tokio::process::Command in Tauri's async runtime
    tokio::task::spawn_blocking(move || run_agent_sync(&msg))
        .await
        .map_err(|e| format!("Agent任务失败: {}", e))?
}

/// Synchronous agent execution (runs in spawn_blocking thread)
fn find_node_bin() -> String {
    if let Ok(path) = std::env::var("SILICONMATE_NODE_BIN") {
        return path;
    }
    if let Ok(output) = std::process::Command::new("which").arg("node").output() {
        if output.status.success() {
            let node_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(bin_dir) = node_path.rsplit('/').nth(1) {
                let _full = format!("/{}", bin_dir);
                if node_path.ends_with(&format!("/bin/node")) {
                    if let Some(idx) = node_path.rfind("/bin") {
                        return node_path[..idx].to_string();
                    }
                }
            }
        }
    }
    "/usr/local/bin".to_string()
}

fn run_agent_sync(message: &str) -> Result<String, String> {
    let node_bin = find_node_bin();
    
    // Write message to temp file to avoid shell injection via single-quote escaping
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let msg_path = format!("/tmp/siliconmate-msg-{}.txt", id);
    std::fs::write(&msg_path, message)
        .map_err(|e| format!("写入消息临时文件失败: {}", e))?;
    
    let stdout_path = format!("/tmp/siliconmate-stdout-{}.txt", id);
    let stderr_path = format!("/tmp/siliconmate-stderr-{}.txt", id);
    let stdout_path_read = stdout_path.clone();
    let stderr_path_read = stderr_path.clone();

    // CLAUDE_CONFIG_DIR隔离: 不隔离会继承~/.claude/settings.json里的
    // env(ANTHROPIC_BASE_URL=127.0.0.1:15721托管代理)，请求被劫持返回502
    // (同free-code wrapper的做法, 2026-09-03 GUI实测踩坑修复)
    let claude_config_dir = "/tmp/siliconmate-claude-config";
    let _ = std::fs::create_dir_all(claude_config_dir);

    // Use $(cat tempfile) to pass message — avoids shell injection from message content
    let shell_cmd = format!(
        "export PATH=\"{}:$PATH\" ANTHROPIC_API_KEY=dummy ANTHROPIC_AUTH_TOKEN=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:15731 CLAUDE_CONFIG_DIR={}; npx -y @anthropic-ai/claude-code -p --output-format stream-json --verbose --bare --model glm-4-flash \"$(cat {})\" >{} 2>{}",
        node_bin, claude_config_dir, &msg_path, &stdout_path, &stderr_path
    );

    let mut child = std::process::Command::new("/bin/bash")
        .args(["-c", &shell_cmd])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动Agent失败: {}", e))?;

    // Wait with timeout (free-code -p may hang after printing result)
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(120);
    
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = std::fs::read_to_string(&stdout_path_read).unwrap_or_default();
                let stderr = std::fs::read_to_string(&stderr_path_read).unwrap_or_default();
                
                let parsed = parse_agent_output(&stdout);
                if !status.success() {
                    if let Ok(text) = &parsed {
                        if !text.is_empty() && !text.contains("Not logged in") {
                            break Ok(text.clone());
                        }
                    }
                    break Err(format!("Agent执行失败: {}", &stderr[..stderr.len().min(200)]));
                }
                break parsed;
            }
            Ok(None) => {
                // Still running - check if we already have an assistant response
                let stdout = std::fs::read_to_string(&stdout_path_read).unwrap_or_default();
                
                let has_result = stdout.lines().any(|l| {
                    crate::output_filter::parse_and_filter(l.trim())
                        .map(|d| d.is_final)
                        .unwrap_or(false)
                });
                let has_stream = stdout.lines().any(|l| {
                    crate::output_filter::parse_and_filter(l.trim()).is_some()
                });

                if has_result {
                    let _ = child.kill();
                    let _ = child.wait();
                    break parse_agent_output(&stdout);
                }

                if has_stream && start.elapsed() > std::time::Duration::from_secs(60) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break parse_agent_output(&stdout);
                }
                
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stdout = std::fs::read_to_string(&stdout_path_read).unwrap_or_default();
                    if !stdout.is_empty() {
                        let parsed = parse_agent_output(&stdout);
                        if let Ok(text) = &parsed {
                            if !text.is_empty() {
                                break Ok(text.clone());
                            }
                        }
                    }
                    break Err("Agent执行超时(120s)".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => {
                break Err(format!("检查进程状态失败: {}", e));
            }
        }
    };
    
    // Clean up temp files
    let _ = std::fs::remove_file(&msg_path);
    let _ = std::fs::remove_file(&stdout_path_read);
    let _ = std::fs::remove_file(&stderr_path_read);
    
    result
}

/// 通过output_filter管道解析free-code输出
///
/// 管道: 每行JSON → output_filter::parse_and_filter → DisplayMessage
/// 只保留streamlined_text(流式) + result(最终), 丢弃tool_use_summary和其他中间步骤
fn parse_agent_output(output: &str) -> Result<String, String> {
    let mut final_text = String::new();
    let mut stream_parts: Vec<String> = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(display) = crate::output_filter::parse_and_filter(line) {
            if display.is_final {
                final_text = display.text;
            } else {
                stream_parts.push(display.text);
            }
        }
    }

    if !final_text.is_empty() {
        Ok(final_text)
    } else if !stream_parts.is_empty() {
        Ok(stream_parts.join(""))
    } else if !output.trim().is_empty() {
        let non_json: Vec<&str> = output.lines()
            .filter(|l| serde_json::from_str::<serde_json::Value>(l.trim()).is_err())
            .collect();
        if !non_json.is_empty() {
            Ok(non_json.join("\n"))
        } else {
            Err("Agent返回空回复".into())
        }
    } else {
        Err("Agent无输出".into())
    }
}

/// 获取Agent状态
#[tauri::command]
pub fn get_agent_status(
    manager: tauri::State<'_, AgentManager>,
) -> Result<AgentStatus, String> {
    let status = manager.status.lock().unwrap();
    Ok(status.clone())
}

/// 检查Agent是否可用（zhipu-bridge健康检查）
#[tauri::command]
pub async fn check_agent_health() -> Result<bool, String> {
    // Check if zhipu-bridge is running on :15731
    let output = tokio::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:15731/health"])
        .output()
        .await
        .map_err(|e| format!("健康检查失败: {}", e))?;

    let code = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(code == "200")
}
