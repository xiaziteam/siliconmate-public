//! 硅侣3.0 — CDP浏览器Sidecar管理
//!
//! 管理Chromium CDP浏览器进程生命周期：
//! - 启动Chromium (--remote-debugging-port=9222 --remote-allow-origins=*)
//! - 等待CDP端点就绪 (wait_for_cdp)
//! - CDP cookie注入 (inject_cookies via WebSocket)
//! - 停止Chromium
//!
//! 用于语音聊天场景（ChatGPT透传）
//! 默认CDP端口9222

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// CDP浏览器状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ObscuraStatus {
    Stopped,
    Starting,
    Ready { port: u16 },
    Error(String),
}

/// CDP浏览器管理器
pub struct ObscuraManager {
    process: Mutex<Option<std::process::Child>>,
    status: Mutex<ObscuraStatus>,
}

impl ObscuraManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            status: Mutex::new(ObscuraStatus::Stopped),
        }
    }
}

impl Default for ObscuraManager {
    fn default() -> Self {
        Self::new()
    }
}

fn find_chromium_path() -> Option<String> {
    let candidates = if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/snap/bin/chromium",
        ]
    } else {
        vec![
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    };

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

#[tauri::command]
pub fn start_obscura(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ObscuraManager>,
    tunnel: tauri::State<'_, crate::tunnel::TunnelManager>,
) -> Result<String, String> {
    let mut process = manager.process.lock().unwrap();
    let mut status = manager.status.lock().unwrap();

    if process.is_some() {
        if let ObscuraStatus::Ready { port } = &*status {
            return Ok(format!("CDP browser already running on port {}", port));
        }
        return Ok("CDP浏览器正在启动中…".into());
    }

    *status = ObscuraStatus::Starting;

    let chrome_path = match find_chromium_path() {
        Some(p) => p,
        None => {
            *status = ObscuraStatus::Error("Chromium not found".into());
            return Err("未找到Chromium浏览器。请安装Google Chrome。".into());
        }
    };

    let port = 9222u16;
    let user_data_dir = std::env::temp_dir().join("siliconmate-chrome-profile");

    let mut args: Vec<String> = vec![
        format!("--remote-debugging-port={}", port),
        "--remote-allow-origins=*".into(),
        format!("--user-data-dir={}", user_data_dir.display()),
        "--no-first-run".into(),
        "--disable-default-apps".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--no-default-browser-check".into(),
        "about:blank".into(),
    ];

    if let Some(proxy) = tunnel.get_proxy_url_if_running() {
        eprintln!("[cdp] Using tunnel proxy: {}", proxy);
        args.push(format!("--proxy-server={}", proxy));
    } else {
        eprintln!("[cdp] No tunnel (direct connection)");
    }

    eprintln!("[cdp] launching: {} on port {}", chrome_path, port);

    let child = std::process::Command::new(&chrome_path)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            *status = ObscuraStatus::Error(format!("启动Chromium失败: {}", e));
            format!("启动Chromium失败 {}: {}", chrome_path, e)
        })?;

    *process = Some(child);
    eprintln!("[cdp] process started, waiting for CDP...");

    start_static_file_server();

    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let Ok(()) = wait_for_cdp_blocking(30) {
            eprintln!("[cdp] CDP ready");
            // Hide Chrome window via AppleScript
            let _ = std::process::Command::new("osascript")
                .args(["-e", "tell application \"Google Chrome\" to set miniaturized of every window to true"])
                .output();
            eprintln!("[cdp] Chrome windows minimized");
            let _ = app_clone.emit("obscura-ready", 9222u16);
        } else {
            eprintln!("[cdp] CDP timeout — Chromium failed to start");
            let _ = app_clone.emit("obscura-error", "CDP端点超时未就绪");
        }
    });

    Ok("CDP浏览器启动中…".into())
}

fn wait_for_cdp_blocking(max_retries: u32) -> Result<(), String> {
    for i in 0..max_retries {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if std::net::TcpStream::connect("127.0.0.1:9222").is_ok() {
            eprintln!("[cdp] CDP port open after {}ms", (i + 1) * 500);
            return Ok(());
        }
    }
    Err("CDP超时未就绪".into())
}

