//! The request and result shapes the team-skill commands hand the frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillVersionPayload {
    pub version: i64,
    pub content_hash: String,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default)]
    pub when_not_to_use: String,
    #[serde(default)]
    pub requires: Option<serde_json::Value>,
}

/// Everything the desktop needs to materialise one skill. The frontend already
/// has the registry row from `GET /v1/teams/:id/skills/:slug`, so it passes the
/// resolved fields down rather than making this command re-fetch them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallRequest {
    pub workspace_path: Option<String>,
    pub slug: String,
    /// Which team's registry this came from. Recorded on disk so a reconcile for
    /// a different team can tell this pack is not its business.
    pub team_id: Option<String>,
    pub download_url: String,
    /// Bearer token for the Cloud API. Passed in because auth lives in the
    /// frontend's backend provider, not here.
    pub access_token: Option<String>,
    pub version: i64,
    pub owner: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub when_to_use: Option<String>,
    pub when_not_to_use: Option<String>,
    pub requires: Option<Vec<String>>,
    #[serde(default)]
    pub is_global: bool,
    /// Overwrite a pack that has local edits. Set by the conflict UI's "discard
    /// local changes"; never by the reconcile loop, which is exactly the caller
    /// that must not be able to do this silently.
    #[serde(default)]
    pub force: bool,
    /// Move an unrelated directory sitting at the target path into the trash
    /// before installing, instead of writing over it.
    ///
    /// Set by the reconcile loop and by nothing else. Clicking install is a
    /// decision about *this* path and may overwrite it; auto-follow on a machine
    /// the user has just signed into is not — it can arrive seconds after login
    /// and write over a skill they hand-wrote there, with nothing to undo.
    #[serde(default)]
    pub archive_unmanaged: bool,
}

/// Install by copying an existing on-disk skill directory (Share → auto-install
/// for the publisher, without needing an OSS download of a blob that may not
/// have been uploaded yet).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallFromDirRequest {
    pub workspace_path: Option<String>,
    pub slug: String,
    pub team_id: Option<String>,
    pub source_dir: String,
    pub version: i64,
    pub owner: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub when_to_use: Option<String>,
    pub when_not_to_use: Option<String>,
    pub requires: Option<Vec<String>>,
    #[serde(default)]
    pub is_global: bool,
}

/// Promote the effective runtime copy of an already-installed team Skill to a
/// newly published version without copying it through the member projection.
///
/// Hosted Agent sessions edit the daemon-owned cloud projection, while ordinary
/// member installs live under `~/.agents/skills`. Re-baselining the latter
/// unconditionally is what made a successful publish leave the copy OpenCode
/// actually runs dirty against its previous version.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillRebaselineRequest {
    pub workspace_path: Option<String>,
    pub slug: String,
    pub team_id: Option<String>,
    pub version: i64,
    pub owner: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub when_to_use: Option<String>,
    pub when_not_to_use: Option<String>,
    pub requires: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillPackResult {
    pub content_hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallResult {
    pub slug: String,
    pub version: i64,
    pub path: String,
    pub frontmatter_written: bool,
    /// Where an unrelated directory was moved before installing, if one was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_path: Option<String>,
}

/// Which team-registry packs are on this machine, and at what version.
///
/// This is the left-hand side of the reconcile diff: the server's install rows
/// are the desired state (§4), and this is what the machine actually has.
///
/// It reads each pack's own `origin.json` rather than the workspace lockfile,
/// because the two disagree by construction. Packs are global
/// (`~/.agents/skills/<slug>`) while lockfiles are per-workspace, so a lockfile
/// is silent about a pack installed from a different workspace and can still
/// name a version that another workspace has since moved past. Reconciling
/// against a source that is structurally allowed to be wrong would produce
/// exactly the phantom installs this whole change is meant to remove.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTeamSkill {
    pub slug: String,
    pub version: String,
    /// `None` for packs installed before the team was recorded. The caller must
    /// treat those as un-removable: one flat directory serves every team, so
    /// "I cannot tell whose this is" and "this is mine to delete" are very
    /// different answers.
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInspectResult {
    pub slug: String,
    /// `missing` | `clean` | `dirty` | `stale_dirty` | `foreign`
    pub state: String,
    pub installed_version: Option<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    /// Files in the pack directory that the install never put there. Dirt in
    /// its own right: the publish path measures the whole directory, so these
    /// ship with the next version.
    pub added: Vec<String>,
    /// `hosted-agent` when this is the daemon projection OpenCode ranks first;
    /// `member` for `~/.agents/skills`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillFileDiff {
    pub path: String,
    /// `None` when the side is absent or not UTF-8.
    pub baseline: Option<String>,
    pub current: Option<String>,
    pub binary: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillVersionRangeDiffRequest {
    pub from: TeamSkillInstallRequest,
    pub to: TeamSkillInstallRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDraftMetadata {
    /// `None` = key absent in the draft (keep registry). `Some("")` = cleared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_not_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecoveryRecord {
    pub slug: String,
    pub path: String,
    pub at: u64,
    pub reason: String,
    pub base_version: Option<i64>,
    pub team_id: Option<String>,
}
