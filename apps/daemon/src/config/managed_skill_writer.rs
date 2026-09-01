//! Backend-neutral personal skill pack writer for `~/.agents/skills`.
//!
//! Used by the daemon `skills-manage` control socket and agent-facing MCP
//! create/update. The settings UI upsert keeps its frontmatter-compat behavior
//! in `upsert_skill` until that path is migrated here.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use base64::Engine as _;
use teamclu_skillpack::manifest::build_manifest;
use teamclu_types::skill_frontmatter::parse_frontmatter;
use uuid::Uuid;

use super::roles_skills::is_inherent_skill;

const GLOBAL_SKILLS_REL: &str = ".agents/skills";
pub(crate) const SKILL_MD: &str = "SKILL.md";
const MAX_PACK_FILES: usize = 500;
const MAX_SINGLE_FILE_BYTES: usize = 1024 * 1024;
const MAX_PACK_TOTAL_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedSkillErrorCode {
    InvalidSkillSlug,
    InvalidSkillFrontmatter,
    InvalidSkillFilePath,
    SkillAlreadyExists,
    TeamSkillReadOnly,
    BuiltinSkillReadOnly,
    SkillChanged,
    SkillNotFound,
    SkillPackTooLarge,
    SkillWriteFailed,
    SkillOwnershipUnavailable,
    SkillRefreshFailed,
}

impl ManagedSkillErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSkillSlug => "invalid_skill_slug",
            Self::InvalidSkillFrontmatter => "invalid_skill_frontmatter",
            Self::InvalidSkillFilePath => "invalid_skill_file_path",
            Self::SkillAlreadyExists => "skill_already_exists",
            Self::TeamSkillReadOnly => "team_skill_read_only",
            Self::BuiltinSkillReadOnly => "builtin_skill_read_only",
            Self::SkillChanged => "skill_changed",
            Self::SkillNotFound => "skill_not_found",
            Self::SkillPackTooLarge => "skill_pack_too_large",
            Self::SkillWriteFailed => "skill_write_failed",
            Self::SkillOwnershipUnavailable => "skill_ownership_unavailable",
            Self::SkillRefreshFailed => "skill_refresh_failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillError {
    pub code: ManagedSkillErrorCode,
    pub message: String,
}

impl ManagedSkillError {
    pub(crate) fn new(code: ManagedSkillErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileInput {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePackRequest {
    pub slug: String,
    pub content: String,
    #[serde(default)]
    pub files: Vec<PackFileInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackRequest {
    pub slug: String,
    pub content: String,
    #[serde(default)]
    pub files: Vec<PackFileInput>,
    #[serde(default)]
    pub expected_digest: Option<String>,
    /// Relative paths under the skill root to remove explicitly.
    #[serde(default)]
    pub delete_files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeActivation {
    CurrentRuntime,
    NextStart,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageSkillResponse {
    pub slug: String,
    pub path: String,
    pub source: String,
    pub created: bool,
    pub runtime_activation: RuntimeActivation,
    pub digest: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub fn global_skills_root(home: &Path) -> PathBuf {
    home.join(GLOBAL_SKILLS_REL)
}

/// Result of querying which team registry slugs are installed for this agent.
#[derive(Debug, Clone)]
pub enum ClaimedTeamContext {
    /// Daemon is unclaimed or has no team id — only builtin protection applies.
    NoTeam,
    Known(BTreeSet<String>),
    /// Backend query failed; callers must fail closed when mutating existing packs.
    Unavailable,
}

impl ClaimedTeamContext {
    pub fn check_update(&self, slug: &str) -> Result<(), ManagedSkillError> {
        match self {
            Self::Unavailable => Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillOwnershipUnavailable,
                "team skill ownership could not be verified; update refused",
            )),
            Self::Known(claimed) if claimed.contains(slug) => Err(ManagedSkillError::new(
                ManagedSkillErrorCode::TeamSkillReadOnly,
                "team-managed skills are read-only here",
            )),
            _ => Ok(()),
        }
    }
}

pub fn pack_digest(dir: &Path) -> Result<String, ManagedSkillError> {
    let manifest = build_manifest(dir).map_err(|e| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillWriteFailed,
            format!("manifest: {e}"),
        )
    })?;
    let json = serde_json::to_string(&manifest).map_err(|e| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::SkillWriteFailed,
            format!("manifest encode: {e}"),
        )
    })?;
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(json.as_bytes());
    Ok(format!("sha256:{:x}", hash))
}

fn io_managed(e: std::io::Error) -> ManagedSkillError {
    ManagedSkillError::new(ManagedSkillErrorCode::SkillWriteFailed, e.to_string())
}

fn is_valid_slug(slug: &str) -> bool {
    if slug.is_empty() {
        return false;
    }
    let mut chars = slug.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() || !first.is_ascii_alphanumeric() {
        return false;
    }
    let mut prev_hyphen = false;
    for c in chars {
        if c == '-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
            continue;
        }
        prev_hyphen = false;
        if !c.is_ascii_lowercase() && !c.is_ascii_digit() {
            return false;
        }
    }
    !slug.ends_with('-')
}

