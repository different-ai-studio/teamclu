//! Canonical on-disk namespace for official TeamClu builds vs white-label brands.
//!
//! Official Production + Dev share `~/.teamclu` and `{workspace}/.teamclu/`.
//! White-label builds keep `~/.{shortName}` / `{workspace}/.{shortName}/`.
//!
//! Local amuxd state follows the same split: official → `~/.amuxd`, white-label
//! → `~/.amuxd-<brand>` (see [`resolve_amuxd_dir_name`]).
//!
//! Workspace meta paths (P1) mirror Desktop `build.rs` / `TEAMCLU_DIR` /
//! `CONFIG_FILE_NAME`: see [`workspace_meta_dir_name`] and friends.

use std::path::{Path, PathBuf};

/// Process env set by desktop when spawning managed amuxd so the daemon reads
/// the same personal secrets store as the brand (`~/.copilot361/secrets`, …).
pub const BRAND_SHORT_NAME_ENV: &str = "TEAMCLU_BRAND_SHORT_NAME";

/// Human-facing product name for this build (`TeamClu`, `Copilot361`, …).
/// Set by desktop when it spawns amuxd; used in agent-facing copy such as
/// session system prompts.
pub const APP_DISPLAY_NAME_ENV: &str = "TEAMCLU_APP_DISPLAY_NAME";

/// Optional absolute override for the amuxd state directory (`DaemonConfig::config_dir`).
/// When unset, derived from [`BRAND_SHORT_NAME_ENV`] via [`amuxd_home_from_env`].
pub const AMUXD_HOME_ENV: &str = "AMUXD_HOME";

/// The only entries allowed directly inside the amuxd home (`~/.amuxd`).
///
/// Normative spec: `docs/architecture/amuxd-home-layout-v2.md` §1. That
/// document's directory tree and this constant are kept item-for-item aligned;
/// when they disagree the document wins and the same PR restores the match.
///
/// Adding an entry means answering one question first: *should this value change
/// when the team changes?* Yes → `teams/<id>/state/`. No, and it is a cache →
/// `cache/`. No, and it belongs to the process → `run/`. Otherwise it very
/// likely does not belong in the daemon home at all.
///
/// Sorted, so the layout test can compare against a sorted directory listing.
pub const ROOT_ALLOWLIST: &[&str] =
    &["cache", "daemon.toml", "device-id", "logs", "mcp.json", "run", "teams"];

/// Folder name under `$HOME` for official amuxd state (`~/.amuxd`).
pub const OFFICIAL_AMUXD_DIR_NAME: &str = "amuxd";

/// Home + workspace storage dir name for official builds (`~/.teamclu`).
pub const OFFICIAL_STORAGE_DIR: &str = "teamclu";

/// Pre-rebrand official dir name (`~/.teamclaw`), migrated away by v2.
///
/// These `teamclaw*` literals are historical facts about what exists on real
/// disks, not brand strings — a rebrand sweep must never rewrite them, or the
/// migration stops finding the data it is supposed to move.
pub const LEGACY_BRAND_STORAGE_DIR: &str = "teamclaw";

/// Pre-rebrand official Dev dir name (`~/.teamclawdev`).
pub const LEGACY_OFFICIAL_DEV_STORAGE_DIR: &str = "teamclawdev";

/// Workspace metadata directory for official builds (`.teamclu/`).
pub const WORKSPACE_META_DIR: &str = ".teamclu";

/// Pre-rebrand workspace metadata directory (`.teamclaw/`).
pub const LEGACY_BRAND_WORKSPACE_META_DIR: &str = ".teamclaw";

/// Primary workspace config file for official builds.
pub const WORKSPACE_CONFIG_FILE: &str = "teamclu.json";

/// Pre-rebrand workspace config file name.
pub const LEGACY_BRAND_CONFIG_FILE: &str = "teamclaw.json";

/// Legacy Dev workspace config file name.
pub const LEGACY_OFFICIAL_DEV_CONFIG_FILE: &str = "teamclawdev.json";

/// Workspace team-drive symlink name, and its pre-rebrand spelling.
pub const TEAM_SHARED_DIR_NAME: &str = "teamclu-team";
pub const LEGACY_BRAND_TEAM_SHARED_DIR_NAME: &str = "teamclaw-team";

/// One-shot migration marker under `~/.teamclu/migrations/`.
pub const STORAGE_NAMESPACE_MIGRATION_MARKER: &str = "official-storage-namespace-v1";

