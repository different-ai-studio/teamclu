//! Tests for the team-skill commands.
//!
//! They share fixtures (an active team, an installed pack on disk), so they
//! stay in one module rather than following the code into its own files.

use super::build_cloud_api_client;
use super::drafts::team_skill_discard_local_blocking;
use super::drafts::team_skill_list_draft_recoveries_blocking;
use super::drafts::team_skill_restore_trashed_blocking;
use super::frontmatter::installed_state;
use super::frontmatter::stamp_installed_state;
use super::frontmatter::write_install_frontmatter;
use super::frontmatter::InstalledStamp;
use super::inspect::belongs_to_another_team;
use super::inspect::effective_team_skill_dir;
use super::inspect::hosted_team_skills_dir;
use super::inspect::inspect_team_skill;
use super::inspect::EffectiveSkillSource;
use super::install::is_presigned_storage_url;
use super::install::team_skill_rebaseline_blocking;
use super::install::team_skill_uninstall_blocking;
use super::trash::prune_trash;
use super::trash::resolve_trashed_source;
use super::trash::trash_dir;
use super::trash::TRASH_MAX_ENTRIES;
use super::trash::TRASH_TTL_MS;
use super::types::TeamSkillInstallRequest;
use super::types::TeamSkillRebaselineRequest;
use crate::commands::clawhub::{global_skills_dir, now_millis, SOURCE_TEAM};
use teamclu_skillpack::{read_origin, DirtyState, SkillOrigin, ORIGIN_VERSION};
use teamclu_types::skill_frontmatter::parse_frontmatter;

fn request(slug: &str) -> TeamSkillInstallRequest {
    TeamSkillInstallRequest {
        workspace_path: None,
        slug: slug.to_string(),
        team_id: Some("team-a".into()),
        download_url: String::new(),
        access_token: None,
        version: 3,
        owner: Some("张三".into()),
        category: Some("devops".into()),
        summary: Some("发布前检查清单".into()),
        when_to_use: Some("发布前确认 CI 绿、迁移已跑".into()),
        when_not_to_use: Some("不要用于本地开发\n不要用于 hotfix 流程".into()),
        requires: Some(vec!["macos".into()]),
        is_global: false,
        force: false,
        archive_unmanaged: false,
    }
}

fn rebaseline_request(slug: &str, version: i64) -> TeamSkillRebaselineRequest {
    TeamSkillRebaselineRequest {
        workspace_path: None,
        slug: slug.to_string(),
        team_id: Some("team-a".into()),
        version,
        owner: Some("张三".into()),
        category: Some("devops".into()),
        summary: Some("发布前检查清单".into()),
        when_to_use: Some("发布前确认 CI".into()),
        when_not_to_use: None,
        requires: None,
    }
}

fn set_active_team(team_id: &str) {
    let root = crate::commands::amuxd_home_dir();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("daemon.toml"),
        format!("active_team = \"{team_id}\"\n"),
    )
    .unwrap();
}

fn write_installed_skill(path: &std::path::Path, team_id: &str, version: i64) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("SKILL.md"), "---\nname: say-hello\n---\nhello\n").unwrap();
    stamp_installed_state(
        path,
        InstalledStamp {
            slug: "say-hello",
            version,
            team_id: Some(team_id),
            shipped: None,
        },
    )
    .unwrap();
}

#[test]
fn effective_copy_prefers_the_active_hosted_agent_projection() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");
    let member = global_skills_dir().unwrap().join("say-hello");
    let hosted = hosted_team_skills_dir("team-a").join("say-hello");
    write_installed_skill(&member, "team-a", 2);
    write_installed_skill(&hosted, "team-a", 2);

    let (resolved, source) = effective_team_skill_dir("say-hello", Some("team-a")).unwrap();
    assert_eq!(resolved, hosted);
    assert_eq!(source, EffectiveSkillSource::HostedAgent);
}

#[test]
fn inspection_and_rebaseline_use_the_same_hosted_copy() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");
    let member = global_skills_dir().unwrap().join("say-hello");
    let hosted = hosted_team_skills_dir("team-a").join("say-hello");
    write_installed_skill(&member, "team-a", 2);
    write_installed_skill(&hosted, "team-a", 2);
    std::fs::write(
        hosted.join("SKILL.md"),
        "---\nname: say-hello\n---\nhi, arya\n",
    )
    .unwrap();

    let before = inspect_team_skill("say-hello".into(), Some(2), Some("team-a".into()), None)
        .expect("inspect hosted edit");
    assert_eq!(before.state, "dirty");
    assert_eq!(before.source, "hosted-agent");
    assert_eq!(before.modified, vec!["SKILL.md"]);

    let result = team_skill_rebaseline_blocking(rebaseline_request("say-hello", 3))
        .expect("rebaseline hosted edit");
    assert_eq!(std::path::PathBuf::from(result.path), hosted);
    assert_eq!(read_origin(&hosted).unwrap().installed_version, "3");
    assert_eq!(installed_state(&hosted), DirtyState::Clean);
    assert_eq!(read_origin(&member).unwrap().installed_version, "2");
}

