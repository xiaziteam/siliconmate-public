//! 硅侣3.0 — macOS原生直通命令
//!
//! 原生直通层：screenshot/open_app/shell_exec/read_file
//! 零模型依赖，毫秒级响应，⚡图标
//! macOS实现：screencapture/osascript/Process::Command/std::fs

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

// ── 数据结构 ──

/// 原生命令状态
pub struct NativeCmdState {
    /// 截图计数（用于文件命名）
    screenshot_counter: Mutex<u64>,
}

impl NativeCmdState {
    pub fn new() -> Self {
        Self {
            screenshot_counter: Mutex::new(0),
        }
    }
}

impl Default for NativeCmdState {
    fn default() -> Self {
        Self::new()
    }
}

/// 截图结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    pub success: bool,
    pub path: String,
    pub size_bytes: u64,
}

/// 打开APP结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAppResult {
    pub success: bool,
    pub app_name: String,
}

/// Shell执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// 文件读取结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileResult {
    pub content: String,
    pub size: u64,
}

// ── 内部实现（供task_engine直接调用）──

/// macOS截图：screencapture -x /tmp/siliconmate-screenshot-{ts}.png
pub fn do_native_screenshot(path: &str) -> Result<ScreenshotResult, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let output_path = if path.is_empty() {
        format!("/tmp/siliconmate-screenshot-{}.png", ts)
    } else {
        path.to_string()
    };

    let output = std::process::Command::new("screencapture")
        .args(["-x", &output_path])
        .output()
        .map_err(|e| format!("screencapture执行失败: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "screencapture失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(ScreenshotResult {
        success: true,
        path: output_path,
        size_bytes: size,
    })
}

/// macOS打开APP：osascript -e 'tell application "X" to activate'
pub fn do_native_open_app(app_name: &str) -> Result<OpenAppResult, String> {
    let script = format!("tell application \"{}\" to activate", app_name);

    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("osascript执行失败: {}", e))?;

    if !output.status.success() {
        // 尝试open -a作为降级
        let fallback = std::process::Command::new("open")
            .args(["-a", app_name])
            .output()
            .map_err(|e| format!("open -a也失败: {}", e))?;

        if !fallback.status.success() {
            return Err(format!(
                "打开APP失败(osascript+open): {} / {}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&fallback.stderr)
            ));
        }
    }

    Ok(OpenAppResult {
        success: true,
        app_name: app_name.to_string(),
    })
}

/// Shell命令执行（带超时控制+安全加固）
pub fn do_native_shell_exec(command: &str, timeout_secs: u32) -> Result<ShellExecResult, String> {
    use std::io::Write;

    // 高危操作黑名单检查（扩展版）
    let dangerous_patterns = [
        "rm -rf /",
        "rm -rf /*",
        "rm -rf ~",
        "format",
        "mkfs",
        "dd if=",
        "sms",
        "SMS",
        "发送短信",
        ":(){ :|:& };:",  // fork bomb
        "> /dev/sda",
        "chmod 777 /",
        "chown root",
        "launchctl unload",
        "killall Finder",
        "killall Dock",
        "defaults delete",
        "nvram",
        "csrutil",
    ];

    let cmd_lower = command.to_lowercase();
    for pattern in &dangerous_patterns {
        if cmd_lower.contains(&pattern.to_lowercase()) {
            return Err(format!("高危操作被黑名单拦截: 包含 '{}'", pattern));
        }
    }

    // 写入临时文件避免shell注入
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let script_path = format!("/tmp/siliconmate-shell-{}.sh", id);

    let mut f = std::fs::File::create(&script_path)
        .map_err(|e| format!("创建脚本文件失败: {}", e))?;
    write!(f, "#!/bin/bash\n{}", command)
        .map_err(|e| format!("写入脚本失败: {}", e))?;

    let mut child = std::process::Command::new("/bin/bash")
        .arg(&script_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_file(&script_path);
            format!("执行命令失败: {}", e)
        })?;

    // 带超时的等待
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs as u64);
    let exit_status;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = status;
                break;
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&script_path);
                    return Err(format!("命令执行超时({}秒)", timeout_secs));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&script_path);
                return Err(format!("检查进程状态失败: {}", e));
            }
        }
    }

    // 从piped stdout/stderr读取
    let output = child.wait_with_output()
        .map_err(|e| format!("获取命令输出失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // 清理临时文件
    let _ = std::fs::remove_file(&script_path);

    Ok(ShellExecResult {
        stdout,
        stderr,
        exit_code: exit_status.code().unwrap_or(-1),
    })
}

/// 读取文件内容
pub fn do_native_read_file(path: &str) -> Result<ReadFileResult, String> {
    // 路径安全检查（扩展禁止列表）
    let forbidden_paths = [
        "/etc/shadow",
        "/etc/passwd",
        "/etc/sudoers",
        "/private/etc/shadow",
        "/private/etc/passwd",
        "/.ssh/",
        "/.gnupg/",
        "/.kube/",
        "/.aws/",
        "/.config/gcloud/",
        "/.docker/",
        "/.npmrc",
        "/.pypirc",
        "/.netrc",
    ];
    let path_lower = path.to_lowercase();
    for forbidden in &forbidden_paths {
        if path_lower.starts_with(&forbidden.to_lowercase()) || path_lower.contains(&forbidden.to_lowercase()) {
            return Err(format!("禁止读取敏感文件/目录: {}", forbidden));
        }
    }

    // 扩展名黑名单（二进制/密钥文件）
    let forbidden_extensions = [".key", ".pem", ".p12", ".pfx", ".ssh", ".priv", ".secret"];
    for ext in &forbidden_extensions {
        if path_lower.ends_with(ext) {
            return Err(format!("禁止读取密钥/凭证文件: {}", ext));
        }
    }

    if !std::path::Path::new(path).exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("读取文件信息失败: {}", e))?;

    // 限制文件大小（1MB for safety, text content）
    const MAX_SIZE: u64 = 1 * 1024 * 1024;
    if metadata.len() > MAX_SIZE {
        return Err(format!(
            "文件过大({}MB)，最大支持1MB",
            metadata.len() / (1024 * 1024)
        ));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    Ok(ReadFileResult {
        content,
        size: metadata.len(),
    })
}

// ── Tauri Commands ──

/// macOS截图
#[tauri::command]
pub fn native_screenshot(
    _state: State<'_, NativeCmdState>,
    path: Option<String>,
) -> Result<Value, String> {
    let result = do_native_screenshot(path.as_deref().unwrap_or(""))?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// macOS打开APP
#[tauri::command]
pub fn native_open_app(
    _state: State<'_, NativeCmdState>,
    app_name: String,
) -> Result<Value, String> {
    let result = do_native_open_app(&app_name)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// Shell命令执行
#[tauri::command]
pub fn native_shell_exec(
    _state: State<'_, NativeCmdState>,
    command: String,
    timeout: Option<u32>,
) -> Result<Value, String> {
    let result = do_native_shell_exec(&command, timeout.unwrap_or(30))?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// 读取文件内容
#[tauri::command]
pub fn native_read_file(
    _state: State<'_, NativeCmdState>,
    path: String,
) -> Result<Value, String> {
    let result = do_native_read_file(&path)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}
