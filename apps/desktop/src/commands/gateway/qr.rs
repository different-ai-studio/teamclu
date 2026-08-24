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
//! Each helper opens a fresh connection, writes the line-based request, reads
//! the single-line JSON reply, and unwraps the envelope.

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use serde::{Deserialize, Serialize};

use teamclu_gateway::wechat_config::{WeChatQrLoginResponse, WeChatQrStatusResponse};
use teamclu_gateway::wecom_config::{WeComQrAuthPollResult, WeComQrAuthStart};

use crate::commands::amuxd_control;

/// One round-trip against amuxd's control channel for the four QR commands.
/// `request` is the literal payload (terminate the last line with `\n`
/// yourself). Returns the raw `result` JSON value on `ok:true`, or the
/// `error` string on `ok:false`.
async fn sock_roundtrip(request: &str) -> Result<serde_json::Value, String> {
    let mut stream = amuxd_control::connect().await?;

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock write: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock flush: {e}"))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("amuxd sock read: {e}"))?;

    #[derive(Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<serde_json::Value>,
    }

    let parsed: Wire = serde_json::from_str(line.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={line:?})"))?;

    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    parsed
        .result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())
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

#[tauri::command]
pub async fn start_wechat_qr_login() -> Result<QrData, String> {
    let raw = sock_roundtrip("wechat-qr-start\n").await?;
    let parsed: WeChatQrLoginResponse =
        serde_json::from_value(raw).map_err(|e| format!("decode WeChatQrLoginResponse: {e}"))?;
    Ok(parsed.into())
}

#[tauri::command]
pub async fn poll_wechat_qr_status(qrcode: String) -> Result<QrStatusResponse, String> {
    // The qrcode token never contains a newline in practice — strip just in case
    // to keep the line framing intact on the daemon side.
    let qrcode = qrcode.replace(['\n', '\r'], "");
    let raw = sock_roundtrip(&format!("wechat-qr-poll\n{qrcode}\n")).await?;
    let parsed: WeChatQrStatusResponse =
        serde_json::from_value(raw).map_err(|e| format!("decode WeChatQrStatusResponse: {e}"))?;
    Ok(parsed.into())
}

#[tauri::command]
pub async fn start_wecom_qr_auth() -> Result<WeComQrAuthStart, String> {
    let raw = sock_roundtrip("wecom-qr-start\n").await?;
    serde_json::from_value(raw).map_err(|e| format!("decode WeComQrAuthStart: {e}"))
}

#[tauri::command]
pub async fn poll_wecom_qr_auth(scode: String) -> Result<WeComQrAuthPollResult, String> {
    let scode = scode.replace(['\n', '\r'], "");
    let raw = sock_roundtrip(&format!("wecom-qr-poll\n{scode}\n")).await?;
    serde_json::from_value(raw).map_err(|e| format!("decode WeComQrAuthPollResult: {e}"))
}
