//! Control-socket handler for knowledge-base MCP tools.
//!
//! Wire shape follows `skills-manage`: a JSON envelope
//! `{ "cmd": "knowledge", "action": ..., ... }` on the daemon control socket,
//! handled here as pure vault file operations. The agent-facing MCP manifest
//! (`assets/knowledge-templates/mcp-manifest.json`) is the discovery surface
//! that turns these into tools for MCP hosts; this module is deliberately
//! transport-agnostic.
//!
//! Tool surface (docs/plans/2026-08-31-team-knowledge-base-program.md §附录 D):
//! - `scaffold`      — generate the standard vault tree + bilingual templates
//! - `create`        — create one page from a template (adr / runbook / domain-index / page)
//! - `write`         — write or edit a page (overwrite, path-locked to the vault)
//! - `salvage`       — capture a conversation conclusion into a vault page
//! - `search`        — full-text search (SQLite FTS5; index kept outside the vault)
//! - `manifest_get`  — read knowledge.manifest.yaml
//! - `manifest_set`  — update manifest fields (visibility change needs confirm:true)
//! - `health`        — freshness / coverage stats
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
const SALVAGE_DIR: &str = "00-salvage";
/// How far `salvage` will walk the `-2`, `-3`, … suffixes before giving up.
/// Only a runaway caller reaches this; a human salvaging by hand never will.
const MAX_SALVAGE_SUFFIX: usize = 50;
const FRESH_KINDS: &[&str] = &["runbook"];
const STALE_DAYS_RUNBOOK: i64 = 90;
const STALE_DAYS_UPDATED: i64 = 90;

mod index;

fn err(code: &str, message: impl Into<String>) -> String {
    json!({ "ok": false, "error": message.into(), "errorCode": code }).to_string()
}

fn ok(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

/// The active team, or an error envelope when the daemon is unclaimed —
/// knowledge is team-scoped by construction.
fn active_team_id() -> Result<String, String> {
    let team_id = layout::active_team();
    if team_id == layout::UNCLAIMED_TEAM {
        return Err(err(
            "no_team",
            "daemon is not onboarded to a team; knowledge vault is team-scoped",
        ));
    }
    Ok(team_id)
}

/// `<team>/shared/team-sync/knowledge` — the synced vault itself.
fn vault_root(team_id: &str) -> PathBuf {
    sync_content_root(team_id).join("knowledge")
}

/// `<team>/state/knowledge-index` — where the derived search index lives.
///
/// Under `state/`, which is a sibling of `shared/` and therefore outside the
/// synced tree by construction. It must not live in the vault: the scanner
/// walks `knowledge/` with `WalkDir` and no rule skips dot-directories, so an
/// index in there is uploaded to the team as ordinary content (a second, full
/// plaintext copy of every page), and each `search` writes to its WAL, which
/// wakes the notify watcher and kicks off another sync. Each device also
/// writes its own — the `.obsidian/` shape `ignore_rules` calls a permanent
/// conflict factory.
fn index_root(team_id: &str) -> PathBuf {
    layout::team_state_dir(team_id).join("knowledge-index")
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
        let team_id = match active_team_id() {
            Ok(id) => id,
            Err(e) => return e,
        };
        let root = vault_root(&team_id);
        match action {
            "scaffold" => knowledge_scaffold(&root, &payload),
            "create" => knowledge_create(&root, &payload),
            "write" => knowledge_write(&root, &payload),
            "salvage" => knowledge_salvage(&root, &payload),
            "search" => index::search(&root, &index_root(&team_id), &payload),
            "manifest_get" => manifest_get(&root),
            "manifest_set" => manifest_set(&root, &payload),
            "health" => health(&root),
            other => err(
                "unknown_action",
                format!(
                    "unknown knowledge action '{other}'; expected \
                     scaffold|create|write|salvage|search|manifest_get|manifest_set|health"
                ),
            ),
        }
    }
}

// --- scaffold / create / write / salvage ---------------------------------

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

