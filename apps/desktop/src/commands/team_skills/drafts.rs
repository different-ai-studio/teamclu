//! Draft metadata, discard/retire/restore, and forking a team skill to personal.

use super::frontmatter::scalar;
use super::frontmatter::FRONTMATTER_KEY_ORDER;
use super::inspect::effective_team_skill_dir;
use super::inspect::preferred_team_skill_dir;
use super::packfs::copy_dir_recursive;
use super::trash::draft_recovery_context;
use super::trash::load_draft_recovery_records;
use super::trash::move_to_trash;
use super::trash::recovery_record_for_path;
use super::trash::resolve_trashed_source;
use super::trash::trash_dir;
use super::types::DraftRecoveryRecord;
use super::types::TeamSkillDraftMetadata;
use crate::commands::clawhub::{global_skills_dir, validate_slug};
use teamclu_types::skill_frontmatter::{parse_frontmatter, write_frontmatter, FrontmatterValue};

/// Read structured metadata from the working copy's SKILL.md frontmatter.
#[tauri::command]
pub async fn team_skill_read_draft_metadata(
    slug: String,
    team_id: Option<String>,
) -> Result<TeamSkillDraftMetadata, String> {
    tokio::task::spawn_blocking(move || team_skill_read_draft_metadata_blocking(slug, team_id))
        .await
        .map_err(|e| format!("team_skill_read_draft_metadata task failed: {e}"))?
}

fn team_skill_read_draft_metadata_blocking(
    slug: String,
    team_id: Option<String>,
) -> Result<TeamSkillDraftMetadata, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let (target, _) = effective_team_skill_dir(&slug, team_id.as_deref())?;
    let skill_md = target.join("SKILL.md");
    if !skill_md.is_file() {
        return Ok(TeamSkillDraftMetadata {
            summary: None,
            category: None,
            when_to_use: None,
            when_not_to_use: None,
            requires: None,
        });
    }
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;
    let parsed = parse_frontmatter(&content);
    Ok(TeamSkillDraftMetadata {
        summary: parsed
            .present_string("description")
            .or_else(|| parsed.present_string("summary")),
        category: parsed.present_string("category"),
        when_to_use: parsed.present_string("when_to_use"),
        when_not_to_use: parsed.present_string("when_not_to_use"),
        requires: parsed.present_list("requires"),
    })
}

/// Recent draft recovery records (discarded packs moved to trash).
#[tauri::command]
pub async fn team_skill_list_draft_recoveries(
    slug: Option<String>,
    team_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DraftRecoveryRecord>, String> {
    tokio::task::spawn_blocking(move || {
        team_skill_list_draft_recoveries_blocking(slug, team_id, limit)
    })
    .await
    .map_err(|e| format!("team_skill_list_draft_recoveries task failed: {e}"))?
}

pub(super) fn team_skill_list_draft_recoveries_blocking(
    slug: Option<String>,
    team_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DraftRecoveryRecord>, String> {
    let trash = trash_dir()?;
    let cap = limit.unwrap_or(20).min(50);
    let slug_filter = slug.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let team_filter = team_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut out: Vec<DraftRecoveryRecord> = load_draft_recovery_records(&trash)
        .into_iter()
        .filter(|rec| slug_filter.is_none_or(|s| rec.slug == s))
        .filter(|rec| team_filter.is_none_or(|t| rec.team_id.as_deref() == Some(t)))
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.at));
    out.truncate(cap);
    Ok(out)
}

/// Move the installed pack aside so a clean copy can be laid down.
///
/// Returns the path it was moved to. Nothing is deleted: "discard my changes"
/// is the one action in the conflict UI that cannot be re-derived, so it gets
/// an undo instead of a confirmation dialog — the dialog interrupts everyone to
/// protect the rare misclick, the undo protects the misclick without
/// interrupting anyone.
#[tauri::command]
pub async fn team_skill_discard_local(
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || team_skill_discard_local_blocking(slug, team_id))
        .await
        .map_err(|e| format!("team_skill_discard_local task failed: {e}"))?
}

pub(super) fn team_skill_discard_local_blocking(
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let (target, _) = effective_team_skill_dir(&slug, team_id.as_deref())?;
    if !target.exists() {
        return Err(format!("{} is not installed", slug));
    }

    move_to_trash(
        &target,
        &slug,
        Some(draft_recovery_context(
            &target,
            "discard",
            team_id.as_deref(),
        )),
    )
}

/// Retire the personal original a skill was shared from.
///
/// Sharing copies the directory into the pack root and leaves the original
/// where it was, so the slug now exists twice and the two copies compete. The
/// pack root (`~/.agents/skills`) is rank 2 — ahead of every root but the
/// workspace's `.claude/skills` (daemon `skill_dir_specs`, desktop loader
/// `priorityOrder`) — so unless the original sat in that one root, the pack is
/// what agents load and what publish, dirty detection and diff all read.
/// Whichever copy loses, its author goes on editing a file nothing reads, and
/// nothing tells them so. One name, one file is the only version of this that
/// stays comprehensible.
///
/// Refuses rather than guesses in three cases: a source that resolves to the
/// pack itself (nothing to retire, and removing it would delete what was just
/// installed), a path outside the home directory, and a directory with no
/// `SKILL.md` — none of which is a personal skill this app put somewhere.
///
/// Goes to the trash, never `remove_dir_all`: the caller offers an undo.
#[tauri::command]
pub async fn team_skill_retire_personal(dir_path: String, slug: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || team_skill_retire_personal_blocking(dir_path, slug))
        .await
        .map_err(|e| format!("team_skill_retire_personal task failed: {e}"))?
}

