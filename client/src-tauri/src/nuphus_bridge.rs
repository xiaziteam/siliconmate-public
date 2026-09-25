//! 硅侣4.2 — Nuphus DesktopClient桥接（真调用版）
//!
//! 三平台Computer Use引擎：Windows=SendInput / macOS=enigo / Linux=XTest(仅X11)
//! 截图=xcap跨平台；剪贴板=desktop-api跨平台；OCR=PaddleOCR ONNX(需模型)
//!
//! 安全防护：nuphus内部enigo初始化失败会panic（无辅助功能权限等），
//! 所有调用经tokio::spawn隔离，panic转为错误而非崩溃App。
//!
//! 模型缺失时OCR/perceive返回明确错误，触发task_engine降级链。
//! macOS的OCR优先走Apple Vision（ocr.rs），失败再回退PaddleOCR。

use nuphus::desktop::DesktopClient;
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

/// Nuphus桥接状态
pub struct NuphusBridge {
    /// DesktopClient单例（懒加载）
    client: OnceLock<Arc<DesktopClient>>,
    /// 是否可用（构造成功即true）
    available: Mutex<bool>,
    /// 版本号
    version: String,
    /// 是否已尝试初始化（懒加载标记）
    initialized: Mutex<bool>,
}

impl NuphusBridge {
    pub fn new() -> Self {
        Self {
            client: OnceLock::new(),
            available: Mutex::new(false),
            version: "0.2.0".into(),
            initialized: Mutex::new(false),
        }
    }

    /// 检查Nuphus是否可用（懒初始化：首次检查时构造DesktopClient）
    pub fn is_available(&self) -> bool {
        let init = self.initialized.lock().unwrap();
        if !*init {
            drop(init);
            self.try_lazy_init();
        }
        *self.available.lock().unwrap()
    }

    /// 标记可用状态
    pub fn set_available(&self, available: bool) {
        let mut a = self.available.lock().unwrap();
        *a = available;
        let mut init = self.initialized.lock().unwrap();
        *init = true;
    }

    /// 懒初始化：构造DesktopClient（纯内存操作，不加载模型/不初始化enigo）
    fn try_lazy_init(&self) {
        let mut init = self.initialized.lock().unwrap();
        if *init {
            return;
        }
        match self.client.set(Arc::new(DesktopClient::new())) {
            Ok(_) => {
                let mut a = self.available.lock().unwrap();
                *a = true;
                eprintln!("[nuphus] DesktopClient initialized (engine ready)");
            }
            Err(_) => {
                eprintln!("[nuphus] DesktopClient already set");
            }
        }
        *init = true;
    }

    /// 获取client引用（未初始化时自动懒加载）
    fn client(&self) -> Result<Arc<DesktopClient>, String> {
        if let Some(c) = self.client.get() {
            return Ok(c.clone());
        }
        self.try_lazy_init();
        self.client
            .get()
            .cloned()
            .ok_or_else(|| "Nuphus引擎未初始化".into())
    }
}

impl Default for NuphusBridge {
    fn default() -> Self {
        Self::new()
    }
}

// ── panic隔离：JoinResult → Result ──

async fn join_to_result(
    res: Result<Result<Value, nuphus::NuphusError>, tokio::task::JoinError>,
) -> Result<Value, String> {
    match res {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("nuphus: {}", e)),
        Err(join_err) if join_err.is_panic() => {
            let p = join_err.into_panic();
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            Err(format!("nuphus引擎异常(可能缺少辅助功能权限): {}", msg))
        }
        Err(e) => Err(format!("nuphus task: {}", e)),
    }
}

// ── 内部执行方法（供task_engine调用）──

