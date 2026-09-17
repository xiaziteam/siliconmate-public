use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/// Debug log to file (eprintln silent in macOS release .app)
fn debug_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/siliconmate-debug.log")
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
    eprintln!("[server] {}", msg);
}

#[derive(Debug, Clone, Serialize)]
pub enum ServerStatus {
    Disconnected,
    Connecting,
    Connected { server_host: String },
    Error(String),
}

pub struct ServerConnector {
    pub status: Mutex<ServerStatus>,
    pub server_host: String,
    pub ssh_key_path: String,
}

impl ServerConnector {
    pub fn new(server_host: String, ssh_key_path: String) -> Self {
        Self {
            status: Mutex::new(ServerStatus::Disconnected),
            server_host,
            ssh_key_path,
        }
    }
}

/// P1 FIX: 用reqwest直连替代SSH+curl探活
/// 1. 先尝试HTTPS到locatenotify.online/v1/smcp/ping (外部可达)
/// 2. 再尝试HTTP直连VPS2:15731/health (局域网/同机可用)
/// 3. 全部3秒超时，fail-open不阻塞UI
#[tauri::command]
pub async fn connect_server(
    connector: tauri::State<'_, ServerConnector>,
) -> Result<String, String> {
    {
        let status = connector.status.lock().unwrap();
        if let ServerStatus::Connected { server_host } = &*status {
            return Ok(server_host.clone());
        }
    }

    {
        let mut status = connector.status.lock().unwrap();
        *status = ServerStatus::Connecting;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("HTTP client创建失败: {}", e))?;

    // Strategy 1: HTTPS via locatenotify.online (externally reachable)
    debug_log("P1: trying HTTPS via locatenotify.online/v1/smcp/ping");
    match client.get("https://locatenotify.online/v1/smcp/ping").send().await {
        Ok(resp) => {
            let status_code = resp.status();
            let body = resp.text().await.unwrap_or_else(|e| format!("<read body failed: {}>", e));
            debug_log(&format!("HTTPS ping returned {} body={}", status_code, &body[..body.len().min(200)]));
            if status_code.is_success() {
                let mut status = connector.status.lock().unwrap();
                *status = ServerStatus::Connected {
                    server_host: connector.server_host.clone(),
                };
                    debug_log("connected via HTTPS (SMCP ping OK)");
                return Ok(connector.server_host.clone());
            }
        }
        Err(e) => {
            debug_log(&format!("HTTPS ping failed: {}", e));
        }
    }

    // Strategy 2: HTTP direct to VPS2:15731 (works if 15731 bound to 0.0.0.0 or same host)
    let health_url = format!("http://{}:15731/health", connector.server_host);
    debug_log(&format!("P1: trying HTTP direct to {}", health_url));
    match client.get(&health_url).send().await {
        Ok(resp) => {
            let status_code = resp.status();
            let body = resp.text().await.unwrap_or_else(|e| format!("<read body failed: {}>", e));
            debug_log(&format!("HTTP direct returned {} body={}", status_code, &body[..body.len().min(200)]));
            if status_code.is_success() {
                let mut status = connector.status.lock().unwrap();
                *status = ServerStatus::Connected {
                    server_host: connector.server_host.clone(),
                };
                    debug_log("connected via HTTP direct (health OK)");
                return Ok(connector.server_host.clone());
            }
        }
        Err(e) => {
            debug_log(&format!("HTTP direct failed: {}", e));
        }
    }

    // All strategies failed — fail-open (UI renders normally, deep-think disabled)
    let mut status = connector.status.lock().unwrap();
    *status = ServerStatus::Error("服务端不可达(深度思考不可用)".into());
    Err("服务端不可达，深度思考需AgentChat支持".into())
}

#[tauri::command]
pub fn disconnect_server(
    connector: tauri::State<'_, ServerConnector>,
) -> Result<(), String> {
    let mut status = connector.status.lock().unwrap();
    *status = ServerStatus::Disconnected;
    Ok(())
}

#[tauri::command]
pub async fn call_server_agent(
    connector: tauri::State<'_, ServerConnector>,
    prompt: String,
) -> Result<String, String> {
    {
        let status = connector.status.lock().unwrap();
        if !matches!(&*status, ServerStatus::Connected { .. }) {
            return Err("服务端未连接".into());
        }
    }

    let escaped_prompt = prompt.replace('\'', "'\\''").replace('\\', "\\\\");
    let ssh_cmd = format!(
        "ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:15731 timeout 120 npx -y @anthropic-ai/claude-code -p --output-format stream-json --verbose --bare --model glm-4-flash '{}'",
        escaped_prompt
    );

    let output = ssh_exec(&connector.ssh_key_path, &connector.server_host, &ssh_cmd).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_server_output(&stdout))
}

