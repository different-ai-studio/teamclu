//! What the file sync refuses to carry.
//!
//! A knowledge tree is a folder people drag things into. Dragging a checked-out
//! repo into it puts `node_modules/` on the sync path — tens of thousands of
//! files, one `sync_files` row and one object each — and the sync data plane has
//! no rate limit of its own (`/v1/sync/*` is deliberately exempt in FC) and no
//! per-team quota. So the client is the first line of defence.
//!
//! It is not the only one: an old client that predates these rules still pushes
//! whatever it likes, which is why the design also calls for a server-side
//! reject on the write path. See
//! `docs/architecture/obsidian-compatible-knowledge.md` §4.
//!
//! ## Rule sources, later overriding earlier
//!
//! 1. [`BUILTIN_RULES`] — compiled in.
//! 2. `knowledge/.amuxignore` — travels with the team, so one person's rule
//!    applies to everyone. It lives *inside* the synced prefix on purpose.
//! 3. `.syncignore.local` at the content root — outside `knowledge/`, therefore
//!    never synced. For "this one machine is special".
//!
//! ## The rule that has no exceptions
//!
//! **Ignoring is "stop managing", never "delete".** The engine decides a file
//! was deleted locally by "present in sync state, absent from the scan"
//! (`engine::locally_deleted_paths`). A file that was synced before and is now
//! ignored disappears from the scan — so without an explicit exclusion the very
//! first tick after this shipped would tombstone it and **delete it off every
//! teammate's disk**. `engine` filters the tombstone list through
//! [`IgnoreRules::is_ignored`] for exactly this reason.

use std::path::Path;

use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// The team-wide rule file, inside the synced prefix.
pub const TEAM_IGNORE_FILE: &str = ".amuxignore";

/// The per-machine rule file, at the content root — outside `knowledge/`, so it
/// is not itself synced.
pub const LOCAL_IGNORE_FILE: &str = ".syncignore.local";

/// Rules every team gets, whether or not anyone wrote an `.amuxignore`.
///
/// Two kinds of entry, and the distinction matters when adding one:
/// - **Generated output** (`node_modules/`, `target/`): huge, reproducible from
///   source, and nobody means to share it.
/// - **Per-machine state** (`.obsidian/`, `.DS_Store`): small, but it churns on
///   every device independently, so syncing it is a permanent conflict factory.
///
/// A list can never be complete — a source tree nobody thought of will always
/// turn up. The size and count guards are what actually bound the damage; this
/// list just keeps the common cases quiet.
pub const BUILTIN_RULES: &[&str] = &[
    // Version control and OS litter
    ".git/",
    ".svn/",
    ".hg/",
    ".DS_Store",
    "._*",
    ".Spotlight-V100/",
    ".Trashes/",
    "Thumbs.db",
    "desktop.ini",
    "$RECYCLE.BIN/",
    // Editor / note-tool state. `.obsidian/` is ours to create (we initialize
    // the knowledge dir as a vault), and it holds `workspace.json`, which is
    // rewritten every time a pane moves.
    ".obsidian/",
    ".trash/",
    ".vscode/",
    ".idea/",
    "*.swp",
    "*~",
    // Node
    "node_modules/",
    ".pnpm-store/",
    ".yarn/",
    ".npm/",
    "dist/",
    "build/",
    ".next/",
    ".nuxt/",
    ".turbo/",
    "coverage/",
    // Rust
    "target/",
    ".cargo-target/",
    // Python
    "__pycache__/",
    "*.pyc",
    ".venv/",
    "venv/",
    ".mypy_cache/",
    ".pytest_cache/",
    ".ruff_cache/",
    // JVM / iOS
    ".gradle/",
    "DerivedData/",
    "Pods/",
    "*.xcuserstate",
];

// Conflict sidecars are deliberately NOT in that list. A glob (`*.conflict.*`)
// would also swallow `merge.conflict.md`, which is a note somebody wrote — and
// the consequences are already documented in `scanner::has_conflict_infix`:
// sync silently refuses to upload it, and the conflicts endpoint lists it as a
// decision that can never be made. The scanner keeps its stricter name check,
// which requires the `<stem>.conflict.<unix_ts>.<hash>` shape this product
// actually writes.

/// Compiled ignore rules for one team's content root.
pub struct IgnoreRules {
    matcher: Gitignore,
}