/// 执行Nuphus方法（内部调用）
pub async fn do_nuphus_execute(
    bridge: &NuphusBridge,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    if !bridge.is_available() {
        return Err("Nuphus引擎不可用".into());
    }

    match method {
        // 截屏相关
        "screenshot" => do_nuphus_screenshot(bridge, params).await,
        "get_screen_size" => do_nuphus_get_screen_size(bridge).await,

        // 窗口相关
        "window_activate" => do_nuphus_window_activate(bridge, params).await,
        "set_focus" => do_nuphus_set_focus(bridge, params).await,
        "get_window_list" => do_nuphus_get_window_list(bridge).await,
        "get_window_info" => do_nuphus_get_window_info(bridge, params).await,

        // 鼠标相关
        "mouse_click" => do_nuphus_mouse_click(bridge, params).await,
        "mouse_move" => do_nuphus_mouse_move(bridge, params).await,
        "mouse_drag" => do_nuphus_mouse_drag(bridge, params).await,
        "mouse_scroll" => do_nuphus_mouse_scroll(bridge, params).await,

        // 键盘相关
        "keyboard_type" => do_nuphus_keyboard_type(bridge, params).await,
        "keyboard_press" => do_nuphus_keyboard_press(bridge, params).await,
        "keyboard_hotkey" => do_nuphus_keyboard_hotkey(bridge, params).await,

        // 剪贴板
        "clipboard_read" => do_nuphus_clipboard_read(bridge).await,
        "clipboard_write" => do_nuphus_clipboard_write(bridge, params).await,

        // AI感知
        "ocr" => do_nuphus_ocr(bridge, params).await,
        "perceive" => do_nuphus_perceive(bridge, params).await,
        "find_text" => do_nuphus_find_text(bridge, params).await,
        "find_icon" => do_nuphus_find_icon(bridge, params).await,

        // 等待
        "wait_for_text" => do_nuphus_wait_for_text(bridge, params).await,
        "wait_for_icon" => do_nuphus_wait_for_icon(bridge, params).await,

        // 高级操作
        "execute" => do_nuphus_computer_use(bridge, params).await,
        "multi_step" => do_nuphus_multi_step(bridge, params).await,
        "drag_and_drop" => do_nuphus_drag_and_drop(bridge, params).await,
        "menu_click" => do_nuphus_menu_click(bridge, params).await,
        "type_in_field" => do_nuphus_type_in_field(bridge, params).await,

        _ => Err(format!("Nuphus不支持的方法: {}", method)),
    }
}

// ── 截屏相关 ──

async fn do_nuphus_screenshot(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // region: "full"或空 = 全屏；对象{x,y,width,height} = 区域
    let region = params.get("region").and_then(|v| {
        if v.is_string() {
            None // "full"
        } else if v.is_object() {
            Some(v.clone())
        } else {
            None
        }
    });
    join_to_result(
        tokio::spawn(async move { client.screenshot(path.as_deref(), region).await }).await,
    )
    .await
}

async fn do_nuphus_get_screen_size(bridge: &NuphusBridge) -> Result<Value, String> {
    let client = bridge.client()?;
    join_to_result(tokio::spawn(async move { client.screen_size().await }).await).await
}

// ── 窗口相关 ──

/// 窗口标题模糊匹配 → hwnd（从windows_list结果里找）
async fn find_hwnd_by_title(
    client: Arc<DesktopClient>,
    app_name: &str,
) -> Result<Option<i64>, String> {
    let list = join_to_result(tokio::spawn(async move { client.windows_list().await }).await).await?;
    // nuphus返回结构: {"success":true,"result":{"windows":[{"hwnd":..,"title":..}]}} — 兼容多种形态
    let windows = list
        .get("result")
        .and_then(|r| r.get("windows"))
        .or_else(|| list.get("windows"))
        .and_then(|w| w.as_array())
        .cloned()
        .unwrap_or_default();
    let lower = app_name.to_lowercase();
    for w in &windows {
        let title = w.get("title").and_then(|t| t.as_str()).unwrap_or("");
        if !title.is_empty() && title.to_lowercase().contains(&lower) {
            let hwnd = w.get("hwnd").and_then(|h| h.as_i64()).unwrap_or(0);
            return Ok(Some(hwnd));
        }
    }
    Ok(None)
}

