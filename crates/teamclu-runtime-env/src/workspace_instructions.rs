//! Per-workspace static instructions (`teamclu.json.systemPrompt`) and Claude
//! Code `CLAUDE.md` sync helpers shared by desktop Tauri and amuxd.
//!
//! Lives here rather than in `teamclu-gateway` (#933): a transport adapter has
//! no business rewriting a workspace's agent instructions, and both the desktop
//! and the daemon need these without pulling in a channel crate. It reads the
//! raw JSON rather than the gateway's channel-aware config type, which is what
//! made the move possible at all.

use std::path::Path;

use crate::WORKSPACE_META_DIR as TEAMCLU_DIR;

const CONFIG_FILE_NAME: &str = "teamclu.json";

fn ensure_teamclu_dir(workspace_path: &str) -> Result<(), String> {
    let dir = format!("{workspace_path}/{TEAMCLU_DIR}");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {TEAMCLU_DIR} directory: {e}"))
}

/// The workspace config as raw JSON. Deliberately untyped: this module only
/// wants `systemPrompt`, and typing it would drag the channel config along.
fn read_config_json(workspace_path: &str) -> Option<serde_json::Value> {
    let path = format!("{workspace_path}/{TEAMCLU_DIR}/{CONFIG_FILE_NAME}");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

const CLAUDE_MD_REL: &str = "instructions/CLAUDE.md";
const BLOCK_START: &str = "<!-- teamclu:system-prompt v1 -->";
const BLOCK_END: &str = "<!-- /teamclu:system-prompt -->";

/// Load `systemPrompt` from `{workspace}/.teamclu/teamclu.json`. Returns "" if unset.
pub fn load_system_prompt(workspace_path: &str) -> String {
    read_config_json(workspace_path)
        .and_then(|config| {
            config
                .get("systemPrompt")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn claude_md_path(workspace_path: &str) -> String {
    format!("{workspace_path}/{TEAMCLU_DIR}/{CLAUDE_MD_REL}")
}

fn render_marked_block(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    format!("{BLOCK_START}\n{trimmed}\n{BLOCK_END}\n")
}

fn upsert_marked_block(existing: &str, prompt: &str) -> String {
    let block = render_marked_block(prompt);
    let start_idx = existing.find(BLOCK_START);
    let end_idx = existing.find(BLOCK_END);

    if let (Some(start), Some(end)) = (start_idx, end_idx) {
        let after_end = end + BLOCK_END.len();
        let mut out = String::new();
        out.push_str(&existing[..start]);
        out.push_str(&block);
        if after_end < existing.len() {
            let tail = &existing[after_end..];
            if !tail.starts_with('\n') && !block.is_empty() && !tail.is_empty() {
                out.push('\n');
            }
            out.push_str(tail.trim_start_matches('\n'));
        }
        return out.trim_end().to_string() + "\n";
    }

    if block.is_empty() {
        return existing.to_string();
    }

    if existing.trim().is_empty() {
        return block;
    }

    let mut out = existing.trim_end().to_string();
    out.push_str("\n\n");
    out.push_str(&block);
    out
}

/// Upsert the TeamClu-managed block in `.teamclu/instructions/CLAUDE.md`.
pub fn sync_teamclu_claude_md(workspace_path: &str, prompt: &str) -> Result<(), String> {
    ensure_teamclu_dir(workspace_path)?;
    let path = claude_md_path(workspace_path);
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create instructions dir: {e}"))?;
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let next = upsert_marked_block(&existing, prompt);
    if next.trim().is_empty() {
        if Path::new(&path).exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove empty CLAUDE.md: {e}"))?;
        }
        return Ok(());
    }

    std::fs::write(&path, next).map_err(|e| format!("Failed to write CLAUDE.md: {e}"))
}

/// Whether the managed system-prompt block exists in `.teamclu/instructions/CLAUDE.md`.
pub fn claude_md_block_present(workspace_path: &str) -> bool {
    let path = claude_md_path(workspace_path);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return false;
    };
    content.contains(BLOCK_START) && content.contains(BLOCK_END)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_system_prompt_reads_teamclu_json() {
        let dir = tempfile::tempdir().unwrap();
        let teamclu = dir.path().join(TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu).unwrap();
        std::fs::write(
            teamclu.join(CONFIG_FILE_NAME),
            r#"{"systemPrompt":"请使用中文回答"}"#,
        )
        .unwrap();

        assert_eq!(
            load_system_prompt(dir.path().to_str().unwrap()),
            "请使用中文回答"
        );
    }

    #[test]
    fn load_system_prompt_returns_empty_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_system_prompt(dir.path().to_str().unwrap()).is_empty());
    }

    #[test]
    fn sync_claude_md_writes_marked_block() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        sync_teamclu_claude_md(ws, "请使用中文回答").unwrap();
        let content = std::fs::read_to_string(claude_md_path(ws)).unwrap();
        assert!(content.contains(BLOCK_START));
        assert!(content.contains("请使用中文回答"));
        assert!(content.contains(BLOCK_END));
    }

    #[test]
    fn sync_claude_md_replaces_existing_block() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        sync_teamclu_claude_md(ws, "first").unwrap();
        sync_teamclu_claude_md(ws, "second").unwrap();
        let content = std::fs::read_to_string(claude_md_path(ws)).unwrap();
        assert!(!content.contains("first"));
        assert!(content.contains("second"));
        assert_eq!(content.matches(BLOCK_START).count(), 1);
    }

    #[test]
    fn sync_claude_md_clears_block_when_prompt_empty() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        sync_teamclu_claude_md(ws, "请使用中文回答").unwrap();
        assert!(claude_md_block_present(ws));
        sync_teamclu_claude_md(ws, "").unwrap();
        assert!(!claude_md_block_present(ws));
    }
}
