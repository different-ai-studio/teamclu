//! Materialises the team skills a shared agent is supposed to have.
//!
//! `cloud/skills` is a **remote snapshot cache**: pull the registry zip, keep
//! it for dirty comparison. The working copy OpenCode loads is
//! `~/.agents/skills`. Cache updates overwrite unconditionally. Working-copy
//! updates skip a dirty pack so a local draft is not clobbered.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use teamclu_skillpack::{
    apply_zip_mode, build_manifest_for, commit_staged_pack, inspect, list_managed_paths,
    read_origin, sanitize_zip_path, sha256_hex, write_origin, write_registry_frontmatter,
    RegistryFields, SkillOrigin, ORIGIN_VERSION, SOURCE_TEAM,
};

use crate::backend::{Backend, TeamSkillRow};
use crate::config::global_team_store::global_team_cloud_dir;

/// How often a hosted agent's skill set is re-checked.
///
/// Ten minutes rather than the 60s the team MCP/env caches use: those fetch a
/// few KB of JSON on a lazy hot path, while this downloads and unpacks
/// archives. Attaching that to a spawn path would put unpredictable latency in
/// front of every agent start, so this runs on its own schedule and the spawn
/// path never waits for it.
pub const TEAM_SKILLS_TTL: Duration = Duration::from_secs(600);

