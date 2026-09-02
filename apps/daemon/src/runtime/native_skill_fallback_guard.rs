//! Turn-scoped detection when agents write skill packs to native runtime dirs
//! instead of `manage_skills` → `~/.agents/skills/<slug>/`.
//!
//! PR3 ships **fail-closed detect** only: violations replace the turn-final
//! agent success reply and instruct recreation via `manage_skills`.
//! `TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION` is reserved for a future adoption path
//! and must not disable detection until that path exists.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::proto::amux;
use crate::proto::teamclu::MessageKind;
use crate::runtime::claude_skills;
use crate::runtime::turn_aggregator::{EmittedMessage, TurnAggregator};

pub const ERROR_CODE: &str = "skill_created_in_unsupported_directory";

pub const AGENT_REPLY_CONTENT: &str = "\
[Skill created in unsupported directory] A skill pack was written under a native \
agent directory (.opencode/skills, .pi/skills, or .claude/skills) instead of \
through manage_skills. The native copy was not adopted. Remove it and recreate \
the skill with manage_skills action=create so it lands in ~/.agents/skills/<slug>/.";

/// Per-parent-session guard opened at logical turn start and closed at turn end.
#[derive(Debug, Clone)]
pub struct NativeSkillTurnGuard {
    pub turn_id: String,
    pub acp_session_id: String,
    pub baseline: NativeSkillBaseline,
}

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

pub fn event_may_open_implicit_turn(event: &Option<amux::acp_event::Event>) -> bool {
    matches!(
        event,
        Some(amux::acp_event::Event::Output(_))
            | Some(amux::acp_event::Event::Thinking(_))
            | Some(amux::acp_event::Event::ToolUse(_))
    )
}

pub fn ensure_turn_guard(
    guard: &mut Option<NativeSkillTurnGuard>,
    workspace: &Path,
    parent_acp_session_id: &str,
    turn_id: Option<&str>,
) {
    if !guard_enabled() || guard.is_some() {
        return;
    }
    *guard = Some(NativeSkillTurnGuard {
        turn_id: turn_id.unwrap_or("").to_string(),
        acp_session_id: parent_acp_session_id.to_string(),
        baseline: snapshot_baseline(workspace),
    });
}

pub fn take_violations_for_turn_end(
    guard: &mut Option<NativeSkillTurnGuard>,
    parent_acp_session_id: &str,
    workspace: &Path,
) -> Vec<NativeSkillViolation> {
    let Some(active) = guard.take() else {
        return Vec::new();
    };
    if active.acp_session_id != parent_acp_session_id {
        *guard = Some(active);
        return Vec::new();
    }
    violations_after_turn(&active.baseline, workspace)
}

pub fn failure_metadata_json(violations: &[NativeSkillViolation]) -> String {
    serde_json::json!({
        "turn_status": ERROR_CODE,
        "error_code": ERROR_CODE,
        "violations": violations
            .iter()
            .map(|v| {
                serde_json::json!({
                    "slug": v.slug,
                    "root": v.root_label,
                    "path": v.path.to_string_lossy(),
                })
            })
            .collect::<Vec<_>>(),
    })
    .to_string()
}

pub fn is_failure_emitted_message(msg: &EmittedMessage) -> bool {
    msg.kind == MessageKind::AgentReply
        && msg
            .metadata_json
            .contains(&format!("\"turn_status\":\"{ERROR_CODE}\""))
}

pub fn apply_violations_to_emitted(
    emitted: &mut Vec<EmittedMessage>,
    violations: &[NativeSkillViolation],
    turn_id: &str,
) {
    if violations.is_empty() {
        return;
    }
    emitted.retain(|msg| {
        !(msg.kind == MessageKind::AgentReply
            && TurnAggregator::cloud_persistent(msg)
            && !is_failure_emitted_message(msg))
    });
    emitted.push(EmittedMessage {
        kind: MessageKind::AgentReply,
        content: AGENT_REPLY_CONTENT.to_string(),
        metadata_json: failure_metadata_json(violations),
        turn_id: turn_id.to_string(),
        cloud_persist: true,
    });
}

