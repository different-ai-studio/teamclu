//! Resolve session attachment URLs into runtime-ready payloads.
//!
//! Cloud clients upload attachments to storage and pass HTTPS URLs in
//! `attachment_urls`. opencode serve requires image `File` parts to use
//! `data:` URLs; pi/claude/cursor backends also need inline data URLs rather
//! than bare storage links. Non-image files are downloaded to
//! `~/.amuxd/attachments/<session_id>/` and referenced by local path in the
//! prompt text.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use tracing::warn;

static IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "heic", "heif",
];

/// Longest edge cap for images inlined into prompts.
const PROMPT_IMAGE_MAX_DIMENSION: u32 = 2048;
/// Images at or below this byte size are inlined as-is.
const PROMPT_IMAGE_SKIP_BELOW_BYTES: usize = 512 * 1024;

/// A storage URL resolved for prompt delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAttachment {
    /// Image bytes encoded as `data:{mime};base64,...`.
    Image {
        source_url: String,
        data_url: String,
        mime: String,
        filename: Option<String>,
    },
    /// Non-image file saved under `~/.amuxd/attachments/<session_id>/`.
    LocalFile {
        source_url: String,
        path: String,
        filename: String,
        mime: String,
    },
    /// Non-image file referenced by its original HTTPS URL (download failed).
    Link {
        source_url: String,
        url: String,
        filename: String,
        mime: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEntry {
    pub source_url: String,
    pub attachment: ResolvedAttachment,
}

/// Non-image attachments above this size are rejected before caching.
const MAX_NON_IMAGE_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Return the (path-without-query, extension) for a URL.
pub fn path_and_ext(url: &str) -> (&str, String) {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    (path, ext)
}

pub fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn filename_from_path(path: &str) -> String {
    path.rsplit('/').next().unwrap_or("attachment").to_string()
}

pub fn format_data_url(mime: &str, bytes: &[u8]) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{data}")
}

fn attachment_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("attachment reqwest client")
    })
}

fn attachment_cache_dir(session_id: &str) -> PathBuf {
    let base = if cfg!(test) {
        std::env::temp_dir().join("amuxd-test-attachments")
    } else {
        crate::config::layout::active_state_dir().join("attachments")
    };
    base.join(sanitize_for_filename(session_id))
}

/// Stable cache identity — ignores signed-URL query tokens and fragments.
fn attachment_cache_key(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or(url);
    without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment)
        .to_string()
}

fn cache_filename(url: &str, filename: &str) -> String {
    let mut hasher = DefaultHasher::new();
    attachment_cache_key(url).hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());
    let short = &hash[..8.min(hash.len())];
    format!("{short}_{filename}")
}

fn local_cache_path(session_id: &str, url: &str, filename: &str) -> PathBuf {
    attachment_cache_dir(session_id).join(cache_filename(url, filename))
}

async fn cached_non_image_attachment(
    url: &str,
    session_id: &str,
    ext: &str,
    filename: &str,
) -> Option<ResolvedAttachment> {
    let local_path = local_cache_path(session_id, url, filename);
    let meta = tokio::fs::metadata(&local_path).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    if len == 0 || len > MAX_NON_IMAGE_ATTACHMENT_BYTES as u64 {
        return None;
    }
    Some(ResolvedAttachment::LocalFile {
        source_url: url.to_string(),
        path: local_path.to_string_lossy().into_owned(),
        filename: filename.to_string(),
        mime: mime_from_ext(ext).to_string(),
    })
}

/// True when the URL path looks like an image we must inline as a data URL.
pub fn is_image_attachment_url(url: &str) -> bool {
    IMAGE_EXTS.contains(&path_and_ext(url).1.as_str())
}