/// `~/.amuxd/teams/<team_id>/cloud/skills` — the daemon's own install root.
pub fn team_cloud_skills_dir(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join("skills")
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct TeamSkillReconcileOutcome {
    pub installed: usize,
    pub removed: usize,
}

impl TeamSkillReconcileOutcome {
    pub fn changed(self) -> bool {
        self.installed > 0 || self.removed > 0
    }
}

pub struct TeamSkillReconciler {
    backend: Arc<dyn Backend>,
    http: reqwest::Client,
    last_fetch: AsyncMutex<HashMap<String, Instant>>,
    reconcile_lock: AsyncMutex<()>,
}

/// The version auto-follow will put on disk for a desired row.
///
/// The registry's `installed_version` records what an agent last *reported*, so
/// it is behind by one tick after every publish and can be stale forever if a
/// writeback failed. Only `latest_version` says what the team wants. Anything
/// that reports install health has to compute the target the same way the
/// reconciler does, or it calls a pending update "installed" and a completed
/// one "drift".
pub(crate) fn desired_version(row: &TeamSkillRow) -> i64 {
    if row.latest_version > 0 {
        row.latest_version
    } else {
        1
    }
}

impl TeamSkillReconciler {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            http: reqwest::Client::new(),
            last_fetch: AsyncMutex::new(HashMap::new()),
            reconcile_lock: AsyncMutex::new(()),
        }
    }

    /// Reconcile if the TTL has expired.
    pub async fn reconcile(&self, team_id: &str) -> TeamSkillReconcileOutcome {
        if let Some(fetched_at) = self.last_fetch.lock().await.get(team_id) {
            if fetched_at.elapsed() < TEAM_SKILLS_TTL {
                return TeamSkillReconcileOutcome::default();
            }
        }
        self.reconcile_now(team_id).await
    }

    /// Reconcile regardless of the TTL. Used on startup and by the MQTT nudge,
    /// which only exists to pull the next tick forward.
    pub async fn reconcile_now(&self, team_id: &str) -> TeamSkillReconcileOutcome {
        let _guard = self.reconcile_lock.lock().await;
        let root = team_cloud_skills_dir(team_id);
        let Some(outcome) = self.fetch_and_apply(team_id, &root).await else {
            return TeamSkillReconcileOutcome::default();
        };

        self.last_fetch
            .lock()
            .await
            .insert(team_id.to_string(), Instant::now());

        if outcome.changed() {
            tracing::info!(
                team_id,
                installed = outcome.installed,
                removed = outcome.removed,
                root = %root.display(),
                "team skills reconciled for hosted agent"
            );
        }
        outcome
    }

    /// Fetch the desired set and make `root` match it.
    ///
    /// `None` means the fetch failed (401 / 404 / 5xx / decode). The disk is
    /// left alone and the TTL is not advanced, so the next tick retries.
    /// Empty desired set is `Some` of an apply against `[]`.
    async fn fetch_and_apply(
        &self,
        team_id: &str,
        root: &Path,
    ) -> Option<TeamSkillReconcileOutcome> {
        let rows = match self.backend.team_skills(team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                // Leave the disk exactly as it is. An unreachable registry must
                // never read as "the team removed everything" — that would
                // strip a working agent of its skills every time the network
                // blinked, and the packs would only come back on the next
                // successful fetch.
                tracing::warn!(team_id, error = %e, "team skills fetch failed; keeping the installed set");
                return None;
            }
        };
        Some(self.apply(team_id, root, &rows).await)
    }

    async fn apply(
        &self,
        team_id: &str,
        root: &Path,
        rows: &[TeamSkillRow],
    ) -> TeamSkillReconcileOutcome {
        let mut outcome = TeamSkillReconcileOutcome::default();
        let mut on_disk = installed_versions(root);

        for row in rows.iter().filter(|r| r.installed) {
            let want = desired_version(row);
            let target = root.join(&row.slug);
            // The cache is a remote snapshot: always match the server, even if
            // something mutated the files. Dirty protection belongs on the
            // working copy (`~/.agents/skills`), not here.
            if on_disk.get(&row.slug).copied() != Some(want) {
                match self.install(team_id, root, row, want).await {
                    Ok(()) => {
                        outcome.installed += 1;
                        on_disk.insert(row.slug.clone(), want);
                    }
                    Err(e) => {
                        tracing::warn!(team_id, slug = %row.slug, version = want, error = %e, "team skill install failed; retrying next tick");
                        continue;
                    }
                }
            }
            sync_working_copy_from_cache(team_id, &row.slug, &target);

            // Report the version actually on disk back to the server. Auto-follow
            // moves packs on its own, so nothing else ever advances
            // `installed_version`; leaving it behind makes the registry claim
            // this agent is on v1 forever and `hasUpdate` never goes quiet.
            //
            // Driven off the freshly-fetched row rather than off "did we just
            // install", so a write that fails here is retried on the next tick
            // instead of being lost the moment the disk is already correct.
            let current = on_disk.get(&row.slug).copied();
            if let Some(version) = current.filter(|v| row.installed_version != Some(*v)) {
                if let Err(e) = self
                    .backend
                    .record_team_skill_install(team_id, &row.slug, version)
                    .await
                {
                    tracing::warn!(team_id, slug = %row.slug, version, error = %e, "recording team skill install failed; retrying next tick");
                }
            }
        }

        let wanted: std::collections::HashSet<&str> = rows
            .iter()
            .filter(|r| r.installed)
            .map(|r| r.slug.as_str())
            .collect();
        for slug in on_disk.keys() {
            if wanted.contains(slug.as_str()) {
                continue;
            }
            let dir = root.join(slug);
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => outcome.removed += 1,
                Err(e) => {
                    tracing::warn!(team_id, slug = %slug, error = %e, "team skill removal failed");
                }
            }
            remove_working_copy_if_ours(team_id, slug);
        }

        outcome
    }

    async fn install(
        &self,
        team_id: &str,
        root: &Path,
        row: &TeamSkillRow,
        version: i64,
    ) -> Result<(), String> {
        let download = self
            .backend
            .team_skill_download(team_id, &row.slug, version)
            .await
            .map_err(|e| format!("resolve download: {e}"))?;

        // The signed URL carries its own credentials; sending the daemon's
        // bearer token to object storage would leak it to a third party.
        let resp = self
            .http
            .get(&download.url)
            .send()
            .await
            .map_err(|e| format!("download: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("download returned HTTP {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("read download body: {e}"))?;

        if !download.content_hash.is_empty() {
            let actual = sha256_hex(&bytes);
            if actual != download.content_hash {
                return Err(format!(
                    "zip content_hash mismatch: expected {}, got {actual}",
                    download.content_hash
                ));
            }
        }
        if download.size > 0 && download.size as usize != bytes.len() {
            return Err(format!(
                "zip size mismatch: expected {}, got {}",
                download.size,
                bytes.len()
            ));
        }

        let target = root.join(&row.slug);
        let staging = tempfile::tempdir().map_err(|e| format!("staging dir: {e}"))?;
        extract_zip_to_dir(&bytes, staging.path())?;

        // Finish the new tree in staging — frontmatter then origin — and only
        // then make it live. Swap-then-origin left vN files next to a vN-1
        // baseline when origin write failed, which inspect reads as Dirty and
        // auto-follow never retries. See hosted-skill-reconcile-fail-closed.md.
        let shipped =
            list_managed_paths(staging.path()).map_err(|e| format!("list package files: {e}"))?;

        let requires = requires_list(row.requires.as_ref());
        write_registry_frontmatter(
            staging.path(),
            &RegistryFields {
                slug: &row.slug,
                version,
                owner: row.owner_actor_id.as_deref(),
                category: Some(&row.category),
                summary: Some(&row.summary),
                when_to_use: Some(&row.when_to_use),
                when_not_to_use: Some(&row.when_not_to_use),
                requires: requires.as_deref(),
            },
        )
        .map_err(|e| format!("frontmatter: {e}"))?;

        let files =
            build_manifest_for(staging.path(), &shipped).map_err(|e| format!("manifest: {e}"))?;
        write_origin(
            staging.path(),
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_TEAM.to_string(),
                slug: row.slug.clone(),
                installed_version: version.to_string(),
                installed_at: now_millis(),
                team_id: Some(team_id.to_string()),
                files: Some(files),
            },
        )
        .map_err(|e| format!("origin.json: {e}"))?;

        commit_staged_pack(&target, staging.path()).map_err(|e| format!("install files: {e}"))?;

        Ok(())
    }
}

