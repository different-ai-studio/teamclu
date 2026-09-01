use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{Notify, RwLock};
use tokio::time::MissedTickBehavior;
use tracing::warn;

use crate::config::global_team_store::TEAM_LINK_NAME;
use crate::runtime::RuntimeSupervisor;

use super::{RefreshChangeKind, RefreshSource, RuntimeRefreshCoordinator};

fn brand_workspace_config(workspace: &Path) -> PathBuf {
    teamclu_runtime_env::workspace_config_path_from_env(workspace)
}

fn legacy_workspace_config(workspace: &Path) -> PathBuf {
    workspace
        .join(teamclu_runtime_env::WORKSPACE_META_DIR)
        .join(teamclu_runtime_env::WORKSPACE_CONFIG_FILE)
}

fn is_workspace_config_path(path: &Path, workspace: &Path) -> bool {
    let brand = brand_workspace_config(workspace);
    let legacy = legacy_workspace_config(workspace);
    path == brand || (legacy != brand && path == legacy)
}

/// Return both the workspace-visible team path and its physical target.
///
/// On macOS, FSEvents reports mutations made through a symlink using the
/// canonical target path, and watching the symlink itself does not reliably
/// follow writes below that target. Keep both spellings so edits performed by
/// an agent inside `teamclu-team/skills` are attributed to the workspace that
/// owns the link.
fn team_link_child_paths(workspace: &Path, child: &str) -> Vec<PathBuf> {
    let visible = workspace.join(TEAM_LINK_NAME).join(child);
    let mut paths = vec![visible.clone()];
    if let Ok(canonical) = std::fs::canonicalize(&visible) {
        if canonical != visible {
            paths.push(canonical);
        }
    }
    paths
}

fn is_team_skills_path(path: &Path, workspace: &Path) -> bool {
    team_link_child_paths(workspace, "skills")
        .iter()
        .any(|root| path.starts_with(root))
}

/// How often the watch loop reconciles OS watches against the registry absent an
/// explicit change signal. This performs only cheap `is_dir()` checks on the
/// handful of `watch_roots` — never a recursive tree walk — so it stays
/// negligible regardless of workspace size. Actual edits arrive via the OS event
/// stream, not this tick; the tick only picks up roots that appear/disappear
/// (e.g. a `.claude/skills` dir created after arm time).
const WATCH_RECONCILE_INTERVAL: Duration = Duration::from_secs(2);
const WATCH_DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedWorkspace {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedChange {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub kind: RefreshChangeKind,
}

#[derive(Debug)]
pub struct RefreshWatchRegistry {
    workspaces: RwLock<HashMap<PathBuf, WatchedWorkspace>>,
    /// Wakes the watch loop so a workspace add/remove re-arms the OS watchers
    /// immediately instead of waiting for the next periodic reconcile tick.
    changed: Notify,
}

impl RefreshWatchRegistry {
    pub fn new(initial: Vec<WatchedWorkspace>) -> Arc<Self> {
        Arc::new(Self {
            workspaces: RwLock::new(
                initial
                    .into_iter()
                    .map(|workspace| (workspace.workspace_path.clone(), workspace))
                    .collect(),
            ),
            changed: Notify::new(),
        })
    }

    pub async fn upsert_workspace(&self, workspace: WatchedWorkspace) {
        let mut workspaces = self.workspaces.write().await;
        workspaces.retain(|path, existing| {
            path == &workspace.workspace_path || existing.workspace_id != workspace.workspace_id
        });
        workspaces.insert(workspace.workspace_path.clone(), workspace);
        drop(workspaces);
        self.changed.notify_one();
    }

    pub async fn remove_workspace_path(&self, workspace_path: &Path) {
        self.workspaces.write().await.remove(workspace_path);
        self.changed.notify_one();
    }

    pub(crate) async fn snapshot(&self) -> Vec<WatchedWorkspace> {
        self.workspaces.read().await.values().cloned().collect()
    }

    #[cfg(test)]
    pub async fn workspace_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = self.workspaces.read().await.keys().cloned().collect();
        paths.sort();
        paths
    }
}

