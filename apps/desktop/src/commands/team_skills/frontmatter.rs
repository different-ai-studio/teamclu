//! Writing the registry fields back into SKILL.md, and the install stamp
//! that lets a later inspect tell "edited since install" from "untouched".

use super::types::TeamSkillInstallRequest;
use crate::commands::clawhub::{now_millis, SOURCE_TEAM};
use teamclu_skillpack::{
    build_manifest, build_manifest_for, inspect, read_origin, write_origin,
    write_registry_frontmatter, DirtyState, RegistryFields, SkillOrigin, ORIGIN_VERSION,
};
use teamclu_types::skill_frontmatter::FrontmatterValue;

/// Key order for the *fork* rewrite below. The registry install path does not
/// use this — it goes through `teamclu_skillpack::write_registry_frontmatter`,
/// which owns the canonical order so the daemon's reconcile stamps byte-identical
/// frontmatter.
pub(super) const FRONTMATTER_KEY_ORDER: &[&str] = &[
    "name",
    "description",
    "owner",
    "category",
    "when_to_use",
    "when_not_to_use",
    "requires",
    "version",
    "source",
];

pub(super) fn scalar(value: &str) -> Option<FrontmatterValue> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(FrontmatterValue::Scalar(trimmed.to_owned()))
    }
}

/// Stamp the registry fields into SKILL.md.
///
/// The writing itself lives in `teamclu-skillpack` because the daemon's
/// reconcile stamps the same fields for shared agents; if the two drifted, a
/// skill's frontmatter would depend on which installer happened to run.
pub(super) fn write_registry_frontmatter_fields(
    target: &std::path::Path,
    fields: &RegistryFields<'_>,
) -> Result<bool, String> {
    write_registry_frontmatter(target, fields)
        .map_err(|e| format!("Failed to write SKILL.md: {}", e))
}

pub(super) fn write_install_frontmatter(
    target: &std::path::Path,
    req: &TeamSkillInstallRequest,
) -> Result<bool, String> {
    write_registry_frontmatter_fields(
        target,
        &RegistryFields {
            slug: &req.slug,
            version: req.version,
            owner: req.owner.as_deref(),
            category: req.category.as_deref(),
            summary: req.summary.as_deref(),
            when_to_use: req.when_to_use.as_deref(),
            when_not_to_use: req.when_not_to_use.as_deref(),
            requires: req.requires.as_deref(),
        },
    )
}

/// Returned instead of overwriting a pack that has local edits. The frontend
/// matches on it to open the conflict UI, so it is a stable contract string,
/// not a message.
pub const DIRTY_CONFLICT_ERROR: &str = "team_skill_dirty_conflict";

/// Compare the installed pack against the baseline recorded at install time.
///
/// A missing directory and a pack with no baseline both come back as
/// `Unmanaged` — neither is evidence of an edit, and treating "I don't know"
/// as "dirty" would wedge auto-follow on every pack installed by an older
/// build.
pub(super) fn installed_state(target: &std::path::Path) -> DirtyState {
    if !target.exists() {
        return DirtyState::Unmanaged;
    }
    let baseline = read_origin(target).and_then(|o| o.files);
    inspect(target, baseline.as_ref())
}

/// What to record about a pack we just laid down.
pub(super) struct InstalledStamp<'a> {
    pub(super) slug: &'a str,
    pub(super) version: i64,
    /// Whose registry it came from. `None` only where the caller genuinely does
    /// not know, which keeps the pack out of every team's removal set.
    pub(super) team_id: Option<&'a str>,
    /// The files the package shipped, `/`-separated. `None` measures the whole
    /// directory and is only correct where the directory *is* the package —
    /// the publish path. On the download path it would adopt a script's own
    /// cache into the baseline and pin the pack dirty forever.
    pub(super) shipped: Option<&'a [String]>,
}

/// Record what we just put on disk.
///
/// Call order is not negotiable: the frontmatter rewrite edits `SKILL.md`, so
/// the manifest has to be built after it or every skill is born dirty; and
/// `origin.json` is excluded from the manifest, so it has to be written after
/// the manifest exists.
pub(super) fn stamp_installed_state(
    target: &std::path::Path,
    stamp: InstalledStamp<'_>,
) -> Result<(), String> {
    let files = match stamp.shipped {
        Some(rels) => build_manifest_for(target, rels),
        None => build_manifest(target),
    }
    .map_err(|e| format!("Failed to record installed state: {}", e))?;
    write_origin(
        target,
        &SkillOrigin {
            version: ORIGIN_VERSION,
            registry: SOURCE_TEAM.to_string(),
            slug: stamp.slug.to_string(),
            installed_version: stamp.version.to_string(),
            installed_at: now_millis(),
            team_id: stamp.team_id.map(str::to_string),
            files: Some(files),
        },
    )
    .map_err(|e| format!("Failed to write origin.json: {}", e))
}
