//! Read/write the local working copy of an installed team Skill.
//!
//! Agents edit drafts here; publishing is a separate Cloud API path. The
//! baseline in `.clawhub/origin.json` is preserved across draft writes so dirty
//! detection and auto-follow keep working.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use teamclu_skillpack::{
    build_package_index, inspect, read_origin, DirtyState, SkillOrigin, ORIGIN_DIR, SOURCE_TEAM,
};
use uuid::Uuid;

use crate::backend::TeamSkillRow;
use crate::runtime::team_skills::team_cloud_skills_dir;

use super::managed_skill_writer::{
    apply_delete_files, apply_patch_files, copy_pack_tree, normalize_pack_rel_path, pack_digest,
    publish_temp_dir, reject_symlink, validate_pack_tree_limits, verify_final_skill_md,
    ManagedSkillError, ManagedSkillErrorCode, RuntimeActivation, TempPackGuard, UpdatePackRequest,
    MAX_PACK_FILES, MAX_SINGLE_FILE_BYTES, SKILL_MD,
};

/// Serialized `get_draft` JSON must stay inside this budget (model context).
pub(crate) const GET_DRAFT_MAX_JSON_BYTES: usize = 64 * 1024;
pub(crate) const READ_DRAFT_FILE_DEFAULT_BYTES: usize = 16 * 1024;
pub(crate) const READ_DRAFT_FILE_MAX_BYTES: usize = 32 * 1024;

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
    /// Sidecar bodies are never inlined on `get_draft`. Use `read_draft_file`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content: String,
    /// `utf8` (default) or `base64` for non-text assets — only on `read_draft_file`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    /// Present when this file cannot be published (`too_large` / `too_many`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
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
    pub file_count: usize,
    pub ignored_count: usize,
    pub total_bytes: u64,
    /// True when SKILL.md or file listing was dropped to stay under the JSON budget.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Publish/update_draft will reject this working copy when non-empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFileRead {
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content: String,
    pub size: u64,
    pub offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    pub complete: bool,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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

