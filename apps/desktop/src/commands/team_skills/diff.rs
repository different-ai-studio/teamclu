//! Diffing an installed skill against a pack, and one version against another.

use super::build_cloud_api_client;
use super::format_reqwest_error;
use super::frontmatter::installed_state;
use super::frontmatter::write_install_frontmatter;
use super::inspect::effective_team_skill_dir;
use super::install::download_request;
use super::types::TeamSkillFileDiff;
use super::types::TeamSkillInstallRequest;
use super::types::TeamSkillVersionRangeDiffRequest;
use crate::commands::clawhub::{extract_zip_to_dir, validate_slug};
use std::collections::BTreeSet;
use teamclu_skillpack::{list_managed_paths, DirtyState};
use teamclu_types::skill_frontmatter::parse_frontmatter;

/// Reconstruct the installed baseline and diff it against what is on disk.
///
/// The baseline is not kept locally — it was overwritten in place — so it is
/// rebuilt from the registry: download the *installed* version's package (not
/// the latest one; the question is "what did I change", not "what did the team
/// change") and run the identical frontmatter rewrite over it. Skipping that
/// rewrite makes every file's frontmatter block show up as a change, which is
/// the same trap as hashing the archive instead of the installed directory.
#[tauri::command]
pub async fn team_skill_diff(
    request: TeamSkillInstallRequest,
) -> Result<Vec<TeamSkillFileDiff>, String> {
    tokio::task::spawn_blocking(move || {
        let mut request = request;
        let slug = request.slug.trim().to_string();
        validate_slug(&slug)?;
        let (target, _) = effective_team_skill_dir(&slug, request.team_id.as_deref())?;

        let (modified, deleted, added) = match installed_state(&target) {
            DirtyState::Dirty {
                modified,
                deleted,
                added,
            } => (modified, deleted, added),
            _ => return Ok(Vec::new()),
        };

        // `owner` and `category` come from the pack's own frontmatter rather
        // than from the caller's registry row. The caller can only pass the
        // *current* row — the version snapshot carries neither field — so after
        // an owner transfer or a category edit, rebuilding the baseline from it
        // paints two frontmatter lines the user never touched as their changes,
        // in the one dialog whose entire job is answering "did I change this?".
        // Both lines are machine-written, so taking them from disk cannot hide
        // a real edit worth showing.
        if let Ok(current) = std::fs::read_to_string(target.join("SKILL.md")) {
            let parsed = teamclu_types::skill_frontmatter::parse_frontmatter(&current);
            if let Some(owner) = parsed.string("owner") {
                request.owner = Some(owner.to_string());
            }
            if let Some(category) = parsed.string("category") {
                request.category = Some(category.to_string());
            }
        }

        let client = build_cloud_api_client()?;
        let resp = download_request(
            &client,
            &request.download_url,
            request.access_token.as_deref(),
        )
        .send()
        .map_err(|e| format!("Download failed: {}", format_reqwest_error(&e)))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed with status {}", resp.status()));
        }
        let zip_bytes = resp
            .bytes()
            .map_err(|e| format!("Failed to read download body: {}", e))?;

        let staging =
            tempfile::tempdir().map_err(|e| format!("Failed to create staging dir: {}", e))?;
        extract_zip_to_dir(&zip_bytes, staging.path())?;
        write_install_frontmatter(staging.path(), &request)?;

        let read_text = |path: &std::path::Path| -> (Option<String>, bool) {
            match std::fs::read(path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => (Some(text), false),
                    Err(_) => (None, true),
                },
                Err(_) => (None, false),
            }
        };

        let mut out = Vec::new();
        // `added` rides the same loop on purpose: the staging copy has no such
        // file, so `read_text` returns None for the baseline side and the diff
        // renders as "all new" — which is exactly what it is.
        for rel in modified.into_iter().chain(deleted).chain(added) {
            let (baseline, baseline_binary) = read_text(&staging.path().join(&rel));
            let (current, current_binary) = read_text(&target.join(&rel));
            out.push(TeamSkillFileDiff {
                path: rel,
                baseline,
                current,
                binary: baseline_binary || current_binary,
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| format!("team skill diff task failed: {}", e))?
}

fn read_text_side(path: &std::path::Path) -> (Option<String>, bool) {
    match std::fs::read(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (Some(text), false),
            Err(_) => (None, true),
        },
        Err(_) => (None, false),
    }
}

fn stage_installed_pack(req: &TeamSkillInstallRequest) -> Result<tempfile::TempDir, String> {
    let client = build_cloud_api_client()?;
    let resp = download_request(&client, &req.download_url, req.access_token.as_deref())
        .send()
        .map_err(|e| format!("Download failed: {}", format_reqwest_error(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status {}", resp.status()));
    }
    let zip_bytes = resp
        .bytes()
        .map_err(|e| format!("Failed to read download body: {}", e))?;
    let staging =
        tempfile::tempdir().map_err(|e| format!("Failed to create staging dir: {}", e))?;
    extract_zip_to_dir(&zip_bytes, staging.path())?;
    // Category is not snapshotted on version rows. Stamping the *current*
    // registry category onto both sides of a version-range diff hides the
    // pack's own frontmatter. Prefer the zip; fall back to the caller's value.
    let mut stamped = req.clone();
    if let Ok(current) = std::fs::read_to_string(staging.path().join("SKILL.md")) {
        let parsed = parse_frontmatter(&current);
        if let Some(category) = parsed.string("category") {
            stamped.category = Some(category.to_string());
        }
        if stamped.requires.is_none() {
            if let Some(requires) = parsed.present_list("requires") {
                stamped.requires = Some(requires);
            }
        }
    }
    write_install_frontmatter(staging.path(), &stamped)?;
    Ok(staging)
}

fn diff_staged_trees(
    from: &std::path::Path,
    to: &std::path::Path,
) -> Result<Vec<TeamSkillFileDiff>, String> {
    let mut paths = BTreeSet::new();
    for rel in list_managed_paths(from).map_err(|e| format!("Failed to list files: {}", e))? {
        paths.insert(rel);
    }
    for rel in list_managed_paths(to).map_err(|e| format!("Failed to list files: {}", e))? {
        paths.insert(rel);
    }
    let mut out = Vec::new();
    for rel in paths {
        let (baseline, baseline_binary) = read_text_side(&from.join(&rel));
        let (current, current_binary) = read_text_side(&to.join(&rel));
        if baseline == current && !baseline_binary && !current_binary {
            continue;
        }
        out.push(TeamSkillFileDiff {
            path: rel,
            baseline,
            current,
            binary: baseline_binary || current_binary,
        });
    }
    Ok(out)
}

/// Diff two published versions — e.g. what the team shipped between your
/// baseline and their latest while you were editing locally.
#[tauri::command]
pub async fn team_skill_diff_versions(
    request: TeamSkillVersionRangeDiffRequest,
) -> Result<Vec<TeamSkillFileDiff>, String> {
    tokio::task::spawn_blocking(move || {
        let from = stage_installed_pack(&request.from)?;
        let to = stage_installed_pack(&request.to)?;
        diff_staged_trees(from.path(), to.path())
    })
    .await
    .map_err(|e| format!("team skill version diff task failed: {}", e))?
}