#[tauri::command]
pub fn inject_cookies(
    manager: tauri::State<'_, ObscuraManager>,
    cookies: Vec<CookieEntry>,
) -> Result<String, String> {
    let status = manager.status.lock().unwrap();

    if !matches!(&*status, ObscuraStatus::Ready { .. }) {
        return Err("CDP浏览器未就绪，无法注入cookies".into());
    }
    drop(status);

    inject_cookies_blocking(&cookies)?;

    Ok(format!("{} cookies injected, navigated to chatgpt.com", cookies.len()))
}

fn inject_cookies_blocking(cookies: &[CookieEntry]) -> Result<(), String> {
    let ws_url = match reqwest::blocking::Client::new()
        .get("http://127.0.0.1:9222/json")
        .timeout(std::time::Duration::from_secs(5))
        .send()
    {
        Ok(resp) => {
            let body: serde_json::Value = match resp.json() {
                Ok(b) => b,
                Err(e) => return Err(format!("解析/json响应失败: {}", e)),
            };
            let targets = match body.as_array() {
                Some(arr) => arr,
                None => return Err("/json未返回数组".into()),
            };
            let first_page = match targets.iter().find(|t| t["type"] == "page") {
                Some(t) => t,
                None => match targets.first() {
                    Some(t) => t,
                    None => return Err("/json中无目标".into()),
                },
            };
            match first_page["webSocketDebuggerUrl"].as_str() {
                Some(url) => url.to_string(),
                None => return Err("目标中无webSocketDebuggerUrl".into()),
            }
        }
        Err(e) => return Err(format!("连接/json失败: {}", e)),
    };

    eprintln!("[cdp] Got WS URL: {}", ws_url);

    use tungstenite::connect;
    use tungstenite::client::IntoClientRequest;

    let request = match ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return Err(format!("无效WS URL: {}", e)),
    };

    let (mut socket, _response) = match connect(request) {
        Ok(s) => s,
        Err(e) => return Err(format!("WebSocket连接失败: {}", e)),
    };

    eprintln!("[cdp] WebSocket connected, injecting {} cookies...", cookies.len());

    let mut msg_id: u64 = 1;

    let enable_cmd = serde_json::json!({
        "id": msg_id,
        "method": "Network.enable",
        "params": {}
    });
    msg_id += 1;
    if let Err(e) = socket.send(tungstenite::Message::Text(enable_cmd.to_string())) {
        return Err(format!("启用Network失败: {}", e));
    }
    let _ = socket.read();

    for cookie in cookies {
        let set_cookie_cmd = serde_json::json!({
            "id": msg_id,
            "method": "Network.setCookie",
            "params": {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path.as_deref().unwrap_or("/"),
                "secure": cookie.secure.unwrap_or(true),
                "httpOnly": cookie.http_only.unwrap_or(false),
            }
        });
        msg_id += 1;

        if let Err(e) = socket.send(tungstenite::Message::Text(set_cookie_cmd.to_string())) {
            return Err(format!("发送setCookie失败: {}", e));
        }

        if let Ok(resp) = socket.read() {
            eprintln!("[cdp] setCookie response: {}", resp);
        }
    }

    eprintln!("[cdp] Cookie injection complete (chatgpt.html will navigate)");
    let _ = socket.close(None);
    Ok(())
}

fn navigate_after_cookie_inject() -> Result<(), String> {
    let ws_url = match reqwest::blocking::Client::new()
        .get("http://127.0.0.1:9222/json")
        .timeout(std::time::Duration::from_secs(5))
        .send()
    {
        Ok(resp) => {
            let body: serde_json::Value = match resp.json() {
                Ok(b) => b,
                Err(e) => return Err(format!("解析/json响应失败: {}", e)),
            };
            let targets = match body.as_array() {
                Some(arr) => arr,
                None => return Err("/json未返回数组".into()),
            };
            let page = match targets.iter().find(|t| t["type"] == "page") {
                Some(t) => t,
                None => match targets.first() {
                    Some(t) => t,
                    None => return Err("/json中无目标".into()),
                },
            };
            match page["webSocketDebuggerUrl"].as_str() {
                Some(url) => url.to_string(),
                None => return Err("目标中无webSocketDebuggerUrl".into()),
            }
        }
        Err(e) => return Err(format!("连接/json失败: {}", e)),
    };

    use tungstenite::connect;
    use tungstenite::client::IntoClientRequest;

    let request = ws_url.as_str().into_client_request()
        .map_err(|e| format!("无效WS URL: {}", e))?;
    let (mut socket, _) = connect(request)
        .map_err(|e| format!("WebSocket连接失败: {}", e))?;

    let nav_cmd = serde_json::json!({
        "id": 1,
        "method": "Page.enable",
        "params": {}
    });
    let _ = socket.send(tungstenite::Message::Text(nav_cmd.to_string()));
    let _ = socket.read();

    let nav_cmd = serde_json::json!({
        "id": 2,
        "method": "Page.navigate",
        "params": { "url": "https://chatgpt.com/" }
    });
    let _ = socket.send(tungstenite::Message::Text(nav_cmd.to_string()));
    let _ = socket.read();

    eprintln!("[cdp] Navigated to chatgpt.com");
    let _ = socket.close(None);
    Ok(())
}