/// A workspace `opencode.json` carrying a decision about `deploy-check`.
fn workspace_with_permission(value: &str) -> tempfile::TempDir {
    let ws = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        ws.path().join("opencode.json"),
        serde_json::json!({
            "permission": { "bash": "ask", "skill": { "deploy-check": value, "other": "allow" } }
        })
        .to_string(),
    )
    .unwrap();
    ws
}

fn skill_permissions(ws: &std::path::Path) -> serde_json::Value {
    let raw = std::fs::read_to_string(ws.join("opencode.json")).unwrap();
    serde_json::from_str::<serde_json::Value>(&raw).unwrap()["permission"]["skill"].clone()
}

/// The whole reason this fix exists: a slug is reusable, so an approval that
/// outlives its pack ends up governing whatever content claims the name next.
#[test]
fn uninstall_forgets_the_skills_permission() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    let ws = workspace_with_permission("allow");
    std::fs::create_dir_all(global_skills_dir().unwrap().join("deploy-check")).unwrap();

    team_skill_uninstall_blocking(
        Some(ws.path().display().to_string()),
        "deploy-check".into(),
        Some(true),
    )
    .expect("uninstall");

    let skills = skill_permissions(ws.path());
    assert!(skills.get("deploy-check").is_none(), "the entry must go");
    // Only this skill's. The map is shared with every other skill in the
    // workspace, and with the non-skill defaults beside it.
    assert_eq!(skills["other"], "allow");
    let raw = std::fs::read_to_string(ws.path().join("opencode.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["permission"]["bash"], "ask");
}

/// The daemon watches this file and treats a permission write as "restart
/// the runtime". Uninstall runs unattended on every reconcile tick, so a
/// no-op rewrite would churn the agent for nothing.
#[test]
fn uninstall_leaves_the_config_untouched_when_there_is_no_entry() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    let ws = tempfile::tempdir().expect("tempdir");
    let config = ws.path().join("opencode.json");
    std::fs::write(
        &config,
        "{\"permission\":{\"skill\":{\"other\":\"allow\"}}}",
    )
    .unwrap();
    let before = std::fs::read_to_string(&config).unwrap();

    team_skill_uninstall_blocking(
        Some(ws.path().display().to_string()),
        "deploy-check".into(),
        Some(true),
    )
    .expect("uninstall");

    assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
}

/// No config, or one that is not JSON, is a normal state — the reconcile
/// calls this unattended and must not fail the removal over it.
#[test]
fn uninstall_survives_a_missing_or_unparseable_config() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());

    let bare = tempfile::tempdir().expect("tempdir");
    team_skill_uninstall_blocking(
        Some(bare.path().display().to_string()),
        "deploy-check".into(),
        Some(true),
    )
    .expect("uninstall with no config");

    let broken = tempfile::tempdir().expect("tempdir");
    std::fs::write(broken.path().join("opencode.json"), "{not json").unwrap();
    team_skill_uninstall_blocking(
        Some(broken.path().display().to_string()),
        "deploy-check".into(),
        Some(true),
    )
    .expect("uninstall with broken config");
}

#[test]
fn detects_presigned_storage_urls() {
    assert!(is_presigned_storage_url(
        "https://s3.example/bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=x&X-Amz-Signature=y"
    ));
    assert!(is_presigned_storage_url(
        "https://supabase.example/storage/v1/object/sign/team-skills/x?token=abc.def"
    ));
    assert!(!is_presigned_storage_url(
        "https://api.example/v1/teams/t/skills/s/versions/1/download"
    ));
}

#[test]
fn writes_structured_fields_and_keeps_the_body() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("deploy-check");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: deploy-check\ndescription: old blurb\n---\n# Deploy check\n\nsteps\n",
    )
    .unwrap();

    let wrote = write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
    assert!(wrote);

    let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
    let parsed = parse_frontmatter(&out);
    assert_eq!(parsed.string("category"), Some("devops"));
    assert_eq!(parsed.string("owner"), Some("张三"));
    // The multi-line field is the one the old regex parser could not carry.
    assert_eq!(
        parsed.string("when_not_to_use"),
        Some("不要用于本地开发\n不要用于 hotfix 流程")
    );
    assert_eq!(parsed.string("version"), Some("3"));
    assert_eq!(parsed.string("source"), Some("team"));
    // description tracks summary so pre-existing readers still see a blurb.
    assert_eq!(parsed.string("description"), Some("发布前检查清单"));
    assert_eq!(parsed.body, "# Deploy check\n\nsteps\n");
}