#[derive(Debug)]
pub struct RefreshDebounce {
    window: Duration,
    last_recorded_at: HashMap<(String, RefreshChangeKind), Instant>,
}

impl RefreshDebounce {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_recorded_at: HashMap::new(),
        }
    }

    pub fn recordable(
        &mut self,
        workspace_id: &str,
        kind: RefreshChangeKind,
        now: Instant,
    ) -> bool {
        let key = (workspace_id.to_string(), kind);
        if let Some(last_seen) = self.last_recorded_at.get(&key) {
            if now.duration_since(*last_seen) < self.window {
                return false;
            }
        }
        self.last_recorded_at.insert(key, now);
        true
    }
}

pub fn classify_change_path(
    path: &Path,
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
) -> Vec<ClassifiedChange> {
    let mut changes = Vec::new();
    let mut seen = HashSet::new();

    // Mirrors `config::roles_skills::skill_dir_specs`. A root that is watched
    // but not scanned only produces refreshes nothing can see; a root that is
    // scanned but not watched leaves the panel stale until something else
    // touches the workspace.
    let is_global_skill_path = home.is_some_and(|home_dir| {
        path.starts_with(home_dir.join(".claude/skills"))
            || path.starts_with(home_dir.join(".agents/skills"))
    });

    for workspace in workspaces {
        let kind = if path == workspace.workspace_path.join("opencode.json") {
            Some(RefreshChangeKind::OpencodeJson)
        } else if is_workspace_config_path(path, &workspace.workspace_path) {
            Some(RefreshChangeKind::TeamcluConfig)
        } else if path.starts_with(workspace.workspace_path.join(TEAM_LINK_NAME).join(".mcp")) {
            Some(RefreshChangeKind::Mcp)
        } else if path.starts_with(
            workspace
                .workspace_path
                .join(TEAM_LINK_NAME)
                .join("_secrets"),
        ) || path.starts_with(workspace.workspace_path.join("teamclaw").join("_secrets"))
        {
            Some(RefreshChangeKind::EnvVars)
        } else if path.starts_with(workspace.workspace_path.join(".claude/skills"))
            || path.starts_with(workspace.workspace_path.join(".agents/skills"))
            || is_team_skills_path(path, &workspace.workspace_path)
            || is_global_skill_path
        {
            Some(RefreshChangeKind::Skills)
        } else {
            None
        };

        let Some(kind) = kind else {
            continue;
        };

        if seen.insert((workspace.workspace_id.clone(), kind)) {
            changes.push(ClassifiedChange {
                workspace_id: workspace.workspace_id.clone(),
                workspace_path: workspace.workspace_path.clone(),
                kind,
            });
        }
    }

    changes
}

#[derive(Debug, Clone)]
struct WatchRoot {
    path: PathBuf,
    recursive: bool,
}

fn watch_roots(workspaces: &[WatchedWorkspace], home: Option<&Path>) -> Vec<WatchRoot> {
    let mut roots = Vec::new();
    for workspace in workspaces {
        roots.push(WatchRoot {
            path: workspace.workspace_path.join("opencode.json"),
            recursive: false,
        });
        let brand_cfg = brand_workspace_config(&workspace.workspace_path);
        let legacy_cfg = legacy_workspace_config(&workspace.workspace_path);
        roots.push(WatchRoot {
            path: brand_cfg.clone(),
            recursive: false,
        });
        if legacy_cfg != brand_cfg {
            roots.push(WatchRoot {
                path: legacy_cfg,
                recursive: false,
            });
        }
        // `.opencode/skills` and `.pi/skills` are deliberately absent, here and
        // in `classify_change_path`. `native_skill_fallback_guard` does watch
        // those directories, but it reads them itself at turn open and turn
        // close (`scan_native_skills`) and never consults this watcher, so
        // subscribing here buys it nothing and breaks the mirror above.
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".claude/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".agents/skills"),
            recursive: true,
        });
        for team_skills in team_link_child_paths(&workspace.workspace_path, "skills") {
            roots.push(WatchRoot {
                path: team_skills,
                recursive: true,
            });
        }
        roots.push(WatchRoot {
            path: workspace
                .workspace_path
                .join(TEAM_LINK_NAME)
                .join("_secrets"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join("teamclaw").join("_secrets"),
            recursive: true,
        });
    }
    if let Some(home_dir) = home {
        roots.push(WatchRoot {
            path: home_dir.join(".claude/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: home_dir.join(".agents/skills"),
            recursive: true,
        });
    }
    roots
}