#[tauri::command]
pub fn stop_obscura(
    manager: tauri::State<'_, ObscuraManager>,
) -> Result<(), String> {
    let mut process = manager.process.lock().unwrap();
    let mut status = manager.status.lock().unwrap();

    if let Some(mut child) = process.take() {
        let _ = child.kill();
        let _ = child.wait();
        *status = ObscuraStatus::Stopped;
        eprintln!("[cdp] stopped");
    }
    Ok(())
}

#[tauri::command]
pub fn obscura_status(
    manager: tauri::State<'_, ObscuraManager>,
) -> Result<ObscuraStatus, String> {
    let status = manager.status.lock().unwrap();
    Ok(status.clone())
}

#[tauri::command]
pub fn obscura_set_ready(
    manager: tauri::State<'_, ObscuraManager>,
    port: u16,
) -> Result<(), String> {
    let mut status = manager.status.lock().unwrap();
    *status = ObscuraStatus::Ready { port };
    eprintln!("[cdp] status set to Ready(port={})", port);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: Option<String>,
    pub secure: Option<bool>,
    pub http_only: Option<bool>,
}

const CF_EXCLUDED: &[&str] = &["__cf_bm", "cf_clearance", "__cflb", "_cfuvid"];

#[tauri::command]
pub fn inject_chatgpt_session(
    manager: tauri::State<'_, ObscuraManager>,
    cookies_json: serde_json::Value,
    access_token: String,
) -> Result<String, String> {
    let status = manager.status.lock().unwrap();
    if !matches!(&*status, ObscuraStatus::Ready { .. }) {
        return Err("CDP浏览器未就绪".into());
    }
    drop(status);

    let cookies_map = match cookies_json.as_object() {
        Some(m) => m,
        None => return Err("cookies不是JSON对象".into()),
    };

    let mut entries: Vec<CookieEntry> = Vec::new();
    for (name, value) in cookies_map {
        if CF_EXCLUDED.contains(&name.as_str()) {
            continue;
        }
        entries.push(CookieEntry {
            name: name.clone(),
            value: value.as_str().unwrap_or("").to_string(),
            domain: ".chatgpt.com".into(),
            path: Some("/".into()),
            secure: Some(true),
            http_only: Some(false),
        });
    }

    entries.push(CookieEntry {
        name: "accessToken".into(),
        value: access_token,
        domain: ".chatgpt.com".into(),
        path: Some("/".into()),
        secure: Some(true),
        http_only: Some(false),
    });

    let count = entries.len();
    inject_cookies_blocking(&entries)?;

    // Navigate to chatgpt.com after cookie injection
    std::thread::sleep(std::time::Duration::from_millis(500));
    navigate_after_cookie_inject()?;

    Ok(format!("注入{}个cookies完成并已导航", count))
}