fn sha256_hex(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn empty_draft_view(
    slug: &str,
    base_version: i64,
    latest_version: i64,
    state: String,
    source: String,
) -> TeamSkillDraftView {
    TeamSkillDraftView {
        slug: slug.to_string(),
        base_version,
        latest_version,
        state,
        digest: String::new(),
        content: String::new(),
        files: Vec::new(),
        source,
        file_count: 0,
        ignored_count: 0,
        total_bytes: 0,
        truncated: false,
        warnings: Vec::new(),
    }
}

fn read_skill_md(target: &Path) -> Result<(String, Option<String>), ManagedSkillError> {
    let path = target.join(SKILL_MD);
    let len = fs::metadata(&path).map_err(io_err)?.len();
    if len as usize > MAX_SINGLE_FILE_BYTES {
        return Ok((
            String::new(),
            Some(format!(
                "SKILL.md exceeds size limit ({len} bytes > {MAX_SINGLE_FILE_BYTES}); publish will be rejected. Use read_draft_file with path {SKILL_MD}"
            )),
        ));
    }
    if len as usize > GET_DRAFT_MAX_JSON_BYTES {
        return Ok((
            String::new(),
            Some(format!(
                "SKILL.md omitted from get_draft ({len} bytes > response budget); use read_draft_file with path {SKILL_MD}"
            )),
        ));
    }
    Ok((fs::read_to_string(path).map_err(io_err)?, None))
}

struct ListedPackFile {
    rel: String,
    size: u64,
}

fn collect_pack_file_entries(
    target: &Path,
) -> Result<(Vec<ListedPackFile>, usize), ManagedSkillError> {
    let index = build_package_index(target).map_err(io_err)?;
    let mut files = Vec::new();
    for rel in index.included {
        if rel == SKILL_MD {
            continue;
        }
        let path = target.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let size = fs::metadata(&path).map_err(io_err)?.len();
        files.push(ListedPackFile { rel, size });
    }
    Ok((files, index.ignored.len()))
}

fn list_pack_files(
    target: &Path,
) -> Result<(Vec<DraftPackFile>, Vec<String>, u64, usize), ManagedSkillError> {
    let (entries, ignored_count) = collect_pack_file_entries(target)?;
    let mut warnings = Vec::new();
    let total_sidecar_bytes: u64 = entries.iter().map(|e| e.size).sum();
    if entries.len() + 1 > MAX_PACK_FILES {
        warnings.push(format!(
            "pack has {} files (limit {MAX_PACK_FILES}); publish will be rejected",
            entries.len() + 1
        ));
    }
    if ignored_count > 0 {
        warnings.push(format!(
            "{ignored_count} files excluded from the publish pack by ignore rules"
        ));
    }

    let mut out = Vec::with_capacity(entries.len());
    for entry in &entries {
        let too_large = entry.size as usize > MAX_SINGLE_FILE_BYTES;
        out.push(DraftPackFile {
            path: entry.rel.clone(),
            content: String::new(),
            encoding: None,
            omitted: too_large.then(|| "too_large".into()),
            size: Some(entry.size),
            hint: too_large.then(|| {
                format!(
                    "use read_draft_file with path {} (publish will reject this file)",
                    entry.rel
                )
            }),
        });
    }
    Ok((out, warnings, total_sidecar_bytes, ignored_count))
}

fn serialized_draft_len(view: &TeamSkillDraftView) -> usize {
    serde_json::to_vec(view)
        .map(|v| v.len())
        .unwrap_or(usize::MAX)
}

fn fit_draft_view(mut view: TeamSkillDraftView) -> TeamSkillDraftView {
    if serialized_draft_len(&view) <= GET_DRAFT_MAX_JSON_BYTES {
        return view;
    }
    view.truncated = true;
    if !view.content.is_empty() {
        let len = view.content.len();
        view.content.clear();
        view.warnings.push(format!(
            "SKILL.md omitted from get_draft ({len} bytes > response budget); use read_draft_file with path {SKILL_MD}"
        ));
        if serialized_draft_len(&view) <= GET_DRAFT_MAX_JSON_BYTES {
            return view;
        }
    }
    let mut dropped = 0usize;
    while serialized_draft_len(&view) > GET_DRAFT_MAX_JSON_BYTES && !view.files.is_empty() {
        view.files.pop();
        dropped += 1;
    }
    if dropped > 0 {
        let msg = format!(
            "{dropped} file listing entries omitted to stay under get_draft response budget; use read_draft_file with a specific path"
        );
        if let Some(last) = view
            .warnings
            .iter_mut()
            .find(|w| w.contains("file listing entries omitted"))
        {
            *last = msg;
        } else {
            view.warnings.push(msg);
        }
        while serialized_draft_len(&view) > GET_DRAFT_MAX_JSON_BYTES && !view.files.is_empty() {
            view.files.pop();
            dropped += 1;
            if let Some(last) = view
                .warnings
                .iter_mut()
                .find(|w| w.contains("file listing entries omitted"))
            {
                *last = format!(
                    "{dropped} file listing entries omitted to stay under get_draft response budget; use read_draft_file with a specific path"
                );
            }
        }
    }
    view
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
        return Ok(empty_draft_view(
            slug,
            0,
            latest_version,
            "missing".into(),
            source.as_str().into(),
        ));
    }

    reject_symlink(&target)?;
    let origin = read_origin(&target);
    let baseline = origin.as_ref().and_then(|o| o.files.as_ref());
    let dirty = inspect(&target, baseline);
    let state = compute_state_for_team(origin.as_ref(), &dirty, latest_version, team_id);

    if state == "missing" || state == "foreign" {
        return Ok(empty_draft_view(
            slug,
            origin
                .as_ref()
                .and_then(|o| o.installed_version.parse().ok())
                .unwrap_or(0),
            latest_version,
            state,
            source.as_str().into(),
        ));
    }

    let base_version = origin
        .as_ref()
        .map(parse_base_version)
        .transpose()?
        .unwrap_or(0);
    let digest = pack_digest(&target)?;
    let (content, skill_warning) = read_skill_md(&target)?;
    let truncated_skill = skill_warning
        .as_ref()
        .is_some_and(|w| w.contains("response budget"));
    let (files, mut warnings, sidecar_bytes, ignored_count) = list_pack_files(&target)?;
    if let Some(warning) = skill_warning {
        warnings.push(warning);
    }
    if let Err(err) = validate_pack_tree_limits(&target) {
        warnings.push(format!("this draft cannot be published: {}", err.message));
    }
    let skill_md_len = fs::metadata(target.join(SKILL_MD))
        .map(|m| m.len())
        .unwrap_or(0);
    let file_count = files.len() + 1;
    let total_bytes = skill_md_len.saturating_add(sidecar_bytes);

    Ok(fit_draft_view(TeamSkillDraftView {
        slug: slug.to_string(),
        base_version,
        latest_version,
        state,
        digest,
        content,
        files,
        source: source.as_str().into(),
        file_count,
        ignored_count,
        total_bytes,
        truncated: truncated_skill,
        warnings,
    }))
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

    if req.content.is_empty() && req.files.is_empty() && req.delete_files.is_empty() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "update_draft requires at least one of content, files, or deleteFiles",
        ));
    }

    let parent = target.parent().ok_or_else(|| {
        ManagedSkillError::new(ManagedSkillErrorCode::SkillWriteFailed, "no parent")
    })?;
    let temp = TempPackGuard::new(parent.join(format!(".teamclu-draft-{}", Uuid::new_v4())));
    copy_pack_tree(&target, temp.path())?;
    if !req.content.is_empty() {
        fs::write(temp.path().join(SKILL_MD), req.content.as_bytes()).map_err(io_err)?;
    }

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
    let dirty = inspect(&target, read_origin(&target).and_then(|o| o.files).as_ref());
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

