//! Read/write the local working copy of an installed team Skill.
//!
//! Agents edit drafts here; publishing is a separate Cloud API path. The
//! baseline in `.clawhub/origin.json` is preserved across draft writes so dirty
//! detection and auto-follow keep working.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use teamclu_skillpack::{
    inspect, read_origin, DirtyState, ORIGIN_DIR, SOURCE_TEAM, SkillOrigin,
};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::backend::TeamSkillRow;
use crate::runtime::team_skills::team_cloud_skills_dir;

use super::managed_skill_writer::{
    apply_delete_files, apply_patch_files, copy_pack_tree, pack_digest, publish_temp_dir,
    reject_symlink, validate_pack_tree_limits, verify_final_skill_md, ManagedSkillError,
    ManagedSkillErrorCode, RuntimeActivation, TempPackGuard, UpdatePackRequest,
    SKILL_MD,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectiveSkillSource {
    /// Legacy: drafts no longer target the cache.
    #[allow(dead_code)]
    HostedAgent,
    Member,
}

impl EffectiveSkillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HostedAgent => "hosted-agent",
            Self::Member => "member",
        }
    }
}

/// The working copy OpenCode and the Skills list must use: `~/.agents/skills`.
///
/// `cloud/skills` is a remote snapshot cache. Drafts, inspect, and publish
/// never write it.
pub fn effective_team_skill_dir(
    team_id: &str,
    slug: &str,
    home: &Path,
) -> (PathBuf, EffectiveSkillSource) {
    let _ = team_id;
    (
        home.join(".agents/skills").join(slug),
        EffectiveSkillSource::Member,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPackFile {
    pub path: String,
    pub content: String,
    /// `utf8` (default) or `base64` for non-text assets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDraftView {
    pub slug: String,
    pub base_version: i64,
    pub latest_version: i64,
    /// `clean` | `dirty` | `stale_dirty` | `foreign` | `missing`
    pub state: String,
    pub digest: String,
    pub content: String,
    pub files: Vec<DraftPackFile>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDraftUpdateResult {
    pub state: String,
    pub base_version: i64,
    pub runtime_activation: RuntimeActivation,
    pub publish_required: bool,
    pub digest: String,
}

fn io_err(e: std::io::Error) -> ManagedSkillError {
    ManagedSkillError::new(ManagedSkillErrorCode::SkillWriteFailed, e.to_string())
}

fn belongs_to_another_team(origin: &SkillOrigin, team_id: &str) -> bool {
    origin
        .team_id
        .as_deref()
        .zip(Some(team_id))
        .is_some_and(|(have, want)| have != want)
}

fn parse_base_version(origin: &SkillOrigin) -> Result<i64, ManagedSkillError> {
    origin.installed_version.parse::<i64>().map_err(|_| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillWriteFailed,
            "installed pack has invalid origin version",
        )
    })
}

fn compute_state(origin: Option<&SkillOrigin>, dirty: &DirtyState, latest_version: i64) -> String {
    let Some(origin) = origin else {
        return "missing".into();
    };
    if origin.registry != SOURCE_TEAM {
        return "foreign".into();
    }
    if origin.files.is_none() {
        return "missing".into();
    }
    let base = origin.installed_version.parse::<i64>().unwrap_or(0);
    match dirty {
        DirtyState::Unmanaged => "missing".into(),
        DirtyState::Clean => "clean".into(),
        DirtyState::Dirty { .. } => {
            if base > 0 && latest_version > base {
                "stale_dirty".into()
            } else {
                "dirty".into()
            }
        }
    }
}

fn compute_state_for_team(
    origin: Option<&SkillOrigin>,
    dirty: &DirtyState,
    latest_version: i64,
    team_id: &str,
) -> String {
    if let Some(origin) = origin {
        if origin.registry != SOURCE_TEAM {
            return "foreign".into();
        }
        if belongs_to_another_team(origin, team_id) {
            return "foreign".into();
        }
    }
    compute_state(origin, dirty, latest_version)
}

fn read_skill_md(target: &Path) -> Result<String, ManagedSkillError> {
    fs::read_to_string(target.join(SKILL_MD)).map_err(io_err)
}

fn list_pack_files(target: &Path) -> Result<Vec<DraftPackFile>, ManagedSkillError> {
    let mut out = Vec::new();
    for entry in WalkDir::new(target)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(target)
            .map_err(|_| io_err(std::io::Error::other("strip pack prefix")))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str == SKILL_MD {
            continue;
        }
        if rel_str.starts_with(&format!("{ORIGIN_DIR}/")) {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(io_err)?;
        let (content, encoding) = match String::from_utf8(bytes.clone()) {
            Ok(text) => (text, None),
            Err(_) => (
                base64::engine::general_purpose::STANDARD.encode(bytes),
                Some("base64".to_string()),
            ),
        };
        out.push(DraftPackFile {
            path: rel_str,
            content,
            encoding,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn ensure_writable_team_pack(
    target: &Path,
    slug: &str,
    team_id: &str,
    row: &TeamSkillRow,
) -> Result<(SkillOrigin, DirtyState), ManagedSkillError> {
    if !row.installed {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} is not installed for this agent"),
        ));
    }
    if !target.is_dir() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} working copy is missing"),
        ));
    }
    reject_symlink(target)?;
    let origin = read_origin(target).ok_or_else(|| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} has no install record"),
        )
    })?;
    if origin.registry != SOURCE_TEAM {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("skill {slug} belongs to another registry"),
        ));
    }
    if belongs_to_another_team(&origin, team_id) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("skill {slug} belongs to another team"),
        ));
    }
    if origin.slug != slug {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "origin slug does not match requested slug",
        ));
    }
    let baseline = origin.files.as_ref().ok_or_else(|| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} has no install baseline"),
        )
    })?;
    let dirty = inspect(target, Some(baseline));
    Ok((origin, dirty))
}