/// Same refresh fan-out as [`apply_team_skill_outcome`], but for a local draft
/// edit that did not change the reconciler's install set.
pub async fn notify_team_skill_draft_changed(
    team_id: &str,
    backend: Option<&Arc<dyn Backend>>,
    refresh: Option<&Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    refresh_watch_registry: Option<
        &Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>,
    >,
) {
    apply_team_skill_outcome(
        team_id,
        TeamSkillReconcileOutcome {
            installed: 1,
            removed: 0,
        },
        backend,
        refresh,
        refresh_watch_registry,
    )
    .await;
}

/// Tell every local workspace of this team that its skill set moved.
///
/// The install root is outside every `refresh_watch` root — deliberately, since
/// it lives in the daemon's config dir rather than a worktree — so no
/// filesystem event fires and the signal has to be sent by hand. Same shape and
/// same reason as `team_cloud_config::apply_team_cloud_outcome`.
pub async fn apply_team_skill_outcome(
    team_id: &str,
    outcome: TeamSkillReconcileOutcome,
    backend: Option<&Arc<dyn Backend>>,
    refresh: Option<&Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    refresh_watch_registry: Option<
        &Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>,
    >,
) {
    if !outcome.changed() {
        return;
    }
    let Some(refresh) = refresh else {
        return;
    };

    for target in resolve_team_skill_refresh_targets(team_id, backend, refresh_watch_registry).await
    {
        if let Err(error) = refresh
            .record_change(
                &target.workspace_id,
                &target.workspace_path,
                crate::runtime::refresh::RefreshChangeKind::Skills,
                crate::runtime::refresh::RefreshSource::TeamSkillReconcile,
            )
            .await
        {
            tracing::warn!(
                workspace_id = target.workspace_id,
                workspace_path = %target.workspace_path.display(),
                error = %error,
                "failed to record skills refresh after team skill reconcile"
            );
            continue;
        }
        tracing::info!(
            team_id,
            workspace_id = %target.workspace_id,
            workspace_path = %target.workspace_path.display(),
            "team_skill_refresh_recorded"
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloudLookupStatus {
    Success,
    Failed,
    Unavailable,
}

impl CloudLookupStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Unavailable => "unavailable",
        }
    }
}

