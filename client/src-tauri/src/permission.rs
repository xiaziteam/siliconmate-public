//! 硅侣3.0 — 远程任务权限审批
//!
//! 三档策略：allow(始终允许) / ask(每次询问) / deny(始终拒绝)
//! JSON文件存储在 ~/.siliconmate/permissions.json
//! 按好友+操作类型组合存储

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

// ── 数据结构 ──

/// 权限规则
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub friend_id: String,
    pub capability: String,
    pub policy: String, // "allow" | "ask" | "deny"
}

/// 权限存储（整体JSON结构）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionData {
    pub rules: Vec<PermissionRule>,
    pub default_policy: String,
}

impl Default for PermissionData {
    fn default() -> Self {
        Self {
            rules: vec![
                // 默认规则：所有好友的所有操作每次询问
                PermissionRule {
                    friend_id: "*".into(),
                    capability: "*".into(),
                    policy: "ask".into(),
                },
            ],
            default_policy: "ask".into(),
        }
    }
}

/// 权限存储管理
pub struct PermissionStore {
    data: Mutex<PermissionData>,
    config_path: String,
}

impl PermissionStore {
    pub fn new() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let config_dir = format!("{}/.siliconmate", home);
        let config_path = format!("{}/permissions.json", config_dir);

        // 确保目录存在
        let _ = std::fs::create_dir_all(&config_dir);

        // 尝试加载已有配置
        let data = match std::fs::read_to_string(&config_path) {
            Ok(content) => {
                match serde_json::from_str::<PermissionData>(&content) {
                    Ok(d) => d,
                    Err(_) => {
                        eprintln!("[permission] 配置文件解析失败，使用默认配置");
                        PermissionData::default()
                    }
                }
            }
            Err(_) => {
                // 首次运行，创建默认配置
                let default = PermissionData::default();
                if let Ok(json) = serde_json::to_string_pretty(&default) {
                    let _ = std::fs::write(&config_path, json);
                }
                default
            }
        };

        Self {
            data: Mutex::new(data),
            config_path,
        }
    }

    /// 检查权限策略
    pub fn check_policy(&self, friend_id: &str, capability: &str) -> String {
        let data = self.data.lock().unwrap();

        // 1. 精确匹配（friend_id + capability）
        for rule in &data.rules {
            if rule.friend_id == friend_id && rule.capability == capability {
                return rule.policy.clone();
            }
        }

        // 2. 好友通配符（friend_id + "*"）
        for rule in &data.rules {
            if rule.friend_id == friend_id && rule.capability == "*" {
                return rule.policy.clone();
            }
        }

        // 3. 全局通配符（"*" + capability）
        for rule in &data.rules {
            if rule.friend_id == "*" && rule.capability == capability {
                return rule.policy.clone();
            }
        }

        // 4. 全局通配符（"*" + "*"）
        for rule in &data.rules {
            if rule.friend_id == "*" && rule.capability == "*" {
                return rule.policy.clone();
            }
        }

        // 5. 默认策略
        data.default_policy.clone()
    }

    /// 设置权限规则
    pub fn set_rule(&self, friend_id: &str, capability: &str, policy: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();

        // 查找是否已有规则
        let found = data.rules.iter_mut().find(|r| {
            r.friend_id == friend_id && r.capability == capability
        });

        if let Some(rule) = found {
            rule.policy = policy.to_string();
        } else {
            data.rules.push(PermissionRule {
                friend_id: friend_id.to_string(),
                capability: capability.to_string(),
                policy: policy.to_string(),
            });
        }

        // 持久化
        self.persist(&data)?;

        Ok(())
    }

    /// 列出所有规则
    pub fn list_rules(&self) -> Vec<PermissionRule> {
        let data = self.data.lock().unwrap();
        data.rules.clone()
    }

    /// 持久化到文件
    fn persist(&self, data: &PermissionData) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data)
            .map_err(|e| format!("序列化权限配置失败: {}", e))?;
        std::fs::write(&self.config_path, json)
            .map_err(|e| format!("写入权限配置失败: {}", e))?;
        Ok(())
    }
}

impl Default for PermissionStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri Commands ──

/// 检查权限策略
#[tauri::command]
pub fn permission_check(
    store: State<'_, PermissionStore>,
    friend_id: String,
    capability: String,
) -> Result<Value, String> {
    let policy = store.check_policy(&friend_id, &capability);
    Ok(serde_json::json!({ "policy": policy }))
}

/// 设置权限规则
#[tauri::command]
pub fn permission_set(
    store: State<'_, PermissionStore>,
    friend_id: String,
    capability: String,
    policy: String,
) -> Result<Value, String> {
    // 验证policy值
    if !["allow", "ask", "deny"].contains(&policy.as_str()) {
        return Err("无效策略，必须是allow/ask/deny之一".into());
    }
    store.set_rule(&friend_id, &capability, &policy)?;
    Ok(serde_json::json!({ "success": true }))
}

/// 列出所有权限规则
#[tauri::command]
pub fn permission_list(
    store: State<'_, PermissionStore>,
) -> Result<Value, String> {
    let rules = store.list_rules();
    Ok(serde_json::json!({ "rules": rules }))
}
