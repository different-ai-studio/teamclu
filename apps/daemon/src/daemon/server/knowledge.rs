//! Control-socket handler for knowledge-base MCP tools.
//!
//! Wire shape follows `skills-manage`: a JSON envelope
//! `{ "cmd": "knowledge", "action": ..., ... }` on the daemon control socket,
//! handled here as pure vault file operations. The agent-facing MCP server
//! (sidecar / pi extension) is the transport that turns these into tools;
//! this module is deliberately transport-agnostic.
//!
//! Tool surface (docs/plans/2026-08-31-team-knowledge-base-program.md §附录 D):
//! - `scaffold` — generate the standard vault tree + bilingual templates
//! - `create`   — create one page from a template (adr / runbook / domain-index / page)
//! - `search`   — filename + content search across the vault
//!
//! All writes are confined to the active team's `shared/knowledge/` root;
//! path traversal outside the vault is rejected.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config::{
    global_team_store::sync_content_root,
    knowledge_scaffold::{domain_index_template, scaffold_at, today_iso},
    layout,
};

use super::DaemonServer;

const MAX_SEARCH_RESULTS: usize = 50;
const MAX_SNIPPET_LEN: usize = 160;

fn err(code: &str, message: impl Into<String>) -> String {
    json!({ "ok": false, "error": message.into(), "errorCode": code }).to_string()
}

fn ok(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

/// The active team's vault root, or an error envelope when the daemon is
/// unclaimed — knowledge is team-scoped by construction.
fn vault_root() -> Result<PathBuf, String> {
    let team_id = layout::active_team();
    if team_id == layout::UNCLAIMED_TEAM {
        return Err(err(
            "no_team",
            "daemon is not onboarded to a team; knowledge vault is team-scoped",
        ));
    }
    Ok(sync_content_root(&team_id).join("knowledge"))
}

/// Resolve a caller-supplied relative path against the vault root, rejecting
/// anything that escapes it.
fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err(err("invalid_path", "path is required"));
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(err("invalid_path", "path must be relative to the vault"));
    }
    let mut clean = PathBuf::new();
    for comp in rel_path.components() {
        match comp {
            std::path::Component::Normal(part) => clean.push(part),
            std::path::Component::CurDir => {}
            _ => {
                return Err(err(
                    "invalid_path",
                    "path must not contain '..' or other escapes",
                ))
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(err("invalid_path", "path is required"));
    }
    Ok(root.join(clean))
}

fn str_field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

impl DaemonServer {
    pub(crate) async fn handle_knowledge(
        &self,
        payload: Value,
        reply_tx: tokio::sync::oneshot::Sender<String>,
    ) {
        let reply = self.handle_knowledge_inner(payload).await;
        let _ = reply_tx.send(reply);
    }

    async fn handle_knowledge_inner(&self, payload: Value) -> String {
        let action = str_field(&payload, "action").unwrap_or("");
        let root = match vault_root() {
            Ok(root) => root,
            Err(e) => return e,
        };
        match action {
            "scaffold" => knowledge_scaffold(&root, &payload),
            "create" => knowledge_create(&root, &payload),
            "search" => knowledge_search(&root, &payload),
            other => err(
                "unknown_action",
                format!("unknown knowledge action '{other}'; expected scaffold|create|search"),
            ),
        }
    }
}

fn knowledge_scaffold(root: &Path, payload: &Value) -> String {
    let team_id = layout::active_team();
    let name = str_field(payload, "team_name").unwrap_or(team_id.as_str());
    match scaffold_at(root, &team_id, name) {
        Ok(report) => ok(json!({
            "knowledgeRoot": report.knowledge_root,
            "dirsCreated": report.dirs_created,
            "filesCreated": report.files_created,
            "filesSkipped": report.files_skipped,
        })),
        Err(e) => err("scaffold_failed", format!("scaffold failed: {e}")),
    }
}

fn knowledge_create(root: &Path, payload: &Value) -> String {
    let Some(kind) = str_field(payload, "kind") else {
        return err("invalid_kind", "kind is required (adr | runbook | domain-index | page)");
    };
    let Some(path) = str_field(payload, "path") else {
        return err("invalid_path", "path is required (relative to the vault)");
    };
    let target = match resolve_in_vault(root, path) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if target.exists() {
        return err(
            "already_exists",
            format!("'{path}' already exists; refusing to overwrite"),
        );
    }
    let title = str_field(payload, "title").unwrap_or("Untitled");
    let today = today_iso();
    let body = match kind {
        "adr" => template_render(TemplateKind::Adr, title, &today),
        "runbook" => template_render(TemplateKind::Runbook, title, &today),
        "domain-index" => template_render(TemplateKind::DomainIndex, title, &today),
        "page" => format!("# {title}\n"),
        other => {
            return err(
                "invalid_kind",
                format!("unknown kind '{other}'; expected adr | runbook | domain-index | page"),
            )
        }
    };
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err("write_failed", format!("creating parent dirs failed: {e}"));
        }
    }
    match std::fs::write(&target, body) {
        Ok(()) => ok(json!({ "created": target })),
        Err(e) => err("write_failed", format!("write failed: {e}")),
    }
}

