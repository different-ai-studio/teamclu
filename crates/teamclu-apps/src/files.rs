//! The files an app stored in object storage (the control panel's 应用附件).
//!
//! Only metadata and signed URLs pass through here. The bytes of an upload or
//! a download move in the process that asked — `amuxd app files get|put` —
//! under that process's own file permissions: the
//! daemon is not the agent, and reading or writing a path an agent named is
//! not something it should do on the agent's behalf.

use std::time::Duration;

use serde_json::{json, Value};

use crate::row::{app_path, row_id};
use crate::{AppOps, Method, OpError};

/// The largest file an upload sends; signed PUTs carry the whole body.
pub const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// `files ls` returns at most this many per page; the server refuses more.
pub const MAX_LIST_LIMIT: u64 = 100;

/// A file path in the one URL segment it has to fit in: unpadded base64url of
/// its UTF-8 bytes, which is what the server decodes (a path has slashes, and
/// a slash cannot survive a single segment). Mirrors `encodeFilePath` in
/// `lib/backend/cloud-api/apps.ts`.
pub fn encode_file_path(path: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes())
}

/// A remote path relative to the storage root; an empty one is refused
/// before any request.
pub fn storage_path(raw: &str, what: &str) -> Result<String, OpError> {
    let path = raw.trim().trim_start_matches('/');
    if path.is_empty() {
        return Err(OpError::invalid(
            "missing_path",
            format!("{what} needs a path relative to the app's storage root"),
        ));
    }
    Ok(path.to_string())
}

/// Where an upload is stored: `path` as given, a folder `path` (ending in `/`)
/// with the local file's name appended, or the file's name at the root.
pub fn upload_destination(path: Option<&str>, file_name: &str) -> String {
    match path.map(|p| p.trim_start_matches('/')) {
        Some("") | None => file_name.to_string(),
        Some(p) if p.ends_with('/') => format!("{p}{file_name}"),
        Some(p) => p.to_string(),
    }
}

/// A MIME type from the extension, for the common attachment kinds. It is
/// signed into the upload URL, so it only has to be consistent, not clever.
pub fn guess_content_type(file_name: &str) -> &'static str {
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

fn file_view(file: &Value) -> Value {
    json!({
        "path": file.get("path"),
        "size": file.get("size"),
        "last_modified": file.get("lastModified"),
    })
}

fn usage_view(usage: &Value) -> Value {
    json!({
        // Null is "never measured", not zero: an app writes with its own
        // credentials, so this is a periodic sweep and `counted_at` its age.
        "bytes": usage.get("bytes"),
        "counted_at": usage.get("countedAt"),
        "quota_bytes": usage.get("quotaBytes"),
        "over_quota": usage.get("overQuota"),
        "objects": usage.get("objects"),
        "truncated": usage.get("truncated"),
    })
}

/// One page of `files ls`.
#[derive(Debug, Clone, Default)]
pub struct FilesQuery {
    pub prefix: Option<String>,
    /// Every key under the prefix, instead of one level.
    pub recursive: bool,
    pub after: Option<String>,
    pub limit: Option<u64>,
}