impl IgnoreRules {
    /// Build the matcher for `content_root` (`~/.amuxd[-<brand>]/teams/<id>/shared`).
    ///
    /// Never fails: a rule file that cannot be read or contains a malformed
    /// line is skipped with a warning. Refusing to sync at all because someone
    /// fat-fingered a pattern would be a far worse failure than ignoring one
    /// line too few.
    pub fn load(content_root: &Path) -> Self {
        // Patterns are written relative to the vault root — a user writing
        // `node_modules/` in `.amuxignore` means the one next to their notes,
        // not `knowledge/node_modules` spelled out.
        let vault_root = content_root.join("knowledge");
        let mut builder = GitignoreBuilder::new(&vault_root);
        // macOS and Windows filesystems are case-insensitive by default; rules
        // that are not would behave differently for different teammates.
        builder.case_insensitive(true).ok();

        for rule in BUILTIN_RULES {
            if let Err(e) = builder.add_line(None, rule) {
                tracing::warn!("[ignore] builtin rule {rule:?} rejected: {e}");
            }
        }
        for file in [
            vault_root.join(TEAM_IGNORE_FILE),
            content_root.join(LOCAL_IGNORE_FILE),
        ] {
            if !file.exists() {
                continue;
            }
            if let Some(e) = builder.add(&file) {
                tracing::warn!("[ignore] {}: {e}", file.display());
            }
        }

        let matcher = builder.build().unwrap_or_else(|e| {
            tracing::warn!("[ignore] rules failed to compile, nothing will be ignored: {e}");
            Gitignore::empty()
        });
        Self { matcher }
    }

    /// Rules that ignore nothing.
    ///
    /// Test-only: production code always builds from the real rule files, and a
    /// silently-empty set is precisely what this module exists to prevent.
    #[cfg(test)]
    pub fn empty() -> Self {
        Self {
            matcher: Gitignore::empty(),
        }
    }

    /// Whether `rel_path` — relative to the **content root**, e.g.
    /// `knowledge/notes/a.md` — is ignored.
    ///
    /// Only matches the entry itself. Callers walking a tree must prune ignored
    /// directories as they go rather than rely on children inheriting: this
    /// mirrors how git evaluates ignore rules, and it is also the whole point —
    /// not descending into `node_modules/` is what makes the scan cheap.
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let Some(rel) = vault_relative(rel_path) else {
            // Outside `knowledge/` — not sync content, so these rules have no
            // opinion about it.
            return false;
        };
        // The rule file can never rule itself out; a team that managed that
        // would lose the ability to edit its own rules.
        if rel == TEAM_IGNORE_FILE {
            return false;
        }
        self.matcher.matched(rel, is_dir).is_ignore()
    }

    /// Whether `rel_path`, or any directory above it, is ignored.
    ///
    /// [`Self::is_ignored`] answers only about the entry itself, which is what a
    /// walker wants — it prunes as it goes, so children never come up. A caller
    /// holding a bare path has no walk to prune and must ask about the whole
    /// chain: `node_modules/` ignores `node_modules/a/b.js` even though no rule
    /// mentions that file.
    ///
    /// This is the form the tombstone filter and the pull loop use.
    pub fn is_ignored_with_ancestors(&self, rel_path: &str) -> bool {
        let parts: Vec<&str> = rel_path.split('/').collect();
        for depth in 1..parts.len() {
            if self.is_ignored(&parts[..depth].join("/"), true) {
                return true;
            }
        }
        self.is_ignored(rel_path, false)
    }
}

