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

/// Tauri-facing QR generate result
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WeComQrAuthStart {
    pub scode: String,
    pub auth_url: String,
}

/// Tauri-facing QR poll result.
///
/// `status` is one of `waiting`, `scanned`, `success`, `expired`. Credentials
/// are present only when `status` is `success` and both values are non-empty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WeComQrAuthPollResult {
    pub status: String,
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}

/// What a poll meant, without the credential values. Safe to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WeComQrPollTrace {
    /// `waiting` | `scanned` | `success` | `success_incomplete` | `expired` | `other`
    pub phase: &'static str,
    pub has_bot_info: bool,
    pub has_bot_id: bool,
    pub has_secret: bool,
}

fn waiting_poll() -> WeComQrAuthPollResult {
    WeComQrAuthPollResult {
        status: "waiting".into(),
        bot_id: None,
        secret: None,
    }
}

fn trimmed_str(value: &serde_json::Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// Bot id keys the WeCom admin QR API is known to use.
///
/// `botid` is the field returned by `query_result` (wecom-cli, picoclaw, and
/// hermes all read it). Hermes also accepts `bot_id` on the same object.
/// There is no evidence for any other alias; unknown keys are ignored.
fn bot_id_from_info(info: &serde_json::Value) -> Option<&str> {
    info.get("botid")
        .and_then(trimmed_str)
        .or_else(|| info.get("bot_id").and_then(trimmed_str))
}

fn secret_from_info(info: &serde_json::Value) -> Option<&str> {
    info.get("secret").and_then(trimmed_str)
}

/// Parse a generate-body. Errors are categories: the body is never copied
/// into the message, because a later poll body is where the secret lives and
/// the two parsers share that rule.
pub(crate) fn interpret_wecom_qr_generate(bytes: &[u8]) -> Result<WeComQrAuthStart, &'static str> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid_json")?;
    let Some(data) = value.get("data").filter(|data| data.is_object()) else {
        return Err("missing_data");
    };
    let Some(scode) = data.get("scode").and_then(trimmed_str) else {
        return Err("missing_fields");
    };
    let Some(auth_url) = data.get("auth_url").and_then(trimmed_str) else {
        return Err("missing_fields");
    };
    Ok(WeComQrAuthStart {
        scode: scode.to_string(),
        auth_url: auth_url.to_string(),
    })
}

