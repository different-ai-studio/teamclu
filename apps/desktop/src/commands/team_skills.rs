//! Team skills registry — desktop install/uninstall.
//!
//! Design: docs/architecture/team-skills-registry.md
//!
//! Deliberately thin. The package pipeline (zip extract with traversal
//! guarding, `.clawhub/origin.json`, the lockfile, the `permission.skill`
//! entry) already exists for ClawHub, so this reuses it wholesale rather than
//! growing a second one — the only genuinely new steps are talking to the
//! Cloud API instead of the public registry, and writing the structured
//! frontmatter back into SKILL.md.
//!
//! That writeback is the point of the whole feature: the agent reads the file
//! on disk, not Postgres. A registry full of tidy `when_not_to_use` fields is
//! worth nothing if what lands in `.teamclu/skills/` is still one opaque
//! description blob.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use teamclu_skillpack::{
    build_manifest, build_manifest_for, commit_staged_pack, inspect, list_managed_paths,
    read_origin, remove_managed_files, swap_managed_files, write_origin,
    write_registry_frontmatter, DirtyState, RegistryFields, SkillOrigin, ORIGIN_VERSION,
};
use teamclu_types::skill_frontmatter::{parse_frontmatter, write_frontmatter, FrontmatterValue};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::clawhub::{
    clear_skill_permission, extract_zip_to_dir, global_skills_dir, now_millis, read_lockfile,
    set_skill_permission_ask, skills_dir, validate_slug, write_lockfile, LockfileEntry,
    SOURCE_TEAM,
};

/// Cloud API / SGW-facing client — mirrors `oss_sync::fc_client::FcClient`.
///
/// The clawhub registry client is fine for public mirrors; team skill upload /
/// download hits SGW-fronted Cloud API hosts where HTTP/2 idle reuse and older
/// TLS negotiation fail as a bare "error sending request for url". Force
/// HTTP/1.1 + rustls the same way FcClient does.
fn build_cloud_api_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .http1_only()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build Cloud API HTTP client: {}", e))
}

/// reqwest's Display omits the source chain, so toast users only see
/// "error sending request for url (...)" with no TLS/connect reason.
fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut src = std::error::Error::source(err);
    while let Some(e) = src {
        out.push_str(": ");
        out.push_str(&e.to_string());
        src = e.source();
    }
    out
}

/// Key order for the *fork* rewrite below. The registry install path does not
/// use this — it goes through `teamclu_skillpack::write_registry_frontmatter`,
/// which owns the canonical order so the daemon's reconcile stamps byte-identical
/// frontmatter.
const FRONTMATTER_KEY_ORDER: &[&str] = &[
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

fn scalar(value: &str) -> Option<FrontmatterValue> {
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
fn write_registry_frontmatter_fields(
    target: &std::path::Path,
    fields: &RegistryFields<'_>,
) -> Result<bool, String> {
    write_registry_frontmatter(target, fields)
        .map_err(|e| format!("Failed to write SKILL.md: {}", e))
}

fn write_install_frontmatter(
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
fn installed_state(target: &std::path::Path) -> DirtyState {
    if !target.exists() {
        return DirtyState::Unmanaged;
    }
    let baseline = read_origin(target).and_then(|o| o.files);
    inspect(target, baseline.as_ref())
}

/// What to record about a pack we just laid down.
struct InstalledStamp<'a> {
    slug: &'a str,
    version: i64,
    /// Whose registry it came from. `None` only where the caller genuinely does
    /// not know, which keeps the pack out of every team's removal set.
    team_id: Option<&'a str>,
    /// The files the package shipped, `/`-separated. `None` measures the whole
    /// directory and is only correct where the directory *is* the package —
    /// the publish path. On the download path it would adopt a script's own
    /// cache into the baseline and pin the pack dirty forever.
    shipped: Option<&'a [String]>,
}

/// Record what we just put on disk.
///
/// Call order is not negotiable: the frontmatter rewrite edits `SKILL.md`, so
/// the manifest has to be built after it or every skill is born dirty; and
/// `origin.json` is excluded from the manifest, so it has to be written after
/// the manifest exists.
fn stamp_installed_state(
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

/// Discarded packs land here — outside `~/.agents/skills` on purpose, so the
/// skill loaders and the daemon's file watcher never see them.
fn trash_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    Ok(home.join(".agents").join(".skill-trash"))
}

/// How long a discarded pack stays recoverable, and how many are kept.
///
/// The undo in the conflict UI lives for the length of a toast, so anything
/// beyond that is insurance against a user who realises tomorrow. Keeping it
/// forever is not more generous — skill packs carry binaries and reference
/// material, and an unbounded directory nobody can see is how a few hundred
/// megabytes accumulates in a home folder with no way to attribute it.
const TRASH_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const TRASH_MAX_ENTRIES: usize = 20;

/// Drop trashed packs that are past the retention window or past the count.
///
/// Both bounds are needed. Age alone lets a bad afternoon leave fifty packs
/// sitting there for a week; count alone lets two forgotten packs live forever.
///
/// Timestamps come from the directory name rather than mtime: the name is what
/// we wrote, and `rename` preserves whatever mtime the pack already had, which
/// can predate the discard by months. An entry whose name we cannot parse is
/// left alone — it is not ours to guess about.
fn prune_trash(trash: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(trash) else {
        return;
    };
    let mut dated: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(stamp) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.rsplit_once('-'))
            .and_then(|(_, ts)| ts.parse::<u64>().ok())
        else {
            continue;
        };
        dated.push((stamp, path));
    }

    // Newest first, so the survivors are a prefix.
    dated.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    let now = now_millis();
    for (index, (stamp, path)) in dated.into_iter().enumerate() {
        if index < TRASH_MAX_ENTRIES && now.saturating_sub(stamp) < TRASH_TTL_MS {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {}: {}", entry.path().display(), e))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)
                .map_err(|e| format!("Failed to copy {}: {}", entry.path().display(), e))?;
        }
    }
    Ok(())
}

