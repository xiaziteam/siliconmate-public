//! 硅侣3.0 — 隧道管理 (统一daemon模式)
//!
//! 不再自己spawn sing-box，改为探测统一隧道daemon是否就绪
//! daemon由launchd管理，监听多端口: 18081(虾壳) 18082(硅侣) 18083(闲鱼) 18080(HTTP) 18085(PAC)
//!
//! 流程: login → probe_daemon → 设系统PAC(http://127.0.0.1:18085/proxy.pac) → Safari/浏览器

use account_client::TunnelConfig;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const SILICONMATE_PORT: u16 = 18082;
pub const DAEMON_PAC_URL: &str = "http://127.0.0.1:18085/proxy.pac";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TunnelStatus {
    Stopped,
    Running { port: u16 },
    Error(String),
}

pub struct TunnelManager {
    pub process: Mutex<Option<std::process::Child>>, // 保留接口兼容，不再使用
    pub status: Mutex<TunnelStatus>,
    config_path: Mutex<Option<String>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            status: Mutex::new(TunnelStatus::Stopped),
            config_path: Mutex::new(None),
        }
    }

    pub fn get_proxy_url_if_running(&self) -> Option<String> {
        let st = self.status.lock().unwrap();
        match &*st {
            TunnelStatus::Running { port } => Some(format!("socks5://127.0.0.1:{}", port)),
            _ => None,
        }
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Probe统一daemon端口是否就绪(不再自己spawn sing-box)
pub fn start_tunnel_internal(
    manager: &TunnelManager,
    _config: TunnelConfig, // 保留参数兼容，实际由daemon管理
) -> Result<u16, String> {
    let mut status = manager.status.lock().unwrap();

    if matches!(&*status, TunnelStatus::Running { .. }) {
        return Ok(SILICONMATE_PORT);
    }

    // 探测daemon SOCKS5端口
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", SILICONMATE_PORT).parse().unwrap();
    match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3)) {
        Ok(_) => {
            eprintln!("[tunnel] Daemon SOCKS5 on :{} is ready", SILICONMATE_PORT);
            *status = TunnelStatus::Running { port: SILICONMATE_PORT };
            Ok(SILICONMATE_PORT)
        }
        Err(e) => {
            let msg = format!(
                "隧道daemon未运行(端口:{}无法连接)。请先启动: launchctl load ~/Library/LaunchAgents/com.shrimp.tunnel.plist (错误: {})",
                SILICONMATE_PORT, e
            );
            eprintln!("[tunnel] {}", msg);
            *status = TunnelStatus::Error(msg.clone());
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn start_tunnel(
    manager: tauri::State<'_, TunnelManager>,
    config: TunnelConfig,
) -> Result<String, String> {
    // 先取名单（config 稍后 move 进探测函数）
    #[cfg(target_os = "macos")]
    let route_domains = config.route_domains.clone().unwrap_or_default();

    let port = start_tunnel_internal(&manager, config)?;

    // daemon 就绪后再刷新 PAC 内容（客户机无 daemon 会在上面提前 Err，不白写文件）
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = write_pac_file(&route_domains) {
            eprintln!("[tunnel] PAC refresh failed (keep existing): {}", e);
        }
    }

    // 设系统PAC代理(指向daemon的HTTP PAC serve)
    set_system_proxy_for_chatgpt(true, port);

    Ok(format!("隧道已就绪, SOCKS5代理: 127.0.0.1:{}", port))
}

#[tauri::command]
pub fn stop_tunnel(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<(), String> {
    let mut status = manager.status.lock().unwrap();

    // 不再kill sing-box(daemon是独立进程)
    // 只清理系统代理设置
    set_system_proxy_for_chatgpt(false, SILICONMATE_PORT);
    *status = TunnelStatus::Stopped;

    eprintln!("[tunnel] Proxy disabled (daemon keeps running)");
    Ok(())
}

#[tauri::command]
pub fn tunnel_status(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<TunnelStatus, String> {
    Ok(manager.status.lock().unwrap().clone())
}

#[tauri::command]
pub fn get_proxy_url(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<Option<String>, String> {
    let status = manager.status.lock().unwrap();
    match &*status {
        TunnelStatus::Running { port } => {
            Ok(Some(format!("socks5://127.0.0.1:{}", port)))
        }
        _ => Ok(None),
    }
}

// ============================================================================
// 系统代理接管 — 成型版（接管留痕 + 退场必恢复 + 崩溃自愈）
//
// 产品铁律：
// 1. 硅侣活着 → 给用户完全无限制的网络（系统 PAC 指向 daemon 隧道）
// 2. 硅侣退场（正常退出/崩溃/强杀/激活失效后的退出）→ 用户网络恢复原样
// 3. 绝不碰用户手动 SOCKS 设置（那是用户自己的能力，硅侣只动 PAC）
// 4. 永不清理 127.0.0.1:18085 本身 — 该端口由虾群 pac-server (com.shrimp.pac-server)
//    占用，是本机全局 PAC 基础设施，硅侣只复用不抢夺
//
// 机制：接管前把每个 network service 的 PAC 原值持久化到
// ~/Library/Application Support/SiliconMate/proxy_takeover.json（原子写），
// 释放时读盘恢复并删文件；文件存在 = 上次未正常释放，启动时自愈。
// ============================================================================

#[cfg(target_os = "macos")]
fn get_all_network_services() -> Vec<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .skip(1) // 第一行是标题
                .filter(|l| !l.starts_with('*') && !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .collect()
        }
        _ => vec!["Wi-Fi".into()],
    }
}

#[cfg(not(target_os = "macos"))]
fn get_all_network_services() -> Vec<String> {
    vec![]
}

/// 读取某个 network service 的自动代理(PAC)状态：(URL, Enabled)
#[cfg(target_os = "macos")]
fn get_auto_proxy_state(service: &str) -> (Option<String>, bool) {
    let output = std::process::Command::new("networksetup")
        .args(["-getautoproxyurl", service])
        .output();
    let text = match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return (None, false),
    };
    let mut url = None;
    let mut enabled = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("URL:") {
            let u = rest.trim();
            if !u.is_empty() && u != "(null)" {
                url = Some(u.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("Enabled:") {
            enabled = rest.trim() == "Yes";
        }
    }
    (url, enabled)
}

// ── 接管记录持久化 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServiceProxyBackup {
    service: String,
    /// 原自动代理 URL（None = 原本未设置）
    auto_proxy_url: Option<String>,
    auto_proxy_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProxyTakeoverRecord {
    /// "siliconmate" — 为多 App（虾壳/闲鱼）共存做引用协调预留
    app: String,
    taken_over: bool,
    pid: u32,
    ts: u64,
    services: Vec<ServiceProxyBackup>,
}

#[cfg(target_os = "macos")]
fn takeover_file_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/Application Support/SiliconMate/proxy_takeover.json"),
    )
}

#[cfg(target_os = "macos")]
fn write_takeover_record(record: &ProxyTakeoverRecord) -> Result<(), String> {
    let path = takeover_file_path().ok_or("no HOME")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    // 原子写：先写 .tmp 再 rename
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_takeover_record() -> Option<ProxyTakeoverRecord> {
    let path = takeover_file_path()?;
    let json = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(target_os = "macos")]
fn delete_takeover_record() {
    if let Some(path) = takeover_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// 按备份恢复某个 service 的 PAC
#[cfg(target_os = "macos")]
fn restore_service_proxy(backup: &ServiceProxyBackup) {
    match &backup.auto_proxy_url {
        Some(url) => {
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxyurl", &backup.service, url])
                .output();
            let state = if backup.auto_proxy_enabled { "on" } else { "off" };
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxystate", &backup.service, state])
                .output();
        }
        None => {
            // 原本没有 PAC — 清掉
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxyurl", &backup.service, ""])
                .output();
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxystate", &backup.service, "off"])
                .output();
        }
    }
}

/// 接管系统代理：备份持久化 → 设 PAC 指向 daemon
/// 幂等：若上次接管未释放（残留文件），先自愈恢复再重新接管
pub fn proxy_take_over() {
    #[cfg(target_os = "macos")]
    {
        let services = get_all_network_services();
        if services.is_empty() {
            eprintln!("[proxy] No network services found, skip takeover");
            return;
        }

        // 自愈：残留的接管记录先恢复，保证备份基线干净
        if let Some(record) = read_takeover_record() {
            if record.taken_over {
                eprintln!("[proxy] Stale takeover record found (pid {}), self-healing restore first", record.pid);
                for backup in &record.services {
                    restore_service_proxy(backup);
                }
                delete_takeover_record();
            }
        }

        // 备份所有 service 的 PAC 原值
        let backups: Vec<ServiceProxyBackup> = services
            .iter()
            .map(|s| {
                let (url, enabled) = get_auto_proxy_state(s);
                ServiceProxyBackup {
                    service: s.clone(),
                    auto_proxy_url: url,
                    auto_proxy_enabled: enabled,
                }
            })
            .collect();

        let record = ProxyTakeoverRecord {
            app: "siliconmate".into(),
            taken_over: true,
            pid: std::process::id(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            services: backups,
        };
        if let Err(e) = write_takeover_record(&record) {
            eprintln!("[proxy] FAILED to persist takeover record: {} — abort takeover (safety first)", e);
            return; // 备份写盘失败就不接管 — 宁可不翻墙也不能丢用户配置
        }

        // 设 PAC 到所有 network service
        for service in &services {
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxyurl", service, DAEMON_PAC_URL])
                .output();
            let _ = std::process::Command::new("networksetup")
                .args(["-setautoproxystate", service, "on"])
                .output();
        }

        // 验证第一个 service
        let (url, enabled) = get_auto_proxy_state(&services[0]);
        if url.as_deref() != Some(DAEMON_PAC_URL) || !enabled {
            eprintln!(
                "[proxy] WARNING: PAC takeover verification failed: url={:?} enabled={}",
                url, enabled
            );
        } else {
            eprintln!(
                "[proxy] PAC takeover OK on {} services (URL: {}), backup persisted",
                services.len(),
                DAEMON_PAC_URL
            );
        }
    }
}

/// 释放系统代理：读盘恢复原值 → 删记录文件
/// 幂等：没有接管记录 = 没接管过，直接返回（绝不无脑清理系统 PAC）
pub fn proxy_release() {
    #[cfg(target_os = "macos")]
    {
        let record = match read_takeover_record() {
            Some(r) if r.taken_over => r,
            _ => {
                eprintln!("[proxy] No takeover record — nothing to release");
                return;
            }
        };

        for backup in &record.services {
            restore_service_proxy(backup);
        }
        delete_takeover_record();
        eprintln!(
            "[proxy] Proxy released, {} services restored to pre-takeover state",
            record.services.len()
        );
    }
}

/// 启动时崩溃自愈：
/// 1. 接管记录残留（上次异常退出）→ 恢复原值
///    仅当当前 PAC 仍指向 daemon 时才动系统（若用户已手动改过，尊重现状只删记录）
/// 2. 历史版本残留兜底：URL 含 siliconmate-tunnel/shrimp-tunnel 的 PAC 清掉
/// 3. 永不清理 127.0.0.1:18085 — pac-server 的全局 PAC，硅侣只借用不占有
pub fn cleanup_leftover_proxy() {
    #[cfg(target_os = "macos")]
    {
        // 1. 接管记录自愈
        if let Some(record) = read_takeover_record() {
            if record.taken_over {
                // 任一 service 的 PAC 仍指向 daemon = 还在我们手里 → 恢复；
                // 全都不是 = 用户已手动改过 → 尊重现状只删记录
                let still_ours = get_all_network_services().iter().any(|s| {
                    get_auto_proxy_state(s).0.as_deref() == Some(DAEMON_PAC_URL)
                });
                if still_ours {
                    eprintln!("[proxy] Crash recovery: restoring {} services from takeover record (pid {})", record.services.len(), record.pid);
                    for backup in &record.services {
                        restore_service_proxy(backup);
                    }
                } else {
                    eprintln!("[proxy] Crash recovery: PAC changed by user since crash, keep current setting");
                }
                delete_takeover_record();
            }
        }

        // 2. 历史版本残留兜底（旧版无持久化时留下的 PAC）
        for service in get_all_network_services() {
            if let Some(url) = get_auto_proxy_state(&service).0 {
                if url.contains("siliconmate-tunnel") || url.contains("shrimp-tunnel") {
                    eprintln!("[proxy] Cleaning legacy PAC on {}: {}", service, url);
                    let _ = std::process::Command::new("networksetup")
                        .args(["-setautoproxyurl", &service, ""])
                        .output();
                    let _ = std::process::Command::new("networksetup")
                        .args(["-setautoproxystate", &service, "off"])
                        .output();
                }
            }
        }
        // 注意：这里绝不清理 127.0.0.1:18085/proxy.pac — 它是 pac-server 的全局 PAC
    }
}

// ============================================================================
// PAC 生成 — 「锦上添花」策略 v3（2026-09-19 v4.4.3）
//
// 产品铁律（麦克 2026-09-19）：绝不破坏任何网络环境。
// 默认直连，只有明确需要梯子的域名才走代理；兜底 = DIRECT。
//
// 名单来源三端统一：服务端 tunnel_configs.route_domains 下发（Android 同源）。
// 内置底座 + 服务端增量合并去重；国内直连清单/中国IP段内置于模板。
// 写入 ~/Users/apple/.pac/proxy.pac（虾群 pac-server :18085 静态服务）。
// 原子写：生成失败绝不覆盖现有 PAC。
// ============================================================================

/// 内置被墙域名底座（服务端名单增量合并，去重）
#[cfg(target_os = "macos")]
const PAC_GFW_BASE: &[&str] = &[
    // Google 系
    "google.com", "googleapis.com", "gstatic.com", "googlevideo.com",
    "ggpht.com", "googleusercontent.com", "google.com.hk", "googlemail.com",
    "youtube.com", "ytimg.com", "youtu.be",
    // AI 系
    "openai.com", "chatgpt.com", "chat.com", "oaistatic.com", "oaiusercontent.com",
    "anthropic.com", "claude.ai", "perplexity.ai",
    // 社交系
    "twitter.com", "x.com", "twimg.com", "t.co",
    "facebook.com", "fbcdn.net", "fbsbx.com", "messenger.com", "whatsapp.com", "meta.com",
    "instagram.com", "cdninstagram.com",
    "telegram.org", "t.me",
    "discord.com", "discordapp.com", "discordapp.net", "discord.gg",
    "reddit.com", "redd.it", "redditmedia.com",
    "medium.com", "quora.com",
    // 知识/参考系
    "wikipedia.org", "wikimedia.org", "wiktionary.org", "wikiquote.org",
    // 流媒体系
    "netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com",
    "disneyplus.com", "spotify.com", "scdn.co", "twitch.tv", "ttvnw.net",
    // 开发者系
    "docker.io", "gcr.io", "huggingface.co", "v2ex.com", "steamcommunity.com",
    "github.com", "githubusercontent.com", "githubassets.com",
    // 其他
    "pixiv.net", "pximg.net", "line.me", "naver.com", "blogspot.com",
    "blogger.com", "appspot.com", "workers.dev", "notion.so", "notion.site",
];

/// 内置国内直连清单（跳过 DNS，快速直连）
#[cfg(target_os = "macos")]
const PAC_CN_DOMAINS: &[&str] = &[
    "taobao.com", "tmall.com", "alipay.com", "alibaba.com", "alicdn.com",
    "aliyun.com", "goofish.com", "tb.cn", "1688.com",
    "jd.com", "360buyimg.com", "jkcsjd.com",
    "qq.com", "wechat.com", "qpic.cn", "qlogo.cn", "gtimg.cn",
    "baidu.com", "bdstatic.com", "bdimg.com", "bcebos.com",
    "bilibili.com", "hdslb.com", "acgvideo.com",
    "zhihu.com", "zhimg.com",
    "douyin.com", "douyinpic.com", "douyincdn.com", "douyinstatic.com",
    "kuaishou.com", "ksapisrv.com", "ks-cdn.com", "yxixy.com",
    "xiaohongshu.com", "xhscdn.com",
    "sina.com.cn", "weibo.com", "wbimg.cn", "miaopai.com",
    "163.com", "netease.com", "126.com", "ydstatic.com", "youdao.com",
    "meituan.com", "dianping.com", "meituan.net", "ele.me",
    "ctrip.com", "qunar.com", "trip.com",
    "mi.com", "xiaomi.com", "miui.com", "vmall.com",
    "huawei.com", "hicloud.com",
    "huaweicloud.com", "myhuaweicloud.com", "hc-cdn.com", "hc-cdn.cn",
    "pinduoduo.com", "yangkeduo.com", "pddpic.com",
    "suning.com", "gome.com.cn", "vip.com",
    "iqiyi.com", "youku.com", "mgtv.com", "letv.com",
    "ifeng.com", "sohu.com", "sogou.com", "360.cn", "haosou.com",
    "csdn.net", "cnblogs.com", "jianshu.com", "oschina.net", "gitee.com",
    "coolapk.com", "sspaq.com",
];

/// 中国 IP 段（APNIC 主干 /8 近似；误判方向安全=多直连，绝不误送梯子）
#[cfg(target_os = "macos")]
const PAC_CN_IP_PREFIXES: &[&str] = &[
    "1.", "14.", "27.", "36.", "39.", "42.", "47.", "58.", "59.", "60.",
    "61.", "101.", "106.", "110.", "111.", "112.", "113.", "114.", "115.",
    "116.", "117.", "118.", "119.", "120.", "121.", "122.", "123.", "124.",
    "125.", "139.", "180.", "182.", "183.", "202.", "203.", "210.", "211.",
    "218.", "219.", "220.", "221.", "222.", "223.",
];

/// 由服务端名单 + 内置底座生成 PAC（兜底 DIRECT，绝不破坏网络环境）
#[cfg(target_os = "macos")]
pub fn generate_pac(route_domains: &[String]) -> String {
    // 合并去重：服务端名单优先，内置底座补漏
    let mut gfw: Vec<String> = route_domains.to_vec();
    for d in PAC_GFW_BASE {
        let d = d.to_string();
        if !gfw.contains(&d) {
            gfw.push(d);
        }
    }
    let gfw_js = gfw
        .iter()
        .map(|d| format!("\"{}\"", d.replace('"', "")))
        .collect::<Vec<_>>()
        .join(",");
    let cn_js = PAC_CN_DOMAINS
        .iter()
        .map(|d| format!("\"{}\"", d))
        .collect::<Vec<_>>()
        .join(",");
    let cnip_js = PAC_CN_IP_PREFIXES
        .iter()
        .map(|p| format!("\"{}\"", p))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"// 硅侣统一 PAC — 「锦上添花」策略 v3（硅侣 v4.4.3+ 自动生成）
// 名单来源: 服务端 route_domains + 内置底座；兜底 = DIRECT（绝不破坏任何网络环境）
function FindProxyForURL(url, host) {{
  if (isPlainHostName(host)) return "DIRECT";
  if (shExpMatch(host, "*.local") || shExpMatch(host, "*.lan") ||
      shExpMatch(host, "*.cn") || shExpMatch(host, "*.com.cn") ||
      shExpMatch(host, "*.net.cn") || shExpMatch(host, "*.org.cn") ||
      shExpMatch(host, "*.gov.cn") || shExpMatch(host, "*.edu.cn")) return "DIRECT";
  var gfw = [{gfw_js}];
  for (var i = 0; i < gfw.length; i++) {{
    var g = gfw[i];
    if (host === g || shExpMatch(host, "*" + g) || host.indexOf("." + g) >= 0 || host === g) return "SOCKS5 127.0.0.1:1080; DIRECT";
  }}
  var cn = [{cn_js}];
  for (var j = 0; j < cn.length; j++) {{
    var c = cn[j];
    if (host === c || host.endsWith("." + c)) return "DIRECT";
  }}
  var ip = "";
  try {{ ip = dnsResolve(host); }} catch (e) {{ return "DIRECT"; }}
  if (!ip) return "DIRECT";
  var cnNets = [{cnip_js}];
  for (var k = 0; k < cnNets.length; k++) {{
    if (ip.indexOf(cnNets[k]) === 0) return "DIRECT";
  }}
  if (isInNet(ip, "10.0.0.0", "255.0.0.0") || isInNet(ip, "172.16.0.0", "255.240.0.0") ||
      isInNet(ip, "192.168.0.0", "255.255.0.0") || isInNet(ip, "127.0.0.0", "255.0.0.0")) return "DIRECT";
  return "DIRECT";
}}
"#,
        gfw_js = gfw_js,
        cn_js = cn_js,
        cnip_js = cnip_js
    )
}

/// PAC 写入路径（虾群 pac-server 静态服务目录）
#[cfg(target_os = "macos")]
fn pac_file_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".pac/proxy.pac"))
}

