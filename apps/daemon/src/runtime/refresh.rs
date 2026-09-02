use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::workspace_control::{RuntimeRefreshDto, WorkspaceControlError};

#[path = "refresh_watch.rs"]
pub mod refresh_watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshChangeKind {
    Skills,
    Mcp,
    EnvVars,
    ProviderAuth,
    ProviderCatalog,
    Permissions,
    OpencodeJson,
    TeamcluConfig,
}

pub const INTERNAL_WRITE_SUPPRESS: Duration = Duration::from_secs(3);
pub const APPLY_REFRESH_SUPPRESS: Duration = Duration::from_secs(5);

pub const INTERNAL_OPENCODE_KINDS: [RefreshChangeKind; 1] = [RefreshChangeKind::OpencodeJson];

/// Global coordinator handle for writers that live outside the manager
/// (e.g. the opencode HTTP backend's MCP-injection writes to a worktree's
/// `opencode.json`). Set once at daemon startup via
/// `RuntimeManager::attach_refresh_coordinator`; absent in unit tests.
static GLOBAL_COORDINATOR: std::sync::OnceLock<std::sync::Arc<RuntimeRefreshCoordinator>> =
    std::sync::OnceLock::new();

pub fn set_global_coordinator(coordinator: std::sync::Arc<RuntimeRefreshCoordinator>) {
    let _ = GLOBAL_COORDINATOR.set(coordinator);
}

/// Suppress filesystem-watch refreshes for an internal `opencode.json` write
/// in `worktree`. No-op when the coordinator isn't up yet (tests, startup).
pub fn suppress_internal_opencode_write(worktree: &std::path::Path) {
    if let Some(coordinator) = GLOBAL_COORDINATOR.get() {
        refresh_watch::suppress_for_workspace_path(
            coordinator,
            worktree,
            &INTERNAL_OPENCODE_KINDS,
            INTERNAL_WRITE_SUPPRESS,
        );
    }
}

/// Record an `EnvVars` pending refresh for `worktree` via the global coordinator.
/// Used when attach tolerates fingerprint drift so idle auto-apply can still run.
pub async fn record_env_vars_change_for_worktree(worktree: &std::path::Path) {
    let Some(coordinator) = GLOBAL_COORDINATOR.get() else {
        return;
    };
    let workspace_id = refresh_watch::workspace_runtime_id(worktree);
    if let Err(error) = coordinator
        .record_change(
            &workspace_id,
            worktree,
            RefreshChangeKind::EnvVars,
            RefreshSource::UiMutation,
        )
        .await
    {
        tracing::warn!(
            workspace_id = %workspace_id,
            workspace_path = %worktree.display(),
            error = %error,
            "failed to record env_vars refresh after fingerprint tolerate"
        );
    }
}