/// Download and resolve attachment URLs. On fetch/decode failure, falls back
/// to the original HTTPS link so text backends still see the reference.
pub async fn resolve_all(urls: &[String], session_id: &str) -> Vec<ResolvedEntry> {
    let mut out = Vec::with_capacity(urls.len());
    for url in urls {
        match resolve_one(url, session_id).await {
            Ok(attachment) => out.push(ResolvedEntry {
                source_url: url.clone(),
                attachment,
            }),
            Err(err) => {
                warn!(url = %url, err = %err, "attachment fetch failed; using remote link fallback");
                let (path, ext) = path_and_ext(url);
                out.push(ResolvedEntry {
                    source_url: url.clone(),
                    attachment: ResolvedAttachment::Link {
                        source_url: url.clone(),
                        url: url.clone(),
                        filename: filename_from_path(path),
                        mime: mime_from_ext(&ext).to_string(),
                    },
                });
            }
        }
    }
    out
}

async fn resolve_one(url: &str, session_id: &str) -> anyhow::Result<ResolvedAttachment> {
    if url.starts_with("data:") {
        let mime = url
            .strip_prefix("data:")
            .and_then(|rest| rest.split(';').next())
            .unwrap_or("application/octet-stream")
            .to_string();
        return Ok(ResolvedAttachment::Image {
            source_url: url.to_string(),
            data_url: url.to_string(),
            mime,
            filename: None,
        });
    }

    let (path, ext) = path_and_ext(url);
    let filename = filename_from_path(path);

    if IMAGE_EXTS.contains(&ext.as_str()) {
        let bytes = attachment_client()
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .to_vec();
        let mime = mime_from_ext(&ext);
        let (bytes, mime) = compress_image_for_prompt(bytes, mime).await;
        let data_url = format_data_url(mime, &bytes);
        return Ok(ResolvedAttachment::Image {
            source_url: url.to_string(),
            data_url,
            mime: mime.to_string(),
            filename: Some(filename),
        });
    }

    if let Some(cached) = cached_non_image_attachment(url, session_id, &ext, &filename).await {
        return Ok(cached);
    }

    let bytes = attachment_client()
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    if let Some(len) = bytes.content_length() {
        if len as usize > MAX_NON_IMAGE_ATTACHMENT_BYTES {
            anyhow::bail!(
                "attachment exceeds {} byte limit (content-length {})",
                MAX_NON_IMAGE_ATTACHMENT_BYTES,
                len
            );
        }
    }
    let bytes = bytes.bytes().await?.to_vec();

    if bytes.len() > MAX_NON_IMAGE_ATTACHMENT_BYTES {
        anyhow::bail!(
            "attachment exceeds {} byte limit (got {} bytes)",
            MAX_NON_IMAGE_ATTACHMENT_BYTES,
            bytes.len()
        );
    }

    let cache_dir = attachment_cache_dir(session_id);
    tokio::fs::create_dir_all(&cache_dir).await?;
    let local_path = local_cache_path(session_id, url, &filename);
    tokio::fs::write(&local_path, &bytes).await?;

    Ok(ResolvedAttachment::LocalFile {
        source_url: url.to_string(),
        path: local_path.to_string_lossy().into_owned(),
        filename,
        mime: mime_from_ext(&ext).to_string(),
    })
}

async fn compress_image_for_prompt(bytes: Vec<u8>, mime: &'static str) -> (Vec<u8>, &'static str) {
    if mime == "image/gif" || bytes.len() <= PROMPT_IMAGE_SKIP_BELOW_BYTES {
        return (bytes, mime);
    }
    let original_len = bytes.len();
    let input = bytes.clone();
    let compressed = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let img = match image::load_from_memory(&input) {
            Ok(img) => img,
            Err(err) => {
                tracing::warn!("attachment image decode failed, inlining original: {err}");
                return None;
            }
        };
        let img = if img.width().max(img.height()) > PROMPT_IMAGE_MAX_DIMENSION {
            img.resize(
                PROMPT_IMAGE_MAX_DIMENSION,
                PROMPT_IMAGE_MAX_DIMENSION,
                image::imageops::FilterType::Triangle,
            )
        } else {
            img
        };
        let mut out = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        if let Err(err) = img.to_rgb8().write_with_encoder(encoder) {
            tracing::warn!("attachment image re-encode failed, inlining original: {err}");
            return None;
        }
        let encoded = out.into_inner();
        (encoded.len() < original_len).then_some(encoded)
    })
    .await;
    match compressed {
        Ok(Some(encoded)) => (encoded, "image/jpeg"),
        Ok(None) => (bytes, mime),
        Err(err) => {
            tracing::warn!("attachment image compression task failed: {err}");
            (bytes, mime)
        }
    }
}

