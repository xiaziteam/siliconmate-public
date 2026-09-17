//! 硅侣2.0 — 账号登录模块
//! 搬运自magic-chatgpt-app，适配双Agent架构
//!
//! 功能：
//! - l1_login: 账号密码登录 → auth-token + api_key
//! - guest_enter: 访客模式（无服务端Agent，无语音聊天）
//! - heartbeat: 30秒心跳保活

use account_client::{AccountClient, AccountInfo, ActivateResponse, FetchPayload, LoginResponse, TunnelConfig};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 会话态 — 存储登录后的凭证
#[derive(Default)]
pub struct SessionState(pub Mutex<Option<Creds>>);

#[derive(Clone, Serialize)]
pub struct Creds {
    pub api_key: String,
    pub account_id: String,
    pub auth_token: Option<String>,
    pub tunnel_config: Option<TunnelConfig>,
    pub activated: bool,
    pub plan: Option<String>,
}

/// Account client context
pub struct AppCtx {
    pub client: AccountClient,
}

#[tauri::command]
pub async fn activate(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
    code: String,
) -> Result<ActivateResponse, String> {
    // NOTE: This is the legacy /v1/code/validate flow (XK codes for 虾壳).
    // For 硅侣, use account_activate instead.
    // We do NOT store code_id as credentials — that would break HMAC auth.
    let device_id = format!("siliconmate-{}", whoami_fallback());
    let resp = ctx
        .client
        .activate_code(&code, &device_id)
        .await
        .map_err(|e| e.to_string())?;

    // Only update tunnel_config if we have existing creds (user already logged in)
    let mut creds_lock = state.0.lock().unwrap();
    if let Some(ref mut creds) = *creds_lock {
        if let Some(tunnel) = resp.tunnel.clone() {
            creds.tunnel_config = Some(tunnel);
        }
        creds.activated = true;
        creds.plan = Some(resp.plan.clone());
    }
    // If no existing creds, the user must login first — activation alone doesn't establish credentials

    Ok(resp)
}

#[tauri::command]
pub async fn register(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
    account_name: String,
    password: String,
) -> Result<LoginResponse, String> {
    let device_id = format!("siliconmate-{}", whoami_fallback());
    let resp = ctx
        .client
        .register(&account_name, &password, &device_id)
        .await
        .map_err(|e| e.to_string())?;

    let tunnel = resp.tunnel.clone();
    *state.0.lock().unwrap() = Some(Creds {
        api_key: resp.api_key.clone(),
        account_id: resp.account_id.clone(),
        auth_token: None,
        tunnel_config: tunnel,
        activated: false,
        plan: None,
    });

    Ok(resp)
}

#[tauri::command]
pub async fn account_activate(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
    code: String,
) -> Result<ActivateResponse, String> {
    let creds = state.0.lock().unwrap().clone();
    eprintln!("[account_activate] code={}, creds={}", code, if creds.is_some() { "yes" } else { "NONE" });
    let creds = creds.ok_or("未登录，请先注册或登录账号")?;
    let resp = ctx
        .client
        .account_activate(&creds.api_key, &creds.account_id, &code)
        .await
        .map_err(|e| {
            eprintln!("[account_activate] FAILED: {}", e);
            e.to_string()
        })?;

    let tunnel = resp.tunnel.clone();
    *state.0.lock().unwrap() = Some(Creds {
        api_key: creds.api_key,
        account_id: creds.account_id,
        auth_token: creds.auth_token,
        tunnel_config: tunnel,
        activated: resp.activated,
        plan: Some(resp.plan.clone()),
    });

    eprintln!("[account_activate] OK plan={}", resp.plan);
    Ok(resp)
}

/// [L1登录] — 账号密码登录获取auth-token
#[tauri::command]
pub async fn l1_login(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
    account_name: String,
    password: String,
) -> Result<LoginResponse, String> {
    eprintln!("[l1_login] start for account: {}", account_name);
    let device_id = format!("siliconmate-{}", whoami_fallback());
    let lr = ctx
        .client
        .login(&account_name, &password, &device_id)
        .await
        .map_err(|e| {
            eprintln!("[l1_login] FAILED: {}", e);
            e.to_string()
        })?;

    *state.0.lock().unwrap() = Some(Creds {
        api_key: lr.api_key.clone(),
        account_id: lr.account_id.clone(),
        auth_token: None,
        tunnel_config: lr.tunnel.clone(),
        activated: lr.activated,
        plan: lr.plan.clone(),
    });

    eprintln!("[l1_login] ok account_id={} activated={}", lr.account_id, lr.activated);
    Ok(lr)
}

/// [账号信息] — 冷启动恢复时由前端调用, 拉取 account_name/silicon_id 显示
#[tauri::command]
pub async fn account_info(
    ctx: State<'_, AppCtx>,
    account_id: String,
) -> Result<AccountInfo, String> {
    ctx.client
        .get_account_info(&account_id)
        .await
        .map_err(|e| e.to_string())
}

/// [获取ChatGPT Session] — 用于语音聊天(Obscura CDP透传)
#[tauri::command]
pub async fn apply_session(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
) -> Result<FetchPayload, String> {
    eprintln!("[apply_session] fetching");
    let creds = state.0.lock().unwrap().clone().ok_or("未登录")?;
    let payload = ctx
        .client
        .fetch_session(&creds.api_key, &creds.account_id)
        .await
        .map_err(|e| e.to_string())?;

    // Store auth_token from session
    let tunnel_config = payload.tunnel_config.clone().or(creds.tunnel_config);
    *state.0.lock().unwrap() = Some(Creds {
        api_key: creds.api_key,
        account_id: creds.account_id,
        auth_token: Some(payload.session_id.clone()),
        tunnel_config,
        activated: creds.activated,
        plan: creds.plan,
    });

    eprintln!(
        "[apply_session] got session_id={}",
        payload.session_id
    );
    Ok(payload)
}

/// [访客模式] — 免登录，客户端Agent可用，服务端Agent和语音聊天不可用
#[tauri::command]
pub async fn guest_enter() -> Result<(), String> {
    eprintln!("[guest_enter] entering guest mode");
    // Guest mode: no login, no server, no voice chat
    // Client Agent still works with GLM-4-Flash
    Ok(())
}

/// [心跳保活] — 30秒自动调用
#[tauri::command]
pub async fn heartbeat(
    state: State<'_, SessionState>,
    ctx: State<'_, AppCtx>,
    session_id: String,
) -> Result<String, String> {
    let creds = state.0.lock().unwrap().clone().ok_or("未登录")?;
    ctx.client
        .heartbeat(&creds.api_key, &creds.account_id, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// [收尾] — 登录完成后关闭登录窗口
#[tauri::command]
pub fn finish_enter(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("login") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 获取当前用户名（用于生成device_id）
pub fn whoami_fallback() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "anon".into())
}