/// Build the page body for `create` / `salvage`. `template:` is optional;
/// `content:` overrides the template body when given.
fn page_body(
    kind: &Option<Value>,
    template: Option<&str>,
    title: &str,
    content: Option<&str>,
    today: &str,
) -> Result<String, String> {
    let k = template.or(kind.as_ref().and_then(Value::as_str)).unwrap_or("page");
    // A caller-supplied body always wins — the template is only the default.
    if let Some(body) = content {
        return Ok(format!("# {title}\n\n{body}\n"));
    }
    let raw = match k {
        "adr" => include_str!("../../../assets/knowledge-templates/adr-template.md"),
        "runbook" => include_str!("../../../assets/knowledge-templates/runbook-template.md"),
        "domain-index" => domain_index_template(),
        "page" => "# {{TITLE}}\n",
        other => {
            return Err(format!(
                "unknown kind/template '{other}'; expected adr | runbook | domain-index | page"
            ))
        }
    };
    Ok(raw.replace("{{TITLE}}", title).replace("{{DATE}}", today))
}

fn create_or_write(
    root: &Path,
    payload: &Value,
    overwrite: bool,
) -> String {
    let Some(path) = str_field(payload, "path") else {
        return err("invalid_path", "path is required (relative to the vault)");
    };
    let target = match resolve_in_vault(root, path) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if !overwrite && target.exists() {
        return err(
            "already_exists",
            format!("'{path}' already exists; refusing to overwrite"),
        );
    }
    let title = str_field(payload, "title").unwrap_or("Untitled");
    let content = str_field(payload, "content");
    let template = str_field(payload, "template");
    let kind = payload.get("kind").cloned();
    let today = today_iso();
    let body = match page_body(&kind, template, title, content, &today) {
        Ok(b) => b,
        Err(e) => return err("invalid_kind", e),
    };
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err("write_failed", format!("creating parent dirs failed: {e}"));
        }
    }
    match std::fs::write(&target, body) {
        Ok(()) => ok(json!({
            "path": target
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| target.to_string_lossy().into_owned()),
            "overwritten": overwrite && target.exists(),
        })),
        Err(e) => err("write_failed", format!("write failed: {e}")),
    }
}

fn knowledge_create(root: &Path, payload: &Value) -> String {
    create_or_write(root, payload, false)
}

fn knowledge_write(root: &Path, payload: &Value) -> String {
    create_or_write(root, payload, true)
}

fn knowledge_salvage(root: &Path, payload: &Value) -> String {
    let Some(content) = str_field(payload, "content") else {
        return err("invalid_content", "content is required for salvage");
    };
    let title = str_field(payload, "title").unwrap_or("salvaged-note");
    let source = str_field(payload, "source").unwrap_or("unknown");
    let session_id = str_field(payload, "session_id").unwrap_or("");
    let today = today_iso();
    let slug = slugify(title);
    let body = format!(
        "---\ntype: salvage\nsource: {source}\nsession-id: {session_id}\nsalvaged: {today}\n---\n\n# {title}\n\n{content}\n"
    );
    let dir = match resolve_in_vault(root, SALVAGE_DIR) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return err("write_failed", format!("creating salvage dir failed: {e}"));
    }

    // Two conclusions salvaged the same day can legitimately share a slug.
    // Refusing the second one loses it — the content exists nowhere but the
    // conversation the caller is salvaging *from*. Take the next free suffix
    // instead, with `create_new` so the check and the write are one step.
    for n in 1..=MAX_SALVAGE_SUFFIX {
        let name = if n == 1 {
            format!("{today}-{slug}.md")
        } else {
            format!("{today}-{slug}-{n}.md")
        };
        let target = dir.join(&name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                return match std::io::Write::write_all(&mut file, body.as_bytes()) {
                    Ok(()) => ok(json!({ "path": format!("{SALVAGE_DIR}/{name}") })),
                    Err(e) => err("write_failed", format!("write failed: {e}")),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return err("write_failed", format!("write failed: {e}")),
        }
    }
    err(
        "already_exists",
        format!("'{SALVAGE_DIR}/{today}-{slug}' already has {MAX_SALVAGE_SUFFIX} notes"),
    )
}

