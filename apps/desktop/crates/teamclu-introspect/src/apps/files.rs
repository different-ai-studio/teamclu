//! `manage_app_files` — an app's stored files, with the bytes moved here.
//!
//! The desktop signs and this process transfers. An upload reads a path the
//! agent named and a download writes one, and both belong to the agent's own
//! process and file permissions — not to the desktop app, which is not the
//! agent and should not read or write arbitrary paths on its behalf. What the
//! desktop hands back is a short-lived signed URL scoped to one object.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{app_body, copy_args, require_named_app, str_arg};

pub(super) const ACTIONS: [&str; 8] = [
    "usage",
    "list",
    "download",
    "upload",
    "delete",
    "delete_folder",
    "purge",
    "set_quota",
];

/// Largest file `upload` will send. It is read into memory whole, and an app's
/// attachments are documents and images, not disk images.
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;

pub(super) async fn handle(
    workspace: &str,
    api_port: u16,
    arguments: &Value,
) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &ACTIONS)?;
    match action.as_str() {
        "usage" => copy_args(arguments, &mut body, &["refresh"]),
        "list" => copy_args(arguments, &mut body, &["prefix", "recursive", "after", "limit"]),
        "delete" => {
            let path = str_arg(arguments, "path")
                .ok_or("delete needs `path` — as action \"list\" reports it")?;
            body["path"] = json!(path);
        }
        "delete_folder" => {
            let prefix = str_arg(arguments, "prefix")
                .filter(|p| p.split('/').any(|seg| !matches!(seg.trim(), "" | "." | "..")))
                .ok_or("delete_folder needs a non-empty `prefix`; to delete every file use action \"purge\"")?;
            body["prefix"] = json!(prefix);
        }
        "purge" => require_named_app(arguments, "purge")?,
        "set_quota" => match arguments.get("quota_bytes") {
            Some(value @ Value::Null) => body["quota_bytes"] = value.clone(),
            Some(value) if value.as_u64().is_some_and(|n| n > 0) => {
                body["quota_bytes"] = value.clone()
            }
            _ => {
                return Err(
                    "set_quota needs `quota_bytes` — a positive number of bytes, or null for the deployment default"
                        .to_string(),
                )
            }
        },
        "download" => return download(workspace, api_port, arguments, body).await,
        "upload" => return upload(workspace, api_port, arguments, body).await,
        _ => {}
    }
    crate::desktop_api::post(api_port, "/app-files", &body).await
}

/// A path the agent gave: absolute as is, relative to its workspace otherwise.
fn local_path(workspace: &str, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        Path::new(workspace).join(path)
    }
}

/// Where a download lands. An existing directory receives the file under its
/// own name; an existing file is refused rather than overwritten, because a
/// tool that silently replaces a file the agent may not have meant is worse
/// than one that asks for another name.
fn download_destination(
    workspace: &str,
    save_to: &str,
    remote_path: &str,
) -> Result<PathBuf, String> {
    let mut dest = local_path(workspace, save_to);
    if dest.is_dir() {
        let name = remote_path
            .rsplit('/')
            .find(|seg| !seg.is_empty())
            .ok_or("path has no file name")?;
        dest = dest.join(name);
    }
    if dest.exists() {
        return Err(format!(
            "{} already exists — choose another save_to, or remove it first",
            dest.display()
        ));
    }
    Ok(dest)
}

/// Where an upload is stored: `path` as given, a folder `path` (ending in `/`)
/// with the local file's name appended, or the file's name at the root.
fn upload_destination(path: Option<&str>, file_name: &str) -> String {
    match path.map(|p| p.trim_start_matches('/')) {
        Some("") => file_name.to_string(),
        Some(p) if p.ends_with('/') => format!("{p}{file_name}"),
        Some(p) => p.to_string(),
        None => file_name.to_string(),
    }
}

/// A MIME type from the extension, for the common attachment kinds. It is
/// signed into the upload URL, so it only has to be consistent, not clever.
fn guess_content_type(file_name: &str) -> &'static str {
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// `download` — a signed link, or the file itself when `save_to` is given.
async fn download(
    workspace: &str,
    api_port: u16,
    arguments: &Value,
    mut body: Value,
) -> Result<Value, String> {
    let path = str_arg(arguments, "path")
        .ok_or("download needs `path` — as action \"list\" reports it")?;
    // Before signing, so a destination that cannot be used costs no link.
    let dest = str_arg(arguments, "save_to")
        .map(|raw| download_destination(workspace, &raw, &path))
        .transpose()?;

    body["action"] = json!("download_url");
    body["path"] = json!(path);
    let mut signed = crate::desktop_api::post(api_port, "/app-files", &body).await?;
    let Some(dest) = dest else {
        signed["action"] = json!("download");
        signed["note"] = json!(
            "A signed link that expires after expires_in seconds; it downloads the file as an attachment. Pass save_to to save the file instead."
        );
        return Ok(signed);
    };

    let url = signed
        .get("url")
        .and_then(Value::as_str)
        .ok_or("the desktop returned no download link")?;
    let bytes = fetch_to_file(url, &dest).await?;
    Ok(json!({
        "ok": true,
        "action": "download",
        "app_id": signed.get("app_id"),
        "path": signed.get("path"),
        "saved_to": dest.display().to_string(),
        "bytes": bytes,
    }))
}

