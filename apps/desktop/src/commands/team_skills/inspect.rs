//! Reading what is installed: the effective directory for a slug, and the
//! inspection the frontend renders (dirty state, origin, ownership).

use super::types::InstalledTeamSkill;
use super::types::TeamSkillInspectResult;
use crate::commands::clawhub::{global_skills_dir, validate_slug, SOURCE_TEAM};
use teamclu_skillpack::{inspect, read_origin, DirtyState, SkillOrigin};

#[tauri::command]
pub async fn team_skill_list_installed() -> Result<Vec<InstalledTeamSkill>, String> {
    tokio::task::spawn_blocking(team_skill_list_installed_blocking)
        .await
        .map_err(|e| format!("team_skill_list_installed task failed: {e}"))?
}

fn team_skill_list_installed_blocking() -> Result<Vec<InstalledTeamSkill>, String> {
    let skills = global_skills_dir()?;
    let Ok(entries) = std::fs::read_dir(&skills) else {
        return Ok(Vec::new());
    };

    let mut out: Vec<InstalledTeamSkill> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        match read_origin(&path) {
            Some(origin) if origin.registry == SOURCE_TEAM => {
                out.push(InstalledTeamSkill {
                    slug: slug.to_string(),
                    version: origin.installed_version,
                    team_id: origin.team_id,
                });
            }
            _ => {}
        }
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EffectiveSkillSource {
    HostedAgent,
    Member,
}

impl EffectiveSkillSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::HostedAgent => "hosted-agent",
            Self::Member => "member",
        }
    }
}

pub(super) fn hosted_team_skills_dir(team_id: &str) -> std::path::PathBuf {
    crate::commands::amuxd_team_state_dir(team_id)
        .join("cloud")
        .join("skills")
}

/// Resolve the copy OpenCode actually sees for this slug. The daemon registers
/// its hosted-Agent root before `~/.agents/skills`, so the first existing
/// directory wins. A cloud directory for another (non-active) team is ignored:
/// this desktop cannot be running it through the local daemon.
pub(super) fn effective_team_skill_dir(
    slug: &str,
    team_id: Option<&str>,
) -> Result<(std::path::PathBuf, EffectiveSkillSource), String> {
    let hosted = team_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| crate::commands::amuxd_active_team().as_deref() == Some(*id))
        .map(|id| hosted_team_skills_dir(id).join(slug));
    if let Some(path) = hosted.filter(|path| path.is_dir()) {
        return Ok((path, EffectiveSkillSource::HostedAgent));
    }
    Ok((
        global_skills_dir()?.join(slug),
        EffectiveSkillSource::Member,
    ))
}

/// Restore targets differ from reads: after a hosted copy was moved aside its
/// directory no longer exists, but undo must put it back into the higher-ranked
/// hosted root rather than silently restoring it as a member copy.
pub(super) fn preferred_team_skill_dir(
    slug: &str,
    team_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if let Some(id) = team_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| crate::commands::amuxd_active_team().as_deref() == Some(*id))
    {
        return Ok(hosted_team_skills_dir(id).join(slug));
    }
    Ok(global_skills_dir()?.join(slug))
}

/// Where the effective installed pack lives. The publish-a-new-version flow
/// packs this directory rather than a hardcoded member projection — after a
/// Hosted Agent edits its higher-priority cloud copy, that is the content the
/// team expects to ship.
#[tauri::command]
pub async fn team_skill_installed_dir(
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || team_skill_installed_dir_blocking(slug, team_id))
        .await
        .map_err(|e| format!("team_skill_installed_dir task failed: {e}"))?
}

fn team_skill_installed_dir_blocking(
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    Ok(effective_team_skill_dir(&slug, team_id.as_deref())?
        .0
        .display()
        .to_string())
}

/// Does this pack still look the way we installed it?
///
/// Three answers, and the distinctions matter more than the happy path:
///
/// **`foreign`** — the directory carries somebody else's `origin.json`
/// (ClawHub, the marketplace). Every registry installs into the same
/// `~/.agents/skills` root, so a slug collision is ordinary; stamping
/// `registry: "team"` over it would hand another registry's pack to this
/// reconcile loop, which would then overwrite it and later delete it. Report it
/// and touch nothing.
///
/// **`missing`** — no pack of ours here. Either the directory does not exist, or
/// it holds something with no team record: a skill the user wrote straight into
/// the skills root, or a pack from a build that recorded nothing. Both answer
/// the caller's real question the same way — there is nothing here we can prove
/// we installed — and the reconcile responds by installing, which overwrites the
/// files the package ships and leaves anything else in the directory alone.
///
/// This deliberately does **not** claim such a directory by writing a record
/// over it. Doing that used to report it `clean` at the version the server
/// happened to name, so a personal skill sitting at the pack's path was
/// registered as that team version and auto-follow saw nothing left to do —
/// content that was never the team's, pinned as the team's, permanently.
/// Whether an installed pack was laid down for a different team than the one
/// being reconciled.
///
/// An absent id on either side answers `false`: packs written before the field
/// existed carry none, and "I cannot tell whose this is" is not evidence that it
/// is somebody else's any more than it is evidence that it is ours.
pub(super) fn belongs_to_another_team(origin: &SkillOrigin, team_id: Option<&str>) -> bool {
    team_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .zip(origin.team_id.as_deref())
        .is_some_and(|(want, have)| want != have)
}

