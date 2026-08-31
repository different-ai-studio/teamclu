//! Materialises the team skills a shared agent is supposed to have.
//!
//! Design: `docs/architecture/team-skills-registry.md` §8.1 / §8.2.
//!
//! An admin installing a skill onto a `visibility='team'` agent writes a server
//! record and nothing else — their machine is not the machine that runs the
//! agent. This is the other half: the daemon that *does* host the agent pulls
//! the set it should have and makes the disk match.
//!
//! # Why a full diff and not an event feed
//!
//! Notifications get lost, daemons go offline, and an install can land while
//! this process is not running at all. Anything that applies deltas drifts, and
//! drift here means an agent quietly executing a version of a team procedure
//! the team has retired. Recomputing the whole set costs a directory listing
//! and cannot drift by construction; a lost notification only means the change
//! lands on the next tick instead of immediately.
//!
//! # Why not `~/.agents/skills`
//!
//! That directory is the *desktop's* install root, and on a desktop machine the
//! desktop is simultaneously reconciling it against the signed-in **member's**
//! install set. This daemon reconciles against the **agent's** set. Two owners,
//! one directory, and both remove packs that are not in their own desired set —
//! they would delete each other's skills on alternating ticks, forever.
//!
//! So the daemon gets its own root under `~/.amuxd/teams/<id>/cloud/skills`,
//! a sibling of the team MCP and env caches and outside every git worktree, and
//! that root is added to [`crate::config::team_skill_roots`] so OpenCode and the
//! Claude symlink bridge still see the packs.
//!
//! # No dirty protection here
//!
//! The desktop refuses to overwrite a pack a member edited locally. This does
//! the opposite and overwrites unconditionally. Nobody on the host machine has
//! standing to veto a team-level decision about a shared agent, and there is no
//! one to ask — the admin who made the change is elsewhere and the daemon has
//! no UI. The server record is the desired state, full stop (§4).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use teamclu_skillpack::{
    apply_zip_mode, build_manifest_for, list_managed_paths, read_origin, sanitize_zip_path,
    swap_managed_files, write_origin, write_registry_frontmatter, RegistryFields, SkillOrigin,
    ORIGIN_VERSION, SOURCE_TEAM,
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
        let rows = match self.backend.team_skills(team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                // Leave the disk exactly as it is. An unreachable registry must
                // never read as "the team removed everything" — that would
                // strip a working agent of its skills every time the network
                // blinked, and the packs would only come back on the next
                // successful fetch.
                tracing::warn!(team_id, error = %e, "team skills fetch failed; keeping the installed set");
                return TeamSkillReconcileOutcome::default();
            }
        };

        let root = team_cloud_skills_dir(team_id);
        let outcome = self.apply(team_id, &root, &rows).await;

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
            // A pack whose recorded version we cannot read is reinstalled
            // rather than trusted: one redundant download beats leaving content
            // of unknown provenance in front of an agent.
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

        let target = root.join(&row.slug);
        let staging = tempfile::tempdir().map_err(|e| format!("staging dir: {e}"))?;
        extract_zip_to_dir(&bytes, staging.path())?;

        // Deletions are authorised only by a baseline we recorded ourselves.
        let baseline = read_origin(&target).and_then(|o| o.files);
        swap_managed_files(&target, staging.path(), baseline.as_ref())
            .map_err(|e| format!("install files: {e}"))?;
        let shipped =
            list_managed_paths(staging.path()).map_err(|e| format!("list package files: {e}"))?;

        let requires = requires_list(row.requires.as_ref());
        write_registry_frontmatter(
            &target,
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

        // Baseline last, and only after the frontmatter rewrite: it describes
        // the directory as installed, not the archive as shipped. Scoped to the
        // files the package shipped, so anything a script writes beside itself
        // stays outside the set the pack claims to own.
        let files = build_manifest_for(&target, &shipped).map_err(|e| format!("manifest: {e}"))?;
        write_origin(
            &target,
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

        Ok(())
    }
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

    let mut cloud_targets = Vec::new();
    if let Some(backend) = backend {
        match backend
            .get_workspaces_by_agent(team_id, backend.actor_id())
            .await
        {
            Ok(rows) => {
                for row in rows {
                    let Some((path, _)) =
                        crate::config::workspace_path::listable_local_workspace(&row)
                    else {
                        continue;
                    };
                    cloud_targets.push(crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                        workspace_id: row.id,
                        workspace_path: PathBuf::from(path),
                    });
                }
            }
            Err(e) => tracing::warn!(
                team_id,
                error = %e,
                "team skills changed but cloud workspace list failed; using runtime refresh targets"
            ),
        }
    }

    let runtime_targets = match refresh_watch_registry {
        Some(registry) => registry.snapshot().await,
        None => Vec::new(),
    };
    for target in merge_refresh_targets(cloud_targets, runtime_targets) {
        if let Err(error) = refresh
            .record_change(
                &target.workspace_id,
                &target.workspace_path,
                crate::runtime::refresh::RefreshChangeKind::Skills,
                crate::runtime::refresh::RefreshSource::UiMutation,
            )
            .await
        {
            tracing::warn!(
                workspace_id = target.workspace_id,
                workspace_path = %target.workspace_path.display(),
                error = %error,
                "failed to record skills refresh after team skill reconcile"
            );
        }
    }
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

    #[test]
    fn runtime_refresh_target_overrides_stale_cloud_path() {
        use crate::runtime::refresh::refresh_watch::WatchedWorkspace;

        let targets = merge_refresh_targets(
            vec![WatchedWorkspace {
                workspace_id: "ws-1".into(),
                workspace_path: PathBuf::from("/tmp/stale-cloud-path"),
            }],
            vec![WatchedWorkspace {
                workspace_id: "ws-1".into(),
                workspace_path: PathBuf::from("/tmp/actual-runtime-path"),
            }],
        );
        assert_eq!(
            targets[0].workspace_path,
            Path::new("/tmp/actual-runtime-path")
        );
    }

    #[tokio::test]
    async fn team_skill_change_refreshes_runtime_target_without_cloud_inventory() {
        use crate::runtime::refresh::refresh_watch::{RefreshWatchRegistry, WatchedWorkspace};

        let registry = RefreshWatchRegistry::new(vec![WatchedWorkspace {
            workspace_id: "ws-runtime".into(),
            workspace_path: PathBuf::from("/tmp/actual-runtime-path"),
        }]);
        let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
        apply_team_skill_outcome(
            "team-1",
            TeamSkillReconcileOutcome {
                installed: 1,
                removed: 0,
            },
            None,
            Some(&refresh),
            Some(&registry),
        )
        .await;

        let state = refresh.workspace_state("ws-runtime").await.unwrap();
        assert_eq!(state.workspace_path, "/tmp/actual-runtime-path");
        assert!(state
            .change_kinds
            .contains(&crate::runtime::refresh::RefreshChangeKind::Skills));
    }
}