/// One-shot marker for the teamclaw → teamclu rebrand move.
pub const REBRAND_NAMESPACE_MIGRATION_MARKER: &str = "official-storage-namespace-v2";

/// Whether `short_name` identifies the official TeamClu build.
///
/// **Exactly one name is official.** This is the single definition; `build.rs`
/// calls it as a build-dependency and the frontend mirrors it under a parity
/// test. Spec: `docs/architecture/amuxd-home-layout-v2.md` §6.
///
/// The pre-rebrand spellings (`teamclaw`, `teamclawdev`) and `teamcludev` are
/// deliberately *not* official. Two of the three implementations already
/// classified them as white-label, so the codebase never actually agreed; the
/// disagreement is what split betly's home state across `~/.teamclu/secrets`
/// and `~/.teamclaw/local-cache.db`. Keeping `teamclaw` official is not an
/// option either: it is byte-identical to [`LEGACY_BRAND_WORKSPACE_META_DIR`],
/// which official builds actively consume, so the two brands would fight over
/// one directory name with nothing on disk able to tell them apart.
///
/// Those names survive as `LEGACY_*` constants — historical facts about what
/// exists on real disks, used to *find* old data, never to resolve a brand.
pub fn is_official_brand(short_name: &str) -> bool {
    short_name == OFFICIAL_STORAGE_DIR
}

/// Resolve the home-directory storage folder name (`teamclu`, `copilot361`, …).
pub fn resolve_storage_dir_name(short_name: &str) -> &str {
    if is_official_brand(short_name) {
        OFFICIAL_STORAGE_DIR
    } else {
        short_name
    }
}

/// Brand short name for process-global personal secrets (daemon injection).
///
/// Reads [`BRAND_SHORT_NAME_ENV`]; empty/unset falls back to [`OFFICIAL_STORAGE_DIR`].
pub fn brand_short_name_from_env() -> String {
    std::env::var(BRAND_SHORT_NAME_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OFFICIAL_STORAGE_DIR.to_string())
}

/// Resolve the user-facing product name for the current process.
///
/// Precedence: [`APP_DISPLAY_NAME_ENV`] → official brand default (`TeamClu`) →
/// [`brand_short_name_from_env`] as a last resort for standalone daemon runs.
pub fn brand_display_name_from_env() -> String {
    if let Ok(name) = std::env::var(APP_DISPLAY_NAME_ENV) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let short = brand_short_name_from_env();
    if is_official_brand(&short) {
        "TeamClu".to_string()
    } else {
        short
    }
}

/// Local amuxd state folder name under `$HOME` (no leading dot).
///
/// Official brands share `amuxd` → `~/.amuxd`. White-label uses `amuxd-<brand>`
/// → `~/.amuxd-copilot361`.
pub fn resolve_amuxd_dir_name(brand_short_name: &str) -> String {
    if is_official_brand(brand_short_name) {
        OFFICIAL_AMUXD_DIR_NAME.to_string()
    } else {
        format!("{OFFICIAL_AMUXD_DIR_NAME}-{brand_short_name}")
    }
}

/// Absolute amuxd state directory for a brand (`$HOME/.amuxd` or `$HOME/.amuxd-<brand>`).
pub fn amuxd_home_for_brand(brand_short_name: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(format!(".{}", resolve_amuxd_dir_name(brand_short_name)))
}

/// Resolve amuxd state directory for this process.
///
/// 1. [`AMUXD_HOME_ENV`] if set and non-empty
/// 2. else [`amuxd_home_for_brand`] using [`brand_short_name_from_env`]
pub fn amuxd_home_from_env() -> PathBuf {
    if let Ok(raw) = std::env::var(AMUXD_HOME_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    amuxd_home_for_brand(&brand_short_name_from_env())
}

/// `$HOME/.teamclu` (official) or `$HOME/.{brand}` — the **desktop's** home
/// storage directory: personal secrets, `local-cache.db`, telemetry consent.
///
/// Sibling of the daemon's [`amuxd_home_for_brand`]; the two are owned by
/// different processes (`docs/architecture/amuxd-home-layout-v2.md` §1) and must
/// not be conflated. Every call site that wants this directory calls here —
/// hand-assembling it from `TEAMCLU_DIR` (a *workspace* metadata constant) is
/// how `local-cache.db` ended up in a different home than the secrets store.
pub fn brand_home_dir(brand_short_name: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(format!(".{}", resolve_storage_dir_name(brand_short_name)))
}

/// Legacy official Dev home dir (`teamclawdev`) when migrating an existing install.
pub fn legacy_official_home_dir_name(short_name: &str) -> Option<&'static str> {
    if short_name == LEGACY_OFFICIAL_DEV_STORAGE_DIR {
        Some(LEGACY_OFFICIAL_DEV_STORAGE_DIR)
    } else {
        None
    }
}

