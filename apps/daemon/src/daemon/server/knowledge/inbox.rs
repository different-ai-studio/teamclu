//! Session-to-knowledge review inbox.
//!
//! Candidates live under `teams/<id>/state/knowledge-inbox/`, which is
//! daemon-private and never synced. `propose` writes here. `publish` is the
//! only action that creates a vault page — and only the desktop review tab
//! should call it (see docs/specs/2026-09-11-session-knowledge-review-design.md).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::knowledge_scaffold::today_iso;
use crate::config::layout;
use crate::sync::oss::state::ForbiddenPaths;

use super::{create_or_write, err, ok, resolve_in_vault, str_field};

const INBOX_DIR: &str = "knowledge-inbox";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CandidateSource {
    SessionHeader,
    AgentPropose,
    Message,
    Unknown,
}

impl CandidateSource {
    fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("unknown") {
            "session-header" => Self::SessionHeader,
            "agent-propose" => Self::AgentPropose,
            "message" => Self::Message,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CandidateStatus {
    Pending,
    Published,
    Discarded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSuggestion {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnowledgeCandidate {
    pub id: String,
    pub team_id: String,
    pub session_id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub suggested_path: String,
    pub source: CandidateSource,
    pub created_at: String,
    pub status: CandidateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<KnowledgeSuggestion>,
}

pub(crate) fn inbox_dir(team_id: &str) -> PathBuf {
    layout::team_state_dir(team_id).join(INBOX_DIR)
}

fn candidate_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.contains(['/', '\\', '.'])
        || id.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-'))
    {
        return Err(err("invalid_id", "id must be a uuid-like token"));
    }
    Ok(dir.join(format!("{id}.json")))
}

fn read_candidate(dir: &Path, id: &str) -> Result<KnowledgeCandidate, String> {
    let path = candidate_path(dir, id)?;
    let raw = fs::read_to_string(&path)
        .map_err(|_| err("not_found", format!("candidate '{id}' not found")))?;
    serde_json::from_str(&raw).map_err(|e| err("corrupt", format!("candidate '{id}' is unreadable: {e}")))
}

fn write_candidate(dir: &Path, candidate: &KnowledgeCandidate) -> Result<(), String> {
    if let Err(e) = fs::create_dir_all(dir) {
        return Err(err(
            "write_failed",
            format!("creating inbox dir failed: {e}"),
        ));
    }
    let path = candidate_path(dir, &candidate.id)?;
    let raw = serde_json::to_string_pretty(candidate)
        .map_err(|e| err("write_failed", format!("serialize failed: {e}")))?;
    fs::write(&path, raw).map_err(|e| err("write_failed", format!("inbox write failed: {e}")))
}

fn candidate_json(c: &KnowledgeCandidate) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}

fn parse_suggestions(payload: &Value) -> Vec<KnowledgeSuggestion> {
    let Some(arr) = payload.get("suggestions").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| serde_json::from_value::<KnowledgeSuggestion>(item.clone()).ok())
        .filter(|item| !item.text.trim().is_empty())
        .take(8)
        .enumerate()
        .map(|(i, mut item)| {
            let kind = match item.kind.as_str() {
                "decision" | "fact" | "followup" => item.kind.clone(),
                _ => "fact".to_string(),
            };
            item.kind = kind;
            if item.id.trim().is_empty() {
                item.id = format!("{}-{i}", item.kind);
            }
            item
        })
        .collect()
}

/// `propose` — create a pending candidate. Does not touch the vault.
pub(crate) fn propose(team_id: &str, inbox: &Path, payload: &Value) -> String {
    let Some(body) = str_field(payload, "content").or_else(|| str_field(payload, "body")) else {
        return err("invalid_content", "content is required for propose");
    };
    let title = str_field(payload, "title").unwrap_or("untitled");
    let suggested_path = str_field(payload, "suggestedPath")
        .or_else(|| str_field(payload, "suggested_path"))
        .unwrap_or("")
        .to_string();
    if !suggested_path.is_empty() {
        if let Err(e) = resolve_in_vault(Path::new("/vault"), &suggested_path) {
            return e;
        }
    }
    let summary = str_field(payload, "summary")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let candidate = KnowledgeCandidate {
        id: Uuid::new_v4().to_string(),
        team_id: team_id.to_string(),
        session_id: str_field(payload, "sessionId")
            .or_else(|| str_field(payload, "session_id"))
            .unwrap_or("")
            .to_string(),
        title: title.to_string(),
        body: body.to_string(),
        suggested_path,
        source: CandidateSource::parse(str_field(payload, "source")),
        created_at: chrono::Utc::now().to_rfc3339(),
        status: CandidateStatus::Pending,
        published_path: None,
        summary,
        suggestions: parse_suggestions(payload),
    };
    match write_candidate(inbox, &candidate) {
        Ok(()) => ok(candidate_json(&candidate)),
        Err(e) => e,
    }
}

/// Pending candidates, newest first. Published / discarded stay out of the
/// review badge.
pub(crate) fn inbox_list(inbox: &Path) -> String {
    let Ok(entries) = fs::read_dir(inbox) else {
        return ok(json!({ "items": [] }));
    };
    let mut items: Vec<KnowledgeCandidate> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<KnowledgeCandidate>(&raw).ok())
        .filter(|c| c.status == CandidateStatus::Pending)
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    ok(json!({
        "items": items.iter().map(candidate_json).collect::<Vec<_>>(),
    }))
}

