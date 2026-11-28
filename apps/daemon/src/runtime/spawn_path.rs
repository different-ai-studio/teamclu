//! PATH enrichment for spawned agent runtimes.
//!
//! amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
//! minimal PATH that omits Homebrew, `~/.local/bin`, and the other locations
//! where runtimes like `npx` actually live.

use std::path::{Path, PathBuf};

#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Build a PATH for spawned agent runtimes that includes common user-level
/// binary directories.
///
/// Inherited PATH entries keep priority; the well-known directories are appended,
/// and duplicates are removed preserving first occurrence.
pub(crate) fn enriched_spawn_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut candidates: Vec<String> = Vec::new();

    if let Some(existing) = existing {
        candidates.extend(existing.split(PATH_SEP).map(|s| s.to_string()));
    }

    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(format!("{pf}\\nodejs"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm"));
        }
    } else {
        if let Some(home) = home {
            for sub in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".opencode/bin",
            ] {
                candidates.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
        for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            candidates.push(dir.to_string());
        }
    }

    dedupe_path(candidates)
}

/// PATH for an MCP stdio probe.
///
/// Superset of [`enriched_spawn_path`]: `lead` is the directory of the Node the
/// probe resolved (the managed install, or a version manager), so `npx` and
/// `node` beside it are visible. `extra` is `teamclu-binpath`'s tool
/// directories and version-manager installs. Inherited entries stay ahead of
/// those extras, and `lead` stays first — the same order pi uses when it puts
/// its Node directory at the front of the child PATH.
pub(crate) fn mcp_probe_path(
    existing: Option<&str>,
    home: Option<&Path>,
    lead: Option<&Path>,
    extra: &[PathBuf],
) -> String {
    let mut candidates = Vec::new();
    if let Some(lead) = lead {
        let lead = lead.to_string_lossy();
        if !lead.is_empty() {
            candidates.push(lead.into_owned());
        }
    }
    let enriched = enriched_spawn_path(existing, home);
    if !enriched.is_empty() {
        candidates.extend(enriched.split(PATH_SEP).map(|s| s.to_string()));
    }
    for dir in extra {
        let dir = dir.to_string_lossy();
        if !dir.is_empty() {
            candidates.push(dir.into_owned());
        }
    }
    dedupe_path(candidates)
}

fn dedupe_path(candidates: Vec<String>) -> String {
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(&PATH_SEP.to_string())
}

#[cfg(test)]
mod tests {
    use super::{enriched_spawn_path, mcp_probe_path, PATH_SEP};
    use std::path::{Path, PathBuf};

    #[cfg(not(windows))]
    #[test]
    fn appends_homebrew_and_user_local_to_minimal_path() {
        let path = enriched_spawn_path(
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            Some(Path::new("/Users/x")),
        );
        let dirs: Vec<&str> = path.split(':').collect();
        assert!(dirs.contains(&"/opt/homebrew/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.local/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.opencode/bin"), "{path}");
        assert!(path.starts_with("/usr/bin:/bin:/usr/sbin:/sbin"), "{path}");
    }

    #[cfg(not(windows))]
    #[test]
    fn dedupes_existing_entries() {
        let path = enriched_spawn_path(
            Some("/opt/homebrew/bin:/usr/bin"),
            Some(Path::new("/home/u")),
        );
        let count = path
            .split(':')
            .filter(|d| *d == "/opt/homebrew/bin")
            .count();
        assert_eq!(count, 1, "{path}");
    }

    #[test]
    fn uses_platform_path_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(PATH_SEP, sep);
    }

    #[test]
    fn probe_path_leads_with_node_and_keeps_inherited_and_extra_dirs() {
        let path = mcp_probe_path(
            Some("/usr/bin:/bin"),
            None,
            Some(Path::new("/managed/node")),
            &[
                PathBuf::from("/usr/bin"),
                PathBuf::from("/fnm/node-versions/v22/installation"),
                PathBuf::from("/opt/nodejs"),
            ],
        );
        let dirs: Vec<&str> = path.split(PATH_SEP).collect();
        assert_eq!(dirs[0], "/managed/node", "{path}");
        assert!(dirs.contains(&"/usr/bin"), "{path}");
        assert!(dirs.contains(&"/bin"), "{path}");
        assert!(
            dirs.contains(&"/fnm/node-versions/v22/installation"),
            "{path}"
        );
        assert!(dirs.contains(&"/opt/nodejs"), "{path}");
        assert_eq!(
            dirs.iter().filter(|d| **d == "/usr/bin").count(),
            1,
            "{path}"
        );
    }
}
