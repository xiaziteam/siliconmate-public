use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSupportInfo {
    pub supported: bool,
    pub method: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInputResult {
    pub text: String,
    pub confidence: f64,
}

#[cfg(target_os = "macos")]
mod macos_impl;

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn detect_voice_support() -> VoiceSupportInfo {
    macos_impl::detect_voice_support()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn start_voice_input() -> Result<VoiceInputResult, String> {
    macos_impl::start_voice_input().await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn start_recording() -> Result<(), String> {
    macos_impl::start_recording().await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn stop_recording() -> Result<VoiceInputResult, String> {
    macos_impl::stop_recording().await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn paste_text(text: String) -> Result<(), String> {
    macos_impl::paste_text(text).await
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn detect_voice_support() -> VoiceSupportInfo {
    VoiceSupportInfo {
        supported: false,
        method: "not_available".into(),
        platform: std::env::consts::OS.into(),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn start_voice_input() -> Result<VoiceInputResult, String> {
    Err("Voice input not supported on this platform".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn start_recording() -> Result<(), String> {
    Err("Voice input not supported on this platform".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn stop_recording() -> Result<VoiceInputResult, String> {
    Err("Voice input not supported on this platform".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn paste_text(_text: String) -> Result<(), String> {
    Err("Paste not supported on this platform".into())
}
