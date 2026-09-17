//! 账号服务 2.0 客户端 (Rust)
//! 对应规格: docs/2.0-账号服务API规格.md; 签名: docs/2.0-账号服务认证协议设计.md §三
//!
//! ⚠️ body哈希基于实际发送字节: reqwest .json() 用 serde_json 紧凑序列化,
//!    签名时必须用同一字节串 — 本crate先序列化再发送, 保证一致。

use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Error, Debug)]
pub enum AccountError {
    #[error("HTTP {status}: {message}")]
    Api { status: u16, code: String, message: String },
    #[error("网络错误: {0}")]
    Network(String),
}

#[derive(Clone)]
pub struct AccountClient {
    pub http: Client,
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AccountInfo {
    pub account_id: String,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub silicon_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoginResponse {
    pub account_id: String,
    pub api_key: String,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub activated: bool,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub tunnel: Option<TunnelConfig>,
    #[serde(default)]
    pub silicon_id: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TunnelConfig {
    pub server: String,
    pub server_port: u16,
    pub uuid: String,
    #[serde(default)]
    pub flow: Option<String>,
    #[serde(rename = "server_name")]
    pub sni: String,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub short_id: Option<String>,
    #[serde(default)]
    pub route_domains: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatgptSession {
    pub access_token: String,
    pub expires: String,
    pub cookies: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ActivateResponse {
    pub plan: String,
    pub code_id: String,
    pub tunnel: Option<TunnelConfig>,
    #[serde(default)]
    pub activated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FetchPayload {
    #[serde(rename = "chatgpt_session")]
    pub chatgpt_session: ChatgptSession,
    pub tunnel_config: Option<TunnelConfig>,
    pub session_id: String,
    pub heartbeat_url: String,
    pub heartbeat_interval_sec: u32,
}

impl AccountClient {
    /// danger_accept_invalid_certs: 自签证书环境(VPS 8444)需true; 生产CA证书后false
    pub fn new(base_url: impl Into<String>, accept_self_signed: bool) -> Result<Self, AccountError> {
        let mut b = Client::builder()
            .user_agent("magic-chatgpt-app/2.0")
            .timeout(std::time::Duration::from_secs(15));
        if accept_self_signed {
            b = b.danger_accept_invalid_certs(true);
        }
        Ok(Self { http: b.build().map_err(|e| AccountError::Network(e.to_string()))?, base_url: base_url.into() })
    }

    fn parse_err(status: u16, body: &serde_json::Value) -> AccountError {
        AccountError::Api {
            status,
            code: body["error"].as_str().unwrap_or("ERR_UNKNOWN").into(),
            message: body["message"].as_str().unwrap_or("").into(),
        }
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self, path: &str, body: &serde_json::Value,
    ) -> Result<T, AccountError> {
        let _raw = serde_json::to_vec(body).map_err(|e| AccountError::Network(e.to_string()))?;
        let url = format!("{}{}", self.base_url, path);
        let r = self.http.post(&url).json(body).send().await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let v: serde_json::Value = r.json().await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(Self::parse_err(status, &v));
        }
        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(data).map_err(|e| AccountError::Network(format!("解析失败: {e}")))
    }

    /// GET /health
    pub async fn health(&self) -> Result<String, AccountError> {
        let r = self.http.get(format!("{}/health", self.base_url))
            .send().await.map_err(|e| AccountError::Network(e.to_string()))?;
        r.text().await.map_err(|e| AccountError::Network(e.to_string()))
    }

    /// POST /v1/code/validate → plan + tunnel (虾壳用, XK码)
    pub async fn activate_code(&self, code: &str, device_id: &str)
        -> Result<ActivateResponse, AccountError>
    {
        self.post_json("/v1/code/validate", &serde_json::json!({
            "code": code, "device_id": device_id, "product": "siliconmate",
        })).await
    }

    /// POST /v1/account/info → account_name/silicon_id (冷启动恢复用, 宽松鉴权)
    pub async fn get_account_info(&self, account_or_session_id: &str)
        -> Result<AccountInfo, AccountError>
    {
        self.post_json("/v1/account/info", &serde_json::json!({
            "account_id": account_or_session_id,
        })).await
    }

    /// POST /v1/auth/register → api_key (硅侣注册)
    pub async fn register(&self, account_name: &str, password: &str, device_id: &str)
        -> Result<LoginResponse, AccountError>
    {
        self.post_json("/v1/auth/register", &serde_json::json!({
            "account_name": account_name, "password": password, "device_id": device_id,
        })).await
    }

    /// POST /v1/account/activate → plan + tunnel (硅侣激活, HMAC签名)
    pub async fn account_activate(&self, api_key: &str, account_id: &str, code: &str)
        -> Result<ActivateResponse, AccountError>
    {
        let path = "/v1/account/activate";
        let payload = serde_json::json!({ "code": code, "product": "siliconmate" });
        let body = serde_json::to_vec(&payload).unwrap();
        let headers = Self::sign_headers(api_key, path, account_id, &body);
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.post(&url)
            .header("Content-Type", "application/json")
            .body(body);
        for (k, v) in headers { req = req.header(k, v); }
        let r = req.send().await.map_err(|e| AccountError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let v: serde_json::Value = r.json().await.map_err(|e| AccountError::Network(e.to_string()))?;
        if !(200..300).contains(&status) { return Err(Self::parse_err(status, &v)); }
        serde_json::from_value(v["data"].clone())
            .map_err(|e| AccountError::Network(format!("解析失败: {e}")))
    }

    /// POST /v1/auth/login → api_key
    pub async fn login(&self, account_name: &str, password: &str, device_id: &str)
        -> Result<LoginResponse, AccountError>
    {
        self.post_json("/v1/auth/login", &serde_json::json!({
            "account_name": account_name, "password": password, "device_id": device_id,
        })).await
    }

    /// HMAC签名头 (A1§三): sig=HMAC(api_key, "POST|path|account_id|ts|sha256(raw_body)")
    pub fn sign_headers(api_key: &str, path: &str, account_id: &str, raw_body: &[u8])
        -> [(&'static str, String); 4]
    {
        let ts = chrono_ts_now();
        let bsha_hex = hex_encode(&Sha256::digest(raw_body));
        let sig_input = format!("POST|{path}|{account_id}|{ts}|{bsha_hex}");
        let mut mac = HmacSha256::new_from_slice(api_key.as_bytes()).expect("hmac key");
        mac.update(sig_input.as_bytes());
        let sig = hex_encode(&mac.finalize().into_bytes());
        [
            ("X-API-Key", api_key.to_string()),
            ("X-Account-Id", account_id.to_string()),
            ("X-Sign-Timestamp", ts),
            ("X-Signature", sig),
        ]
    }

    /// POST /v1/admin/account (管理面, master_key)
    pub async fn admin_create_account(&self, master_key: &str, name: &str, password: &str)
        -> Result<serde_json::Value, AccountError>
    {
        let r = self.http.post(format!("{}/v1/admin/account", self.base_url))
            .header("x-master-key", master_key)
            .json(&serde_json::json!({"action":"create","account_name":name,"password":password}))
            .send().await.map_err(|e| AccountError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let v: serde_json::Value = r.json().await.map_err(|e| AccountError::Network(e.to_string()))?;
        if !(200..300).contains(&status) { return Err(Self::parse_err(status, &v)); }
        Ok(v["data"].clone())
    }

    /// POST /v1/session/fetch — 一次握手全下发; tunnel_config二次为None(用后即焚)
    pub async fn fetch_session(&self, api_key: &str, account_id: &str)
        -> Result<FetchPayload, AccountError>
    {
        let path = "/v1/session/fetch";
        let body = serde_json::to_vec(&serde_json::json!({})).unwrap();
        let headers = Self::sign_headers(api_key, path, account_id, &body);
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.post(&url)
            .header("Content-Type", "application/json")
            .body(body.clone());
        for (k, v) in headers { req = req.header(k, v); }
        let r = req.send().await.map_err(|e| AccountError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let v: serde_json::Value = r.json().await.map_err(|e| AccountError::Network(e.to_string()))?;
        if !(200..300).contains(&status) { return Err(Self::parse_err(status, &v)); }
        serde_json::from_value(v["data"].clone())
            .map_err(|e| AccountError::Network(format!("解析失败: {e}")))
    }

    /// POST /v1/session/heartbeat → "alive"|"stale"|...
    pub async fn heartbeat(&self, api_key: &str, account_id: &str, session_id: &str)
        -> Result<String, AccountError>
    {
        let path = "/v1/session/heartbeat";
        let payload = serde_json::json!({ "session_id": session_id });
        let body = serde_json::to_vec(&payload).unwrap();
        let headers = Self::sign_headers(api_key, path, account_id, &body);
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.post(&url).header("Content-Type", "application/json").body(body);
        for (k, v) in headers { req = req.header(k, v); }
        let r = req.send().await.map_err(|e| AccountError::Network(e.to_string()))?;
        let status = r.status().as_u16();
        let v: serde_json::Value = r.json().await.map_err(|e| AccountError::Network(e.to_string()))?;
        if !(200..300).contains(&status) { return Err(Self::parse_err(status, &v)); }
        Ok(v["data"]["status"].as_str().unwrap_or("unknown").to_string())
    }
}

/// ISO-8601 UTC时间戳(±60s窗口内即可, 秒精度足够)
fn chrono_ts_now() -> String {
    // 无chrono依赖: unix秒转UTC日期(简化实现, 2100年前正确)
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days (Howard Hinnant算法)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}+00:00")
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sign_headers_deterministic() {
        let h = AccountClient::sign_headers("sk_test", "/v1/session/fetch", "acc_1", b"{}");
        assert_eq!(h[0].0, "X-API-Key");
        assert_eq!(h[1].1, "acc_1");
        assert_eq!(h[3].1.len(), 64); // sha256 hex
    }

    #[test]
    fn test_ts_format() {
        let ts = chrono_ts_now();
        assert!(ts.ends_with("+00:00"));
        assert_eq!(ts.len(), 25);
    }
}