/// Zip a skill directory for upload.
///
/// `.clawhub/` is left out. It is this machine's private record of what was
/// installed here — including the full file manifest — and shipping it means
/// every member downloads the publisher's bookkeeping and then overwrites it
/// with their own on install. A package that carries one machine's install
/// state is also the kind of thing that makes two installs of the "same"
/// version differ.
fn zip_skill_dir(dir: &std::path::Path) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    fn add_tree(
        writer: &mut ZipWriter<std::io::Cursor<Vec<u8>>>,
        opts: SimpleFileOptions,
        base: &std::path::Path,
        rel: &std::path::Path,
    ) -> Result<(), String> {
        let full = base.join(rel);
        if full.is_dir() {
            for entry in std::fs::read_dir(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
                let name = entry.file_name();
                // Only the top-level bookkeeping dir is ours; one nested deeper
                // belongs to the package, same rule the manifest walk uses.
                if rel.as_os_str().is_empty() && name == teamclu_skillpack::ORIGIN_DIR {
                    continue;
                }
                let child_rel = rel.join(&name);
                add_tree(writer, opts, base, &child_rel)?;
            }
        } else if full.is_file() {
            let name = rel.to_string_lossy().replace('\\', "/");
            let mut opts = opts;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&full) {
                    // Carry the exec bit into the archive, or every member
                    // downloads a script they cannot run.
                    opts = opts.unix_permissions(meta.permissions().mode() & 0o777);
                }
            }
            writer
                .start_file(name, opts)
                .map_err(|e| format!("zip start: {}", e))?;
            let bytes = std::fs::read(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?;
            use std::io::Write;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("zip write: {}", e))?;
        }
        Ok(())
    }

    add_tree(&mut writer, opts, dir, std::path::Path::new(""))?;
    let finished = writer.finish().map_err(|e| format!("zip finish: {}", e))?;
    Ok(finished.into_inner())
}

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
fn is_presigned_storage_url(url: &str) -> bool {
    url.contains("X-Amz-Signature=")
        || url.contains("X-Amz-Credential=")
        || url.contains("X-Amz-Algorithm=")
        // Supabase Storage signed URLs carry the JWT in the query string.
        || url.contains("token=")
}