fn validate_strict_frontmatter(content: &str, slug: &str) -> Result<(), ManagedSkillError> {
    let parsed = parse_frontmatter(content);
    if !parsed.has_frontmatter {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFrontmatter,
            "SKILL.md must begin with a closed YAML frontmatter block",
        ));
    }
    let name = parsed.string("name").ok_or_else(|| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFrontmatter,
            "frontmatter must include a non-empty name",
        )
    })?;
    if name != slug {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFrontmatter,
            format!("frontmatter name {name:?} must match slug {slug:?}"),
        ));
    }
    parsed.string("description").ok_or_else(|| {
        ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFrontmatter,
            "frontmatter must include a non-empty description",
        )
    })?;
    Ok(())
}

pub(crate) fn normalize_pack_rel_path(raw: &str) -> Result<PathBuf, ManagedSkillError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "pack file path must not be empty",
        ));
    }
    if trimmed.contains('\\') {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "pack file paths must use forward slashes",
        ));
    }
    let path = Path::new(trimmed);
    let mut normalized = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(seg) => normalized.push(seg),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ManagedSkillError::new(
                    ManagedSkillErrorCode::InvalidSkillFilePath,
                    format!("unsafe pack path {raw:?}"),
                ));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "pack file path must not be empty",
        ));
    }
    if normalized == Path::new(SKILL_MD) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "pack files must not overwrite SKILL.md; pass it as content",
        ));
    }
    Ok(normalized)
}

pub(crate) fn decode_pack_file(input: &PackFileInput) -> Result<Vec<u8>, ManagedSkillError> {
    let encoding = input.encoding.as_deref().unwrap_or("utf8");
    match encoding {
        "utf8" => Ok(input.content.as_bytes().to_vec()),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(input.content.trim())
            .map_err(|e| {
                ManagedSkillError::new(
                    ManagedSkillErrorCode::InvalidSkillFilePath,
                    format!("invalid base64 file content: {e}"),
                )
            }),
        other => Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("unsupported file encoding {other:?}; use utf8 or base64"),
        )),
    }
}

pub(crate) fn reject_symlink(path: &Path) -> Result<(), ManagedSkillError> {
    if path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("symlinks are not allowed in skill packs: {}", path.display()),
        ));
    }
    Ok(())
}

fn verify_tree_confined(root: &Path) -> Result<(), ManagedSkillError> {
    reject_symlink(root)?;
    if !root.is_dir() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillWriteFailed,
            "pack root is not a directory",
        ));
    }
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        let path = entry.path();
        reject_symlink(path)?;
        if !path.starts_with(root) {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                "pack path escapes skill root",
            ));
        }
    }
    Ok(())
}

