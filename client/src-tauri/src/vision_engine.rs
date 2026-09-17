//! vision_engine.rs — 视觉引擎配置 + 本地模型下载管理 (v4.2.0)
//!
//! 架构决策（用户定调）：
//! - 各平台用最优化方案不统一：macOS OCR = Apple Vision 系统自带保留；
//! - OCR 引擎三模式：auto（macOS=Vision优先/其他平台=paddle）/ local（强制本地模型）/ api（用户填URL+key）；
//! - AI 视觉感知（perceive/找图标）= API 方案，不本地跑 YOLO（Win/Linux 性能弱）；
//! - 公有仓版不带模型 + 留「下载模型」入口；私有版可预置。
//!
//! 模型下载逻辑移植自 nuphus bootstrap.rs（Apache 2.0）：
//! - hf-mirror.com 优先 → huggingface.co 兜底；OCR 字典 gitee 优先 → github 兜底；
//! - 反投毒 min_size：低于阈值的文件视为错误页重新下载；
//! - 文件粒度断点续传（已存在且达标即跳过）；
//! - YOLO(icon_detect) 可选：失败降级为 OCR-only，不算终端错误。

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 下载镜像优先级（国内镜像优先）
const MIRRORS: &[&str] = &["https://hf-mirror.com", "https://huggingface.co"];

/// 全局单例：同一时刻只允许一个下载任务
static DOWNLOAD_RUNNING: AtomicBool = AtomicBool::new(false);

// ── 配置持久化 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisionEngineConfig {
    /// OCR 引擎: "auto" | "local" | "api"
    pub ocr_engine: String,
    /// API 模式: OpenAI 兼容 base URL（如 https://api.xxx.com/v1）
    pub api_url: String,
    /// API 模式: 密钥
    pub api_key: String,
    /// API 模式: 视觉模型名（如 gpt-4o-mini / qwen-vl-plus）
    pub api_model: String,
}

impl VisionEngineConfig {
    pub fn normalized(&self) -> Self {
        let mut c = self.clone();
        if c.ocr_engine.is_empty() {
            c.ocr_engine = "auto".into();
        }
        c
    }

    pub fn api_ready(&self) -> bool {
        !self.api_url.is_empty() && !self.api_key.is_empty() && !self.api_model.is_empty()
    }
}

/// 跨平台应用数据目录（Windows CI 即将加入，不用硬编码 macOS 路径）
pub fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join("Library/Application Support/SiliconMate"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        Some(PathBuf::from(appdata).join("SiliconMate"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".config/SiliconMate"))
    }
}

fn config_file_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("vision_engine.json"))
}

/// 读取配置（无文件 = 默认 auto）
pub fn load_config() -> VisionEngineConfig {
    let Some(path) = config_file_path() else {
        return VisionEngineConfig::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|j| serde_json::from_str::<VisionEngineConfig>(&j).ok())
        .unwrap_or_default()
        .normalized()
}

/// 原子写配置
fn save_config(cfg: &VisionEngineConfig) -> Result<(), String> {
    let path = config_file_path().ok_or("no app data dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

// ── 模型清单（与 nuphus bootstrap.rs / paddle_ocr.rs 读取路径保持一致）────

struct ModelFile {
    name: &'static str,
    urls: Vec<String>,
    /// 反投毒下限 — 低于此值视为错误页
    min_size: u64,
    /// true = OCR 必需（失败=终端错误）；false = YOLO 可选（失败降级）
    required: bool,
}

fn vision_files() -> Vec<ModelFile> {
    let hf = |repo: &str, file: &str| -> Vec<String> {
        MIRRORS
            .iter()
            .map(|m| format!("{}/{}/resolve/main/{}", m, repo, file))
            .collect()
    };
    vec![
        ModelFile {
            name: "ch_PP-OCRv4_det.onnx",
            urls: hf("SWHL/RapidOCR", "PP-OCRv4/ch_PP-OCRv4_det_infer.onnx"),
            min_size: 2 * 1024 * 1024, // 实际 ~4.7 MB
            required: true,
        },
        ModelFile {
            name: "ch_PP-OCRv4_rec.onnx",
            urls: hf("SWHL/RapidOCR", "PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx"),
            min_size: 4 * 1024 * 1024, // 实际 ~10.8 MB
            required: true,
        },
        ModelFile {
            name: "ch_PP-OCR_keys_v1.txt",
            urls: vec![
                "https://gitee.com/paddlepaddle/PaddleOCR/raw/main/ppocr/utils/ppocr_keys_v1.txt".into(),
                "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt".into(),
            ],
            min_size: 1024, // 实际 ~26 KB
            required: true,
        },
        ModelFile {
            name: "icon_detect.onnx",
            urls: hf("onnx-community/OmniParser-icon_detect_640x640", "onnx/model.onnx"),
            min_size: 1024 * 1024, // 实际 ~12.2 MB
            required: false,
        },
    ]
}

/// 模型写入目录：NUPHUS_MODELS_DIR 环境变量 > 用户数据目录（与 nuphus 读取路径一致）
fn models_dir_for_write() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("NUPHUS_MODELS_DIR") {
        let p = PathBuf::from(&dir);
        std::fs::create_dir_all(&p).map_err(|e| format!("创建模型目录失败 {}: {}", p.display(), e))?;
        return Ok(p);
    }
    let base = app_data_dir().ok_or("无法定位用户数据目录")?;
    let p = base.join("Nuphus").join("models");
    std::fs::create_dir_all(&p).map_err(|e| format!("创建模型目录失败 {}: {}", p.display(), e))?;
    Ok(p)
}

fn models_dir_hint() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("NUPHUS_MODELS_DIR") {
        return Some(PathBuf::from(dir));
    }
    app_data_dir().map(|d| d.join("Nuphus").join("models"))
}