async fn do_nuphus_window_activate(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params
        .get("app_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if app_name.is_empty() {
        return Err("app_name不能为空".into());
    }

    // 1) 标题匹配 → hwnd激活（三平台通用）
    let client = bridge.client()?;
    if let Some(hwnd) = find_hwnd_by_title(client.clone(), &app_name).await? {
        if hwnd != 0 {
            let r = join_to_result(
                tokio::spawn(async move { client.window_activate(hwnd as i32).await }).await,
            )
            .await;
            if r.is_ok() {
                return Ok(serde_json::json!({ "success": true, "app": app_name, "hwnd": hwnd }));
            }
        }
    }

    // 2) macOS回退：osascript按应用名激活
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"{}\" to activate",
            app_name.replace('"', "\\\"")
        );
        let output = tokio::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .await
            .map_err(|e| format!("osascript activate失败: {}", e))?;
        if output.status.success() {
            return Ok(serde_json::json!({ "success": true, "app": app_name }));
        }
        return Err(format!(
            "激活窗口失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    #[cfg(not(target_os = "macos"))]
    Err(format!("未找到匹配窗口: {}", app_name))
}

async fn do_nuphus_set_focus(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    do_nuphus_window_activate(bridge, params).await
}

async fn do_nuphus_get_window_list(bridge: &NuphusBridge) -> Result<Value, String> {
    let client = bridge.client()?;
    join_to_result(tokio::spawn(async move { client.windows_list().await }).await).await
}

async fn do_nuphus_get_window_info(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params
        .get("app_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if app_name.is_empty() {
        return Err("app_name不能为空".into());
    }
    // hwnd直传优先
    if let Some(hwnd) = params.get("hwnd").and_then(|v| v.as_i64()) {
        let client = bridge.client()?;
        return join_to_result(
            tokio::spawn(async move { client.window_info(hwnd as i32).await }).await,
        )
        .await;
    }
    // 标题匹配 → window_info
    let client = bridge.client()?;
    if let Some(hwnd) = find_hwnd_by_title(client.clone(), &app_name).await? {
        if hwnd != 0 {
            return join_to_result(
                tokio::spawn(async move { client.window_info(hwnd as i32).await }).await,
            )
            .await;
        }
    }
    Err(format!("未找到窗口: {}", app_name))
}

// ── 鼠标相关（Win=SendInput / macOS+Linux=enigo，无外部依赖）──

async fn do_nuphus_mouse_click(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let x = params.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let y = params.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let button = params
        .get("button")
        .and_then(|v| v.as_str())
        .unwrap_or("left")
        .to_string();
    let clicks = params.get("clicks").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
    join_to_result(
        tokio::spawn(async move { client.mouse_click(x, y, &button, clicks).await }).await,
    )
    .await
}

async fn do_nuphus_mouse_move(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let x = params.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let y = params.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    join_to_result(tokio::spawn(async move { client.mouse_move(x, y, 0.0).await }).await).await
}

async fn do_nuphus_mouse_drag(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let from_x = params.get("from_x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let from_y = params.get("from_y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let to_x = params.get("to_x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let to_y = params.get("to_y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    join_to_result(
        tokio::spawn(async move { client.mouse_drag(from_x, from_y, to_x, to_y).await }).await,
    )
    .await
}

async fn do_nuphus_mouse_scroll(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let direction = params
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("down")
        .to_string();
    let amount = params.get("amount").and_then(|v| v.as_i64()).unwrap_or(3) as i32;
    join_to_result(
        tokio::spawn(async move { client.mouse_scroll(&direction, amount).await }).await,
    )
    .await
}

// ── 键盘相关 ──

async fn do_nuphus_keyboard_type(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    join_to_result(
        tokio::spawn(async move { client.keyboard_type_unicode(&text).await }).await,
    )
    .await
}

async fn do_nuphus_keyboard_press(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let key = params
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("return")
        .to_string();
    join_to_result(tokio::spawn(async move { client.keyboard_press(&key).await }).await).await
}

async fn do_nuphus_keyboard_hotkey(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    // 兼容两种参数形态：{key, modifiers:[...]} 或 {keys:[...]}
    let mut keys: Vec<String> = params
        .get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if let Some(key) = params.get("key").and_then(|v| v.as_str()) {
        keys.push(key.to_string());
    }
    if keys.is_empty() {
        if let Some(arr) = params.get("keys").and_then(|v| v.as_array()) {
            keys = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
        }
    }
    if keys.is_empty() {
        return Err("快捷键参数为空".into());
    }
    join_to_result(tokio::spawn(async move { client.keyboard_hotkey(keys).await }).await).await
}

// ── 剪贴板（desktop-api跨平台）──

async fn do_nuphus_clipboard_read(_bridge: &NuphusBridge) -> Result<Value, String> {
    let text = tokio::task::spawn_blocking(desktop_api::clipboard::read_text)
        .await
        .map_err(|e| format!("clipboard task: {}", e))?
        .map_err(|e| format!("读取剪贴板失败: {}", e))?;
    Ok(serde_json::json!({ "text": text }))
}

async fn do_nuphus_clipboard_write(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let client = bridge.client()?;
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    join_to_result(
        tokio::spawn(async move { client.clipboard_write(&text).await }).await,
    )
    .await
}

// ── AI感知 ──

async fn do_nuphus_ocr(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let image_path = params
        .get("image_path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if image_path.is_empty() {
        return Err("image_path不能为空".into());
    }

    // v4.2.0 视觉引擎路由：auto/macOS=Apple Vision优先 | api=用户配置 | local=强制Paddle
    match crate::vision_engine::resolve_ocr_route() {
        crate::vision_engine::OcrRoute::Api => {
            let text = crate::vision_engine::ocr_via_api(image_path).await?;
            return Ok(serde_json::json!({ "text": text, "engine": "api" }));
        }
        crate::vision_engine::OcrRoute::System => {
            #[cfg(target_os = "macos")]
            {
                match crate::ocr::extract_text(image_path.to_string()) {
                    Ok(text) => {
                        return Ok(serde_json::json!({ "text": text, "engine": "apple_vision" }))
                    }
                    Err(e) => {
                        eprintln!("[nuphus] Apple Vision OCR失败，回退PaddleOCR: {}", e);
                    }
                }
            }
        }
        crate::vision_engine::OcrRoute::LocalPaddle => {}
    }

    // PaddleOCR ONNX（需模型；模型缺失返回错误触发降级）
    let client = bridge.client()?;
    let path = image_path.to_string();
    join_to_result(
        tokio::spawn(async move { client.ocr("paddle", &path, false, None).await }).await,
    )
    .await
}

async fn do_nuphus_perceive(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // AI视觉理解走API方案（v4.2.0视觉引擎设置页），本地不跑大模型
    Err("perceive需配置AI视觉API（设置→视觉引擎）".into())
}

async fn do_nuphus_find_text(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if text.is_empty() {
        return Err("text不能为空".into());
    }

    // 截图 → OCR(boxes) → 文本匹配坐标
    let client = bridge.client()?;
    let shot = join_to_result(
        tokio::spawn(async move { client.screenshot(None, None).await }).await,
    )
    .await?;
    let shot_path = shot
        .get("result")
        .and_then(|r| r.get("path"))
        .or_else(|| shot.get("path"))
        .and_then(|p| p.as_str())
        .ok_or("截图失败：无路径")?
        .to_string();

    let client2 = bridge.client()?;
    let ocr = join_to_result(
        tokio::spawn(async move { client2.ocr("paddle", &shot_path, true, None).await }).await,
    )
    .await?;

    // 在OCR结果里找目标文本
    let target = text.to_lowercase();
    let items = ocr
        .get("result")
        .and_then(|r| r.as_array().cloned())
        .or_else(|| ocr.as_array().cloned())
        .unwrap_or_default();
    for item in &items {
        let t = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if t.to_lowercase().contains(&target) {
            return Ok(serde_json::json!({
                "found": true,
                "text": t,
                "box": item.get("box").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(serde_json::json!({ "found": false }))
}

async fn do_nuphus_find_icon(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 图标定位走API方案（v4.2.0视觉引擎设置页）
    Err("find_icon需配置AI视觉API（设置→视觉引擎）".into())
}

// ── 等待 ──

async fn do_nuphus_wait_for_text(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let timeout_secs = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30);
    if text.is_empty() {
        return Err("text不能为空".into());
    }
    let start = std::time::Instant::now();
    loop {
        let r = do_nuphus_find_text(
            bridge,
            &serde_json::json!({ "text": text }),
        )
        .await?;
        if r.get("found").and_then(|f| f.as_bool()).unwrap_or(false) {
            return Ok(r);
        }
        if start.elapsed().as_secs() >= timeout_secs {
            return Ok(serde_json::json!({ "found": false, "timeout": true }));
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}

async fn do_nuphus_wait_for_icon(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    Err("wait_for_icon需配置AI视觉API（设置→视觉引擎）".into())
}

// ── 高级操作 ──

async fn do_nuphus_computer_use(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 完整Computer Use调用链：需LLM编排，走API方案
    Err("Computer Use编排需配置AI API（设置→视觉引擎）".into())
}

async fn do_nuphus_multi_step(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    Err("multi_step需配置AI API（设置→视觉引擎）".into())
}

async fn do_nuphus_drag_and_drop(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    do_nuphus_mouse_drag(bridge, params).await
}

async fn do_nuphus_menu_click(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let _ = bridge;
    let app_name = params.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
    let menu_name = params.get("menu").and_then(|v| v.as_str()).unwrap_or("");
    let item_name = params.get("item").and_then(|v| v.as_str()).unwrap_or("");

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "{}" to activate
tell application "System Events" to tell process "{}" to click menu item "{}" of menu "{}" of menu bar 1"#,
            app_name.replace('"', "\\\""),
            app_name.replace('"', "\\\""),
            item_name.replace('"', "\\\""),
            menu_name.replace('"', "\\\""),
        );
        let output = tokio::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .await
            .map_err(|e| format!("菜单点击失败: {}", e))?;
        if output.status.success() {
            Ok(serde_json::json!({ "success": true }))
        } else {
            Err(format!(
                "菜单点击失败: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bridge, app_name, menu_name, item_name);
        Err("menu_click当前仅支持macOS".into())
    }
}

async fn do_nuphus_type_in_field(bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // 全选清空 → 输入
    let select_all = if cfg!(target_os = "macos") {
        serde_json::json!({ "key": "a", "modifiers": ["cmd"] })
    } else {
        serde_json::json!({ "key": "a", "modifiers": ["ctrl"] })
    };
    let _ = do_nuphus_keyboard_hotkey(bridge, &select_all).await;
    do_nuphus_keyboard_type(bridge, &serde_json::json!({ "text": text })).await
}

// ── Tauri Commands ──

/// Nuphus截图
#[tauri::command]
pub async fn nuphus_screenshot(
    bridge: State<'_, NuphusBridge>,
    path: Option<String>,
    region: Option<String>,
) -> Result<Value, String> {
    let params = serde_json::json!({
        "path": path.unwrap_or_default(),
        "region": region.unwrap_or_else(|| "full".into()),
    });
    do_nuphus_screenshot(&bridge, &params).await
}

/// 通用Nuphus方法调用
#[tauri::command]
pub async fn nuphus_execute(
    bridge: State<'_, NuphusBridge>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    do_nuphus_execute(&bridge, &method, &params).await
}

/// Nuphus引擎状态
#[tauri::command]
pub fn nuphus_status(bridge: State<'_, NuphusBridge>) -> Result<Value, String> {
    Ok(serde_json::json!({
        "available": bridge.is_available(),
        "version": bridge.version,
    }))
}

/// Nuphus OCR
#[tauri::command]
pub async fn nuphus_ocr(
    bridge: State<'_, NuphusBridge>,
    image_path: String,
) -> Result<Value, String> {
    let params = serde_json::json!({ "image_path": image_path });
    do_nuphus_ocr(&bridge, &params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实链路：DesktopClient xcap截图（三平台引擎）
    #[tokio::test]
    async fn test_desktop_client_screenshot_real() {
        let bridge = NuphusBridge::new();
        let r = do_nuphus_screenshot(
            &bridge,
            &serde_json::json!({ "path": "/tmp/nuphus-test-shot.bmp", "region": "full" }),
        )
        .await;
        assert!(r.is_ok(), "screenshot failed: {:?}", r.err());
        let result = r.unwrap();
        let path = result
            .get("result")
            .and_then(|x| x.get("path"))
            .or_else(|| result.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string();
        assert!(!path.is_empty(), "no path in result");
        let meta = std::fs::metadata(&path).expect("screenshot file must exist");
        assert!(meta.len() > 100_000, "screenshot too small: {} bytes", meta.len());
        let _ = std::fs::remove_file(&path);
    }

    /// 真实链路：屏幕尺寸（三平台）
    #[tokio::test]
    async fn test_desktop_client_screen_size_real() {
        let bridge = NuphusBridge::new();
        let r = do_nuphus_get_screen_size(&bridge).await;
        assert!(r.is_ok(), "screen_size failed: {:?}", r.err());
    }

    /// 真实链路：剪贴板写入+读回（desktop-api跨平台）
    #[tokio::test]
    async fn test_clipboard_roundtrip_real() {
        let bridge = NuphusBridge::new();
        let marker = format!("siliconmate-nuphus-test-{}", std::process::id());
        let w = do_nuphus_clipboard_write(&bridge, &serde_json::json!({ "text": marker })).await;
        assert!(w.is_ok(), "clipboard_write failed: {:?}", w.err());
        let r = do_nuphus_clipboard_read(&bridge).await;
        assert!(r.is_ok(), "clipboard_read failed: {:?}", r.err());
        let binding = r.unwrap();
        let text = binding.get("text").and_then(|t| t.as_str()).unwrap_or_default();
        assert_eq!(text, marker, "clipboard roundtrip mismatch");
    }
}
