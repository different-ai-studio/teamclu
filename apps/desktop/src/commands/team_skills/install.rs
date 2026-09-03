//! Install, uninstall, re-baseline, and pack-and-upload.

use super::build_cloud_api_client;
use super::format_reqwest_error;
use super::frontmatter::installed_state;
use super::frontmatter::stamp_installed_state;
use super::frontmatter::write_install_frontmatter;
use super::frontmatter::write_registry_frontmatter_fields;
use super::frontmatter::InstalledStamp;
use super::frontmatter::DIRTY_CONFLICT_ERROR;
use super::inspect::belongs_to_another_team;
use super::inspect::effective_team_skill_dir;
use super::packfs::zip_skill_dir;
use super::trash::draft_recovery_context;
use super::trash::move_to_trash;
use super::types::TeamSkillInstallFromDirRequest;
use super::types::TeamSkillInstallRequest;
use super::types::TeamSkillInstallResult;
use super::types::TeamSkillPackResult;
use super::types::TeamSkillRebaselineRequest;
use crate::commands::clawhub::{
    clear_skill_permission, extract_zip_to_dir, global_skills_dir, now_millis, read_lockfile,
    set_skill_permission_ask, validate_slug, write_lockfile, LockfileEntry, SOURCE_TEAM,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use teamclu_skillpack::{
    commit_staged_pack, list_managed_paths, read_origin, remove_managed_files, swap_managed_files,
    RegistryFields,
};

#[tauri::command]
pub async fn team_skill_install(
    request: TeamSkillInstallRequest,
) -> Result<TeamSkillInstallResult, String> {
    tokio::task::spawn_blocking(move || team_skill_install_blocking(request))
        .await
        .map_err(|e| format!("team skill install task failed: {}", e))?
}

/// Storage download URLs from `resolveDownload` are already signed (S3/MinIO
/// query auth, or Supabase Storage `token=`). Attaching a Bearer JWT makes
/// MinIO reject the GET as "multiple authentication types" (HTTP 400) — which
/// is exactly what auto-follow hits when bumping an installed pack to a new
/// marketplace/team version. Only attach Bearer when the URL is not presigned.
pub(super) fn is_presigned_storage_url(url: &str) -> bool {
    url.contains("X-Amz-Signature=")
        || url.contains("X-Amz-Credential=")
        || url.contains("X-Amz-Algorithm=")
        // Supabase Storage signed URLs carry the JWT in the query string.
        || url.contains("token=")
}

pub(super) fn download_request(
    client: &reqwest::blocking::Client,
    url: &str,
    access_token: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let mut download = client.get(url);
    if is_presigned_storage_url(url) {
        return download;
    }
    if let Some(token) = access_token.filter(|t| !t.is_empty()) {
        download = download.header("Authorization", format!("Bearer {}", token));
    }
    download
}

/// Blocking half. Runs off the Tauri main thread: HTTP + zip + filesystem.
fn team_skill_install_blocking(
    req: TeamSkillInstallRequest,
) -> Result<TeamSkillInstallResult, String> {
    let slug = req.slug.trim().to_string();
    validate_slug(&slug)?;

    let skills = global_skills_dir()?;
    std::fs::create_dir_all(&skills).map_err(|e| format!("Failed to create skills dir: {}", e))?;
    let target = skills.join(&slug);

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

    // Auto-follow means this runs unattended, so a local edit has to stop it.
    // The caller normally checks with `team_skill_inspect` first and shows the
    // conflict UI; this is the backstop that makes it impossible to lose an
    // edit by forgetting to ask.
    if !req.force && installed_state(&target).is_dirty() {
        return Err(DIRTY_CONFLICT_ERROR.to_string());
    }

    // Something is here that we have no record of installing — a skill written
    // straight into the skills root, most likely, that happens to share a team
    // slug. Overwriting it is right when a person just clicked install; doing it
    // unattended is not, so the reconcile asks for it to be set aside instead
    // and the user gets an offer to keep it under another name.
    let archived_path = if req.archive_unmanaged
        && target.is_dir()
        && read_origin(&target).is_none()
        && std::fs::read_dir(&target)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        Some(move_to_trash(
            &target,
            &slug,
            Some(draft_recovery_context(
                &target,
                "replace",
                req.team_id.as_deref(),
            )),
        )?)
    } else {
        None
    };

    let staging =
        tempfile::tempdir().map_err(|e| format!("Failed to create staging dir: {}", e))?;
    extract_zip_to_dir(&zip_bytes, staging.path())?;

    // Finish the new tree in staging (frontmatter + origin) before making it
    // live. Swap-then-origin left mixed versions when origin write failed —
    // see docs/architecture/hosted-skill-reconcile-fail-closed.md.
    let shipped = list_managed_paths(staging.path())
        .map_err(|e| format!("Failed to list package files: {}", e))?;
    let frontmatter_written = write_install_frontmatter(staging.path(), &req)?;
    stamp_installed_state(
        staging.path(),
        InstalledStamp {
            slug: &slug,
            version: req.version,
            team_id: req.team_id.as_deref(),
            shipped: Some(&shipped),
        },
    )?;
    commit_staged_pack(&target, staging.path())
        .map_err(|e| format!("Failed to install skill files: {}", e))?;

    // Lockfile stays workspace-scoped for update checks, even though the pack
    // itself always lives under ~/.agents/skills.
    if let Some(ws) = req
        .workspace_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut lock = read_lockfile(ws);
        lock.skills.insert(
            slug.clone(),
            LockfileEntry {
                version: Some(req.version.to_string()),
                installed_at: now_millis(),
                source: Some(SOURCE_TEAM.to_string()),
            },
        );
        write_lockfile(ws, &lock)?;
        set_skill_permission_ask(ws, &slug);
    }

    Ok(TeamSkillInstallResult {
        slug,
        version: req.version,
        path: target.display().to_string(),
        frontmatter_written,
        archived_path,
    })
}

