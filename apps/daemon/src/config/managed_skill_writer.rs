//! Backend-neutral personal skill pack writer for `~/.agents/skills`.
//!
//! Used by the daemon `skills-manage` control socket and agent-facing MCP
//! create/update. The settings UI upsert keeps its frontmatter-compat behavior
//! in `upsert_skill` until that path is migrated here.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use teamclu_skillpack::manifest::build_manifest;
use teamclu_types::skill_frontmatter::parse_frontmatter;
use uuid::Uuid;

use super::roles_skills::is_inherent_skill;

const GLOBAL_SKILLS_REL: &str = ".agents/skills";
const SKILL_MD: &str = "SKILL.md";
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
    fn new(code: ManagedSkillErrorCode, message: impl Into<String>) -> Self {
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

fn normalize_pack_rel_path(raw: &str) -> Result<PathBuf, ManagedSkillError> {
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
    if trimmed.starts_with('/') || trimmed.starts_with("..") || trimmed.contains("/../") {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("unsafe pack path {raw:?}"),
        ));
    }
    if trimmed == SKILL_MD {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            "pack files must not overwrite SKILL.md; pass it as content",
        ));
    }
    let path = Path::new(trimmed);
    for comp in path.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ManagedSkillError::new(
                    ManagedSkillErrorCode::InvalidSkillFilePath,
                    format!("unsafe pack path {raw:?}"),
                ));
            }
            _ => {}
        }
    }
    Ok(path.to_path_buf())
}

fn decode_pack_file(input: &PackFileInput) -> Result<Vec<u8>, ManagedSkillError> {
    let encoding = input.encoding.as_deref().unwrap_or("utf8");
    if encoding != "utf8" {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::InvalidSkillFilePath,
            format!("unsupported file encoding {encoding:?}; only utf8 is supported"),
        ));
    }
    Ok(input.content.as_bytes().to_vec())
}

fn reject_symlink(path: &Path) -> Result<(), ManagedSkillError> {
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
    verify_tree_confined(root)?;
    Ok(())
}

fn classify_existing_target(
    target: &Path,
    claimed_team_slugs: &BTreeSet<String>,
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
    if claimed_team_slugs.contains(slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::TeamSkillReadOnly,
            format!("team-managed skill {slug} cannot be overwritten"),
        ));
    }
    Err(ManagedSkillError::new(
        ManagedSkillErrorCode::SkillAlreadyExists,
        format!("skill {slug} already exists and was not overwritten"),
    ))
}

fn publish_temp_dir(temp: &Path, target: &Path) -> Result<(), ManagedSkillError> {
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
    claimed_team_slugs: &BTreeSet<String>,
) -> Result<ManageSkillResponse, ManagedSkillError> {
    let build = build_pack_inputs(&req.slug, &req.content, &req.files)?;
    let skills_root = global_skills_root(home);
    fs::create_dir_all(&skills_root).map_err(io_managed)?;
    let target = skills_root.join(&req.slug);
    classify_existing_target(&target, claimed_team_slugs)?;

    let temp = skills_root.join(format!(".teamclu-create-{}", Uuid::new_v4()));
    write_temp_pack(&temp, &build)?;
    let digest = pack_digest(&temp)?;
    publish_temp_dir(&temp, &target)?;

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
    claimed_team_slugs: &BTreeSet<String>,
) -> Result<ManageSkillResponse, ManagedSkillError> {
    let build = build_pack_inputs(&req.slug, &req.content, &req.files)?;
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
    if claimed_team_slugs.contains(&req.slug) {
        return Err(ManagedSkillError::new(
            ManagedSkillErrorCode::TeamSkillReadOnly,
            "team-managed skills are read-only here",
        ));
    }
    if let Some(expected) = req.expected_digest.as_deref().filter(|v| !v.is_empty()) {
        let current = pack_digest(&target)?;
        if current != expected {
            return Err(ManagedSkillError::new(
                ManagedSkillErrorCode::SkillChanged,
                "skill digest does not match expectedDigest",
            ));
        }
    }

    let temp = skills_root.join(format!(".teamclu-update-{}", Uuid::new_v4()));
    write_temp_pack(&temp, &build)?;
    let digest = pack_digest(&temp)?;
    let backup = skills_root.join(format!(".teamclu-backup-{}", Uuid::new_v4()));
    fs::rename(&target, &backup).map_err(io_managed)?;
    if let Err(e) = publish_temp_dir(&temp, &target) {
        let _ = fs::rename(&backup, &target);
        return Err(e);
    }
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
        let resp = create_pack(ws.path(), home.path(), &req, &BTreeSet::new()).unwrap();
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
        create_pack(ws.path(), home.path(), &req, &BTreeSet::new()).unwrap();
        let err = create_pack(ws.path(), home.path(), &req, &BTreeSet::new()).unwrap_err();
        assert_eq!(err.code, ManagedSkillErrorCode::SkillAlreadyExists);
    }
}