/// Workspace meta directory name (leading dot), matching Desktop `TEAMCLU_DIR`.
///
/// Official → `.teamclu`; white-label → `.{brand}` (e.g. `.copilot361`).
pub fn workspace_meta_dir_name(brand_short_name: &str) -> String {
    if is_official_brand(brand_short_name) {
        WORKSPACE_META_DIR.to_string()
    } else {
        format!(".{brand_short_name}")
    }
}

/// Workspace primary config file name, matching Desktop `CONFIG_FILE_NAME`.
///
/// Official → `teamclu.json`; white-label → `{brand}.json`.
pub fn workspace_config_file_name(brand_short_name: &str) -> String {
    if is_official_brand(brand_short_name) {
        WORKSPACE_CONFIG_FILE.to_string()
    } else {
        format!("{brand_short_name}.json")
    }
}

/// Canonical `{workspace}/.{brand|teamclu}/` directory.
pub fn workspace_meta_dir(workspace: &Path, brand_short_name: &str) -> PathBuf {
    workspace.join(workspace_meta_dir_name(brand_short_name))
}

/// Canonical workspace config path (write target / primary read).
pub fn workspace_config_path(workspace: &Path, brand_short_name: &str) -> PathBuf {
    workspace_meta_dir(workspace, brand_short_name)
        .join(workspace_config_file_name(brand_short_name))
}

/// Always-canonical path for a relative entry under workspace meta (writes).
pub fn workspace_meta_write_path(
    workspace: &Path,
    brand_short_name: &str,
    rel: impl AsRef<Path>,
) -> PathBuf {
    workspace_meta_dir(workspace, brand_short_name).join(rel)
}

/// Resolve a meta-relative path for reads: prefer canonical, else legacy `.teamclu/`.
///
/// When neither exists, returns the canonical path (caller may create it).
pub fn resolve_workspace_meta_path(
    workspace: &Path,
    brand_short_name: &str,
    rel: impl AsRef<Path>,
) -> PathBuf {
    let rel = rel.as_ref();
    let canonical = workspace_meta_write_path(workspace, brand_short_name, rel);
    if canonical.exists() || is_official_brand(brand_short_name) {
        return canonical;
    }
    let legacy = workspace.join(WORKSPACE_META_DIR).join(rel);
    if legacy.exists() {
        legacy
    } else {
        canonical
    }
}

/// Resolve workspace config for reads (canonical brand file, else legacy official).
pub fn resolve_workspace_config_path(workspace: &Path, brand_short_name: &str) -> PathBuf {
    let canonical = workspace_config_path(workspace, brand_short_name);
    if canonical.exists() || is_official_brand(brand_short_name) {
        return canonical;
    }
    let legacy = workspace
        .join(WORKSPACE_META_DIR)
        .join(WORKSPACE_CONFIG_FILE);
    if legacy.exists() {
        legacy
    } else {
        canonical
    }
}

/// Unique meta roots to scan for reads (canonical first, then legacy when distinct).
pub fn workspace_meta_read_roots(workspace: &Path, brand_short_name: &str) -> Vec<PathBuf> {
    let canonical = workspace_meta_dir(workspace, brand_short_name);
    if is_official_brand(brand_short_name) {
        return vec![canonical];
    }
    let legacy = workspace.join(WORKSPACE_META_DIR);
    if legacy == canonical {
        vec![canonical]
    } else {
        vec![canonical, legacy]
    }
}

/// Convenience: meta helpers using [`brand_short_name_from_env`].
pub fn workspace_meta_dir_from_env(workspace: &Path) -> PathBuf {
    workspace_meta_dir(workspace, &brand_short_name_from_env())
}

pub fn workspace_config_path_from_env(workspace: &Path) -> PathBuf {
    workspace_config_path(workspace, &brand_short_name_from_env())
}

pub fn resolve_workspace_meta_path_from_env(workspace: &Path, rel: impl AsRef<Path>) -> PathBuf {
    resolve_workspace_meta_path(workspace, &brand_short_name_from_env(), rel)
}

pub fn workspace_meta_write_path_from_env(workspace: &Path, rel: impl AsRef<Path>) -> PathBuf {
    workspace_meta_write_path(workspace, &brand_short_name_from_env(), rel)
}

