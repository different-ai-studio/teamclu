//! Turn-scoped detection when agents write skill packs to native runtime dirs
//! instead of `manage_skills` → `~/.agents/skills/<slug>/`.
//!
//! PR3 ships **fail-closed detect** only: violations surface on turn end and
//! instruct the agent to recreate via `manage_skills`. Auto-adoption is gated
//! behind `TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION` (default off).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::runtime::claude_skills;

pub const ERROR_CODE: &str = "skill_created_in_unsupported_directory";

pub const AGENT_REPLY_CONTENT: &str = "\
[Skill created in unsupported directory] A skill pack was written under a native \
agent directory (.opencode/skills, .pi/skills, or .claude/skills) instead of \
through manage_skills. The native copy was not adopted. Remove it and recreate \
the skill with manage_skills action=create so it lands in ~/.agents/skills/<slug>/.";

pub const AGENT_REPLY_METADATA_JSON: &str =
    r#"{"turn_status":"skill_created_in_unsupported_directory"}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum NativeRootKind {
    Opencode,
    Pi,
    Claude,
}

impl NativeRootKind {
    fn rel_dir(self) -> &'static str {
        match self {
            Self::Opencode => ".opencode/skills",
            Self::Pi => ".pi/skills",
            Self::Claude => ".claude/skills",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Opencode => ".opencode/skills",
            Self::Pi => ".pi/skills",
            Self::Claude => ".claude/skills",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NativeSkillKey {
    root: NativeRootKind,
    slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSkillViolation {
    pub root_label: &'static str,
    pub slug: String,
    pub path: PathBuf,
}

/// Snapshot of valid native-root skill slugs at turn start.
#[derive(Debug, Clone, Default)]
pub struct NativeSkillBaseline {
    entries: HashSet<NativeSkillKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardMode {
    Off,
    Detect,
}

pub fn guard_mode() -> GuardMode {
    match std::env::var("TEAMCLU_NATIVE_SKILL_FALLBACK_GUARD")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") | Some("detect") | Some("1") | Some("true") | Some("on") => {
            GuardMode::Detect
        }
        Some("off") | Some("0") | Some("false") => GuardMode::Off,
        _ => GuardMode::Detect,
    }
}

pub fn guard_enabled() -> bool {
    matches!(guard_mode(), GuardMode::Detect)
}

pub fn auto_adoption_enabled() -> bool {
    matches!(
        std::env::var("TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION")
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

pub fn snapshot_baseline(workspace: &Path) -> NativeSkillBaseline {
    NativeSkillBaseline {
        entries: scan_native_skills(workspace),
    }
}

pub fn violations_after_turn(
    baseline: &NativeSkillBaseline,
    workspace: &Path,
) -> Vec<NativeSkillViolation> {
    if !guard_enabled() || auto_adoption_enabled() {
        return Vec::new();
    }
    let current = scan_native_skills(workspace);
    current
        .difference(&baseline.entries)
        .map(|key| NativeSkillViolation {
            root_label: key.root.label(),
            slug: key.slug.clone(),
            path: workspace.join(key.root.rel_dir()).join(&key.slug),
        })
        .collect()
}

fn forbidden_roots(workspace: &Path) -> [(NativeRootKind, PathBuf); 3] {
    [
        (
            NativeRootKind::Opencode,
            workspace.join(NativeRootKind::Opencode.rel_dir()),
        ),
        (
            NativeRootKind::Pi,
            workspace.join(NativeRootKind::Pi.rel_dir()),
        ),
        (
            NativeRootKind::Claude,
            workspace.join(NativeRootKind::Claude.rel_dir()),
        ),
    ]
}

fn scan_native_skills(workspace: &Path) -> HashSet<NativeSkillKey> {
    let mut out = HashSet::new();
    for (root, dir) in forbidden_roots(workspace) {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if slug.starts_with('.') {
                continue;
            }
            if is_valid_native_skill_pack(&path, workspace, root) {
                out.insert(NativeSkillKey { root, slug });
            }
        }
    }
    out
}

fn is_valid_native_skill_pack(path: &Path, workspace: &Path, root: NativeRootKind) -> bool {
    let skill_md = path.join("SKILL.md");
    if !skill_md.is_file() {
        return false;
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => match root {
            NativeRootKind::Claude => {
                !claude_skills::is_claude_team_bridge_symlink(path, workspace)
            }
            _ => false,
        },
        Ok(meta) if meta.is_dir() => true,
        Ok(meta) if meta.is_file() => root == NativeRootKind::Claude,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{create_pack, ClaimedTeamContext, CreatePackRequest};
    use crate::runtime::claude_skills::reconcile_after_managed_mutation;

    fn write_native_pack(root: &Path, slug: &str, body: &str) {
        let dir = root.join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn detects_new_opencode_native_skill_after_turn() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "native-demo",
            "---\nname: native-demo\ndescription: Native.\n---\n",
        );
        let violations = violations_after_turn(&baseline, ws.path());
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].slug, "native-demo");
        assert_eq!(violations[0].root_label, ".opencode/skills");
    }

    #[test]
    fn baseline_skips_preexisting_native_skill() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        write_native_pack(
            &ws.path().join(".pi/skills"),
            "legacy",
            "---\nname: legacy\ndescription: Old.\n---\n",
        );
        let baseline = snapshot_baseline(ws.path());
        let violations = violations_after_turn(&baseline, ws.path());
        assert!(violations.is_empty());
    }

    #[test]
    fn claude_bridge_symlink_from_manage_skills_is_not_a_violation() {
        let lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".agents/skills")).unwrap();
        std::fs::write(
            ws.path().join("opencode.json"),
            format!(
                r#"{{"skills":{{"paths":["{}"]}}}}"#,
                home.path().join(".agents/skills").display()
            ),
        )
        .unwrap();

        let baseline = snapshot_baseline(ws.path());
        let resp = create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "bridged".into(),
                content: "---\nname: bridged\ndescription: Bridged.\n---\n".into(),
                files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        reconcile_after_managed_mutation(ws.path(), "bridged", Path::new(&resp.path)).unwrap();

        let violations = violations_after_turn(&baseline, ws.path());
        assert!(
            violations.is_empty(),
            "bridge symlink should not count as unsupported native write: {violations:?}"
        );
        drop(lock);
    }

    #[test]
    fn guard_respects_off_flag() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        std::env::set_var("TEAMCLU_NATIVE_SKILL_FALLBACK_GUARD", "off");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "ignored",
            "---\nname: ignored\ndescription: Ignored.\n---\n",
        );
        let violations = violations_after_turn(&baseline, ws.path());
        assert!(violations.is_empty());
        std::env::remove_var("TEAMCLU_NATIVE_SKILL_FALLBACK_GUARD");
    }
}