/// Parse API `change_kinds` strings into [`RefreshChangeKind`] values.
pub fn parse_refresh_change_kinds(kinds: &[String]) -> Vec<RefreshChangeKind> {
    let mut out = Vec::new();
    for kind in kinds {
        let parsed = match kind.as_str() {
            "env_vars" => Some(RefreshChangeKind::EnvVars),
            "skills" => Some(RefreshChangeKind::Skills),
            "mcp" => Some(RefreshChangeKind::Mcp),
            "provider_auth" => Some(RefreshChangeKind::ProviderAuth),
            "provider_catalog" => Some(RefreshChangeKind::ProviderCatalog),
            "permissions" => Some(RefreshChangeKind::Permissions),
            "opencode_json" => Some(RefreshChangeKind::OpencodeJson),
            "teamclu_config" => Some(RefreshChangeKind::TeamcluConfig),
            _ => None,
        };
        if let Some(parsed) = parsed {
            if !out.contains(&parsed) {
                out.push(parsed);
            }
        }
    }
    out
}
pub const INTERNAL_PREPARE_KINDS: [RefreshChangeKind; 3] = [
    RefreshChangeKind::OpencodeJson,
    RefreshChangeKind::Skills,
    RefreshChangeKind::TeamcluConfig,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshSource {
    UiMutation,
    FilesystemWatch,
    StartupRescan,
    TeamSkillReconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshImpact {
    AppliedLive,
    IdleReload,
    IdleRestart,
    UserApplyRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshRecommendedAction {
    None,
    ApplyChanges,
}

/// When a recorded refresh change takes effect for running vs future runtimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshActivationPolicy {
    /// Informational pending only; next runtime spawn reads latest workspace files.
    NextRuntimeStart,
    /// Writer/cache invalidation applies immediately; no runtime reload.
    Live,
    /// Provider-auth and other security-sensitive paths (handled outside auto-apply).
    SecurityImmediate,
}

pub fn activation_policy(kind: RefreshChangeKind) -> RefreshActivationPolicy {
    match kind {
        RefreshChangeKind::Skills
        | RefreshChangeKind::Mcp
        | RefreshChangeKind::OpencodeJson
        | RefreshChangeKind::TeamcluConfig
        | RefreshChangeKind::EnvVars => RefreshActivationPolicy::NextRuntimeStart,
        RefreshChangeKind::ProviderCatalog | RefreshChangeKind::Permissions => {
            RefreshActivationPolicy::Live
        }
        RefreshChangeKind::ProviderAuth => RefreshActivationPolicy::SecurityImmediate,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRefreshStatus {
    Clean,
    Pending,
    Applying,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRefreshState {
    pub workspace_id: String,
    pub workspace_path: String,
    pub status: WorkspaceRefreshStatus,
    pub strongest_impact: RefreshImpact,
    pub recommended_action: RefreshRecommendedAction,
    pub change_kinds: BTreeSet<RefreshChangeKind>,
    pub sources: BTreeSet<RefreshSource>,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub revision: u64,
    pub apply_attempt_id: Option<u64>,
    pub first_detected_at: DateTime<Utc>,
    pub last_detected_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

impl WorkspaceRefreshState {
    pub fn to_dto(&self) -> RuntimeRefreshDto {
        RuntimeRefreshDto {
            status: self.status.as_str().to_owned(),
            change_kinds: self
                .change_kinds
                .iter()
                .map(|kind| kind.as_str().to_owned())
                .collect(),
            recommended_action: self.recommended_action.as_str().to_owned(),
            auto_apply_blocked_by_active_runtime: self.auto_apply_blocked_by_active_runtime,
            last_detected_at: Some(self.last_detected_at.to_rfc3339()),
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct WatchSuppression {
    until: Instant,
    kinds: BTreeSet<RefreshChangeKind>,
}

#[derive(Debug, Default)]
struct WatchSuppressState {
    by_workspace: HashMap<String, Vec<WatchSuppression>>,
}

#[derive(Debug)]
pub struct RuntimeRefreshCoordinator {
    inner: RwLock<CoordinatorState>,
    watch_suppress: Mutex<WatchSuppressState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshApplyAttempt {
    workspace_revision: u64,
    attempt_id: u64,
}

#[derive(Debug)]
struct CoordinatorState {
    workspaces: HashMap<String, WorkspaceRefreshState>,
    next_attempt_id: u64,
}

impl RuntimeRefreshCoordinator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(CoordinatorState {
                workspaces: HashMap::new(),
                next_attempt_id: 1,
            }),
            watch_suppress: Mutex::new(WatchSuppressState::default()),
        })
    }

    /// Ignore filesystem watcher `record_change` for `kinds` until `duration` elapses.
    /// Re-calling extends the deadline when the new window ends later.
    pub fn suppress_workspace_watch(
        &self,
        workspace_id: &str,
        kinds: &[RefreshChangeKind],
        duration: Duration,
    ) {
        let until = Instant::now() + duration;
        let kinds: BTreeSet<_> = kinds.iter().copied().collect();
        let mut guard = self.watch_suppress.lock().expect("watch_suppress poisoned");
        let entries = guard
            .by_workspace
            .entry(workspace_id.to_owned())
            .or_default();
        if let Some(existing) = entries.iter_mut().find(|e| e.kinds == kinds) {
            if existing.until < until {
                existing.until = until;
            }
        } else {
            entries.push(WatchSuppression { until, kinds });
        }
    }

    pub fn is_watch_suppressed(&self, workspace_id: &str, kind: RefreshChangeKind) -> bool {
        let mut guard = self.watch_suppress.lock().expect("watch_suppress poisoned");
        let now = Instant::now();
        let Some(entries) = guard.by_workspace.get_mut(workspace_id) else {
            return false;
        };
        entries.retain(|e| e.until > now);
        if entries.is_empty() {
            guard.by_workspace.remove(workspace_id);
            return false;
        }
        entries.iter().any(|e| e.kinds.contains(&kind))
    }

    pub async fn record_change(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        kind: RefreshChangeKind,
        source: RefreshSource,
    ) -> Result<(), WorkspaceControlError> {
        let now = Utc::now();
        let mut guard = self.inner.write().await;
        let entry = guard
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceRefreshState {
                workspace_id: workspace_id.to_owned(),
                workspace_path: workspace_path.display().to_string(),
                status: WorkspaceRefreshStatus::Pending,
                strongest_impact: impact_for_kind(kind),
                recommended_action: RefreshRecommendedAction::None,
                change_kinds: BTreeSet::new(),
                sources: BTreeSet::new(),
                auto_apply_blocked_by_active_runtime: false,
                revision: 0,
                apply_attempt_id: None,
                first_detected_at: now,
                last_detected_at: now,
                last_error: None,
            });

        entry.workspace_path = workspace_path.display().to_string();
        entry.status = WorkspaceRefreshStatus::Pending;
        entry.change_kinds.insert(kind);
        entry.sources.insert(source);
        entry.strongest_impact = strongest_impact(entry.change_kinds.iter().copied());
        entry.recommended_action = recommended_action_for_kinds(&entry.change_kinds);
        entry.auto_apply_blocked_by_active_runtime = false;
        entry.revision += 1;
        entry.last_detected_at = now;
        entry.last_error = None;
        Ok(())
    }

    pub async fn workspace_state(&self, workspace_id: &str) -> Option<WorkspaceRefreshState> {
        self.inner
            .read()
            .await
            .workspaces
            .get(workspace_id)
            .cloned()
    }

    /// Resolve a refresh identity by its filesystem path. HTTP workspace
    /// control routes use a base64url path as `:id`, while runtime isolation
    /// uses the cloud workspace UUID. The watcher records the UUID; status and
    /// Apply callers therefore need this path bridge to address the same state.
    pub async fn workspace_id_for_path(&self, workspace_path: &Path) -> Option<String> {
        let workspace_path = workspace_path.to_string_lossy();
        let path_identity = refresh_watch::workspace_runtime_id(Path::new(workspace_path.as_ref()));
        self.inner
            .read()
            .await
            .workspaces
            .values()
            .filter(|state| state.workspace_path == workspace_path)
            .max_by_key(|state| state.workspace_id != path_identity)
            .map(|state| state.workspace_id.clone())
    }

    pub async fn runtime_refresh_dto_for_path(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> RuntimeRefreshDto {
        let workspace_path = workspace_path.to_string_lossy();
        let path_identity = refresh_watch::workspace_runtime_id(Path::new(workspace_path.as_ref()));
        let guard = self.inner.read().await;
        if workspace_id != path_identity {
            if let Some(state) = guard.workspaces.get(workspace_id) {
                return state.to_dto();
            }
        }
        guard
            .workspaces
            .values()
            .filter(|state| state.workspace_path == workspace_path)
            .max_by_key(|state| state.workspace_id != path_identity)
            .map(WorkspaceRefreshState::to_dto)
            .unwrap_or_else(RuntimeRefreshDto::clean)
    }

    pub async fn pending_workspace_states(&self) -> Vec<WorkspaceRefreshState> {
        self.inner
            .read()
            .await
            .workspaces
            .values()
            .filter(|state| state.status == WorkspaceRefreshStatus::Pending)
            .cloned()
            .collect()
    }

    pub async fn set_auto_apply_blocked_by_active_runtime(
        &self,
        workspace_id: &str,
        blocked: bool,
    ) {
        let mut guard = self.inner.write().await;
        if let Some(state) = guard.workspaces.get_mut(workspace_id) {
            state.auto_apply_blocked_by_active_runtime = blocked;
        }
    }

    pub async fn runtime_refresh_dto(&self, workspace_id: &str) -> RuntimeRefreshDto {
        self.workspace_state(workspace_id)
            .await
            .map(|state| state.to_dto())
            .unwrap_or_else(RuntimeRefreshDto::clean)
    }

    pub async fn mark_applying(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> RefreshApplyAttempt {
        let now = Utc::now();
        let mut guard = self.inner.write().await;
        let attempt_id = guard.next_attempt_id;
        guard.next_attempt_id += 1;
        let state = guard
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceRefreshState {
                workspace_id: workspace_id.to_owned(),
                workspace_path: workspace_path.display().to_string(),
                status: WorkspaceRefreshStatus::Applying,
                strongest_impact: RefreshImpact::UserApplyRequired,
                recommended_action: RefreshRecommendedAction::ApplyChanges,
                change_kinds: BTreeSet::new(),
                sources: BTreeSet::new(),
                auto_apply_blocked_by_active_runtime: false,
                revision: 0,
                apply_attempt_id: None,
                first_detected_at: now,
                last_detected_at: now,
                last_error: None,
            });
        state.workspace_path = workspace_path.display().to_string();
        state.status = WorkspaceRefreshStatus::Applying;
        state.recommended_action = RefreshRecommendedAction::ApplyChanges;
        state.apply_attempt_id = Some(attempt_id);
        state.last_error = None;
        state.last_detected_at = now;
        RefreshApplyAttempt {
            workspace_revision: state.revision,
            attempt_id,
        }
    }

    pub async fn clear_applied(&self, workspace_id: &str, attempt: RefreshApplyAttempt) {
        let mut guard = self.inner.write().await;
        let Some(state) = guard.workspaces.get(workspace_id) else {
            return;
        };
        if state.apply_attempt_id != Some(attempt.attempt_id) {
            return;
        }

        let should_clear = state.revision == attempt.workspace_revision
            || (state.sources.len() == 1
                && state.sources.contains(&RefreshSource::FilesystemWatch)
                && state.change_kinds.iter().all(|kind| {
                    matches!(
                        kind,
                        RefreshChangeKind::OpencodeJson | RefreshChangeKind::Skills
                    )
                }));

        if should_clear {
            guard.workspaces.remove(workspace_id);
        }
    }

    /// Drop one pending kind after it has been applied independently.
    ///
    /// Skills can be cache-invalidated without applying MCP/env/provider
    /// changes. When `kind` is the last remaining kind the workspace is
    /// removed (clean); otherwise other kinds stay pending.
    pub async fn clear_change_kind(&self, workspace_id: &str, kind: RefreshChangeKind) {
        let mut guard = self.inner.write().await;
        let Some(state) = guard.workspaces.get_mut(workspace_id) else {
            return;
        };
        state.change_kinds.remove(&kind);
        if state.change_kinds.is_empty() {
            guard.workspaces.remove(workspace_id);
            return;
        }
        state.strongest_impact = strongest_impact(state.change_kinds.iter().copied());
        state.recommended_action = recommended_action_for_kinds(&state.change_kinds);
        if state.status == WorkspaceRefreshStatus::Applying {
            state.status = WorkspaceRefreshStatus::Pending;
        }
        state.apply_attempt_id = None;
        state.auto_apply_blocked_by_active_runtime = false;
        state.last_error = None;
    }

    pub async fn mark_apply_failed(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        attempt: RefreshApplyAttempt,
        error: impl Into<String>,
    ) {
        let now = Utc::now();
        let error = error.into();
        let mut guard = self.inner.write().await;
        let state = guard
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceRefreshState {
                workspace_id: workspace_id.to_owned(),
                workspace_path: workspace_path.display().to_string(),
                status: WorkspaceRefreshStatus::Failed,
                strongest_impact: RefreshImpact::UserApplyRequired,
                recommended_action: RefreshRecommendedAction::ApplyChanges,
                change_kinds: BTreeSet::new(),
                sources: BTreeSet::new(),
                auto_apply_blocked_by_active_runtime: false,
                revision: 0,
                apply_attempt_id: Some(attempt.attempt_id),
                first_detected_at: now,
                last_detected_at: now,
                last_error: None,
            });
        if state.apply_attempt_id != Some(attempt.attempt_id) {
            return;
        }
        state.workspace_path = workspace_path.display().to_string();
        state.status = WorkspaceRefreshStatus::Failed;
        state.recommended_action = RefreshRecommendedAction::ApplyChanges;
        state.last_error = Some(error);
        state.last_detected_at = now;
    }
}

fn impact_for_kind(kind: RefreshChangeKind) -> RefreshImpact {
    match kind {
        RefreshChangeKind::Mcp | RefreshChangeKind::TeamcluConfig => RefreshImpact::IdleRestart,
        RefreshChangeKind::Skills
        | RefreshChangeKind::EnvVars
        | RefreshChangeKind::ProviderAuth
        | RefreshChangeKind::ProviderCatalog
        | RefreshChangeKind::Permissions
        | RefreshChangeKind::OpencodeJson => RefreshImpact::IdleReload,
    }
}

fn strongest_impact(kinds: impl Iterator<Item = RefreshChangeKind>) -> RefreshImpact {
    kinds
        .map(impact_for_kind)
        .max_by_key(|impact| match impact {
            RefreshImpact::AppliedLive => 0,
            RefreshImpact::IdleReload => 1,
            RefreshImpact::IdleRestart => 2,
            RefreshImpact::UserApplyRequired => 3,
        })
        .unwrap_or(RefreshImpact::AppliedLive)
}

fn recommended_action_for_kinds(kinds: &BTreeSet<RefreshChangeKind>) -> RefreshRecommendedAction {
    if kinds.is_empty() {
        return RefreshRecommendedAction::None;
    }
    if kinds
        .iter()
        .any(|kind| activation_policy(*kind) == RefreshActivationPolicy::NextRuntimeStart)
    {
        RefreshRecommendedAction::None
    } else if kinds
        .iter()
        .all(|kind| activation_policy(*kind) == RefreshActivationPolicy::Live)
    {
        RefreshRecommendedAction::None
    } else {
        RefreshRecommendedAction::ApplyChanges
    }
}

impl RefreshChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::EnvVars => "env_vars",
            Self::ProviderAuth => "provider_auth",
            Self::ProviderCatalog => "provider_catalog",
            Self::Permissions => "permissions",
            Self::OpencodeJson => "opencode_json",
            Self::TeamcluConfig => "teamclu_config",
        }
    }

    /// Whether applying this change requires restarting the global
    /// `opencode serve` process so freshly-created sessions pick it up.
    ///
    /// Only provider-auth / provider-config kinds do. `Mcp` config is merged
    /// into the worktree's `opencode.json` at `attach_session(mcp_config_path)`
    /// time rather than baked into the process; `Permissions` are enforced
    /// per-turn. Restarting for those merely discards a warm serve instance
    /// and forces the next session to cold-start the binary again — the exact
    /// regression this predicate guards against.
    ///
    /// `Skills` and `TeamcluConfig` don't touch the serve *process* either,
    /// but opencode memoizes skills per directory instance inside it, so
    /// applying them does dispose that cached instance (see
    /// `OpenCodeHostPool::dispose_workspace_instance`, wired from
    /// `reload_workspace`) — a far cheaper invalidation that leaves the
    /// process warm.
    pub fn requires_provider_host_evict(self) -> bool {
        matches!(
            self,
            Self::ProviderAuth | Self::ProviderCatalog | Self::OpencodeJson | Self::EnvVars
        )
    }
}

impl RefreshRecommendedAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ApplyChanges => "apply_changes",
        }
    }
}