#[tauri::command]
pub async fn team_skill_uninstall(
    workspace_path: Option<String>,
    slug: String,
    is_global: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        team_skill_uninstall_blocking(workspace_path, slug, is_global)
    })
    .await
    .map_err(|e| format!("team_skill_uninstall task failed: {e}"))?
}

pub(super) fn team_skill_uninstall_blocking(
    workspace_path: Option<String>,
    slug: String,
    is_global: Option<bool>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let _ = is_global; // packs always live under ~/.agents/skills

    let skills = global_skills_dir()?;
    let target = skills.join(&slug);
    // Remove what we installed, not everything in the directory. The reconcile
    // loop calls this unattended in response to an uninstall somebody performed
    // on another machine, and the upgrade path two functions up deliberately
    // preserves files the pack never owned — a background tick must not be the
    // one operation that deletes the user's notes.
    let baseline = read_origin(&target).and_then(|o| o.files);
    remove_managed_files(&target, baseline.as_ref())
        .map_err(|e| format!("Failed to remove skill directory: {}", e))?;

    if let Some(ws) = workspace_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let mut lock = read_lockfile(ws);
        lock.skills.remove(&slug);
        write_lockfile(ws, &lock)?;
        // The permission entry is keyed by slug, and slugs get reused: a team
        // can delete a skill and publish different content under the same name.
        // Left behind, the old decision governs the new pack — `install` only
        // writes `ask` when the key is absent, so nothing resets it.
        //
        // Same workspace-shaped limitation as the lockfile above, for the same
        // reason: packs are global, both of these are per-workspace, and this
        // command is handed one path. Other workspaces keep their entry.
        clear_skill_permission(ws, &slug);
    }

    Ok(format!("Uninstalled {}", slug))
}