async fn resolve_team_skill_refresh_targets(
    team_id: &str,
    backend: Option<&Arc<dyn Backend>>,
    registry: Option<&Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
) -> Vec<crate::runtime::refresh::refresh_watch::WatchedWorkspace> {
    use crate::runtime::refresh::refresh_watch::WatchedWorkspace;

    let (cloud_targets, cloud_lookup_status) = match backend {
        Some(backend) => match backend
            .get_workspaces_by_agent(team_id, backend.actor_id())
            .await
        {
            Ok(rows) => {
                let mut cloud_targets = Vec::new();
                for row in rows {
                    let Some((path, _)) =
                        crate::config::workspace_path::listable_local_workspace(&row)
                    else {
                        continue;
                    };
                    cloud_targets.push(WatchedWorkspace::new(
                        row.id,
                        PathBuf::from(path),
                        Some(team_id),
                    ));
                }
                (cloud_targets, CloudLookupStatus::Success)
            }
            Err(e) => {
                tracing::warn!(
                    team_id,
                    error = %e,
                    "team skills changed but cloud workspace list failed; using team-matched runtime refresh targets"
                );
                (Vec::new(), CloudLookupStatus::Failed)
            }
        },
        None => (Vec::new(), CloudLookupStatus::Unavailable),
    };

    let (runtime_targets, unknown_skipped) = match registry {
        Some(registry) => {
            let snapshot = registry.snapshot().await;
            let unknown_skipped = snapshot
                .iter()
                .filter(|workspace| workspace.team_id.is_none())
                .count();
            if unknown_skipped > 0 {
                tracing::warn!(
                    team_id,
                    unknown_skipped,
                    "skipping refresh-watch workspaces with unknown team_id"
                );
            }
            (registry.snapshot_for_team(team_id).await, unknown_skipped)
        }
        None => (Vec::new(), 0),
    };

    let cloud_count = cloud_targets.len();
    let runtime_count = runtime_targets.len();
    let targets = merge_refresh_targets(cloud_targets, runtime_targets);
    tracing::info!(
        team_id,
        cloud_count,
        runtime_count,
        unknown_skipped,
        deduped_count = targets.len(),
        cloud_lookup_status = cloud_lookup_status.as_str(),
        "team_skill_refresh_targets_resolved"
    );
    if targets.is_empty() {
        tracing::warn!(
            team_id,
            cloud_lookup_status = cloud_lookup_status.as_str(),
            "team skills changed but no trusted refresh targets were found"
        );
    }
    targets
}

fn merge_refresh_targets(
    cloud_targets: Vec<crate::runtime::refresh::refresh_watch::WatchedWorkspace>,
    runtime_targets: Vec<crate::runtime::refresh::refresh_watch::WatchedWorkspace>,
) -> Vec<crate::runtime::refresh::refresh_watch::WatchedWorkspace> {
    let mut by_workspace_id = HashMap::new();
    // Runtime targets are inserted last: RuntimeStart's effective path wins
    // over a stale cloud path for the same workspace identity.
    for target in cloud_targets.into_iter().chain(runtime_targets) {
        by_workspace_id.insert(target.workspace_id.clone(), target);
    }
    let mut targets: Vec<_> = by_workspace_id.into_values().collect();
    targets.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
    targets
}

/// Which packs are in this root, and at what version, from each pack's own
/// `origin.json`.
fn working_copy_dir(slug: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".agents").join("skills").join(slug))
}

/// Mirror the cache into `~/.agents/skills` when that working copy is not a
/// local draft. Personal / foreign packs are left alone.
fn sync_working_copy_from_cache(team_id: &str, slug: &str, cache: &Path) {
    if !cache.is_dir() {
        return;
    }
    let Some(work) = working_copy_dir(slug) else {
        return;
    };
    if work.is_dir() {
        if is_dirty_pack(&work) {
            return;
        }
        match read_origin(&work) {
            Some(origin)
                if origin.registry != SOURCE_TEAM
                    || origin
                        .team_id
                        .as_deref()
                        .is_some_and(|have| have != team_id) =>
            {
                return;
            }
            None => return,
            Some(_) => {}
        }
    }
    if let Err(e) = commit_staged_pack(&work, cache) {
        tracing::warn!(
            team_id,
            slug,
            error = %e,
            "failed to sync team skill working copy from cache"
        );
    }
}