pub(crate) fn inbox_get(inbox: &Path, payload: &Value) -> String {
    let Some(id) = str_field(payload, "id") else {
        return err("invalid_id", "id is required");
    };
    match read_candidate(inbox, id) {
        Ok(c) => ok(candidate_json(&c)),
        Err(e) => e,
    }
}

pub(crate) fn inbox_discard(inbox: &Path, payload: &Value) -> String {
    let Some(id) = str_field(payload, "id") else {
        return err("invalid_id", "id is required");
    };
    let path = match candidate_path(inbox, id) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match fs::remove_file(&path) {
        Ok(()) => ok(json!({ "id": id, "status": "discarded" })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            err("not_found", format!("candidate '{id}' not found"))
        }
        Err(e) => err("write_failed", format!("discard failed: {e}")),
    }
}

fn with_md(path: &str) -> String {
    let trimmed = path.trim().trim_start_matches('/');
    match Path::new(trimmed).extension() {
        Some(_) => trimmed.to_string(),
        None => format!("{trimmed}.md"),
    }
}

fn published_page(session_id: &str, title: &str, body: &str) -> String {
    let today = today_iso();
    format!(
        "---\ntype: page\nsource: session\nsession-id: {session_id}\nreviewed: {today}\n---\n\n# {title}\n\n{body}\n"
    )
}