impl WorkspaceRefreshStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Pending => "pending",
            Self::Applying => "applying",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws_path(id: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!("/tmp/{id}"))
    }

    #[tokio::test]
    async fn strongest_pending_impact_wins() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-1",
                Path::new("/tmp/ws-1"),
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();
        coordinator
            .record_change(
                "ws-1",
                Path::new("/tmp/ws-1"),
                RefreshChangeKind::Mcp,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let state = coordinator.workspace_state("ws-1").await.unwrap();
        assert_eq!(state.status, WorkspaceRefreshStatus::Pending);
        assert_eq!(state.recommended_action, RefreshRecommendedAction::None);
        assert_eq!(state.strongest_impact, RefreshImpact::IdleRestart);
        assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
        assert!(state.change_kinds.contains(&RefreshChangeKind::Mcp));
    }

    #[tokio::test]
    async fn path_lookup_bridges_http_route_id_to_runtime_workspace_id() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let path = Path::new("/tmp/teamclu-runtime-id-bridge");
        coordinator
            .record_change(
                "cloud-workspace-uuid",
                path,
                RefreshChangeKind::Skills,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();
        let path_identity = refresh_watch::workspace_runtime_id(path);
        coordinator
            .record_change(
                &path_identity,
                path,
                RefreshChangeKind::OpencodeJson,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        assert_eq!(
            coordinator.workspace_id_for_path(path).await.as_deref(),
            Some("cloud-workspace-uuid")
        );
        let dto = coordinator
            .runtime_refresh_dto_for_path(&path_identity, path)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.change_kinds, vec!["skills"]);
    }

    #[tokio::test]
    async fn failed_apply_preserves_failed_state_and_change_context() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-2",
                Path::new("/tmp/ws-2"),
                RefreshChangeKind::EnvVars,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        let attempt = coordinator
            .mark_applying("ws-2", Path::new("/tmp/ws-2"))
            .await;
        coordinator
            .mark_apply_failed("ws-2", Path::new("/tmp/ws-2"), attempt, "reload failed")
            .await;

        let state = coordinator.workspace_state("ws-2").await.unwrap();
        assert_eq!(state.status, WorkspaceRefreshStatus::Failed);
        assert_eq!(
            state.recommended_action,
            RefreshRecommendedAction::ApplyChanges
        );
        assert!(state
            .last_error
            .as_deref()
            .unwrap()
            .contains("reload failed"));
        assert!(state.change_kinds.contains(&RefreshChangeKind::EnvVars));

        let dto = coordinator.runtime_refresh_dto("ws-2").await;
        assert_eq!(dto.status, "failed");
        assert_eq!(dto.recommended_action, "apply_changes");
        assert_eq!(dto.change_kinds, vec!["env_vars".to_string()]);
        assert!(dto.last_error.as_deref().unwrap().contains("reload failed"));
    }

    #[tokio::test]
    async fn runtime_refresh_dto_reports_pending_state() {
        let coordinator = RuntimeRefreshCoordinator::new();
        coordinator
            .record_change(
                "ws-3",
                Path::new("/tmp/ws-3"),
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        let dto = coordinator.runtime_refresh_dto("ws-3").await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");
        assert_eq!(dto.change_kinds, vec!["skills".to_string()]);
        assert_eq!(dto.last_error, None);
    }

    #[tokio::test]
    async fn runtime_refresh_dto_returns_clean_when_state_absent() {
        let coordinator = RuntimeRefreshCoordinator::new();

        let dto = coordinator.runtime_refresh_dto("ws-clean").await;
        assert_eq!(dto.status, "clean");
        assert_eq!(dto.recommended_action, "none");
        assert!(dto.change_kinds.is_empty());
        assert_eq!(dto.last_detected_at, None);
        assert_eq!(dto.last_error, None);
    }

    #[tokio::test]
    async fn clear_applied_does_not_drop_newer_changes() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace = ws_path("ws-apply-race");
        coordinator
            .record_change(
                "ws-apply-race",
                &workspace,
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();

        let attempt = coordinator.mark_applying("ws-apply-race", &workspace).await;

        coordinator
            .record_change(
                "ws-apply-race",
                &workspace,
                RefreshChangeKind::Mcp,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        coordinator.clear_applied("ws-apply-race", attempt).await;

        let dto = coordinator.runtime_refresh_dto("ws-apply-race").await;
        assert_eq!(dto.status, "pending");
        assert!(dto.change_kinds.contains(&"skills".to_string()));
        assert!(dto.change_kinds.contains(&"mcp".to_string()));
    }

    #[tokio::test]
    async fn clear_change_kind_keeps_other_pending_kinds() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace = ws_path("ws-clear-kind");
        coordinator
            .record_change(
                "ws-clear-kind",
                &workspace,
                RefreshChangeKind::Skills,
                RefreshSource::UiMutation,
            )
            .await
            .unwrap();
        coordinator
            .record_change(
                "ws-clear-kind",
                &workspace,
                RefreshChangeKind::Mcp,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        coordinator
            .clear_change_kind("ws-clear-kind", RefreshChangeKind::Skills)
            .await;

        let dto = coordinator.runtime_refresh_dto("ws-clear-kind").await;
        assert_eq!(dto.status, "pending");
        assert!(!dto.change_kinds.iter().any(|k| k == "skills"));
        assert!(dto.change_kinds.contains(&"mcp".to_string()));
    }

    #[tokio::test]
    async fn suppress_blocks_matching_kind_until_expiry() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace_id = "ws-suppress";

        coordinator.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_OPENCODE_KINDS,
            Duration::from_millis(50),
        );

        assert!(coordinator.is_watch_suppressed(workspace_id, RefreshChangeKind::OpencodeJson));
        assert!(!coordinator.is_watch_suppressed(workspace_id, RefreshChangeKind::Skills));

        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!coordinator.is_watch_suppressed(workspace_id, RefreshChangeKind::OpencodeJson));
    }

    #[tokio::test]
    async fn suppress_extends_window_when_called_again() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace_id = "ws-extend";

        coordinator.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_OPENCODE_KINDS,
            Duration::from_millis(80),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        coordinator.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_OPENCODE_KINDS,
            Duration::from_millis(80),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(coordinator.is_watch_suppressed(workspace_id, RefreshChangeKind::OpencodeJson));
    }

    #[tokio::test]
    async fn clear_applied_clears_when_only_filesystem_watch_during_apply() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace = ws_path("ws-apply-noise");
        let workspace_id = "ws-apply-noise";

        coordinator
            .record_change(
                workspace_id,
                &workspace,
                RefreshChangeKind::OpencodeJson,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let attempt = coordinator.mark_applying(workspace_id, &workspace).await;

        coordinator
            .record_change(
                workspace_id,
                &workspace,
                RefreshChangeKind::OpencodeJson,
                RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        coordinator.clear_applied(workspace_id, attempt).await;

        let dto = coordinator.runtime_refresh_dto(workspace_id).await;
        assert_eq!(dto.status, "clean");
    }

    #[tokio::test]
    async fn apply_failure_creates_failed_state_for_clean_workspace() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspace = ws_path("ws-failed-clean");

        let attempt = coordinator
            .mark_applying("ws-failed-clean", &workspace)
            .await;
        coordinator
            .mark_apply_failed("ws-failed-clean", &workspace, attempt, "reload failed")
            .await;

        let dto = coordinator.runtime_refresh_dto("ws-failed-clean").await;
        assert_eq!(dto.status, "failed");
        assert_eq!(dto.recommended_action, "apply_changes");
        assert!(dto.change_kinds.is_empty());
        assert_eq!(dto.last_error.as_deref(), Some("reload failed"));
    }

    #[test]
    fn parse_refresh_change_kinds_maps_known_and_dedupes() {
        let kinds = parse_refresh_change_kinds(&[
            "env_vars".to_string(),
            "skills".to_string(),
            "env_vars".to_string(),
            "nope".to_string(),
        ]);
        assert_eq!(
            kinds,
            vec![RefreshChangeKind::EnvVars, RefreshChangeKind::Skills]
        );
    }
}