fn download_request(
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
pub fn team_skill_uninstall(
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

/// Zip a personal skill directory and return sha256 + size (local only — no OSS).
/// Prefer `team_skill_pack_and_upload` for Share; this remains for hash checks.
#[tauri::command]
pub async fn team_skill_pack(
    dir_path: String,
    slug: String,
) -> Result<TeamSkillPackResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = slug.trim().to_string();
        validate_slug(&slug)?;
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
        Ok(TeamSkillPackResult {
            content_hash,
            size: zip_bytes.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("team skill pack task failed: {}", e))?
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
pub fn team_skill_rebaseline(
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

#[tauri::command]
pub fn team_skill_list_installed() -> Result<Vec<InstalledTeamSkill>, String> {
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
enum EffectiveSkillSource {
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

fn hosted_team_skills_dir(team_id: &str) -> std::path::PathBuf {
    crate::commands::amuxd_team_state_dir(team_id)
        .join("cloud")
        .join("skills")
}

/// Resolve the copy OpenCode actually sees for this slug. The daemon registers
/// its hosted-Agent root before `~/.agents/skills`, so the first existing
/// directory wins. A cloud directory for another (non-active) team is ignored:
/// this desktop cannot be running it through the local daemon.
fn effective_team_skill_dir(
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
fn preferred_team_skill_dir(
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
pub fn team_skill_installed_dir(slug: String, team_id: Option<String>) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    Ok(effective_team_skill_dir(&slug, team_id.as_deref())?
        .0
        .display()
        .to_string())
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
fn belongs_to_another_team(origin: &SkillOrigin, team_id: Option<&str>) -> bool {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillFileDiff {
    pub path: String,
    /// `None` when the side is absent or not UTF-8.
    pub baseline: Option<String>,
    pub current: Option<String>,
    pub binary: bool,
}

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillVersionRangeDiffRequest {
    pub from: TeamSkillInstallRequest,
    pub to: TeamSkillInstallRequest,
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

/// Read structured metadata from the working copy's SKILL.md frontmatter.
#[tauri::command]
pub fn team_skill_read_draft_metadata(
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

fn recovery_record_for_path(source: &std::path::Path) -> Option<DraftRecoveryRecord> {
    let sidecar = source.join(".clawhub").join("recovery.json");
    if sidecar.is_file() {
        if let Ok(text) = std::fs::read_to_string(&sidecar) {
            if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(&text) {
                return Some(rec);
            }
        }
    }
    let trash = trash_dir().ok()?;
    let log = trash.join("recovery.jsonl");
    if !log.is_file() {
        return None;
    }
    let canonical = std::fs::canonicalize(source).ok()?;
    let content = std::fs::read_to_string(&log).ok()?;
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<DraftRecoveryRecord>(line).ok())
        .find(|rec| {
            std::fs::canonicalize(&rec.path)
                .ok()
                .is_some_and(|p| p == canonical)
        })
}

/// Load recovery records from trash sidecars and the JSONL index.
///
/// Sidecars are authoritative; JSONL is a rebuildable cache for fast listing.
fn load_draft_recovery_records(trash: &std::path::Path) -> Vec<DraftRecoveryRecord> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();

    let mut push = |rec: DraftRecoveryRecord| {
        if !std::path::Path::new(&rec.path).is_dir() {
            return;
        }
        if seen.insert(rec.path.clone()) {
            out.push(rec);
        }
    };

    if let Ok(entries) = std::fs::read_dir(trash) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let sidecar = path.join(".clawhub").join("recovery.json");
            if !sidecar.is_file() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&sidecar) {
                if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(&text) {
                    push(rec);
                }
            }
        }
    }

    let log = trash.join("recovery.jsonl");
    if log.is_file() {
        if let Ok(content) = std::fs::read_to_string(&log) {
            for line in content.lines() {
                if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(line) {
                    push(rec);
                }
            }
        }
    }

    out
}

/// Recent draft recovery records (discarded packs moved to trash).
#[tauri::command]
pub fn team_skill_list_draft_recoveries(
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
pub fn team_skill_discard_local(slug: String, team_id: Option<String>) -> Result<String, String> {
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

/// Move a skill directory into the trash and return where it went.
///
/// Every path that takes something away from the user goes through here rather
/// than `remove_dir_all`, so "undo" is always a rename back rather than a
/// restore from nothing.
fn move_to_trash(
    target: &std::path::Path,
    slug: &str,
    recovery: Option<DraftRecoveryContext>,
) -> Result<String, String> {
    let trash = trash_dir()?;
    std::fs::create_dir_all(&trash).map_err(|e| format!("Failed to create trash dir: {}", e))?;
    let dest = trash.join(format!("{}-{}", slug, now_millis()));
    std::fs::rename(target, &dest).map_err(|e| format!("Failed to move skill aside: {}", e))?;
    if let Some(ctx) = recovery {
        let rec = DraftRecoveryRecord {
            slug: slug.to_string(),
            path: dest.display().to_string(),
            at: now_millis(),
            reason: ctx.reason,
            base_version: ctx.base_version,
            team_id: ctx.team_id,
        };
        if let Err(e) = record_draft_recovery(&dest, &rec) {
            // Undo depends on recovery metadata; without it the pack would sit in
            // trash invisibly. Put it back where the user left it.
            if let Err(rollback) = std::fs::rename(&dest, target) {
                return Err(format!(
                    "{e}; failed to restore skill after recovery write error: {rollback}"
                ));
            }
            return Err(e);
        }
    }
    // Swept here rather than on a timer: this is the only thing that ever adds
    // to the directory, so it is the only place that can let it grow.
    prune_trash(&trash);
    Ok(dest.display().to_string())
}

#[derive(Debug, Clone)]
struct DraftRecoveryContext {
    reason: String,
    base_version: Option<i64>,
    team_id: Option<String>,
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

fn record_draft_recovery(dest: &std::path::Path, rec: &DraftRecoveryRecord) -> Result<(), String> {
    let sidecar_dir = dest.join(".clawhub");
    std::fs::create_dir_all(&sidecar_dir)
        .map_err(|e| format!("Failed to write recovery metadata: {}", e))?;
    let line = serde_json::to_string(rec)
        .map_err(|e| format!("Failed to serialize recovery metadata: {}", e))?;
    std::fs::write(sidecar_dir.join("recovery.json"), &line)
        .map_err(|e| format!("Failed to write recovery metadata: {}", e))?;

    append_recovery_log(rec);
    Ok(())
}

/// Best-effort index append; listing can rebuild from sidecars.
fn append_recovery_log(rec: &DraftRecoveryRecord) {
    let Ok(trash) = trash_dir() else {
        return;
    };
    let log = trash.join("recovery.jsonl");
    let Ok(line) = serde_json::to_string(rec) else {
        return;
    };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{line}")
        });
}

fn draft_recovery_context(
    target: &std::path::Path,
    reason: &str,
    team_id: Option<&str>,
) -> DraftRecoveryContext {
    let base_version = read_origin(target).and_then(|o| o.installed_version.parse::<i64>().ok());
    DraftRecoveryContext {
        reason: reason.to_string(),
        base_version,
        team_id: team_id.map(str::to_string),
    }
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
pub fn team_skill_retire_personal(dir_path: String, slug: String) -> Result<String, String> {
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

/// Resolve a caller-supplied backup path, refusing anything that is not really
/// inside our own trash.
///
/// The path arrives from the frontend and is used as the source of a `rename`
/// into the skills directory, so a permissive check here is a way to move an
/// arbitrary directory. `Path::starts_with` alone is not that check: it is
/// purely lexical, so `<trash>/../../elsewhere` matches the prefix while naming
/// somewhere else entirely. Canonicalising both sides collapses the `..`
/// segments and resolves symlinks, and it fails outright on a path that does
/// not exist — which is the other case this has to reject.
fn resolve_trashed_source(
    trash: &std::path::Path,
    raw: &str,
) -> Result<std::path::PathBuf, String> {
    let reject = || "Not a restorable skill backup".to_string();
    let source = std::fs::canonicalize(raw).map_err(|_| reject())?;
    let root = std::fs::canonicalize(trash).map_err(|_| reject())?;
    if !source.is_dir() || source == root || !source.starts_with(&root) {
        return Err(reject());
    }
    Ok(source)
}

/// Undo a discard. The trashed copy wins over whatever is installed now, which
/// is the point: the user asked for their edits back.
#[tauri::command]
pub fn team_skill_restore_trashed(
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
pub fn team_skill_fork(
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

#[cfg(test)]
mod tests {
    use super::*;
    use teamclu_types::skill_frontmatter::parse_frontmatter;

    fn request(slug: &str) -> TeamSkillInstallRequest {
        TeamSkillInstallRequest {
            workspace_path: None,
            slug: slug.to_string(),
            team_id: Some("team-a".into()),
            download_url: String::new(),
            access_token: None,
            version: 3,
            owner: Some("张三".into()),
            category: Some("devops".into()),
            summary: Some("发布前检查清单".into()),
            when_to_use: Some("发布前确认 CI 绿、迁移已跑".into()),
            when_not_to_use: Some("不要用于本地开发\n不要用于 hotfix 流程".into()),
            requires: Some(vec!["macos".into()]),
            is_global: false,
            force: false,
            archive_unmanaged: false,
        }
    }

    fn rebaseline_request(slug: &str, version: i64) -> TeamSkillRebaselineRequest {
        TeamSkillRebaselineRequest {
            workspace_path: None,
            slug: slug.to_string(),
            team_id: Some("team-a".into()),
            version,
            owner: Some("张三".into()),
            category: Some("devops".into()),
            summary: Some("发布前检查清单".into()),
            when_to_use: Some("发布前确认 CI".into()),
            when_not_to_use: None,
            requires: None,
        }
    }

    fn set_active_team(team_id: &str) {
        let root = crate::commands::amuxd_home_dir();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("daemon.toml"),
            format!("active_team = \"{team_id}\"\n"),
        )
        .unwrap();
    }

    fn write_installed_skill(path: &std::path::Path, team_id: &str, version: i64) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("SKILL.md"), "---\nname: say-hello\n---\nhello\n").unwrap();
        stamp_installed_state(
            path,
            InstalledStamp {
                slug: "say-hello",
                version,
                team_id: Some(team_id),
                shipped: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn effective_copy_prefers_the_active_hosted_agent_projection() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");
        let member = global_skills_dir().unwrap().join("say-hello");
        let hosted = hosted_team_skills_dir("team-a").join("say-hello");
        write_installed_skill(&member, "team-a", 2);
        write_installed_skill(&hosted, "team-a", 2);

        let (resolved, source) = effective_team_skill_dir("say-hello", Some("team-a")).unwrap();
        assert_eq!(resolved, hosted);
        assert_eq!(source, EffectiveSkillSource::HostedAgent);
    }

    #[test]
    fn inspection_and_rebaseline_use_the_same_hosted_copy() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");
        let member = global_skills_dir().unwrap().join("say-hello");
        let hosted = hosted_team_skills_dir("team-a").join("say-hello");
        write_installed_skill(&member, "team-a", 2);
        write_installed_skill(&hosted, "team-a", 2);
        std::fs::write(
            hosted.join("SKILL.md"),
            "---\nname: say-hello\n---\nhi, arya\n",
        )
        .unwrap();

        let before = inspect_team_skill("say-hello".into(), Some(2), Some("team-a".into()), None)
            .expect("inspect hosted edit");
        assert_eq!(before.state, "dirty");
        assert_eq!(before.source, "hosted-agent");
        assert_eq!(before.modified, vec!["SKILL.md"]);

        let result = team_skill_rebaseline(rebaseline_request("say-hello", 3))
            .expect("rebaseline hosted edit");
        assert_eq!(std::path::PathBuf::from(result.path), hosted);
        assert_eq!(read_origin(&hosted).unwrap().installed_version, "3");
        assert_eq!(installed_state(&hosted), DirtyState::Clean);
        assert_eq!(read_origin(&member).unwrap().installed_version, "2");
    }

    /// A workspace `opencode.json` carrying a decision about `deploy-check`.
    fn workspace_with_permission(value: &str) -> tempfile::TempDir {
        let ws = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            ws.path().join("opencode.json"),
            serde_json::json!({
                "permission": { "bash": "ask", "skill": { "deploy-check": value, "other": "allow" } }
            })
            .to_string(),
        )
        .unwrap();
        ws
    }

    fn skill_permissions(ws: &std::path::Path) -> serde_json::Value {
        let raw = std::fs::read_to_string(ws.join("opencode.json")).unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["permission"]["skill"].clone()
    }

    /// The whole reason this fix exists: a slug is reusable, so an approval that
    /// outlives its pack ends up governing whatever content claims the name next.
    #[test]
    fn uninstall_forgets_the_skills_permission() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        let ws = workspace_with_permission("allow");
        std::fs::create_dir_all(global_skills_dir().unwrap().join("deploy-check")).unwrap();

        team_skill_uninstall(
            Some(ws.path().display().to_string()),
            "deploy-check".into(),
            Some(true),
        )
        .expect("uninstall");

        let skills = skill_permissions(ws.path());
        assert!(skills.get("deploy-check").is_none(), "the entry must go");
        // Only this skill's. The map is shared with every other skill in the
        // workspace, and with the non-skill defaults beside it.
        assert_eq!(skills["other"], "allow");
        let raw = std::fs::read_to_string(ws.path().join("opencode.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["permission"]["bash"], "ask");
    }

    /// The daemon watches this file and treats a permission write as "restart
    /// the runtime". Uninstall runs unattended on every reconcile tick, so a
    /// no-op rewrite would churn the agent for nothing.
    #[test]
    fn uninstall_leaves_the_config_untouched_when_there_is_no_entry() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        let ws = tempfile::tempdir().expect("tempdir");
        let config = ws.path().join("opencode.json");
        std::fs::write(
            &config,
            "{\"permission\":{\"skill\":{\"other\":\"allow\"}}}",
        )
        .unwrap();
        let before = std::fs::read_to_string(&config).unwrap();

        team_skill_uninstall(
            Some(ws.path().display().to_string()),
            "deploy-check".into(),
            Some(true),
        )
        .expect("uninstall");

        assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
    }

    /// No config, or one that is not JSON, is a normal state — the reconcile
    /// calls this unattended and must not fail the removal over it.
    #[test]
    fn uninstall_survives_a_missing_or_unparseable_config() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());

        let bare = tempfile::tempdir().expect("tempdir");
        team_skill_uninstall(
            Some(bare.path().display().to_string()),
            "deploy-check".into(),
            Some(true),
        )
        .expect("uninstall with no config");

        let broken = tempfile::tempdir().expect("tempdir");
        std::fs::write(broken.path().join("opencode.json"), "{not json").unwrap();
        team_skill_uninstall(
            Some(broken.path().display().to_string()),
            "deploy-check".into(),
            Some(true),
        )
        .expect("uninstall with broken config");
    }

    #[test]
    fn detects_presigned_storage_urls() {
        assert!(is_presigned_storage_url(
            "https://s3.example/bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=x&X-Amz-Signature=y"
        ));
        assert!(is_presigned_storage_url(
            "https://supabase.example/storage/v1/object/sign/team-skills/x?token=abc.def"
        ));
        assert!(!is_presigned_storage_url(
            "https://api.example/v1/teams/t/skills/s/versions/1/download"
        ));
    }

    #[test]
    fn writes_structured_fields_and_keeps_the_body() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("deploy-check");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: deploy-check\ndescription: old blurb\n---\n# Deploy check\n\nsteps\n",
        )
        .unwrap();

        let wrote = write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
        assert!(wrote);

        let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
        let parsed = parse_frontmatter(&out);
        assert_eq!(parsed.string("category"), Some("devops"));
        assert_eq!(parsed.string("owner"), Some("张三"));
        // The multi-line field is the one the old regex parser could not carry.
        assert_eq!(
            parsed.string("when_not_to_use"),
            Some("不要用于本地开发\n不要用于 hotfix 流程")
        );
        assert_eq!(parsed.string("version"), Some("3"));
        assert_eq!(parsed.string("source"), Some("team"));
        // description tracks summary so pre-existing readers still see a blurb.
        assert_eq!(parsed.string("description"), Some("发布前检查清单"));
        assert_eq!(parsed.body, "# Deploy check\n\nsteps\n");
    }

    #[test]
    fn a_package_without_skill_md_installs_but_reports_no_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("empty");
        std::fs::create_dir_all(&skill).unwrap();
        assert!(!write_install_frontmatter(&skill, &request("empty")).unwrap());
    }

    #[test]
    fn the_baseline_is_taken_after_the_frontmatter_rewrite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("deploy-check");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: deploy-check\ndescription: old blurb\n---\nbody\n",
        )
        .unwrap();

        // The real install order. Reversing these two lines is the bug this
        // test exists for: a baseline taken before the rewrite describes the
        // archive, not the disk, and every skill would be born in conflict.
        write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
        stamp_installed_state(
            &skill,
            InstalledStamp {
                slug: "deploy-check",
                version: 3,
                team_id: Some("team-a"),
                shipped: None,
            },
        )
        .unwrap();

        assert_eq!(installed_state(&skill), DirtyState::Clean);
        let origin = read_origin(&skill).expect("origin");
        assert_eq!(origin.installed_version, "3");
        assert_eq!(origin.registry, SOURCE_TEAM);
    }

    #[test]
    fn an_edit_after_install_is_caught() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("deploy-check");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: deploy-check\n---\nbody\n",
        )
        .unwrap();
        write_install_frontmatter(&skill, &request("deploy-check")).unwrap();
        stamp_installed_state(
            &skill,
            InstalledStamp {
                slug: "deploy-check",
                version: 3,
                team_id: Some("team-a"),
                shipped: None,
            },
        )
        .unwrap();

        let path = skill.join("SKILL.md");
        let edited = std::fs::read_to_string(&path).unwrap() + "\nmy own note\n";
        std::fs::write(&path, edited).unwrap();

        match installed_state(&skill) {
            DirtyState::Dirty {
                modified,
                deleted,
                added,
            } => {
                assert_eq!(modified, vec!["SKILL.md".to_string()]);
                assert!(deleted.is_empty());
                assert!(added.is_empty());
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    /// A file dropped into an installed pack is dirt, even though every file
    /// the install laid down is untouched: publishing measures the whole
    /// directory, so this one would ship with the next version.
    #[test]
    fn a_file_added_beside_the_pack_is_dirty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("deploy-check");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: deploy-check\n---\nbody\n",
        )
        .unwrap();
        stamp_installed_state(
            &skill,
            InstalledStamp {
                slug: "deploy-check",
                version: 3,
                team_id: Some("team-a"),
                shipped: None,
            },
        )
        .unwrap();

        std::fs::write(skill.join("notes.md"), "mine\n").unwrap();

        match installed_state(&skill) {
            DirtyState::Dirty {
                modified,
                deleted,
                added,
            } => {
                assert!(modified.is_empty(), "nothing the install wrote changed");
                assert!(deleted.is_empty());
                assert_eq!(added, vec!["notes.md".to_string()]);
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    #[test]
    fn empty_optional_fields_are_not_emitted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("bare");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: bare\n---\nbody\n").unwrap();

        let mut req = request("bare");
        req.owner = None;
        req.when_not_to_use = Some("   ".into());
        req.requires = Some(vec![]);
        write_install_frontmatter(&skill, &req).unwrap();

        let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
        let parsed = parse_frontmatter(&out);
        assert_eq!(parsed.string("owner"), None);
        assert_eq!(parsed.string("when_not_to_use"), None);
        assert!(parsed.data.get("requires").is_none());
    }

    fn trashed(trash: &std::path::Path, name: &str) -> std::path::PathBuf {
        let dir = trash.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "body\n").unwrap();
        dir
    }

    fn origin_for(team: Option<&str>) -> SkillOrigin {
        SkillOrigin {
            version: ORIGIN_VERSION,
            registry: SOURCE_TEAM.to_string(),
            slug: "deploy-check".into(),
            installed_version: "3".into(),
            installed_at: 1,
            team_id: team.map(str::to_owned),
            files: None,
        }
    }

    /// One flat root serves every team the user belongs to, and a slug names
    /// exactly one directory — so two teams that both publish `deploy-check`
    /// contend for the same one. With the team ignored the reconcile could not
    /// see the contention: on differing version numbers it overwrote the other
    /// team's bytes, and on matching ones — the common case, every team's
    /// versions starting at 1 — it did nothing and left the runtime serving one
    /// team's file as the other team's skill.
    #[test]
    fn a_pack_installed_for_another_team_is_not_ours() {
        assert!(belongs_to_another_team(
            &origin_for(Some("team-a")),
            Some("team-b")
        ));
        assert!(!belongs_to_another_team(
            &origin_for(Some("team-a")),
            Some("team-a")
        ));
    }

    /// Neither side knowing is not evidence either way, and guessing "somebody
    /// else's" would strand every pack written before the field existed in a
    /// conflict nobody can resolve.
    #[test]
    fn an_unrecorded_team_never_makes_a_pack_foreign() {
        assert!(!belongs_to_another_team(&origin_for(None), Some("team-b")));
        assert!(!belongs_to_another_team(&origin_for(Some("team-a")), None));
        assert!(!belongs_to_another_team(
            &origin_for(Some("team-a")),
            Some("  ")
        ));
    }

    #[test]
    fn a_directory_with_no_team_record_is_not_claimed() {
        // A skill the user wrote straight into the skills root, colliding with
        // a team slug. Claiming it — writing a team record over it and calling
        // it clean at whatever version the server named — registered their
        // content as that team version, and auto-follow then saw nothing to do.
        // Reporting it as ours-is-not-here lets the install overwrite instead,
        // which is what the user asked for by installing.
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("hand-written");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "mine, not the team's\n").unwrap();

        assert_eq!(installed_state(&skill), DirtyState::Unmanaged);
        assert!(read_origin(&skill).is_none(), "nothing was written over it");
        // And the installer does not treat it as a local edit to protect, so an
        // install proceeds and overwrites what the package ships.
        assert!(!installed_state(&skill).is_dirty());
    }

    #[test]
    fn a_real_backup_resolves() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trash = tmp.path().join("trash");
        let backup = trashed(&trash, "deploy-check-1000");
        let resolved = resolve_trashed_source(&trash, backup.to_str().unwrap()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&backup).unwrap());
    }

    #[test]
    fn a_traversal_out_of_the_trash_is_refused() {
        // The lexical `starts_with` this replaced accepted exactly this path,
        // which made the restore a way to move any directory on the machine
        // into ~/.agents/skills.
        let tmp = tempfile::tempdir().expect("tempdir");
        let trash = tmp.path().join("trash");
        std::fs::create_dir_all(&trash).unwrap();
        let outside = tmp.path().join("not-trash");
        std::fs::create_dir_all(&outside).unwrap();

        let escape = trash.join("..").join("not-trash");
        assert!(escape.starts_with(&trash), "the lexical check still passes");
        assert!(resolve_trashed_source(&trash, escape.to_str().unwrap()).is_err());
    }

    #[test]
    fn the_trash_root_itself_is_not_a_backup() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trash = tmp.path().join("trash");
        std::fs::create_dir_all(&trash).unwrap();
        assert!(resolve_trashed_source(&trash, trash.to_str().unwrap()).is_err());
    }

    #[test]
    fn pruning_keeps_the_recent_and_drops_the_stale() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trash = tmp.path().join("trash");
        let now = now_millis();
        let fresh = trashed(&trash, &format!("fresh-{}", now - 1000));
        let old = trashed(&trash, &format!("old-{}", now - TRASH_TTL_MS - 1));
        // A name with no parsable timestamp is somebody else's business.
        let foreign = trashed(&trash, "not-ours");

        prune_trash(&trash);

        assert!(
            fresh.is_dir(),
            "a pack discarded seconds ago is still undoable"
        );
        assert!(!old.exists(), "a pack past the retention window is swept");
        assert!(foreign.is_dir());
    }

    #[test]
    fn pruning_bounds_the_count_even_when_everything_is_fresh() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trash = tmp.path().join("trash");
        let now = now_millis();
        // Discarded in one sitting, so the age bound never fires and only the
        // count can stop this directory from growing.
        let dirs: Vec<_> = (0..TRASH_MAX_ENTRIES + 5)
            .map(|i| trashed(&trash, &format!("skill-{}", now - i as u64)))
            .collect();

        prune_trash(&trash);

        let left = std::fs::read_dir(&trash).unwrap().count();
        assert_eq!(left, TRASH_MAX_ENTRIES);
        // The newest survive; the oldest five are the ones that went.
        assert!(dirs[0].is_dir());
        assert!(!dirs[TRASH_MAX_ENTRIES + 4].exists());
    }

    #[test]
    fn cloud_api_client_builds() {
        build_cloud_api_client().expect("http1 + rustls client");
    }

    #[test]
    fn restore_into_a_team_requires_a_matching_recovery_record() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");

        let source = global_skills_dir().unwrap().join("say-hello");
        write_installed_skill(&source, "team-a", 1);

        let trashed = team_skill_discard_local("say-hello".into(), Some("team-a".into()))
            .expect("discard writes recovery metadata");
        assert!(std::path::Path::new(&trashed)
            .join(".clawhub/recovery.json")
            .is_file());

        let restored =
            team_skill_restore_trashed(trashed.clone(), "say-hello".into(), Some("team-a".into()))
                .expect("same team + slug restores");
        assert!(std::path::Path::new(&restored).is_dir());
    }

    #[test]
    fn restore_into_a_team_rejects_missing_or_mismatched_recovery() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");

        let trash = trash_dir().unwrap();
        std::fs::create_dir_all(&trash).unwrap();
        // A second in the past, deliberately: `move_to_trash` names its own
        // destination `{slug}-{now_millis()}`, so on a runner fast enough to put
        // this line and the discard below in the same millisecond, that rename
        // would target this very directory and fail with ENOTEMPTY.
        let orphan = trash.join(format!("say-hello-{}", now_millis() - 1_000));
        write_installed_skill(&orphan, "team-a", 1);

        let err = team_skill_restore_trashed(
            orphan.display().to_string(),
            "say-hello".into(),
            Some("team-a".into()),
        )
        .expect_err("no recovery record");
        assert!(err.contains("no recovery record"), "{err}");

        let source = global_skills_dir().unwrap().join("say-hello");
        write_installed_skill(&source, "team-a", 1);
        let trashed =
            team_skill_discard_local("say-hello".into(), Some("team-a".into())).expect("discard");

        let wrong_team =
            team_skill_restore_trashed(trashed.clone(), "say-hello".into(), Some("team-b".into()))
                .expect_err("other team");
        assert!(wrong_team.contains("another team"), "{wrong_team}");

        let wrong_slug =
            team_skill_restore_trashed(trashed, "other-skill".into(), Some("team-a".into()))
                .expect_err("other slug");
        assert!(wrong_slug.contains("different skill"), "{wrong_slug}");
    }

    #[test]
    fn discard_rolls_back_when_recovery_metadata_cannot_be_written() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");

        let source = global_skills_dir().unwrap().join("blocked-recovery");
        write_installed_skill(&source, "team-a", 1);
        // `write_installed_skill` already created `.clawhub/` to hold origin.json,
        // so the blocker has to sit on the sidecar file itself: a directory where
        // `record_draft_recovery` must write `recovery.json` fails that write on
        // every platform, without the chmod dance the sibling test needs.
        std::fs::create_dir_all(source.join(".clawhub").join("recovery.json")).unwrap();

        let err = team_skill_discard_local("blocked-recovery".into(), Some("team-a".into()))
            .expect_err("sidecar write should fail");
        assert!(err.contains("recovery metadata"), "{err}");
        assert!(source.is_dir(), "skill restored to original location");

        let trash = trash_dir().unwrap();
        let orphan = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("blocked-recovery-")
            });
        assert!(!orphan, "no orphan trash entry after rollback");
    }

    #[test]
    #[cfg(unix)]
    fn discard_succeeds_when_recovery_log_append_fails() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_home::HomeGuard::set(home.path());
        set_active_team("team-a");

        let trash = trash_dir().unwrap();
        std::fs::create_dir_all(&trash).unwrap();
        let log = trash.join("recovery.jsonl");
        std::fs::write(&log, "existing\n").unwrap();
        std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o444)).unwrap();

        let source = global_skills_dir().unwrap().join("say-hello");
        write_installed_skill(&source, "team-a", 1);

        let trashed = team_skill_discard_local("say-hello".into(), Some("team-a".into()))
            .expect("sidecar success is enough");
        assert!(std::path::Path::new(&trashed)
            .join(".clawhub/recovery.json")
            .is_file());

        let listed =
            team_skill_list_draft_recoveries(Some("say-hello".into()), Some("team-a".into()), None)
                .expect("list scans sidecars");
        assert!(listed.iter().any(|rec| rec.path == trashed));
    }
}