fn normalize_draft_read_path(raw: &str) -> Result<PathBuf, ManagedSkillError> {
    let trimmed = raw.trim();
    if trimmed == SKILL_MD {
        return Ok(PathBuf::from(SKILL_MD));
    }
    let rel = normalize_pack_rel_path(trimmed)?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str == ORIGIN_DIR || rel_str.starts_with(&format!("{ORIGIN_DIR}/")) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "origin metadata is not readable via read_draft_file",
        ));
    }
    Ok(rel)
}

fn utf8_chunk(bytes: &[u8], offset: usize, limit: usize) -> (String, usize, bool) {
    if offset >= bytes.len() {
        return (String::new(), bytes.len(), true);
    }
    let mut start = offset;
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }
    if start >= bytes.len() {
        return (String::new(), bytes.len(), true);
    }
    let mut end = start.saturating_add(limit).min(bytes.len());
    if end < bytes.len() {
        while end > start && (bytes[end] & 0xc0) == 0x80 {
            end -= 1;
        }
    }
    if end == start && start < bytes.len() {
        end = start + 1;
        while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
            end += 1;
        }
    }
    let chunk = bytes[start..end].to_vec();
    let content = String::from_utf8(chunk).unwrap_or_default();
    (content, end, end >= bytes.len())
}

