//! Read a pi session JSONL off disk for analysis export.
//!
//! The live host (`get_entries` / `get_state`) is not consulted: JSONL is the
//! persistence source, and analysis usually wants a completed session. An
//! in-flight turn that has not been flushed yet will be missing.

use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::config::SessionBinding;

const SESSION_ID_PREFIX: &str = "pi:";
const HUGE_INLINE_MIN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptError {
    NotPiSession,
    EscapedPath,
    FileMissing,
    Io(String),
    InvalidJson { line: usize },
    NoTranscripts,
}

#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    pub sanitize: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self { sanitize: true }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PiTranscript {
    pub workspace_id: String,
    pub acp_session_id: String,
    pub session_file: String,
    pub entry_count: usize,
    pub skipped_lines: usize,
    pub entries: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiTranscriptBundle {
    pub teamclu_session_id: String,
    pub exported_at: String,
    pub source: String,
    pub transcripts: Vec<PiTranscript>,
}

pub fn session_file_from_acp_id(acp_session_id: &str) -> Result<PathBuf, TranscriptError> {
    let rest = acp_session_id
        .strip_prefix(SESSION_ID_PREFIX)
        .ok_or(TranscriptError::NotPiSession)?;
    if rest.is_empty() {
        return Err(TranscriptError::NotPiSession);
    }
    Ok(PathBuf::from(rest))
}

/// Lexical fence: the session file must sit under `pi-sessions/` and must
/// not contain `..`. Canonicalize-after-exists is applied in [`export_session`]
/// so a symlink cannot walk out of the root.
pub fn fence_session_file(
    path: &Path,
    pi_sessions_root: &Path,
) -> Result<PathBuf, TranscriptError> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(TranscriptError::EscapedPath);
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        pi_sessions_root.join(path)
    };
    if !path_starts_with(&abs, pi_sessions_root) {
        return Err(TranscriptError::EscapedPath);
    }
    Ok(abs)
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    let path_comps: Vec<_> = path.components().collect();
    let root_comps: Vec<_> = root.components().collect();
    path_comps.starts_with(&root_comps)
}

pub fn parse_jsonl(text: &str) -> Result<(Vec<Value>, usize), TranscriptError> {
    let mut entries = Vec::new();
    let mut skipped = 0usize;
    for (idx, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => entries.push(value),
            Err(_) => {
                if line.starts_with('{') || line.starts_with('[') {
                    return Err(TranscriptError::InvalidJson { line: idx + 1 });
                }
                skipped += 1;
            }
        }
    }
    Ok((entries, skipped))
}