fn team_skill_retire_personal_blocking(dir_path: String, slug: String) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let source = std::fs::canonicalize(dir_path.trim())
        .map_err(|_| "Personal skill directory not found".to_string())?;
    if !source.is_dir() || !source.join("SKILL.md").is_file() {
        return Err("Not a skill directory".to_string());
    }

    let pack = global_skills_dir()?.join(&slug);
    if std::fs::canonicalize(&pack)
        .map(|p| p == source)
        .unwrap_or(false)
    {
        return Err("The shared copy is the original; nothing to retire".to_string());
    }

    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    let home = std::fs::canonicalize(&home).unwrap_or(home);
    if !source.starts_with(&home) {
        return Err("Refusing to move a directory outside the home directory".to_string());
    }

    move_to_trash(&source, &slug, None)
}

/// Undo a discard. The trashed copy wins over whatever is installed now, which
/// is the point: the user asked for their edits back.
#[tauri::command]
pub async fn team_skill_restore_trashed(
    trashed_path: String,
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        team_skill_restore_trashed_blocking(trashed_path, slug, team_id)
    })
    .await
    .map_err(|e| format!("team_skill_restore_trashed task failed: {e}"))?
}

pub(super) fn team_skill_restore_trashed_blocking(
    trashed_path: String,
    slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let source = resolve_trashed_source(&trash_dir()?, trashed_path.trim())?;

    if let Some(expected_team) = team_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let rec = recovery_record_for_path(&source).ok_or_else(|| {
            "This backup has no recovery record and cannot be restored into a team skill"
                .to_string()
        })?;
        match rec.team_id.as_deref() {
            Some(rec_team) if rec_team == expected_team => {}
            Some(_) => {
                return Err(
                    "This recovery belongs to another team and cannot be restored here".to_string(),
                );
            }
            None => {
                return Err(
                    "This recovery has no team context and cannot be restored here".to_string(),
                );
            }
        }
        if rec.slug != slug {
            return Err("This recovery belongs to a different skill".to_string());
        }
    }

    let target = preferred_team_skill_dir(&slug, team_id.as_deref())?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create skill root: {}", e))?;
    }
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to clear skill dir: {}", e))?;
    }
    std::fs::rename(&source, &target).map_err(|e| format!("Failed to restore skill: {}", e))?;
    Ok(target.display().to_string())
}

/// Copy the edited pack out to a personal skill under a new slug.
///
/// The rename is mandatory, not a nicety: local skills outrank team skills in
/// the loader's source priority, so a fork keeping the original slug would
/// shadow the team copy and quietly cancel the auto-follow it was supposed to
/// let the user keep.
#[tauri::command]
pub async fn team_skill_fork(
    slug: String,
    new_slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || team_skill_fork_blocking(slug, new_slug, team_id))
        .await
        .map_err(|e| format!("team_skill_fork task failed: {e}"))?
}

fn team_skill_fork_blocking(
    slug: String,
    new_slug: String,
    team_id: Option<String>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    let new_slug = new_slug.trim().to_string();
    validate_slug(&slug)?;
    validate_slug(&new_slug)?;
    if slug == new_slug {
        return Err("A fork needs a different slug".to_string());
    }

    let skills = global_skills_dir()?;
    let (source, _) = effective_team_skill_dir(&slug, team_id.as_deref())?;
    if !source.is_dir() {
        return Err(format!("{} is not installed", slug));
    }
    let target = skills.join(&new_slug);
    if target.exists() {
        return Err(format!("{} already exists", new_slug));
    }
    copy_dir_recursive(&source, &target)?;

    // The copy is nobody's package now: drop the registry bookkeeping so it is
    // never mistaken for something the reconcile loop should manage.
    let origin_dir = target.join(teamclu_skillpack::ORIGIN_DIR);
    if origin_dir.exists() {
        std::fs::remove_dir_all(&origin_dir)
            .map_err(|e| format!("Failed to clear fork bookkeeping: {}", e))?;
    }

    let skill_md = target.join("SKILL.md");
    if skill_md.is_file() {
        let content = std::fs::read_to_string(&skill_md)
            .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;
        let updates: Vec<(&str, Option<FrontmatterValue>)> = vec![
            ("name", scalar(&new_slug)),
            ("version", None),
            ("source", None),
        ];
        let out = write_frontmatter(&content, &updates, FRONTMATTER_KEY_ORDER);
        std::fs::write(&skill_md, out).map_err(|e| format!("Failed to write SKILL.md: {}", e))?;
    }

    Ok(target.display().to_string())
}
