use crate::i18n;
use crate::wecom_config::{WeComConfig, WeComGatewayStatus, WeComGatewayStatusResponse};
use base64::Engine as _;
use futures_util::stream::SplitSink;
#[allow(unused_imports)]
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::{driver, AgentHandle, ChannelStore};

/// Global reference to the active WeComGateway for proactive message sending.
static ACTIVE_GATEWAY: OnceLock<Arc<RwLock<Option<WeComGateway>>>> = OnceLock::new();

fn get_active_gateway_holder() -> &'static Arc<RwLock<Option<WeComGateway>>> {
    ACTIVE_GATEWAY.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Decrypt AES-256-CBC encrypted data from WeCom.
/// WeCom images/files are encrypted with a per-message aeskey.
/// Algorithm: AES-256-CBC, PKCS#7 padding (32-byte aligned), IV = first 16 bytes of key.
fn decrypt_wecom_media(encrypted: &[u8], aeskey_b64: &str) -> Result<Vec<u8>, String> {
    use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};

    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

    // Base64-decode the key (may need padding)
    let padded_key = if aeskey_b64.ends_with('=') {
        aeskey_b64.to_string()
    } else {
        format!("{}=", aeskey_b64)
    };
    let key = base64::engine::general_purpose::STANDARD
        .decode(&padded_key)
        .map_err(|e| format!("Failed to decode aeskey: {}", e))?;

    if key.len() != 32 {
        return Err(format!("AES key must be 32 bytes, got {}", key.len()));
    }

    // IV = first 16 bytes of the key
    let iv = &key[..16];

    // Decrypt
    let mut buf = encrypted.to_vec();
    let decryptor =
        Aes256CbcDec::new_from_slices(&key, iv).map_err(|e| format!("AES init failed: {}", e))?;
    let decrypted = decryptor
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decryption failed: {:?}", e))?;

    // Manual PKCS#7 unpadding (32-byte aligned, values 1-32)
    if decrypted.is_empty() {
        return Err("Decrypted data is empty".into());
    }
    let pad_byte = *decrypted.last().unwrap() as usize;
    if pad_byte == 0 || pad_byte > 32 || pad_byte > decrypted.len() {
        // No valid padding — return as-is
        return Ok(decrypted.to_vec());
    }
    // Verify all padding bytes match
    let start = decrypted.len() - pad_byte;
    if decrypted[start..].iter().all(|&b| b as usize == pad_byte) {
        Ok(decrypted[..start].to_vec())
    } else {
        Ok(decrypted.to_vec())
    }
}

/// Fetch an encrypted WeCom media URL, decrypt with the per-message aeskey,
/// and detect the MIME type. Returns `(plaintext_bytes, mime)`.
async fn download_and_decrypt_wecom_media(
    url: &str,
    aeskey_b64: &str,
    filename_hint: Option<&str>,
) -> Result<(Vec<u8>, String), String> {
    let client = crate::try_http_client_secs(30).map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("media GET: {e} ({e:?})"))?;
    if !resp.status().is_success() {
        return Err(format!("media GET failed: HTTP {}", resp.status()));
    }
    let encrypted = resp
        .bytes()
        .await
        .map_err(|e| format!("media body: {e}"))?
        .to_vec();
    let plaintext = if aeskey_b64.is_empty() {
        encrypted
    } else {
        decrypt_wecom_media(&encrypted, aeskey_b64)?
    };
    let mime = resolve_mime(&plaintext, filename_hint);
    Ok((plaintext, mime))
}

/// Compress an image to fit within max_bytes by resizing and re-encoding as JPEG.
#[allow(dead_code)]
fn compress_image(bytes: &[u8], max_bytes: usize) -> Result<Vec<u8>, String> {
    use image::ImageReader;
    use std::io::Cursor;

    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Try progressively smaller sizes until it fits
    let (orig_w, orig_h) = (img.width(), img.height());
    for scale_pct in &[100u32, 75, 50, 35, 25] {
        let w = orig_w * scale_pct / 100;
        let h = orig_h * scale_pct / 100;
        let resized = if *scale_pct < 100 {
            img.resize(w, h, image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        };

        // Encode as JPEG with quality 80
        let mut buf = Cursor::new(Vec::new());
        resized
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .map_err(|e| format!("JPEG encode failed: {}", e))?;

        let result = buf.into_inner();
        if result.len() <= max_bytes {
            return Ok(result);
        }
    }

    Err("Could not compress image small enough".into())
}

/// Detect MIME type from file magic bytes.
///
/// For ZIP-based files, attempts to distinguish OOXML subtypes (xlsx/docx/pptx)
/// by inspecting the ZIP directory entries. Falls back to `application/zip` if
/// the content cannot be identified as OOXML.
fn detect_mime_from_magic(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    // Images
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg".into())
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png".into())
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif".into())
    } else if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        Some("image/webp".into())
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp".into())
    // Documents
    } else if bytes.starts_with(b"%PDF") {
        Some("application/pdf".into())
    // ZIP archive — local file header (\x03\x04), empty archive (\x05\x06),
    // or spanned archive (\x07\x08). All OOXML files (xlsx/docx/pptx) start
    // with the local file header form.
    } else if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || bytes.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || bytes.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        // Try to identify OOXML subtypes by peeking at ZIP entry names.
        // OOXML packages always contain well-known directory prefixes.
        Some(detect_ooxml_from_zip(bytes).unwrap_or_else(|| "application/zip".into()))
    // Compound File Binary Format (legacy MS Office: .xls / .doc / .ppt)
    } else if bytes.len() >= 8 && bytes[..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        Some("application/x-cfb".into())
    } else {
        None
    }
}

/// Attempt to identify OOXML subtype by scanning ZIP local file header entries.
///
/// Instead of pulling in the full `zip` crate, we do a lightweight scan of the
/// ZIP local file headers (signature 0x50 0x4B 0x03 0x04) and inspect the
/// stored file names for well-known OOXML directory prefixes:
///   - `xl/`   → xlsx (Excel)
///   - `word/` → docx (Word)
///   - `ppt/`  → pptx (PowerPoint)
///   - `[Content_Types].xml` → confirms OOXML but subtype unknown
///
/// Returns `Some(mime)` if an OOXML subtype is identified, `None` otherwise
/// (caller should fall back to `application/zip`).
fn detect_ooxml_from_zip(bytes: &[u8]) -> Option<String> {
    // ZIP local file header structure:
    //   offset 0:  signature (4 bytes) = PK\x03\x04
    //   offset 26: filename length (2 bytes, little-endian)
    //   offset 28: extra field length (2 bytes, little-endian)
    //   offset 30: filename (variable length)
    //   followed by: extra field, then file data (or not, for stored entries)
    //
    // We scan up to 20 entries or 64KB (whichever comes first) to keep this fast.
    let limit = bytes.len().min(65536);
    let mut offset = 0;
    let mut entries_scanned = 0;
    let max_entries = 20;

    let mut has_content_types = false;

    while offset + 30 <= limit && entries_scanned < max_entries {
        // Check for local file header signature
        if bytes[offset..offset + 4] != [0x50, 0x4B, 0x03, 0x04] {
            break;
        }

        let fname_len = u16::from_le_bytes([bytes[offset + 26], bytes[offset + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let compressed_size = u32::from_le_bytes([
            bytes[offset + 18],
            bytes[offset + 19],
            bytes[offset + 20],
            bytes[offset + 21],
        ]) as usize;

        if offset + 30 + fname_len > limit {
            break;
        }

        let fname_bytes = &bytes[offset + 30..offset + 30 + fname_len];
        if let Ok(fname) = std::str::from_utf8(fname_bytes) {
            let fname_lower = fname.to_ascii_lowercase();
            if fname_lower.starts_with("xl/") || fname_lower == "xl" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
                );
            }
            if fname_lower.starts_with("word/") || fname_lower == "word" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        .into(),
                );
            }
            if fname_lower.starts_with("ppt/") || fname_lower == "ppt" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        .into(),
                );
            }
            if fname_lower == "[content_types].xml" {
                has_content_types = true;
            }
        }

        // Advance to next entry: header(30) + filename + extra + compressed data
        offset += 30 + fname_len + extra_len + compressed_size;
        entries_scanned += 1;
    }

    // If we found [Content_Types].xml but no specific prefix, it's still likely
    // OOXML — return xlsx as the most common case (better than zip).
    if has_content_types {
        return Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into());
    }

    None
}

