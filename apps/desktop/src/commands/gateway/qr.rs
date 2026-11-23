//! Thin Tauri command wrappers around amuxd's QR-login frames.
//!
//! The desktop app does not call the WeChat/WeCom HTTP APIs directly anymore;
//! amuxd owns the gateway crate and exposes four control commands over its
//! control channel (a Unix socket, or a named pipe on Windows):
//!
//!   wechat-qr-start            -> JSON `{ok, result?, error?}` with `QrData`
//!   wechat-qr-poll <qrcode>    -> JSON `{ok, result?, error?}` with `QrStatusResponse`
//!   wecom-qr-start             -> JSON `{ok, result?, error?}` with `WeComQrAuthStart`
//!   wecom-qr-poll <scode>      -> JSON `{ok, result?, error?}` with `WeComQrAuthPollResult`
//!
//! Each helper is one timed line round-trip on that channel. The reply body is
//! never copied into an error string: a WeCom poll line is where the bot
//! secret travels.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use teamclu_gateway::wechat_config::{WeChatQrLoginResponse, WeChatQrStatusResponse};
use teamclu_gateway::wecom_config::{WeComQrAuthPollResult, WeComQrAuthStart};

use crate::commands::amuxd_control;

/// Generate calls the upstream with a 30s HTTP budget. Leave headroom so a
/// slow but successful response is not reported as a desktop timeout.
const QR_START_TIMEOUT: Duration = Duration::from_secs(45);
/// WeCom poll's own HTTP budget is 10s. WeChat's long-poll budget is 35s,
/// so the shared poll deadline has to clear that one too.
const QR_POLL_TIMEOUT: Duration = Duration::from_secs(50);

/// One round-trip against amuxd's control channel for the four QR commands.
/// `request` is the literal payload (terminate the last line with `\n`
/// yourself). Returns the raw `result` JSON value on `ok:true`, or a
/// redacted `error` string on failure.
async fn sock_roundtrip(request: &str, timeout: Duration) -> Result<serde_json::Value, String> {
    let line = amuxd_control::request_line_timeout(request, timeout).await?;
    decode_control_result(&line)
}

/// Unwrap `{ok, result?, error?}` without echoing `line`.
fn decode_control_result(line: &str) -> Result<serde_json::Value, String> {
    #[derive(Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<serde_json::Value>,
    }

    let parsed: Wire =
        serde_json::from_str(line.trim()).map_err(|_| "amuxd bad response".to_string())?;
    if !parsed.ok {
        return Err(sanitize_control_error(parsed.error.as_deref()));
    }
    parsed
        .result
        .ok_or_else(|| "amuxd bad response".to_string())
}

/// Daemon errors are short categories. Anything that could be a payload
/// (URL, JSON, the words a credential uses) is replaced with a fixed label.
fn sanitize_control_error(err: Option<&str>) -> String {
    let Some(raw) = err.map(str::trim).filter(|text| !text.is_empty()) else {
        return "amuxd error".to_string();
    };
    let one = raw.lines().next().unwrap_or(raw);
    let lower = one.to_ascii_lowercase();
    if one.len() > 160
        || one.contains('{')
        || one.contains("://")
        || lower.contains("secret")
        || lower.contains("scode")
        || lower.contains("auth_url")
        || lower.contains("token")
    {
        return "amuxd error".to_string();
    }
    one.to_string()
}

/// Frontend-facing shape for WeChat QR start. Mirrors the React
/// `QrData` interface in `Wechat.tsx` exactly (camelCase, optional
/// `qrcodeImgContent`). The underlying ilink response already serializes
/// to this shape via `WeChatQrLoginResponse`'s camelCase rename.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrData {
    pub qrcode: String,
    pub qrcode_img_content: Option<String>,
}