/// Validates size and file-count limits on the final on-disk pack tree.
pub(crate) fn validate_pack_tree_limits(root: &Path) -> Result<(), ManagedSkillError> {
    verify_tree_confined(root)?;
    let mut file_count = 0usize;
    let mut total_bytes = 0usize;
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|e| io_managed(std::io::Error::other(e.to_string())))?;
        if !entry.file_type().is_file() {
            continue;
        }
        file_count += 1;
        if file_count > MAX_PACK_FILES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                "skill pack exceeds file count limit",
            ));
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| io_managed(std::io::Error::other("strip pack prefix")))?;
        let len = entry
            .metadata()
            .map_err(|e| io_managed(std::io::Error::other(e.to_string())))?
            .len()
            .try_into()
            .unwrap_or(usize::MAX);
        if len > MAX_SINGLE_FILE_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                format!("file {} exceeds size limit", rel.display()),
            ));
        }
        total_bytes = total_bytes.saturating_add(len);
        if total_bytes > MAX_PACK_TOTAL_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                "skill pack exceeds total size limit",
            ));
        }
    }
    Ok(())
}

struct PackBuild {
    skill_md: String,
    files: Vec<(PathBuf, Vec<u8>)>,
}

fn build_pack_inputs(
    slug: &str,
    content: &str,
    extra: &[PackFileInput],
) -> Result<PackBuild, ManagedSkillError> {
    if !is_valid_slug(slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillSlug,
            format!("invalid slug {slug:?}"),
        ));
    }
    validate_strict_frontmatter(content, slug)?;
    let skill_md = content.to_string();

    let mut files = Vec::new();
    let mut total_bytes = skill_md.len();
    if total_bytes > MAX_SINGLE_FILE_BYTES {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillPackTooLarge,
            "SKILL.md exceeds size limit",
        ));
    }
    for file in extra {
        let rel = normalize_pack_rel_path(&file.path)?;
        if files.iter().any(|(existing, _)| existing == &rel) {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                format!("duplicate pack file path {}", rel.display()),
            ));
        }
        let bytes = decode_pack_file(file)?;
        if bytes.len() > MAX_SINGLE_FILE_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                format!("file {} exceeds size limit", rel.display()),
            ));
        }
        total_bytes += bytes.len();
        if total_bytes > MAX_PACK_TOTAL_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                "skill pack exceeds total size limit",
            ));
        }
        files.push((rel, bytes));
    }
    if files.len() + 1 > MAX_PACK_FILES {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillPackTooLarge,
            "skill pack exceeds file count limit",
        ));
    }
    Ok(PackBuild { skill_md, files })
}

fn write_temp_pack(root: &Path, build: &PackBuild) -> Result<(), ManagedSkillError> {
    fs::create_dir_all(root).map_err(io_managed)?;
    reject_symlink(root)?;
    fs::write(root.join(SKILL_MD), build.skill_md.as_bytes()).map_err(io_managed)?;
    for (rel, bytes) in &build.files {
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(io_managed)?;
        }
        fs::write(&dest, bytes).map_err(io_managed)?;
    }
    Ok(())
}

pub(crate) struct TempPackGuard(PathBuf);

impl TempPackGuard {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn disarm(mut self) {
        self.0 = PathBuf::new();
    }
}

impl Drop for TempPackGuard {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

pub(crate) fn copy_pack_tree(src: &Path, dst: &Path) -> Result<(), ManagedSkillError> {
    reject_symlink(src)?;
    for entry in walkdir::WalkDir::new(src)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|e| io_managed(std::io::Error::other(e.to_string())))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|_| io_managed(std::io::Error::other("strip pack prefix")))?;
        if rel.as_os_str().is_empty() {
            fs::create_dir_all(dst).map_err(io_managed)?;
            continue;
        }
        reject_symlink(entry.path())?;
        let target_path = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target_path).map_err(io_managed)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(io_managed)?;
            }
            fs::copy(entry.path(), &target_path).map_err(io_managed)?;
        }
    }
    Ok(())
}

pub(crate) fn verify_final_skill_md(root: &Path, slug: &str) -> Result<(), ManagedSkillError> {
    let content = fs::read_to_string(root.join(SKILL_MD)).map_err(io_managed)?;
    validate_strict_frontmatter(&content, slug)
}