pub fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_str(s)),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if should_drop_inline_blob(k, v) {
                    continue;
                }
                out.insert(k.clone(), redact_value(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn redact_str(s: &str) -> String {
    let mut out = s.to_string();
    out = redact_jwt(&out);
    out = redact_sk_keys(&out);
    out
}

fn redact_jwt(s: &str) -> String {
    // JWT: three base64url segments starting with the standard header.
    const HEAD: &str = "eyJ";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find(HEAD) {
        out.push_str(&rest[..idx]);
        let candidate = &rest[idx..];
        if let Some(end) = jwt_end(candidate.as_bytes()) {
            out.push_str("[redacted]");
            rest = &candidate[end..];
        } else {
            out.push_str(HEAD);
            rest = &candidate[HEAD.len()..];
        }
    }
    out.push_str(rest);
    out
}

fn jwt_end(bytes: &[u8]) -> Option<usize> {
    // header.payload.sig — require two dots and jwt-ish charset.
    let mut dots = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'.' {
            dots += 1;
            i += 1;
            continue;
        }
        if c.is_ascii_alphanumeric() || c == b'-' || c == b'_' {
            i += 1;
            continue;
        }
        break;
    }
    if dots == 2 && i > 8 {
        Some(i)
    } else {
        None
    }
}

fn redact_sk_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("sk-") {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + 3..];
        let n = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .count();
        if n >= 8 {
            out.push_str("[redacted-key]");
            rest = &after[n..];
        } else {
            out.push_str("sk-");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn should_drop_inline_blob(key: &str, value: &Value) -> bool {
    let Some(raw) = value.as_str() else {
        return false;
    };
    if raw.len() < HUGE_INLINE_MIN {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    matches!(lower.as_str(), "base64" | "binary" | "bytes" | "data") && looks_like_base64(raw)
}

fn looks_like_base64(raw: &str) -> bool {
    if raw
        .get(..22)
        .map(|prefix| prefix.eq_ignore_ascii_case("data:") && raw.contains(";base64,"))
        .unwrap_or(false)
    {
        return true;
    }
    let compact: String = raw.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.len() >= HUGE_INLINE_MIN
        && compact
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
}

pub fn export_session(
    cloud_session_id: &str,
    bindings: &[SessionBinding],
    workspace_id: Option<&str>,
    pi_sessions_root: &Path,
    opts: ExportOptions,
) -> Result<PiTranscriptBundle, TranscriptError> {
    let mut transcripts = Vec::new();
    let mut first_escape: Option<TranscriptError> = None;
    for binding in bindings {
        if binding.cloud_session_id != cloud_session_id {
            continue;
        }
        if let Some(ws) = workspace_id.filter(|s| !s.is_empty()) {
            if binding.workspace_id != ws {
                continue;
            }
        }
        match load_one(binding, pi_sessions_root, opts) {
            Ok(t) => transcripts.push(t),
            Err(TranscriptError::NotPiSession) => continue,
            Err(TranscriptError::FileMissing) => continue,
            Err(TranscriptError::EscapedPath) => {
                first_escape = Some(TranscriptError::EscapedPath);
            }
            Err(e) => return Err(e),
        }
    }
    if transcripts.is_empty() {
        return Err(first_escape.unwrap_or(TranscriptError::NoTranscripts));
    }
    Ok(PiTranscriptBundle {
        teamclu_session_id: cloud_session_id.to_string(),
        exported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        source: "pi_jsonl".to_string(),
        transcripts,
    })
}

fn load_one(
    binding: &SessionBinding,
    pi_sessions_root: &Path,
    opts: ExportOptions,
) -> Result<PiTranscript, TranscriptError> {
    let path = session_file_from_acp_id(&binding.acp_session_id)?;
    let fenced = fence_session_file(&path, pi_sessions_root)?;
    if !fenced.is_file() {
        return Err(TranscriptError::FileMissing);
    }
    if let (Ok(canon), Ok(root_canon)) = (fenced.canonicalize(), pi_sessions_root.canonicalize()) {
        if !path_starts_with(&canon, &root_canon) {
            return Err(TranscriptError::EscapedPath);
        }
    }
    let text = std::fs::read_to_string(&fenced).map_err(|e| TranscriptError::Io(e.to_string()))?;
    let (mut entries, skipped_lines) = parse_jsonl(&text)?;
    if opts.sanitize {
        entries = entries.into_iter().map(|e| redact_value(&e)).collect();
    }
    let entry_count = entries.len();
    Ok(PiTranscript {
        workspace_id: binding.workspace_id.clone(),
        acp_session_id: binding.acp_session_id.clone(),
        session_file: fenced.display().to_string(),
        entry_count,
        skipped_lines,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acp_id_strips_pi_prefix() {
        let path = session_file_from_acp_id("pi:/tmp/state/pi-sessions/ab/s.jsonl").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/state/pi-sessions/ab/s.jsonl"));
    }

    #[test]
    fn acp_id_rejects_non_pi() {
        assert_eq!(
            session_file_from_acp_id("ses_opencode"),
            Err(TranscriptError::NotPiSession)
        );
        assert_eq!(
            session_file_from_acp_id("pi:"),
            Err(TranscriptError::NotPiSession)
        );
    }

    #[test]
    fn fence_accepts_file_under_pi_sessions() {
        let root = PathBuf::from("/tmp/state/pi-sessions");
        let path = PathBuf::from("/tmp/state/pi-sessions/ab/s.jsonl");
        assert_eq!(fence_session_file(&path, &root).unwrap(), path);
    }

    #[test]
    fn fence_rejects_escape_and_dotdot() {
        let root = PathBuf::from("/tmp/state/pi-sessions");
        assert_eq!(
            fence_session_file(Path::new("/etc/passwd"), &root),
            Err(TranscriptError::EscapedPath)
        );
        assert_eq!(
            fence_session_file(Path::new("/tmp/state/pi-sessions/../secrets.enc"), &root),
            Err(TranscriptError::EscapedPath)
        );
    }

    #[test]
    fn parse_jsonl_keeps_objects_skips_blank() {
        let text = "\n{\"type\":\"session\",\"id\":\"a\"}\n\n{\"type\":\"message\"}\nnot-json\n";
        let (entries, skipped) = parse_jsonl(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["type"], "session");
        assert_eq!(entries[1]["type"], "message");
        assert_eq!(skipped, 1);
    }

    #[test]
    fn redact_masks_jwt_and_api_keys() {
        let raw = json!({
            "message": {
                "content": [
                    {"type": "text", "text": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.sig"},
                    {"type": "text", "text": "key sk-abcdefghijklmnop"}
                ]
            }
        });
        let redacted = redact_value(&raw);
        let text0 = redacted["message"]["content"][0]["text"].as_str().unwrap();
        let text1 = redacted["message"]["content"][1]["text"].as_str().unwrap();
        assert!(!text0.contains("eyJhbGci"));
        assert!(text0.contains("[redacted]"));
        assert!(!text1.contains("sk-abcdefghijklmnop"));
        assert!(text1.contains("[redacted-key]"));
    }

    #[test]
    fn export_reads_jsonl_for_matching_binding() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("pi-sessions");
        let file = root.join("ab").join("s.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "{\"type\":\"session\"}\n{\"type\":\"message\",\"role\":\"user\"}\n",
        )
        .unwrap();

        let acp = format!("pi:{}", file.display());
        let bindings = vec![SessionBinding::new("cloud-1", "ws-a", 1, &acp)];
        let bundle = export_session(
            "cloud-1",
            &bindings,
            None,
            &root,
            ExportOptions { sanitize: false },
        )
        .unwrap();
        assert_eq!(bundle.teamclu_session_id, "cloud-1");
        assert_eq!(bundle.source, "pi_jsonl");
        assert_eq!(bundle.transcripts.len(), 1);
        assert_eq!(bundle.transcripts[0].workspace_id, "ws-a");
        assert_eq!(bundle.transcripts[0].entry_count, 2);
        assert_eq!(bundle.transcripts[0].entries[1]["role"], "user");
    }

    #[test]
    fn export_filters_workspace_and_skips_non_pi() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("pi-sessions");
        let file = root.join("ab").join("s.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{\"type\":\"session\"}\n").unwrap();
        let acp = format!("pi:{}", file.display());
        let bindings = vec![
            SessionBinding::new("cloud-1", "ws-a", 1, &acp),
            SessionBinding::new("cloud-1", "ws-b", 1, "ses_opencode"),
        ];
        let bundle = export_session(
            "cloud-1",
            &bindings,
            Some("ws-a"),
            &root,
            ExportOptions::default(),
        )
        .unwrap();
        assert_eq!(bundle.transcripts.len(), 1);
        assert_eq!(bundle.transcripts[0].workspace_id, "ws-a");
    }

    #[test]
    fn export_without_bindings_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("pi-sessions");
        std::fs::create_dir_all(&root).unwrap();
        let err =
            export_session("missing", &[], None, &root, ExportOptions::default()).unwrap_err();
        assert_eq!(err, TranscriptError::NoTranscripts);
    }

    #[test]
    fn export_rejects_binding_outside_pi_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("pi-sessions");
        std::fs::create_dir_all(&root).unwrap();
        let outside = dir.path().join("secrets.enc");
        std::fs::write(&outside, "secret").unwrap();
        let acp = format!("pi:{}", outside.display());
        let bindings = vec![SessionBinding::new("cloud-1", "ws-a", 1, &acp)];
        let err = export_session("cloud-1", &bindings, None, &root, ExportOptions::default())
            .unwrap_err();
        assert_eq!(err, TranscriptError::EscapedPath);
    }
}