fn remove_working_copy_if_ours(team_id: &str, slug: &str) {
    let Some(work) = working_copy_dir(slug) else {
        return;
    };
    if !work.is_dir() {
        return;
    }
    let Some(origin) = read_origin(&work) else {
        return;
    };
    if origin.registry != SOURCE_TEAM || origin.team_id.as_deref().is_some_and(|have| have != team_id)
    {
        return;
    }
    if is_dirty_pack(&work) {
        if let Err(e) = archive_removed_pack(team_id, &work, slug) {
            tracing::warn!(team_id, slug, error = %e, "team skill working-copy archive failed");
        }
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(&work) {
        tracing::warn!(team_id, slug, error = %e, "team skill working-copy removal failed");
    }
}

fn installed_versions(root: &Path) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Some(origin) = read_origin(&path) {
            if let Ok(version) = origin.installed_version.parse::<i64>() {
                out.insert(slug.to_string(), version);
            }
        }
    }
    out
}

/// `requires` is jsonb, so it can be anything. Only a list of strings means
/// something to the frontmatter; everything else is dropped rather than
/// stringified into noise the agent would have to read.
fn requires_list(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let out: Vec<String> = items
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_dirty_pack(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let baseline = read_origin(path).and_then(|o| o.files);
    inspect(path, baseline.as_ref()).is_dirty()
}

fn archive_removed_pack(team_id: &str, dir: &Path, slug: &str) -> Result<(), String> {
    let archive_root = global_team_cloud_dir(team_id).join("archived-skills");
    std::fs::create_dir_all(&archive_root).map_err(|e| format!("create archive dir: {e}"))?;
    let dest = archive_root.join(format!("{slug}-{}", now_millis()));
    std::fs::rename(dir, dest).map_err(|e| format!("archive skill {slug}: {e}"))?;
    Ok(())
}

/// Unpack a skill archive.
///
/// The entry-name guard comes from `teamclu-skillpack` so it has one definition
/// shared with the desktop installer; the loop is local because the two crates
/// are on different major versions of `zip`.
fn extract_zip_to_dir(zip_bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    use std::io::Read;

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;
    std::fs::create_dir_all(target_dir).map_err(|e| format!("create target dir: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let Some(safe_path) = sanitize_zip_path(file.name()) else {
            continue;
        };
        let out_path = target_dir.join(&safe_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create dir for {safe_path}: {e}"))?;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("read zip entry {safe_path}: {e}"))?;
        std::fs::write(&out_path, &buf).map_err(|e| format!("write {safe_path}: {e}"))?;
        // Shipped scripts have to stay runnable; see `apply_zip_mode` for why
        // dropping this makes the pack look permanently edited.
        apply_zip_mode(&out_path, file.unix_mode())
            .map_err(|e| format!("set mode {safe_path}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn installed_versions_reads_each_packs_own_record() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let skill = root.join("deploy-check");
        write(&skill, "SKILL.md", "body\n");
        write_origin(
            &skill,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_TEAM.to_string(),
                slug: "deploy-check".into(),
                installed_version: "4".into(),
                installed_at: 1,
                team_id: Some("team-a".into()),
                files: None,
            },
        )
        .unwrap();
        // A directory with no origin.json is not ours and stays invisible, so
        // the reconcile never deletes something it did not install.
        write(&root.join("hand-made"), "SKILL.md", "body\n");

        let found = installed_versions(root);
        assert_eq!(found.get("deploy-check"), Some(&4));
        assert!(!found.contains_key("hand-made"));
    }

    #[test]
    fn requires_keeps_string_lists_and_drops_the_rest() {
        assert_eq!(
            requires_list(Some(&serde_json::json!(["macos", "gh"]))),
            Some(vec!["macos".to_string(), "gh".to_string()])
        );
        assert_eq!(requires_list(Some(&serde_json::json!([]))), None);
        assert_eq!(
            requires_list(Some(&serde_json::json!({"mcp": "none"}))),
            None
        );
        assert_eq!(requires_list(None), None);
    }

    #[test]
    fn extraction_refuses_to_escape_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("pack");

        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            zip.start_file("SKILL.md", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"ok\n").unwrap();
            zip.start_file("../escaped.md", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"nope\n").unwrap();
            zip.finish().unwrap();
        }

        extract_zip_to_dir(&buf, &target).unwrap();

        assert!(target.join("SKILL.md").is_file());
        assert!(!tmp.path().join("escaped.md").exists());
    }

    fn watched(
        id: &str,
        path: &str,
        team_id: Option<&str>,
    ) -> crate::runtime::refresh::refresh_watch::WatchedWorkspace {
        crate::runtime::refresh::refresh_watch::WatchedWorkspace::new(
            id,
            PathBuf::from(path),
            team_id,
        )
    }

    fn changed_outcome() -> TeamSkillReconcileOutcome {
        TeamSkillReconcileOutcome {
            installed: 1,
            removed: 0,
        }
    }

    async fn apply_changed(
        team_id: &str,
        backend: Option<&Arc<dyn Backend>>,
        refresh: &Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>,
        registry: &Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>,
    ) {
        apply_team_skill_outcome(
            team_id,
            changed_outcome(),
            backend,
            Some(refresh),
            Some(registry),
        )
        .await;
    }

    fn seed_workspace(
        mock: &crate::backend::mock::MockBackend,
        id: &str,
        team_id: &str,
        path: &Path,
    ) {
        mock.state.lock().unwrap().workspaces_by_id.insert(
            id.to_string(),
            crate::backend::WorkspaceRow {
                id: id.to_string(),
                team_id: team_id.to_string(),
                path: Some(path.display().to_string()),
                archived: false,
                agent_id: Some(mock.actor_id().to_string()),
            },
        );
    }

    #[test]
    fn runtime_refresh_target_overrides_stale_cloud_path() {
        let targets = merge_refresh_targets(
            vec![watched("ws-1", "/tmp/stale-cloud-path", Some("team-1"))],
            vec![watched("ws-1", "/tmp/actual-runtime-path", Some("team-1"))],
        );
        assert_eq!(
            targets[0].workspace_path,
            Path::new("/tmp/actual-runtime-path")
        );
    }

    #[tokio::test]
    async fn team_skill_change_refreshes_runtime_target_without_cloud_inventory() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let registry = RefreshWatchRegistry::new(vec![watched(
            "ws-runtime",
            "/tmp/actual-runtime-path",
            Some("team-1"),
        )]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", None, &refresh, &registry).await;

        let state = refresh.workspace_state("ws-runtime").await.unwrap();
        assert_eq!(state.workspace_path, "/tmp/actual-runtime-path");
        assert!(state
            .change_kinds
            .contains(&crate::runtime::refresh::RefreshChangeKind::Skills));
        assert!(state
            .sources
            .contains(&crate::runtime::refresh::RefreshSource::TeamSkillReconcile));
    }

    #[tokio::test]
    async fn team_skill_change_skips_unknown_team_runtime_target() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let registry = RefreshWatchRegistry::new(vec![watched(
            "ws-unknown",
            "/tmp/unknown-runtime-path",
            None,
        )]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", None, &refresh, &registry).await;

        assert!(refresh.workspace_state("ws-unknown").await.is_none());
    }

    #[tokio::test]
    async fn team_skill_change_does_not_refresh_other_team_workspace() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let registry = RefreshWatchRegistry::new(vec![
            watched("ws-team-1", "/tmp/team-1", Some("team-1")),
            watched("ws-team-2", "/tmp/team-2", Some("team-2")),
        ]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", None, &refresh, &registry).await;

        assert!(refresh.workspace_state("ws-team-1").await.is_some());
        assert!(refresh.workspace_state("ws-team-2").await.is_none());
    }

    #[tokio::test]
    async fn unchanged_reconcile_outcome_does_not_record_refresh() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let registry = RefreshWatchRegistry::new(vec![watched(
            "ws-runtime",
            "/tmp/actual-runtime-path",
            Some("team-1"),
        )]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_team_skill_outcome(
            "team-1",
            TeamSkillReconcileOutcome {
                installed: 0,
                removed: 0,
            },
            None,
            Some(&refresh),
            Some(&registry),
        )
        .await;

        assert!(refresh.workspace_state("ws-runtime").await.is_none());
    }

    #[tokio::test]
    async fn cloud_lookup_failure_uses_only_exact_team_match() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let mock = crate::backend::mock::MockBackend::with_identity("team-1", "agent-1");
        mock.state.lock().unwrap().get_workspaces_by_team_error = Some("cloud down".to_string());
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let registry = RefreshWatchRegistry::new(vec![
            watched("ws-team-1", "/tmp/team-1", Some("team-1")),
            watched("ws-team-2", "/tmp/team-2", Some("team-2")),
            watched("ws-unknown", "/tmp/unknown", None),
        ]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", Some(&backend), &refresh, &registry).await;

        assert!(refresh.workspace_state("ws-team-1").await.is_some());
        assert!(refresh.workspace_state("ws-team-2").await.is_none());
        assert!(refresh.workspace_state("ws-unknown").await.is_none());
    }

    #[tokio::test]
    async fn backend_none_does_not_cross_team_refresh() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let registry = RefreshWatchRegistry::new(vec![
            watched("ws-team-1", "/tmp/team-1", Some("team-1")),
            watched("ws-team-2", "/tmp/team-2", Some("team-2")),
        ]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", None, &refresh, &registry).await;

        assert!(refresh.workspace_state("ws-team-1").await.is_some());
        assert!(refresh.workspace_state("ws-team-2").await.is_none());
    }

    #[tokio::test]
    async fn cloud_success_overlays_runtime_path_for_same_workspace_id() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let cloud_dir = tempfile::tempdir().unwrap();
        let runtime_dir = tempfile::tempdir().unwrap();
        let mock = crate::backend::mock::MockBackend::with_identity("team-1", "agent-1");
        seed_workspace(&mock, "ws-1", "team-1", cloud_dir.path());
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let registry = RefreshWatchRegistry::new(vec![watched(
            "ws-1",
            runtime_dir.path().to_str().unwrap(),
            Some("team-1"),
        )]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", Some(&backend), &refresh, &registry).await;

        let state = refresh.workspace_state("ws-1").await.unwrap();
        assert_eq!(
            state.workspace_path,
            runtime_dir.path().display().to_string()
        );
    }

    #[tokio::test]
    async fn cloud_success_does_not_refresh_other_team_runtime_target() {
        use crate::runtime::refresh::refresh_watch::RefreshWatchRegistry;

        let cloud_dir = tempfile::tempdir().unwrap();
        let mock = crate::backend::mock::MockBackend::with_identity("team-1", "agent-1");
        seed_workspace(&mock, "ws-cloud", "team-1", cloud_dir.path());
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let registry =
            RefreshWatchRegistry::new(vec![watched("ws-other", "/tmp/other-team", Some("team-2"))]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_changed("team-1", Some(&backend), &refresh, &registry).await;

        let cloud_state = refresh.workspace_state("ws-cloud").await.unwrap();
        assert_eq!(
            cloud_state.workspace_path,
            cloud_dir.path().display().to_string()
        );
        assert!(refresh.workspace_state("ws-other").await.is_none());
    }

    fn seed_installed_pack(root: &Path, slug: &str, version: i64, body: &str) {
        let skill = root.join(slug);
        write(
            &skill,
            "SKILL.md",
            &format!("---\nname: {slug}\n---\n{body}\n"),
        );
        let files = teamclu_skillpack::build_manifest(&skill).unwrap();
        write_origin(
            &skill,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_TEAM.to_string(),
                slug: slug.into(),
                installed_version: version.to_string(),
                installed_at: 1,
                team_id: Some("team-1".into()),
                files: Some(files),
            },
        )
        .unwrap();
    }

    fn skill_zip(body: &str) -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            zip.start_file("SKILL.md", opts).unwrap();
            zip.write_all(format!("---\nname: deploy-check\n---\n{body}\n").as_bytes())
                .unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    fn cloud_config(server: &wiremock::MockServer) -> crate::provider_config::CloudApiConfig {
        crate::provider_config::CloudApiConfig {
            url: server.uri(),
            refresh_token: "refresh".to_string(),
            team_id: "team-1".to_string(),
            actor_id: "agent-1".to_string(),
        }
    }

    async fn mount_refresh(server: &wiremock::MockServer) {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "access-token",
                "refreshToken": "rt-2",
                "expiresAt": 9999999999_i64
            })))
            .mount(server)
            .await;
    }

    async fn reconciler_for(server: &wiremock::MockServer) -> TeamSkillReconciler {
        use crate::backend::cloud_api::CloudApiBackend;
        TeamSkillReconciler::new(std::sync::Arc::new(CloudApiBackend::new(cloud_config(
            server,
        ))))
    }

    #[tokio::test]
    async fn list_401_keeps_installed_packs() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_installed_pack(root, "deploy-check", 1, "v1");

        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/skills"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "code": "unauthorized", "message": "JWT expired" }
            })))
            .mount(&server)
            .await;

        assert!(reconciler_for(&server)
            .await
            .fetch_and_apply("team-1", root)
            .await
            .is_none());
        assert!(root.join("deploy-check/SKILL.md").is_file());
        assert_eq!(
            read_origin(&root.join("deploy-check"))
                .unwrap()
                .installed_version,
            "1"
        );
    }

    #[tokio::test]
    async fn list_404_keeps_installed_packs() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_installed_pack(root, "deploy-check", 1, "v1");

        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/skills"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no such team" }
            })))
            .mount(&server)
            .await;

        assert!(reconciler_for(&server)
            .await
            .fetch_and_apply("team-1", root)
            .await
            .is_none());
        assert!(root.join("deploy-check/SKILL.md").is_file());
    }

    #[tokio::test]
    async fn list_200_empty_items_uninstalls_clean_packs() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_installed_pack(root, "deploy-check", 1, "v1");

        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/skills"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": []
            })))
            .mount(&server)
            .await;

        let outcome = reconciler_for(&server)
            .await
            .fetch_and_apply("team-1", root)
            .await
            .expect("200 empty list is a desired set");
        assert_eq!(outcome.removed, 1);
        assert!(!root.join("deploy-check").exists());
    }

    #[tokio::test]
    async fn list_200_items_installs_pack() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let zip = skill_zip("v3 body");
        let hash = sha256_hex(&zip);

        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/skills"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "slug": "deploy-check",
                    "summary": "check",
                    "category": "devops",
                    "whenToUse": "before release",
                    "whenNotToUse": "not locally",
                    "latestVersion": 3,
                    "installed": true,
                    "installedVersion": 1
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/teams/team-1/skills/deploy-check/versions/3/download",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "url": format!("{}/zip/deploy-check.zip", server.uri()),
                "contentHash": hash,
                "size": zip.len()
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/zip/deploy-check.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip.clone()))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/teams/team-1/skills/deploy-check/install"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let outcome = reconciler_for(&server)
            .await
            .fetch_and_apply("team-1", root)
            .await
            .expect("200 items is a desired set");
        assert_eq!(outcome.installed, 1);
        let installed = root.join("deploy-check");
        assert!(installed.join("SKILL.md").is_file());
        let origin = read_origin(&installed).expect("origin");
        assert_eq!(origin.installed_version, "3");
        assert_eq!(
            inspect(&installed, origin.files.as_ref()),
            teamclu_skillpack::DirtyState::Clean
        );
    }

    #[tokio::test]
    async fn zip_content_hash_mismatch_does_not_touch_disk() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_installed_pack(root, "deploy-check", 1, "v1");
        let before = std::fs::read_to_string(root.join("deploy-check/SKILL.md")).unwrap();

        let zip = skill_zip("tampered");
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/skills"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "slug": "deploy-check",
                    "summary": "check",
                    "category": "devops",
                    "whenToUse": "x",
                    "whenNotToUse": "y",
                    "latestVersion": 2,
                    "installed": true
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/teams/team-1/skills/deploy-check/versions/2/download",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "url": format!("{}/zip/deploy-check.zip", server.uri()),
                "contentHash": "0".repeat(64),
                "size": zip.len()
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/zip/deploy-check.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
            .mount(&server)
            .await;

        let outcome = reconciler_for(&server)
            .await
            .fetch_and_apply("team-1", root)
            .await
            .expect("hash mismatch is an install failure, not a fetch failure");
        assert_eq!(outcome.installed, 0);
        assert_eq!(
            std::fs::read_to_string(root.join("deploy-check/SKILL.md")).unwrap(),
            before
        );
        assert_eq!(
            read_origin(&root.join("deploy-check"))
                .unwrap()
                .installed_version,
            "1"
        );
    }
}