enum TemplateKind {
    Adr,
    Runbook,
    DomainIndex,
}

fn template_render(kind: TemplateKind, title: &str, today: &str) -> String {
    let raw = match kind {
        TemplateKind::Adr => include_str!("../../../assets/knowledge-templates/adr-template.md"),
        TemplateKind::Runbook => {
            include_str!("../../../assets/knowledge-templates/runbook-template.md")
        }
        TemplateKind::DomainIndex => domain_index_template(),
    };
    raw.replace("{{TITLE}}", title).replace("{{DATE}}", today)
}

fn knowledge_search(root: &Path, payload: &Value) -> String {
    let Some(query) = str_field(payload, "query") else {
        return err("invalid_query", "query is required");
    };
    if !root.is_dir() {
        // Not scaffolded yet — an empty result set is the honest answer.
        return ok(json!({ "results": [], "vaultExists": false }));
    }
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    collect_md_files(root, root, &mut results);
    let mut hits = Vec::new();
    for (rel, abs) in results {
        let rel_str = rel.to_string_lossy().to_string();
        let mut matched_line: Option<(usize, String)> = None;
        let name_hit = rel_str.to_lowercase().contains(&needle);
        if let Ok(content) = std::fs::read_to_string(&abs) {
            for (idx, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    let mut snippet = line.trim().to_string();
                    if snippet.len() > MAX_SNIPPET_LEN {
                        snippet.truncate(MAX_SNIPPET_LEN);
                        snippet.push('…');
                    }
                    matched_line = Some((idx + 1, snippet));
                    break;
                }
            }
        }
        if name_hit || matched_line.is_some() {
            hits.push(json!({
                "path": rel_str,
                "nameMatch": name_hit,
                "line": matched_line.as_ref().map(|(n, _)| *n),
                "snippet": matched_line.map(|(_, s)| s),
            }));
            if hits.len() >= MAX_SEARCH_RESULTS {
                break;
            }
        }
    }
    ok(json!({ "results": hits, "vaultExists": true }))
}

fn collect_md_files(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip scaffold-internal and conflict sidecar trees — they are not
        // user knowledge and would pollute results.
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "attachments" {
            continue;
        }
        if path.is_dir() {
            collect_md_files(root, &path, out);
        } else if name.ends_with(".md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_path_buf(), path.clone()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_in_vault_rejects_traversal() {
        let root = Path::new("/vault");
        assert!(resolve_in_vault(root, "../escape.md").is_err());
        assert!(resolve_in_vault(root, "/abs/path.md").is_err());
        assert!(resolve_in_vault(root, "a/../../b.md").is_err());
        assert!(resolve_in_vault(root, "  ").is_err());
        let ok = resolve_in_vault(root, "30-decisions/0001-x.md").unwrap();
        assert_eq!(ok, root.join("30-decisions/0001-x.md"));
    }

    #[test]
    fn search_finds_content_and_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("40-runbooks")).unwrap();
        std::fs::write(
            root.join("40-runbooks/push-outage.md"),
            "# Push outage\n\n检查渠道状态页 / Check the channel status page\n",
        )
        .unwrap();
        std::fs::write(root.join("00-home.md"), "# Home\nnothing here\n").unwrap();

        let payload = json!({ "query": "渠道" });
        let reply = knowledge_search(root, &payload);
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["ok"], true);
        let results = v["result"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["path"], "40-runbooks/push-outage.md");
        assert!(results[0]["snippet"].as_str().unwrap().contains("渠道"));
    }

    #[test]
    fn search_on_missing_vault_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        let reply = knowledge_search(&tmp.path().join("nope"), &json!({ "query": "x" }));
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["vaultExists"], false);
    }
}
