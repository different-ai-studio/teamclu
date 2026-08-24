//! Comparing the version a CLI reports against the version we want.
//!
//! Lives here because both apps ask the same question and used to answer it
//! differently: the daemon gates pi's and opencode's *upgrades* on this, while
//! the desktop decides what the Dependencies row *says*. A desktop copy that
//! parsed `"pi 0.84.2 (build 3)"` as `0.0.0` would offer an update forever
//! against a daemon that considered the same install current.

/// Parse a dotted version ("1.15.13" / "v1.15.13" / "1.15.13-beta") into
/// (major, minor, patch).
///
/// Scans whitespace-separated tokens so a `--version` line that carries a
/// program name ("pi 0.84.2") still resolves.
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    s.split_whitespace().find_map(parse_semver_token)
}

fn parse_semver_token(token: &str) -> Option<(u64, u64, u64)> {
    let token = token.trim().trim_start_matches('v');
    let core = token.split(['-', '+', ',', ')', '(']).next().unwrap_or("");
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// True if `have` >= `want`. An unparseable `have` is `false` — treated as
/// needs-install, which is the safe direction for both callers.
pub fn version_ge(have: &str, want: &str) -> bool {
    match (parse_semver(have), parse_semver(want)) {
        (Some(h), Some(w)) => h >= w,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_found_inside_a_noisy_line() {
        assert_eq!(parse_semver("pi 0.84.2 (build 3)"), Some((0, 84, 2)));
        assert_eq!(parse_semver("v1.15.13"), Some((1, 15, 13)));
        assert_eq!(parse_semver("1.15.13-beta"), Some((1, 15, 13)));
        // Missing components read as zero, so "0.85" == "0.85.0".
        assert_eq!(parse_semver("0.85"), Some((0, 85, 0)));
        assert_eq!(parse_semver("unknown"), None);
    }

    #[test]
    fn a_pinned_minimum_is_satisfied_by_anything_newer() {
        assert!(version_ge("0.84.2", "0.84.2"));
        assert!(version_ge("0.85.0", "0.84.2"));
        assert!(version_ge("1.0.0", "0.84.2"));
        assert!(!version_ge("0.84.1", "0.84.2"));
        assert!(!version_ge("0.85", "0.85.1"));
        // Unparseable is needs-install, not up-to-date.
        assert!(!version_ge("unknown", "0.84.2"));
    }
}