/// Guard lifecycle for one ACP event. Must run **before** `TurnAggregator::ingest`
/// on parent-session events so turn-end detection sees the pre-ingest filesystem
/// and implicit turns open a baseline before the first content event allocates
/// `turn_id`.
pub fn prepare_guard_for_acp_event(
    guard: &mut Option<NativeSkillTurnGuard>,
    workspace: &Path,
    parent_acp_session_id: &str,
    is_child_event: bool,
    event: &amux::AcpEvent,
    current_turn_id: Option<&str>,
) -> Vec<NativeSkillViolation> {
    if is_child_event || !guard_enabled() {
        return Vec::new();
    }
    let turn_opened = matches!(
        event.event.as_ref(),
        Some(amux::acp_event::Event::StatusChange(sc))
            if sc.old_status == amux::AgentStatus::Idle as i32
                && sc.new_status == amux::AgentStatus::Active as i32
    );
    let implicit_turn_event =
        event_may_open_implicit_turn(&event.event) && current_turn_id.is_none();
    if turn_opened || implicit_turn_event {
        ensure_turn_guard(
            guard,
            workspace,
            parent_acp_session_id,
            current_turn_id,
        );
    }
    let clear_reply_to = matches!(
        event.event.as_ref(),
        Some(amux::acp_event::Event::StatusChange(sc))
            if sc.old_status == amux::AgentStatus::Active as i32
                && sc.new_status == amux::AgentStatus::Idle as i32
    );
    if clear_reply_to {
        take_violations_for_turn_end(guard, parent_acp_session_id, workspace)
    } else {
        Vec::new()
    }
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
    if !guard_enabled() {
        return Vec::new();
    }
    if auto_adoption_enabled() {
        tracing::warn!(
            "TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION is set but auto-adoption is not implemented; \
             native skill fallback detection remains active"
        );
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
    use crate::proto::amux;
    use crate::runtime::claude_skills::reconcile_after_managed_mutation;
    use crate::runtime::turn_aggregator::TurnAggregator;

    fn write_native_pack(root: &Path, slug: &str, body: &str) {
        let dir = root.join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn status_change(old: amux::AgentStatus, new: amux::AgentStatus) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::StatusChange(amux::AcpStatusChange {
                old_status: old as i32,
                new_status: new as i32,
            })),
            model: String::new(),
        }
    }

    fn output_chunk(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.into(),
                is_complete: false,
            })),
            model: String::new(),
        }
    }

    fn ingest_with_guard(
        workspace: &Path,
        parent_acp: &str,
        guard: &mut Option<NativeSkillTurnGuard>,
        agg: &mut TurnAggregator,
        event: &amux::AcpEvent,
        is_child: bool,
    ) -> Vec<EmittedMessage> {
        let turn_id_before = agg.current_turn_id().map(str::to_string);
        let violations = prepare_guard_for_acp_event(
            guard,
            workspace,
            parent_acp,
            is_child,
            event,
            turn_id_before.as_deref(),
        );
        let mut emitted = if !is_child {
            agg.ingest(event)
        } else {
            Vec::new()
        };
        if !violations.is_empty() {
            apply_violations_to_emitted(
                &mut emitted,
                &violations,
                turn_id_before.as_deref().unwrap_or(""),
            );
        }
        emitted
    }

    fn cloud_persistent_replies(emitted: &[EmittedMessage]) -> Vec<&EmittedMessage> {
        emitted
            .iter()
            .filter(|msg| TurnAggregator::cloud_persistent(msg))
            .collect()
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
    fn detects_new_pi_native_skill_after_turn() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        write_native_pack(
            &ws.path().join(".pi/skills"),
            "pi-native",
            "---\nname: pi-native\ndescription: Pi native.\n---\n",
        );
        let violations = violations_after_turn(&baseline, ws.path());
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].slug, "pi-native");
        assert_eq!(violations[0].root_label, ".pi/skills");
    }

    #[test]
    fn detects_new_claude_native_skill_after_turn() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        write_native_pack(
            &ws.path().join(".claude/skills"),
            "claude-native",
            "---\nname: claude-native\ndescription: Claude native.\n---\n",
        );
        let violations = violations_after_turn(&baseline, ws.path());
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].slug, "claude-native");
        assert_eq!(violations[0].root_label, ".claude/skills");
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

    #[test]
    fn auto_adoption_flag_does_not_disable_detection() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        std::env::set_var("TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION", "true");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "still-detected",
            "---\nname: still-detected\ndescription: Still detected.\n---\n",
        );
        let violations = violations_after_turn(&baseline, ws.path());
        assert_eq!(violations.len(), 1);
        std::env::remove_var("TEAMCLU_NATIVE_SKILL_AUTO_ADOPTION");
    }

    #[test]
    fn apply_violations_replaces_cloud_persistent_success_reply() {
        let violations = vec![NativeSkillViolation {
            root_label: ".opencode/skills",
            slug: "demo".into(),
            path: PathBuf::from("/tmp/ws/.opencode/skills/demo"),
        }];
        let mut emitted = vec![EmittedMessage {
            kind: MessageKind::AgentReply,
            content: "Skill created successfully.".into(),
            metadata_json: String::new(),
            turn_id: "turn-1".into(),
            cloud_persist: true,
        }];
        apply_violations_to_emitted(&mut emitted, &violations, "turn-1");
        assert_eq!(emitted.len(), 1);
        assert!(is_failure_emitted_message(&emitted[0]));
        assert!(!emitted[0].content.contains("successfully"));
        assert!(emitted[0].metadata_json.contains("demo"));
        assert!(emitted[0].metadata_json.contains(".opencode/skills"));
    }

    #[test]
    fn child_session_guard_does_not_consume_parent_turn_end() {
        // Same reason as `ensure_turn_guard_only_opens_once`.
        let _env = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let baseline = snapshot_baseline(ws.path());
        let mut guard = Some(NativeSkillTurnGuard {
            turn_id: "turn-parent".into(),
            acp_session_id: "child-session".into(),
            baseline,
        });
        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "child-write",
            "---\nname: child-write\ndescription: Child.\n---\n",
        );
        let violations = take_violations_for_turn_end(&mut guard, "parent-session", ws.path());
        assert!(violations.is_empty());
        assert_eq!(guard.as_ref().unwrap().acp_session_id, "child-session");
    }

    #[test]
    fn ensure_turn_guard_only_opens_once() {
        // `guard_mode()` reads the process-global
        // `TEAMCLU_NATIVE_SKILL_FALLBACK_GUARD`, and `guard_respects_off_flag`
        // sets it to "off" for the width of its own body. Without the same
        // guard — which holds `TEST_HOME_LOCK` — this test can run inside that
        // window, `ensure_turn_guard` returns early because the feature reads
        // as disabled, and the `unwrap` below hits a `None` that has nothing to
        // do with what is being tested. Every other test in this module that
        // touches the guard already takes it.
        let _env = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let mut guard = None;
        ensure_turn_guard(&mut guard, ws.path(), "parent", Some("turn-1"));
        let first = guard.clone().unwrap();
        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "late",
            "---\nname: late\ndescription: Late.\n---\n",
        );
        ensure_turn_guard(&mut guard, ws.path(), "parent", Some("turn-1"));
        assert_eq!(guard.unwrap().baseline.entries, first.baseline.entries);
    }

    #[test]
    fn messaging_flow_explicit_turn_suppresses_success_on_violation() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let parent_acp = "parent-session";
        let mut turn_guard = None;
        let mut agg = TurnAggregator::new();

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            false,
        )
        .is_empty());

        write_native_pack(
            &ws.path().join(".opencode/skills"),
            "bypass-demo",
            "---\nname: bypass-demo\ndescription: Bypass.\n---\n",
        );

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &output_chunk("Skill created successfully."),
            false,
        )
        .is_empty());

        let emitted = ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            false,
        );
        let finals = cloud_persistent_replies(&emitted);
        assert_eq!(finals.len(), 1, "expected one cloud-final reply: {emitted:?}");
        assert!(is_failure_emitted_message(finals[0]));
        assert!(finals[0].metadata_json.contains("bypass-demo"));
        assert!(finals[0].metadata_json.contains(".opencode/skills"));
        assert!(!finals[0].content.contains("successfully"));
    }

    #[test]
    fn messaging_flow_implicit_turn_detects_native_write_before_active() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let parent_acp = "parent-session";
        let mut turn_guard = None;
        let mut agg = TurnAggregator::new();

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &output_chunk("Starting work…"),
            false,
        )
        .is_empty());
        assert!(turn_guard.is_some(), "implicit turn should open guard baseline");

        write_native_pack(
            &ws.path().join(".pi/skills"),
            "implicit-pi",
            "---\nname: implicit-pi\ndescription: Implicit.\n---\n",
        );

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            false,
        )
        .is_empty());

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &output_chunk("Done."),
            false,
        )
        .is_empty());

        let emitted = ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            false,
        );
        let finals = cloud_persistent_replies(&emitted);
        assert_eq!(finals.len(), 1);
        assert!(is_failure_emitted_message(finals[0]));
        assert!(finals[0].metadata_json.contains("implicit-pi"));
    }

    #[test]
    fn messaging_flow_child_idle_does_not_consume_parent_guard() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let parent_acp = "parent-session";
        let mut turn_guard = None;
        let mut agg = TurnAggregator::new();

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            false,
        )
        .is_empty());
        assert!(turn_guard.is_some());

        write_native_pack(
            &ws.path().join(".claude/skills"),
            "parent-skill",
            "---\nname: parent-skill\ndescription: Parent.\n---\n",
        );

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            true,
        )
        .is_empty());
        assert!(
            turn_guard.is_some(),
            "child Idle should not consume parent guard"
        );

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &output_chunk("Skill created successfully."),
            false,
        )
        .is_empty());

        let emitted = ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            false,
        );
        let finals = cloud_persistent_replies(&emitted);
        assert_eq!(finals.len(), 1);
        assert!(is_failure_emitted_message(finals[0]));
        assert!(finals[0].metadata_json.contains("parent-skill"));
    }

    #[test]
    fn messaging_flow_clean_turn_keeps_success_reply() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let parent_acp = "parent-session";
        let mut turn_guard = None;
        let mut agg = TurnAggregator::new();

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            false,
        )
        .is_empty());

        assert!(ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &output_chunk("All good."),
            false,
        )
        .is_empty());

        let emitted = ingest_with_guard(
            ws.path(),
            parent_acp,
            &mut turn_guard,
            &mut agg,
            &status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            false,
        );
        let finals = cloud_persistent_replies(&emitted);
        assert_eq!(finals.len(), 1);
        assert!(!is_failure_emitted_message(finals[0]));
        assert_eq!(finals[0].content, "All good.");
    }
}
