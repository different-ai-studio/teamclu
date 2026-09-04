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
pub const WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED: &str = "claude_bridge_reconcile_failed";

/// Whether an existing workspace-local Claude entry blocks bridging to `canonical_pack`.
pub fn claude_bridge_blocked_by_local_entry(
    workspace_path: &Path,
    slug: &str,
    canonical_pack: &Path,
) -> bool {
    let link = workspace_path.join(CLAUDE_SKILLS_DIR).join(slug);
    let team_roots = team_skill_roots(workspace_path);
    match std::fs::symlink_metadata(&link) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => true,
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => true,
        Ok(meta) if meta.file_type().is_symlink() => {
            if is_team_managed_symlink(&link, &team_roots) {
                !symlink_points_to(&link, canonical_pack)
            } else {
                !symlink_points_to(&link, canonical_pack)
            }
        }
        Ok(_) => false,
        Err(_) => false,
    }
}

fn claude_bridge_points_to_canonical(
    workspace_path: &Path,
    slug: &str,
    canonical_pack: &Path,
) -> bool {
    let link = workspace_path.join(CLAUDE_SKILLS_DIR).join(slug);
    if same_path(&link, canonical_pack) {
        return true;
    }
    symlink_points_to(&link, canonical_pack)
}

/// Whether `.claude/skills/<slug>` is a team-bridge symlink (daemon-managed).
pub fn is_claude_team_bridge_symlink(link: &Path, workspace_path: &Path) -> bool {
    is_team_managed_symlink(link, &team_skill_roots(workspace_path))
}

/// After a managed personal skill mutation, refresh Claude bridge links and report
/// whether a workspace-local pack still wins for Claude Code.
pub fn reconcile_after_managed_mutation(
    workspace_path: &Path,
    slug: &str,
    canonical_pack: &Path,
) -> Result<Vec<String>, WorkspaceControlError> {
    let blocked_before =
        claude_bridge_blocked_by_local_entry(workspace_path, slug, canonical_pack);
    ensure_claude_team_skills(workspace_path)?;
    if blocked_before || claude_bridge_blocked_by_local_entry(workspace_path, slug, canonical_pack) {
        return Ok(vec![WARNING_CLAUDE_LOCAL_OVERRIDE.into()]);
    }
    if !claude_bridge_points_to_canonical(workspace_path, slug, canonical_pack) {
        // Soft warning, not Err: `ensure_claude_team_skills` may have skipped
        // Windows symlink creation (os error 1314). OpenCode still resolves the
        // pack via team skill roots; only Claude Code discovery under
        // `.claude/skills/` is affected.
        tracing::warn!(
            slug,
            "claude skill bridge not ready after reconcile; OpenCode team skills still resolve via team roots"
        );
        return Ok(vec![WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED.into()]);
    }
    Ok(Vec::new())
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
                if is_team_managed_symlink(&link, &team_roots) {
                    std::fs::remove_file(&link).map_err(io_err)?;
                } else {
                    // User-owned symlink — preserve even when broken; ownership
                    // cannot be inferred from `desired_slugs` alone.
                    continue;
                }
            }
            Ok(_) => continue,
            Err(_) => {}
        }
        match create_dir_symlink(target, &link) {
            Ok(()) => {}
            // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege:
            // CreateSymbolicLink fails with ERROR_PRIVILEGE_NOT_HELD (os error 1314).
            // Soft-skip so prepare_workspace / runtime refresh still succeed for
            // OpenCode-only users (do not surface "运行时配置读取失败").
            //
            // Consequence: team skills are NOT mirrored under `.claude/skills/`,
            // so Claude Code will not discover them until the user enables
            // Developer Mode (or runs elevated). OpenCode continues to resolve
            // the same packs via teamclu-team / global team skill roots.
            Err(e) if is_symlink_privilege_denied(&e) => {
                tracing::warn!(
                    slug,
                    link = %link.display(),
                    target = %target.display(),
                    error = %e,
                    "skipping Claude skill bridge symlink (Windows privilege missing); OpenCode team skills still resolve via team roots"
                );
                break;
            }
            Err(e) => return Err(e),
        }
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

fn resolve_symlink_target_raw(link: &Path) -> Option<PathBuf> {
    let dest = std::fs::read_link(link).ok()?;
    let resolved = if dest.is_absolute() {
        dest
    } else {
        link.parent()?.join(dest)
    };
    Some(normalize_lexical(&resolved))
}