impl ResolvedAttachment {
    pub fn opencode_file_fields(&self) -> (String, String, Option<String>) {
        match self {
            ResolvedAttachment::Image {
                data_url,
                mime,
                filename,
                ..
            } => (mime.clone(), data_url.clone(), filename.clone()),
            ResolvedAttachment::Link {
                url,
                filename,
                mime,
                ..
            } => (mime.clone(), url.clone(), Some(filename.clone())),
            ResolvedAttachment::LocalFile { .. } => {
                // Non-image local files are injected into prompt text, not File parts.
                unreachable!("LocalFile must not be sent as opencode File part")
            }
        }
    }
}

/// Replace cloud `(url: …)` tokens with local `(path: …)` for downloaded files.
pub fn substitute_in_message(message: &mut String, entries: &[ResolvedEntry]) {
    for entry in entries {
        if let ResolvedAttachment::LocalFile { path, .. } = &entry.attachment {
            let url_token = format!("(url: {})", entry.source_url);
            let path_token = format!("(path: {})", path);
            if message.contains(&url_token) {
                *message = message.replace(&url_token, &path_token);
            }
        }
    }
}

/// Strip the `data:{mime};base64,` prefix from an inline data URL.
pub fn decode_data_url(data_url: &str) -> Option<(String, String)> {
    let meta_and_data = data_url.strip_prefix("data:")?;
    let (meta, data) = meta_and_data.split_once(',')?;
    if !meta.split(';').any(|part| part == "base64") {
        return None;
    }
    let mime = meta.split(';').next()?.trim();
    if mime.is_empty() || data.is_empty() {
        return None;
    }
    Some((mime.to_string(), data.to_string()))
}

/// Build pi RPC `images` entries from resolved image attachments.
/// pi expects raw base64 in `data`, not a full data URL (see pi rpc `prompt.images`).
pub fn pi_prompt_images(entries: &[ResolvedEntry]) -> Vec<serde_json::Value> {
    entries
        .iter()
        .filter_map(|entry| {
            let ResolvedAttachment::Image {
                data_url, mime, ..
            } = &entry.attachment
            else {
                return None;
            };
            let (decoded_mime, data) = decode_data_url(data_url)
                .unwrap_or_else(|| (mime.clone(), data_url.clone()));
            Some(serde_json::json!({
                "type": "image",
                "data": data,
                "mimeType": decoded_mime,
            }))
        })
        .collect()
}