#[test]
fn a_package_without_skill_md_installs_but_reports_no_frontmatter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("empty");
    std::fs::create_dir_all(&skill).unwrap();
    assert!(!write_install_frontmatter(&skill, &request("empty")).unwrap());
}

#[test]
fn the_baseline_is_taken_after_the_frontmatter_rewrite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("deploy-check");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: deploy-check\ndescription: old blurb\n---\nbody\n",
    )
    .unwrap();

    // The real install order. Reversing these two lines is the bug this
    // test exists for: a baseline taken before the rewrite describes the
    // archive, not the disk, and every skill would be born in conflict.
    write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
    stamp_installed_state(
        &skill,
        InstalledStamp {
            slug: "deploy-check",
            version: 3,
            team_id: Some("team-a"),
            shipped: None,
        },
    )
    .unwrap();

    assert_eq!(installed_state(&skill), DirtyState::Clean);
    let origin = read_origin(&skill).expect("origin");
    assert_eq!(origin.installed_version, "3");
    assert_eq!(origin.registry, SOURCE_TEAM);
}

#[test]
fn an_edit_after_install_is_caught() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("deploy-check");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: deploy-check\n---\nbody\n",
    )
    .unwrap();
    write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
    stamp_installed_state(
        &skill,
        InstalledStamp {
            slug: "deploy-check",
            version: 3,
            team_id: Some("team-a"),
            shipped: None,
        },
    )
    .unwrap();

    let path = skill.join("SKILL.md");
    let edited = std::fs::read_to_string(&path).unwrap() + "\nmy own note\n";
    std::fs::write(&path, edited).unwrap();

    match installed_state(&skill) {
        DirtyState::Dirty {
            modified,
            deleted,
            added,
        } => {
            assert_eq!(modified, vec!["SKILL.md".to_string()]);
            assert!(deleted.is_empty());
            assert!(added.is_empty());
        }
        other => panic!("expected dirty, got {:?}", other),
    }
}

/// A file dropped into an installed pack is dirt, even though every file
/// the install laid down is untouched: publishing measures the whole
/// directory, so this one would ship with the next version.
#[test]
fn a_file_added_beside_the_pack_is_dirty() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("deploy-check");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: deploy-check\n---\nbody\n",
    )
    .unwrap();
    stamp_installed_state(
        &skill,
        InstalledStamp {
            slug: "deploy-check",
            version: 3,
            team_id: Some("team-a"),
            shipped: None,
        },
    )
    .unwrap();

    std::fs::write(skill.join("notes.md"), "mine\n").unwrap();

    match installed_state(&skill) {
        DirtyState::Dirty {
            modified,
            deleted,
            added,
        } => {
            assert!(modified.is_empty(), "nothing the install wrote changed");
            assert!(deleted.is_empty());
            assert_eq!(added, vec!["notes.md".to_string()]);
        }
        other => panic!("expected dirty, got {:?}", other),
    }
}

#[test]
fn empty_optional_fields_are_not_emitted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("bare");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: bare\n---\nbody\n").unwrap();

    let mut req = request("bare");
    req.owner = None;
    req.when_not_to_use = Some("   ".into());
    req.requires = Some(vec![]);
    write_install_frontmatter(&skill, &req).unwrap();

    let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
    let parsed = parse_frontmatter(&out);
    assert_eq!(parsed.string("owner"), None);
    assert_eq!(parsed.string("when_not_to_use"), None);
    assert!(parsed.data.get("requires").is_none());
}

fn trashed(trash: &std::path::Path, name: &str) -> std::path::PathBuf {
    let dir = trash.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "body\n").unwrap();
    dir
}

fn origin_for(team: Option<&str>) -> SkillOrigin {
    SkillOrigin {
        version: ORIGIN_VERSION,
        registry: SOURCE_TEAM.to_string(),
        slug: "deploy-check".into(),
        installed_version: "3".into(),
        installed_at: 1,
        team_id: team.map(str::to_owned),
        files: None,
    }
}