#[tauri::command]
pub fn open_chatgpt_webview(
    app: tauri::AppHandle,
    tunnel: tauri::State<'_, crate::tunnel::TunnelManager>,
    session: tauri::State<'_, crate::account::SessionState>,
) -> Result<String, String> {
    use url::Url;

    // 1. Try to start sing-box tunnel (best-effort, don't block if no config)
    let tunnel_ok = match ensure_tunnel_running(&tunnel, &session) {
        Ok(port) => {
            crate::tunnel::set_system_proxy_for_chatgpt(true, port);
            eprintln!("[webview] Tunnel running on :{}", port);
            true
        }
        Err(e) => {
            eprintln!("[webview] No tunnel config ({}), ChatGPT will use direct connection", e);
            // No tunnel — ChatGPT will work if user has their own proxy/VPN
            false
        }
    };

    // 2. Open ChatGPT webview
    let chatgpt_url = "https://chatgpt.com/".parse::<Url>().unwrap();
    let label = "chatgpt-main";

    let tunnel_msg = if tunnel_ok { "with tunnel" } else { "direct (no tunnel)" };
    eprintln!("[webview] Opening ChatGPT webview ({})", tunnel_msg);

    // Try child webview inside main window
    if let Some(main_window) = app.get_webview_window("main") {
        let window = main_window.as_ref().window();
        use tauri::WebviewBuilder;
        let win_size = window.inner_size().unwrap_or(tauri::PhysicalSize::new(800, 600));
        let scale = window.scale_factor().unwrap_or(1.0);
        let w = (win_size.width as f64 / scale) as f64;
        let h = (win_size.height as f64 / scale) - 40.0;
        let builder = WebviewBuilder::new(label, tauri::WebviewUrl::External(chatgpt_url))
            .initialization_script(r#"
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
            "#);

        match window.add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 40.0),
            tauri::LogicalSize::new(w, h),
        ) {
            Ok(_) => {
                eprintln!("[webview] ChatGPT child webview embedded");
                let msg = if tunnel_ok {
                    "ChatGPT webview opened (tunnel active)".into()
                } else {
                    "ChatGPT webview opened (direct connection — activate for auto-tunnel)".into()
                };
                return Ok(msg);
            }
            Err(e) => {
                eprintln!("[webview] Child failed ({}), fallback to window", e);
            }
        }
    }

    // Fallback: new window
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let chatgpt_url2 = "https://chatgpt.com/".parse::<Url>().unwrap();
    match WebviewWindowBuilder::new(&app, "chatgpt-window", WebviewUrl::External(chatgpt_url2))
        .title("ChatGPT")
        .inner_size(1200.0, 800.0)
        .initialization_script(r#"
            Object.defineProperty(navigator, 'webdriver', {get: () => false});
        "#)
        .build()
    {
        Ok(_) => {
            let msg = if tunnel_ok {
                "ChatGPT opened (tunnel active)".into()
            } else {
                "ChatGPT opened (direct connection — activate for auto-tunnel)".into()
            };
            Ok(msg)
        }
        Err(e) => Err(format!("打开webview失败: {}", e)),
    }
}

#[tauri::command]
pub fn close_chatgpt_webview(
    app: tauri::AppHandle,
    tunnel: tauri::State<'_, crate::tunnel::TunnelManager>,
) -> Result<(), String> {
    // 1. Close the webview
    for label in &["chatgpt-main", "chatgpt-window"] {
        if let Some(wv) = app.get_webview(label) {
            let _ = wv.close();
            eprintln!("[webview] Closed {}", label);
        }
    }

    // 2. Restore system proxy (daemon mode: only clear PAC, don't kill sing-box)
    crate::tunnel::set_system_proxy_for_chatgpt(false, crate::tunnel::SILICONMATE_PORT);

    // 3. Mark tunnel stopped (daemon keeps running)
    let mut process = tunnel.process.lock().unwrap();
    // 3. Mark tunnel stopped (daemon keeps running)
    *tunnel.status.lock().unwrap() = crate::tunnel::TunnelStatus::Stopped;
    eprintln!("[webview] Proxy disabled (daemon keeps running)");
    Ok(())
}

fn ensure_tunnel_running(tunnel: &crate::tunnel::TunnelManager, session: &crate::account::SessionState) -> Result<u16, String> {
    let status = tunnel.status.lock().unwrap();
    if let crate::tunnel::TunnelStatus::Running { port } = &*status {
        return Ok(*port);
    }
    drop(status);

    // 尝试从session拿config(保留接口兼容)
    let config = {
        let guard = session.0.lock().unwrap();
        guard.as_ref()
            .and_then(|c| c.tunnel_config.clone())
            .or_else(env_tunnel_config)
    };

    // Probe daemon(即使没有config也尝试，因为daemon是独立运行的)
    crate::tunnel::start_tunnel_internal(tunnel, config.unwrap_or_else(|| account_client::TunnelConfig {
        server: String::new(), server_port: 0, uuid: String::new(),
        flow: None, sni: String::new(), public_key: None, short_id: None,
        route_domains: None,
    }))
}

