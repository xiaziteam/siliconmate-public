use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub enum FeishuOutputStatus {
    Unavailable,
    Ready,
    Error(String),
}

/// Check if lark-cli is available (locally installed, not npx remote)
fn lark_cli_path() -> Option<String> {
    // 1. Check SILICONMATE_LARK_CLI env override
    if let Ok(path) = std::env::var("SILICONMATE_LARK_CLI") {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    // 2. Check global install locations
    let candidates = [
        "/usr/local/bin/lark-cli",
        "/usr/local/bin/lark",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // 3. Check via which
    if let Ok(output) = std::process::Command::new("which")
        .arg("lark-cli")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn feishu_send_message(
    text: String,
    chat_id: Option<String>,
) -> Result<String, String> {
    let lark = lark_cli_path().ok_or("飞书功能不可用：lark-cli未安装。请运行 npm i -g lark-cli 并完成登录配置")?;
    let chat = chat_id.unwrap_or_else(|| "default".into());
    let escaped_text = text.replace('\'', "'\\''");

    let output = tokio::process::Command::new(&lark)
        .args([
            "im", "send",
            "--chat", &chat,
            &escaped_text,
        ])
        .output()
        .await
        .map_err(|e| format!("lark-cli执行失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("飞书发送失败: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

#[tauri::command]
pub async fn feishu_create_doc(
    title: String,
    content: String,
) -> Result<String, String> {
    let lark = lark_cli_path().ok_or("飞书功能不可用：lark-cli未安装。请运行 npm i -g lark-cli 并完成登录配置")?;
    let escaped_title = title.replace('\'', "'\\''");
    let escaped_content = content.replace('\'', "'\\''");

    let output = tokio::process::Command::new(&lark)
        .args([
            "doc", "create",
            "--title", &escaped_title,
            "--content", &escaped_content,
        ])
        .output()
        .await
        .map_err(|e| format!("lark-cli执行失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("飞书文档创建失败: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

#[tauri::command]
pub async fn feishu_check() -> Result<FeishuOutputStatus, String> {
    match lark_cli_path() {
        Some(_) => Ok(FeishuOutputStatus::Ready),
        None => Ok(FeishuOutputStatus::Error("lark-cli未安装".into())),
    }
}