fn file_present(dir: &PathBuf, name: &str) -> bool {
    let files = vision_files();
    let Some(mf) = files.iter().find(|f| f.name == name) else {
        return dir.join(name).exists();
    };
    std::fs::metadata(dir.join(name))
        .map(|m| m.len() >= mf.min_size)
        .unwrap_or(false)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelsStatus {
    pub ocr_ready: bool,
    pub yolo_ready: bool,
    pub missing: Vec<String>,
    pub dir: Option<String>,
    pub downloading: bool,
}

fn scan_models() -> ModelsStatus {
    let dir = models_dir_hint();
    let present = |name: &str| dir.as_ref().map(|d| file_present(d, name)).unwrap_or(false);
    ModelsStatus {
        ocr_ready: vision_files().iter().filter(|f| f.required).all(|f| present(f.name)),
        yolo_ready: present("icon_detect.onnx"),
        missing: dir
            .as_ref()
            .map(|d| {
                vision_files()
                    .iter()
                    .filter(|f| !file_present(d, f.name))
                    .map(|f| f.name.to_string())
                    .collect()
            })
            .unwrap_or_default(),
        dir: dir.map(|d| d.display().to_string()),
        downloading: DOWNLOAD_RUNNING.load(Ordering::SeqCst),
    }
}

// ── 事件 ────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
enum VisionEvent {
    #[serde(rename = "progress")]
    Progress { file: String, downloaded: u64, total: u64, index: usize, count: usize },
    #[serde(rename = "done")]
    Done { ocr_ready: bool, yolo_ready: bool },
    #[serde(rename = "error")]
    Error { message: String },
}

fn emit(app: &AppHandle, ev: VisionEvent) {
    let _ = app.emit("vision:download", ev);
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────

/// 视觉引擎全景状态（配置 + 模型文件扫描，纯本地无网络）
#[tauri::command]
pub fn vision_engine_status() -> serde_json::Value {
    let cfg = load_config();
    let models = scan_models();
    serde_json::json!({
        "config": {
            "ocrEngine": cfg.ocr_engine,
            "apiConfigured": cfg.api_ready(),
            "apiUrl": cfg.api_url,
            "apiModel": cfg.api_model,
        },
        "models": models,
    })
}

/// 保存视觉引擎配置（前端设置页调用）
#[tauri::command]
pub fn vision_engine_set(
    ocr_engine: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut cfg = load_config();
    if let Some(v) = ocr_engine {
        let v = v.trim().to_lowercase();
        if !["auto", "local", "api"].contains(&v.as_str()) {
            return Err(format!("无效引擎类型: {}（可选 auto/local/api）", v));
        }
        cfg.ocr_engine = v;
    }
    if let Some(v) = api_url { cfg.api_url = v.trim().to_string(); }
    // Key 写入语义：Some("") = 保留原值（前端留空=不修改）
    if let Some(v) = api_key {
        if !v.trim().is_empty() { cfg.api_key = v.trim().to_string(); }
    }
    if let Some(v) = api_model { cfg.api_model = v.trim().to_string(); }
    // api 模式必须三项齐全
    if cfg.ocr_engine == "api" && !cfg.api_ready() {
        return Err("API 模式需要完整填写 URL、Key 和模型名".into());
    }
    save_config(&cfg)?;
    eprintln!("[vision] 引擎配置已保存: ocr={}", cfg.ocr_engine);
    Ok(serde_json::json!({ "ok": true, "ocrEngine": cfg.ocr_engine }))
}

/// 触发模型下载（异步任务，进度走 vision:download 事件）
#[tauri::command]
pub async fn vision_models_download(app: AppHandle) -> Result<serde_json::Value, String> {
    if DOWNLOAD_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("下载已在进行中".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_download_with(&mut |ev| emit(&app, ev));
        DOWNLOAD_RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(_) => {
                let s = scan_models();
                emit(&app, VisionEvent::Done { ocr_ready: s.ocr_ready, yolo_ready: s.yolo_ready });
            }
            Err(e) => {
                eprintln!("[vision] 模型下载失败: {}", e);
                emit(&app, VisionEvent::Error { message: e });
            }
        }
    });
    Ok(serde_json::json!({ "ok": true }))
}