pub(crate) fn apply_patch_files(
    root: &Path,
    files: &[(PathBuf, Vec<u8>)],
) -> Result<(), ManagedSkillError> {
    for (rel, bytes) in files {
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(io_managed)?;
        }
        fs::write(&dest, bytes).map_err(io_managed)?;
    }
    Ok(())
}

pub(crate) fn apply_delete_files(
    root: &Path,
    delete_files: &[String],
) -> Result<(), ManagedSkillError> {
    for raw in delete_files {
        let rel = normalize_pack_rel_path(raw)?;
        let path = root.join(&rel);
        if !path.starts_with(root) {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                format!("delete path escapes skill root: {raw:?}"),
            ));
        }
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(io_managed)?;
        } else if path.is_file() {
            fs::remove_file(&path).map_err(io_managed)?;
        }
    }
    Ok(())
}

fn classify_existing_target(
    target: &Path,
    ownership: &ClaimedTeamContext,
) -> Result<(), ManagedSkillError> {
    if !target.exists() {
        return Ok(());
    }
    reject_symlink(target)?;
    let slug = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if is_inherent_skill(slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::BuiltinSkillReadOnly,
            format!("built-in skill {slug} cannot be overwritten"),
        ));
    }
    if matches!(ownership, ClaimedTeamContext::Unavailable) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillOwnershipUnavailable,
            "team skill ownership could not be verified; create refused for existing skill",
        ));
    }
    if let ClaimedTeamContext::Known(claimed) = ownership {
        if claimed.contains(slug) {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::TeamSkillReadOnly,
                format!("team-managed skill {slug} cannot be overwritten"),
            ));
        }
    }
    Err(ManagedSkillError::new(
        ManagedSkillErrorCode::SkillAlreadyExists,
        format!("skill {slug} already exists and was not overwritten"),
    ))
}

pub(crate) fn publish_temp_dir(temp: &Path, target: &Path) -> Result<(), ManagedSkillError> {
    match fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillAlreadyExists,
            "skill already exists and was not overwritten",
        )),
        Err(e) => Err(io_managed(e)),
    }
}

pub fn create_pack(
    _workspace_path: &Path,
    home: &Path,
    req: &CreatePackRequest,
    ownership: &ClaimedTeamContext,
) -> Result<ManageSkillResponse, ManagedSkillError> {
    let build = build_pack_inputs(&req.slug, &req.content, &req.files)?;
    let skills_root = global_skills_root(home);
    fs::create_dir_all(&skills_root).map_err(io_managed)?;
    let target = skills_root.join(&req.slug);
    classify_existing_target(&target, ownership)?;

    let temp = TempPackGuard::new(skills_root.join(format!(".teamclu-create-{}", Uuid::new_v4())));
    write_temp_pack(temp.path(), &build)?;
    verify_final_skill_md(temp.path(), &req.slug)?;
    validate_pack_tree_limits(temp.path())?;
    let digest = pack_digest(temp.path())?;
    publish_temp_dir(temp.path(), &target)?;
    temp.disarm();

    Ok(ManageSkillResponse {
        slug: req.slug.clone(),
        path: target.to_string_lossy().into_owned(),
        source: "global-agent".into(),
        created: true,
        runtime_activation: RuntimeActivation::NextStart,
        digest,
        warnings: if parse_frontmatter(&build.skill_md).body.trim().is_empty() {
            vec!["SKILL.md body is empty".into()]
        } else {
            vec![]
        },
    })
}