/// 原子写 PAC；生成/写盘失败绝不覆盖现有文件
#[cfg(target_os = "macos")]
pub fn write_pac_file(route_domains: &[String]) -> Result<(), String> {
    let path = pac_file_path().ok_or("no HOME")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let pac = generate_pac(route_domains);
    let tmp = path.with_extension("pac.tmp");
    std::fs::write(&tmp, pac).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    eprintln!("[tunnel] PAC updated: {} domains (gfw) -> {:?}", route_domains.len(), path);
    Ok(())
}

// 保留兼容性：旧的调用入口（内部转到新逻辑）
pub fn set_system_proxy_for_chatgpt(enable: bool, _socks_port: u16) {
    let _ = _socks_port;
    if enable {
        proxy_take_over();
    } else {
        proxy_release();
    }
}

// 保留find_singbox_binary用于兼容(不再实际使用)
pub fn find_singbox_binary() -> Option<String> {
    let candidates = if cfg!(target_os = "macos") {
        vec!["/usr/local/bin/sing-box", "/opt/homebrew/bin/sing-box"]
    } else {
        vec!["/usr/bin/sing-box", "/usr/local/bin/sing-box"]
    };
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// 完整周期测试：接管 → 记录存在且PAC指向daemon → 释放 → 记录删除且PAC恢复原值
    /// 安全性：释放后系统 PAC 必须与接管前逐字节一致（产品铁律：退场必恢复）
    #[test]
    fn test_takeover_release_cycle_restores_original_state() {
        let services = get_all_network_services();
        assert!(!services.is_empty(), "no network services found");

        // 1. 记录接管前原状
        let before: Vec<(Option<String>, bool)> = services
            .iter()
            .map(|s| get_auto_proxy_state(s))
            .collect();

        // 2. 接管
        proxy_take_over();
        assert!(
            read_takeover_record().map(|r| r.taken_over).unwrap_or(false),
            "takeover record must exist after take_over"
        );
        for s in &services {
            let (url, enabled) = get_auto_proxy_state(s);
            assert_eq!(url.as_deref(), Some(DAEMON_PAC_URL), "PAC must point to daemon on {}", s);
            assert!(enabled, "PAC must be enabled on {}", s);
        }

        // 3. 释放
        proxy_release();
        assert!(read_takeover_record().is_none(), "record must be deleted after release");

        // 4. 恢复原状（产品铁律）
        for (i, s) in services.iter().enumerate() {
            let after = get_auto_proxy_state(s);
            assert_eq!(after, before[i], "service {} must be restored exactly", s);
        }
    }

    /// 释放的幂等性：没接管过就释放 = 无操作，绝不误清系统 PAC
    #[test]
    fn test_release_without_takeover_is_noop() {
        let services = get_all_network_services();
        let before: Vec<(Option<String>, bool)> = services
            .iter()
            .map(|s| get_auto_proxy_state(s))
            .collect();

        proxy_release(); // 无记录 → 应直接返回

        for (i, s) in services.iter().enumerate() {
            let after = get_auto_proxy_state(s);
            assert_eq!(after, before[i], "no-takeover release must not touch {}", s);
        }
    }

    /// 崩溃自愈：伪造残留接管记录 → cleanup 恢复原值并删记录
    #[test]
    fn test_cleanup_recovers_from_stale_record() {
        let services = get_all_network_services();
        let before: Vec<(Option<String>, bool)> = services
            .iter()
            .map(|s| get_auto_proxy_state(s))
            .collect();

        // 模拟"接管后崩溃"：接管但不释放，制造残留记录
        proxy_take_over();
        assert!(read_takeover_record().is_some());

        // 启动自愈（模拟下次启动）
        cleanup_leftover_proxy();
        assert!(read_takeover_record().is_none(), "stale record must be cleaned");

        // PAC 恢复原值
        for (i, s) in services.iter().enumerate() {
            let after = get_auto_proxy_state(s);
            assert_eq!(after, before[i], "service {} must be restored by crash recovery", s);
        }
    }
}