/// Parse a `query_result` body into a poll the UI can act on.
///
/// A `success` payload is ready only when both the bot id and the secret are
/// non-empty. Anything less (missing `bot_info`, empty secret, id under an
/// unknown key) stays `waiting`, so the caller keeps polling. `scaned` /
/// `scanned` become `scanned` and never carry partial credentials. The error
/// string is a static category and does not include the body.
pub(crate) fn interpret_wecom_qr_poll(
    bytes: &[u8],
) -> Result<(WeComQrAuthPollResult, WeComQrPollTrace), &'static str> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid_json")?;
    let Some(data) = value.get("data").filter(|data| data.is_object()) else {
        return Ok((
            waiting_poll(),
            WeComQrPollTrace {
                phase: "waiting",
                has_bot_info: false,
                has_bot_id: false,
                has_secret: false,
            },
        ));
    };

    let info = data.get("bot_info").filter(|info| info.is_object());
    let has_bot_info = info.is_some();
    let bot_id = info.and_then(bot_id_from_info);
    let secret = info.and_then(secret_from_info);
    let trace_flags = WeComQrPollTrace {
        phase: "waiting",
        has_bot_info,
        has_bot_id: bot_id.is_some(),
        has_secret: secret.is_some(),
    };
    let raw_status = data
        .get("status")
        .and_then(|status| status.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let (result, phase) = match raw_status.as_str() {
        "expired" => (
            WeComQrAuthPollResult {
                status: "expired".into(),
                bot_id: None,
                secret: None,
            },
            "expired",
        ),
        "scaned" | "scanned" => (
            WeComQrAuthPollResult {
                status: "scanned".into(),
                bot_id: None,
                secret: None,
            },
            "scanned",
        ),
        "success" => match (bot_id, secret) {
            (Some(id), Some(sec)) => (
                WeComQrAuthPollResult {
                    status: "success".into(),
                    bot_id: Some(id.to_string()),
                    secret: Some(sec.to_string()),
                },
                "success",
            ),
            _ => (waiting_poll(), "success_incomplete"),
        },
        "wait" | "waiting" | "pending" | "" => (waiting_poll(), "waiting"),
        // Unknown non-terminal states keep the poll alive. They are not success.
        _ => (waiting_poll(), "other"),
    };

    Ok((
        result,
        WeComQrPollTrace {
            phase,
            ..trace_flags
        },
    ))
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

    const SECRET_FIXTURE: &str = "qr-test-secret-value";

    #[test]
    fn success_with_botid_returns_both_credentials() {
        let body = format!(
            r#"{{"data":{{"status":"success","bot_info":{{"botid":"bot-1","secret":"{SECRET_FIXTURE}"}}}}}}"#
        );
        let (result, trace) = interpret_wecom_qr_poll(body.as_bytes()).unwrap();
        assert_eq!(result.status, "success");
        assert_eq!(result.bot_id.as_deref(), Some("bot-1"));
        assert_eq!(result.secret.as_deref(), Some(SECRET_FIXTURE));
        assert_eq!(trace.phase, "success");
        assert!(trace.has_bot_id && trace.has_secret);
    }

    /// Hermes reads `bot_id` when `botid` is absent. That alias is the only
    /// extra key with a public caller; a credential is still all-or-nothing.
    #[test]
    fn success_accepts_bot_id_alias() {
        let body = format!(
            r#"{{"data":{{"status":"Success","bot_info":{{"bot_id":"bot-2","secret":"{SECRET_FIXTURE}"}}}}}}"#
        );
        let (result, trace) = interpret_wecom_qr_poll(body.as_bytes()).unwrap();
        assert_eq!(result.status, "success");
        assert_eq!(result.bot_id.as_deref(), Some("bot-2"));
        assert_eq!(result.secret.as_deref(), Some(SECRET_FIXTURE));
        assert_eq!(trace.phase, "success");
    }

    #[test]
    fn success_without_a_secret_is_not_success() {
        let body = br#"{"data":{"status":"success","bot_info":{"botid":"bot-1","secret":"   "}}}"#;
        let (result, trace) = interpret_wecom_qr_poll(body).unwrap();
        assert_eq!(result, super::waiting_poll());
        assert_eq!(trace.phase, "success_incomplete");
        assert!(trace.has_bot_id);
        assert!(!trace.has_secret);
        assert!(result.bot_id.is_none());
    }

    #[test]
    fn success_without_bot_info_keeps_polling() {
        let body = br#"{"data":{"status":"success"}}"#;
        let (result, trace) = interpret_wecom_qr_poll(body).unwrap();
        assert_eq!(result.status, "waiting");
        assert_eq!(trace.phase, "success_incomplete");
        assert!(!trace.has_bot_info);
    }

    #[test]
    fn scanned_statuses_do_not_surface_partial_credentials() {
        for status in ["scaned", "scanned"] {
            let body = format!(
                r#"{{"data":{{"status":"{status}","bot_info":{{"botid":"bot-1","secret":"{SECRET_FIXTURE}"}}}}}}"#
            );
            let (result, trace) = interpret_wecom_qr_poll(body.as_bytes()).unwrap();
            assert_eq!(result.status, "scanned", "{status}");
            assert!(result.bot_id.is_none() && result.secret.is_none());
            assert_eq!(trace.phase, "scanned");
            assert!(trace.has_secret);
        }
    }

    #[test]
    fn waiting_and_unknown_statuses_are_not_success() {
        for status in ["wait", "waiting", "pending", "confirm"] {
            let body = format!(
                r#"{{"data":{{"status":"{status}","bot_info":{{"botid":"bot-1","secret":"{SECRET_FIXTURE}"}}}}}}"#
            );
            let (result, trace) = interpret_wecom_qr_poll(body.as_bytes()).unwrap();
            assert_eq!(result.status, "waiting", "{status}");
            assert!(result.secret.is_none());
            assert!(trace.phase == "waiting" || trace.phase == "other");
        }
    }

    #[test]
    fn expired_drops_any_credentials() {
        let body = format!(
            r#"{{"data":{{"status":"expired","bot_info":{{"botid":"bot-1","secret":"{SECRET_FIXTURE}"}}}}}}"#
        );
        let (result, trace) = interpret_wecom_qr_poll(body.as_bytes()).unwrap();
        assert_eq!(result.status, "expired");
        assert!(result.bot_id.is_none() && result.secret.is_none());
        assert_eq!(trace.phase, "expired");
    }

    #[test]
    fn missing_data_keeps_polling() {
        let (result, trace) = interpret_wecom_qr_poll(br#"{"errcode":0}"#).unwrap();
        assert_eq!(result.status, "waiting");
        assert_eq!(trace.phase, "waiting");
    }

    #[test]
    fn invalid_poll_json_does_not_echo_the_body() {
        let body = format!(r#"{{"data":{{"secret":"{SECRET_FIXTURE}""#);
        let err = interpret_wecom_qr_poll(body.as_bytes()).unwrap_err();
        assert_eq!(err, "invalid_json");
        assert!(!err.contains(SECRET_FIXTURE));
        assert!(!err.contains("bot_info"));
    }

    #[test]
    fn invalid_generate_json_does_not_echo_the_body() {
        let body =
            format!(r#"{{"data":{{"auth_url":"https://example.invalid/qr?scode={SECRET_FIXTURE}""#);
        let err = interpret_wecom_qr_generate(body.as_bytes()).unwrap_err();
        assert_eq!(err, "invalid_json");
        assert!(!err.contains(SECRET_FIXTURE));
        assert!(!err.contains("auth_url"));
    }

    #[test]
    fn generate_requires_both_scode_and_auth_url() {
        let err = interpret_wecom_qr_generate(br#"{"data":{"scode":"abc"}}"#).unwrap_err();
        assert_eq!(err, "missing_fields");
        let ok = interpret_wecom_qr_generate(
            br#"{"data":{"scode":"abc","auth_url":"https://example.invalid/a"}}"#,
        )
        .unwrap();
        assert_eq!(ok.scode, "abc");
        assert_eq!(ok.auth_url, "https://example.invalid/a");
    }
}
