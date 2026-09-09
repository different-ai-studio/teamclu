//! Shared Agents Skills directory (`~/.agents/skills`) — the single install
//! target for TeamClu skill packages, readable by Pi natively and wired into
//! OpenCode / Claude Code via each runtime's `skills.paths` config.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

/// Canonical shared install root: `~/.agents/skills`.
pub fn agents_skills_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    Ok(home.join(".agents").join("skills"))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {}", path.display(), e))
}

/// Why `~/.agents/skills` is not ready for the webview / install paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentsSkillsAccessKind {
    Ok,
    HomeMissing,
    CreateFailed,
    OsPermission,
    TauriScope,
}

/// Structured result of probing OS + Tauri fs-scope access to `~/.agents/skills`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSkillsAccess {
    pub path: String,
    pub ok: bool,
    pub kind: AgentsSkillsAccessKind,
    pub message: String,
    pub os_readable: bool,
    pub os_writable: bool,
    pub scope_granted: bool,
}

fn access_result(
    path: PathBuf,
    kind: AgentsSkillsAccessKind,
    message: impl Into<String>,
    os_readable: bool,
    os_writable: bool,
    scope_granted: bool,
) -> AgentsSkillsAccess {
    AgentsSkillsAccess {
        path: path.to_string_lossy().into_owned(),
        ok: kind == AgentsSkillsAccessKind::Ok,
        kind,
        message: message.into(),
        os_readable,
        os_writable,
        scope_granted,
    }
}

/// Create the directory (if needed) and probe a write/read/delete round-trip.
///
/// Returns `(readable, writable, create_error)`. A create error that looks like
/// a permission problem is reported separately from a generic create failure so
/// the UI can tell the user to fix ownership rather than "disk full".
fn probe_os_access(dir: &Path) -> (bool, bool, Option<(AgentsSkillsAccessKind, String)>) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        let kind = if e.kind() == std::io::ErrorKind::PermissionDenied {
            AgentsSkillsAccessKind::OsPermission
        } else {
            AgentsSkillsAccessKind::CreateFailed
        };
        return (
            false,
            false,
            Some((kind, format!("Failed to create {}: {e}", dir.display()))),
        );
    }

    let probe = dir.join(format!(".teamclu-write-probe-{}", std::process::id()));
    let payload = b"teamclu-agents-skills-probe\n";

    if let Err(e) = std::fs::write(&probe, payload) {
        let _ = std::fs::remove_file(&probe);
        return (
            true,
            false,
            Some((
                AgentsSkillsAccessKind::OsPermission,
                format!(
                    "Cannot write to {}: {e}. Check that your user owns ~/.agents/skills.",
                    dir.display()
                ),
            )),
        );
    }

    let readable = match std::fs::read(&probe) {
        Ok(bytes) => bytes == payload,
        Err(_) => false,
    };
    let _ = std::fs::remove_file(&probe);

    if !readable {
        return (
            false,
            true,
            Some((
                AgentsSkillsAccessKind::OsPermission,
                format!(
                    "Wrote a probe file under {} but could not read it back.",
                    dir.display()
                ),
            )),
        );
    }

    (true, true, None)
}

fn grant_and_check_scope(app: &AppHandle, skills: &Path) -> (bool, Option<String>) {
    let agents_parent = skills.parent().unwrap_or(skills);
    if let Err(e) = crate::fs_scope::allow_directory(app, agents_parent) {
        return (false, Some(e));
    }
    if let Err(e) = crate::fs_scope::allow_directory(app, skills) {
        return (false, Some(e));
    }

    let probe_child = skills.join(".teamclu-scope-probe");
    let allowed = app.fs_scope().is_allowed(skills) || app.fs_scope().is_allowed(&probe_child);
    if allowed {
        (true, None)
    } else {
        (
            false,
            Some(format!(
                "Tauri fs scope still rejects {} after granting ~/.agents",
                skills.display()
            )),
        )
    }
}

/// Probe OS writability of `~/.agents/skills` and (re)grant the webview fs scope.
#[tauri::command]
pub fn check_agents_skills_access(app: AppHandle) -> Result<AgentsSkillsAccess, String> {
    let skills = match agents_skills_dir() {
        Ok(p) => p,
        Err(e) => {
            return Ok(access_result(
                PathBuf::from("~/.agents/skills"),
                AgentsSkillsAccessKind::HomeMissing,
                e,
                false,
                false,
                false,
            ));
        }
    };

    let (os_readable, os_writable, os_err) = probe_os_access(&skills);
    if let Some((kind, message)) = os_err {
        let (scope_granted, _) = grant_and_check_scope(&app, &skills);
        return Ok(access_result(
            skills,
            kind,
            message,
            os_readable,
            os_writable,
            scope_granted,
        ));
    }

    let (scope_granted, scope_err) = grant_and_check_scope(&app, &skills);
    if !scope_granted {
        return Ok(access_result(
            skills,
            AgentsSkillsAccessKind::TauriScope,
            scope_err
                .unwrap_or_else(|| "App filesystem scope does not allow ~/.agents/skills".into()),
            os_readable,
            os_writable,
            false,
        ));
    }

    Ok(access_result(
        skills,
        AgentsSkillsAccessKind::Ok,
        "ok".to_string(),
        os_readable,
        os_writable,
        true,
    ))
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
        // The working copy now lives there exclusively; the hosted cache is not
        // a runtime path. Claude still needs the member root registered.
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

    #[test]
    fn probe_os_access_creates_and_writes_in_empty_dir() {
        let dir = tempdir().unwrap();
        let skills = dir.path().join(".agents").join("skills");
        let (readable, writable, err) = probe_os_access(&skills);
        assert!(readable);
        assert!(writable);
        assert!(err.is_none());
        assert!(skills.is_dir());
        // Probe file must not linger.
        let leftovers: Vec<_> = std::fs::read_dir(&skills)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".teamclu-write-probe-")
            })
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn probe_os_access_reports_permission_on_readonly_dir() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let skills = dir.path().join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let mut perms = std::fs::metadata(&skills).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&skills, perms).unwrap();

        let (readable, writable, err) = probe_os_access(&skills);
        // Restore before asserts so the tempdir can clean up.
        let mut perms = std::fs::metadata(&skills).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&skills, perms).unwrap();

        assert!(!writable);
        let (kind, _) = err.expect("expected permission error");
        assert_eq!(kind, AgentsSkillsAccessKind::OsPermission);
        let _ = readable;
    }
}