/// Zip a personal skill directory and upload it to the team's amuxc blob store.
/// Returns sha256 + size for the subsequent `POST /v1/teams/:id/skills` publish.
#[tauri::command]
pub async fn team_skill_pack_and_upload(
    dir_path: String,
    slug: String,
    team_id: String,
    cloud_api_url: String,
    access_token: String,
) -> Result<TeamSkillPackResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = slug.trim().to_string();
        validate_slug(&slug)?;
        let team_id = team_id.trim().to_string();
        if team_id.is_empty() {
            return Err("teamId is required".to_string());
        }
        let base = cloud_api_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err("cloudApiUrl is required".to_string());
        }
        let token = access_token.trim().to_string();
        if token.is_empty() {
            return Err("accessToken is required".to_string());
        }

        let dir = std::path::PathBuf::from(dir_path.trim());
        if !dir.is_dir() {
            return Err(format!("Skill directory not found: {}", dir.display()));
        }
        if !dir.join("SKILL.md").is_file() {
            return Err("Skill directory must contain SKILL.md".to_string());
        }
        let zip_bytes = zip_skill_dir(&dir)?;
        let mut hasher = Sha256::new();
        hasher.update(&zip_bytes);
        let content_hash = format!("{:x}", hasher.finalize());
        let size = zip_bytes.len() as u64;

        let client = build_cloud_api_client()?;
        let prepare_url = format!("{}/v1/teams/{}/skill-blobs/prepare", base, team_id);
        let prepare_resp = client
            .post(&prepare_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "contentHash": content_hash,
                "size": size,
            }))
            .send()
            .map_err(|e| format!("skill blob prepare failed: {}", format_reqwest_error(&e)))?;
        if !prepare_resp.status().is_success() {
            let status = prepare_resp.status();
            let body = prepare_resp.text().unwrap_or_default();
            return Err(format!("skill blob prepare HTTP {}: {}", status, body));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrepareBody {
            requires_upload: bool,
            #[serde(default)]
            presigned_put: Option<String>,
        }
        let prepared: PrepareBody = prepare_resp
            .json()
            .map_err(|e| format!("skill blob prepare decode: {}", e))?;

        if prepared.requires_upload {
            let put_url = prepared
                .presigned_put
                .filter(|u| !u.is_empty())
                .ok_or_else(|| {
                    "skill blob prepare required upload but returned no URL".to_string()
                })?;
            let put_resp = client
                .put(&put_url)
                .header("x-upsert", "true")
                .body(zip_bytes)
                .send()
                .map_err(|e| format!("skill blob PUT failed: {}", format_reqwest_error(&e)))?;
            if !put_resp.status().is_success() {
                return Err(format!("skill blob PUT HTTP {}", put_resp.status()));
            }
        }

        let complete_url = format!("{}/v1/teams/{}/skill-blobs/complete", base, team_id);
        let complete_resp = client
            .post(&complete_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "contentHash": content_hash,
                "size": size,
            }))
            .send()
            .map_err(|e| format!("skill blob complete failed: {}", format_reqwest_error(&e)))?;
        if !complete_resp.status().is_success() {
            let status = complete_resp.status();
            let body = complete_resp.text().unwrap_or_default();
            return Err(format!("skill blob complete HTTP {}: {}", status, body));
        }

        Ok(TeamSkillPackResult { content_hash, size })
    })
    .await
    .map_err(|e| format!("team skill pack_and_upload task failed: {}", e))?
}

