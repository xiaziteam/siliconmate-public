//! 硅侣3.0 — 双Agent极简AI助手（Tauri2入口）
//!
//! V3.0 = siliconmate-v2 + magic-chatgpt-app 融合
//!
//! 核心架构：
//! - 客户端Agent: free-code SDK子进程 (GLM-4-Flash + nuphus-mcp)
//! - 服务端Agent: free-code Server (AgentChat + OfficeCLI)
//! - Tauri2壳层: 场景路由 + 输出过滤 + 极简交互
//! - V1迁入: account-service + tunnel + ChatGPT编排器 + Cookie同步

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod account;
pub mod agent_manager;
pub mod output_filter;
pub mod scene_router;
pub mod server_connector;
pub mod ocr;
pub mod obscura;
pub mod tunnel;
pub mod voice_input;
pub mod feishu_output;
pub mod smcp;
// Agent capability modules (硅侣Agent能力升级)
pub mod task_engine;
pub mod nuphus_bridge;
pub mod vision_engine;
pub mod native_cmds;
pub mod permission;

use account::{AppCtx, SessionState};

/// JS-side debug log — release 版 WKWebView console 不可见，统一落 /tmp/siliconmate-debug.log
#[tauri::command]
fn js_log(msg: String) {
    use std::io::Write;
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open("/tmp/siliconmate-debug.log")
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(log, "[{}][js] {}", ts, msg);
    }
}

fn main() {
    // Safety: clear any leftover PAC proxy from previous crash/force-quit
    #[cfg(target_os = "macos")]
    {
        tunnel::cleanup_leftover_proxy();
    }

    let base_url = std::env::var("ACCOUNT_SERVICE_URL")
        .unwrap_or_else(|_| "https://locatenotify.online".into());
    let self_signed = std::env::var("ACCEPT_SELF_SIGNED")
        .map(|v| v == "1")
        .unwrap_or(true);

    // Startup probe — lightweight debug log (non-blocking, no network probe)
    {
        use std::io::Write;
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open("/tmp/siliconmate-debug.log")
        {
            let _ = writeln!(log, "[startup] v{} base_url={}, self_signed={}", std::env!("CARGO_PKG_VERSION"), base_url, self_signed);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .manage(AppCtx {
            client: account_client::AccountClient::new(base_url, self_signed)
                .expect("account client init"),
        })
        .manage(agent_manager::AgentManager::default())
        .manage(obscura::ObscuraManager::new())
        .manage(tunnel::TunnelManager::new())
        .manage(smcp::SmcpState::new())
        .manage(task_engine::TaskEngine::new())
        .manage(nuphus_bridge::NuphusBridge::new())
        .manage(native_cmds::NativeCmdState::new())
        .manage(permission::PermissionStore::new())
        .manage(server_connector::ServerConnector::new(
            std::env::var("SILICONMATE_SERVER_HOST")
                .unwrap_or_else(|_| "locatenotify.online".into()),
            std::env::var("SILICONMATE_SSH_KEY")
                .unwrap_or_else(|_| {
                    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
                    format!("{}/.ssh/id_ed25519", home)
                }),
        ))
        .invoke_handler(tauri::generate_handler![
            // Account
            account::register,
            account::l1_login,            account::activate,
            account::account_info,
            account::account_activate,
            account::account_change_password,
            account::account_change_username,
            account::apply_session,
            account::heartbeat,
            account::guest_enter,
            account::finish_enter,
            // Agent Manager (per-request mode)
            agent_manager::send_message,
            agent_manager::get_agent_status,
            agent_manager::check_agent_health,
            // Scene Router
            scene_router::route_message,
            // OCR
            ocr::extract_text,
            ocr::process_image,
            // Voice Input
            voice_input::detect_voice_support,
            voice_input::start_voice_input,
            voice_input::start_recording,
            voice_input::stop_recording,
            voice_input::paste_text,
            // Server Connector
            server_connector::connect_server,
            server_connector::disconnect_server,
            server_connector::call_server_agent,
            server_connector::call_server_deep_think,
            server_connector::call_server_office,
            // Feishu Output
            feishu_output::feishu_send_message,
            feishu_output::feishu_create_doc,
            feishu_output::feishu_check,
            // Obscura Sidecar (Voice Chat)
            obscura::start_obscura,
            obscura::stop_obscura,
            obscura::obscura_status,
            obscura::obscura_set_ready,
            obscura::inject_cookies,
            obscura::inject_chatgpt_session,
            // ChatGPT (Safari mode)
            obscura::open_chatgpt_safari,
            obscura::close_chatgpt_safari,
            // Tunnel
            tunnel::start_tunnel,
            tunnel::stop_tunnel,
            tunnel::tunnel_status,
            tunnel::get_proxy_url,
            // SMCP
            smcp::smcp_register,
            smcp::smcp_agent_list,
            smcp::smcp_friend_capabilities,
            smcp::smcp_message_send,
            smcp::smcp_message_poll,
            smcp::smcp_friend_request,
            smcp::smcp_friend_accept,
            smcp::smcp_friend_reject,
            smcp::smcp_friend_list,
            smcp::smcp_friend_set_permissions,
            smcp::smcp_friend_remove,
            smcp::smcp_friend_requests,
            smcp::smcp_ping,
            smcp::smcp_lookup,
            smcp::smcp_message_unread,
            smcp::smcp_message_read,
            smcp::smcp_group_create,
            smcp::smcp_group_list,
            smcp::smcp_group_info,
            smcp::smcp_group_invite,
            smcp::smcp_group_leave,
            smcp::smcp_group_message_send,
            smcp::smcp_group_kick,
            smcp::smcp_group_transfer,
            smcp::smcp_group_set_role,
            smcp::smcp_group_update,
            smcp::smcp_file_upload,
            smcp::read_file_base64,
            // Task Engine (Agent capability execution)
            task_engine::task_execute,
            task_engine::task_send,
            task_engine::task_result_poll,
            task_engine::task_list_capabilities,
            task_engine::task_cancel,
            task_engine::task_check_timeouts,
            task_engine::task_get_pending_remote,
            task_engine::task_remove_pending_remote,
            task_engine::task_multi_step_execute,
            // Nuphus Bridge (Computer Use engine)
            nuphus_bridge::nuphus_screenshot,
            nuphus_bridge::nuphus_execute,
            nuphus_bridge::nuphus_status,
            nuphus_bridge::nuphus_ocr,
            // Vision Engine (v4.2.0 视觉引擎设置 + 模型下载)
            vision_engine::vision_engine_status,
            vision_engine::vision_engine_set,
            vision_engine::vision_models_download,
            // Native Commands (macOS direct)
            native_cmds::native_screenshot,
            native_cmds::native_open_app,
            native_cmds::native_shell_exec,
            native_cmds::native_read_file,
            // Permission (remote task approval)
            permission::permission_check,
            permission::permission_set,
            permission::permission_list,
            // SMCP Task/Result protocol
            smcp::smcp_task_send,
            smcp::smcp_task_result_send,
            js_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // 退场必恢复：App 真正退出时释放系统代理接管，用户网络恢复原样。
            // 覆盖正常退出 / Cmd+Q / 激活失效后的退出；崩溃场景由下次启动的
            // cleanup_leftover_proxy() 依据持久化接管记录自愈。
            if let tauri::RunEvent::Exit = event {
                tunnel::proxy_release();
            }
        });
}
