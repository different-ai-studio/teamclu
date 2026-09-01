//! Shared Agents Skills directory (`~/.agents/skills`) — the single install
//! target for TeamClu skill packages, readable by Pi natively and wired into
//! OpenCode / Claude Code via each runtime's `skills.paths` config.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Canonical shared install root: `~/.agents/skills`.
pub fn agents_skills_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    Ok(home.join(".agents").join("skills"))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {}", path.display(), e))
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} root is not a JSON object", path.display()))
    }
}

fn write_json_object(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {}", path.display(), e))?;
    std::fs::write(path, format!("{}\n", body))
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Ensure `skills.paths` on a config object contains `agents_skills` (absolute).
fn ensure_skills_paths_entry(root: &mut Value, agents_skills: &str) -> Result<bool, String> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "config root is not an object".to_string())?;
    let skills = obj.entry("skills").or_insert_with(|| json!({}));
    let skills_obj = skills
        .as_object_mut()
        .ok_or_else(|| "skills is not an object".to_string())?;
    let paths_val = skills_obj.entry("paths").or_insert_with(|| json!([]));
    let paths = paths_val
        .as_array_mut()
        .ok_or_else(|| "skills.paths is not an array".to_string())?;

    let already = paths.iter().any(|v| {
        v.as_str()
            .map(|s| s == agents_skills || s == "~/.agents/skills")
            .unwrap_or(false)
    });
    if already {
        return Ok(false);
    }
    paths.push(json!(agents_skills));
    Ok(true)
}

fn patch_config_file(path: &Path, agents_skills: &str) -> Result<bool, String> {
    let mut root = read_json_object(path)?;
    let changed = ensure_skills_paths_entry(&mut root, agents_skills)?;
    if changed {
        write_json_object(path, &root)?;
    }
    Ok(changed)
}

/// Create `~/.agents/skills` and register it in OpenCode + Claude `skills.paths`.
///
/// - OpenCode: `{workspace}/opencode.json` when `workspace_path` is set
/// - Claude: `~/.claude/settings.json`, and `{workspace}/.claude/settings.json` when set
#[tauri::command]
pub fn ensure_agents_skills_paths(workspace_path: Option<String>) -> Result<String, String> {
    let agents = agents_skills_dir()?;
    ensure_dir(&agents)?;
    let agents_str = agents.to_string_lossy().to_string();

    let mut touched = Vec::new();

    if let Some(ws) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Workspace `opencode.json` used to get `~/.agents/skills` prepended here.
        // That copy outranks the team's global hosted-first `skills.paths`, so
        // an older member pack shadowed the hosted team skill. Claude still
        // needs the member root; OpenCode reads it from the global config.
        let claude_ws = Path::new(ws).join(".claude").join("settings.json");
        if patch_config_file(&claude_ws, &agents_str)? {
            touched.push(claude_ws.display().to_string());
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    let claude_global = home.join(".claude").join("settings.json");
    if patch_config_file(&claude_global, &agents_str)? {
        touched.push(claude_global.display().to_string());
    }

    // Also register in the user-level OpenCode config when present/creatable.
    let opencode_global = home.join(".config").join("opencode").join("opencode.json");
    if patch_config_file(&opencode_global, &agents_str)? {
        touched.push(opencode_global.display().to_string());
    }

    Ok(format!(
        "agents skills at {}; updated {}",
        agents_str,
        if touched.is_empty() {
            "nothing (already registered)".to_string()
        } else {
            touched.join(", ")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn adds_skills_paths_idempotently() {
        let dir = tempdir().unwrap();
        let cfg = dir.path().join("opencode.json");
        std::fs::write(&cfg, "{}\n").unwrap();
        assert!(patch_config_file(&cfg, "/tmp/.agents/skills").unwrap());
        assert!(!patch_config_file(&cfg, "/tmp/.agents/skills").unwrap());
        let raw = std::fs::read_to_string(&cfg).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let paths = v["skills"]["paths"].as_array().unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], "/tmp/.agents/skills");
    }

    #[test]
    fn ensure_agents_skills_paths_does_not_write_workspace_opencode_json() {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let opencode = ws.path().join("opencode.json");
        std::fs::write(&opencode, "{}\n").unwrap();

        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home.path());
        let result = ensure_agents_skills_paths(Some(ws.path().to_string_lossy().into_owned()));
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        result.unwrap();

        let raw = std::fs::read_to_string(&opencode).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert!(
            v.get("skills").is_none(),
            "workspace opencode.json must not gain a member skills.paths entry"
        );
    }
}