/// Extract filename from a Content-Disposition header value.
///
/// Handles both `filename="name.ext"` and `filename*=UTF-8''encoded` forms.
/// Returns `None` if no filename can be extracted.
#[allow(dead_code)]
fn extract_filename_from_content_disposition(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();

    // Try filename*= (RFC 5987 / RFC 6266) first — it supports UTF-8
    if let Some(pos) = lower.find("filename*=") {
        let after = &header[pos + "filename*=".len()..];
        // Format: charset'language'value (e.g. UTF-8''%E6%8A%A5%E8%A1%A8.xlsx)
        if let Some(tick_pos) = after.find("''") {
            let encoded = after[tick_pos + 2..]
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('"');
            if !encoded.is_empty() {
                // URL-decode the filename
                if let Ok(decoded) = urlencoding::decode(encoded) {
                    let name = decoded.into_owned();
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
    }

    // Fall back to plain filename= parameter.
    // Note: "filename*=" does NOT contain "filename=" as a substring
    // (the * comes before =), so a simple find is safe.
    if let Some(pos) = lower.find("filename=") {
        let after = &header[pos + "filename=".len()..];
        let name = if let Some(stripped) = after.strip_prefix('"') {
            // Quoted string
            stripped.split('"').next().unwrap_or("").to_string()
        } else {
            after.split(';').next().unwrap_or("").trim().to_string()
        };
        if !name.is_empty() {
            return Some(name);
        }
    }

    None
}

/// Best-effort MIME for a file: trust the extension, fall back to magic
/// bytes, then to a generic binary. Public because the daemon's outbound
/// send path records attachments too, and both directions must label the
/// same file the same way.
pub fn resolve_mime(bytes: &[u8], filename_hint: Option<&str>) -> String {
    filename_hint
        .and_then(detect_mime_from_filename)
        .or_else(|| detect_mime_from_magic(bytes))
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// Extract the lowercase extension from a filename, rejecting dotfiles
/// (`.hidden`), trailing dots (`name.`), and non-alphanumeric extensions.
#[allow(dead_code)]
fn ext_from_filename(filename: &str) -> Option<String> {
    let (stem, ext) = filename.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    if !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Infer MIME type from filename extension
fn detect_mime_from_filename(filename: &str) -> Option<String> {
    let ext = filename.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        // Images
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "png" => Some("image/png".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "bmp" => Some("image/bmp".into()),
        "svg" => Some("image/svg+xml".into()),
        // Documents
        "pdf" => Some("application/pdf".into()),
        "doc" => Some("application/msword".into()),
        "docx" => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".into())
        }
        "xls" => Some("application/vnd.ms-excel".into()),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()),
        "ppt" => Some("application/vnd.ms-powerpoint".into()),
        "pptx" => {
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation".into())
        }
        "csv" => Some("text/csv".into()),
        "txt" => Some("text/plain".into()),
        "json" => Some("application/json".into()),
        "xml" => Some("application/xml".into()),
        "html" | "htm" => Some("text/html".into()),
        "md" => Some("text/markdown".into()),
        "zip" => Some("application/zip".into()),
        _ => None,
    }
}

/// Get platform code for WeCom QR auth API
fn get_plat_code() -> u8 {
    #[cfg(target_os = "macos")]
    {
        1
    }
    #[cfg(target_os = "windows")]
    {
        2
    }
    #[cfg(target_os = "linux")]
    {
        3
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        0
    }
}

const WECOM_QR_GENERATE_URL: &str = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_POLL_URL: &str = "https://work.weixin.qq.com/ai/qc/query_result";

/// Fetch a QR code for WeCom bot authorization
pub async fn fetch_wecom_qr_code() -> Result<super::wecom_config::WeComQrAuthStart, String> {
    use crate::wecom_config::{WeComQrAuthStart, WeComQrGenerateResponse};

    let url = format!(
        "{}?source=teamclu&plat={}",
        WECOM_QR_GENERATE_URL,
        get_plat_code()
    );
    let client = crate::http_client_secs(30);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR generate request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR generate failed: HTTP {}", resp.status()));
    }

    let body: WeComQrGenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR generate parse failed: {}", e))?;

    let data = body.data.ok_or("QR generate response missing data")?;
    if data.scode.is_empty() || data.auth_url.is_empty() {
        return Err("QR generate response missing scode or auth_url".into());
    }

    Ok(WeComQrAuthStart {
        scode: data.scode,
        auth_url: data.auth_url,
    })
}

/// Poll WeCom QR code scan result
pub async fn poll_wecom_qr_result(
    scode: &str,
) -> Result<super::wecom_config::WeComQrAuthPollResult, String> {
    use crate::wecom_config::{WeComQrAuthPollResult, WeComQrPollResponse};

    let url = format!("{}?scode={}", WECOM_QR_POLL_URL, urlencoding::encode(scode));
    let client = crate::try_http_client_secs(10).map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR poll request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR poll failed: HTTP {}", resp.status()));
    }

    let body: WeComQrPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR poll parse failed: {}", e))?;

    let data = match body.data {
        Some(d) => d,
        None => {
            return Ok(WeComQrAuthPollResult {
                status: "waiting".into(),
                bot_id: None,
                secret: None,
            });
        }
    };

    if data.status == "success" {
        let bot_info = data
            .bot_info
            .ok_or("QR poll success but missing bot_info")?;
        Ok(WeComQrAuthPollResult {
            status: "success".into(),
            bot_id: Some(bot_info.botid),
            secret: Some(bot_info.secret),
        })
    } else {
        Ok(WeComQrAuthPollResult {
            status: data.status,
            bot_id: None,
            secret: None,
        })
    }
}

type WsSink = Arc<
    tokio::sync::Mutex<
        SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::Message,
        >,
    >,
>;

pub const WECOM_WS_ENDPOINT: &str = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_SECS: u64 = 30;
#[allow(dead_code)]
const HEARTBEAT_TIMEOUT_SECS: u64 = 6;

/// Pending WebSocket response channels, keyed by req_id.
/// Used for request–response patterns (e.g. media upload) over the multiplexed WS.
type PendingResponses =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<serde_json::Value>>>>;

/// Minimum spacing between two frames of the same streamed reply. See
/// [`StreamPacer`] for why frames cannot simply be fired as fast as the agent
/// produces text.
/// Minimum gap between two frames of one streaming reply.
///
/// WeCom counts **every** frame against "30 messages/minute, 1000/hour per
/// conversation" — replies and proactive pushes share that budget, and a stream
/// is not consolidated into one message
/// (<https://developer.work.weixin.qq.com/document/path/101463>). At the old
/// 900ms this burned 66 frames a minute, more than twice the allowance, so a
/// long answer would start losing frames part-way through and read as a reply
/// that froze. 2.1s keeps it at ~28/minute with room for the final message.
const STREAM_FRAME_MIN_GAP: std::time::Duration = std::time::Duration::from_millis(2100);

#[allow(dead_code)]
const TERMINAL_FRAME_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Paces the frames of one streamed reply.
///
/// Every frame of a turn rewrites the *same* bubble, and WeCom applies those
/// rewrites under optimistic concurrency: two landing close together come back
/// as errcode 6000 (数据版本冲突, "possible simultaneous modification by
/// multiple callers, retry later") and the losing rewrite is dropped. The agent
/// side sends an update the moment a segment flushes — deliberately, so text
/// appears promptly — which on a long answer means several frames within
/// milliseconds. Spacing them here keeps that behaviour for every other channel
/// while staying inside what WeCom will accept.
#[derive(Clone)]
struct StreamPacer {
    req_id: String,
    stream_id: String,
    ws_sink: WsSink,
    last_frame_at: Arc<tokio::sync::Mutex<Option<std::time::Instant>>>,
}

impl StreamPacer {
    fn new(req_id: &str, stream_id: &str, ws_sink: &WsSink) -> Self {
        Self {
            req_id: req_id.to_string(),
            stream_id: stream_id.to_string(),
            ws_sink: ws_sink.clone(),
            last_frame_at: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Send one frame, waiting out the remainder of the gap since the previous
    /// one. The lock is deliberately held across the wait: it is what serializes
    /// the progressive-update task against the terminal frame.
    async fn send(&self, content: &str, finish: bool) -> Result<(), String> {
        let mut last = self.last_frame_at.lock().await;
        if let Some(prev) = *last {
            let since = prev.elapsed();
            if since < STREAM_FRAME_MIN_GAP {
                tokio::time::sleep(STREAM_FRAME_MIN_GAP - since).await;
            }
        }
        let result = WeComGateway::send_stream_chunk_static(
            &self.req_id,
            &self.stream_id,
            content,
            finish,
            &self.ws_sink,
        )
        .await;
        *last = Some(std::time::Instant::now());
        result
    }
}

#[derive(Clone)]
pub struct WeComGateway {
    config: Arc<RwLock<WeComConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeComGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    pending_questions: Arc<super::PendingQuestionStore>,
    shared_ws_sink: Arc<RwLock<Option<WsSink>>>,
    card_metadata: Arc<RwLock<std::collections::HashMap<String, CardMetadata>>>,
    pending_responses: PendingResponses,
    /// When present, inbound messages are normalized and handed to the core
    /// pipeline instead of being handled inline
    /// (`docs/specs/2026-08-18-gateway-transport-architecture.md`).
    ///
    /// Absent means the pre-driver path, which is still here so a live bot can
    /// be switched back without a rebuild. It goes away once the new path has
    /// been through a real WeCom round trip.
    inbound_sink: Arc<RwLock<Option<Arc<dyn driver::InboundSink>>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct WeComWsMessage {
    #[serde(default)]
    cmd: String,
    #[allow(dead_code)]
    headers: Option<serde_json::Value>,
    body: Option<serde_json::Value>,
}

/// WeCom uses flat lowercase field names (msgid, chatid, msgtype, etc.)
/// See: https://developer.work.weixin.qq.com/document/path/101463
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WeComMsgCallback {
    #[serde(default)]
    msgid: String,
    #[serde(default)]
    chatid: String,
    #[serde(default)]
    chattype: String,
    #[serde(default)]
    from: Option<WeComFrom>,
    #[serde(default)]
    msgtype: String,
    // Content fields per msgtype
    #[serde(default)]
    text: Option<serde_json::Value>,
    #[serde(default)]
    voice: Option<serde_json::Value>,
    #[serde(default)]
    image: Option<serde_json::Value>,
    #[serde(default)]
    file: Option<serde_json::Value>,
    /// An attachment sent together with a caption arrives as one `mixed`
    /// message; the parts live in `mixed.msg_item[]`, each with its own
    /// `msgtype` and body.
    #[serde(default)]
    mixed: Option<serde_json::Value>,
    /// Quoted/referenced message when user replies to a message
    #[serde(default)]
    quote: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct WeComFrom {
    #[serde(default)]
    userid: String,
}

/// One inbound media reference lifted off a callback, before it is downloaded
/// and decrypted.
#[derive(Debug, Clone, PartialEq)]
struct PendingMedia {
    url: String,
    aeskey: Option<String>,
    filename_hint: Option<String>,
}

fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// Pull the media reference out of an `image` body. WeCom has shipped the URL
/// under three different names, so all three are accepted.
fn image_media(image: &serde_json::Value) -> Option<PendingMedia> {
    let url = json_str(image, "url")
        .or_else(|| json_str(image, "img_url"))
        .or_else(|| json_str(image, "pic_url"))?;
    Some(PendingMedia {
        url,
        aeskey: json_str(image, "aeskey"),
        filename_hint: None,
    })
}

/// Pull the media reference out of a `file` body. Files carry a filename,
/// which `resolve_mime` needs to tell e.g. xlsx from a bare ZIP.
fn file_media(file: &serde_json::Value) -> Option<PendingMedia> {
    Some(PendingMedia {
        url: json_str(file, "url")?,
        aeskey: json_str(file, "aeskey"),
        filename_hint: json_str(file, "filename"),
    })
}

/// Split a callback into its text and its media references.
///
/// An image or file sent *with* a caption arrives as a single `mixed` message
/// whose parts sit in `mixed.msg_item[]` in send order; sent alone it arrives
/// under its own top-level `msgtype`. Returns `None` for message types we
/// don't handle at all, which the caller drops.
fn extract_message_parts(msg: &WeComMsgCallback) -> Option<(String, Vec<PendingMedia>)> {
    let mut text = String::new();
    let mut media: Vec<PendingMedia> = Vec::new();

    match msg.msgtype.as_str() {
        "text" => {
            text = msg
                .text
                .as_ref()
                .and_then(|t| json_str(t, "content"))
                .unwrap_or_default();
        }
        "voice" => {
            text = msg
                .voice
                .as_ref()
                .and_then(|v| json_str(v, "content"))
                .unwrap_or_default();
        }
        "image" => {
            println!("[WeCom] Image message body: {:?}", msg.image);
            match msg.image.as_ref().and_then(image_media) {
                Some(m) => media.push(m),
                None => println!("[WeCom] Image message has no URL field"),
            }
        }
        "file" => {
            println!("[WeCom] File message body: {:?}", msg.file);
            match msg.file.as_ref().and_then(file_media) {
                Some(m) => media.push(m),
                None => println!("[WeCom] File message has no URL field"),
            }
        }
        "mixed" => {
            let items = msg
                .mixed
                .as_ref()
                .and_then(|m| m.get("msg_item"))
                .and_then(|i| i.as_array());
            match items {
                Some(items) => {
                    for item in items {
                        match item.get("msgtype").and_then(|v| v.as_str()).unwrap_or("") {
                            "text" => {
                                let part = item
                                    .get("text")
                                    .and_then(|t| json_str(t, "content"))
                                    .unwrap_or_default();
                                if !part.is_empty() {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(&part);
                                }
                            }
                            "image" => match item.get("image").and_then(image_media) {
                                Some(m) => media.push(m),
                                None => println!("[WeCom] Mixed image item has no URL field"),
                            },
                            "file" => match item.get("file").and_then(file_media) {
                                Some(m) => media.push(m),
                                None => println!("[WeCom] Mixed file item has no URL field"),
                            },
                            other => println!("[WeCom] Ignoring mixed item of type: {}", other),
                        }
                    }
                }
                None => println!("[WeCom] Mixed message has no msg_item array"),
            }
        }
        _ => return None,
    }

    Some((text, media))
}

/// Metadata stored when a template card is sent for a question,
/// needed to update the card when the user clicks a button.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct CardMetadata {
    question_text: String,
    options: Vec<super::pending_question::QuestionOption>,
}

enum WsExitReason {
    Shutdown,
    Disconnected,
}

// ─── Prototype: WeCom → InboundMessage ───────────────────────────────────────
//
// The normalizer for the transport-driver design
// (`docs/specs/2026-08-18-gateway-transport-architecture.md`). Pure: no
// network, no config, no clock — which is what lets it be tested against real
// callback shapes instead of only against a live bot.
//
// What it deliberately does NOT do, because the core owns it: dedup, matching a
// quoted reply back to a pending question, slash-command dispatch, session
// resolve, identity, recording, driving the turn.
//
// What stays here, because it IS the wire protocol: msgtype demultiplexing, the
// `@bot ` prefix WeCom prepends in group chats, and media references (url +
// per-message aeskey) left undownloaded.

/// Bytes for one WeCom media reference, fetched and decrypted on demand.
///
/// Deferred rather than eager so a text-only message still starts its turn
/// without waiting on a download. That property exists today only as an
/// ordering accident inside `handle_message_callback`; the type is what keeps
/// it once the ordering moves into the core.
struct WeComAttachmentFetch {
    url: String,
    aeskey: Option<String>,
    filename_hint: Option<String>,
}

#[async_trait::async_trait]
impl driver::FetchAttachment for WeComAttachmentFetch {
    async fn fetch(&self) -> Result<Vec<u8>, driver::DriverError> {
        // The mime the download resolves is dropped here on purpose: it is
        // sniffed again from the bytes on the core side, so a driver cannot be
        // the only thing that knows a file's type.
        download_and_decrypt_wecom_media(
            &self.url,
            self.aeskey.as_deref().unwrap_or(""),
            self.filename_hint.as_deref(),
        )
        .await
        .map(|(bytes, _mime)| bytes)
        .map_err(driver::DriverError::Transport)
    }
}

/// What a WeCom bot can do, for the core's downgrade rules.
pub fn wecom_caps() -> driver::ChannelCaps {
    driver::ChannelCaps {
        // Stream chunks land as template-card updates.
        streaming_edit: true,
        media_upload: true,
        interactive: true,
        threading: driver::Threading::Inline,
        max_chars: 2048,
        // Ten minutes. A chat bot that searches, reads files and writes an
        // answer routinely runs past the old two-minute cap — and when it did,
        // the sender got "timed out, please retry" for a turn that was working
        // fine, while the runtime kept going and starved the next message.
        turn_timeout_secs: 600,
    }
}

/// Normalize a decrypted callback into the canonical inbound shape.
///
/// `None` means a msgtype carrying nothing actionable — the caller logs and
/// drops it, exactly as today.
pub(crate) fn normalize_callback(
    msg: &WeComMsgCallback,
    bot_id: &str,
    req_id: &str,
    bot_name: Option<&str>,
) -> Option<driver::InboundMessage> {
    let (text, pending_media) = extract_message_parts(msg)?;

    let kind = if msg.chattype == "group" {
        driver::ConversationKind::Group
    } else {
        driver::ConversationKind::Direct
    };
    // A group keys on the chat; a DM keys on the user, because a DM has no
    // chat id to key on.
    let userid = msg
        .from
        .as_ref()
        .map(|f| f.userid.clone())
        .unwrap_or_default();
    let conversation_id = if kind == driver::ConversationKind::Group {
        msg.chatid.clone()
    } else {
        userid.clone()
    };

    let text = strip_group_mention_prefix(&text, kind, bot_name);

    let quoted_text = msg.quote.as_ref().and_then(|q| {
        q.get("text")
            .and_then(|t| t.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    });

    let attachments = pending_media
        .into_iter()
        .map(|m| driver::InboundAttachment {
            filename: m
                .filename_hint
                .clone()
                .unwrap_or_else(|| "file".to_string()),
            // WeCom does not declare a mime type; it is sniffed after decrypt.
            mime: String::new(),
            size_hint: None,
            source: driver::AttachmentSource::Deferred(Arc::new(WeComAttachmentFetch {
                url: m.url,
                aeskey: m.aeskey,
                filename_hint: m.filename_hint,
            })),
        })
        .collect();

    Some(driver::InboundMessage {
        conversation: driver::Conversation {
            channel: "wecom",
            bot_id: (!bot_id.is_empty()).then(|| bot_id.to_string()),
            kind,
            id: conversation_id,
        },
        sender: driver::ExternalSender {
            external_id: userid,
            // WeCom callbacks carry no display name; the core resolves it when
            // it maps the external user to an actor.
            display_name: String::new(),
            email: None,
        },
        external_message_id: msg.msgid.clone(),
        text,
        attachments,
        // WeCom only delivers a group message when the bot is addressed, so
        // reaching here already means it was. Stated rather than assumed: the
        // core must not have to know that rule per channel.
        addressed_to_bot: true,
        quoted_text,
        // The websocket request this arrived on. Replies and streaming card
        // updates go back through it, not through a send-to-chat API.
        reply_context: (!req_id.is_empty()).then(|| req_id.to_string()),
    })
}

/// WeCom as a transport driver.
///
/// Holds only what rendering needs: the shared websocket sink (set on connect),
/// the config (for `bot_id`, which is part of the binding), and the pacers for
/// in-flight streaming replies.
///
/// The pacer map is why `update` cannot be stateless: WeCom throttles card
/// updates, and the gap is measured from the previous frame of *that* reply.
/// Rebuilding a pacer per update would reset the clock and burst straight
/// through the limit.
pub struct WeComDriver {
    #[allow(dead_code)]
    config: Arc<RwLock<WeComConfig>>,
    shared_ws_sink: Arc<RwLock<Option<WsSink>>>,
    pacers: tokio::sync::Mutex<std::collections::HashMap<String, InFlightReply>>,
}

/// A streaming reply being written, and where its finished text has to go.
///
/// The conversation is kept because the final answer does NOT go out through
/// the stream: `stream` carries plain text, so a markdown answer arrives with
/// its fences and lists as literal characters. The stream shows progress, and
/// the finished answer is sent once as a `markdown` message, which WeCom
/// renders.
struct InFlightReply {
    pacer: StreamPacer,
    chatid: String,
    chat_type: u32,
}

impl WeComDriver {
    pub fn new(
        config: Arc<RwLock<WeComConfig>>,
        shared_ws_sink: Arc<RwLock<Option<WsSink>>>,
    ) -> Self {
        Self {
            config,
            shared_ws_sink,
            pacers: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    async fn sink(&self) -> Result<WsSink, driver::DriverError> {
        self.shared_ws_sink
            .read()
            .await
            .clone()
            .ok_or_else(|| driver::DriverError::Transport("WeCom is not connected".into()))
    }

    /// `(chatid, chat_type)` for the media APIs, which address chats by number
    /// rather than by the binding's words.
    fn chat_target(conversation: &driver::Conversation) -> (&str, u32) {
        match conversation.kind {
            driver::ConversationKind::Group => (conversation.id.as_str(), 2),
            _ => (conversation.id.as_str(), 1),
        }
    }
}

#[async_trait::async_trait]
impl driver::ChannelDriver for WeComDriver {
    fn id(&self) -> driver::ChannelId {
        "wecom"
    }

    fn caps(&self) -> driver::ChannelCaps {
        wecom_caps()
    }

    fn binding(&self, conversation: &driver::Conversation) -> String {
        // WSS smart-bot only exposes bot_id, so it fills both the corp and the
        // agent slot — the same shape the pre-driver code built.
        let bot = conversation.bot_id.clone().unwrap_or_default();
        match conversation.kind {
            driver::ConversationKind::Group => {
                crate::binding::wecom_group(&bot, &bot, &conversation.id)
            }
            _ => crate::binding::wecom_dm(&bot, &bot, &conversation.id),
        }
    }

    fn sender_urn(
        &self,
        conversation: &driver::Conversation,
        sender: &driver::ExternalSender,
    ) -> String {
        let bot = conversation.bot_id.clone().unwrap_or_default();
        crate::binding::urn_wecom_user(&bot, &sender.external_id)
    }

    fn session_title(
        &self,
        conversation: &driver::Conversation,
        sender: &driver::ExternalSender,
    ) -> String {
        match conversation.kind {
            driver::ConversationKind::Group => format!("WeCom group: {}", conversation.id),
            _ => format!("WeCom DM: {}", sender.external_id),
        }
    }

    /// An empty text opens a streaming bubble — the core does that before a
    /// streaming turn and then edits it. A non-empty one is a complete message
    /// and goes out finished.
    async fn deliver(
        &self,
        to: &driver::Conversation,
        reply_context: Option<&str>,
        msg: &driver::OutboundMessage,
    ) -> Result<driver::DeliveryId, driver::DriverError> {
        let sink = self.sink().await?;

        // Attachments first: the caption reads as a label for them, and WeCom
        // renders each file as its own bubble regardless of order.
        for att in &msg.attachments {
            let (chatid, chat_type) = Self::chat_target(to);
            let path = att.local_path.as_deref().unwrap_or_default();
            let bytes = std::fs::read(path)
                .map_err(|e| driver::DriverError::Transport(format!("read {path}: {e}")))?;
            upload_and_send_media(
                chatid,
                chat_type,
                &bytes,
                &att.filename,
                media_type_for(&att.mime),
            )
            .await
            .map_err(driver::DriverError::Transport)?;
        }

        // Files with no text of their own: the caption already went out with
        // the reply. Opening a streaming bubble here is what left a "thinking…"
        // placeholder stranded in the chat after the answer had arrived —
        // empty text means "nothing more to say", not "start a reply".
        if msg.text.trim().is_empty() && !msg.attachments.is_empty() {
            return Ok(driver::DeliveryId(format!("files:{}", to.id)));
        }

        let Some(req_id) = reply_context else {
            // Nothing to answer: this is proactive, which WeCom does through a
            // different command entirely.
            let (chatid, chat_type) = Self::chat_target(to);
            send_proactive_message(chatid, chat_type, &msg.text)
                .await
                .map_err(driver::DriverError::Transport)?;
            return Ok(driver::DeliveryId(format!("proactive:{chatid}")));
        };

        let (chatid, chat_type) = Self::chat_target(to);

        // A finished one-shot reply (a command answer, an error). Sent as
        // markdown so a reply containing a list or a code block renders as one.
        if !msg.text.trim().is_empty() {
            send_proactive_message(chatid, chat_type, &msg.text)
                .await
                .map_err(driver::DriverError::Transport)?;
            return Ok(driver::DeliveryId(format!("markdown:{chatid}")));
        }

        let stream_id = uuid::Uuid::new_v4().to_string();
        let pacer = StreamPacer::new(req_id, &stream_id, &sink);
        pacer
            .send(PROGRESS_OPENING, false)
            .await
            .map_err(driver::DriverError::Transport)?;

        self.pacers.lock().await.insert(
            stream_id.clone(),
            InFlightReply {
                pacer,
                chatid: chatid.to_string(),
                chat_type,
            },
        );
        Ok(driver::DeliveryId(stream_id))
    }

    /// Progress while the turn runs; the answer itself at the end.
    ///
    /// The intermediate text is deliberately NOT streamed. `stream` carries
    /// plain text, so a markdown answer would arrive with its fences, tables
    /// and lists as literal characters, and every frame spends one of the 30
    /// messages a minute this conversation is allowed. A progress line costs
    /// the same per frame but does not need to be complete or pretty.
    async fn update(
        &self,
        id: &driver::DeliveryId,
        text: &str,
        end: Option<driver::TurnEnd>,
    ) -> Result<(), driver::DriverError> {
        let (pacer, chatid, chat_type) = {
            let pacers = self.pacers.lock().await;
            match pacers.get(&id.0) {
                Some(r) => (r.pacer.clone(), r.chatid.clone(), r.chat_type),
                None => {
                    return Err(driver::DriverError::Transport(format!(
                        "no streaming reply {} to update — it was already finished",
                        id.0
                    )))
                }
            }
        };

        let Some(end) = end else {
            let frame = match newest_line(text) {
                Some(line) => format!("{PROGRESS_OPENING} {line}"),
                None => PROGRESS_OPENING.to_string(),
            };
            return pacer
                .send(&frame, false)
                .await
                .map_err(driver::DriverError::Transport);
        };

        // WeCom has no delete/recall API, so this bubble is permanent once
        // opened. Close it on a marker that stays true forever rather than on
        // the last progress frame, which would leave "正在思考…" hanging above
        // an answer that finished long ago. The answer itself then goes out as
        // `markdown` — the only way WeCom renders fences and lists, since
        // `stream` content is plain text.
        //
        // A turn that ended with nothing to show closes on "cancelled": saying
        // "done" after the user typed `/stop` reports that the thing they
        // stopped finished anyway.
        let closing = match end {
            driver::TurnEnd::Answered => PROGRESS_DONE,
            driver::TurnEnd::NoAnswer => PROGRESS_CANCELLED,
        };
        let _ = pacer.send(closing, true).await;
        self.pacers.lock().await.remove(&id.0);
        if text.trim().is_empty() {
            return Ok(());
        }
        send_proactive_message(&chatid, chat_type, text)
            .await
            .map_err(driver::DriverError::Transport)
    }
}

/// What the progress bubble says while a turn runs.
const PROGRESS_OPENING: &str = "💭 正在思考…";
/// …and once it is done, so the bubble does not sit there implying it still is.
const PROGRESS_DONE: &str = "✅ 已完成";
/// …or once it was stopped, which is a different thing from finishing.
const PROGRESS_CANCELLED: &str = "⏹️ 已取消";

/// How much of the newest line rides along in the progress frame.
const PROGRESS_LINE_CHARS: usize = 40;

/// The tail of what the agent has written so far, for the progress bubble.
///
/// The turn reports **cumulative** text, so "newest" means the last non-empty
/// line. Fence markers and heading hashes are dropped: `stream` is plain text,
/// so they would show up as literal characters in the one place we cannot
/// render them.
///
/// Truncation counts characters, not bytes — a byte slice through a Chinese
/// reply panics, and this runs on every frame of every turn.
fn newest_line(text: &str) -> Option<String> {
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("```"))?;
    let line = line.trim_start_matches(['#', '*', '-', '>', ' ']);
    if line.is_empty() {
        return None;
    }
    let mut out: String = line.chars().take(PROGRESS_LINE_CHARS).collect();
    if line.chars().count() > PROGRESS_LINE_CHARS {
        out.push('…');
    }
    Some(out)
}

/// WeCom's media API takes its own type word, not a mime.
fn media_type_for(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "voice"
    } else {
        "file"
    }
}

/// `"@蕉你一手 /help"` → `"/help"`.
///
/// WeCom puts the mention in the text itself; nothing downstream should have to
/// know that. A message that is *only* the mention normalizes to empty, which
/// the core reads as "addressed, said nothing".
///
/// The callback has no structured mention field — `@<display name> 正文` in
/// `text.content` is all there is — so where the name ends is a guess unless
/// `bot_name` says. Cutting at the first space was that guess, and it is wrong
/// for every bot whose name contains one: `@Matt chow的机器人 1 /help` came
/// through as `chow的机器人 1 /help`, which no longer starts with a slash, so
/// every slash command in every group was quietly handled as a chat message.
///
/// Order matters: the configured name is exact, so it wins. Failing that, a
/// slash token is a strong signal — a message that mentions the bot and then
/// says `/stop` means the command, and the words in between are the name.
fn strip_group_mention_prefix(
    text: &str,
    kind: driver::ConversationKind,
    bot_name: Option<&str>,
) -> String {
    if kind != driver::ConversationKind::Group {
        return text.to_string();
    }
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix('@') else {
        return text.to_string();
    };

    if let Some(name) = bot_name.map(str::trim).filter(|n| !n.is_empty()) {
        if let Some(body) = rest.strip_prefix(name) {
            return body.trim().to_string();
        }
    }

    // No name configured (or it did not match — the bot was renamed in WeCom).
    // A slash token still pins where the mention stops.
    if let Some(slash) = slash_token_start(rest) {
        return rest[slash..].trim().to_string();
    }

    match rest.find(' ') {
        Some(space) => rest[space..].trim().to_string(),
        None => String::new(),
    }
}

/// Byte offset of the first token that is actually one of *our* commands.
///
/// Matching any `/word` would take `看看 /tmp/x` apart and send `/tmp/x` as a
/// command; only the command list can tell a command from a path.
fn slash_token_start(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    for (i, _) in text.char_indices().filter(|(_, c)| *c == '/') {
        if i != 0 && bytes.get(i - 1) != Some(&b' ') {
            continue;
        }
        let word = text[i + 1..].split([' ', '/']).next().unwrap_or_default();
        if !word.is_empty() && crate::commands::is_meta_command_name(word) {
            return Some(i);
        }
    }
    None
}

impl WeComGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
        workspace_path: String,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeComConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeComGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            shared_ws_sink: Arc::new(RwLock::new(None)),
            card_metadata: Arc::new(RwLock::new(std::collections::HashMap::new())),
            inbound_sink: Arc::new(RwLock::new(None)),
            pending_responses: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeComConfig) {
        *self.config.write().await = config;
    }

    /// The configured bot id for this gateway. Used by the channel manager to
    /// route bot-pinned sends and report per-bot status across a multi-bot fleet.
    pub async fn bot_id(&self) -> String {
        self.config.read().await.bot_id.clone()
    }

    /// Route inbound messages through the core pipeline instead of the inline
    /// handler. Set by the daemon at boot; unset leaves the pre-driver path.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver over this gateway's live connection, for the core to render
    /// replies through. Shares the config and websocket sink rather than
    /// copying them, so a reconnect is visible to both.
    pub fn as_driver(&self) -> WeComDriver {
        WeComDriver::new(self.config.clone(), self.shared_ws_sink.clone())
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub async fn get_status(&self) -> WeComGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeComGatewayStatus, error: Option<String>) {
        let mut s = self.status.write().await;
        s.status = status;
        s.error_message = error;
    }

    pub async fn start(&self) -> Result<(), String> {
        let is_running = *self.is_running.read().await;
        if is_running {
            return Err("WeCom gateway is already running".to_string());
        }

        let config = self.config.read().await.clone();
        if config.bot_id.is_empty() || config.secret.is_empty() {
            return Err("WeCom bot_id and secret are required".to_string());
        }

        *self.is_running.write().await = true;
        *get_active_gateway_holder().write().await = Some(self.clone());
        self.set_status(WeComGatewayStatus::Connecting, None).await;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        let bot_id = config.bot_id.clone();
        let secret = config.secret.clone();

        tokio::spawn(async move {
            gateway.run_gateway_loop(bot_id, secret, shutdown_rx).await;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let shutdown_tx = self.shutdown_tx.write().await.take();
        if let Some(tx) = shutdown_tx {
            let _ = tx.send(());
        }
        *get_active_gateway_holder().write().await = None;
        *self.shared_ws_sink.write().await = None;
        *self.is_running.write().await = false;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
        Ok(())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[WeCom] shutdown: {e}");
        }
    }

    async fn run_gateway_loop(
        &self,
        bot_id: String,
        secret: String,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        let mut backoff_secs = 2u64;

        loop {
            match self
                .connect_and_run(&bot_id, &secret, &mut shutdown_rx)
                .await
            {
                Ok(WsExitReason::Shutdown) => {
                    println!("[WeCom] Gateway shut down gracefully");
                    break;
                }
                Ok(WsExitReason::Disconnected) => {
                    backoff_secs = 2; // Reset after successful session
                    eprintln!("[WeCom] Disconnected, reconnecting in {}s", backoff_secs);
                    self.set_status(WeComGatewayStatus::Connecting, None).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during reconnect backoff");
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[WeCom] Gateway error: {}", e);
                    self.set_status(WeComGatewayStatus::Error, Some(e)).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during error backoff");
                            break;
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }

        *self.is_running.write().await = false;
        *get_active_gateway_holder().write().await = None;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
    }

    async fn connect_and_run(
        &self,
        bot_id: &str,
        secret: &str,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<WsExitReason, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;

        println!("[WeCom] Connecting to {}", WECOM_WS_ENDPOINT);

        let (ws_stream, _) = connect_async(WECOM_WS_ENDPOINT)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Send aibot_subscribe
        let subscribe_msg = serde_json::json!({
            "cmd": "aibot_subscribe",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": { "bot_id": bot_id, "secret": secret }
        });
        ws_sink
            .send(tokio_tungstenite::tungstenite::Message::Text(
                subscribe_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send subscribe: {}", e))?;

        // Wait for subscribe response (5s timeout)
        let subscribe_response =
            tokio::time::timeout(std::time::Duration::from_secs(5), ws_stream.next())
                .await
                .map_err(|_| "Subscribe response timeout".to_string())?
                .ok_or("WebSocket closed before subscribe response")?
                .map_err(|e| format!("Subscribe response error: {}", e))?;

        if let tokio_tungstenite::tungstenite::Message::Text(text) = subscribe_response {
            let resp: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid subscribe response: {}", e))?;
            // WeCom API uses "errcode"/"errmsg" fields (not "code"/"msg")
            let code = resp.get("errcode").and_then(|c| c.as_i64()).unwrap_or(-1);
            if code != 0 {
                let msg = resp
                    .get("errmsg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Subscribe failed (code {}): {}", code, msg));
            }
            println!("[WeCom] Subscribed successfully");
        }

        self.set_status(WeComGatewayStatus::Connected, None).await;
        {
            let mut s = self.status.write().await;
            s.bot_id = Some(bot_id.to_string());
        }

        // Heartbeat task
        let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));
        *self.shared_ws_sink.write().await = Some(Arc::clone(&ws_sink));
        let ws_sink_hb = Arc::clone(&ws_sink);
        let (hb_shutdown_tx, mut hb_shutdown_rx) = mpsc::channel::<()>(1);

        let heartbeat_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)) => {
                        use futures_util::SinkExt;
                        let ping_json = serde_json::json!({
                            "cmd": "ping",
                            "headers": { "req_id": uuid::Uuid::new_v4().to_string() }
                        });
                        let ping = tokio_tungstenite::tungstenite::Message::Text(
                            ping_json.to_string().into(),
                        );
                        if let Err(e) = ws_sink_hb.lock().await.send(ping).await {
                            eprintln!("[WeCom] Heartbeat ping failed: {}", e);
                            break;
                        }
                    }
                    _ = hb_shutdown_rx.recv() => {
                        break;
                    }
                }
            }
        });

        // Main event loop
        let exit_reason = loop {
            tokio::select! {
                msg = ws_stream.next() => {
                    match msg {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let ws_sink_clone = Arc::clone(&ws_sink);
                            // Spawn message handling as a separate task so we don't block the WS loop
                            // (same pattern as Feishu gateway)
                            let gateway = self.clone();
                            tokio::spawn(async move {
                                gateway.handle_ws_message(&text, ws_sink_clone).await;
                            });
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => {
                            // Heartbeat pong received
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                            println!("[WeCom] WebSocket closed by server");
                            break WsExitReason::Disconnected;
                        }
                        Some(Err(e)) => {
                            eprintln!("[WeCom] WebSocket error: {}", e);
                            break WsExitReason::Disconnected;
                        }
                        None => {
                            println!("[WeCom] WebSocket stream ended");
                            break WsExitReason::Disconnected;
                        }
                        _ => {} // Ignore binary, etc.
                    }
                }
                _ = &mut *shutdown_rx => {
                    println!("[WeCom] Shutdown signal received");
                    break WsExitReason::Shutdown;
                }
            }
        };

        *self.shared_ws_sink.write().await = None;
        let _ = hb_shutdown_tx.send(()).await;
        heartbeat_handle.abort();
        Ok(exit_reason)
    }

    async fn handle_ws_message(&self, text: &str, ws_sink: WsSink) {
        let msg: WeComWsMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[WeCom] Failed to parse message: {}", e);
                return;
            }
        };

        match msg.cmd.as_str() {
            "aibot_msg_callback" => {
                println!(
                    "[WeCom] Received msg callback: {}",
                    text.chars().take(2000).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let callback: WeComMsgCallback = match serde_json::from_value(body) {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[WeCom] Failed to parse callback: {}", e);
                            return;
                        }
                    };
                    // Extract original req_id for reply
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.handle_message_callback(callback, req_id, ws_sink)
                        .await;
                }
            }
            "aibot_event_callback" => {
                println!(
                    "[WeCom] Received event callback: {}",
                    text.chars().take(500).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let eventtype = body
                        .get("event")
                        .and_then(|e| e.get("eventtype"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    match eventtype {
                        "enter_chat" => {
                            self.handle_enter_chat(&req_id, &ws_sink).await;
                        }
                        "template_card_event" => {
                            self.handle_template_card_event(&body, &req_id, &ws_sink)
                                .await;
                        }
                        "disconnected_event" => {
                            println!("[WeCom] Disconnected by server (new connection established)");
                        }
                        "feedback_event" => {
                            let feedback = body
                                .get("event")
                                .and_then(|e| e.get("feedback"))
                                .and_then(|f| f.as_str())
                                .unwrap_or("unknown");
                            println!("[WeCom] User feedback received: {}", feedback);
                        }
                        _ => {
                            println!("[WeCom] Unhandled event type: {}", eventtype);
                        }
                    }
                }
            }
            "" => {
                // WeCom acknowledgment/response — route to pending waiters or log errors
                let raw: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
                let req_id = raw
                    .get("headers")
                    .and_then(|h| h.get("req_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // If someone is waiting for this req_id, deliver the response
                if !req_id.is_empty() {
                    let mut pending = self.pending_responses.lock().await;
                    if let Some(tx) = pending.remove(req_id) {
                        let _ = tx.send(raw.clone());
                        return;
                    }
                }

                // Otherwise log errors as before
                if let Some(body) = &msg.body {
                    let errcode = body.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                    if errcode != 0 {
                        let errmsg = body.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                    }
                }
                let errcode = raw.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                if errcode != 0 {
                    let errmsg = raw.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                    eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                }
            }
            _ => {
                println!("[WeCom] Unhandled command: {}", msg.cmd);
            }
        }
    }

    async fn handle_message_callback(
        &self,
        msg: WeComMsgCallback,
        req_id: String,
        // The core renders the reply now; the socket is no longer the
        // callback's business.
        _ws_sink: WsSink,
    ) {
        let userid = msg.from.as_ref().map(|f| f.userid.as_str()).unwrap_or("");
        println!(
            "[WeCom] Callback: msgid={}, msgtype={}, chattype={}, userid={}",
            msg.msgid, msg.msgtype, msg.chattype, userid
        );
        // The core pipeline, when the daemon has wired it. Dedup lives inside
        // it (one store for every channel), so this branch sits ABOVE the
        // inline tracker rather than after it — claiming here too would make
        // the core's own claim always lose.
        let core_sink = self.inbound_sink.read().await.clone();
        if let Some(sink) = core_sink {
            let (bot_id, bot_name) = {
                let cfg = self.config.read().await;
                (cfg.bot_id.clone(), cfg.bot_name.clone())
            };
            match normalize_callback(&msg, &bot_id, &req_id, bot_name.as_deref()) {
                Some(inbound) => sink.accept(inbound).await,
                None => println!("[WeCom] Unsupported message type: {}", msg.msgtype),
            }
            return;
        }
    }

    /// Handle enter_chat event — send welcome message
    async fn handle_enter_chat(&self, req_id: &str, ws_sink: &WsSink) {
        use futures_util::SinkExt;

        let locale = i18n::locale();
        let welcome = serde_json::json!({
            "cmd": "aibot_respond_welcome_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "text",
                "text": {
                    "content": i18n::t(i18n::MsgKey::WecomWelcome, locale)
                }
            }
        });

        match ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                welcome.to_string().into(),
            ))
            .await
        {
            Ok(_) => println!("[WeCom] Welcome message sent"),
            Err(e) => eprintln!("[WeCom] Failed to send welcome message: {}", e),
        }
    }

    /// Handle template_card_event — user clicked a button on a template card
    async fn handle_template_card_event(
        &self,
        body: &serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) {
        use futures_util::SinkExt;

        // Extract the clicked button key from the event
        let event = match body.get("event") {
            Some(e) => e,
            None => {
                eprintln!("[WeCom] Template card event missing 'event' field");
                return;
            }
        };

        let selected_key = event
            .get("selected_items")
            .and_then(|items| items.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("key"))
            .and_then(|k| k.as_str())
            .or_else(|| event.get("key").and_then(|k| k.as_str()))
            .unwrap_or("");

        if selected_key.is_empty() {
            println!("[WeCom] Template card event with no selected key");
            return;
        }

        println!("[WeCom] Template card button clicked: key={}", selected_key);

        // Parse key format: "q:{question_id}:{option_index}:{option_value}"
        let parts: Vec<&str> = selected_key.splitn(4, ':').collect();
        if parts.len() < 4 || parts[0] != "q" {
            println!("[WeCom] Unexpected button key format: {}", selected_key);
            return;
        }
        let question_id = parts[1];
        let option_index: usize = parts[2].parse().unwrap_or(0);
        let option_value = parts[3];

        // Answer the pending question
        if let Some(entry) = self
            .pending_questions
            .take_by_question_id(question_id)
            .await
        {
            let _ = entry.answer_tx.send(option_value.to_string());
            println!(
                "[WeCom] Question {} answered via card: {}",
                question_id, option_value
            );
        } else {
            println!("[WeCom] No pending question found for id={}", question_id);
        }

        // Update the card — highlight selected button, grey out others
        let metadata = self.card_metadata.write().await.remove(question_id);
        if let Some(meta) = metadata {
            let button_list: Vec<serde_json::Value> = meta
                .options
                .iter()
                .enumerate()
                .map(|(i, opt)| {
                    let value = opt.value.as_deref().unwrap_or(&opt.label);
                    let (text, style) = if i == option_index {
                        (format!("✓ {}", opt.label), 1) // highlighted
                    } else {
                        (opt.label.clone(), 2) // grey
                    };
                    serde_json::json!({
                        "text": text,
                        "style": style,
                        "key": format!("q:{}:{}:{}", question_id, i, value)
                    })
                })
                .collect();

            let task_id = format!("q:{}", question_id);

            let update_msg = serde_json::json!({
                "cmd": "aibot_respond_update_msg",
                "headers": { "req_id": req_id },
                "body": {
                    "response_type": "update_template_card",
                    "template_card": {
                        "card_type": "button_interaction",
                        "main_title": { "title": "AI Question" },
                        "sub_title_text": meta.question_text,
                        "button_list": button_list,
                        "task_id": task_id
                    }
                }
            });

            match ws_sink
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    update_msg.to_string().into(),
                ))
                .await
            {
                Ok(_) => println!("[WeCom] Card updated: task_id={}", task_id),
                Err(e) => eprintln!("[WeCom] Failed to update card: {}", e),
            }
        }
    }

    /// Send a template card with buttons for a question that has options.
    /// Currently unused: WeCom doesn't render template_card after a stream
    /// response on the same req_id, and aibot_send_msg with template_card
    /// also fails to deliver. Kept for future investigation.
    #[allow(dead_code)]
    async fn send_question_card(
        &self,
        question_id: &str,
        question_text: &str,
        options: &[super::pending_question::QuestionOption],
        ws_sink: &WsSink,
        chatid: &str,
        chat_type: u32,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let button_list: Vec<serde_json::Value> = options
            .iter()
            .enumerate()
            .map(|(i, opt)| {
                let value = opt.value.as_deref().unwrap_or(&opt.label);
                serde_json::json!({
                    "text": opt.label,
                    "style": 1,
                    "key": format!("q:{}:{}:{}", question_id, i, value)
                })
            })
            .collect();

        let task_id = format!("q:{}", question_id);

        let card_msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": "template_card",
                "template_card": {
                    "card_type": "button_interaction",
                    "main_title": { "title": "AI Question" },
                    "sub_title_text": question_text,
                    "button_list": button_list,
                    "task_id": task_id
                }
            }
        });

        println!(
            "[WeCom] Sending question card via aibot_send_msg: chatid={}, chat_type={}, task_id={}, payload={}",
            chatid, chat_type, task_id, card_msg
        );

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                card_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send question card: {}", e))?;

        // Store metadata for card update when button is clicked
        self.card_metadata.write().await.insert(
            question_id.to_string(),
            CardMetadata {
                question_text: question_text.to_string(),
                options: options.to_vec(),
            },
        );

        println!(
            "[WeCom] Question card sent successfully: task_id={}",
            task_id
        );
        Ok(())
    }

    /// Static version of send_stream_chunk for use in spawned tasks (no &self needed)
    async fn send_stream_chunk_static(
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": content,
                },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))
    }

    /// Send a proactive message to a WeCom conversation via aibot_send_msg.
    /// Requires the gateway to be connected and the target user to have
    /// previously messaged the bot in that conversation.
    pub async fn send_chat_message(
        &self,
        chatid: &str,
        chat_type: u32,
        text: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self.shared_ws_sink.read().await.clone().ok_or_else(|| {
            "WeCom gateway is not connected. Cannot send proactive message.".to_string()
        })?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": "markdown",
                "markdown": { "content": text }
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send proactive message: {}", e))?;

        println!(
            "[WeCom] Proactive message sent to chatid={}, chat_type={}",
            chatid, chat_type
        );
        Ok(())
    }

    /// Send a WS command and wait for the response (matched by req_id).
    async fn ws_request(
        &self,
        msg: serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) -> Result<serde_json::Value, String> {
        use futures_util::SinkExt;

        let (tx, rx) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(req_id.to_string(), tx);

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| {
                // Clean up on send failure
                let pending = self.pending_responses.clone();
                let rid = req_id.to_string();
                tokio::spawn(async move {
                    pending.lock().await.remove(&rid);
                });
                format!("Failed to send WS request: {}", e)
            })?;

        tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| "WS request timed out".to_string())?
            .map_err(|_| "WS response channel closed".to_string())
    }

    /// Upload media data to WeCom via the 3-step WebSocket upload protocol.
    /// `media_type` is one of: "image", "voice", "video", "file".
    /// Returns the media_id on success.
    async fn upload_media(
        &self,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<String, String> {
        let md5_hash = format!("{:x}", md5::compute(data));
        let total_size = data.len();
        const CHUNK_SIZE: usize = 512 * 1024; // Max 512KB per chunk
        let total_chunks = total_size.div_ceil(CHUNK_SIZE);

        // Step 1: Init
        let init_req_id = uuid::Uuid::new_v4().to_string();
        let init_msg = serde_json::json!({
            "cmd": "aibot_upload_media_init",
            "headers": { "req_id": &init_req_id },
            "body": {
                "type": media_type,
                "filename": filename,
                "total_size": total_size,
                "total_chunks": total_chunks,
                "md5": &md5_hash,
            }
        });
        let init_resp = self.ws_request(init_msg, &init_req_id, ws_sink).await?;
        let upload_id = init_resp
            .get("body")
            .and_then(|b| b.get("upload_id"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| {
                format!(
                    "No upload_id in init response: {}",
                    serde_json::to_string(&init_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload init: type={}, upload_id={}, chunks={}",
            media_type, upload_id, total_chunks
        );

        // Step 2: Upload chunks
        for i in 0..total_chunks {
            let start = i * CHUNK_SIZE;
            let end = (start + CHUNK_SIZE).min(total_size);
            let chunk_data = base64::engine::general_purpose::STANDARD.encode(&data[start..end]);

            let chunk_req_id = uuid::Uuid::new_v4().to_string();
            let chunk_msg = serde_json::json!({
                "cmd": "aibot_upload_media_chunk",
                "headers": { "req_id": &chunk_req_id },
                "body": {
                    "upload_id": &upload_id,
                    "chunk_index": i,
                    "base64_data": &chunk_data,
                }
            });
            let chunk_resp = self.ws_request(chunk_msg, &chunk_req_id, ws_sink).await?;
            let errcode = chunk_resp
                .get("body")
                .and_then(|b| b.get("errcode"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            if errcode != 0 {
                return Err(format!("Upload chunk {} failed: {:?}", i, chunk_resp));
            }
        }

        // Step 3: Finish
        let finish_req_id = uuid::Uuid::new_v4().to_string();
        let finish_msg = serde_json::json!({
            "cmd": "aibot_upload_media_finish",
            "headers": { "req_id": &finish_req_id },
            "body": {
                "upload_id": &upload_id,
            }
        });
        let finish_resp = self.ws_request(finish_msg, &finish_req_id, ws_sink).await?;
        let media_id = finish_resp
            .get("body")
            .and_then(|b| b.get("media_id"))
            .and_then(|m| m.as_str())
            .ok_or_else(|| {
                format!(
                    "No media_id in finish response: {}",
                    serde_json::to_string(&finish_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload complete: type={}, media_id={}",
            media_type,
            &media_id[..media_id.len().min(20)]
        );
        Ok(media_id)
    }

    /// Send a media message as a reply (image/voice/video/file).
    #[allow(dead_code)]
    async fn send_media_reply(
        &self,
        req_id: &str,
        media_id: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send {} reply: {}", media_type, e))
    }

    /// Upload file bytes and send as a reply. Convenience wrapper.
    #[allow(dead_code)]
    async fn upload_and_send_media_reply(
        &self,
        req_id: &str,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        let media_id = self
            .upload_media(data, filename, media_type, ws_sink)
            .await?;
        self.send_media_reply(req_id, &media_id, media_type, ws_sink)
            .await
    }

    /// Proactive send wrapper for the `amuxd mcp-server` MCP `send` tool.
    /// `user_id` is a WeCom internal/external userid; chat_type is fixed at
    /// 1 (single chat). Optionally uploads + sends a file before the text.
    pub async fn send_to_user_with_optional_media(
        &self,
        user_id: &str,
        text: &str,
        media: Option<(Vec<u8>, String)>,
    ) -> Result<(), String> {
        if let Some((bytes, filename)) = media {
            let ws_sink = self
                .shared_ws_sink
                .read()
                .await
                .clone()
                .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;
            let media_type = detect_media_type(&filename);
            let media_id = self
                .upload_media(&bytes, &filename, media_type, &ws_sink)
                .await?;
            self.send_media_to_chat(user_id, 1, &media_id, media_type)
                .await?;
        }
        if !text.is_empty() {
            self.send_chat_message(user_id, 1, text).await?;
        }
        Ok(())
    }

    /// Proactive send wrapper for the `amuxd mcp-server` MCP `send` tool.
    /// `chat_id` is a WeCom group chat id; chat_type is fixed at 2 (group).
    /// Optionally uploads + sends a file before the text.
    pub async fn send_to_chat_with_optional_media(
        &self,
        chat_id: &str,
        text: &str,
        media: Option<(Vec<u8>, String)>,
    ) -> Result<(), String> {
        if let Some((bytes, filename)) = media {
            let ws_sink = self
                .shared_ws_sink
                .read()
                .await
                .clone()
                .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;
            let media_type = detect_media_type(&filename);
            let media_id = self
                .upload_media(&bytes, &filename, media_type, &ws_sink)
                .await?;
            self.send_media_to_chat(chat_id, 2, &media_id, media_type)
                .await?;
        }
        if !text.is_empty() {
            self.send_chat_message(chat_id, 2, text).await?;
        }
        Ok(())
    }

    /// Send a media message proactively to a chat (image/voice/video/file).
    pub async fn send_media_to_chat(
        &self,
        chatid: &str,
        chat_type: u32,
        media_id: &str,
        media_type: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self
            .shared_ws_sink
            .read()
            .await
            .clone()
            .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        let text = msg.to_string();
        let mut guard = ws_sink.lock().await;
        guard
            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await
            .map_err(|e| format!("Failed to send {}: {}", media_type, e))
    }
}

/// Map a filename to a WeCom `msgtype` string (`image` / `voice` / `video` /
/// `file`). Used by the proactive-send wrappers (and the MCP `send` tool)
/// to pick the right upload protocol from a bare file path.
fn detect_media_type(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => "image",
        "mp3" | "amr" | "wav" | "ogg" | "m4a" | "aac" => "voice",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" => "video",
        _ => "file",
    }
}

/// Send a proactive message to a WeCom conversation.
/// Called by cron delivery and other modules that don't have direct gateway access.
/// Requires the WeCom gateway to be running and connected.
pub async fn send_proactive_message(
    chatid: &str,
    chat_type: u32,
    text: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending proactive messages.".to_string()
        })?;

    gateway.send_chat_message(chatid, chat_type, text).await
}

/// Upload media and send it to a WeCom conversation.
/// `media_type` is one of: "image", "voice", "video", "file".
/// Called by the introspect API for MCP media sending.
pub async fn upload_and_send_media(
    chatid: &str,
    chat_type: u32,
    data: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending media."
                .to_string()
        })?;

    let ws_sink = gateway
        .shared_ws_sink
        .read()
        .await
        .clone()
        .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

    let media_id = gateway
        .upload_media(data, filename, media_type, &ws_sink)
        .await?;
    gateway
        .send_media_to_chat(chatid, chat_type, &media_id, media_type)
        .await
}

#[cfg(test)]
mod mime_tests {
    use super::*;

    const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    #[test]
    fn magic_detects_png() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_mime_from_magic(&bytes).as_deref(), Some("image/png"));
    }

    #[test]
    fn magic_detects_zip_for_ooxml_local_file_header() {
        // Every xlsx/docx/pptx file starts with the ZIP local file header.
        let bytes = [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00];
        assert_eq!(
            detect_mime_from_magic(&bytes).as_deref(),
            Some("application/zip")
        );
    }

    #[test]
    fn magic_detects_legacy_office_compound_doc() {
        let bytes = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00];
        assert_eq!(
            detect_mime_from_magic(&bytes).as_deref(),
            Some("application/x-cfb")
        );
    }

    #[test]
    fn filename_detects_xlsx() {
        assert_eq!(
            detect_mime_from_filename("report.xlsx").as_deref(),
            Some(XLSX_MIME)
        );
    }

    #[test]
    fn resolve_mime_xlsx_with_filename_returns_ooxml_subtype() {
        // PK header + filename → filename wins so we get the precise OOXML mime.
        let bytes = [0x50, 0x4B, 0x03, 0x04];
        assert_eq!(resolve_mime(&bytes, Some("quarterly.xlsx")), XLSX_MIME);
    }

    #[test]
    fn resolve_mime_plain_zip_without_filename_returns_zip() {
        // A minimal ZIP header with no recognizable OOXML entries → application/zip.
        let bytes = [0x50, 0x4B, 0x03, 0x04];
        let mime = resolve_mime(&bytes, None);
        assert_eq!(mime, "application/zip");
        assert_ne!(mime, "image/png");
    }

    #[test]
    fn detect_ooxml_xlsx_from_zip_entries() {
        // Simulate a minimal xlsx ZIP with an entry named "xl/workbook.xml"
        let entry_name = b"xl/workbook.xml";
        let mut bytes = Vec::new();
        // Local file header
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]); // signature
        bytes.extend_from_slice(&[0x14, 0x00]); // version needed
        bytes.extend_from_slice(&[0x00, 0x00]); // flags
        bytes.extend_from_slice(&[0x00, 0x00]); // compression method (stored)
        bytes.extend_from_slice(&[0x00, 0x00]); // last mod time
        bytes.extend_from_slice(&[0x00, 0x00]); // last mod date
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // crc32
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // compressed size
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // uncompressed size
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes()); // filename length
        bytes.extend_from_slice(&[0x00, 0x00]); // extra field length
        bytes.extend_from_slice(entry_name); // filename
        let mime = resolve_mime(&bytes, None);
        assert_eq!(mime, XLSX_MIME);
    }

    #[test]
    fn detect_ooxml_docx_from_zip_entries() {
        // Simulate a minimal docx ZIP with an entry named "word/document.xml"
        let entry_name = b"word/document.xml";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
        bytes.extend_from_slice(&[0x14, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(entry_name);
        let mime = resolve_mime(&bytes, None);
        assert_eq!(
            mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
    }

    #[test]
    fn detect_ooxml_pptx_from_zip_entries() {
        // Simulate a minimal pptx ZIP with an entry named "ppt/presentation.xml"
        let entry_name = b"ppt/presentation.xml";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
        bytes.extend_from_slice(&[0x14, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(entry_name);
        let mime = resolve_mime(&bytes, None);
        assert_eq!(
            mime,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
    }

    #[test]
    fn content_disposition_extracts_filename() {
        assert_eq!(
            extract_filename_from_content_disposition(r#"attachment; filename="report.xlsx""#),
            Some("report.xlsx".to_string())
        );
    }

    #[test]
    fn content_disposition_extracts_utf8_filename() {
        assert_eq!(
            extract_filename_from_content_disposition(
                "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx"
            ),
            Some("\u{62a5}\u{8868}.xlsx".to_string())
        );
    }

    #[test]
    fn content_disposition_returns_none_for_missing() {
        assert_eq!(
            extract_filename_from_content_disposition("attachment"),
            None
        );
    }

    #[test]
    fn resolve_mime_unknown_bytes_no_filename_returns_octet_stream() {
        // Regression: previously defaulted to image/png.
        let bytes = [0x00, 0x01, 0x02, 0x03];
        assert_eq!(resolve_mime(&bytes, None), "application/octet-stream");
    }

    #[test]
    fn resolve_mime_filename_without_extension_falls_through_to_magic() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(resolve_mime(&bytes, Some("noext")), "image/png");
    }

    #[test]
    fn mime_to_ext_xlsx() {
        assert_eq!(mime_to_ext(XLSX_MIME), "xlsx");
    }

    #[test]
    fn mime_to_ext_unknown_returns_bin() {
        assert_eq!(mime_to_ext("application/x-totally-unknown"), "bin");
    }

    #[test]
    fn ext_from_filename_xlsx_with_chinese_stem() {
        assert_eq!(ext_from_filename("Q3 报表.xlsx"), Some("xlsx".to_string()));
    }

    #[test]
    fn ext_from_filename_uppercase_normalized() {
        assert_eq!(ext_from_filename("DOC.PDF"), Some("pdf".to_string()));
    }

    #[test]
    fn ext_from_filename_no_dot_returns_none() {
        assert_eq!(ext_from_filename("noext"), None);
    }

    #[test]
    fn ext_from_filename_dotfile_returns_none() {
        assert_eq!(ext_from_filename(".hidden"), None);
    }

    #[test]
    fn ext_from_filename_trailing_dot_returns_none() {
        assert_eq!(ext_from_filename("name."), None);
    }

    #[test]
    fn ext_from_filename_non_alphanumeric_extension_returns_none() {
        // Defends against weird extensions that could break filename construction.
        assert_eq!(ext_from_filename("foo.tar/gz"), None);
    }
}

#[cfg(test)]
mod message_parts_tests {
    use super::*;
    use serde_json::json;

    fn callback(body: serde_json::Value) -> WeComMsgCallback {
        serde_json::from_value(body).expect("callback deserializes")
    }

    #[test]
    fn mixed_carries_both_the_image_and_its_caption() {
        // Verbatim shape of a real callback: sending a picture with a caption
        // produces one `mixed` message, not an image message plus a text one.
        let msg = callback(json!({
            "msgid": "886f61f00519e05f33d53a7558b1e1d5",
            "chattype": "single",
            "msgtype": "mixed",
            "mixed": { "msg_item": [
                { "msgtype": "image", "image": {
                    "url": "https://ww-aibot-img.example/7674552250407683094?sign=x",
                    "aeskey": "Bu9DZx23TKmJ5h3ypCH0vYTMHWcIOU40rm0RyZxb4Lc"
                }},
                { "msgtype": "text", "text": { "content": "你能收到图片吗？" }}
            ]}
        }));

        let (text, media) = extract_message_parts(&msg).expect("mixed is handled");
        assert_eq!(text, "你能收到图片吗？");
        assert_eq!(
            media,
            vec![PendingMedia {
                url: "https://ww-aibot-img.example/7674552250407683094?sign=x".into(),
                aeskey: Some("Bu9DZx23TKmJ5h3ypCH0vYTMHWcIOU40rm0RyZxb4Lc".into()),
                filename_hint: None,
            }]
        );
    }

    #[test]
    fn mixed_keeps_every_attachment_and_joins_the_text() {
        let msg = callback(json!({
            "msgtype": "mixed",
            "mixed": { "msg_item": [
                { "msgtype": "text", "text": { "content": "first" }},
                { "msgtype": "image", "image": { "url": "https://x/1", "aeskey": "k1" }},
                { "msgtype": "file", "file": {
                    "url": "https://x/2", "aeskey": "k2", "filename": "report.xlsx"
                }},
                { "msgtype": "text", "text": { "content": "second" }}
            ]}
        }));

        let (text, media) = extract_message_parts(&msg).expect("mixed is handled");
        assert_eq!(text, "first\nsecond");
        assert_eq!(media.len(), 2);
        assert_eq!(media[1].filename_hint.as_deref(), Some("report.xlsx"));
    }

    #[test]
    fn mixed_of_unknown_items_only_yields_nothing_but_is_still_handled() {
        // Handled (not `None`) so the caller's empty-message drop applies rather
        // than the "unsupported type" path.
        let msg = callback(json!({
            "msgtype": "mixed",
            "mixed": { "msg_item": [{ "msgtype": "voice", "voice": { "content": "hi" }}] }
        }));

        let (text, media) = extract_message_parts(&msg).expect("mixed is handled");
        assert!(text.is_empty());
        assert!(media.is_empty());
    }

    #[test]
    fn bare_image_still_yields_one_media_item() {
        let msg = callback(json!({
            "msgtype": "image",
            "image": { "url": "https://x/1", "aeskey": "k1" }
        }));

        let (text, media) = extract_message_parts(&msg).expect("image is handled");
        assert!(text.is_empty());
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].aeskey.as_deref(), Some("k1"));
    }

    #[test]
    fn image_url_falls_back_to_legacy_field_names() {
        let msg = callback(json!({ "msgtype": "image", "image": { "pic_url": "https://x/1" }}));
        let (_, media) = extract_message_parts(&msg).expect("image is handled");
        assert_eq!(media[0].url, "https://x/1");
        assert_eq!(media[0].aeskey, None);
    }

    #[test]
    fn image_without_any_url_yields_no_media() {
        let msg = callback(json!({ "msgtype": "image", "image": { "aeskey": "k1" }}));
        let (_, media) = extract_message_parts(&msg).expect("image is handled");
        assert!(media.is_empty());
    }

    #[test]
    fn text_and_voice_map_to_their_content() {
        let text_msg = callback(json!({ "msgtype": "text", "text": { "content": "hello" }}));
        assert_eq!(extract_message_parts(&text_msg).unwrap().0, "hello");

        let voice_msg = callback(json!({ "msgtype": "voice", "voice": { "content": "spoken" }}));
        assert_eq!(extract_message_parts(&voice_msg).unwrap().0, "spoken");
    }

    #[test]
    fn genuinely_unknown_msgtype_is_rejected() {
        let msg = callback(json!({ "msgtype": "video", "video": { "url": "https://x/1" }}));
        assert!(extract_message_parts(&msg).is_none());
    }
}

#[cfg(test)]
mod stream_frame_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn a_burst_of_updates_collapses_to_the_newest() {
        let (tx, mut rx) = mpsc::channel::<String>(8);
        for text in ["He", "Hell", "Hello wo", "Hello world"] {
            tx.send(text.to_string()).await.unwrap();
        }
        let first = rx.recv().await.unwrap();
        assert_eq!(drain_to_latest(first, &mut rx), "Hello world");
    }

    #[tokio::test]
    async fn a_lone_update_survives_unchanged() {
        let (tx, mut rx) = mpsc::channel::<String>(8);
        tx.send("only".to_string()).await.unwrap();
        let first = rx.recv().await.unwrap();
        assert_eq!(drain_to_latest(first, &mut rx), "only");
    }

    #[test]
    fn version_conflict_ack_is_read_as_a_rejection() {
        // The shape WeCom actually sent when the reply went missing.
        let ack = json!({
            "errcode": 6000,
            "errmsg": "more than one callers at the same time, data version conflict. please retry later"
        });
        assert_eq!(ack_errcode(&ack), 6000);
    }

    #[test]
    fn rejection_nested_under_body_is_found_too() {
        assert_eq!(ack_errcode(&json!({ "body": { "errcode": 45033 }})), 45033);
    }

    #[test]
    fn a_clean_ack_reads_as_success() {
        assert_eq!(ack_errcode(&json!({ "errcode": 0, "body": {}})), 0);
        assert_eq!(ack_errcode(&json!({ "body": { "msgid": "x" }})), 0);
    }
}

#[cfg(test)]
mod progress_line_tests {
    use super::*;

    #[test]
    fn the_progress_line_is_the_newest_line_not_the_first() {
        // The turn reports cumulative text; the reader wants to see where the
        // agent is now, not where it started.
        let text = "第一行\n第二行\n第三行";
        assert_eq!(newest_line(text).unwrap(), "第三行");
    }

    #[test]
    fn a_long_line_is_truncated_by_characters_not_bytes() {
        // Slicing bytes through a Chinese reply panics, and this runs on every
        // frame of every turn.
        let line = "中".repeat(100);
        let out = newest_line(&line).unwrap();
        assert_eq!(out.chars().count(), PROGRESS_LINE_CHARS + 1, "40 chars + …");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn fence_and_heading_markers_do_not_leak_into_the_bubble() {
        // `stream` is plain text, so markdown syntax shows up as characters in
        // exactly the place it cannot be rendered.
        assert_eq!(newest_line("答案\n```python").unwrap(), "答案");
        assert_eq!(newest_line("## 标题").unwrap(), "标题");
        assert_eq!(newest_line("- 列表项").unwrap(), "列表项");
    }

    #[test]
    fn a_stopped_turn_and_a_finished_one_close_differently() {
        // WeCom cannot delete this bubble, so whatever it says is what the
        // chat keeps. "Done" above a turn the user cancelled is a lie it keeps
        // telling.
        assert_ne!(PROGRESS_DONE, PROGRESS_CANCELLED);
        assert!(PROGRESS_CANCELLED.contains("已取消"));
    }

    #[test]
    fn text_with_nothing_showable_falls_back_to_no_line() {
        assert!(newest_line("").is_none());
        assert!(newest_line("   \n\n  ").is_none());
        assert!(newest_line("###").is_none());
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::*;
    use serde_json::json;

    fn callback(v: serde_json::Value) -> WeComMsgCallback {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_dm_keys_on_the_user_because_there_is_no_chat_id() {
        let msg = callback(json!({
            "msgid": "m-1",
            "chattype": "single",
            "msgtype": "text",
            "from": { "userid": "u-42" },
            "text": { "content": "hello" },
        }));
        let inbound = normalize_callback(&msg, "bot-a", "req-1", None).unwrap();
        assert_eq!(inbound.conversation.kind, driver::ConversationKind::Direct);
        assert_eq!(inbound.conversation.id, "u-42");
        assert_eq!(inbound.conversation.bot_id.as_deref(), Some("bot-a"));
        assert_eq!(inbound.sender.external_id, "u-42");
        assert_eq!(inbound.text, "hello");
        assert_eq!(inbound.external_message_id, "m-1");
    }

    #[test]
    fn a_group_keys_on_the_chat_and_loses_the_mention_prefix() {
        // WeCom puts the mention in the text. Leaving it in means every group
        // turn starts with a bot name the agent has to learn to ignore, and a
        // slash command in a group would not parse as one.
        let msg = callback(json!({
            "msgid": "m-2",
            "chatid": "chat-9",
            "chattype": "group",
            "msgtype": "text",
            "from": { "userid": "u-7" },
            "text": { "content": "@蕉你一手 /help" },
        }));
        let inbound = normalize_callback(&msg, "bot-a", "req-1", None).unwrap();
        assert_eq!(inbound.conversation.kind, driver::ConversationKind::Group);
        assert_eq!(inbound.conversation.id, "chat-9");
        assert_eq!(inbound.text, "/help");
        assert!(inbound.addressed_to_bot);
    }

    #[test]
    fn a_multi_word_bot_name_does_not_eat_the_command() {
        // Real payload from a live group: the bot is called "Matt chow的机器人 1".
        // Cutting at the first space left "chow的机器人 1 /help", which does not
        // start with a slash — so every command in every group was answered by
        // the model as if it were chat.
        let text = "@Matt chow的机器人 1 /help";
        let group = driver::ConversationKind::Group;
        assert_eq!(
            strip_group_mention_prefix(text, group, Some("Matt chow的机器人 1")),
            "/help"
        );
        // Same result with no name configured: the slash token pins it.
        assert_eq!(strip_group_mention_prefix(text, group, None), "/help");
    }

    #[test]
    fn a_path_in_the_body_is_not_mistaken_for_a_command() {
        // The slash fallback must not fire on "看看 /tmp/x" — a name-shaped
        // prefix followed by a path is still a chat message.
        let group = driver::ConversationKind::Group;
        assert_eq!(
            strip_group_mention_prefix("@Bot 看看 /tmp/x", group, Some("Bot")),
            "看看 /tmp/x"
        );
        // Without the name we fall back to the first space, as before.
        assert_eq!(
            strip_group_mention_prefix("@Bot 看看 /tmp/x", group, None),
            "看看 /tmp/x"
        );
    }

    #[test]
    fn a_renamed_bot_still_gets_its_commands() {
        // The configured name no longer matches what WeCom sends; the slash
        // token is what keeps `/stop` working until someone fixes the config.
        let group = driver::ConversationKind::Group;
        assert_eq!(
            strip_group_mention_prefix("@New Name Here /stop", group, Some("Old Name")),
            "/stop"
        );
    }

    #[test]
    fn a_bare_mention_normalizes_to_empty_rather_than_to_the_bot_name() {
        let msg = callback(json!({
            "msgid": "m-3",
            "chatid": "chat-9",
            "chattype": "group",
            "msgtype": "text",
            "from": { "userid": "u-7" },
            "text": { "content": "@bot" },
        }));
        let inbound = normalize_callback(&msg, "bot-a", "req-1", None).unwrap();
        assert_eq!(inbound.text, "");
    }

    #[test]
    fn quoted_text_is_carried_but_not_interpreted() {
        // The core decides what a quote means (context, or an answer to a
        // pending question). The driver only reports that there was one.
        let msg = callback(json!({
            "msgid": "m-4",
            "chattype": "single",
            "msgtype": "text",
            "from": { "userid": "u-7" },
            "text": { "content": "yes" },
            "quote": { "msgtype": "text", "text": { "content": "pick one: a or b" } },
        }));
        let inbound = normalize_callback(&msg, "bot-a", "req-1", None).unwrap();
        assert_eq!(inbound.quoted_text.as_deref(), Some("pick one: a or b"));
        assert_eq!(inbound.text, "yes");
    }

    #[test]
    fn an_empty_quote_is_absent_not_empty_string() {
        let msg = callback(json!({
            "msgid": "m-5",
            "chattype": "single",
            "msgtype": "text",
            "from": { "userid": "u-7" },
            "text": { "content": "hi" },
            "quote": { "msgtype": "text", "text": { "content": "" } },
        }));
        assert!(normalize_callback(&msg, "bot-a", "req-1", None)
            .unwrap()
            .quoted_text
            .is_none());
    }

    #[test]
    fn attachments_are_referenced_not_downloaded() {
        // The whole point of deferring: a text-only message must not wait on a
        // download, and normalization must stay pure enough to unit-test.
        let msg = callback(json!({
            "msgid": "m-6",
            "chattype": "single",
            "msgtype": "image",
            "from": { "userid": "u-7" },
            "image": { "url": "https://wecom.example/media/1", "aeskey": "k" },
        }));
        let inbound = normalize_callback(&msg, "bot-a", "req-1", None).unwrap();
        assert_eq!(inbound.attachments.len(), 1);
        assert!(matches!(
            inbound.attachments[0].source,
            driver::AttachmentSource::Deferred(_)
        ));
    }

    #[test]
    fn an_unusable_msgtype_is_dropped() {
        let msg = callback(json!({
            "msgid": "m-7",
            "chattype": "single",
            "msgtype": "event",
            "from": { "userid": "u-7" },
        }));
        assert!(normalize_callback(&msg, "bot-a", "req-1", None).is_none());
    }

    #[test]
    fn a_missing_bot_id_is_absent_rather_than_an_empty_string() {
        // An empty bot_id would key a distinct conversation from "no bot id",
        // and the two would drift apart in the router.
        let msg = callback(json!({
            "msgid": "m-8",
            "chattype": "single",
            "msgtype": "text",
            "from": { "userid": "u-7" },
            "text": { "content": "hi" },
        }));
        assert!(normalize_callback(&msg, "", "req-1", None)
            .unwrap()
            .conversation
            .bot_id
            .is_none());
    }
}