/// One flat root serves every team the user belongs to, and a slug names
/// exactly one directory — so two teams that both publish `deploy-check`
/// contend for the same one. With the team ignored the reconcile could not
/// see the contention: on differing version numbers it overwrote the other
/// team's bytes, and on matching ones — the common case, every team's
/// versions starting at 1 — it did nothing and left the runtime serving one
/// team's file as the other team's skill.
#[test]
fn a_pack_installed_for_another_team_is_not_ours() {
    assert!(belongs_to_another_team(
        &origin_for(Some("team-a")),
        Some("team-b")
    ));
    assert!(!belongs_to_another_team(
        &origin_for(Some("team-a")),
        Some("team-a")
    ));
}

/// Neither side knowing is not evidence either way, and guessing "somebody
/// else's" would strand every pack written before the field existed in a
/// conflict nobody can resolve.
#[test]
fn an_unrecorded_team_never_makes_a_pack_foreign() {
    assert!(!belongs_to_another_team(&origin_for(None), Some("team-b")));
    assert!(!belongs_to_another_team(&origin_for(Some("team-a")), None));
    assert!(!belongs_to_another_team(
        &origin_for(Some("team-a")),
        Some("  ")
    ));
}

#[test]
fn a_directory_with_no_team_record_is_not_claimed() {
    // A skill the user wrote straight into the skills root, colliding with
    // a team slug. Claiming it — writing a team record over it and calling
    // it clean at whatever version the server named — registered their
    // content as that team version, and auto-follow then saw nothing to do.
    // Reporting it as ours-is-not-here lets the install overwrite instead,
    // which is what the user asked for by installing.
    let dir = tempfile::tempdir().expect("tempdir");
    let skill = dir.path().join("hand-written");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "mine, not the team's\n").unwrap();

    assert_eq!(installed_state(&skill), DirtyState::Unmanaged);
    assert!(read_origin(&skill).is_none(), "nothing was written over it");
    // And the installer does not treat it as a local edit to protect, so an
    // install proceeds and overwrites what the package ships.
    assert!(!installed_state(&skill).is_dirty());
}

#[test]
fn a_real_backup_resolves() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let trash = tmp.path().join("trash");
    let backup = trashed(&trash, "deploy-check-1000");
    let resolved = resolve_trashed_source(&trash, backup.to_str().unwrap()).unwrap();
    assert_eq!(resolved, std::fs::canonicalize(&backup).unwrap());
}

#[test]
fn a_traversal_out_of_the_trash_is_refused() {
    // The lexical `starts_with` this replaced accepted exactly this path,
    // which made the restore a way to move any directory on the machine
    // into ~/.agents/skills.
    let tmp = tempfile::tempdir().expect("tempdir");
    let trash = tmp.path().join("trash");
    std::fs::create_dir_all(&trash).unwrap();
    let outside = tmp.path().join("not-trash");
    std::fs::create_dir_all(&outside).unwrap();

    let escape = trash.join("..").join("not-trash");
    assert!(escape.starts_with(&trash), "the lexical check still passes");
    assert!(resolve_trashed_source(&trash, escape.to_str().unwrap()).is_err());
}

#[test]
fn the_trash_root_itself_is_not_a_backup() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let trash = tmp.path().join("trash");
    std::fs::create_dir_all(&trash).unwrap();
    assert!(resolve_trashed_source(&trash, trash.to_str().unwrap()).is_err());
}

#[test]
fn pruning_keeps_the_recent_and_drops_the_stale() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let trash = tmp.path().join("trash");
    let now = now_millis();
    let fresh = trashed(&trash, &format!("fresh-{}", now - 1000));
    let old = trashed(&trash, &format!("old-{}", now - TRASH_TTL_MS - 1));
    // A name with no parsable timestamp is somebody else's business.
    let foreign = trashed(&trash, "not-ours");

    prune_trash(&trash);

    assert!(
        fresh.is_dir(),
        "a pack discarded seconds ago is still undoable"
    );
    assert!(!old.exists(), "a pack past the retention window is swept");
    assert!(foreign.is_dir());
}

#[test]
fn pruning_bounds_the_count_even_when_everything_is_fresh() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let trash = tmp.path().join("trash");
    let now = now_millis();
    // Discarded in one sitting, so the age bound never fires and only the
    // count can stop this directory from growing.
    let dirs: Vec<_> = (0..TRASH_MAX_ENTRIES + 5)
        .map(|i| trashed(&trash, &format!("skill-{}", now - i as u64)))
        .collect();

    prune_trash(&trash);

    let left = std::fs::read_dir(&trash).unwrap().count();
    assert_eq!(left, TRASH_MAX_ENTRIES);
    // The newest survive; the oldest five are the ones that went.
    assert!(dirs[0].is_dir());
    assert!(!dirs[TRASH_MAX_ENTRIES + 4].exists());
}

