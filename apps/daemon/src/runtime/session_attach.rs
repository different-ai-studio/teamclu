//! Pi `session_attach_file`: upload to cloud storage and return a public URL.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

use super::RuntimeManager;
use super::attachment_filename::safe_object_name;
use crate::backend::Backend;
use crate::runtime::context_registry::{ResolveError, ResolveRuntimeContextResponse};

#[derive(Debug, thiserror::Error)]
pub enum SessionAttachError {
    #[error("session_context_unavailable")]
    SessionContextUnavailable,
    #[error("path_not_allowed")]
    PathNotAllowed,
    #[error("read_failed: {0}")]
    ReadFailed(String),
    #[error("upload_failed: {0}")]
    UploadFailed(String),
}

impl SessionAttachError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SessionContextUnavailable => "session_context_unavailable",
            Self::PathNotAllowed => "path_not_allowed",
            Self::ReadFailed(_) => "read_failed",
            Self::UploadFailed(_) => "upload_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::SessionContextUnavailable => {
                "Unable to determine the TeamClu session for this tool call".into()
            }
            Self::PathNotAllowed => "file_path must be under the current workspace".into(),
            Self::ReadFailed(e) => e.clone(),
            Self::UploadFailed(e) => e.clone(),
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::SessionContextUnavailable => 404,
            Self::PathNotAllowed => 422,
            Self::ReadFailed(_) => 422,
            Self::UploadFailed(_) => 502,
        }
    }
}