/// Copy a personal skill folder into the workspace team-skills install location
/// and stamp registry frontmatter / lockfile. Used after Share so the publisher
/// does not need an OSS download of a blob that may not exist yet.
#[tauri::command]
pub async fn team_skill_install_from_dir(
    request: TeamSkillInstallFromDirRequest,
) -> Result<TeamSkillInstallResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = request.slug.trim().to_string();
        validate_slug(&slug)?;
        let source = std::path::PathBuf::from(request.source_dir.trim());
        if !source.is_dir() {
            return Err(format!("Source directory not found: {}", source.display()));
        }
        if !source.join("SKILL.md").is_file() {
            return Err("Source directory must contain SKILL.md".to_string());
        }

        let skills = global_skills_dir()?;
        std::fs::create_dir_all(&skills)
            .map_err(|e| format!("Failed to create skills dir: {}", e))?;
        let target = skills.join(&slug);
        // No dirty check here, unlike the download path: this *is* the author
        // publishing their local edits, so the edits are the new version rather
        // than something to protect from it.
        let baseline = read_origin(&target).and_then(|o| o.files);
        swap_managed_files(&target, &source, baseline.as_ref())
            .map_err(|e| format!("Failed to install skill files: {}", e))?;

        let frontmatter_written = write_registry_frontmatter_fields(
            &target,
            &RegistryFields {
                slug: &slug,
                version: request.version,
                owner: request.owner.as_deref(),
                category: request.category.as_deref(),
                summary: request.summary.as_deref(),
                when_to_use: request.when_to_use.as_deref(),
                when_not_to_use: request.when_not_to_use.as_deref(),
                requires: request.requires.as_deref(),
            },
        )?;
        // Re-baselining here is what keeps the author's own machine out of
        // permanent conflict: without it, every publish leaves the publisher
        // looking dirty against the version they just shipped.
        //
        // `shipped: None` on purpose — here the directory *is* the package, so
        // measuring the whole thing is measuring exactly what was uploaded.
        stamp_installed_state(
            &target,
            InstalledStamp {
                slug: &slug,
                version: request.version,
                team_id: request.team_id.as_deref(),
                shipped: None,
            },
        )?;

        if let Some(ws) = request
            .workspace_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            let mut lock = read_lockfile(ws);
            lock.skills.insert(
                slug.clone(),
                LockfileEntry {
                    version: Some(request.version.to_string()),
                    installed_at: now_millis(),
                    source: Some(SOURCE_TEAM.to_string()),
                },
            );
            write_lockfile(ws, &lock)?;
            set_skill_permission_ask(ws, &slug);
        }

        Ok(TeamSkillInstallResult {
            slug,
            version: request.version,
            path: target.display().to_string(),
            frontmatter_written,
            archived_path: None,
        })
    })
    .await
    .map_err(|e| format!("team skill install_from_dir task failed: {}", e))?
}

/// Re-baseline the same copy that inspection and publishing resolved.
///
/// This intentionally does not download or copy anything: the bytes in this
/// directory are the bytes that were just uploaded. The desktop reconcile will
/// independently bring the lower-priority member projection to the new version
/// when the effective copy is hosted by the daemon.
#[tauri::command]
pub async fn team_skill_rebaseline(
    request: TeamSkillRebaselineRequest,
) -> Result<TeamSkillInstallResult, String> {
    tokio::task::spawn_blocking(move || team_skill_rebaseline_blocking(request))
        .await
        .map_err(|e| format!("team_skill_rebaseline task failed: {e}"))?
}

pub(super) fn team_skill_rebaseline_blocking(
    request: TeamSkillRebaselineRequest,
) -> Result<TeamSkillInstallResult, String> {
    let slug = request.slug.trim().to_string();
    validate_slug(&slug)?;
    let (target, _) = effective_team_skill_dir(&slug, request.team_id.as_deref())?;
    if !target.is_dir() || !target.join("SKILL.md").is_file() {
        return Err(format!("{} is not installed", slug));
    }

    let origin = read_origin(&target)
        .ok_or_else(|| "Refusing to claim a Skill with no team install record".to_string())?;
    if origin.registry != SOURCE_TEAM
        || belongs_to_another_team(&origin, request.team_id.as_deref())
    {
        return Err("Refusing to re-baseline a Skill owned by another source".to_string());
    }

    let frontmatter_written = write_registry_frontmatter_fields(
        &target,
        &RegistryFields {
            slug: &slug,
            version: request.version,
            owner: request.owner.as_deref(),
            category: request.category.as_deref(),
            summary: request.summary.as_deref(),
            when_to_use: request.when_to_use.as_deref(),
            when_not_to_use: request.when_not_to_use.as_deref(),
            requires: request.requires.as_deref(),
        },
    )?;
    stamp_installed_state(
        &target,
        InstalledStamp {
            slug: &slug,
            version: request.version,
            team_id: request.team_id.as_deref(),
            shipped: None,
        },
    )?;

    if let Some(ws) = request
        .workspace_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut lock = read_lockfile(ws);
        lock.skills.insert(
            slug.clone(),
            LockfileEntry {
                version: Some(request.version.to_string()),
                installed_at: now_millis(),
                source: Some(SOURCE_TEAM.to_string()),
            },
        );
        write_lockfile(ws, &lock)?;
        set_skill_permission_ask(ws, &slug);
    }

    Ok(TeamSkillInstallResult {
        slug,
        version: request.version,
        path: target.display().to_string(),
        frontmatter_written,
        archived_path: None,
    })
}