/// Filename slug for a human title. Keeps letters and digits of any script,
/// turns every other run into a single `-`.
///
/// It used to keep only `is_ascii_alphanumeric`, and to *skip* whitespace
/// rather than separate on it. Both halves were wrong for the language this
/// vault is mostly written in: a title of pure Chinese produced an empty slug
/// and fell back to `note`, so every Chinese salvage on a given day landed on
/// the same filename — and salvage refused to overwrite, which meant the
/// second note of the day was simply lost. `Push 文案公式` kept only `push`
/// and `Push outage runbook` came out as `pushoutagerunbook`.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    // Truncate first, then trim: cutting at 48 can land on a separator.
    let capped: String = out.trim_matches('-').chars().take(48).collect();
    let trimmed = capped.trim_matches('-');
    if trimmed.is_empty() {
        "note".to_string()
    } else {
        trimmed.to_string()
    }
}

// --- manifest (lenient YAML subset — the manifest is user-edited) ---------

const MANIFEST: &str = "knowledge.manifest.yaml";

fn manifest_get(root: &Path) -> String {
    let path = root.join(MANIFEST);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return err(
            "no_manifest",
            "knowledge.manifest.yaml not found; run scaffold first",
        );
    };
    ok(json!({ "raw": raw }))
}

fn manifest_set(root: &Path, payload: &Value) -> String {
    let path = root.join(MANIFEST);
    let Ok(mut raw) = std::fs::read_to_string(&path) else {
        return err(
            "no_manifest",
            "knowledge.manifest.yaml not found; run scaffold first",
        );
    };
    // Visibility flips demand an explicit confirm flag — an agent must not
    // silently open the vault to the org (附录 D 安全约束).
    if let Some(vis) = str_field(payload, "visibility") {
        let confirm = payload
            .get("confirm")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirm {
            return err(
                "confirm_required",
                "visibility change requires confirm=true (publishing is a considered action)",
            );
        }
        if vis != "private" && vis != "org" {
            return err("invalid_value", "visibility must be 'private' or 'org'");
        }
        raw = replace_lenient_yaml_scalar(&raw, "visibility", vis);
    }
    if let Some(summary) = str_field(payload, "summary") {
        raw = replace_lenient_yaml_scalar(&raw, "summary", summary);
    }
    if let Some(team) = str_field(payload, "team") {
        raw = replace_lenient_yaml_scalar(&raw, "team", team);
    }
    if let Some(title) = str_field(payload, "title") {
        raw = replace_lenient_yaml_scalar(&raw, "title", title);
    }
    match std::fs::write(&path, &raw) {
        Ok(()) => ok(json!({ "written": MANIFEST })),
        Err(e) => err("write_failed", format!("manifest write failed: {e}")),
    }
}

/// Minimal line-based YAML scalar rewriter. Handles scalar values only —
/// `version: 1`, `visibility: private`. List/map blocks pass through
/// unchanged; users edit those by hand in Obsidian anyway.
fn replace_lenient_yaml_scalar(raw: &str, key: &str, value: &str) -> String {
    let mut next = Vec::with_capacity(raw.lines().count());
    for line in raw.lines() {
        if let Some((k, _)) = line.split_once(':') {
            if k.trim() == key && !line.trim_start().starts_with('#') {
                let indent = &line[..line.len() - line.trim_start().len()];
                let formatted = if value.contains(&['"', '\'', '#', ':'][..]) || value.len() != value.trim().len() {
                    format!("{indent}{key}: \"{value}\"")
                } else {
                    format!("{indent}{key}: {value}")
                };
                next.push(formatted);
                continue;
            }
        }
        next.push(line.to_string());
    }
    next.join("\n") + if raw.ends_with('\n') { "\n" } else { "" }
}

// --- health (freshness / coverage) -----------------------------------------