fn resolve_symlink_target(link: &Path) -> Option<PathBuf> {
    let resolved = resolve_symlink_target_raw(link)?;
    if !resolved.exists() {
        return None;
    }
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
    let Some(raw_target) = resolve_symlink_target_raw(link) else {
        return false;
    };
    team_roots.iter().any(|root| path_is_under_root(&raw_target, root))
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

/// Windows `ERROR_PRIVILEGE_NOT_HELD` (1314) when creating directory symlinks.
/// Message text is localized (e.g. Chinese "客户端没有所需的特权"), so match
/// the os-error code rather than English wording.
fn is_symlink_privilege_denied(err: &WorkspaceControlError) -> bool {
    match err {
        WorkspaceControlError::Io(msg) => {
            msg.contains("os error 1314") || msg.contains("(os error 1314)")
        }
        _ => false,
    }
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::global_team_store::TEST_HOME_LOCK;

    #[test]
    fn detects_windows_symlink_privilege_error_text() {
        assert!(is_symlink_privilege_denied(&WorkspaceControlError::Io(
            "客户端没有所需的特权。(os error 1314)".into()
        )));
        assert!(is_symlink_privilege_denied(&WorkspaceControlError::Io(
            "A required privilege is not held by the client. (os error 1314)".into()
        )));
        assert!(!is_symlink_privilege_denied(&WorkspaceControlError::Io(
            "Access is denied. (os error 5)".into()
        )));
    }

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

        let canonical = pack_root.join("managed-skill");
        let warnings =
            reconcile_after_managed_mutation(ws.path(), "managed-skill", &canonical).unwrap();
        assert!(warnings.is_empty());

        let link = ws.path().join(".claude/skills/managed-skill");
        assert!(is_symlink(&link));
        assert!(symlink_points_to(&link, &canonical));
    }

    #[test]
    fn reconcile_after_managed_mutation_reports_local_override() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "shared-name");

        let canonical = pack_root.join("shared-name");
        let local = ws.path().join(".claude/skills/shared-name");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("SKILL.md"), "local wins").unwrap();

        let warnings =
            reconcile_after_managed_mutation(ws.path(), "shared-name", &canonical).unwrap();
        assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
        assert!(!is_symlink(&local));
    }

    #[test]
    fn reconcile_after_managed_mutation_reports_user_owned_symlink_override() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "linked-skill");

        let external = ws.path().join("external-skill");
        write_skill(ws.path(), "external-skill");
        let local = ws.path().join(".claude/skills/linked-skill");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&external, &local).unwrap();
            let warnings = reconcile_after_managed_mutation(
                ws.path(),
                "linked-skill",
                &pack_root.join("linked-skill"),
            )
            .unwrap();
            assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
            assert!(is_symlink(&local));
        }
    }

    #[test]
    fn reconcile_preserves_broken_user_symlink_with_team_root_prefix_collision() {
        let (_lock, home, ws, team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "demo");

        let canonical = pack_root.join("demo");
        let backup_root = ws.path().join("team-skills-backup");
        let local = ws.path().join(".claude/skills/demo");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(backup_root.join("demo"), &local).unwrap();
            assert!(!local.exists());
            let link_target_before = std::fs::read_link(&local).unwrap();
            assert!(
                !path_is_under_root(&backup_root.join("demo"), &team_skills),
                "fixture should collide on string prefix but not path containment"
            );

            let warnings =
                reconcile_after_managed_mutation(ws.path(), "demo", &canonical).unwrap();
            assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
            assert!(is_symlink(&local));
            assert_eq!(std::fs::read_link(&local).unwrap(), link_target_before);
        }
    }

    #[test]
    fn reconcile_preserves_broken_user_symlink_with_relative_target() {
        let (_lock, home, ws, team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "demo");

        let canonical = pack_root.join("demo");
        let backup_root = ws.path().join("team-skills-backup");
        std::fs::create_dir_all(&backup_root).unwrap();
        let local = ws.path().join(".claude/skills/demo");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("../team-skills-backup/demo", &local).unwrap();
            assert!(!local.exists());
            let link_target_before = std::fs::read_link(&local).unwrap();

            let warnings =
                reconcile_after_managed_mutation(ws.path(), "demo", &canonical).unwrap();
            assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
            assert!(is_symlink(&local));
            assert_eq!(std::fs::read_link(&local).unwrap(), link_target_before);
            assert!(!path_is_under_root(&backup_root.join("demo"), &team_skills));
        }
    }

    #[test]
    fn reconcile_preserves_broken_user_owned_symlink() {
        let (_lock, home, ws, _team_skills) = workspace_with_team_root();
        let pack_root = home.path().join(".agents/skills");
        write_skill(&pack_root, "demo");

        let canonical = pack_root.join("demo");
        let local = ws.path().join(".claude/skills/demo");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            let external = ws.path().join("temporarily-unmounted/demo");
            std::os::unix::fs::symlink(&external, &local).unwrap();
            assert!(!local.exists());
            let link_target_before = std::fs::read_link(&local).unwrap();

            let warnings =
                reconcile_after_managed_mutation(ws.path(), "demo", &canonical).unwrap();
            assert_eq!(warnings, vec![WARNING_CLAUDE_LOCAL_OVERRIDE.to_string()]);
            assert!(is_symlink(&local));
            assert_eq!(std::fs::read_link(&local).unwrap(), link_target_before);
            assert!(!symlink_points_to(&local, &canonical));
        }
    }
}