/// Strip the synced prefix so a path can be matched against rules written
/// relative to the vault root. `None` when the path is not under it.
///
/// `knowledge/` is the only entry in `ALLOWED_PREFIXES`; if that ever grows,
/// this has to grow with it.
fn vault_relative(rel_path: &str) -> Option<&str> {
    let rest = rel_path.strip_prefix("knowledge/")?;
    (!rest.is_empty()).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_in(dir: &Path) -> IgnoreRules {
        IgnoreRules::load(dir)
    }

    #[test]
    fn builtin_rules_catch_the_big_generated_trees() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored("knowledge/node_modules", true));
        assert!(r.is_ignored("knowledge/app/node_modules", true));
        assert!(r.is_ignored("knowledge/target", true));
        assert!(r.is_ignored("knowledge/.git", true));
    }

    #[test]
    fn builtin_rules_catch_per_machine_state() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored("knowledge/.obsidian", true));
        assert!(r.is_ignored("knowledge/.DS_Store", false));
        assert!(r.is_ignored("knowledge/notes/.DS_Store", false));
    }

    #[test]
    fn documents_are_not_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/onboarding.md", false));
        assert!(!r.is_ignored("knowledge/项目/会议纪要.md", false));
        assert!(!r.is_ignored("knowledge/attachments/diagram.png", false));
    }

    /// Conflict sidecars stay the scanner's job — see the note under
    /// `BUILTIN_RULES`. A glob here would also hide a document somebody named
    /// `merge.conflict.md`, and hiding it is worse than listing it: the sidecar
    /// path silently refuses to upload.
    #[test]
    fn conflict_sidecars_are_not_this_modules_job() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/note.conflict.1748332800.abc123de.md", false));
        assert!(!r.is_ignored("knowledge/merge.conflict.md", false));
    }

    #[test]
    fn a_team_rule_file_adds_to_the_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("knowledge");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join(TEAM_IGNORE_FILE), "*.draft\nscratch/\n").unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored("knowledge/plan.draft", false));
        assert!(r.is_ignored("knowledge/scratch", true));
        // …and the builtins still apply.
        assert!(r.is_ignored("knowledge/node_modules", true));
        assert!(!r.is_ignored("knowledge/plan.md", false));
    }

    /// Without this a team could write a rule that hides its own rule file, and
    /// then never be able to edit it from another machine.
    #[test]
    fn the_team_rule_file_can_never_ignore_itself() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("knowledge");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join(TEAM_IGNORE_FILE), ".amuxignore\n*\n").unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/.amuxignore", false));
    }

    #[test]
    fn a_negation_can_rescue_a_builtin_ignore() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("knowledge");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join(TEAM_IGNORE_FILE), "!dist/\n").unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/dist", true));
        assert!(r.is_ignored("knowledge/target", true));
    }

    #[test]
    fn a_local_rule_file_is_read_from_the_content_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge")).unwrap();
        std::fs::write(dir.path().join(LOCAL_IGNORE_FILE), "my-machine-only/\n").unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored("knowledge/my-machine-only", true));
    }

    /// Rules are matched case-insensitively because macOS and Windows
    /// filesystems are: the same tree must not sync differently per teammate.
    #[test]
    fn matching_ignores_case() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored("knowledge/Node_Modules", true));
    }

    /// Paths outside the synced prefix are none of this module's business —
    /// answering `true` for them would be a licence for a caller to skip
    /// something it should have carried.
    #[test]
    fn paths_outside_the_synced_prefix_are_never_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("skills/node_modules", true));
        assert!(!r.is_ignored("knowledge", true));
    }

    /// A directory rule (`node_modules/`) must not swallow a *file* of the same
    /// name — the `is_dir` flag passed to `matched` is what keeps those apart.
    #[test]
    fn a_directory_rule_does_not_match_a_file_of_the_same_name() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/node_modules", false));
    }

    /// The tombstone filter and the pull loop hold bare paths with no walk to
    /// prune, so a file deep inside an ignored directory has to come back
    /// ignored — otherwise the first tick after this shipped would tombstone
    /// every file under `node_modules/` and delete them off every teammate's
    /// disk.
    #[test]
    fn ancestor_form_catches_files_inside_an_ignored_directory() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(r.is_ignored_with_ancestors("knowledge/node_modules/left-pad/index.js"));
        assert!(r.is_ignored_with_ancestors("knowledge/app/target/debug/foo"));
        assert!(!r.is_ignored_with_ancestors("knowledge/notes/a.md"));
    }

    /// The plain form must NOT do ancestor lookup: the walker relies on it
    /// being about the entry alone.
    #[test]
    fn plain_form_does_not_look_at_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let r = rules_in(dir.path());
        assert!(!r.is_ignored("knowledge/node_modules/left-pad/index.js", false));
    }

    #[test]
    fn empty_rules_ignore_nothing() {
        let r = IgnoreRules::empty();
        assert!(!r.is_ignored("knowledge/node_modules", true));
    }
}