impl AppOps<'_> {
    fn storage(&self, app_id: &str, rest: &str) -> String {
        app_path(app_id, &format!("/storage{rest}"))
    }

    /// `files ls` — one level by default, the way a person browses.
    pub async fn files_list(&self, row: &Value, q: &FilesQuery) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let prefix = q.prefix.clone().unwrap_or_default();
        // Refused above 100 by the server rather than clamped, so clamped here.
        let limit = q.limit.unwrap_or(MAX_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
        let mut query = format!("?limit={limit}");
        if !prefix.is_empty() {
            query.push_str(&format!("&prefix={}", urlencoding::encode(&prefix)));
        }
        // Recursive lists every key under the prefix — thousands, for an app
        // that writes per-user folders.
        if !q.recursive {
            query.push_str("&delimiter=%2F");
        }
        if let Some(after) = &q.after {
            query.push_str(&format!("&after={}", urlencoding::encode(after)));
        }
        let page = self
            .get(
                &self.storage(&app_id, &format!("/objects{query}")),
                "Listing the app's files (needs read on it)",
            )
            .await?;
        Ok(json!({
            "action": "files_ls",
            "app_id": app_id,
            "prefix": prefix,
            "recursive": q.recursive,
            "folders": page.get("folders").cloned().unwrap_or(json!([])),
            "files": page.get("items").and_then(Value::as_array)
                .map(|items| items.iter().map(file_view).collect::<Vec<_>>())
                .unwrap_or_default(),
            "next_cursor": page.get("nextCursor"),
            "can_write": page.get("canWrite").and_then(Value::as_bool).unwrap_or(false),
        }))
    }

    /// A signed download link. The caller fetches it, or hands it on.
    pub async fn files_url(&self, row: &Value, path: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let path = storage_path(path, "files get")?;
        let signed = self
            .get(
                &self.storage(
                    &app_id,
                    &format!("/objects/{}/url", encode_file_path(&path)),
                ),
                "Signing a download link (needs read on the app)",
            )
            .await?;
        Ok(json!({
            "action": "files_get",
            "app_id": app_id,
            "path": path,
            "url": signed.get("url"),
            "size": signed.get("size"),
            "content_type": signed.get("contentType"),
            "expires_in": signed.get("expiresIn"),
        }))
    }

    /// A signed upload link; the PUT must carry exactly `content_type`, which
    /// is signed into it.
    pub async fn files_sign_upload(
        &self,
        row: &Value,
        path: &str,
        content_type: &str,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let path = storage_path(path, "files put")?;
        let signed = self
            .post(
                &self.storage(&app_id, "/sign-upload"),
                &json!({ "path": path, "contentType": content_type }),
                "Signing an upload (needs write on the app)",
            )
            .await?;
        Ok(json!({
            "action": "files_sign_upload",
            "app_id": app_id,
            "path": signed.get("path").cloned().unwrap_or(json!(path)),
            "url": signed.get("url"),
            "expires_in": signed.get("expiresIn"),
            "content_type": content_type,
        }))
    }

    /// The caller finished a PUT this only signed: anyone watching the app's
    /// files hears now rather than when the link was minted.
    pub fn files_uploaded(&self, row: &Value) -> Result<Value, OpError> {
        self.host.app_changed(row);
        Ok(json!({ "ok": true, "action": "files_uploaded", "app_id": row_id(row)? }))
    }

    /// `files rm <path>`.
    pub async fn files_delete(&self, row: &Value, path: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let path = storage_path(path, "files rm")?;
        self.del(
            &self.storage(&app_id, &format!("/objects/{}", encode_file_path(&path))),
            "Deleting the file (needs write on the app)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({ "ok": true, "action": "files_rm", "app_id": app_id, "path": path }))
    }

    /// `files rm -r <prefix>` — never the root: that is `purge`.
    pub async fn files_delete_folder(&self, row: &Value, prefix: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        if !prefix
            .split('/')
            .any(|seg| !matches!(seg.trim(), "" | "." | ".."))
        {
            return Err(OpError::invalid(
                "root_prefix",
                "files rm -r needs a folder, not the storage root",
            )
            .with_next(crate::step("files purge")));
        }
        let out = self
            .call(
                Method::Delete,
                &self.storage(
                    &app_id,
                    &format!("/folder?prefix={}", urlencoding::encode(prefix)),
                ),
                None,
                Some(Duration::from_secs(120)),
                "Deleting the folder (needs write on the app)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "files_rm_r",
            "app_id": app_id,
            "prefix": prefix,
            "deleted": out.get("deleted"),
        }))
    }

    /// `files purge` — every file of the app. Callers name the app outright
    /// and confirm first.
    pub async fn files_purge(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let out = self
            .call(
                Method::Post,
                &self.storage(&app_id, "/purge"),
                Some(&json!({})),
                Some(Duration::from_secs(300)),
                "Deleting every file of the app (needs admin on it)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "files_purge",
            "app_id": app_id,
            "deleted": out.get("deleted"),
        }))
    }

    /// `files usage [--refresh]` — refresh lists the whole prefix first.
    pub async fn files_usage(&self, row: &Value, refresh: bool) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let usage = if refresh {
            self.call(
                Method::Post,
                &self.storage(&app_id, "/usage/refresh"),
                Some(&json!({})),
                Some(Duration::from_secs(120)),
                "Re-measuring the app's storage",
            )
            .await?
        } else {
            self.get(
                &self.storage(&app_id, "/usage"),
                "Reading the app's storage usage",
            )
            .await?
        };
        let mut out = usage_view(&usage);
        out["action"] = json!("files_usage");
        out["app_id"] = json!(app_id);
        Ok(out)
    }

    /// `files quota <bytes|default>` — `None` falls back to the deployment's.
    pub async fn files_set_quota(&self, row: &Value, bytes: Option<u64>) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        if bytes == Some(0) {
            return Err(OpError::invalid(
                "invalid_quota",
                "a quota is a positive number of bytes, or `default`",
            ));
        }
        let out = self
            .put(
                &self.storage(&app_id, "/quota"),
                &json!({ "quotaBytes": bytes }),
                "Setting the storage quota (needs admin on the app)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "files_quota",
            "app_id": app_id,
            "quota_bytes": out.get("quotaBytes"),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_paths_encode_the_way_the_server_decodes_them() {
        assert_eq!(encode_file_path("a.txt"), "YS50eHQ");
        assert_eq!(encode_file_path("报表/q3.csv"), "5oql6KGoL3EzLmNzdg");
        assert!(!encode_file_path("reports/2026/q3.csv").contains('/'));
    }

    #[test]
    fn a_path_is_relative_to_the_storage_root() {
        assert_eq!(
            storage_path("/uploads/a.png", "x").unwrap(),
            "uploads/a.png"
        );
        assert_eq!(storage_path("/", "x").unwrap_err().code, "missing_path");
    }

    #[test]
    fn upload_destination_follows_the_folder_convention() {
        assert_eq!(upload_destination(None, "a.png"), "a.png");
        assert_eq!(upload_destination(Some("/"), "a.png"), "a.png");
        assert_eq!(upload_destination(Some("img/"), "a.png"), "img/a.png");
        assert_eq!(upload_destination(Some("img/b.png"), "a.png"), "img/b.png");
    }

    #[test]
    fn content_types_cover_common_attachments_and_fall_back() {
        assert_eq!(guess_content_type("photo.JPG"), "image/jpeg");
        assert_eq!(guess_content_type("Makefile"), "application/octet-stream");
    }
}
