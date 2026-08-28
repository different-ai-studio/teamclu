//! Bridge team-shared skills into `<workspace>/.claude/skills/` for Claude Code.
//!
//! OpenCode reads `teamclu-team/skills` via `opencode.json`; the Claude Agent SDK
//! only discovers skills under `.claude/skills/` (with `settingSources` including
//! `project`). We materialize per-skill symlinks so team skills are visible without
//! touching the team-share layout.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::config::team_skill_roots;
use crate::config::workspace_control::WorkspaceControlError;

const CLAUDE_SKILLS_DIR: &str = ".claude/skills";
pub const WARNING_CLAUDE_LOCAL_OVERRIDE: &str = "claude_local_override";

/// Whether a real workspace-local Claude skill directory blocks the bridge for `slug`.
pub fn has_claude_local_skill_override(workspace_path: &Path, slug: &str) -> bool {
    let local = workspace_path.join(CLAUDE_SKILLS_DIR).join(slug);
    match std::fs::symlink_metadata(&local) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => true,
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => true,
        _ => false,
    }
}

/// After a managed personal skill mutation, refresh Claude bridge links and report
/// whether a workspace-local pack still wins for Claude Code.
pub fn reconcile_after_managed_mutation(
    workspace_path: &Path,
    slug: &str,
) -> Result<Vec<String>, WorkspaceControlError> {
    let local_override = has_claude_local_skill_override(workspace_path, slug);
    ensure_claude_team_skills(workspace_path)?;
    Ok(if local_override {
        vec![WARNING_CLAUDE_LOCAL_OVERRIDE.into()]
    } else {
        Vec::new()
    })
}

/// Ensure team skills are symlinked into `.claude/skills/`, without overwriting
/// workspace-local entries. Idempotent; safe to call on every `prepare_workspace`.
pub fn ensure_claude_team_skills(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let claude_skills = workspace_path.join(CLAUDE_SKILLS_DIR);
    std::fs::create_dir_all(&claude_skills).map_err(io_err)?;

    let team_roots = team_skill_roots(workspace_path);
    if team_roots.is_empty() {
        prune_stale_team_symlinks(&claude_skills, &team_roots, &HashSet::new())?;
        return Ok(());
    }

    let desired = collect_desired_team_skills(&team_roots, &claude_skills);
    let desired_slugs: HashSet<String> = desired.keys().cloned().collect();

    for (slug, target) in &desired {
        let link = claude_skills.join(slug);
        // Never symlink a pack onto itself — happens when `.claude/skills` is
        // listed in `skills.paths` and a previous prepare already materialized
        // team packs there.
        if same_path(&link, target) {
            continue;
        }
        if symlink_points_to(&link, target) {
            continue;
        }

        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                // Workspace-local skill wins over team.
                continue;
            }
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => continue,
            Ok(meta) if meta.file_type().is_symlink() => {
                let broken = !link.exists();
                if is_team_managed_symlink(&link, &team_roots) || (broken && desired_slugs.contains(slug)) {
                    std::fs::remove_file(&link).map_err(io_err)?;
                } else {
                    // User-owned symlink — do not overwrite.
                    continue;
                }
            }
            Ok(_) => continue,
            Err(_) => {}
        }
        create_dir_symlink(target, &link)?;
    }

    prune_stale_team_symlinks(&claude_skills, &team_roots, &desired_slugs)?;
    Ok(())
}

fn collect_desired_team_skills(
    team_roots: &[PathBuf],
    claude_skills: &Path,
) -> HashMap<String, PathBuf> {
    let mut desired = HashMap::new();
    for root in team_roots {
        // The bridge writes into `.claude/skills`; treating that tree as a
        // source would read back the symlinks we just created and try to link
        // each slug to itself (`EEXIST`, os error 17).
        if is_bridge_destination_root(root, claude_skills) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            desired.entry(slug.to_string()).or_insert(path);
        }
    }
    desired
}