pub fn update_pack(
    _workspace_path: &Path,
    home: &Path,
    req: &UpdatePackRequest,
    ownership: &ClaimedTeamContext,
) -> Result<ManageSkillResponse, ManagedSkillError> {
    if !is_valid_slug(&req.slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillSlug,
            format!("invalid slug {:?}", req.slug),
        ));
    }
    validate_strict_frontmatter(&req.content, &req.slug)?;
    if req.content.len() > MAX_SINGLE_FILE_BYTES {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillPackTooLarge,
            "SKILL.md exceeds size limit",
        ));
    }

    let mut patch_files = Vec::new();
    let mut total_bytes = req.content.len();
    for file in &req.files {
        let rel = normalize_pack_rel_path(&file.path)?;
        if patch_files.iter().any(|(existing, _)| existing == &rel) {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                format!("duplicate pack file path {}", rel.display()),
            ));
        }
        let bytes = decode_pack_file(file)?;
        if bytes.len() > MAX_SINGLE_FILE_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                format!("file {} exceeds size limit", rel.display()),
            ));
        }
        total_bytes += bytes.len();
        if total_bytes > MAX_PACK_TOTAL_BYTES {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillPackTooLarge,
                "skill pack exceeds total size limit",
            ));
        }
        patch_files.push((rel, bytes));
    }

    let skills_root = global_skills_root(home);
    let target = skills_root.join(&req.slug);
    if !target.is_dir() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("skill {} not found", req.slug),
        ));
    }
    reject_symlink(&target)?;
    if is_inherent_skill(&req.slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::BuiltinSkillReadOnly,
            "built-in skills are read-only",
        ));
    }
    ownership.check_update(&req.slug)?;
    if let Some(expected) = req.expected_digest.as_deref().filter(|v| !v.is_empty()) {
        let current = pack_digest(&target)?;
        if current != expected {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillChanged,
                "skill digest does not match expectedDigest",
            ));
        }
    }

    let temp = TempPackGuard::new(skills_root.join(format!(".teamclu-update-{}", Uuid::new_v4())));
    copy_pack_tree(&target, temp.path())?;
    fs::write(temp.path().join(SKILL_MD), req.content.as_bytes()).map_err(io_managed)?;
    apply_patch_files(temp.path(), &patch_files)?;
    apply_delete_files(temp.path(), &req.delete_files)?;
    verify_final_skill_md(temp.path(), &req.slug)?;
    validate_pack_tree_limits(temp.path())?;
    let digest = pack_digest(temp.path())?;
    let backup = skills_root.join(format!(".teamclu-backup-{}", Uuid::new_v4()));
    fs::rename(&target, &backup).map_err(io_managed)?;
    if let Err(e) = publish_temp_dir(temp.path(), &target) {
        let _ = fs::rename(&backup, &target);
        return Err(e);
    }
    temp.disarm();
    let _ = fs::remove_dir_all(&backup);

    Ok(ManageSkillResponse {
        slug: req.slug.clone(),
        path: target.to_string_lossy().into_owned(),
        source: "global-agent".into(),
        created: false,
        runtime_activation: RuntimeActivation::NextStart,
        digest,
        warnings: vec![],
    })
}