/// Append resolved attachments not already present in the message body.
/// When `include_images` is false, images are omitted here and delivered via
/// runtime-specific channels (pi `images`, opencode File parts).
pub fn append_unreferenced(message: &mut String, entries: &[ResolvedEntry], include_images: bool) {
    let mut extras: Vec<&ResolvedAttachment> = Vec::new();
    for entry in entries {
        match &entry.attachment {
            ResolvedAttachment::Image { .. } if include_images => {
                extras.push(&entry.attachment);
            }
            ResolvedAttachment::Image { .. } => {}
            _ if message.contains(&entry.source_url) => continue,
            _ => extras.push(&entry.attachment),
        }
    }
    if extras.is_empty() {
        return;
    }
    message.push_str("\n\nAttachments:\n");
    for att in extras {
        match att {
            ResolvedAttachment::Image {
                data_url, filename, ..
            } => {
                if let Some(name) = filename {
                    message.push_str(name);
                    message.push_str(": ");
                }
                message.push_str(data_url);
                message.push('\n');
            }
            ResolvedAttachment::LocalFile { path, filename, .. } => {
                message.push_str(filename);
                message.push_str(": ");
                message.push_str(path);
                message.push('\n');
            }
            ResolvedAttachment::Link { url, filename, .. } => {
                message.push_str(filename);
                message.push_str(": ");
                message.push_str(url);
                message.push('\n');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_ext_strips_query_before_extension() {
        let url = "https://x.supabase.co/storage/v1/object/public/attachments/t/s/abc/photo.png?token=eyJ.foo.bar";
        let (path, ext) = path_and_ext(url);
        assert!(path.ends_with("photo.png"));
        assert_eq!(ext, "png");
    }

    #[test]
    fn format_data_url_prefix() {
        let url = format_data_url("image/png", b"\x89PNG");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn mime_from_ext_maps_common_images() {
        assert_eq!(mime_from_ext("jpeg"), "image/jpeg");
        assert_eq!(mime_from_ext("webp"), "image/webp");
        assert_eq!(mime_from_ext("pdf"), "application/pdf");
    }

    #[test]
    fn is_image_attachment_url_strips_query() {
        let url = "https://x/y/photo.png?token=eyJ.foo.bar";
        assert!(is_image_attachment_url(url));
        assert!(!is_image_attachment_url("https://x/y/doc.pdf"));
        assert!(is_image_attachment_url("https://x/y/icon.svg"));
        assert!(is_image_attachment_url("https://x/y/photo.heic?token=abc"));
    }

    #[test]
    fn substitute_in_message_replaces_url_with_path() {
        let url = "https://cdn.example.test/team/s/id/doc.pdf";
        let mut message = format!("[Attachment: doc.pdf] (url: {url})");
        substitute_in_message(
            &mut message,
            &[ResolvedEntry {
                source_url: url.to_string(),
                attachment: ResolvedAttachment::LocalFile {
                    source_url: url.to_string(),
                    path: "/Users/me/.amuxd/attachments/sess/doc.pdf".into(),
                    filename: "doc.pdf".into(),
                    mime: "application/pdf".into(),
                },
            }],
        );
        assert!(message.contains("(path: /Users/me/.amuxd/attachments/sess/doc.pdf)"));
        assert!(!message.contains("(url:"));
    }

    #[test]
    fn cache_filename_is_stable() {
        let a = cache_filename("https://x/y/a.pdf", "a.pdf");
        let b = cache_filename("https://x/y/a.pdf", "a.pdf");
        assert_eq!(a, b);
        assert!(a.ends_with("_a.pdf"));
    }

    #[test]
    fn cache_filename_ignores_query_and_fragment() {
        let base = cache_filename("https://x/y/a.pdf", "a.pdf");
        let with_query = cache_filename("https://x/y/a.pdf?token=abc", "a.pdf");
        let with_both = cache_filename("https://x/y/a.pdf?token=def#frag", "a.pdf");
        assert_eq!(base, with_query);
        assert_eq!(base, with_both);
    }

    #[tokio::test]
    async fn resolve_one_reuses_existing_non_image_cache() {
        let session_id = "p0_cache_hit_test";
        let url = "https://cdn.example.test/team/s/doc.pdf?token=old";
        let cache_dir = attachment_cache_dir(session_id);
        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        tokio::fs::create_dir_all(&cache_dir).await.unwrap();
        let local_path = local_cache_path(session_id, url, "doc.pdf");
        tokio::fs::write(&local_path, b"cached-bytes")
            .await
            .unwrap();

        let resolved = resolve_one(url, session_id).await.unwrap();
        match resolved {
            ResolvedAttachment::LocalFile { path, filename, .. } => {
                assert_eq!(path, local_path.to_string_lossy());
                assert_eq!(filename, "doc.pdf");
            }
            other => panic!("expected LocalFile, got {other:?}"),
        }

        let url_new_token = "https://cdn.example.test/team/s/doc.pdf?token=new";
        let resolved2 = resolve_one(url_new_token, session_id).await.unwrap();
        match resolved2 {
            ResolvedAttachment::LocalFile { path, .. } => {
                assert_eq!(path, local_path.to_string_lossy());
            }
            other => panic!("expected cache hit for normalized url, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
    }

    #[tokio::test]
    async fn resolve_one_redownloads_when_cached_file_is_empty() {
        let session_id = "p0_cache_empty_test";
        let url = "https://cdn.example.test/empty.pdf";
        let cache_dir = attachment_cache_dir(session_id);
        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        tokio::fs::create_dir_all(&cache_dir).await.unwrap();
        let local_path = local_cache_path(session_id, url, "empty.pdf");
        tokio::fs::write(&local_path, b"").await.unwrap();

        let err = resolve_one(url, session_id).await;
        assert!(
            err.is_err(),
            "empty cache file should trigger re-download attempt"
        );

        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
    }

    #[test]
    fn append_unreferenced_inlines_image_when_include_images_true() {
        let url = "https://cdn.example.test/a.png";
        let mut message = format!("[Image: a.png] (url: {url})");
        append_unreferenced(
            &mut message,
            &[ResolvedEntry {
                source_url: url.to_string(),
                attachment: ResolvedAttachment::Image {
                    source_url: url.to_string(),
                    data_url: "data:image/png;base64,abc".into(),
                    mime: "image/png".into(),
                    filename: Some("a.png".into()),
                },
            }],
            true,
        );
        assert!(message.contains("Attachments:"));
        assert!(message.contains("data:image/png;base64,abc"));
    }

    #[test]
    fn append_unreferenced_skips_images_when_include_images_false() {
        let url = "https://cdn.example.test/a.png";
        let mut message = format!("[Image: a.png] (url: {url})");
        append_unreferenced(
            &mut message,
            &[ResolvedEntry {
                source_url: url.to_string(),
                attachment: ResolvedAttachment::Image {
                    source_url: url.to_string(),
                    data_url: "data:image/png;base64,abc".into(),
                    mime: "image/png".into(),
                    filename: Some("a.png".into()),
                },
            }],
            false,
        );
        assert!(!message.contains("Attachments:"));
        assert!(!message.contains("data:image/png;base64,abc"));
    }

    #[test]
    fn decode_data_url_strips_prefix() {
        let (mime, data) =
            decode_data_url("data:image/png;base64,iVBORw0KGgo=").expect("decode");
        assert_eq!(mime, "image/png");
        assert_eq!(data, "iVBORw0KGgo=");
    }

    #[test]
    fn pi_prompt_images_emits_pi_rpc_shape() {
        let images = pi_prompt_images(&[ResolvedEntry {
            source_url: "https://cdn.example.test/a.png".into(),
            attachment: ResolvedAttachment::Image {
                source_url: "https://cdn.example.test/a.png".into(),
                data_url: "data:image/jpeg;base64,abc123".into(),
                mime: "image/jpeg".into(),
                filename: Some("a.jpg".into()),
            },
        }]);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["type"], "image");
        assert_eq!(images[0]["data"], "abc123");
        assert_eq!(images[0]["mimeType"], "image/jpeg");
    }

    #[test]
    fn append_unreferenced_skips_non_image_urls_already_in_message() {
        let url = "https://cdn.example.test/doc.pdf";
        let mut message = format!("[Attachment: doc.pdf] (url: {url})");
        append_unreferenced(
            &mut message,
            &[ResolvedEntry {
                source_url: url.to_string(),
                attachment: ResolvedAttachment::Link {
                    source_url: url.to_string(),
                    url: url.to_string(),
                    filename: "doc.pdf".into(),
                    mime: "application/pdf".into(),
                },
            }],
            true,
        );
        assert!(!message.contains("Attachments:"));
    }

    #[test]
    fn attachment_cache_dir_sanitizes_session_id() {
        let dir = attachment_cache_dir("../evil/session");
        let path = dir.to_string_lossy();
        assert!(!path.contains("/../"));
        assert!(path.contains("attachments"));
        assert!(path.contains("evil_session") || path.contains("evil/session"));
    }

    #[test]
    fn attachment_cache_dir_under_amuxd() {
        let dir = attachment_cache_dir("sess-1");
        let path = dir.to_string_lossy();
        assert!(path.contains("sess_1"));
        if !cfg!(test) {
            assert!(path.contains(".amuxd/attachments"));
        }
    }
}