// ── 下载实现（移植自 nuphus bootstrap.rs）───────────────────────────────

fn download_once(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &std::path::Path,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<u64, String> {
    let mut resp = client.get(url).send().map_err(|e| format!("请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut downloaded = 0u64;
    loop {
        let n = resp.read(&mut buf).map_err(|e| format!("读取数据失败: {}", e))?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += n as u64;
        on_progress(downloaded, total);
    }
    Ok(downloaded)
}

fn run_download_with(emit_fn: &mut dyn FnMut(VisionEvent)) -> Result<(), String> {
    let dir = models_dir_for_write()?;
    eprintln!("[vision] 模型下载目标目录: {}", dir.display());

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let files = vision_files();
    let count = files.len();

    for (idx, mf) in files.iter().enumerate() {
        let path = dir.join(mf.name);
        let index = idx + 1;

        // 断点续传：已存在且达标即跳过
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= mf.min_size {
                eprintln!("[vision] 跳过已存在: {} ({} bytes)", mf.name, meta.len());
                emit_fn(VisionEvent::Progress {
                    file: mf.name.to_string(),
                    downloaded: meta.len(),
                    total: meta.len(),
                    index,
                    count,
                });
                continue;
            }
            eprintln!("[vision] {} 体积异常 ({} < {}), 重新下载", mf.name, meta.len(), mf.min_size);
        }

        // 镜像逐一尝试
        let mut last_err = String::new();
        let mut ok = false;
        for url in &mf.urls {
            let mut last_emitted = 0u64;
            match download_once(&client, url, &path, &mut |downloaded, total| {
                // 节流：~1MB 一个事件
                if downloaded - last_emitted >= 1024 * 1024 || downloaded == total {
                    last_emitted = downloaded;
                    emit_fn(VisionEvent::Progress {
                        file: mf.name.to_string(),
                        downloaded,
                        total,
                        index,
                        count,
                    });
                }
            }) {
                Ok(n) if n >= mf.min_size => {
                    eprintln!("[vision] 下载完成: {} ({} bytes) ← {}", mf.name, n, url);
                    ok = true;
                    break;
                }
                Ok(n) => {
                    let e = format!("体积异常 {} < {}", n, mf.min_size);
                    eprintln!("[vision] {} {} via {}", mf.name, e, url);
                    last_err = e;
                    let _ = std::fs::remove_file(&path);
                }
                Err(e) => {
                    eprintln!("[vision] {} 失败 via {}: {}", mf.name, url, e);
                    last_err = e;
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        if !ok {
            if mf.required {
                return Err(format!("必需模型 {} 下载失败: {}", mf.name, last_err));
            }
            eprintln!("[vision] 可选模型 {} 下载失败（降级为 OCR-only）: {}", mf.name, last_err);
        }
    }
    Ok(())
}

// ── OCR 路由（供 nuphus_bridge 调用）────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum OcrRoute {
    /// 系统自带：macOS=Apple Vision
    System,
    /// 本地 PaddleOCR 模型
    LocalPaddle,
    /// 用户配置的 API
    Api,
}

/// 根据配置+平台解析 OCR 路由
pub fn resolve_ocr_route() -> OcrRoute {
    let cfg = load_config();
    match cfg.ocr_engine.as_str() {
        "local" => OcrRoute::LocalPaddle,
        "api" if cfg.api_ready() => OcrRoute::Api,
        // auto：macOS 优先系统 Vision（免费+快），其他平台本地模型
        _ => {
            #[cfg(target_os = "macos")]
            { OcrRoute::System }
            #[cfg(not(target_os = "macos"))]
            { OcrRoute::LocalPaddle }
        }
    }
}

/// API OCR：OpenAI 兼容 vision 端点，图片转 base64 data URI 发送
pub async fn ocr_via_api(image_path: &str) -> Result<String, String> {
    let cfg = load_config();
    if !cfg.api_ready() {
        return Err("视觉 API 未配置（需 URL/Key/模型名）".into());
    }
    let bytes = std::fs::read(image_path).map_err(|e| format!("读取图片失败: {}", e))?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let url = format!("{}/chat/completions", cfg.api_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": cfg.api_model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": "提取图片中的全部文字，按原布局逐行输出，不要解释。" },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", b64) } }
            ]
        }]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应: {}", e))?;
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "响应中无文本".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 配置持久化往返：写入→读取→字段一致；Key留空=保留原值
    /// 先备份用户现有配置，测试后恢复（对运行中App无污染）
    #[test]
    fn test_config_roundtrip_and_key_keep() {
        let backup = std::fs::read_to_string(config_file_path().unwrap_or_default()).ok();
        // 安全网：断言失败也恢复
        struct Guard(Option<String>);
        impl Drop for Guard {
            fn drop(&mut self) {
                let Some(path) = config_file_path() else { return };
                match &self.0 {
                    Some(json) => { let _ = std::fs::write(path, json); }
                    None => { let _ = std::fs::remove_file(path); }
                }
            }
        }
        let _guard = Guard(backup);

        let mut cfg = VisionEngineConfig {
            ocr_engine: "api".into(),
            api_url: "https://api.example.com/v1".into(),
            api_key: "sk-test".into(),
            api_model: "qwen-vl-plus".into(),
        };
        assert!(save_config(&cfg).is_ok());
        let loaded = load_config();
        assert_eq!(loaded.ocr_engine, "api");
        assert_eq!(loaded.api_url, "https://api.example.com/v1");
        assert_eq!(loaded.api_key, "sk-test");
        assert_eq!(loaded.api_model, "qwen-vl-plus");
        assert!(loaded.api_ready());

        // Key 留空 = 保留（语义在 vision_engine_set 命令层）
        let r = vision_engine_set(None, None, Some(String::new()), None);
        assert!(r.is_ok());
        let loaded2 = load_config();
        assert_eq!(loaded2.api_key, "sk-test", "空key必须保留原值");
        assert_eq!(loaded2.ocr_engine, "api");
    }

    /// 无效引擎名被拒绝
    #[test]
    fn test_invalid_engine_rejected() {
        let r = vision_engine_set(Some("turbo".into()), None, None, None);
        assert!(r.is_err());
    }

    /// 真实链路：下载最小模型（OCR字典 ~26KB）到临时目录，验证镜像+落盘+反投毒
    /// 使用 NUPHUS_MODELS_DIR 环境变量隔离，不污染用户数据目录
    #[test]
    fn test_download_dict_model_real() {
        let tmp = std::env::temp_dir().join(format!("siliconmate-vision-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 安全网：测试结束清理（即使断言失败）
        struct Guard(PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _guard = Guard(tmp.clone());
        std::env::set_var("NUPHUS_MODELS_DIR", &tmp);

        // 预置其余3个文件为达标假件（只真实下载26KB字典，避免测试拖满28MB）
        for name in ["ch_PP-OCRv4_det.onnx", "ch_PP-OCRv4_rec.onnx", "icon_detect.onnx"] {
            std::fs::write(tmp.join(name), vec![0u8; 5 * 1024 * 1024]).unwrap();
        }

        let mut events = 0usize;
        let r = run_download_with(&mut |_ev| events += 1);
        assert!(r.is_ok(), "下载失败: {:?}", r.err());
        assert!(events > 0, "必须有进度事件");

        let dict = std::fs::metadata(tmp.join("ch_PP-OCR_keys_v1.txt")).expect("字典必须落盘");
        assert!(dict.len() >= 1024, "字典体积异常: {}", dict.len());

        // 状态扫描：NUPHUS_MODELS_DIR 生效 → ocr_ready + yolo_ready
        let s = scan_models();
        assert!(s.ocr_ready, "OCR三件套应就绪");
        assert!(s.yolo_ready, "YOLO假件应达标");

        std::env::remove_var("NUPHUS_MODELS_DIR");
    }
}
