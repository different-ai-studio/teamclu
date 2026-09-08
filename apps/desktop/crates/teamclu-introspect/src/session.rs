use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use teamclu_runtime_env::{
    read_active_session_id, require_explicit_session_id_from_env, TEAMCLU_SESSION_ID_ENV,
};

const DEFAULT_SCHEME: &str = "teamclu";

/// Validate a UUID v4-style session id (same rules as `session-deeplink.ts`).
fn validate_session_id(session_id: &str) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session_id is required".to_string());
    }

    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5 {
        return Err(format!("Invalid session_id (expected UUID): {id}"));
    }

    let expected_lens = [8, 4, 4, 4, 12];
    for (part, len) in parts.iter().zip(expected_lens) {
        if part.len() != len || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("Invalid session_id (expected UUID): {id}"));
        }
    }

    Ok(())
}

fn resolve_scheme(arguments: &Value) -> Result<String, String> {
    let scheme = arguments
        .get("scheme")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("TEAMCLU_APP_SCHEME").ok())
        .unwrap_or_else(|| DEFAULT_SCHEME.to_string());

    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return Err(format!("Invalid scheme: {scheme}"));
    }

    Ok(scheme)
}

pub(crate) fn resolve_session_id(workspace: &str, arguments: &Value) -> Result<String, String> {
    if let Some(id) = arguments
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        validate_session_id(id)?;
        return Ok(id.to_string());
    }

    if require_explicit_session_id_from_env() {
        return Err(
            "session_id is required: pass session_id explicitly (managed runtime context)"
                .to_string(),
        );
    }

    if let Ok(id) = std::env::var(TEAMCLU_SESSION_ID_ENV) {
        let id = id.trim();
        if !id.is_empty() {
            validate_session_id(id)?;
            return Ok(id.to_string());
        }
    }

    if let Some(id) = read_active_session_id(Path::new(workspace)) {
        teamclu_runtime_env::session_context::warn_deprecated_active_session_file_fallback();
        validate_session_id(&id)?;
        return Ok(id);
    }

    Err(
        "session_id is required: pass session_id, set TEAMCLU_SESSION_ID, or run inside an active TeamClu session"
            .to_string(),
    )
}

pub fn build_session_deeplink(session_id: &str, scheme: &str) -> String {
    format!("{scheme}://session/{session_id}")
}

pub fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let session_id = resolve_session_id(workspace, arguments)?;
    let scheme = resolve_scheme(arguments)?;
    let deeplink = build_session_deeplink(&session_id, &scheme);

    Ok(json!({
        "session_id": session_id,
        "scheme": scheme,
        "deeplink": deeplink,
    }))
}

/// Archive a cloud session via the desktop introspect API → Cloud API PATCH.
pub async fn archive(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let session_id = resolve_session_id(workspace, arguments)?;
    let mut body = json!({ "session_id": session_id });
    if let Some(at) = arguments
        .get("archived_at")
        .or_else(|| arguments.get("archivedAt"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body["archivedAt"] = json!(at);
    }

    crate::desktop_api::post(api_port, "/session-archive", &body).await
}

pub(crate) fn default_transcript_output_path(workspace: &Path, session_id: &str) -> PathBuf {
    teamclu_runtime_env::workspace_meta_write_path_from_env(
        workspace,
        format!("exports/pi-transcript-{session_id}.json"),
    )
}

/// Keep skill-chosen output inside the workspace. `..` is rejected before any
/// write so a prompt cannot walk out to `/etc` or a sibling checkout.
pub(crate) fn fence_output_path(workspace: &Path, output_path: &Path) -> Result<PathBuf, String> {
    if output_path.as_os_str().is_empty() {
        return Err("output_path is empty".to_string());
    }
    if output_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("output_path must not contain '..'".to_string());
    }
    let candidate = if output_path.is_absolute() {
        output_path.to_path_buf()
    } else {
        workspace.join(output_path)
    };
    let workspace_norm = normalize_lex(workspace);
    let candidate_norm = normalize_lex(&candidate);
    if candidate_norm == workspace_norm {
        return Err("output_path must be a file inside the workspace".to_string());
    }
    if !candidate_norm.starts_with(&workspace_norm) {
        return Err("output_path must be inside the workspace".to_string());
    }
    Ok(candidate)
}