#[tauri::command]
pub async fn call_server_deep_think(
    app: tauri::AppHandle,
    connector: tauri::State<'_, ServerConnector>,
    prompt: String,
    skill: Option<String>,
) -> Result<String, String> {
    {
        let status = connector.status.lock().unwrap();
        if !matches!(&*status, ServerStatus::Connected { .. }) {
            return Err("服务端未连接，深度思考需要AgentChat团队支持".into());
        }
    }

    let skill_name = skill.unwrap_or_else(|| "oneweb".into());
    let skill_path = match skill_name.as_str() {
        "websubagent" => "/root/AgentChat/skills/AgentChat-WebSubAgent/index.js",
        "independenttasks" => "/root/AgentChat/skills/AgentChat-IndependentTasks/index.js",
        _ => "/root/AgentChat/skills/AgentChat-OneWeb/index.js",
    };

    // Write prompt to temp file on remote to avoid shell injection
    let prompt_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let remote_prompt_file = format!("/tmp/siliconmate-prompt-{}", prompt_id);

    // Upload prompt via SSH stdin → cat > file
    let echo_cmd = format!("cat > {}", remote_prompt_file);
    let mut echo_child = tokio::process::Command::new("ssh")
        .args([
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=no",
            "-i", &connector.ssh_key_path,
            &format!("root@{}", connector.server_host),
            &echo_cmd,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("SSH上传prompt失败: {}", e))?;

    use tokio::io::AsyncWriteExt;
    if let Some(mut stdin) = echo_child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await
            .map_err(|e| format!("写入prompt失败: {}", e))?;
        drop(stdin);
    }
    let echo_output = tokio::time::timeout(
        Duration::from_secs(15),
        echo_child.wait_with_output()
    )
        .await
        .map_err(|_| "SSH上传prompt超时(15s)".to_string())?
        .map_err(|e| format!("SSH上传prompt失败: {}", e))?;

    if !echo_output.status.success() {
        return Err("上传prompt到服务器失败".into());
    }

    let ssh_cmd = format!(
        "cd /root/AgentChat && timeout 600 node {} \"$(cat {})\" 2>&1; rm -f {}",
        skill_path, remote_prompt_file, remote_prompt_file
    );

    eprintln!("[server] deep_think: skill={}, prompt_len={}", skill_name, prompt.len());

    // Emit progress events
    let _ = app.emit("deep-think-progress", serde_json::json!({
        "phase": "started",
        "skill": skill_name,
        "message": "深度思考启动中…"
    }));

    // Use streaming SSH: spawn with piped stdout, read line by line
    let mut child = tokio::process::Command::new("ssh")
        .args([
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=no",
            "-i", &connector.ssh_key_path,
            &format!("root@{}", connector.server_host),
            &ssh_cmd,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("SSH执行AgentChat失败: {}", e))?;

    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdout = child.stdout.take().ok_or("无法读取SSH stdout")?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut all_output = String::new();
    let mut line_count = 0u32;
    let mut last_emit_time = std::time::Instant::now();
    let start = std::time::Instant::now();
    let max_duration = std::time::Duration::from_secs(600); // 10 min hard limit

    while let Ok(Some(line)) = lines.next_line().await {
        all_output.push_str(&line);
        all_output.push('\n');
        line_count += 1;

        // Emit progress every 2 seconds or every 10 lines
        let should_emit = line_count % 10 == 0 || last_emit_time.elapsed() > std::time::Duration::from_secs(2);

        if should_emit {
            // Extract a meaningful snippet from recent output
            let snippet = line.trim();
            if snippet.len() > 5 && !snippet.starts_with('[') && !snippet.contains("debug") {
                let preview = if snippet.len() > 200 {
                    format!("{}…", &snippet[..200])
                } else {
                    snippet.to_string()
                };
                let _ = app.emit("deep-think-progress", serde_json::json!({
                    "phase": "thinking",
                    "skill": skill_name,
                    "message": preview,
                    "elapsed_secs": start.elapsed().as_secs(),
                    "lines": line_count,
                }));
                last_emit_time = std::time::Instant::now();
            }
        }

        // Hard timeout check
        if start.elapsed() > max_duration {
            let _ = child.kill().await;
            break;
        }
    }

    // Wait for process to finish
    let exit_status = child.wait().await;

    let elapsed = start.elapsed().as_secs();
    eprintln!("[server] deep_think finished: {} lines, {}s, exit={:?}", line_count, elapsed, exit_status);

    if all_output.trim().is_empty() {
        let _ = app.emit("deep-think-progress", serde_json::json!({
            "phase": "error",
            "message": "AgentChat返回空结果"
        }));
        return Err("AgentChat返回空结果".into());
    }

    let result = extract_agentchat_result(&all_output);

    let _ = app.emit("deep-think-progress", serde_json::json!({
        "phase": "done",
        "message": "深度思考完成",
        "elapsed_secs": elapsed,
        "result_len": result.len(),
    }));

    eprintln!("[server] deep_think response: {} bytes", result.len());
    Ok(result)
}

#[tauri::command]
pub async fn call_server_office(
    connector: tauri::State<'_, ServerConnector>,
    file_path: String,
    operation: String,
) -> Result<String, String> {
    {
        let status = connector.status.lock().unwrap();
        if !matches!(&*status, ServerStatus::Connected { .. }) {
            return Err("服务端未连接，Office文件处理需要VPS2支持".into());
        }
    }

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效文件路径")?;

    let remote_path = format!("/tmp/siliconmate-office-{}", file_name);

    let scp_output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("scp")
            .args([
                "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=10",
                "-i", &connector.ssh_key_path,
                &file_path,
                &format!("root@{}:{}", connector.server_host, remote_path),
            ])
            .output()
    )
        .await
        .map_err(|_| "SCP上传超时(30s)".to_string())?
        .map_err(|e| format!("SCP上传失败: {}", e))?;

    if !scp_output.status.success() {
        let stderr = String::from_utf8_lossy(&scp_output.stderr);
        return Err(format!("文件上传失败: {}", stderr));
    }

    let escaped_op = operation.replace('\'', "'\\''");
    let ssh_cmd = format!(
        "timeout 60 PYTHONPATH=/opt/cli_anything python3 -m cli_anything.libreoffice {} '{}' --json 2>&1",
        remote_path, escaped_op
    );

    let output = ssh_exec(&connector.ssh_key_path, &connector.server_host, &ssh_cmd).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let cleanup_cmd = format!("rm -f {}", remote_path);
    let _ = ssh_exec(&connector.ssh_key_path, &connector.server_host, &cleanup_cmd).await;

    Ok(stdout.to_string())
}