/// Compare an installed pack against its recorded baseline.
///
/// `async` + `spawn_blocking`: the comparison hashes every file in the pack,
/// and the callers run it for every installed slug on team switch and again
/// every ten minutes. Inline it ran on the main thread, so a team with a dozen
/// packs stalled the window for the whole loop.
#[tauri::command]
pub async fn team_skill_inspect(
    slug: String,
    expected_version: Option<i64>,
    team_id: Option<String>,
    registry_latest_version: Option<i64>,
) -> Result<TeamSkillInspectResult, String> {
    tokio::task::spawn_blocking(move || {
        inspect_team_skill(slug, expected_version, team_id, registry_latest_version)
    })
    .await
    .map_err(|e| format!("team_skill_inspect task failed: {e}"))?
}

pub(crate) fn inspect_team_skill(
    slug: String,
    expected_version: Option<i64>,
    team_id: Option<String>,
    registry_latest_version: Option<i64>,
) -> Result<TeamSkillInspectResult, String> {
    let _ = expected_version;
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let (target, source) = effective_team_skill_dir(&slug, team_id.as_deref())?;

    let missing = |slug: String| TeamSkillInspectResult {
        slug,
        state: "missing".to_string(),
        installed_version: None,
        modified: Vec::new(),
        deleted: Vec::new(),
        added: Vec::new(),
        source: source.as_str().to_string(),
    };

    if !target.exists() {
        return Ok(missing(slug));
    }

    let origin = read_origin(&target);

    // Another registry's pack, or another *team's*. Both mean the same thing to
    // every caller — "not ours to touch" — so both answer `foreign`.
    //
    // The team half matters because one flat root serves every team the user
    // belongs to and a slug can only name one directory. Two teams publishing
    // `deploy-check` therefore contend for `~/.agents/skills/deploy-check`, and
    // with the team ignored the reconcile could not see the contention: on
    // differing version numbers it overwrote the other team's bytes in place,
    // and on matching ones — the common case, since every team's versions start
    // at 1 — it did nothing at all and left the runtime serving one team's file
    // as the other team's skill. Reporting it stops auto-follow and puts the
    // collision on screen, which is not co-existence but is at least the truth.
    //
    // An absent `teamId` (packs from before the field existed) is not evidence
    // of anything and never makes a pack foreign.
    if let Some(origin) = origin
        .as_ref()
        .filter(|o| o.registry != SOURCE_TEAM || belongs_to_another_team(o, team_id.as_deref()))
    {
        return Ok(TeamSkillInspectResult {
            slug,
            state: "foreign".to_string(),
            installed_version: Some(origin.installed_version.clone()),
            modified: Vec::new(),
            deleted: Vec::new(),
            added: Vec::new(),
            source: source.as_str().to_string(),
        });
    }

    if origin.as_ref().and_then(|o| o.files.as_ref()).is_none() {
        return Ok(missing(slug));
    }

    let installed_version = origin.as_ref().map(|o| o.installed_version.clone());
    let base_version = installed_version
        .as_ref()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let registry_latest = registry_latest_version.unwrap_or(base_version);

    let baseline = origin.and_then(|o| o.files);
    match inspect(&target, baseline.as_ref()) {
        DirtyState::Dirty {
            modified,
            deleted,
            added,
        } => {
            let state = if registry_latest > base_version {
                "stale_dirty".to_string()
            } else {
                "dirty".to_string()
            };
            Ok(TeamSkillInspectResult {
                slug,
                state,
                installed_version,
                modified,
                deleted,
                added,
                source: source.as_str().to_string(),
            })
        }
        _ => Ok(TeamSkillInspectResult {
            slug,
            state: "clean".to_string(),
            installed_version,
            modified: Vec::new(),
            deleted: Vec::new(),
            added: Vec::new(),
            source: source.as_str().to_string(),
        }),
    }
}
