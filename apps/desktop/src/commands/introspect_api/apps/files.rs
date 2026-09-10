//! `manage_app_files` — the files an app stored (the control panel's 应用附件).
//!
//! This side only ever handles metadata and signed URLs. The bytes of an upload
//! or a download move in the sidecar, under the agent's own process and file
//! permissions: this process is not the agent, and reading or writing a path
//! an agent named is not something it should do on the agent's behalf.

use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::{
    app_path, notify_app_changed, parse_body, require_action, require_named_app, resolve_app_row,
    row_id, u64_body_field, AppApi,
};
use crate::commands::introspect_api::str_body_field;

/// `download_url`, `sign_upload` and `uploaded` are the sidecar's half of
/// `download` / `upload`; the tool never exposes them by those names.
const FILE_ACTIONS: [&str; 9] = [
    "usage",
    "list",
    "download_url",
    "sign_upload",
    "uploaded",
    "delete",
    "delete_folder",
    "purge",
    "set_quota",
];

/// A file path in the one URL segment it has to fit in: unpadded base64url of
/// its UTF-8 bytes, which is what the server decodes (a path has slashes, and
/// a slash cannot survive a single segment). Mirrors `encodeFilePath` in
/// `lib/backend/cloud-api/apps.ts`.
fn encode_file_path(path: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes())
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

/// The file path an action is about, refusing an empty one before any request.
fn require_path(v: &Value, action: &str) -> Result<String, String> {
    str_body_field(v, "path", "path")
        .map(|p| p.trim_start_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("{action} needs `path` — relative to the app's storage root"))
}

