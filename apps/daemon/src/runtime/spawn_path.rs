//! PATH enrichment for spawned agent runtimes.
//!
//! amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
//! minimal PATH that omits Homebrew, `~/.local/bin`, and the other locations
//! where runtimes like `npx` actually live.

use std::path::Path;

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

    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(&PATH_SEP.to_string())
}

#[cfg(test)]
mod tests {
    use super::{enriched_spawn_path, PATH_SEP};
    use std::path::Path;

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
}
