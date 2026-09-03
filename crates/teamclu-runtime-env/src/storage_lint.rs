//! Ratchet: home-directory names may only be spelled in one place.
//!
//! `~/.amuxd`, `~/.teamclu` and their pre-rebrand spellings are derived by
//! [`crate::storage_namespace`] from the brand and `$AMUXD_HOME`. Every other
//! spelling is a path built by hand, and every one of them is a place a
//! white-label build silently reads the official brand's state — the class of
//! bug that put `apps_data_root()` on `$HOME/.amuxd/apps` with no brand
//! resolution at all, and `device_id.rs` on `$HOME/.amuxd/device-id`.
//!
//! [`DEBT`] is the set of files that still spell one by hand. It may only
//! shrink: a file that stops offending must be removed from the list in the
//! same PR, or this test fails. That is deliberate — an allowlist nobody is
//! forced to prune stops meaning anything.
//!
//! Spec: `docs/architecture/amuxd-home-layout-v2.md` §8.

use std::fs;
use std::path::{Path, PathBuf};

/// Files allowed to spell the names by design: the resolver itself, and this
/// lint (whose needles are those names). Not subject to the ratchet.
const OWNERS: &[&str] = &[
    "crates/teamclu-runtime-env/src/storage_lint.rs",
    "crates/teamclu-runtime-env/src/storage_namespace.rs",
];

/// Files that still build a path from a hand-written home-directory name.
///
/// **This list may only get shorter.** Sorted; keep it that way.
const DEBT: &[&str] = &[
    // Test-only, and the name is the subject of the test: it plants
    // `.amuxd-copilot361` as a branded `AMUXD_HOME` and checks the reaper stays
    // inside it. Landed with #1218. Clearable by asking `storage_namespace` to
    // build the branded name instead of spelling it.
    "apps/daemon/src/cli/process.rs",
    // Not a home directory: a temp sibling inside an already-resolved skills
    // root (`.teamclu-create-<uuid>`, `-update-`, `-backup-`, `-draft-`). The
    // needle cannot tell that from `~/.teamclu`, and there is nothing here to
    // resolve through the runtime-env helpers. Clearing these two means
    // teaching the lint, not rewriting the code.
    "apps/daemon/src/config/managed_skill_writer.rs",
    "apps/daemon/src/config/roles_skills.rs",
    // Test-only, and a workspace meta dir rather than a home one:
    // `.teamclu/instructions/...` under a temp workspace. Clearable by asking
    // `workspace_meta_dir_from_env` for the path instead of spelling it.
    "apps/daemon/src/config/skill_creation_policy.rs",
    "apps/daemon/src/config/team_skill_draft.rs",
    "apps/daemon/src/config/workspace_control.rs",
    "apps/daemon/src/provider_config.rs",
    "apps/daemon/src/runtime/env_assembly.rs",
    "apps/daemon/src/runtime/prompt_attachments.rs",
    "apps/daemon/src/runtime/refresh_watch.rs",
    "apps/daemon/src/runtime/supervisor.rs",
    "apps/daemon/src/sync/oss/state.rs",
    "apps/daemon/src/team_link.rs",
    "apps/daemon/src/team_shared_env.rs",
    "apps/daemon/src/workspace_meta_gate.rs",
    "apps/desktop/crates/teamclu-introspect/src/config.rs",
    "apps/desktop/crates/teamclu-introspect/src/cron.rs",
    // Test-only: assertions that the resolver produced `.amuxd-teamclaw` /
    // `.amuxd-copilot361` for a branded build. Spelling the names is the point
    // of those assertions — this is the one entry that wants OWNERS-like
    // treatment rather than a rewrite.
    "apps/desktop/src/commands/amuxd_supervisor.rs",
    "apps/desktop/src/commands/diagnostics.rs",
    "apps/desktop/src/commands/team_share/enable.rs",
    "apps/desktop/tests/team_share_smoke.rs",
    "crates/teamclu-gateway/src/lib.rs",
    "crates/teamclu-runtime-env/src/active_session.rs",
    "crates/teamclu-runtime-env/src/env_catalog.rs",
    "crates/teamclu-runtime-env/src/mcp_resolve.rs",
    "crates/teamclu-runtime-env/src/opencode_config.rs",
    "crates/teamclu-runtime-env/src/team_provider_sync.rs",
    "packages/app/src/components/settings/__tests__/GeneralSectionSmallWindow.test.tsx",
    "packages/app/src/components/settings/__tests__/SettingsNavigation.test.tsx",
    "packages/app/src/lib/__tests__/mid-turn-followup-repro.test.ts",
    "packages/app/src/lib/__tests__/session-binding-live.test.ts",
    "packages/app/src/lib/build-config.ts",
];

/// A hand-written home dir is a quote immediately followed by one of these.
/// `.teamclu` also covers `.teamcludev`, `.amuxd` covers `.amuxd-<brand>`.
const NEEDLES: &[&str] = &[".amuxd", ".teamclu", ".teamclaw"];

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".next",
    "coverage",
    "dist",
    "node_modules",
    "target",
    ".cargo-target",
];

