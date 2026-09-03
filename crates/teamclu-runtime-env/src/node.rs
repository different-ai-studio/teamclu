//! Which `node` the agent runtimes actually run on.
//!
//! pi is a Node CLI and cursor's bridge is a Node script, so "is this machine
//! ready" is really a question about a *specific* node binary — and on a
//! developer's machine there is rarely just one. The report that produced this
//! module had three: `~/.n/bin/node` (v24.18.0), an fnm shell (v26.1.0), and
//! `/usr/local/bin/node` symlinked into an abandoned nvm 20.20.2. The terminal
//! ran the first, the app measured the last, and pi — which needs >= 22.19.0 —
//! was reported as unusable on a machine that runs it fine.
//!
//! So the question is not "what does `node` resolve to" but "is there a node
//! here that satisfies the minimum": [`resolve_node`] walks every candidate
//! `teamclu_binpath` can name, best-first, and takes the first that does. When
//! none does it still reports the best one it found, because "found 20.20.2,
//! need 22.19.0" is an actionable answer and "node missing" is not.

use std::path::{Path, PathBuf};

use crate::version::version_ge;

/// The minimum Node pi declares (`engines.node` of pi 0.84.x).
///
/// Shared rather than re-typed per app: the daemon gates the install on it, the
/// desktop labels the Dependencies row with it, and onboarding explains it. The
/// last time two of those disagreed, the same machine read as ready in one
/// screen and broken in the next (#1049).
pub const PI_MIN_VERSION: &str = "22.19.0";

/// A node binary and what it reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeChoice {
    pub path: PathBuf,
    /// Exactly as node prints it, `v` prefix and all (`v24.18.0`).
    pub version: String,
    /// Whether [`version`](Self::version) meets the minimum asked for. `false`
    /// means this is the best node on the machine and it is still too old.
    pub satisfies: bool,
}

impl NodeChoice {
    /// `20.20.2 (/usr/local/bin/node)` — what to put in front of a user who was
    /// just told their node is too old, so they can see *which* node we mean.
    pub fn describe(&self) -> String {
        format!(
            "{} ({})",
            self.version.trim_start_matches('v'),
            self.path.display()
        )
    }
}

/// The best node on this machine for something that needs `min_version`.
///
/// `None` only when no candidate answered `--version` at all — that is the one
/// case where "Node is not installed" is the truth.
pub fn resolve_node(min_version: &str) -> Option<NodeChoice> {
    choose_node(
        &teamclu_binpath::node_candidates(),
        min_version,
        probe_version,
    )
}

/// `<node> --version`, or `None` when the file cannot run.
fn probe_version(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command.arg("--version");
    command.env("PATH", teamclu_binpath::augmented_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!line.is_empty()).then_some(line)
}

/// [`resolve_node`] over an explicit candidate list and probe, so tests do not
/// depend on what happens to be installed on the machine running them.
///
/// Stops at the first candidate that satisfies the minimum: on a healthy
/// machine that is the first entry, so the usual cost stays one spawn.
pub fn choose_node(
    candidates: &[PathBuf],
    min_version: &str,
    probe: impl Fn(&Path) -> Option<String>,
) -> Option<NodeChoice> {
    let mut best_too_old: Option<NodeChoice> = None;
    for path in candidates {
        let Some(version) = probe(path) else { continue };
        if version_ge(&version, min_version) {
            return Some(NodeChoice {
                path: path.clone(),
                version,
                satisfies: true,
            });
        }
        if best_too_old.is_none() {
            best_too_old = Some(NodeChoice {
                path: path.clone(),
                version,
                satisfies: false,
            });
        }
    }
    best_too_old
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_from(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&Path) -> Option<String> {
        move |path: &Path| {
            pairs
                .iter()
                .find(|(p, _)| Path::new(p) == path)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn a_newer_node_further_down_the_list_beats_the_first_one() {
        // The reported machine exactly: PATH resolves to an abandoned nvm 20,
        // and the node the user actually runs sits in a version-manager
        // directory no GUI app inherits.
        let candidates = vec![
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/home/u/.n/bin/node"),
        ];
        let got = choose_node(
            &candidates,
            PI_MIN_VERSION,
            probe_from(&[
                ("/usr/local/bin/node", "v20.20.2"),
                ("/home/u/.n/bin/node", "v24.18.0"),
            ]),
        )
        .unwrap();
        assert_eq!(got.path, PathBuf::from("/home/u/.n/bin/node"));
        assert_eq!(got.version, "v24.18.0");
        assert!(got.satisfies);
    }

    #[test]
    fn the_first_satisfying_candidate_wins_and_stops_the_walk() {
        let candidates = vec![PathBuf::from("/a/node"), PathBuf::from("/b/node")];
        let seen = std::cell::RefCell::new(Vec::new());
        let got = choose_node(&candidates, PI_MIN_VERSION, |p| {
            seen.borrow_mut().push(p.to_path_buf());
            Some("v22.19.0".to_string())
        })
        .unwrap();
        assert_eq!(got.path, PathBuf::from("/a/node"));
        assert_eq!(seen.into_inner().len(), 1, "must not keep probing");
    }

    #[test]
    fn everything_too_old_still_reports_the_best_one_found() {
        // "node missing" next to a Dependencies row reading 20.20.2 is what
        // sent the reporter looking for a node they already had.
        let candidates = vec![PathBuf::from("/usr/local/bin/node")];
        let got = choose_node(
            &candidates,
            PI_MIN_VERSION,
            probe_from(&[("/usr/local/bin/node", "v20.20.2")]),
        )
        .unwrap();
        assert!(!got.satisfies);
        assert_eq!(got.describe(), "20.20.2 (/usr/local/bin/node)");
    }

    #[test]
    fn a_candidate_that_cannot_run_is_skipped_not_reported() {
        let candidates = vec![PathBuf::from("/broken/node"), PathBuf::from("/good/node")];
        let got = choose_node(
            &candidates,
            PI_MIN_VERSION,
            probe_from(&[("/good/node", "v24.0.0")]),
        )
        .unwrap();
        assert_eq!(got.path, PathBuf::from("/good/node"));
    }

    #[test]
    fn no_node_anywhere_is_none() {
        assert!(choose_node(&[], PI_MIN_VERSION, probe_from(&[])).is_none());
        assert!(choose_node(
            &[PathBuf::from("/nope/node")],
            PI_MIN_VERSION,
            probe_from(&[])
        )
        .is_none());
    }
}