/// P2 FIX: SSH执行加timeout兜底，防止channel open慢时卡75-120s
async fn ssh_exec(
    ssh_key_path: &str,
    server_host: &str,
    command: &str,
) -> Result<std::process::Output, String> {
    let cmd = tokio::process::Command::new("ssh")
        .args([
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=no",
            "-i", ssh_key_path,
            &format!("root@{}", server_host),
            command,
        ])
        .output();

    tokio::time::timeout(Duration::from_secs(30), cmd)
        .await
        .map_err(|_| "SSH执行超时(30s)".to_string())?
        .map_err(|e| format!("SSH执行失败: {}", e))
}

fn parse_server_output(output: &str) -> String {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if json.get("type").and_then(|t| t.as_str()) == Some("result") {
                if let Some(text) = json.get("result").and_then(|r| r.as_str()) {
                    return text.to_string();
                }
            }
            if json.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                if let Some(text) = json.pointer("/message/content/0/text").and_then(|t| t.as_str()) {
                    return text.to_string();
                }
            }
        }
    }
    output.to_string()
}

fn extract_agentchat_result(output: &str) -> String {
    let mut result_lines: Vec<String> = Vec::new();
    let mut in_result = false;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        if trimmed.contains("=== 最终回答 ===") || trimmed.contains("=== Final Answer ===") {
            in_result = true;
            continue;
        }
        if trimmed.contains("=== ") && in_result {
            in_result = false;
            continue;
        }
        if in_result {
            result_lines.push(line.to_string());
            continue;
        }

        if trimmed.starts_with("```") || trimmed.starts_with("---") {
            continue;
        }

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
                if !text.is_empty() && text.len() > 50 {
                    result_lines.push(text.to_string());
                }
            }
            continue;
        }

        if trimmed.len() > 20 && !trimmed.starts_with('[') && !trimmed.contains("CDP") && !trimmed.contains("browser") {
            if result_lines.is_empty() || result_lines.last().map(|l| l.len()).unwrap_or(0) < 50 {
                result_lines.push(trimmed.to_string());
            }
        }
    }

    if result_lines.is_empty() {
        let non_debug: Vec<&str> = output.lines()
            .filter(|l| {
                let t = l.trim();
                t.len() > 20 && !t.contains("CDP") && !t.contains("debug") && !t.starts_with('[')
            })
            .collect();
        return non_debug.join("\n");
    }

    result_lines.join("\n")
}