const SCANNED_EXTENSIONS: &[&str] = &["rs", "ts", "tsx"];

/// True when `text` contains a string literal starting with a home-dir name.
///
/// `backtick_opens_a_string` is per-language: in TypeScript a backtick opens a
/// template literal, so `` `.teamclu/x` `` there really is a hand-written path.
/// Rust has no backtick literal — a backtick can only be doc prose, and
/// rewriting a doc comment that names the directory it documents is exactly the
/// noise this lint set out not to create.
fn has_hand_written_home_dir(text: &str, backtick_opens_a_string: bool) -> bool {
    let bytes = text.as_bytes();
    for needle in NEEDLES {
        let mut from = 0usize;
        while let Some(rel) = text[from..].find(needle) {
            let at = from + rel;
            // Only a quoted literal counts — prose and comments mention these
            // names constantly and rewriting them would be pure noise.
            let quoted = at > 0
                && (matches!(bytes[at - 1], b'"' | b'\'')
                    || (backtick_opens_a_string && bytes[at - 1] == b'`'));
            if quoted {
                return true;
            }
            from = at + needle.len();
        }
    }
    false
}

fn collect_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_ref()) {
                collect_sources(&path, out);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| SCANNED_EXTENSIONS.contains(&ext))
        {
            out.push(path);
        }
    }
}

/// Repo-relative, forward-slash path — the form both lists above use.
fn repo_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> Option<PathBuf> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        let root = root.canonicalize().ok()?;
        // A vendored or partially-checked-out build has no repo to scan; skip
        // rather than fail on a machine that simply does not have the sources.
        root.join("apps/daemon/src").is_dir().then_some(root)
    }

    #[test]
    fn debt_list_is_sorted_and_unique() {
        let mut sorted = DEBT.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, DEBT, "DEBT must stay sorted and free of duplicates");
    }

    #[test]
    fn needle_matches_only_quoted_literals() {
        assert!(has_hand_written_home_dir(r#"h.join(".amuxd")"#, false));
        assert!(has_hand_written_home_dir(r#"'.teamclu/secrets'"#, false));
        assert!(has_hand_written_home_dir(r#"".amuxd-copilot361""#, false));
        // Prose, comments and derived paths are not the target.
        assert!(!has_hand_written_home_dir(
            "// lives under ~/.amuxd today",
            false
        ));
        assert!(!has_hand_written_home_dir(
            r#"amuxd_home_from_env().join("teams")"#,
            false
        ));
    }

    #[test]
    fn a_backtick_is_a_literal_in_ts_and_prose_in_rust() {
        // A TypeScript template literal really does build the path.
        assert!(has_hand_written_home_dir(r#"`.teamclaw/${team}`"#, true));
        // The same characters in a Rust doc comment document the directory;
        // rewriting that sentence would say less and pass a lint.
        assert!(!has_hand_written_home_dir(
            r#"/// writes `.teamclu/` into the workspace"#,
            false
        ));
    }

    /// The ratchet. Fails in both directions: a new hand-written home dir, and
    /// a listed file that no longer has one.
    #[test]
    fn hand_written_home_dirs_only_shrink() {
        let Some(root) = repo_root() else {
            return;
        };

        let mut sources = Vec::new();
        for top in ["apps", "crates", "packages"] {
            collect_sources(&root.join(top), &mut sources);
        }
        assert!(
            sources.len() > 100,
            "scan found only {} source files — the walk is broken, not the repo",
            sources.len()
        );

        let mut offenders: Vec<String> = sources
            .iter()
            .filter(|path| {
                let backticks = path.extension().and_then(|e| e.to_str()) != Some("rs");
                fs::read_to_string(path)
                    .map(|text| has_hand_written_home_dir(&text, backticks))
                    .unwrap_or(false)
            })
            .filter_map(|path| repo_relative(&root, path))
            .filter(|rel| !OWNERS.contains(&rel.as_str()))
            .collect();
        offenders.sort_unstable();

        let added: Vec<&String> = offenders
            .iter()
            .filter(|rel| !DEBT.contains(&rel.as_str()))
            .collect();
        assert!(
            added.is_empty(),
            "these files build a path from a hand-written home directory:\n  {}\n\n\
             Resolve it through `teamclu_runtime_env` instead \
             (`amuxd_home_from_env`, `workspace_meta_dir_from_env`, …). \
             See docs/architecture/amuxd-home-layout-v2.md §6.",
            added
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        );

        let cleaned: Vec<&str> = DEBT
            .iter()
            .filter(|rel| !offenders.iter().any(|o| o == *rel))
            .copied()
            .collect();
        assert!(
            cleaned.is_empty(),
            "these files no longer hand-write a home directory — \
             delete them from `DEBT` in this PR:\n  {}",
            cleaned.join("\n  ")
        );
    }
}