fn prune_stale_team_symlinks(
    claude_skills: &Path,
    team_roots: &[PathBuf],
    desired_slugs: &HashSet<String>,
) -> Result<(), WorkspaceControlError> {
    let Ok(entries) = std::fs::read_dir(claude_skills) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_symlink(&path) {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if desired_slugs.contains(slug) {
            continue;
        }
        if is_team_managed_symlink(&path, team_roots) {
            std::fs::remove_file(&path).map_err(io_err)?;
        }
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(l), Ok(r)) => l == r,
        _ => false,
    }
}

/// Whether `root` is the bridge destination dir (or inside it).
fn is_bridge_destination_root(root: &Path, claude_skills: &Path) -> bool {
    if root == claude_skills {
        return true;
    }
    match (root.canonicalize(), claude_skills.canonicalize()) {
        (Ok(root), Ok(claude)) => root == claude || root.starts_with(&claude),
        _ => false,
    }
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn resolve_symlink_target(link: &Path) -> Option<PathBuf> {
    let dest = std::fs::read_link(link).ok()?;
    let resolved = if dest.is_absolute() {
        dest
    } else {
        link.parent()?.join(dest)
    };
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

fn symlink_points_to(link: &Path, target: &Path) -> bool {
    let Some(resolved) = resolve_symlink_target(link) else {
        return false;
    };
    let Ok(canonical_target) = std::fs::canonicalize(target) else {
        return false;
    };
    resolved == canonical_target
}

fn is_team_managed_symlink(link: &Path, team_roots: &[PathBuf]) -> bool {
    if !is_symlink(link) {
        return false;
    }
    let Some(resolved) = resolve_symlink_target(link) else {
        // Broken symlink — only prune when we can't resolve; treat as managed
        // if the link target string references a team root path component.
        let Ok(dest) = std::fs::read_link(link) else {
            return false;
        };
        let dest_str = dest.to_string_lossy();
        return team_roots.iter().any(|root| {
            let root_str = root.to_string_lossy();
            dest_str.contains(root_str.as_ref())
        });
    };
    team_roots.iter().any(|root| {
        let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        resolved.starts_with(&root_canon)
    })
}

fn create_dir_symlink(target: &Path, link: &Path) -> Result<(), WorkspaceControlError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(io_err)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).map_err(io_err)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err(WorkspaceControlError::Io(
            "symlinks are not supported on this platform".into(),
        ))
    }
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::global_team_store::TEST_HOME_LOCK;

    /// A workspace whose only team skill root is one it declares itself.
    ///
    /// Two things this has to nail down. The team drive's own `skills/` stopped
    /// being a root (see `collect_team_skill_paths`), so the fixture declares
    /// one through `opencode.json` instead. And `team_skill_roots` probes
    /// `$HOME/.agents/skills`, which on a developer machine is a real directory
    /// full of real packs — without redirecting HOME these tests symlink whatever
    /// the person running them happens to have installed, and pass or fail by
    /// machine. The lock is the daemon-wide one every HOME-mutating test shares.
    fn workspace_with_team_root() -> (
        std::sync::MutexGuard<'static, ()>,
        tempfile::TempDir,
        tempfile::TempDir,
        PathBuf,
    ) {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        let team_skills = ws.path().join("team-skills");
        std::fs::create_dir_all(&team_skills).unwrap();
        std::fs::write(
            ws.path().join("opencode.json"),
            format!(
                r#"{{"skills":{{"paths":["{}"]}}}}"#,
                team_skills.to_string_lossy()
            ),
        )
        .unwrap();
        (lock, home, ws, team_skills)
    }

    fn write_skill(dir: &Path, slug: &str) {
        let skill_dir = dir.join(slug);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {slug}\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn symlinks_team_skills_into_claude_dir() {
        let (_lock, _home, ws, team_skills) = workspace_with_team_root();
        write_skill(&team_skills, "team-skill");

        ensure_claude_team_skills(ws.path()).unwrap();

        let link = ws.path().join(".claude/skills/team-skill");
        assert!(is_symlink(&link));
        assert!(link.join("SKILL.md").is_file());
    }

    #[test]
    fn local_skill_wins_over_team_with_same_slug() {
        let (_lock, _home, ws, team_skills) = workspace_with_team_root();
        write_skill(&team_skills, "shared-name");

        let local = ws.path().join(".claude/skills/shared-name");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("SKILL.md"), "local wins").unwrap();

        ensure_claude_team_skills(ws.path()).unwrap();

        let content = std::fs::read_to_string(local.join("SKILL.md")).unwrap();
        assert_eq!(content, "local wins");
        assert!(!is_symlink(&local));
    }

    #[test]
    fn removes_stale_team_symlinks() {
        let (_lock, _home, ws, team_skills) = workspace_with_team_root();
        write_skill(&team_skills, "keep-me");

        ensure_claude_team_skills(ws.path()).unwrap();

        // Simulate a removed team skill by deleting source and re-running prepare.
        std::fs::remove_dir_all(team_skills.join("keep-me")).unwrap();
        ensure_claude_team_skills(ws.path()).unwrap();

        assert!(!ws.path().join(".claude/skills/keep-me").exists());
    }

    #[test]
    fn first_team_root_wins_for_duplicate_slug() {
        let ws = tempfile::tempdir().unwrap();
        let root_a = ws.path().join("skills-a");
        let root_b = ws.path().join("skills-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        write_skill(&root_a, "dup");
        write_skill(&root_b, "dup");
        std::fs::write(root_a.join("dup/SKILL.md"), "from-a").unwrap();
        std::fs::write(root_b.join("dup/SKILL.md"), "from-b").unwrap();

        let claude = ws.path().join(".claude/skills");
        let desired = collect_desired_team_skills(&[root_a.clone(), root_b], &claude);
        assert_eq!(desired.get("dup").unwrap(), &root_a.join("dup"));
    }

    #[test]
    fn ignores_claude_skills_tree_as_a_team_root_source() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        std::fs::create_dir_all(&pack_root).unwrap();
        write_skill(&pack_root, "market-skill");
        std::fs::write(
            ws.path().join("opencode.json"),
            format!(
                r#"{{"skills":{{"paths":["{}","{}"]}}}}"#,
                ws.path().join(".claude/skills").to_string_lossy(),
                pack_root.to_string_lossy()
            ),
        )
        .unwrap();

        ensure_claude_team_skills(ws.path()).unwrap();
        // Second apply is the failure mode: the bridge symlink is visible when
        // `.claude/skills` is listed in `skills.paths`.
        ensure_claude_team_skills(ws.path()).unwrap();

        let link = ws.path().join(".claude/skills/market-skill");
        assert!(is_symlink(&link));
        assert!(symlink_points_to(&link, &pack_root.join("market-skill")));
    }

    #[test]
    fn repairs_broken_team_symlink() {
        let (_lock, _home, ws, team_skills) = workspace_with_team_root();
        write_skill(&team_skills, "broken-link");
        let link = ws.path().join(".claude/skills/broken-link");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(team_skills.join("missing-target"), &link).unwrap();
            assert!(!link.exists());
            ensure_claude_team_skills(ws.path()).unwrap();
            assert!(is_symlink(&link));
            assert!(link.join("SKILL.md").is_file());
            assert!(symlink_points_to(&link, &team_skills.join("broken-link")));
        }
    }

    #[test]
    fn reconcile_after_managed_mutation_bridges_global_agent_skill() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "managed-skill");

        let warnings = reconcile_after_managed_mutation(ws.path(), "managed-skill").unwrap();
        assert!(warnings.is_empty());

        let link = ws.path().join(".claude/skills/managed-skill");
        assert!(is_symlink(&link));
        assert!(symlink_points_to(&link, &pack_root.join("managed-skill")));
    }

    #[test]
    fn reconcile_after_managed_mutation_reports_local_override() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "shared-name");

        let local = ws.path().join(".claude/skills/shared-name");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("SKILL.md"), "local wins").unwrap();

        let warnings = reconcile_after_managed_mutation(ws.path(), "shared-name").unwrap();
        assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
        assert!(!is_symlink(&local));
    }
}