impl From<WeChatQrLoginResponse> for QrData {
    fn from(v: WeChatQrLoginResponse) -> Self {
        Self {
            qrcode: v.qrcode,
            qrcode_img_content: v.qrcode_img_content,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStatusResponse {
    pub status: String,
    pub bot_token: Option<String>,
    pub ilink_bot_id: Option<String>,
    pub baseurl: Option<String>,
}

impl From<WeChatQrStatusResponse> for QrStatusResponse {
    fn from(v: WeChatQrStatusResponse) -> Self {
        Self {
            status: v.status,
            bot_token: v.bot_token,
            ilink_bot_id: v.ilink_bot_id,
            baseurl: v.baseurl,
        }
    }
}

fn decode_value<T: serde::de::DeserializeOwned>(raw: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(raw).map_err(|_| "amuxd bad response".to_string())
}

#[tauri::command]
pub async fn start_wechat_qr_login() -> Result<QrData, String> {
    let raw = sock_roundtrip("wechat-qr-start\n", QR_START_TIMEOUT).await?;
    let parsed: WeChatQrLoginResponse = decode_value(raw)?;
    Ok(parsed.into())
}

#[tauri::command]
pub async fn poll_wechat_qr_status(qrcode: String) -> Result<QrStatusResponse, String> {
    // The qrcode token never contains a newline in practice — strip just in case
    // to keep the line framing intact on the daemon side.
    let qrcode = qrcode.replace(['\n', '\r'], "");
    let raw = sock_roundtrip(&format!("wechat-qr-poll\n{qrcode}\n"), QR_POLL_TIMEOUT).await?;
    let parsed: WeChatQrStatusResponse = decode_value(raw)?;
    Ok(parsed.into())
}

#[tauri::command]
pub async fn start_wecom_qr_auth() -> Result<WeComQrAuthStart, String> {
    let raw = sock_roundtrip("wecom-qr-start\n", QR_START_TIMEOUT).await?;
    decode_value(raw)
}

#[tauri::command]
pub async fn poll_wecom_qr_auth(scode: String) -> Result<WeComQrAuthPollResult, String> {
    let scode = scode.replace(['\n', '\r'], "");
    let raw = sock_roundtrip(&format!("wecom-qr-poll\n{scode}\n"), QR_POLL_TIMEOUT).await?;
    decode_value(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET_FIXTURE: &str = "qr-test-secret-value";

    #[test]
    fn a_malformed_poll_line_does_not_echo_the_secret() {
        let line = format!(
            r#"{{"ok":true,"result":{{"status":"success","botId":"bot-1","secret":"{SECRET_FIXTURE}""#
        );
        let err = decode_control_result(&line).unwrap_err();
        assert_eq!(err, "amuxd bad response");
        assert!(!err.contains(SECRET_FIXTURE));
    }

    #[test]
    fn a_daemon_error_that_quotes_the_body_is_replaced() {
        let line = format!(
            r#"{{"ok":false,"error":"QR poll parse failed: {{\"secret\":\"{SECRET_FIXTURE}\"}}"}}"#
        );
        let err = decode_control_result(&line).unwrap_err();
        assert_eq!(err, "amuxd error");
        assert!(!err.contains(SECRET_FIXTURE));
    }

    #[test]
    fn a_short_category_error_is_forwarded() {
        let line = r#"{"ok":false,"error":"QR poll request failed: timeout"}"#;
        let err = decode_control_result(line).unwrap_err();
        assert_eq!(err, "QR poll request failed: timeout");
    }

    #[test]
    fn a_successful_poll_line_decodes_credentials() {
        let line = format!(
            r#"{{"ok":true,"result":{{"status":"success","botId":"bot-1","secret":"{SECRET_FIXTURE}"}}}}"#
        );
        let raw = decode_control_result(&line).unwrap();
        let parsed: WeComQrAuthPollResult = decode_value(raw).unwrap();
        assert_eq!(parsed.status, "success");
        assert_eq!(parsed.bot_id.as_deref(), Some("bot-1"));
        assert_eq!(parsed.secret.as_deref(), Some(SECRET_FIXTURE));
    }
}