#[test]
fn cloud_api_client_builds() {
    build_cloud_api_client().expect("http1 + rustls client");
}

#[test]
fn restore_into_a_team_requires_a_matching_recovery_record() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");

    let source = global_skills_dir().unwrap().join("say-hello");
    write_installed_skill(&source, "team-a", 1);

    let trashed = team_skill_discard_local_blocking("say-hello".into(), Some("team-a".into()))
        .expect("discard writes recovery metadata");
    assert!(std::path::Path::new(&trashed)
        .join(".clawhub/recovery.json")
        .is_file());

    let restored = team_skill_restore_trashed_blocking(
        trashed.clone(),
        "say-hello".into(),
        Some("team-a".into()),
    )
    .expect("same team + slug restores");
    assert!(std::path::Path::new(&restored).is_dir());
}

#[test]
fn restore_into_a_team_rejects_missing_or_mismatched_recovery() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");

    let trash = trash_dir().unwrap();
    std::fs::create_dir_all(&trash).unwrap();
    // A second in the past, deliberately: `move_to_trash` names its own
    // destination `{slug}-{now_millis()}`, so on a runner fast enough to put
    // this line and the discard below in the same millisecond, that rename
    // would target this very directory and fail with ENOTEMPTY.
    let orphan = trash.join(format!("say-hello-{}", now_millis() - 1_000));
    write_installed_skill(&orphan, "team-a", 1);

    let err = team_skill_restore_trashed_blocking(
        orphan.display().to_string(),
        "say-hello".into(),
        Some("team-a".into()),
    )
    .expect_err("no recovery record");
    assert!(err.contains("no recovery record"), "{err}");

    let source = global_skills_dir().unwrap().join("say-hello");
    write_installed_skill(&source, "team-a", 1);
    let trashed = team_skill_discard_local_blocking("say-hello".into(), Some("team-a".into()))
        .expect("discard");

    let wrong_team = team_skill_restore_trashed_blocking(
        trashed.clone(),
        "say-hello".into(),
        Some("team-b".into()),
    )
    .expect_err("other team");
    assert!(wrong_team.contains("another team"), "{wrong_team}");

    let wrong_slug =
        team_skill_restore_trashed_blocking(trashed, "other-skill".into(), Some("team-a".into()))
            .expect_err("other slug");
    assert!(wrong_slug.contains("different skill"), "{wrong_slug}");
}

#[test]
fn discard_rolls_back_when_recovery_metadata_cannot_be_written() {
    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");

    let source = global_skills_dir().unwrap().join("blocked-recovery");
    write_installed_skill(&source, "team-a", 1);
    // `write_installed_skill` already created `.clawhub/` to hold origin.json,
    // so the blocker has to sit on the sidecar file itself: a directory where
    // `record_draft_recovery` must write `recovery.json` fails that write on
    // every platform, without the chmod dance the sibling test needs.
    std::fs::create_dir_all(source.join(".clawhub").join("recovery.json")).unwrap();

    let err = team_skill_discard_local_blocking("blocked-recovery".into(), Some("team-a".into()))
        .expect_err("sidecar write should fail");
    assert!(err.contains("recovery metadata"), "{err}");
    assert!(source.is_dir(), "skill restored to original location");

    let trash = trash_dir().unwrap();
    let orphan = std::fs::read_dir(&trash)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("blocked-recovery-")
        });
    assert!(!orphan, "no orphan trash entry after rollback");
}

#[test]
#[cfg(unix)]
fn discard_succeeds_when_recovery_log_append_fails() {
    use std::os::unix::fs::PermissionsExt;

    let home = tempfile::tempdir().expect("tempdir");
    let _home = crate::test_home::HomeGuard::set(home.path());
    set_active_team("team-a");

    let trash = trash_dir().unwrap();
    std::fs::create_dir_all(&trash).unwrap();
    let log = trash.join("recovery.jsonl");
    std::fs::write(&log, "existing\n").unwrap();
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o444)).unwrap();

    let source = global_skills_dir().unwrap().join("say-hello");
    write_installed_skill(&source, "team-a", 1);

    let trashed = team_skill_discard_local_blocking("say-hello".into(), Some("team-a".into()))
        .expect("sidecar success is enough");
    assert!(std::path::Path::new(&trashed)
        .join(".clawhub/recovery.json")
        .is_file());

    let listed = team_skill_list_draft_recoveries_blocking(
        Some("say-hello".into()),
        Some("team-a".into()),
        None,
    )
    .expect("list scans sidecars");
    assert!(listed.iter().any(|rec| rec.path == trashed));
}