async fn record_classified_changes(
    refresh: &RuntimeRefreshCoordinator,
    _supervisor: Option<&RuntimeSupervisor>,
    debounce: &mut RefreshDebounce,
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
    path: &Path,
    now: Instant,
) {
    for change in classify_change_path(path, workspaces, home) {
        if !debounce.recordable(&change.workspace_id, change.kind, now) {
            continue;
        }
        if refresh.is_watch_suppressed(&change.workspace_id, change.kind) {
            continue;
        }
        if let Err(error) = refresh
            .record_change(
                &change.workspace_id,
                &change.workspace_path,
                change.kind,
                RefreshSource::FilesystemWatch,
            )
            .await
        {
            warn!(
                workspace_id = %change.workspace_id,
                workspace_path = %change.workspace_path.display(),
                changed_path = %path.display(),
                error = %error,
                "failed to record filesystem refresh change"
            );
        }
    }
}

/// Map the declarative `watch_roots` to the concrete directories handed to the
/// OS watcher, deduped by path.
///
/// OS watchers (FSEvents / inotify / ReadDirectoryChangesW) watch *directories*,
/// so a non-recursive file root (`opencode.json`, `teamclu.json`) is covered by
/// watching its parent directory shallowly — this also survives atomic saves
/// (write-temp + rename) that would break a watch pinned to the file's inode.
/// Only directories that currently exist are returned; missing roots are armed
/// later by the reconcile tick once they appear. A path wanted recursively wins
/// over the same path wanted shallowly.
fn desired_watch_targets(
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
) -> HashMap<PathBuf, RecursiveMode> {
    let mut targets: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    for root in watch_roots(workspaces, home) {
        let (path, mode) = if root.recursive {
            (root.path, RecursiveMode::Recursive)
        } else {
            match root.path.parent() {
                Some(parent) => (parent.to_path_buf(), RecursiveMode::NonRecursive),
                None => continue,
            }
        };
        if !path.is_dir() {
            continue;
        }
        targets
            .entry(path)
            .and_modify(|existing| {
                if mode == RecursiveMode::Recursive {
                    *existing = RecursiveMode::Recursive;
                }
            })
            .or_insert(mode);
    }
    targets
}

/// Arm/disarm OS watches so the live set matches `desired`. Failures are logged
/// and retried on the next reconcile (the desired path may have just vanished).
fn reconcile_watches(
    watcher: &mut RecommendedWatcher,
    desired: &HashMap<PathBuf, RecursiveMode>,
    watched: &mut HashSet<PathBuf>,
) {
    let stale: Vec<PathBuf> = watched
        .iter()
        .filter(|path| !desired.contains_key(*path))
        .cloned()
        .collect();
    for path in stale {
        let _ = watcher.unwatch(&path);
        watched.remove(&path);
    }
    for (path, mode) in desired {
        if watched.contains(path) {
            continue;
        }
        match watcher.watch(path, *mode) {
            Ok(()) => {
                watched.insert(path.clone());
            }
            Err(error) => {
                tracing::debug!(
                    path = %path.display(),
                    %error,
                    "failed to arm filesystem refresh watch; will retry"
                );
            }
        }
    }
}