pub(crate) async fn handle_app_files(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &FILE_ACTIONS)?;
    if action == "purge" {
        require_named_app(&v, "purge")?;
    }
    let api = AppApi::for_tool(app, &v, "manage_app_files").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;
    let storage = |rest: &str| app_path(&app_id, &format!("/storage{rest}"));

    let out = match action.as_str() {
        "usage" => {
            let refresh = v.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            let usage = if refresh {
                // Lists the app's whole prefix before answering.
                api.call(
                    Method::POST,
                    &storage("/usage/refresh"),
                    Some(&json!({})),
                    Some(Duration::from_secs(120)),
                    "Re-measuring the app's storage",
                )
                .await?
            } else {
                api.get(&storage("/usage"), "Reading the app's storage usage")
                    .await?
            };
            let mut out = usage_view(&usage);
            out["action"] = json!("usage");
            out["app_id"] = json!(app_id);
            out
        }
        "list" => {
            let prefix = str_body_field(&v, "prefix", "prefix").unwrap_or_default();
            let recursive = v.get("recursive").and_then(Value::as_bool).unwrap_or(false);
            // Refused above 100 by the server rather than clamped, so it is
            // clamped here, where the tool's own description states the cap.
            let limit = u64_body_field(&v, "limit", "limit")
                .unwrap_or(100)
                .clamp(1, 100);
            let mut query = format!("?limit={limit}");
            if !prefix.is_empty() {
                query.push_str(&format!("&prefix={}", urlencoding::encode(&prefix)));
            }
            // One level by default, the way a person browses. Recursive is a
            // listing of every key under the prefix — thousands, for an app
            // that writes per-user folders.
            if !recursive {
                query.push_str("&delimiter=%2F");
            }
            if let Some(after) = str_body_field(&v, "after", "after") {
                query.push_str(&format!("&after={}", urlencoding::encode(&after)));
            }
            let page = api
                .get(
                    &storage(&format!("/objects{query}")),
                    "Listing the app's files (needs view on it)",
                )
                .await?;
            json!({
                "action": "list",
                "app_id": app_id,
                "prefix": prefix,
                "recursive": recursive,
                "folders": page.get("folders").cloned().unwrap_or(json!([])),
                "files": page.get("items").and_then(Value::as_array)
                    .map(|items| items.iter().map(file_view).collect::<Vec<_>>())
                    .unwrap_or_default(),
                "next_cursor": page.get("nextCursor"),
                "can_write": page.get("canWrite").and_then(Value::as_bool).unwrap_or(false),
            })
        }
        "download_url" => {
            let path = require_path(&v, "download")?;
            let signed = api
                .get(
                    &storage(&format!("/objects/{}/url", encode_file_path(&path))),
                    "Signing a download link (needs view on the app)",
                )
                .await?;
            json!({
                "action": "download_url",
                "app_id": app_id,
                "path": path,
                "url": signed.get("url"),
                "size": signed.get("size"),
                "content_type": signed.get("contentType"),
                "expires_in": signed.get("expiresIn"),
            })
        }
        "sign_upload" => {
            let path = require_path(&v, "upload")?;
            let content_type = str_body_field(&v, "content_type", "contentType");
            let signed = api
                .post(
                    &storage("/sign-upload"),
                    &json!({ "path": path, "contentType": content_type }),
                    "Signing an upload (needs prompt on the app)",
                )
                .await?;
            json!({
                "action": "sign_upload",
                "app_id": app_id,
                "path": signed.get("path").cloned().unwrap_or(json!(path)),
                "url": signed.get("url"),
                "expires_in": signed.get("expiresIn"),
                // Signed into the URL: the PUT must carry exactly this header.
                "content_type": content_type,
            })
        }
        // The sidecar finished a PUT this process only signed; the window is
        // told now rather than when the link was minted.
        "uploaded" => {
            notify_app_changed(app, &row);
            json!({ "ok": true, "action": "uploaded", "app_id": app_id })
        }
        "delete" => {
            let path = require_path(&v, "delete")?;
            api.delete(
                &storage(&format!("/objects/{}", encode_file_path(&path))),
                "Deleting the file (needs prompt on the app)",
            )
            .await?;
            notify_app_changed(app, &row);
            json!({ "ok": true, "action": "delete", "app_id": app_id, "path": path })
        }
        "delete_folder" => {
            // The server normalises the prefix too and refuses one that comes
            // out empty — that would be the whole app, which is `purge`.
            let prefix = str_body_field(&v, "prefix", "prefix")
                .filter(|p| p.split('/').any(|seg| !matches!(seg.trim(), "" | "." | "..")))
                .ok_or("delete_folder needs a non-empty `prefix`; to delete every file use action \"purge\"")?;
            let out = api
                .call(
                    Method::DELETE,
                    &storage(&format!("/folder?prefix={}", urlencoding::encode(&prefix))),
                    None,
                    Some(Duration::from_secs(120)),
                    "Deleting the folder (needs prompt on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "delete_folder",
                "app_id": app_id,
                "prefix": prefix,
                "deleted": out.get("deleted"),
            })
        }
        "purge" => {
            let out = api
                .call(
                    Method::POST,
                    &storage("/purge"),
                    Some(&json!({})),
                    Some(Duration::from_secs(300)),
                    "Deleting every file of the app (needs admin on it)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "purge",
                "app_id": app_id,
                "deleted": out.get("deleted"),
            })
        }
        "set_quota" => {
            let quota = match v.get("quota_bytes").or_else(|| v.get("quotaBytes")) {
                Some(Value::Null) => Value::Null,
                Some(value) => json!(value
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or("quota_bytes must be a positive integer, or null for the deployment default")?),
                None => {
                    return Err(
                        "set_quota needs `quota_bytes` — bytes, or null to fall back to the deployment default"
                            .to_string(),
                    )
                }
            };
            let out = api
                .put(
                    &storage("/quota"),
                    &json!({ "quotaBytes": quota }),
                    "Setting the storage quota (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "set_quota",
                "app_id": app_id,
                "quota_bytes": out.get("quotaBytes"),
            })
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_paths_encode_the_way_the_server_decodes_them() {
        // Unpadded base64url of the UTF-8 bytes — Chinese names included,
        // which is where a latin1-only encoder used to throw.
        assert_eq!(encode_file_path("a.txt"), "YS50eHQ");
        assert_eq!(encode_file_path("报表/q3.csv"), "5oql6KGoL3EzLmNzdg");
        assert!(!encode_file_path("reports/2026/q3.csv").contains('/'));
    }

    #[test]
    fn a_path_is_relative_to_the_storage_root() {
        assert_eq!(
            require_path(&json!({ "path": "/uploads/a.png" }), "delete").unwrap(),
            "uploads/a.png"
        );
        assert!(require_path(&json!({ "path": "/" }), "delete").is_err());
        assert!(require_path(&json!({}), "delete").is_err());
    }
}