fn health(root: &Path) -> String {
    if !root.is_dir() {
        return ok(json!({ "vaultExists": false }));
    }
    let mut files = Vec::new();
    collect_md_files(root, root, &mut files);
    let today = today_iso();
    let mut stale_runbook = 0usize;
    let mut stale_updated = 0usize;
    let mut total = 0usize;
    for (rel, abs) in &files {
        total += 1;
        let Ok(raw) = std::fs::read_to_string(abs) else { continue };
        let (kind, owner, verified, updated) = parse_frontmatter(&raw);
        let _ = owner;
        let rel_str = rel.to_string_lossy();
        let window = if FRESH_KINDS.contains(&kind.as_str()) {
            STALE_DAYS_RUNBOOK
        } else {
            STALE_DAYS_UPDATED
        };
        let date = if kind == "runbook" {
            verified.as_deref().or(updated.as_deref())
        } else {
            updated.as_deref()
        };
        if let Some(d) = date {
            if days_between(d, &today).map(|n| n > window).unwrap_or(false) {
                if kind == "runbook" {
                    stale_runbook += 1;
                } else {
                    stale_updated += 1;
                }
            }
        }
        let _ = rel_str;
    }
    let coverage = json!({
        "hasHome": root.join("00-home.md").exists(),
        "hasGlossary": root.join("50-glossary.md").exists(),
        "hasManifest": root.join(MANIFEST).exists(),
        "domainsDir": root.join("20-domains").is_dir(),
    });
    ok(json!({
        "vaultExists": true,
        "totalPages": total,
        "staleRunbooks": stale_runbook,
        "staleUpdatedPages": stale_updated,
        "coverage": coverage,
        "staleWindowDays": {
            "runbook": STALE_DAYS_RUNBOOK,
            "updated": STALE_DAYS_UPDATED,
        },
    }))
}

/// Pull (type, owner, last-verified, updated) out of a YAML frontmatter
/// block. Absence of a block is fine — all four come back None.
fn parse_frontmatter(raw: &str) -> (String, Option<String>, Option<String>, Option<String>) {
    let mut kind = String::new();
    let mut owner = None;
    let mut verified = None;
    let mut updated = None;
    let mut lines = raw.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        // runbook detection falls back to path-free inference in health();
        // kind stays empty here.
        let first = raw.lines().next().unwrap_or("");
        if first.starts_with("#") {
            return ("page".to_string(), None, None, None);
        }
        return (kind, owner, verified, updated);
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            let v = v.trim().trim_matches('"');
            match k {
                "type" => kind = v.to_string(),
                "owner" => owner = Some(v.to_string()),
                "last-verified" => verified = Some(v.to_string()),
                "updated" => updated = Some(v.to_string()),
                _ => {}
            }
        }
    }
    (kind, owner, verified, updated)
}

fn days_between(from: &str, to: &str) -> Option<i64> {
    let from_days = iso_to_days(from)?;
    let to_days = iso_to_days(to)?;
    Some(to_days - from_days)
}

fn iso_to_days(s: &str) -> Option<i64> {
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.trim_end_matches('"').parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant's days-from-civil, inverse of today_iso.
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = (y_adj - era * 400) as u64;
    let (m_adj, d_adj) = if m > 2 { (m - 3, d) } else { (m + 9, d) };
    let doy = (153 * (m_adj as u64) + 2) / 5 + (d_adj as u64) - 1;
    let doc = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doc as i64 - 719468)
}