pub fn get_team_skill_draft(
    home: &Path,
    team_id: &str,
    row: &TeamSkillRow,
) -> Result<TeamSkillDraftView, ManagedSkillError> {
    let slug = row.slug.as_str();
    if !row.installed {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} is not installed for this agent"),
        ));
    }
    let (target, source) = effective_team_skill_dir(team_id, slug, home);
    let latest_version = if row.latest_version > 0 {
        row.latest_version
    } else {
        1
    };

    if !target.is_dir() {
        return Ok(TeamSkillDraftView {
            slug: slug.to_string(),
            base_version: 0,
            latest_version,
            state: "missing".into(),
            digest: String::new(),
            content: String::new(),
            files: Vec::new(),
            source: source.as_str().into(),
        });
    }

    reject_symlink(&target)?;
    let origin = read_origin(&target);
    let baseline = origin.as_ref().and_then(|o| o.files.as_ref());
    let dirty = inspect(&target, baseline);
    let state = compute_state_for_team(origin.as_ref(), &dirty, latest_version, team_id);

    if state == "missing" || state == "foreign" {
        return Ok(TeamSkillDraftView {
            slug: slug.to_string(),
            base_version: origin
                .as_ref()
                .and_then(|o| o.installed_version.parse().ok())
                .unwrap_or(0),
            latest_version,
            state,
            digest: String::new(),
            content: String::new(),
            files: Vec::new(),
            source: source.as_str().into(),
        });
    }

    let base_version = origin
        .as_ref()
        .map(parse_base_version)
        .transpose()?
        .unwrap_or(0);
    let digest = pack_digest(&target)?;
    let content = read_skill_md(&target)?;
    let files = list_pack_files(&target)?;

    Ok(TeamSkillDraftView {
        slug: slug.to_string(),
        base_version,
        latest_version,
        state,
        digest,
        content,
        files,
        source: source.as_str().into(),
    })
}