/// Access events (opens/reads) are pure noise for config/skill refresh.
fn is_relevant_event(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

pub fn start_refresh_watchers(
    supervisor: Arc<RuntimeSupervisor>,
    workspaces: Vec<WatchedWorkspace>,
    home: Option<PathBuf>,
) -> Arc<RefreshWatchRegistry> {
    let refresh = supervisor.refresh_coordinator();
    let registry = RefreshWatchRegistry::new(workspaces);
    let watch_registry = Arc::clone(&registry);
    tokio::spawn(async move {
        // The notify callback runs on notify's own thread; bridge its events to
        // this async loop through an unbounded channel. Event volume is bounded
        // downstream by classification + debounce, so no backpressure is needed.
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
        let mut watcher = match RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else { return };
                if !is_relevant_event(&event.kind) {
                    return;
                }
                for path in event.paths {
                    let _ = event_tx.send(path);
                }
            },
            Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                warn!(%error, "failed to create filesystem watcher; runtime refresh disabled");
                return;
            }
        };

        let mut watched: HashSet<PathBuf> = HashSet::new();
        let mut debounce = RefreshDebounce::new(WATCH_DEBOUNCE_WINDOW);
        let mut reconcile = tokio::time::interval(WATCH_RECONCILE_INTERVAL);
        reconcile.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let reconcile_now = |watcher: &mut RecommendedWatcher,
                             watched: &mut HashSet<PathBuf>,
                             workspaces: &[WatchedWorkspace]| {
            let desired = desired_watch_targets(workspaces, home.as_deref());
            reconcile_watches(watcher, &desired, watched);
        };

        {
            let workspaces = watch_registry.snapshot().await;
            reconcile_now(&mut watcher, &mut watched, &workspaces);
        }

        loop {
            tokio::select! {
                _ = reconcile.tick() => {
                    let workspaces = watch_registry.snapshot().await;
                    reconcile_now(&mut watcher, &mut watched, &workspaces);
                }
                _ = watch_registry.changed.notified() => {
                    let workspaces = watch_registry.snapshot().await;
                    reconcile_now(&mut watcher, &mut watched, &workspaces);
                }
                Some(path) = event_rx.recv() => {
                    let workspaces = watch_registry.snapshot().await;
                    record_classified_changes(
                        &refresh,
                        Some(&supervisor),
                        &mut debounce,
                        &workspaces,
                        home.as_deref(),
                        &path,
                        Instant::now(),
                    )
                    .await;
                }
            }
        }
    });

    registry
}

pub fn workspace_runtime_id(workspace_path: &Path) -> String {
    URL_SAFE_NO_PAD.encode(workspace_path.to_string_lossy().as_bytes())
}

