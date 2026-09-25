//! 硅侣2.0 — Streamlined输出过滤
//!
//! 解析free-code SDK输出的SDKMessage JSON流，过滤后只保留：
//! - streamlined_text: 显示（流式文本）
//! - result: 显示（最终结论）
//! - streamlined_tool_use_summary: 丢弃
//! - 其他: 丢弃
//!
//! 铁律: 交互窗口只显示用户输入和AI最终结论，严禁显示工具调用、模型名称、中间步骤

use serde::{Deserialize, Serialize};

/// SDKMessage — free-code SDK输出的JSON消息格式
#[derive(Debug, Deserialize, Serialize)]
pub struct SDKMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub content: Option<serde_json::Value>,
}

/// 过滤后的显示消息
#[derive(Debug, Clone, Serialize)]
pub struct DisplayMessage {
    pub text: String,
    pub is_final: bool,
    pub msg_type: String,
}

/// 过滤SDKMessage — 核心过滤逻辑
///
/// 规则:
/// - streamlined_text → DisplayMessage { text, is_final: false }
/// - result → DisplayMessage { text: result.content, is_final: true }
/// - streamlined_tool_use_summary → None (丢弃)
/// - 其他 → None (丢弃)
pub fn filter(message: &SDKMessage) -> Option<DisplayMessage> {
    match message.msg_type.as_str() {
        "streamlined_text" => {
            // 流式文本 — 显示
            message.text.as_ref().map(|text| DisplayMessage {
                text: text.clone(),
                is_final: false,
                msg_type: "streamlined_text".into(),
            })
        }
        "result" => {
            // 最终结论 — 显示
            let text = if let Some(ref result) = message.result {
                if let Some(s) = result.as_str() {
                    s.to_string()
                } else {
                    serde_json::to_string(result).unwrap_or_default()
                }
            } else {
                String::new()
            };
            Some(DisplayMessage {
                text,
                is_final: true,
                msg_type: "result".into(),
            })
        }
        "streamlined_tool_use_summary" => {
            // 工具调用摘要 — 丢弃
            None
        }
        _ => {
            // 其他所有消息 — 丢弃
            None
        }
    }
}

/// 从原始JSON行解析并过滤
pub fn parse_and_filter(line: &str) -> Option<DisplayMessage> {
    let msg: SDKMessage = serde_json::from_str(line).ok()?;
    filter(&msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_streamlined_text() {
        let msg = SDKMessage {
            msg_type: "streamlined_text".into(),
            text: Some("你好".into()),
            session_id: None,
            uuid: None,
            result: None,
            content: None,
        };
        let result = filter(&msg);
        assert!(result.is_some());
        let dm = result.unwrap();
        assert_eq!(dm.text, "你好");
        assert!(!dm.is_final);
    }

    #[test]
    fn test_filter_result() {
        let msg = SDKMessage {
            msg_type: "result".into(),
            text: None,
            session_id: None,
            uuid: None,
            result: Some(serde_json::json!("最终答案")),
            content: None,
        };
        let result = filter(&msg);
        assert!(result.is_some());
        let dm = result.unwrap();
        assert_eq!(dm.text, "最终答案");
        assert!(dm.is_final);
    }

    #[test]
    fn test_filter_tool_use_summary() {
        let msg = SDKMessage {
            msg_type: "streamlined_tool_use_summary".into(),
            text: Some("Read 2 files".into()),
            session_id: None,
            uuid: None,
            result: None,
            content: None,
        };
        let result = filter(&msg);
        assert!(result.is_none());
    }

    #[test]
    fn test_filter_other() {
        let msg = SDKMessage {
            msg_type: "thinking".into(),
            text: Some("思考中...".into()),
            session_id: None,
            uuid: None,
            result: None,
            content: None,
        };
        let result = filter(&msg);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_and_filter() {
        let line = r#"{"type":"streamlined_text","text":"你好世界"}"#;
        let result = parse_and_filter(line);
        assert!(result.is_some());
        assert_eq!(result.unwrap().text, "你好世界");
    }
}
