use serde::{Deserialize, Serialize};

use crate::wecom_delivery::{
    DEFAULT_FINAL_MAX_RETRIES, DEFAULT_PROGRESS_FRAME_GAP_SECS, DEFAULT_STREAM_MAX_SECS,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WeComConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub encoding_aes_key: Option<String>,
    /// The userid of the person who bound this bot.
    /// Auto-recorded from the first DM received by the gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    /// The bot's display name in WeCom, e.g. `Matt chow的机器人 1`.
    ///
    /// Group callbacks carry the mention only as text — `@<name> 正文`, with no
    /// structured field to read it from — so stripping it back off requires
    /// knowing the name. Without it the gateway falls back to a heuristic that
    /// cannot tell where a multi-word name ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    /// Seconds a stream bubble may stay open. Past this the driver finishes
    /// it with a "still running" frame and later pushes the answer as
    /// markdown. `0` disables the early close (tests / emergency).
    pub stream_max_secs: u64,
    /// Minimum gap between two frames of the same stream, in seconds.
    pub progress_frame_gap_secs: u64,
    /// How many times a failed proactive send is retried from the outbox.
    pub final_max_retries: u32,
}

impl Default for WeComConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_id: String::new(),
            secret: String::new(),
            encoding_aes_key: None,
            owner_id: None,
            bot_name: None,
            stream_max_secs: DEFAULT_STREAM_MAX_SECS,
            progress_frame_gap_secs: DEFAULT_PROGRESS_FRAME_GAP_SECS,
            final_max_retries: DEFAULT_FINAL_MAX_RETRIES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WeComGatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComGatewayStatusResponse {
    pub status: WeComGatewayStatus,
    pub error_message: Option<String>,
    pub bot_id: Option<String>,
    /// Active session keys (e.g. "wecom:dm:userid", "wecom:chatid")
    #[serde(default)]
    pub active_sessions: Vec<String>,
}

impl Default for WeComGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: WeComGatewayStatus::Disconnected,
            error_message: None,
            bot_id: None,
            active_sessions: Vec::new(),
        }
    }
}

/// Response from WeCom QR code generate API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrGenerateResponse {
    pub data: Option<WeComQrGenerateData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrGenerateData {
    pub scode: String,
    pub auth_url: String,
}

/// Response from WeCom QR code poll API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrPollResponse {
    pub data: Option<WeComQrPollData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrPollData {
    pub status: String,
    pub bot_info: Option<WeComQrBotInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrBotInfo {
    pub botid: String,
    pub secret: String,
}

/// Tauri-facing QR generate result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrAuthStart {
    pub scode: String,
    pub auth_url: String,
}

/// Tauri-facing QR poll result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComQrAuthPollResult {
    pub status: String, // "waiting" | "success" | "expired"
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_delivery_fields_take_the_new_defaults() {
        let cfg: WeComConfig = serde_json::from_str(r#"{"enabled":true,"botId":"b"}"#).unwrap();
        assert_eq!(cfg.bot_id, "b");
        assert_eq!(cfg.stream_max_secs, DEFAULT_STREAM_MAX_SECS);
        assert_eq!(cfg.progress_frame_gap_secs, DEFAULT_PROGRESS_FRAME_GAP_SECS);
        assert_eq!(cfg.final_max_retries, DEFAULT_FINAL_MAX_RETRIES);
    }
}