pub fn get_pack(home: &Path, slug: &str) -> Result<ManageSkillResponse, ManagedSkillError> {
    if !is_valid_slug(slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillSlug,
            format!("invalid slug {slug:?}"),
        ));
    }
    let target = global_skills_root(home).join(slug);
    if !target.is_dir() {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::SkillNotFound,
            format!("skill {slug} not found"),
        ));
    }
    reject_symlink(&target)?;
    let digest = pack_digest(&target)?;
    Ok(ManageSkillResponse {
        slug: slug.to_owned(),
        path: target.to_string_lossy().into_owned(),
        source: "global-agent".into(),
        created: false,
        runtime_activation: RuntimeActivation::NextStart,
        digest,
        warnings: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn update_request_deserializes_delete_files_camel_case() {
        let payload = serde_json::json!({
            "slug": "demo",
            "content": "---\nname: demo\ndescription: Demo.\n---\n",
            "deleteFiles": ["references/old.md"]
        });
        let req: UpdatePackRequest = serde_json::from_value(payload).unwrap();
        assert_eq!(req.delete_files, vec!["references/old.md".to_string()]);
    }

    #[test]
    fn slug_validation_accepts_and_rejects() {
        assert!(is_valid_slug("api-review"));
        assert!(is_valid_slug("v2-check"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("API"));
        assert!(!is_valid_slug("a/b"));
        assert!(!is_valid_slug("-bad"));
        assert!(!is_valid_slug("bad-"));
        assert!(!is_valid_slug("a--b"));
    }

    #[test]
    fn create_pack_writes_global_agent_skill() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let req = CreatePackRequest {
            slug: "demo-skill".into(),
            content: "---\nname: demo-skill\ndescription: Demo.\n---\n\n# Demo\n".into(),
            files: vec![PackFileInput {
                path: "references/checklist.md".into(),
                content: "# Checklist\n".into(),
                encoding: None,
            }],
        };
        let resp = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        assert!(resp.created);
        assert!(home
            .path()
            .join(".agents/skills/demo-skill/SKILL.md")
            .is_file());
        assert!(resp.digest.starts_with("sha256:"));
    }

    #[test]
    fn create_rejects_existing_personal_skill() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let req = CreatePackRequest {
            slug: "dup".into(),
            content: "---\nname: dup\ndescription: One.\n---\n".into(),
            files: vec![],
        };
        create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        let err = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillAlreadyExists);
    }

    #[test]
    fn rejects_dot_slash_skill_md_in_pack_files() {
        for raw in [
            "SKILL.md",
            "./SKILL.md",
            "foo/../SKILL.md",
            "../SKILL.md",
            "/absolute/SKILL.md",
        ] {
            let err = normalize_pack_rel_path(raw).unwrap_err();
            assert_eq!(
                err.code,
                ManagedSkillErrorCode::InvalidSkillFilePath,
                "expected rejection for {raw:?}"
            );
        }
    }

    #[test]
    fn create_rejects_invalid_pack_path_without_publishing() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let req = CreatePackRequest {
            slug: "bad-path".into(),
            content: "---\nname: bad-path\ndescription: One.\n---\n".into(),
            files: vec![PackFileInput {
                path: "./SKILL.md".into(),
                content: "no frontmatter".into(),
                encoding: None,
            }],
        };
        let err = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::InvalidSkillFilePath);
        assert!(!home.path().join(".agents/skills/bad-path").exists());
    }

    #[test]
    fn update_rejects_team_skill_read_only() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let skill_root = home.path().join(".agents/skills/deploy-check");
        fs::create_dir_all(&skill_root).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: deploy-check\ndescription: Team.\n---\n",
        )
        .unwrap();
        fs::create_dir_all(skill_root.join("scripts")).unwrap();
        fs::write(skill_root.join("scripts/check.sh"), "#!/bin/sh\n").unwrap();

        let update = UpdatePackRequest {
            slug: "deploy-check".into(),
            content: "---\nname: deploy-check\ndescription: Nope.\n---\n".into(),
            files: vec![],
            expected_digest: None,
            delete_files: vec![],
        };
        let mut claimed = BTreeSet::new();
        claimed.insert("deploy-check".into());
        let err = update_pack(
            ws.path(),
            home.path(),
            &update,
            &ClaimedTeamContext::Known(claimed),
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::TeamSkillReadOnly);
        let skill_md = fs::read_to_string(skill_root.join("SKILL.md")).unwrap();
        assert!(skill_md.contains("Team."));
        assert!(skill_root.join("scripts/check.sh").is_file());
    }

    #[test]
    fn update_patches_single_resource_file() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let create = CreatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Demo.\n---\n\n# Demo\n".into(),
            files: vec![
                PackFileInput {
                    path: "scripts/check.sh".into(),
                    content: "v1\n".into(),
                    encoding: None,
                },
                PackFileInput {
                    path: "references/checklist.md".into(),
                    content: "unchanged\n".into(),
                    encoding: None,
                },
            ],
        };
        create_pack(
            ws.path(),
            home.path(),
            &create,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let update = UpdatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Demo.\n---\n\n# Demo\n".into(),
            files: vec![PackFileInput {
                path: "scripts/check.sh".into(),
                content: "v2\n".into(),
                encoding: None,
            }],
            expected_digest: None,
            delete_files: vec![],
        };
        update_pack(
            ws.path(),
            home.path(),
            &update,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let root = home.path().join(".agents/skills/api-review");
        assert_eq!(fs::read_to_string(root.join("scripts/check.sh")).unwrap(), "v2\n");
        assert_eq!(
            fs::read_to_string(root.join("references/checklist.md")).unwrap(),
            "unchanged\n"
        );
    }

    #[test]
    fn update_delete_files_removes_only_requested() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let create = CreatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Demo.\n---\n\n# Demo\n".into(),
            files: vec![
                PackFileInput {
                    path: "scripts/check.sh".into(),
                    content: "#!/bin/sh\n".into(),
                    encoding: None,
                },
                PackFileInput {
                    path: "references/checklist.md".into(),
                    content: "# Checklist\n".into(),
                    encoding: None,
                },
                PackFileInput {
                    path: "assets/template.json".into(),
                    content: "{}\n".into(),
                    encoding: None,
                },
            ],
        };
        create_pack(
            ws.path(),
            home.path(),
            &create,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let update = UpdatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Updated.\n---\n\n# Updated\n".into(),
            files: vec![],
            expected_digest: None,
            delete_files: vec!["references/checklist.md".into()],
        };
        update_pack(
            ws.path(),
            home.path(),
            &update,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let root = home.path().join(".agents/skills/api-review");
        assert!(root.join("scripts/check.sh").is_file());
        assert!(!root.join("references/checklist.md").exists());
        assert!(root.join("assets/template.json").is_file());
    }

    #[test]
    fn update_preserves_unmentioned_resource_files() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let create = CreatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Demo.\n---\n\n# Demo\n".into(),
            files: vec![
                PackFileInput {
                    path: "scripts/check.sh".into(),
                    content: "#!/bin/sh\n".into(),
                    encoding: None,
                },
                PackFileInput {
                    path: "references/checklist.md".into(),
                    content: "# Checklist\n".into(),
                    encoding: None,
                },
            ],
        };
        create_pack(
            ws.path(),
            home.path(),
            &create,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let update = UpdatePackRequest {
            slug: "api-review".into(),
            content: "---\nname: api-review\ndescription: Updated.\n---\n\n# Updated\n".into(),
            files: vec![],
            expected_digest: None,
            delete_files: vec![],
        };
        update_pack(
            ws.path(),
            home.path(),
            &update,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let root = home.path().join(".agents/skills/api-review");
        assert!(root.join("scripts/check.sh").is_file());
        assert!(root.join("references/checklist.md").is_file());
        let skill_md = fs::read_to_string(root.join("SKILL.md")).unwrap();
        assert!(skill_md.contains("Updated."));
    }

    #[test]
    fn update_refuses_when_team_ownership_unavailable() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let create = CreatePackRequest {
            slug: "deploy-check".into(),
            content: "---\nname: deploy-check\ndescription: One.\n---\n".into(),
            files: vec![],
        };
        create_pack(
            ws.path(),
            home.path(),
            &create,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        let original = fs::read_to_string(
            home.path()
                .join(".agents/skills/deploy-check/SKILL.md"),
        )
        .unwrap();

        let update = UpdatePackRequest {
            slug: "deploy-check".into(),
            content: "---\nname: deploy-check\ndescription: Nope.\n---\n".into(),
            files: vec![],
            expected_digest: None,
            delete_files: vec![],
        };
        let err = update_pack(
            ws.path(),
            home.path(),
            &update,
            &ClaimedTeamContext::Unavailable,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillOwnershipUnavailable);
        let after = fs::read_to_string(
            home.path()
                .join(".agents/skills/deploy-check/SKILL.md"),
        )
        .unwrap();
        assert_eq!(after, original);
    }

    #[test]
    fn create_existing_refuses_when_team_ownership_unavailable() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let req = CreatePackRequest {
            slug: "existing".into(),
            content: "---\nname: existing\ndescription: One.\n---\n".into(),
            files: vec![],
        };
        create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        let err = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::Unavailable,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillOwnershipUnavailable);
    }

    fn test_skill_md(slug: &str) -> String {
        format!("---\nname: {slug}\ndescription: Demo.\n---\n")
    }

    fn blob(size: usize) -> String {
        "x".repeat(size)
    }

    fn pack_files(prefix: &str, count: usize, size: usize) -> Vec<PackFileInput> {
        (0..count)
            .map(|i| PackFileInput {
                path: format!("assets/{prefix}-{i}.bin"),
                content: blob(size),
                encoding: None,
            })
            .collect()
    }

    fn assert_no_update_temp_dirs(skills_root: &Path) {
        let entries = fs::read_dir(skills_root).unwrap();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.starts_with(".teamclu-update-"),
                "unexpected temp dir: {name}"
            );
        }
    }

    #[test]
    fn update_rejects_oversized_skill_md() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "big-md".into(),
                content: test_skill_md("big-md"),
                files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let before = get_pack(home.path(), "big-md").unwrap();
        let oversized = format!(
            "{}\n{}",
            test_skill_md("big-md"),
            blob(MAX_SINGLE_FILE_BYTES)
        );
        let err = update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "big-md".into(),
                content: oversized,
                files: vec![],
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillPackTooLarge);
        assert_eq!(get_pack(home.path(), "big-md").unwrap().digest, before.digest);
        assert_no_update_temp_dirs(&home.path().join(".agents/skills"));
    }

    #[test]
    fn update_rejects_when_final_file_count_exceeds_limit() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "many-files".into(),
                content: test_skill_md("many-files"),
                files: vec![PackFileInput {
                    path: "assets/seed.bin".into(),
                    content: "seed".into(),
                    encoding: None,
                }],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let before = get_pack(home.path(), "many-files").unwrap();
        let err = update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "many-files".into(),
                content: test_skill_md("many-files"),
                files: pack_files("bulk", MAX_PACK_FILES - 1, 1),
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillPackTooLarge);
        assert_eq!(get_pack(home.path(), "many-files").unwrap().digest, before.digest);
        assert_no_update_temp_dirs(&home.path().join(".agents/skills"));
    }

    #[test]
    fn update_rejects_when_retained_plus_new_exceeds_total_size() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let chunk = MAX_SINGLE_FILE_BYTES - 512;
        create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "heavy".into(),
                content: test_skill_md("heavy"),
                files: pack_files("base", 3, chunk),
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let before = get_pack(home.path(), "heavy").unwrap();
        let err = update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "heavy".into(),
                content: test_skill_md("heavy"),
                files: pack_files("extra", 3, chunk),
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillPackTooLarge);
        assert_eq!(get_pack(home.path(), "heavy").unwrap().digest, before.digest);
        assert_no_update_temp_dirs(&home.path().join(".agents/skills"));
    }

    #[test]
    fn cumulative_updates_reject_when_final_pack_exceeds_limit() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let chunk = MAX_SINGLE_FILE_BYTES - 512;
        create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "grow".into(),
                content: test_skill_md("grow"),
                files: pack_files("seed", 3, chunk),
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "grow".into(),
                content: test_skill_md("grow"),
                files: pack_files("step", 2, chunk),
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let before = get_pack(home.path(), "grow").unwrap();
        let err = update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "grow".into(),
                content: test_skill_md("grow"),
                files: pack_files("final", 1, chunk),
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillPackTooLarge);
        assert_eq!(get_pack(home.path(), "grow").unwrap().digest, before.digest);
    }

    #[test]
    fn delete_files_frees_capacity_for_legal_update() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let chunk = MAX_SINGLE_FILE_BYTES - 512;
        create_pack(
            ws.path(),
            home.path(),
            &CreatePackRequest {
                slug: "trim".into(),
                content: test_skill_md("trim"),
                files: pack_files("base", 4, chunk),
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "trim".into(),
                content: test_skill_md("trim"),
                files: vec![],
                expected_digest: None,
                delete_files: vec![
                    "assets/base-0.bin".into(),
                    "assets/base-1.bin".into(),
                    "assets/base-2.bin".into(),
                ],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        update_pack(
            ws.path(),
            home.path(),
            &UpdatePackRequest {
                slug: "trim".into(),
                content: test_skill_md("trim"),
                files: pack_files("extra", 3, chunk),
                expected_digest: None,
                delete_files: vec![],
            },
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();

        let root = home.path().join(".agents/skills/trim");
        assert!(!root.join("assets/base-0.bin").exists());
        assert!(root.join("assets/extra-0.bin").exists());
    }
}
