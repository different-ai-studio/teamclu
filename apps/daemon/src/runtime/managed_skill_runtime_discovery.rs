//! Runtime adapter-contract discovery for managed personal skills.
//!
//! Each entry point mirrors what one runtime reads from disk/config when
//! discovering skills — not TeamClu's merged inventory scan.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config::pack_digest;
use crate::config::workspace_control::WorkspaceControlError;
use crate::runtime::claude_skills;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDiscoveredPack {
    pub slug: String,
    pub pack_dir: PathBuf,
    pub digest: String,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn path_is_under_root(candidate: &Path, root: &Path) -> bool {
    normalize_lexical(candidate).starts_with(normalize_lexical(root))
}

fn expand_config_path(raw: &str, workspace: &Path, home: &Path) -> PathBuf {
    let trimmed = raw.trim();
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');
    if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        PathBuf::from(format!("{home_trimmed}/{rest}"))
    } else if trimmed.starts_with('/') {
        PathBuf::from(trimmed)
    } else {
        workspace.join(trimmed.trim_start_matches("./"))
    }
}

fn skills_paths_from_config(value: &Value, workspace: &Path, home: &Path) -> Vec<PathBuf> {
    value
        .pointer("/skills/paths")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|raw| expand_config_path(raw, workspace, home))
                .collect()
        })
        .unwrap_or_default()
}

fn load_discovered_pack(slug: &str, pack_dir: &Path) -> Result<RuntimeDiscoveredPack, WorkspaceControlError> {
    if !pack_dir.join("SKILL.md").is_file() {
        return Err(WorkspaceControlError::NotFound(format!(
            "skill {slug} missing SKILL.md at {}",
            pack_dir.display()
        )));
    }
    let digest = pack_digest(pack_dir).map_err(|err| WorkspaceControlError::Io(err.message))?;
    Ok(RuntimeDiscoveredPack {
        slug: slug.to_string(),
        pack_dir: pack_dir.to_path_buf(),
        digest,
    })
}

/// OpenCode adapter contract: merged workspace + daemon-injected global `skills.paths`.
pub fn discover_opencode_managed_pack(
    workspace: &Path,
    home: &Path,
    slug: &str,
) -> Result<Option<RuntimeDiscoveredPack>, WorkspaceControlError> {
    use teamclu_runtime_env::opencode_config::OpencodeConfigStore;

    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for config in [
        OpencodeConfigStore::load(workspace),
        OpencodeConfigStore::load_global(),
    ] {
        if let Ok(value) = config {
            for path in skills_paths_from_config(&value, workspace, home) {
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }
    }

    for root in paths {
        let candidate = root.join(slug);
        if candidate.join("SKILL.md").is_file() {
            return Ok(Some(load_discovered_pack(slug, &candidate)?));
        }
    }
    Ok(None)
}

/// Pi adapter contract: native `~/.agents/skills/<slug>` enumeration.
pub fn discover_pi_managed_pack(
    home: &Path,
    slug: &str,
) -> Result<Option<RuntimeDiscoveredPack>, WorkspaceControlError> {
    let candidate = home.join(".agents/skills").join(slug);
    if !candidate.join("SKILL.md").is_file() {
        return Ok(None);
    }
    Ok(Some(load_discovered_pack(slug, &candidate)?))
}

/// Claude Code adapter contract: project `.claude/skills/<slug>` discovery.
pub fn discover_claude_project_managed_pack(
    workspace: &Path,
    slug: &str,
) -> Result<Option<RuntimeDiscoveredPack>, WorkspaceControlError> {
    let entry = workspace.join(".claude/skills").join(slug);
    let pack_dir = match std::fs::symlink_metadata(&entry) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let dest = std::fs::read_link(&entry).map_err(io_err)?;
            let resolved = if dest.is_absolute() {
                dest.clone()
            } else {
                entry
                    .parent()
                    .map(|parent| parent.join(&dest))
                    .unwrap_or(dest)
            };
            if !resolved.exists() {
                return Ok(None);
            }
            std::fs::canonicalize(&resolved).unwrap_or(resolved)
        }
        Ok(_) if entry.is_dir() => entry,
        _ => return Ok(None),
    };
    if !pack_dir.join("SKILL.md").is_file() {
        return Ok(None);
    }
    Ok(Some(load_discovered_pack(slug, &pack_dir)?))
}

/// Post-write pipeline shared by `skills.manage` create/update after the pack lands.
pub fn apply_managed_skill_post_write(
    workspace: &Path,
    slug: &str,
    canonical_pack: &Path,
) -> Result<Vec<String>, WorkspaceControlError> {
    claude_skills::reconcile_after_managed_mutation(workspace, slug, canonical_pack)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::global_team_store::TEST_HOME_LOCK;
    use crate::config::{create_pack, ClaimedTeamContext, CreatePackRequest};
    use crate::runtime::supervisor::prepare_workspace;

    fn register_runtime_skill_paths(workspace: &Path, home: &Path, agents_root: &Path) {
        let agents = agents_root.to_string_lossy();
        std::fs::write(
            workspace.join("opencode.json"),
            format!(r#"{{"skills":{{"paths":["{}"]}}}}"#, agents),
        )
        .unwrap();
        let claude_settings = workspace.join(".claude/settings.json");
        std::fs::create_dir_all(claude_settings.parent().unwrap()).unwrap();
        std::fs::write(
            &claude_settings,
            format!(r#"{{"skills":{{"paths":["{}"]}}}}"#, agents),
        )
        .unwrap();
        let _ = home.join(".claude").join("settings.json");
    }

    #[test]
    fn skills_manage_create_pipeline_discovers_via_runtime_adapters() {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        let agents_root = home.path().join(".agents/skills");
        std::fs::create_dir_all(&agents_root).unwrap();
        register_runtime_skill_paths(ws.path(), home.path(), &agents_root);

        let body = "---\nname: cross-runtime\ndescription: Shared.\n---\n\n# Shared body\n";
        let req = CreatePackRequest {
            slug: "cross-runtime".into(),
            content: body.into(),
            files: vec![],
        };
        let resp = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        let canonical = PathBuf::from(&resp.path);
        apply_managed_skill_post_write(ws.path(), "cross-runtime", &canonical).unwrap();
        prepare_workspace(ws.path()).unwrap();

        let opencode = discover_opencode_managed_pack(ws.path(), home.path(), "cross-runtime")
            .unwrap()
            .expect("OpenCode adapter should discover the managed pack");
        let pi = discover_pi_managed_pack(home.path(), "cross-runtime")
            .unwrap()
            .expect("Pi adapter should discover the managed pack");
        let claude = discover_claude_project_managed_pack(ws.path(), "cross-runtime")
            .unwrap()
            .expect("Claude adapter should discover the managed pack");

        assert_eq!(opencode.digest, resp.digest);
        assert_eq!(pi.digest, resp.digest);
        assert_eq!(claude.digest, resp.digest);
        assert_eq!(
            std::fs::canonicalize(opencode.pack_dir).unwrap(),
            std::fs::canonicalize(&canonical).unwrap()
        );
        assert_eq!(
            std::fs::canonicalize(pi.pack_dir).unwrap(),
            std::fs::canonicalize(&canonical).unwrap()
        );
        assert_eq!(
            std::fs::canonicalize(claude.pack_dir).unwrap(),
            std::fs::canonicalize(&canonical).unwrap()
        );

        drop(lock);
    }
}