pub fn suppress_for_workspace_path(
    coordinator: &super::RuntimeRefreshCoordinator,
    workspace_path: &Path,
    kinds: &[super::RefreshChangeKind],
    duration: std::time::Duration,
) {
    let workspace_id = workspace_runtime_id(workspace_path);
    coordinator.suppress_workspace_watch(&workspace_id, kinds, duration);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
    use crate::runtime::opencode_http::host_pool::HostLifecycle;
    use crate::runtime::RuntimeManager;
    use tokio::sync::Mutex as AsyncMutex;

    fn watched_workspace(id: &str, path: &str) -> WatchedWorkspace {
        WatchedWorkspace {
            workspace_id: id.to_string(),
            workspace_path: PathBuf::from(path),
        }
    }

    #[test]
    fn skill_path_change_maps_to_skills_kind() {
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];
        let home = Path::new("/Users/tester");

        let cases = [
            (
                Path::new("/tmp/ws-1/.claude/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/.agents/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.claude/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.agents/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/opencode.json"),
                RefreshChangeKind::OpencodeJson,
            ),
            (
                Path::new("/tmp/ws-1/.teamclu/teamclu.json"),
                RefreshChangeKind::TeamcluConfig,
            ),
            (
                Path::new("/tmp/ws-1/teamclu-team/_secrets/api_key.enc.json"),
                RefreshChangeKind::EnvVars,
            ),
            (
                Path::new("/tmp/ws-1/teamclaw/_secrets/legacy_key.enc.json"),
                RefreshChangeKind::EnvVars,
            ),
        ];

        for (path, kind) in cases {
            let changes = classify_change_path(path, &workspaces, Some(home));
            assert_eq!(
                changes,
                vec![ClassifiedChange {
                    workspace_id: "ws-1".to_string(),
                    workspace_path: PathBuf::from("/tmp/ws-1"),
                    kind,
                }],
                "path {} should classify to {:?}",
                path.display(),
                kind
            );
        }

        // Roots the scanner dropped. A write here refreshes nothing, because
        // nothing can load it — see `skill_dir_specs`.
        for retired in [
            Path::new("/tmp/ws-1/.teamclu/skills/demo-skill/SKILL.md"),
            Path::new("/tmp/ws-1/.opencode/skills/demo-skill/SKILL.md"),
            Path::new("/tmp/ws-1/.pi/skills/demo-skill/SKILL.md"),
            Path::new("/Users/tester/.config/teamclu/skills/global-skill/SKILL.md"),
            Path::new("/Users/tester/.config/opencode/skills/global-skill/SKILL.md"),
        ] {
            assert!(
                classify_change_path(retired, &workspaces, Some(home)).is_empty(),
                "{} is no longer a skills root",
                retired.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn canonical_team_skill_target_is_watched_and_classified() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let shared_team = root.path().join("shared/teamclu-team");
        let shared_skills = shared_team.join("skills");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(shared_skills.join("multiply-add")).unwrap();
        std::os::unix::fs::symlink(&shared_team, workspace.join(TEAM_LINK_NAME)).unwrap();

        let workspaces = vec![WatchedWorkspace {
            workspace_id: "ws-symlink".to_string(),
            workspace_path: workspace.clone(),
        }];
        let canonical_skills = std::fs::canonicalize(&shared_skills).unwrap();
        let roots = watch_roots(&workspaces, None);
        assert!(roots.iter().any(|root| root.path == canonical_skills));

        let changed_file = canonical_skills.join("multiply-add/SKILL.md");
        assert_eq!(
            classify_change_path(&changed_file, &workspaces, None),
            vec![ClassifiedChange {
                workspace_id: "ws-symlink".to_string(),
                workspace_path: workspace,
                kind: RefreshChangeKind::Skills,
            }]
        );
    }

    #[tokio::test]
    async fn burst_events_are_debounced_into_one_recorded_change() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));
        let now = Instant::now();
        let path = Path::new("/tmp/ws-1/.claude/skills/demo-skill/SKILL.md");

        record_classified_changes(
            &coordinator,
            None,
            &mut debounce,
            &workspaces,
            None,
            path,
            now,
        )
        .await;
        record_classified_changes(
            &coordinator,
            None,
            &mut debounce,
            &workspaces,
            None,
            path,
            now + Duration::from_millis(50),
        )
        .await;
        record_classified_changes(
            &coordinator,
            None,
            &mut debounce,
            &workspaces,
            None,
            path,
            now + Duration::from_millis(100),
        )
        .await;

        let state = coordinator.workspace_state("ws-1").await.unwrap();
        assert_eq!(state.revision, 1);
        assert_eq!(state.change_kinds.len(), 1);
        assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
        assert_eq!(state.sources.len(), 1);
        assert!(state.sources.contains(&RefreshSource::FilesystemWatch));
    }

    #[tokio::test]
    async fn watcher_state_surfaces_through_runtime_status_with_http_workspace_id() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let manager = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(manager)));
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));

        record_classified_changes(
            &supervisor.refresh_coordinator(),
            None,
            &mut debounce,
            &workspaces,
            None,
            &dir.path().join(".claude/skills/demo-skill/SKILL.md"),
            Instant::now(),
        )
        .await;

        let status = supervisor
            .runtime_status(&workspace_id, dir.path())
            .await
            .unwrap();
        assert_eq!(status.refresh.status, "pending");
        assert_eq!(status.refresh.change_kinds, vec!["skills".to_string()]);
    }

    #[tokio::test]
    async fn skill_change_records_pending_without_host_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let domain = IsolationDomainKey::Workspace(workspace_id.clone());
        let revision = ProcessEnvRevision::from_bindings(&HashMap::new());
        let pool = crate::runtime::test_support::test_host_pool();
        let old = pool
            .acquire(
                domain.clone(),
                revision.clone(),
                HashMap::new(),
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap();
        let old_generation_id = old.generation.generation_id.clone();
        let supervisor = RuntimeSupervisor::new_with_host_pool(
            Arc::new(AsyncMutex::new(RuntimeManager::new(
                RuntimeManager::default_launch_configs(),
                None,
            ))),
            pool.clone(),
        );
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));

        record_classified_changes(
            &supervisor.refresh_coordinator(),
            Some(&supervisor),
            &mut debounce,
            &workspaces,
            None,
            &dir.path().join(".claude/skills/demo-skill/SKILL.md"),
            Instant::now(),
        )
        .await;

        assert_eq!(old.generation.lifecycle(), HostLifecycle::Ready);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");

        let same = pool
            .acquire(
                domain,
                revision,
                HashMap::new(),
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(same.generation.generation_id, old_generation_id);
        assert_eq!(old.generation.lifecycle(), HostLifecycle::Ready);
    }

    #[tokio::test]
    async fn watcher_skips_record_change_when_suppressed() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));

        coordinator.suppress_workspace_watch(
            &workspace_id,
            &[RefreshChangeKind::OpencodeJson],
            Duration::from_secs(5),
        );

        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"$schema":"https://opencode.ai/config.json"}"#,
        )
        .unwrap();

        record_classified_changes(
            &coordinator,
            None,
            &mut debounce,
            &workspaces,
            None,
            &dir.path().join("opencode.json"),
            Instant::now(),
        )
        .await;

        assert!(coordinator.workspace_state(&workspace_id).await.is_none());
    }

    /// Spawn env assembly awaits managed-LLM longer than a short suppress window.
    /// Suppressing *before* that await lets the window expire; the subsequent
    /// opencode.json write is recorded as Pending. Suppressing *after* the await
    /// (immediately before disk writes) covers the write — the production order
    /// in `assemble_spawn_runtime_env_for_worktree`.
    #[tokio::test]
    async fn suppress_after_await_covers_opencode_write_unlike_suppress_before_await() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let opencode = dir.path().join("opencode.json");
        let content = r#"{"$schema":"https://opencode.ai/config.json"}"#;

        // --- buggy order: suppress → await past window → write ---
        let leaky = RuntimeRefreshCoordinator::new();
        let mut debounce = RefreshDebounce::new(Duration::from_millis(1));
        leaky.suppress_workspace_watch(
            &workspace_id,
            &[RefreshChangeKind::OpencodeJson],
            Duration::from_millis(30),
        );
        tokio::time::sleep(Duration::from_millis(45)).await;
        std::fs::write(&opencode, content).unwrap();
        record_classified_changes(
            &leaky,
            None,
            &mut debounce,
            &workspaces,
            None,
            &opencode,
            Instant::now(),
        )
        .await;
        let leaked = leaky.workspace_state(&workspace_id).await.unwrap();
        assert!(leaked
            .change_kinds
            .contains(&RefreshChangeKind::OpencodeJson));

        // --- fixed order: await → suppress → write ---
        let covered = RuntimeRefreshCoordinator::new();
        let mut debounce = RefreshDebounce::new(Duration::from_millis(1));
        tokio::time::sleep(Duration::from_millis(45)).await;
        covered.suppress_workspace_watch(
            &workspace_id,
            &[RefreshChangeKind::OpencodeJson],
            Duration::from_secs(5),
        );
        std::fs::write(&opencode, content).unwrap();
        record_classified_changes(
            &covered,
            None,
            &mut debounce,
            &workspaces,
            None,
            &opencode,
            Instant::now(),
        )
        .await;
        assert!(covered.workspace_state(&workspace_id).await.is_none());
    }

    #[tokio::test]
    async fn watch_registry_supports_add_and_remove() {
        let registry = RefreshWatchRegistry::new(Vec::new());
        registry
            .upsert_workspace(watched_workspace("ws-1", "/tmp/ws-1"))
            .await;
        registry
            .upsert_workspace(watched_workspace("ws-2", "/tmp/ws-2"))
            .await;
        assert_eq!(
            registry.workspace_paths().await,
            vec![PathBuf::from("/tmp/ws-1"), PathBuf::from("/tmp/ws-2")]
        );

        registry.remove_workspace_path(Path::new("/tmp/ws-1")).await;
        assert_eq!(
            registry.workspace_paths().await,
            vec![PathBuf::from("/tmp/ws-2")]
        );
    }

    #[tokio::test]
    async fn watch_registry_replaces_stale_path_for_same_workspace_id() {
        let registry = RefreshWatchRegistry::new(Vec::new());
        registry
            .upsert_workspace(watched_workspace("ws-1", "/tmp/cloud-path"))
            .await;
        registry
            .upsert_workspace(watched_workspace("ws-1", "/tmp/runtime-path"))
            .await;

        assert_eq!(
            registry.workspace_paths().await,
            vec![PathBuf::from("/tmp/runtime-path")]
        );
    }

    #[test]
    fn desired_targets_map_existing_dirs_and_skip_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        // Only this recursive skill root exists; the other skill/_secrets roots do not.
        std::fs::create_dir_all(ws.join(".claude/skills")).unwrap();

        let workspaces = vec![WatchedWorkspace {
            workspace_id: "ws-1".to_string(),
            workspace_path: ws.to_path_buf(),
        }];

        let targets = desired_watch_targets(&workspaces, None);

        // The recursive skill dir is watched recursively.
        assert_eq!(
            targets.get(&ws.join(".claude/skills")),
            Some(&RecursiveMode::Recursive),
            "existing skills dir should be watched recursively"
        );
        // `opencode.json` (a file root) is covered by its parent (the workspace
        // root) watched shallowly, since the workspace root exists.
        assert_eq!(
            targets.get(ws),
            Some(&RecursiveMode::NonRecursive),
            "workspace root should be watched non-recursively for config files"
        );
        // A skill root that does not exist is not armed.
        assert!(
            !targets.contains_key(&ws.join(".agents/skills")),
            "missing skills dir must be excluded until it is created"
        );
        // `.teamclu/teamclu.json`'s parent does not exist here, so it is skipped.
        assert!(
            !targets.contains_key(&ws.join(".teamclu")),
            "missing config parent dir must be excluded"
        );
    }

    #[test]
    fn white_label_config_and_skills_paths_classify() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];

        let brand_cfg = classify_change_path(
            Path::new("/tmp/ws-1/.copilot361/copilot361.json"),
            &workspaces,
            None,
        );
        assert_eq!(
            brand_cfg[0].kind,
            RefreshChangeKind::TeamcluConfig,
            "brand config should classify"
        );

        let legacy_cfg = classify_change_path(
            Path::new("/tmp/ws-1/.teamclu/teamclu.json"),
            &workspaces,
            None,
        );
        assert_eq!(
            legacy_cfg[0].kind,
            RefreshChangeKind::TeamcluConfig,
            "legacy config should still classify during migration"
        );

        let brand_skill = classify_change_path(
            Path::new("/tmp/ws-1/.copilot361/skills/demo/SKILL.md"),
            &workspaces,
            None,
        );
        assert!(
            brand_skill.is_empty(),
            "a brand meta dir is not a skills root under any brand"
        );

        let claude_skill = classify_change_path(
            Path::new("/tmp/ws-1/.claude/skills/demo/SKILL.md"),
            &workspaces,
            None,
        );
        assert_eq!(claude_skill[0].kind, RefreshChangeKind::Skills);
    }

    #[test]
    /// Config files are still brand-namespaced (and keep the legacy fallback);
    /// skills are not watched under a meta dir at all any more.
    fn white_label_watch_roots_include_brand_and_legacy_configs() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];
        let roots = watch_roots(&workspaces, None);
        let paths: Vec<_> = roots.iter().map(|r| r.path.clone()).collect();
        assert!(paths.contains(&PathBuf::from("/tmp/ws-1/.copilot361/copilot361.json")));
        assert!(paths.contains(&PathBuf::from("/tmp/ws-1/.teamclu/teamclu.json")));
        assert!(paths.contains(&PathBuf::from("/tmp/ws-1/.claude/skills")));
        assert!(!paths.contains(&PathBuf::from("/tmp/ws-1/.copilot361/skills")));
        assert!(!paths.contains(&PathBuf::from("/tmp/ws-1/.teamclu/skills")));
    }
}