fn env_tunnel_config() -> Option<account_client::TunnelConfig> {
    let json = std::env::var("SILICONMATE_TUNNEL_JSON").ok()?;
    serde_json::from_str(&json).ok()
}

static FILE_SERVER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn start_static_file_server() {
    if FILE_SERVER_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    let html = include_str!("../../public/chatgpt.html").to_string();

    std::thread::spawn(move || {
        let listener = match std::net::TcpListener::bind("127.0.0.1:5174") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[static] Failed to bind :5174: {}", e);
                return;
            }
        };
        eprintln!("[static] Serving on http://localhost:5174 (html + CDP proxy)");

        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            stream.set_nonblocking(false).ok();
            let mut buf = vec![0u8; 8192];
            let n = match std::io::Read::read(&mut stream, &mut buf) {
                Ok(n) if n > 0 => n,
                _ => continue,
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");

            if first_line.contains(" /chatgpt.html") || first_line.contains(" / ") {
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n{}",
                    html
                );
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            } else if first_line.contains(" /cdp/") {
                // Proxy CDP requests: /cdp/json → http://127.0.0.1:9222/json
                let cdp_path = if first_line.contains(" /cdp/json") {
                    // Parse query params
                    if first_line.contains("new=") {
                        "/json/new"
                    } else {
                        "/json"
                    }
                } else if first_line.contains(" /cdp/version") {
                    "/json/version"
                } else {
                    let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
                    let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
                    continue;
                };

                // Forward to CDP
                match reqwest::blocking::Client::new()
                    .get(&format!("http://127.0.0.1:9222{}", cdp_path))
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                {
                    Ok(cdp_resp) => {
                        let status = cdp_resp.status().as_u16();
                        let body = cdp_resp.text().unwrap_or_default();
                        // Rewrite websocket URLs to use our proxy
                        let body = body.replace("ws://127.0.0.1:9222", "ws://127.0.0.1:5174");
                        let resp = format!(
                            "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n\r\n{}",
                            status, body
                        );
                        let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
                    }
                    Err(e) => {
                        eprintln!("[static] CDP proxy error: {}", e);
                        let resp = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\nCDP not available";
                        let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
                    }
                }
            } else if first_line.starts_with("OPTIONS") {
                let resp = "HTTP/1.1 200 OK\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n\r\n";
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            } else {
                let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            }
        }
    });
}

#[tauri::command]
pub fn open_chatgpt_safari(
    tunnel: tauri::State<'_, crate::tunnel::TunnelManager>,
    session: tauri::State<'_, crate::account::SessionState>,
) -> Result<String, String> {
    // Probe统一daemon(不再自己spawn sing-box)
    let tunnel_ok = match ensure_tunnel_running(&tunnel, &session) {
        Ok(port) => {
            crate::tunnel::set_system_proxy_for_chatgpt(true, port);
            true
        }
        Err(e) => {
            eprintln!("[safari] Daemon not ready ({}), using direct connection", e);
            false
        }
    };

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(["-a", "Safari", "https://chatgpt.com/"])
            .spawn();
    }

    if tunnel_ok {
        Ok("Daemon已就绪, Safari已打开ChatGPT".into())
    } else {
        Ok("Safari已打开ChatGPT (直连模式, 请确保daemon已启动: launchctl load ~/Library/LaunchAgents/com.shrimp.tunnel.plist)".into())
    }
}

#[tauri::command]
pub fn close_chatgpt_safari(
    tunnel: tauri::State<'_, crate::tunnel::TunnelManager>,
) -> Result<String, String> {
    // 只清理系统代理，不kill daemon(daemon是独立进程)
    crate::tunnel::set_system_proxy_for_chatgpt(false, crate::tunnel::SILICONMATE_PORT);
    *tunnel.status.lock().unwrap() = crate::tunnel::TunnelStatus::Stopped;

    Ok("代理已关闭(daemon继续运行)".into())
}