pub fn read_team_skill_draft_file(
    home: &Path,
    team_id: &str,
    row: &TeamSkillRow,
    path: &str,
    offset: u64,
    limit: Option<usize>,
) -> Result<DraftFileRead, ManagedSkillError> {
    let slug = row.slug.as_str();
    if !row.installed {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} is not installed for this agent"),
        ));
    }
    let (target, _) = effective_team_skill_dir(team_id, slug, home);
    if !target.is_dir() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} working copy is missing"),
        ));
    }
    reject_symlink(&target)?;
    let origin = read_origin(&target).ok_or_else(|| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("team skill {slug} has no install record"),
        )
    })?;
    if origin.registry != SOURCE_TEAM || belongs_to_another_team(&origin, team_id) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("skill {slug} is not this team's working copy"),
        ));
    }

    let rel = normalize_draft_read_path(path)?;
    let abs = target.join(&rel);
    reject_symlink(&abs)?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if !abs.is_file() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("file {rel_str} not found in draft"),
        ));
    }
    let bytes = fs::read(&abs).map_err(io_err)?;
    let digest = sha256_hex(&bytes);
    let size = bytes.len() as u64;
    let limit = limit
        .filter(|n| *n > 0)
        .unwrap_or(READ_DRAFT_FILE_DEFAULT_BYTES)
        .min(READ_DRAFT_FILE_MAX_BYTES);
    let offset = offset as usize;

    match std::str::from_utf8(&bytes) {
        Ok(_) => {
            let (content, end, complete) = utf8_chunk(&bytes, offset, limit);
            Ok(DraftFileRead {
                path: rel_str,
                content,
                size,
                offset: offset as u64,
                next_offset: (!complete).then_some(end as u64),
                complete,
                digest,
                encoding: None,
                omitted: None,
                warnings: Vec::new(),
            })
        }
        Err(_) => Ok(DraftFileRead {
            path: rel_str,
            content: String::new(),
            size,
            offset: 0,
            next_offset: None,
            complete: true,
            digest,
            encoding: Some("binary".into()),
            omitted: Some("binary".into()),
            warnings: vec!["binary files are not inlined; inspect them on disk".into()],
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::managed_skill_writer::{
        ManagedSkillErrorCode, PackFileInput, UpdatePackRequest, MAX_SINGLE_FILE_BYTES,
    };
    use super::*;
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
        write_skill(&member, "---\nname: say-hello\ndescription: Member.\n---\n");

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
    fn get_draft_lists_sidecars_without_bodies() {
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
        fs::write(skill.join("notes.md"), "# keep me\n").unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let view = get_team_skill_draft(home, team, &row(slug, 1, true)).unwrap();
        assert!(view.content.contains("# Demo"));
        assert_eq!(view.file_count, 3);
        let encoded = serde_json::to_vec(&view).unwrap();
        assert!(
            encoded.len() <= GET_DRAFT_MAX_JSON_BYTES,
            "get_draft JSON was {} bytes",
            encoded.len()
        );
        let asset = view
            .files
            .iter()
            .find(|f| f.path == "logo.png")
            .expect("binary asset listed");
        assert!(asset.content.is_empty());
        assert_eq!(asset.encoding, None);
        assert_eq!(asset.size, Some(4));
        let notes = view
            .files
            .iter()
            .find(|f| f.path == "notes.md")
            .expect("text sidecar listed");
        assert!(notes.content.is_empty());
        assert!(!notes.content.contains("keep me"));
    }

    #[test]
    fn get_draft_never_inlines_sidecar_bodies() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-big";
        let slug = "issue-investigator";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: issue-investigator\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        let dump_size = 6 * 1024 * 1024;
        assert!(dump_size > MAX_SINGLE_FILE_BYTES);
        fs::write(skill.join("dump.txt"), vec![b'x'; dump_size]).unwrap();
        for i in 0..3 {
            fs::write(skill.join(format!("chunk-{i}.txt")), vec![b'y'; 400_000]).unwrap();
        }
        stamp_team_origin(&skill, slug, team, 1, true);

        let view = get_team_skill_draft(home, team, &row(slug, 1, true)).unwrap();
        assert!(
            view.files.iter().all(|f| f.content.is_empty()),
            "get_draft must not inline sidecar bodies"
        );
        let dump = view
            .files
            .iter()
            .find(|f| f.path == "dump.txt")
            .expect("oversized sidecar listed");
        assert_eq!(dump.omitted.as_deref(), Some("too_large"));
        assert_eq!(dump.size, Some(dump_size as u64));
        assert!(
            view.warnings
                .iter()
                .any(|w| w.contains("dump.txt") || w.contains("cannot be published")),
            "expected a publish-will-fail warning, got {:?}",
            view.warnings
        );
        let encoded = serde_json::to_vec(&view).unwrap();
        assert!(encoded.len() <= GET_DRAFT_MAX_JSON_BYTES);
    }

    #[test]
    fn get_draft_omits_skill_md_when_json_budget_exceeded() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-budget";
        let slug = "fat-skill";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(&skill).unwrap();
        let mut skill_md = String::from("---\nname: fat-skill\ndescription: Demo 中文\n---\n\n");
        skill_md.push_str(&"字".repeat(40_000));
        fs::write(skill.join("SKILL.md"), &skill_md).unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let view = get_team_skill_draft(home, team, &row(slug, 1, true)).unwrap();
        assert!(
            view.content.is_empty(),
            "oversized SKILL.md must not be inlined"
        );
        assert!(view.truncated);
        assert!(
            view.warnings
                .iter()
                .any(|w| w.contains("read_draft_file") && w.contains("SKILL.md")),
            "expected read_draft_file hint, got {:?}",
            view.warnings
        );
        let encoded = serde_json::to_vec(&view).unwrap();
        assert!(encoded.len() <= GET_DRAFT_MAX_JSON_BYTES);
        let read = read_team_skill_draft_file(home, team, &row(slug, 1, true), "SKILL.md", 0, None)
            .unwrap();
        assert!(read.content.contains("name: fat-skill"));
        assert!(!read.complete);
        assert!(read.content.len() <= READ_DRAFT_FILE_DEFAULT_BYTES);
        assert!(read.content.is_char_boundary(read.content.len()));
    }

    #[test]
    fn read_draft_file_chunks_utf8_and_skips_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-read";
        let slug = "chunked";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: chunked\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        let body = "é".repeat(20_000);
        fs::write(skill.join("scripts/run.py"), &body).unwrap();
        fs::write(skill.join("logo.png"), [0x89, 0x50, 0x4e, 0x47, 0x0d]).unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let first =
            read_team_skill_draft_file(home, team, &row(slug, 1, true), "scripts/run.py", 0, None)
                .unwrap();
        assert_eq!(first.offset, 0);
        assert!(!first.complete);
        assert_eq!(
            first.next_offset,
            Some(READ_DRAFT_FILE_DEFAULT_BYTES as u64)
        );
        assert!(first.content.is_char_boundary(first.content.len()));

        let second = read_team_skill_draft_file(
            home,
            team,
            &row(slug, 1, true),
            "scripts/run.py",
            first.next_offset.unwrap(),
            Some(READ_DRAFT_FILE_MAX_BYTES + 8),
        )
        .unwrap();
        assert!(second.content.len() <= READ_DRAFT_FILE_MAX_BYTES);
        assert!(second.complete);

        let bin = read_team_skill_draft_file(home, team, &row(slug, 1, true), "logo.png", 0, None)
            .unwrap();
        assert!(bin.content.is_empty());
        assert_eq!(bin.omitted.as_deref(), Some("binary"));
        assert_eq!(bin.encoding.as_deref(), Some("binary"));
    }

    #[test]
    fn update_draft_can_patch_sidecar_without_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-patch";
        let slug = "patch-one";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: patch-one\ndescription: One\n---\n\n# One\n",
        )
        .unwrap();
        fs::write(skill.join("scripts/run.py"), "print(1)\n").unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);
        let digest = pack_digest(&skill).unwrap();

        let req = UpdatePackRequest {
            slug: slug.into(),
            content: String::new(),
            files: vec![PackFileInput {
                path: "scripts/run.py".into(),
                content: "print(2)\n".into(),
                encoding: None,
            }],
            expected_digest: Some(digest),
            delete_files: vec![],
        };
        update_team_skill_draft(home, team, &row(slug, 1, true), &req).unwrap();
        assert!(fs::read_to_string(skill.join("SKILL.md"))
            .unwrap()
            .contains("# One"));
        assert_eq!(
            fs::read_to_string(skill.join("scripts/run.py")).unwrap(),
            "print(2)\n"
        );
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

    #[test]
    fn update_pack_request_deserializes_without_content() {
        let req: UpdatePackRequest = serde_json::from_value(serde_json::json!({
            "slug": "demo",
            "files": [{ "path": "notes.md", "content": "hi" }],
            "expectedDigest": "sha256:abc"
        }))
        .unwrap();
        assert!(req.content.is_empty());
        assert_eq!(req.files.len(), 1);
        assert_eq!(req.expected_digest.as_deref(), Some("sha256:abc"));
    }

    #[test]
    fn read_draft_file_rejects_missing_and_origin() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let team = "team-read";
        let slug = "guarded";
        let skill = home.join(".agents/skills").join(slug);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: guarded\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        stamp_team_origin(&skill, slug, team, 1, true);

        let missing =
            read_team_skill_draft_file(home, team, &row(slug, 1, true), "nope.md", 0, None)
                .unwrap_err();
        assert_eq!(missing.code, ManagedSkillErrorCode::SkillNotFound);

        let origin = read_team_skill_draft_file(
            home,
            team,
            &row(slug, 1, true),
            ".clawhub/origin.json",
            0,
            None,
        )
        .unwrap_err();
        assert_eq!(origin.code, ManagedSkillErrorCode::InvalidSkillFilePath);
    }
}