/// Stream a signed URL into `dest`, through a sibling temp file, so a transfer
/// that fails halfway leaves nothing under the name that was asked for.
///
/// Errors are reported `without_url`: the URL carries the signature, and an
/// error message is exactly what ends up quoted in a transcript.
async fn fetch_to_file(url: &str, dest: &Path) -> Result<u64, String> {
    let mut resp = reqwest::get(url)
        .await
        .map_err(|e| format!("Download failed: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download failed: storage answered HTTP {}",
            resp.status()
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let tmp = dest.with_file_name(format!(".{name}.part"));
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;

    let mut written = 0u64;
    let result: Result<(), String> = async {
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Download failed: {}", e.without_url()))?
        {
            file.write_all(&chunk)
                .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
            written += chunk.len() as u64;
        }
        file.sync_all()
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot move the download into {}: {e}", dest.display())
    })?;
    Ok(written)
}

/// `upload` — sign on the desktop, PUT from here, then tell the desktop it
/// landed so an open files tab re-reads.
async fn upload(
    workspace: &str,
    api_port: u16,
    arguments: &Value,
    mut body: Value,
) -> Result<Value, String> {
    let raw = str_arg(arguments, "local_path")
        .ok_or("upload needs `local_path` — the local file to send")?;
    let local = local_path(workspace, &raw);
    let meta =
        std::fs::metadata(&local).map_err(|e| format!("cannot read {}: {e}", local.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", local.display()));
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "{} is {} bytes; upload sends at most {MAX_UPLOAD_BYTES}",
            local.display(),
            meta.len()
        ));
    }
    let file_name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("local_path has no usable file name")?
        .to_string();
    let dest = upload_destination(str_arg(arguments, "path").as_deref(), &file_name);
    let content_type = str_arg(arguments, "content_type")
        .unwrap_or_else(|| guess_content_type(&file_name).to_string());

    body["action"] = json!("sign_upload");
    body["path"] = json!(dest);
    body["content_type"] = json!(content_type);
    let signed = crate::desktop_api::post(api_port, "/app-files", &body).await?;
    let url = signed
        .get("url")
        .and_then(Value::as_str)
        .ok_or("the desktop returned no upload link")?;

    let bytes =
        std::fs::read(&local).map_err(|e| format!("cannot read {}: {e}", local.display()))?;
    let size = bytes.len();
    // The content type was signed into the URL; the PUT must carry the same.
    let resp = reqwest::Client::new()
        .put(url)
        .header(reqwest::header::CONTENT_TYPE, &content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!(
            "Upload failed: storage answered HTTP {status}: {snippet}"
        ));
    }

    body["action"] = json!("uploaded");
    let _ = crate::desktop_api::post(api_port, "/app-files", &body).await;
    Ok(json!({
        "ok": true,
        "action": "upload",
        "app_id": signed.get("app_id"),
        "path": signed.get("path").cloned().unwrap_or(json!(dest)),
        "bytes": size,
        "content_type": content_type,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_the_workspace_s() {
        assert_eq!(
            local_path("/work/site", "out/report.csv"),
            PathBuf::from("/work/site/out/report.csv")
        );
        assert_eq!(
            local_path("/work/site", "/tmp/a.png"),
            PathBuf::from("/tmp/a.png")
        );
    }

    #[test]
    fn a_download_never_overwrites_and_fills_in_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        // An existing directory gets the file under its remote name.
        let dest = download_destination(ws, ".", "uploads/报表.csv").unwrap();
        assert_eq!(dest, dir.path().join(".").join("报表.csv"));

        std::fs::write(dir.path().join("a.png"), b"x").unwrap();
        let err = download_destination(ws, "a.png", "uploads/a.png").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn upload_destination_follows_the_folder_convention() {
        assert_eq!(upload_destination(None, "a.png"), "a.png");
        assert_eq!(
            upload_destination(Some("uploads/"), "a.png"),
            "uploads/a.png"
        );
        assert_eq!(
            upload_destination(Some("/uploads/b.png"), "a.png"),
            "uploads/b.png"
        );
        assert_eq!(upload_destination(Some("/"), "a.png"), "a.png");
    }

    #[test]
    fn content_types_cover_common_attachments_and_fall_back() {
        assert_eq!(guess_content_type("photo.JPG"), "image/jpeg");
        assert_eq!(guess_content_type("report.csv"), "text/csv");
        assert_eq!(guess_content_type("Makefile"), "application/octet-stream");
    }

    #[tokio::test]
    async fn purge_refuses_the_workspace_default_before_any_request() {
        let err = handle("/work/site", 1, &json!({ "action": "purge" }))
            .await
            .unwrap_err();
        assert!(err.contains("app_id or app_name"), "{err}");
    }

    #[tokio::test]
    async fn delete_folder_refuses_the_root() {
        for prefix in ["/", "./", "../.."] {
            let err = handle(
                "/work/site",
                1,
                &json!({ "action": "delete_folder", "prefix": prefix }),
            )
            .await
            .unwrap_err();
            assert!(err.contains("purge"), "{prefix}: {err}");
        }
    }

    #[tokio::test]
    async fn set_quota_takes_bytes_or_null_only() {
        let err = handle(
            "/work/site",
            1,
            &json!({ "action": "set_quota", "quota_bytes": -1 }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("quota_bytes"), "{err}");
        // A valid value gets past the argument check and fails only on the
        // unreachable desktop.
        let err = handle(
            "/work/site",
            1,
            &json!({ "action": "set_quota", "quota_bytes": null }),
        )
        .await
        .unwrap_err();
        assert!(!err.contains("needs `quota_bytes`"), "{err}");
    }

    #[tokio::test]
    async fn upload_checks_the_local_file_before_signing() {
        let err = handle(
            "/work/site",
            1,
            &json!({ "action": "upload", "local_path": "/definitely/not/here.png" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("cannot read"), "{err}");
    }
}