fn collect_md_files(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
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
    fn manifest_scalar_rewrite_preserves_lists() {
        let raw = "version: 1\nvisibility: private\ncollections:\n  - name: x\n";
        let next = replace_lenient_yaml_scalar(raw, "visibility", "org");
        assert!(next.contains("visibility: org"));
        assert!(next.contains("collections:"));
        assert!(next.contains("  - name: x"));
    }

    #[test]
    fn manifest_set_requires_confirm_for_visibility() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join(MANIFEST), "version: 1\nvisibility: private\n").unwrap();
        let bad = manifest_set(root, &json!({ "visibility": "org" }));
        assert!(bad.contains("confirm_required"));
        let good = manifest_set(root, &json!({ "visibility": "org", "confirm": true }));
        assert!(good.contains("\"ok\":true"));
        let raw = std::fs::read_to_string(root.join(MANIFEST)).unwrap();
        assert!(raw.contains("visibility: org"));
    }

    #[test]
    fn frontmatter_parses_runbook_dates() {
        let raw = "---\ntype: runbook\nowner: 老周\nlast-verified: 2026-06-01\n---\n\n# x\n";
        let (kind, owner, verified, _updated) = parse_frontmatter(raw);
        assert_eq!(kind, "runbook");
        assert_eq!(owner.as_deref(), Some("老周"));
        assert_eq!(verified.as_deref(), Some("2026-06-01"));
    }

    #[test]
    fn days_between_handles_quotes_and_order() {
        let raw = "---\ntype: runbook\nlast-verified: \"2026-06-01\"\n---\n";
        let (_, _, verified, _) = parse_frontmatter(raw);
        let today = "2026-09-04";
        let n = days_between(verified.as_deref().unwrap(), today).unwrap();
        assert!(n > 90);
    }

    #[test]
    fn slugify_keeps_cjk_and_separates_on_space() {
        // The four titles from the review, and what each used to produce.
        assert_eq!(slugify("Push 文案公式"), "push-文案公式"); // was "push"
        assert_eq!(slugify("双11备战复盘"), "双11备战复盘"); // was "11"
        assert_eq!(slugify("对账口径"), "对账口径"); // was "note"
        assert_eq!(slugify("Push outage runbook"), "push-outage-runbook"); // was one word

        // Separator runs collapse, edges are trimmed, and a title with nothing
        // to keep still yields a usable name.
        assert_eq!(slugify("  a --- b  "), "a-b");
        assert_eq!(slugify("!!!"), "note");
        assert_eq!(slugify(""), "note");
        assert!(slugify(&"字".repeat(80)).chars().count() <= 48);
        assert!(!slugify("abc ---").ends_with('-'));
    }

    /// Two Chinese titles on the same day used to slug identically, and the
    /// second salvage was refused — losing a conclusion that existed nowhere
    /// else. Distinct titles must now get distinct files either way.
    #[test]
    fn salvage_suffixes_instead_of_losing_the_note() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let salvage = |title: &str, content: &str| {
            let reply = knowledge_salvage(root, &json!({ "title": title, "content": content }));
            let v: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(v["ok"], true, "{v}");
            v["result"]["path"].as_str().unwrap().to_string()
        };

        let first = salvage("对账口径", "一");
        let second = salvage("对账口径", "二");
        assert_ne!(first, second);
        assert!(second.ends_with("-2.md"), "unexpected second path {second}");

        // Both notes are on disk, with their own content.
        assert!(std::fs::read_to_string(root.join(&first))
            .unwrap()
            .contains('一'));
        assert!(std::fs::read_to_string(root.join(&second))
            .unwrap()
            .contains('二'));

        // A different Chinese title is a different file, not another suffix.
        let other = salvage("渠道状态", "三");
        assert!(other.contains("渠道状态"), "unexpected path {other}");
    }

    #[test]
    fn salvage_names_slug_and_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let payload = json!({
            "title": "Push 文案公式",
            "content": "标题 + 利益点 + 行动指令",
            "source": "chat",
        });
        let reply = knowledge_salvage(root, &payload);
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["ok"], true);
        let path = v["result"]["path"].as_str().unwrap();
        assert!(path.starts_with("00-salvage/"));
        assert!(path.ends_with(".md"));
        let raw = std::fs::read_to_string(root.join(path)).unwrap();
        assert!(raw.contains("type: salvage"));
        assert!(raw.contains("source: chat"));
    }

    #[test]
    fn health_counts_stale_runbooks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("40-runbooks")).unwrap();
        std::fs::write(
            root.join("40-runbooks/old.md"),
            "---\ntype: runbook\nlast-verified: 2026-01-01\n---\n# x\n",
        )
        .unwrap();
        std::fs::write(root.join("00-home.md"), "# Home\n").unwrap();
        let reply = health(root);
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["result"]["staleRunbooks"].as_u64().unwrap() >= 1);
    }
}