fn normalize_lex(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn transcript_entry_count(bundle: &Value) -> (usize, usize) {
    let transcripts = bundle.get("transcripts").and_then(Value::as_array);
    let transcript_count = transcripts.map(Vec::len).unwrap_or(0);
    let entry_count = transcripts
        .map(|items| {
            items
                .iter()
                .map(|t| t.get("entry_count").and_then(Value::as_u64).unwrap_or(0) as usize)
                .sum()
        })
        .unwrap_or(0);
    (transcript_count, entry_count)
}

/// Fetch the on-disk pi JSONL via amuxd and write it under the workspace.
///
/// The JSON is not returned inline: a long transcript would blow the MCP
/// context. Skills should `Read` the file at `path`.
pub async fn export_pi_transcript(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let session_id = resolve_session_id(workspace, arguments)?;
    let ws = Path::new(workspace);
    let sanitize = arguments
        .get("sanitize")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let workspace_id = arguments
        .get("workspace_id")
        .or_else(|| arguments.get("workspaceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut path = format!(
        "/v1/pi/transcripts/{}?sanitize={}",
        crate::daemon_http::urlencode(&session_id),
        if sanitize { "true" } else { "false" }
    );
    if let Some(wid) = workspace_id {
        path.push_str("&workspaceId=");
        path.push_str(&crate::daemon_http::urlencode(wid));
    }

    let bundle =
        crate::daemon_http::request(reqwest::Method::GET, &path, &["sessions:read"], None).await?;

    let dest = match arguments
        .get("output_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(p) => fence_output_path(ws, Path::new(p))?,
        None => default_transcript_output_path(ws, &session_id),
    };
    let dest = fence_output_path(ws, &dest)?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create export directory: {e}"))?;
    }
    let pretty = serde_json::to_vec_pretty(&bundle)
        .map_err(|e| format!("failed to serialize transcript: {e}"))?;
    std::fs::write(&dest, pretty).map_err(|e| format!("failed to write transcript: {e}"))?;

    let (transcript_count, entry_count) = transcript_entry_count(&bundle);
    Ok(json!({
        "teamclu_session_id": session_id,
        "path": dest.to_string_lossy(),
        "exported_at": bundle.get("exported_at"),
        "source": bundle.get("source"),
        "transcript_count": transcript_count,
        "entry_count": entry_count,
        "sanitized": sanitize,
        "hint": "Read the JSON file at path. Do not paste the whole transcript into the chat.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use teamclu_runtime_env::write_active_session_id;

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    const UUID: &str = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";

    #[test]
    fn build_session_deeplink_uses_teamclu_scheme_by_default() {
        assert_eq!(
            build_session_deeplink(UUID, "teamclu"),
            format!("teamclu://session/{UUID}")
        );
    }

    #[test]
    fn handle_returns_deeplink_for_valid_uuid() {
        let result = handle("/ws", &json!({ "session_id": UUID })).unwrap();
        assert_eq!(result["deeplink"], format!("teamclu://session/{UUID}"));
        assert_eq!(result["session_id"], UUID);
        assert_eq!(result["scheme"], "teamclu");
    }

    #[test]
    fn handle_accepts_custom_scheme() {
        let result = handle("/ws", &json!({ "session_id": UUID, "scheme": "acme" })).unwrap();
        assert_eq!(result["deeplink"], format!("acme://session/{UUID}"));
    }

    #[test]
    fn handle_rejects_invalid_uuid() {
        let err = handle("/ws", &json!({ "session_id": "not-a-uuid" })).unwrap_err();
        assert!(err.contains("Invalid session_id"));
    }

    #[test]
    fn handle_requires_session_id_when_unresolved() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var(TEAMCLU_SESSION_ID_ENV).ok();
        std::env::remove_var(TEAMCLU_SESSION_ID_ENV);
        let err = handle("/ws", &json!({})).unwrap_err();
        assert!(err.contains("session_id is required"));
        match prev {
            Some(v) => std::env::set_var(TEAMCLU_SESSION_ID_ENV, v),
            None => std::env::remove_var(TEAMCLU_SESSION_ID_ENV),
        }
    }

    #[test]
    fn handle_reads_active_session_id_file() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev_managed = std::env::var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID").ok();
        std::env::remove_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID");
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), UUID).unwrap();
        let result = handle(dir.path().to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(result["session_id"], UUID);
        match prev_managed {
            Some(v) => std::env::set_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID", v),
            None => std::env::remove_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID"),
        }
    }

    #[test]
    fn handle_requires_session_id_in_managed_mode() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var(TEAMCLU_SESSION_ID_ENV).ok();
        let prev_managed = std::env::var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID").ok();
        std::env::remove_var(TEAMCLU_SESSION_ID_ENV);
        std::env::set_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID", "1");
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), UUID).unwrap();
        let err = handle(dir.path().to_str().unwrap(), &json!({})).unwrap_err();
        assert!(err.contains("session_id is required"));
        match prev {
            Some(v) => std::env::set_var(TEAMCLU_SESSION_ID_ENV, v),
            None => std::env::remove_var(TEAMCLU_SESSION_ID_ENV),
        }
        match prev_managed {
            Some(v) => std::env::set_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID", v),
            None => std::env::remove_var("TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID"),
        }
    }

    #[test]
    fn handle_reads_teamclu_session_id_env() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var(TEAMCLU_SESSION_ID_ENV).ok();
        std::env::set_var(TEAMCLU_SESSION_ID_ENV, UUID);
        let result = handle("/ws", &json!({})).unwrap();
        assert_eq!(result["session_id"], UUID);
        match prev {
            Some(v) => std::env::set_var(TEAMCLU_SESSION_ID_ENV, v),
            None => std::env::remove_var(TEAMCLU_SESSION_ID_ENV),
        }
    }

    #[tokio::test]
    async fn archive_rejects_invalid_uuid_without_network() {
        let err = archive("/ws", 13144, &json!({ "session_id": "not-a-uuid" }))
            .await
            .unwrap_err();
        assert!(err.contains("Invalid session_id"));
    }

    #[tokio::test]
    async fn export_pi_transcript_rejects_invalid_uuid_without_network() {
        let err = export_pi_transcript("/ws", &json!({ "session_id": "not-a-uuid" }))
            .await
            .unwrap_err();
        assert!(err.contains("Invalid session_id"));
    }

    #[test]
    fn default_transcript_path_sits_under_workspace_meta_exports() {
        let dir = tempfile::tempdir().unwrap();
        let path = default_transcript_output_path(dir.path(), UUID);
        assert!(path.starts_with(dir.path()));
        let as_str = path.to_string_lossy();
        assert!(as_str.contains("exports"));
        assert!(as_str.ends_with(&format!("pi-transcript-{UUID}.json")));
    }

    #[test]
    fn fence_output_path_accepts_relative_and_absolute_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let rel = fence_output_path(dir.path(), Path::new("out.json")).unwrap();
        assert_eq!(rel, dir.path().join("out.json"));
        let abs = fence_output_path(dir.path(), &dir.path().join("nested/a.json")).unwrap();
        assert_eq!(abs, dir.path().join("nested/a.json"));
    }

    #[test]
    fn fence_output_path_rejects_parent_dir_and_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = fence_output_path(dir.path(), Path::new("../escape.json")).unwrap_err();
        assert!(err.contains(".."));
        let err = fence_output_path(dir.path(), Path::new("/tmp/outside.json")).unwrap_err();
        assert!(err.contains("inside the workspace"));
        let err = fence_output_path(dir.path(), dir.path()).unwrap_err();
        assert!(err.contains("file inside the workspace"));
    }
}