pub fn resolve_workspace_config_path_from_env(workspace: &Path) -> PathBuf {
    resolve_workspace_config_path(workspace, &brand_short_name_from_env())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{home_env_lock, HomeGuard};
    use tempfile::tempdir;

    /// Exactly one name is official. The three names below are the ones a
    /// reader is most likely to assume are still official — they are not.
    #[test]
    fn only_teamclu_is_official() {
        assert!(is_official_brand("teamclu"));

        assert!(!is_official_brand("teamcludev"));
        assert!(!is_official_brand("teamclaw"));
        assert!(!is_official_brand("teamclawdev"));
        assert!(!is_official_brand("copilot361"));

        assert_eq!(resolve_storage_dir_name("teamclu"), "teamclu");
        assert_eq!(resolve_storage_dir_name("teamcludev"), "teamcludev");
        assert_eq!(resolve_storage_dir_name("copilot361"), "copilot361");
    }

    /// The pre-rebrand names keep working as *legacy path facts*. Demoting them
    /// from the brand table must not stop the cleanup pass from finding old
    /// data on disk.
    #[test]
    fn legacy_names_survive_as_path_constants() {
        assert_eq!(LEGACY_BRAND_STORAGE_DIR, "teamclaw");
        assert_eq!(LEGACY_OFFICIAL_DEV_STORAGE_DIR, "teamclawdev");
        assert_eq!(LEGACY_BRAND_WORKSPACE_META_DIR, ".teamclaw");
        assert_eq!(LEGACY_BRAND_CONFIG_FILE, "teamclaw.json");
        assert_eq!(LEGACY_BRAND_TEAM_SHARED_DIR_NAME, "teamclaw-team");
    }

    #[test]
    fn brand_display_name_from_env_prefers_override() {
        let _lock = home_env_lock();
        std::env::remove_var(APP_DISPLAY_NAME_ENV);
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        assert_eq!(brand_display_name_from_env(), "TeamClu");

        std::env::set_var(APP_DISPLAY_NAME_ENV, "Copilot361");
        assert_eq!(brand_display_name_from_env(), "Copilot361");

        std::env::remove_var(APP_DISPLAY_NAME_ENV);
        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");
        assert_eq!(brand_display_name_from_env(), "copilot361");

        std::env::remove_var(BRAND_SHORT_NAME_ENV);
    }

    #[test]
    fn brand_short_name_from_env_defaults_and_reads_override() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        assert_eq!(brand_short_name_from_env(), OFFICIAL_STORAGE_DIR);

        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");
        assert_eq!(brand_short_name_from_env(), "copilot361");

        std::env::set_var(BRAND_SHORT_NAME_ENV, "  ");
        assert_eq!(brand_short_name_from_env(), OFFICIAL_STORAGE_DIR);
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
    }

    #[test]
    fn amuxd_dir_name_official_vs_white_label() {
        assert_eq!(resolve_amuxd_dir_name("teamclu"), "amuxd");
        assert_eq!(resolve_amuxd_dir_name("teamcludev"), "amuxd-teamcludev");
        assert_eq!(resolve_amuxd_dir_name("copilot361"), "amuxd-copilot361");
    }

    #[test]
    fn amuxd_home_from_env_prefers_explicit_override() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        std::env::remove_var(AMUXD_HOME_ENV);

        assert_eq!(amuxd_home_from_env(), dir.path().join(".amuxd"));

        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");
        assert_eq!(amuxd_home_from_env(), dir.path().join(".amuxd-copilot361"));

        let custom = dir.path().join("custom-amuxd");
        std::env::set_var(AMUXD_HOME_ENV, &custom);
        assert_eq!(amuxd_home_from_env(), custom);

        std::env::remove_var(AMUXD_HOME_ENV);
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
    }

    /// Locks Desktop `build.rs` / frontend `TEAMCLU_DIR` naming rules.
    #[test]
    fn workspace_meta_names_match_desktop_brand_table() {
        assert_eq!(workspace_meta_dir_name("teamclu"), ".teamclu");
        assert_eq!(workspace_config_file_name("teamclu"), "teamclu.json");

        assert_eq!(workspace_meta_dir_name("teamcludev"), ".teamcludev");
        assert_eq!(workspace_config_file_name("teamcludev"), "teamcludev.json");

        assert_eq!(workspace_meta_dir_name("copilot361"), ".copilot361");
        assert_eq!(workspace_config_file_name("copilot361"), "copilot361.json");
    }

    #[test]
    fn workspace_config_and_meta_paths_are_brand_scoped() {
        let ws = Path::new("/tmp/ws");
        assert_eq!(
            workspace_config_path(ws, "teamclu"),
            PathBuf::from("/tmp/ws/.teamclu/teamclu.json")
        );
        assert_eq!(
            workspace_config_path(ws, "copilot361"),
            PathBuf::from("/tmp/ws/.copilot361/copilot361.json")
        );
        assert_eq!(
            workspace_meta_write_path(ws, "copilot361", "skills"),
            PathBuf::from("/tmp/ws/.copilot361/skills")
        );
        assert_eq!(
            workspace_meta_write_path(ws, "copilot361", "allowlist.json"),
            PathBuf::from("/tmp/ws/.copilot361/allowlist.json")
        );
        assert_eq!(
            workspace_meta_write_path(ws, "copilot361", Path::new("sync").join("state.json")),
            PathBuf::from("/tmp/ws/.copilot361/sync/state.json")
        );
    }

    #[test]
    fn resolve_prefers_canonical_then_legacy_for_white_label() {
        let dir = tempdir().unwrap();
        let ws = dir.path();
        let brand = "copilot361";

        // Neither exists → canonical (for subsequent create).
        assert_eq!(
            resolve_workspace_meta_path(ws, brand, "skills"),
            workspace_meta_write_path(ws, brand, "skills")
        );
        assert_eq!(
            resolve_workspace_config_path(ws, brand),
            workspace_config_path(ws, brand)
        );

        // Only legacy → read legacy.
        let legacy_skills = ws.join(".teamclu/skills");
        std::fs::create_dir_all(&legacy_skills).unwrap();
        assert_eq!(
            resolve_workspace_meta_path(ws, brand, "skills"),
            legacy_skills
        );
        let legacy_cfg = ws.join(".teamclu/teamclu.json");
        std::fs::write(&legacy_cfg, "{}").unwrap();
        assert_eq!(resolve_workspace_config_path(ws, brand), legacy_cfg);

        // Canonical wins when both exist.
        let canonical_skills = workspace_meta_write_path(ws, brand, "skills");
        std::fs::create_dir_all(&canonical_skills).unwrap();
        assert_eq!(
            resolve_workspace_meta_path(ws, brand, "skills"),
            canonical_skills
        );
        let canonical_cfg = workspace_config_path(ws, brand);
        std::fs::create_dir_all(canonical_cfg.parent().unwrap()).unwrap();
        std::fs::write(&canonical_cfg, "{}").unwrap();
        assert_eq!(resolve_workspace_config_path(ws, brand), canonical_cfg);
    }

    #[test]
    fn resolve_official_never_uses_alternate_legacy_branch() {
        let dir = tempdir().unwrap();
        let ws = dir.path();
        let path = resolve_workspace_meta_path(ws, "teamclu", "skills");
        assert_eq!(path, ws.join(".teamclu/skills"));
        assert_eq!(
            resolve_workspace_config_path(ws, "teamclu"),
            ws.join(".teamclu/teamclu.json")
        );
    }

    #[test]
    fn write_path_always_canonical_even_when_legacy_exists() {
        let dir = tempdir().unwrap();
        let ws = dir.path();
        std::fs::create_dir_all(ws.join(".teamclu/skills")).unwrap();
        assert_eq!(
            workspace_meta_write_path(ws, "copilot361", "skills"),
            ws.join(".copilot361/skills")
        );
    }

    #[test]
    fn meta_read_roots_include_legacy_for_white_label_only() {
        let ws = Path::new("/tmp/ws");
        assert_eq!(
            workspace_meta_read_roots(ws, "teamclu"),
            vec![PathBuf::from("/tmp/ws/.teamclu")]
        );
        assert_eq!(
            workspace_meta_read_roots(ws, "copilot361"),
            vec![
                PathBuf::from("/tmp/ws/.copilot361"),
                PathBuf::from("/tmp/ws/.teamclu"),
            ]
        );
    }

    #[test]
    fn from_env_helpers_follow_brand_short_name_env() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");
        assert_eq!(
            workspace_meta_dir_from_env(dir.path()),
            dir.path().join(".copilot361")
        );
        assert_eq!(
            workspace_config_path_from_env(dir.path()),
            dir.path().join(".copilot361/copilot361.json")
        );
        assert_eq!(
            workspace_meta_write_path_from_env(dir.path(), "allowlist.json"),
            dir.path().join(".copilot361/allowlist.json")
        );
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        assert_eq!(
            workspace_meta_dir_from_env(dir.path()),
            dir.path().join(".teamclu")
        );
    }
}