/// `publish` — write the candidate into the vault. Desktop review tab only.
pub(crate) fn publish(
    inbox: &Path,
    vault: &Path,
    payload: &Value,
    blocked: &ForbiddenPaths,
) -> String {
    let Some(id) = str_field(payload, "id") else {
        return err("invalid_id", "id is required");
    };
    let mut candidate = match read_candidate(inbox, id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if candidate.status != CandidateStatus::Pending {
        return err(
            "not_pending",
            format!("candidate '{id}' is {:?}, not pending", candidate.status),
        );
    }
    let title = str_field(payload, "title").unwrap_or(candidate.title.as_str());
    let body = str_field(payload, "content")
        .or_else(|| str_field(payload, "body"))
        .unwrap_or(candidate.body.as_str());
    let path_raw = str_field(payload, "path")
        .or_else(|| {
            if candidate.suggested_path.is_empty() {
                None
            } else {
                Some(candidate.suggested_path.as_str())
            }
        })
        .unwrap_or("");
    if path_raw.is_empty() {
        return err("invalid_path", "path is required (relative to the vault)");
    }
    let path = with_md(path_raw);
    let overwrite = payload
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let page = published_page(&candidate.session_id, title, body);
    let write_payload = json!({
        "path": path,
        "title": title,
        "content": page,
    });
    let reply = create_or_write(vault, &write_payload, overwrite, blocked);
    let parsed: Value = match serde_json::from_str(&reply) {
        Ok(v) => v,
        Err(_) => return reply,
    };
    if parsed.get("ok") != Some(&Value::Bool(true)) {
        return reply;
    }
    let published_path = parsed
        .pointer("/result/path")
        .and_then(Value::as_str)
        .unwrap_or(&path)
        .to_string();
    candidate.title = title.to_string();
    candidate.body = body.to_string();
    candidate.status = CandidateStatus::Published;
    candidate.published_path = Some(published_path.clone());
    // Vault write already landed. Inbox bookkeeping is secondary — the
    // reviewer can see the open editor either way.
    let _ = write_candidate(inbox, &candidate);
    let mut result = parsed
        .get("result")
        .cloned()
        .unwrap_or_else(|| json!({ "path": published_path }));
    if let Some(obj) = result.as_object_mut() {
        obj.insert("id".into(), Value::String(candidate.id.clone()));
        obj.insert("status".into(), Value::String("published".into()));
    }
    ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::oss::state::ForbiddenPath;

    fn tmp_pair() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let inbox = tmp.path().join("inbox");
        let vault = tmp.path().join("vault");
        fs::create_dir_all(&inbox).unwrap();
        fs::create_dir_all(&vault).unwrap();
        (tmp, inbox, vault)
    }

    fn parse(reply: &str) -> Value {
        serde_json::from_str(reply).unwrap()
    }

    #[test]
    fn propose_does_not_touch_the_vault() {
        let (_tmp, inbox, vault) = tmp_pair();
        let reply = propose(
            "team-1",
            &inbox,
            &json!({
                "title": "对账口径",
                "content": "以渠道单号为准",
                "sessionId": "sess-1",
                "source": "agent-propose",
                "suggestedPath": "20-domains/payments/对账口径",
            }),
        );
        let v = parse(&reply);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["status"], "pending");
        assert_eq!(v["result"]["sessionId"], "sess-1");
        assert_eq!(v["result"]["suggestedPath"], "20-domains/payments/对账口径");
        assert!(v["result"]["id"].as_str().unwrap().contains('-'));

        let vault_files: Vec<_> = fs::read_dir(&vault).unwrap().collect();
        assert!(vault_files.is_empty(), "propose must not write the vault");
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 1);
    }

    #[test]
    fn propose_persists_distilled_suggestions() {
        let (_tmp, inbox, vault) = tmp_pair();
        let reply = propose(
            "team-1",
            &inbox,
            &json!({
                "title": "对账口径",
                "content": "以渠道单号为准",
                "summary": "以渠道单号为准",
                "suggestions": [
                    {"id": "d-1", "kind": "decision", "text": "以渠道单号为准"},
                    {"kind": "followup", "text": "补一条 runbook"},
                    {"kind": "noise", "text": ""}
                ],
            }),
        );
        let v = parse(&reply);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["summary"], "以渠道单号为准");
        let items = v["result"]["suggestions"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], "decision");
        assert_eq!(items[1]["kind"], "followup");
        assert_eq!(items[1]["id"], "followup-1");
        assert!(vault.read_dir().unwrap().next().is_none());
    }

    #[test]
    fn inbox_get_reads_candidates_written_before_suggestions_existed() {
        let (_tmp, inbox, _vault) = tmp_pair();
        fs::write(
            inbox.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json"),
            r#"{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","teamId":"t","sessionId":"s","title":"old","body":"plain","suggestedPath":"","source":"session-header","createdAt":"2026-09-11T00:00:00Z","status":"pending"}"#,
        )
        .unwrap();
        let got = parse(&inbox_get(
            &inbox,
            &json!({ "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
        ));
        assert_eq!(got["ok"], true, "{got}");
        assert_eq!(got["result"]["title"], "old");
        assert!(got["result"].get("suggestions").is_none());
    }

    #[test]
    fn propose_rejects_a_path_that_escapes_the_vault() {
        let (_tmp, inbox, vault) = tmp_pair();
        let reply = propose(
            "team-1",
            &inbox,
            &json!({
                "title": "x",
                "content": "y",
                "suggestedPath": "../outside.md",
            }),
        );
        let v = parse(&reply);
        assert_eq!(v["ok"], false, "{v}");
        assert_eq!(v["errorCode"], "invalid_path");
        assert!(vault.read_dir().unwrap().next().is_none());
        assert!(inbox.read_dir().unwrap().next().is_none());
    }

    #[test]
    fn publish_writes_frontmatter_and_leaves_inbox_published() {
        let (_tmp, inbox, vault) = tmp_pair();
        let proposed = parse(&propose(
            "team-1",
            &inbox,
            &json!({
                "title": "对账口径",
                "content": "以渠道单号为准",
                "sessionId": "sess-9",
                "suggestedPath": "20-domains/payments/对账口径",
            }),
        ));
        let id = proposed["result"]["id"].as_str().unwrap();
        let reply = publish(
            &inbox,
            &vault,
            &json!({ "id": id }),
            &ForbiddenPaths::default(),
        );
        let v = parse(&reply);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["path"], "20-domains/payments/对账口径.md");
        assert_eq!(v["result"]["status"], "published");

        let raw = fs::read_to_string(vault.join("20-domains/payments/对账口径.md")).unwrap();
        assert!(raw.contains("type: page"));
        assert!(raw.contains("source: session"));
        assert!(raw.contains("session-id: sess-9"));
        assert!(raw.contains("reviewed:"));
        assert!(raw.contains("# 对账口径"));
        assert!(raw.contains("以渠道单号为准"));

        let listed = parse(&inbox_list(&inbox));
        assert_eq!(listed["result"]["items"].as_array().unwrap().len(), 0);

        let got = parse(&inbox_get(&inbox, &json!({ "id": id })));
        assert_eq!(got["result"]["status"], "published");
        assert_eq!(
            got["result"]["publishedPath"],
            "20-domains/payments/对账口径.md"
        );
    }

    #[test]
    fn publish_refuses_overwrite_unless_asked() {
        let (_tmp, inbox, vault) = tmp_pair();
        fs::create_dir_all(vault.join("20-domains")).unwrap();
        fs::write(vault.join("20-domains/keep.md"), b"original").unwrap();
        let proposed = parse(&propose(
            "team-1",
            &inbox,
            &json!({
                "title": "keep",
                "content": "new",
                "suggestedPath": "20-domains/keep.md",
            }),
        ));
        let id = proposed["result"]["id"].as_str().unwrap();
        let refused = parse(&publish(
            &inbox,
            &vault,
            &json!({ "id": id, "path": "20-domains/keep.md" }),
            &ForbiddenPaths::default(),
        ));
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["errorCode"], "already_exists");
        assert_eq!(
            fs::read_to_string(vault.join("20-domains/keep.md")).unwrap(),
            "original"
        );

        let overwritten = parse(&publish(
            &inbox,
            &vault,
            &json!({ "id": id, "path": "20-domains/keep.md", "overwrite": true }),
            &ForbiddenPaths::default(),
        ));
        assert_eq!(overwritten["ok"], true, "{overwritten}");
        let raw = fs::read_to_string(vault.join("20-domains/keep.md")).unwrap();
        assert!(raw.contains("new"));
        assert!(!raw.contains("original"));
    }

    #[test]
    fn discard_deletes_the_candidate_and_not_the_vault() {
        let (_tmp, inbox, vault) = tmp_pair();
        fs::write(vault.join("existing.md"), b"stay").unwrap();
        let proposed = parse(&propose(
            "team-1",
            &inbox,
            &json!({ "title": "t", "content": "c" }),
        ));
        let id = proposed["result"]["id"].as_str().unwrap();
        let reply = parse(&inbox_discard(&inbox, &json!({ "id": id })));
        assert_eq!(reply["ok"], true, "{reply}");
        assert!(inbox_get(&inbox, &json!({ "id": id })).contains("not_found"));
        assert_eq!(fs::read_to_string(vault.join("existing.md")).unwrap(), "stay");
    }

    #[test]
    fn publish_of_a_refused_directory_still_writes_locally_and_says_not_syncing() {
        let (_tmp, inbox, vault) = tmp_pair();
        let proposed = parse(&propose(
            "team-1",
            &inbox,
            &json!({
                "title": "hr",
                "content": "secret",
                "suggestedPath": "hr/note.md",
            }),
        ));
        let id = proposed["result"]["id"].as_str().unwrap();
        let blocked = ForbiddenPaths::from_entries([(
            "knowledge/hr/salary.md".to_string(),
            ForbiddenPath {
                last_tried_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                reason: "not accessible".into(),
            },
        )]);
        let v = parse(&publish(
            &inbox,
            &vault,
            &json!({ "id": id }),
            &blocked,
        ));
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["teamSync"], "not-syncing");
        assert!(vault.join("hr/note.md").exists());
    }
}