pub fn update_team_skill_draft(
    home: &Path,
    team_id: &str,
    row: &TeamSkillRow,
    req: &UpdatePackRequest,
) -> Result<TeamSkillDraftUpdateResult, ManagedSkillError> {
    if req.slug != row.slug {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillSlug,
            "slug in body must match URL slug",
        ));
    }

    let (target, _) = effective_team_skill_dir(team_id, &req.slug, home);
    let (origin, _dirty) = ensure_writable_team_pack(&target, &req.slug, team_id, row)?;
    let base_version = parse_base_version(&origin)?;

    let expected = req
        .expected_digest
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ManagedSkillError::new(
                ManagedSkillErrorCode::SkillChanged,
                "expectedDigest is required — call get_draft first",
            )
        })?;
    let current = pack_digest(&target)?;
    if current != expected {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillChanged,
            "skill digest does not match expectedDigest",
        ));
    }

    let parent = target
        .parent()
        .ok_or_else(|| ManagedSkillError::new(ManagedSkillErrorCode::SkillWriteFailed, "no parent"))?;
    let temp = TempPackGuard::new(parent.join(format!(".teamclu-draft-{}", Uuid::new_v4())));
    copy_pack_tree(&target, temp.path())?;
    fs::write(temp.path().join(SKILL_MD), req.content.as_bytes()).map_err(io_err)?;

    let mut patch_files = Vec::new();
    for file in &req.files {
        let rel = super::managed_skill_writer::normalize_pack_rel_path(&file.path)?;
        let bytes = super::managed_skill_writer::decode_pack_file(file)?;
        patch_files.push((rel, bytes));
    }
    apply_patch_files(temp.path(), &patch_files)?;
    apply_delete_files(temp.path(), &req.delete_files)?;
    verify_final_skill_md(temp.path(), &req.slug)?;
    validate_pack_tree_limits(temp.path())?;
    let digest = pack_digest(temp.path())?;

    let backup = parent.join(format!(".teamclu-backup-{}", Uuid::new_v4()));
    fs::rename(&target, &backup).map_err(io_err)?;
    if let Err(e) = publish_temp_dir(temp.path(), &target) {
        let _ = fs::rename(&backup, &target);
        return Err(e);
    }
    temp.disarm();
    let _ = fs::remove_dir_all(&backup);

    let latest_version = if row.latest_version > 0 {
        row.latest_version
    } else {
        1
    };
    let dirty = inspect(
        &target,
        read_origin(&target)
            .and_then(|o| o.files)
            .as_ref(),
    );
    let state = compute_state_for_team(
        read_origin(&target).as_ref(),
        &dirty,
        latest_version,
        team_id,
    );

    Ok(TeamSkillDraftUpdateResult {
        state,
        base_version,
        runtime_activation: RuntimeActivation::NextStart,
        publish_required: true,
        digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::managed_skill_writer::{ManagedSkillErrorCode, UpdatePackRequest};
    use teamclu_skillpack::{write_origin, ORIGIN_VERSION};

    fn write_skill(dir: &Path, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn stamp_team_origin(dir: &Path, slug: &str, team_id: &str, version: i64, files: bool) {
        use teamclu_skillpack::build_manifest;
        write_origin(
            dir,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_TEAM.to_string(),
                slug: slug.into(),
                installed_version: version.to_string(),
                installed_at: 1,
                team_id: Some(team_id.into()),
                files: if files {
                    Some(build_manifest(dir).unwrap())
                } else {
                    None
                },
            },
        )
        .unwrap();
    }

    fn row(slug: &str, latest: i64, installed: bool) -> TeamSkillRow {
        TeamSkillRow {
            slug: slug.into(),
            latest_version: latest,
            installed,
            ..Default::default()
        }
    }

    #[test]
    fn effective_path_is_always_the_member_working_copy() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let team = "team-a";
        let slug = "say-hello";
        let hosted = team_cloud_skills_dir(team).join(slug);
        let member = home.path().join(".agents/skills").join(slug);
        write_skill(&hosted, "---\nname: say-hello\ndescription: Hosted.\n---\n");
        write_skill(
            &member,
            "---\nname: say-hello\ndescription: Member.\n---\n",
        );

        let (path, source) = effective_team_skill_dir(team, slug, home.path());
        assert_eq!(source, EffectiveSkillSource::Member);
        assert_eq!(path, member);
    }

    #[test]
    fn update_draft_preserves_origin_baseline() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let team = "team-a";
        let slug = "demo-draft";
        let skill = home.path().join(".agents/skills").join(slug);
        write_skill(
            &skill,
            "---\nname: demo-draft\ndescription: One.\n---\n\n# Body\n",
        );
        stamp_team_origin(&skill, slug, team, 1, true);
        let digest = pack_digest(&skill).unwrap();

        let req = UpdatePackRequest {
            slug: slug.into(),
            content: "---\nname: demo-draft\ndescription: Two.\n---\n\n# Changed\n".into(),
            files: vec![],
            expected_digest: Some(digest),
            delete_files: vec![],
        };
        let result = update_team_skill_draft(home.path(), team, &row(slug, 1, true), &req).unwrap();
        assert_eq!(result.state, "dirty");
        assert!(result.publish_required);
        assert_eq!(result.base_version, 1);

        let origin = read_origin(&skill).unwrap();
        assert_eq!(origin.installed_version, "1");
        let baseline = origin.files.unwrap();
        let current = fs::read_to_string(skill.join("SKILL.md")).unwrap();
        assert!(current.contains("# Changed"));
        let dirty = inspect(&skill, Some(&baseline));
        assert!(dirty.is_dirty());
    }

    #[test]
    fn get_draft_returns_binary_files_as_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-bin";
        let slug = "with-asset";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: with-asset\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        fs::write(skill.join("logo.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let view = get_team_skill_draft(home, team, &row(slug, 1, true)).unwrap();
        let asset = view
            .files
            .iter()
            .find(|f| f.path == "logo.png")
            .expect("binary asset listed");
        assert_eq!(asset.encoding.as_deref(), Some("base64"));
        assert!(!asset.content.is_empty());
    }

    #[test]
    fn update_draft_requires_expected_digest() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-digest";
        let slug = "needs-digest";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: needs-digest\ndescription: One\n---\n\n# One\n",
        )
        .unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let req = UpdatePackRequest {
            slug: slug.into(),
            content: "---\nname: needs-digest\ndescription: Two\n---\n\n# Two\n".into(),
            files: vec![],
            expected_digest: None,
            delete_files: vec![],
        };
        let err = update_team_skill_draft(home, team, &row(slug, 1, true), &req).unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillChanged);
    }
}