impl From<ResolveError> for SessionAttachError {
    fn from(_: ResolveError) -> Self {
        Self::SessionContextUnavailable
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachOk {
    pub ok: bool,
    pub file_name: String,
    pub mime_type: String,
    pub size: usize,
    pub storage_path: String,
    pub url: String,
}

pub struct SessionAttachService {
    manager: Arc<AsyncMutex<RuntimeManager>>,
    backend: Arc<dyn Backend>,
}

impl SessionAttachService {
    pub fn new(manager: Arc<AsyncMutex<RuntimeManager>>, backend: Arc<dyn Backend>) -> Self {
        Self { manager, backend }
    }

    pub async fn attach_file(
        &self,
        resolved: &ResolveRuntimeContextResponse,
        file_path: &str,
        _message: Option<&str>,
    ) -> Result<SessionAttachOk, SessionAttachError> {
        let session_id = resolved.teamclu_session_id.trim();
        if session_id.is_empty() {
            return Err(SessionAttachError::SessionContextUnavailable);
        }

        let worktree = {
            let mgr = self.manager.lock().await;
            let handle = mgr.get_handle(&resolved.runtime_id).ok_or(
                SessionAttachError::SessionContextUnavailable,
            )?;
            handle.worktree.clone()
        };

        let path = Path::new(file_path.trim());
        if path.as_os_str().is_empty() {
            return Err(SessionAttachError::PathNotAllowed);
        }
        let canonical_file = canonicalize_under_worktree(path, Path::new(&worktree))?;

        let bytes = tokio::fs::read(&canonical_file)
            .await
            .map_err(|e| SessionAttachError::ReadFailed(format!("read {}: {e}", path.display())))?;
        let filename = canonical_file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let mime = teamclu_gateway::wecom::resolve_mime(&bytes, Some(&filename));
        let size = bytes.len();
        let team_id = self.backend.team_id();
        let attachment_id = uuid::Uuid::new_v4();
        let storage_path = format!(
            "{}/{}/{}/{}",
            team_id,
            session_id,
            attachment_id,
            safe_object_name(&filename)
        );
        let url = self
            .backend
            .upload_attachment_bytes(&storage_path, bytes, &mime)
            .await
            .map_err(|e| SessionAttachError::UploadFailed(e.to_string()))?;

        Ok(SessionAttachOk {
            ok: true,
            file_name: filename,
            mime_type: mime,
            size,
            storage_path,
            url,
        })
    }
}

/// Parsed from pi `session_attach_file` tool result JSON (daemon aggregator path).
pub struct ParsedSessionAttach {
    pub record: teamclu_gateway::AttachmentRecord,
    pub public_url: String,
}

const SESSION_ATTACH_TOOL: &str = "session_attach_file";

/// When the ACP tool result is from `session_attach_file` and reports success,
/// return attachment metadata for turn-final agent reply merge.
pub fn parse_session_attach_tool_result(
    tool_name: &str,
    tr: &crate::proto::amux::AcpToolResult,
) -> Option<ParsedSessionAttach> {
    if tool_name != SESSION_ATTACH_TOOL || !tr.success {
        return None;
    }
    if let Some(parsed) = parse_session_attach_json(&tr.summary) {
        return Some(parsed);
    }
    if !tr.raw_output_json.is_empty() {
        if let Some(parsed) = parse_session_attach_json(&tr.raw_output_json) {
            return Some(parsed);
        }
    }
    for block in &tr.content {
        if let Some(crate::proto::amux::acp_tool_call_content::Payload::Text(text)) =
            block.payload.as_ref()
        {
            if let Some(parsed) = parse_session_attach_json(&text.text) {
                return Some(parsed);
            }
        }
    }
    None
}

fn parse_session_attach_json(raw: &str) -> Option<ParsedSessionAttach> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if v.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    let file_name = v
        .get("fileName")
        .or_else(|| v.get("file_name"))
        .and_then(|x| x.as_str())?;
    let mime = v
        .get("mimeType")
        .or_else(|| v.get("mime_type"))
        .and_then(|x| x.as_str())
        .unwrap_or("application/octet-stream");
    let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let storage_path = v
        .get("storagePath")
        .or_else(|| v.get("storage_path"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
    if storage_path.is_empty() && url.is_empty() {
        return None;
    }
    Some(ParsedSessionAttach {
        record: teamclu_gateway::AttachmentRecord {
            filename: file_name.to_string(),
            mime: mime.to_string(),
            size,
            bucket_path: if storage_path.is_empty() {
                url.to_string()
            } else {
                storage_path.to_string()
            },
            local_path: None,
        },
        public_url: url.to_string(),
    })
}

/// `file` must resolve to a path under `worktree` (no `..` escape).
pub fn canonicalize_under_worktree(
    file: &Path,
    worktree: &Path,
) -> Result<PathBuf, SessionAttachError> {
    let worktree = worktree
        .canonicalize()
        .map_err(|_| SessionAttachError::PathNotAllowed)?;
    let file = if file.is_absolute() {
        file.to_path_buf()
    } else {
        worktree.join(file)
    };
    let canonical = file
        .canonicalize()
        .map_err(|_| SessionAttachError::PathNotAllowed)?;
    if !canonical.starts_with(&worktree) {
        return Err(SessionAttachError::PathNotAllowed);
    }
    if canonical
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(SessionAttachError::PathNotAllowed);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_paths_outside_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("ws");
        fs::create_dir_all(&worktree).unwrap();
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, b"x").unwrap();
        assert!(matches!(
            canonicalize_under_worktree(&outside, &worktree),
            Err(SessionAttachError::PathNotAllowed)
        ));
    }

    #[test]
    fn parses_session_attach_tool_result_json() {
        use crate::proto::amux::AcpToolResult;
        let tr = AcpToolResult {
            tool_id: "t1".into(),
            success: true,
            summary: r#"{"ok":true,"fileName":"a.pdf","mimeType":"application/pdf","size":3,"storagePath":"team/s/a.pdf","url":"https://cdn/a.pdf"}"#.into(),
            raw_output_json: String::new(),
            content: vec![],
        };
        let parsed =
            super::parse_session_attach_tool_result("session_attach_file", &tr).unwrap();
        assert_eq!(parsed.record.filename, "a.pdf");
        assert_eq!(parsed.public_url, "https://cdn/a.pdf");
    }

    #[test]
    fn accepts_file_under_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("ws");
        fs::create_dir_all(&worktree).unwrap();
        let file = worktree.join("a.txt");
        fs::write(&file, b"hi").unwrap();
        let got = canonicalize_under_worktree(&file, &worktree).unwrap();
        assert!(got.ends_with("a.txt"));
    }
}
