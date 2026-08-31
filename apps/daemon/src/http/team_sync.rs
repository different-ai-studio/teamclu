//! HTTP loopback endpoints for daemon-owned team sync (desktop triggers these).
//!
//! The desktop app drives team sync over the daemon's loopback HTTP API rather
//! than running OSS sync itself. `POST /v1/team/sync` kicks a sync for the
//! daemon's onboarded team; `GET /v1/team/sync/status` reads the cached last
//! status. The daemon is single-team, so the team_id is resolved from
//! `daemon.toml` (teamclu.json carries no team_id) — same lookup as
//! `/v1/team/link`.
//!
//! `workspacePath` is optional and only ever used to repair that workspace's
//! team links as a side effect. What gets synced is the team's own tree under
//! the amuxd home, so a client with no folder open can still sync.
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::sync::versions::{ChangedFile, StuckFile, VersionEntry};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    /// Optional. Present only so this call can also repair that workspace's
    /// team links; it never decides what is synced.
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// When `true`, run sync even if `team_share.auto_sync` is `false`.
    #[serde(default)]
    pub force_sync: bool,
    /// When `true`, push a batch of new files an earlier tick held back for
    /// confirmation. Set by the UI when a person answers "yes, send them" —
    /// never by a retry, or the guard becomes a one-tick delay.
    #[serde(default)]
    pub allow_bulk_add: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    #[serde(flatten)]
    pub status: crate::sync::dispatch::SyncStatus,
}

/// `POST /v1/team/sync` — body `{ "workspacePath"?: "<abs path>" }`.
pub async fn sync_now(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = body
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let team_id = active_team_id()?;
    // Opportunistic repair of the caller's workspace links, when it named one.
    if let Some(path) = workspace_path {
        crate::team_link::ensure_team_link(&team_id, path);
    }
    let status = state
        .sync_dispatcher
        .sync_team(
            &team_id,
            crate::sync::dispatch::SyncOptions {
                force: body.force_sync,
                allow_bulk_add: body.allow_bulk_add,
            },
        )
        .await;
    if status.skipped {
        return Ok(Json(SyncResponse { status }));
    }
    if let Some(err) = status
        .last_error
        .as_deref()
        .filter(|e| !e.trim().is_empty())
    {
        return Err(HttpError::internal(err.to_string()));
    }
    Ok(Json(SyncResponse { status }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusQuery {
    pub team_id: String,
}

/// `GET /v1/team/sync/status?teamId=...`
pub async fn sync_status(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<crate::sync::dispatch::SyncStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    Ok(Json(state.sync_dispatcher.status(&q.team_id).await))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCloudConfigRequest {
    /// Optional override; when omitted the daemon's onboarded team is used.
    #[serde(default)]
    pub team_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCloudConfigResponse {
    pub team_id: String,
    pub mcp_changed: bool,
    pub env_changed: bool,
}

/// `POST /v1/team/cloud-config/reconcile` — pull team MCP / team env from the
/// Cloud API into the daemon-owned cache immediately, then fan-out refresh
/// signals so the UI can prompt for a runtime restart.
///
/// Desktop calls this after a successful team env write/delete. Without it the
/// background tick (300s) is the only converge path, and the cloud cache sits
/// outside every `refresh_watch` root so no EnvVars change would ever surface.
pub async fn reconcile_cloud_config(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<ReconcileCloudConfigRequest>,
) -> Result<Json<ReconcileCloudConfigResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = body
        .team_id
        .and_then(|id| {
            let trimmed = id.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .map(Ok)
        .unwrap_or_else(active_team_id)?;

    let outcome = reconcile_team_cloud_after_write(&state, &team_id).await?;

    Ok(Json(ReconcileCloudConfigResponse {
        team_id,
        mcp_changed: outcome.mcp_changed,
        env_changed: outcome.env_changed,
    }))
}

/// Re-fetch the team MCP/env cache immediately and fan out refresh signals.
/// Shared by the reconcile route and the team MCP install/uninstall routes so a
/// write surfaces without waiting out the 300s background tick.
async fn reconcile_team_cloud_after_write(
    state: &HttpState,
    team_id: &str,
) -> Result<crate::runtime::team_cloud_config::TeamCloudReconcileOutcome, HttpError> {
    let workspace_paths = team_mcp_workspace_paths_for_state(state, team_id).await;
    let previous_team_mcp = snapshot_team_mcp(&workspace_paths);

    let Some(resolver) = state.team_cloud.as_ref() else {
        return Err(HttpError::runtime_unavailable(
            "team cloud config resolver is not available",
        ));
    };
    let outcome = resolver.reconcile_now(team_id).await;
    crate::runtime::team_cloud_config::apply_team_cloud_outcome(
        team_id,
        outcome,
        state.backend.as_ref(),
        state.runtime_refresh.as_ref(),
    )
    .await;
    prune_team_mcp_snapshots(team_id, &previous_team_mcp);
    Ok(outcome)
}

type TeamMcpSnapshot = (
    std::path::PathBuf,
    std::collections::HashMap<String, crate::config::workspace_control::McpServerConfig>,
);

async fn team_mcp_workspace_paths_for_state(
    state: &HttpState,
    team_id: &str,
) -> Vec<std::path::PathBuf> {
    let rows = match state.backend.as_ref() {
        Some(backend) => backend
            .get_workspaces_by_agent(team_id, backend.actor_id())
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    team_mcp_workspace_paths(team_id, &rows)
}

fn snapshot_team_mcp(workspace_paths: &[std::path::PathBuf]) -> Vec<TeamMcpSnapshot> {
    workspace_paths
        .iter()
        .map(|path| (path.clone(), crate::config::team_mcp::scan_team_mcp(path)))
        .collect()
}

fn prune_team_mcp_snapshots(team_id: &str, snapshots: &[TeamMcpSnapshot]) {
    for (workspace_path, previous_team) in snapshots {
        let path = workspace_path.to_string_lossy().into_owned();
        if let Err(e) = crate::config::team_mcp::prune_materialised_team_mcp_entries(
            workspace_path,
            previous_team,
        ) {
            tracing::warn!(
                team_id,
                path,
                error = %e,
                "failed to prune leftover team MCP copies from opencode.json"
            );
        }
    }
}

fn team_mcp_workspace_paths(
    team_id: &str,
    rows: &[crate::backend::WorkspaceRow],
) -> Vec<std::path::PathBuf> {
    let mut paths = std::collections::BTreeSet::new();
    let default = crate::config::global_team_store::default_workspace_dir(team_id);
    if default.is_dir() {
        paths.insert(default);
    }
    for row in rows {
        if let Some((path, _)) = crate::config::workspace_path::listable_local_workspace(row) {
            paths.insert(std::path::PathBuf::from(path));
        }
    }
    paths.into_iter().collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMcpInstallResponse {
    pub team_id: String,
    pub mcp_changed: bool,
}

/// `PUT /v1/team/mcp-servers/:name/install`
///
/// Installs a team MCP server for the daemon's own agent actor — never the
/// desktop user. The daemon is what spawns and probes the server, so the install
/// must land on the daemon's actor for the merged MCP view (and therefore the
/// tool probe) to pick it up. Then the team MCP cache is re-fetched immediately.
pub async fn install_team_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(name): Path<String>,
) -> Result<Json<TeamMcpInstallResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    let backend = state
        .backend
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("cloud backend unavailable"))?;
    backend
        .install_team_mcp(&team_id, &name)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let outcome = reconcile_team_cloud_after_write(&state, &team_id).await?;
    Ok(Json(TeamMcpInstallResponse {
        team_id,
        mcp_changed: outcome.mcp_changed,
    }))
}

/// `DELETE /v1/team/mcp-servers/:name/install`
pub async fn uninstall_team_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(name): Path<String>,
) -> Result<Json<TeamMcpInstallResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    let backend = state
        .backend
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("cloud backend unavailable"))?;
    backend
        .uninstall_team_mcp(&team_id, &name)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let outcome = reconcile_team_cloud_after_write(&state, &team_id).await?;
    Ok(Json(TeamMcpInstallResponse {
        team_id,
        mcp_changed: outcome.mcp_changed,
    }))
}

// ---------------------------------------------------------------------------
// Daemon-owned team skill management
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillsResponse {
    pub team_id: String,
    pub skills: Vec<crate::backend::TeamSkillRow>,
}

/// `GET /v1/team/skills` — list registry skills decorated for this daemon's
/// own agent actor. The handler deliberately uses the daemon's shared backend;
/// a local management client must never create a second refresh-token owner.
pub async fn list_team_skills(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<TeamSkillsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, team_id) = daemon_backend_and_team(&state)?;
    let skills = backend
        .team_skills(&team_id)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    Ok(Json(TeamSkillsResponse { team_id, skills }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTeamSkillRequest {
    pub version: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillReconcileResponse {
    pub team_id: String,
    #[serde(flatten)]
    pub outcome: crate::runtime::team_skills::TeamSkillReconcileOutcome,
}

/// `PUT /v1/team/skills/:slug/install` — assign a published skill to this
/// daemon actor and materialise the resulting desired set immediately.
pub async fn install_team_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path(slug): Path<String>,
    Json(body): Json<InstallTeamSkillRequest>,
) -> Result<Json<TeamSkillReconcileResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if slug.trim().is_empty() {
        return Err(HttpError::validation("skill slug must not be empty"));
    }
    if body.version < 1 {
        return Err(HttpError::validation("skill version must be at least 1"));
    }
    let (backend, team_id) = daemon_backend_and_team(&state)?;
    backend
        .record_team_skill_install(&team_id, &slug, body.version)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    reconcile_team_skills_for_state(&state, team_id).await
}

/// `DELETE /v1/team/skills/:slug/install` — remove the desired assignment for
/// this daemon's own Agent and reconcile disk immediately.
pub async fn uninstall_team_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path(slug): Path<String>,
) -> Result<Json<TeamSkillReconcileResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if slug.trim().is_empty() {
        return Err(HttpError::validation("skill slug must not be empty"));
    }
    let (backend, team_id) = daemon_backend_and_team(&state)?;
    backend
        .remove_team_skill_install(&team_id, &slug)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    reconcile_team_skills_for_state(&state, team_id).await
}

/// `POST /v1/team/skills/reconcile` — force the same reconciler used by the
/// daemon's periodic task to run now.
pub async fn reconcile_team_skills(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<TeamSkillReconcileResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (_, team_id) = daemon_backend_and_team(&state)?;
    reconcile_team_skills_for_state(&state, team_id).await
}

async fn reconcile_team_skills_for_state(
    state: &HttpState,
    team_id: String,
) -> Result<Json<TeamSkillReconcileResponse>, HttpError> {
    let reconciler = state
        .team_skills
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("team skill reconciler is not available"))?;
    let outcome = reconciler.reconcile_now(&team_id).await;
    crate::runtime::team_skills::apply_team_skill_outcome(
        &team_id,
        outcome,
        state.backend.as_ref(),
        state.runtime_refresh.as_ref(),
        state.refresh_watch_registry.as_ref(),
    )
    .await;
    Ok(Json(TeamSkillReconcileResponse { team_id, outcome }))
}

fn daemon_backend_and_team(
    state: &HttpState,
) -> Result<(&std::sync::Arc<dyn crate::backend::Backend>, String), HttpError> {
    let backend = state
        .backend
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("cloud backend unavailable"))?;
    let team_id = backend.team_id().trim().to_string();
    if team_id.is_empty() {
        return Err(HttpError::validation("daemon is not onboarded to a team"));
    }
    Ok((backend, team_id))
}

// ---------------------------------------------------------------------------
// Task 11: secrets delivery
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsRequest {
    pub team_id: String,
    #[serde(default)]
    pub oss_team_secret: Option<String>,
    #[serde(default)]
    pub user_jwt: Option<String>,
}

/// `POST /v1/team/secrets` — desktop delivers credentials for headless sync.
/// JWTs expire: while the app is closed and the stored JWT is expired, OSS timer
/// syncs fail until the desktop re-posts a fresh JWT.
pub async fn set_secrets(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SecretsRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // Trim then validate, exactly as `amuxd team secrets set` does: a secret
    // pasted into the setup UI arrives with stray whitespace far more often than
    // one typed as a CLI flag, and a malformed secret stored here would not
    // surface until it failed to decrypt on the next sync tick.
    let oss_team_secret = body.oss_team_secret.map(|s| s.trim().to_string());
    if let Some(secret) = oss_team_secret.as_deref() {
        crate::sync::secret_store::validate_team_secret(secret).map_err(HttpError::validation)?;
    }
    let incoming = crate::sync::secret_store::TeamSecrets {
        oss_team_secret,
        user_jwt: body.user_jwt,
        channel_secrets: Default::default(),
    };
    state
        .sync_dispatcher
        .secrets()
        .merge(&body.team_id, &incoming)
        .map_err(|e| HttpError::internal(format!("store secrets: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub set: bool,
    /// Masked fingerprint (`(set, ab12…ef90)`), never the value. See
    /// [`crate::sync::secret_store::mask_secret`].
    pub display: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatusResponse {
    pub team_id: String,
    pub oss_team_secret: SecretStatus,
    pub user_jwt: SecretStatus,
}

/// `GET /v1/team/secrets?teamId=...` — which sync credentials are stored.
///
/// The read counterpart of `POST /v1/team/secrets`, which had no way to answer
/// "is this already configured?" over HTTP — only `amuxd team secrets show`
/// could. Values are never returned, so this is `workspace:read` rather than
/// `workspace:write`: it reveals set/unset plus a fingerprint, the same
/// information the CLI prints.
pub async fn get_secrets(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<SecretsStatusResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let secrets = state
        .sync_dispatcher
        .secrets()
        .load(&q.team_id)
        .map_err(|e| HttpError::internal(format!("read secrets: {e}")))?;

    let status = |v: Option<&str>| SecretStatus {
        set: v.is_some(),
        display: crate::sync::secret_store::mask_secret(v),
    };

    Ok(Json(SecretsStatusResponse {
        team_id: q.team_id.clone(),
        oss_team_secret: status(secrets.oss_team_secret.as_deref()),
        user_jwt: status(secrets.user_jwt.as_deref()),
    }))
}

// ---------------------------------------------------------------------------
// Task 12: conflict + version endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    /// Sync key of the DOCUMENT that conflicted (`knowledge/<rel>`) — the file
    /// the user recognises, and the one a decision is made about.
    pub path: String,
    /// Sync key of the sidecar holding the local version that lost.
    pub sidecar: String,
    /// Unix seconds recorded in the sidecar's name, when parseable. The
    /// sidecar's own mtime is not the same thing — a copy or a restore moves it.
    pub conflicted_at: Option<u64>,
    pub kind: String,
}

/// `GET /v1/team/conflicts?teamId=...` — one entry per OSS conflict sidecar on
/// disk under the global team dir.
///
/// The sidecar is the only DURABLE record that a conflict happened: the
/// `conflicts` counter in `/v1/team/sync/status` is per-tick and resets on the
/// next one, so "how many conflicts are waiting for me" can only be read from
/// this scan.
pub async fn list_conflicts(
    principal: Principal,
    State(_state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Vec<ConflictEntry>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let root = crate::config::global_team_store::sync_content_root(&q.team_id);
    Ok(Json(conflict_entries(&root)))
}

/// Every conflict sidecar under one team's synced tree, as decisions to make.
fn conflict_entries(root: &std::path::Path) -> Vec<ConflictEntry> {
    let mut out = crate::sync::oss::scanner::scan_conflict_files(&root.to_string_lossy())
        .into_iter()
        // A name that does not reverse into a document is not a decision anyone
        // can make: `resolve` requires the sidecar to belong to the path, so
        // listing it would put a permanent badge on the panel with nothing
        // behind it. `is_conflict_file` should already have excluded these.
        .filter_map(|sidecar| {
            let path = crate::sync::oss::conflict::original_from_conflict(&sidecar)?;
            Some(ConflictEntry {
                path,
                conflicted_at: crate::sync::oss::conflict::conflict_timestamp(&sidecar),
                sidecar,
                kind: "oss-sidecar".into(),
            })
        })
        .collect::<Vec<_>>();
    // WalkDir yields filesystem order, which is stable on neither platform.
    // Sort so a poll every few seconds does not reshuffle the list under the
    // user's cursor; newest conflict first within one document.
    out.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(b.conflicted_at.cmp(&a.conflicted_at))
            .then(a.sidecar.cmp(&b.sidecar))
    });
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub team_id: String,
    pub path: String,
    /// Which sidecar this decision is about. One document can accumulate
    /// several (it conflicted more than once), and each is its own decision.
    /// Optional for older callers: the newest sidecar is used when absent.
    #[serde(default)]
    pub sidecar: Option<String>,
    pub choice: crate::sync::oss::ConflictChoice,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponse {
    pub ok: bool,
    /// The sidecar that was acted on; `None` when there was nothing left to do.
    pub sidecar: Option<String>,
}

/// `POST /v1/team/conflicts/resolve` — carry out the user's decision on ONE
/// conflict sidecar.
///
/// What the disk looks like when this is called: the sync engine wrote the
/// user's bytes to the sidecar and then let the remote version overwrite the
/// original (`engine.rs` PULL/PUSH conflict paths). So:
///
/// - `KeepLocal` means "put my bytes back and send them up" — copy the sidecar
///   over the original and mark the entry dirty. The next push CAS-es against
///   the remote version the engine already recorded, so it wins rather than
///   conflicting a second time.
/// - `KeepRemote` means "throw mine away" — the original is ALREADY the remote
///   version, so there is nothing to write, only the losing copy to clear.
///
/// Both branches delete the sidecar. It is local-only (the scanner never
/// uploads anything under `.conflicts/`), so leaving it behind would just
/// accumulate junk — which is exactly what happened before this endpoint did
/// any disk work at all.
pub async fn resolve_conflict(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<ResolveResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let sidecar = apply_conflict_decision(
        &body.team_id,
        &body.path,
        body.sidecar.as_deref(),
        body.choice,
    )
    .map_err(|e| match e {
        DecisionError::Invalid(m) => HttpError::validation(m),
        DecisionError::Failed(m) => HttpError::internal(m),
    })?;
    Ok(Json(ResolveResponse { ok: true, sidecar }))
}

/// Why a decision could not be carried out: a caller mistake (rejected) versus a
/// disk failure (retryable). The handler is the only place that knows these are
/// HTTP statuses, which keeps the logic below testable without a server.
#[derive(Debug)]
enum DecisionError {
    Invalid(String),
    Failed(String),
}

/// Carry out one conflict decision on disk + in sync state. Returns the sidecar
/// that was acted on, or `None` when there was nothing left to resolve.
fn apply_conflict_decision(
    team_id: &str,
    path: &str,
    sidecar: Option<&str>,
    choice: crate::sync::oss::ConflictChoice,
) -> Result<Option<String>, DecisionError> {
    crate::sync::oss::path_validator::validate(path)
        .map_err(|e| DecisionError::Invalid(format!("invalid path: {e}")))?;
    // `validate` deliberately still accepts the RETIRED prefixes (`skills/`,
    // `.mcp/`, `_secrets/`, …) so a legacy manifest row cannot abort a pull.
    // This endpoint writes and deletes what it is handed, and the only thing it
    // is ever asked about is a document — so it takes the narrower rule.
    if !is_live_sync_prefix(path) {
        return Err(DecisionError::Invalid(format!(
            "path is not team knowledge content: {path}"
        )));
    }

    let root = crate::config::global_team_store::sync_content_root(team_id);

    let sidecar = match sidecar.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(s.to_string()),
        None => newest_sidecar_for(&root, path),
    };
    // Nothing on disk: already resolved elsewhere, or removed by hand. A second
    // click must read as "done", not as a 500.
    let Some(sidecar) = sidecar else {
        return Ok(None);
    };

    crate::sync::oss::path_validator::validate(&sidecar)
        .map_err(|e| DecisionError::Invalid(format!("invalid sidecar: {e}")))?;
    if !is_live_sync_prefix(&sidecar) {
        return Err(DecisionError::Invalid(format!(
            "sidecar is not team knowledge content: {sidecar}"
        )));
    }
    // This deletes a file the caller names, so the name has to be a sidecar OF
    // THIS DOCUMENT — never an arbitrary path under the team tree.
    if !crate::sync::oss::scanner::is_conflict_file(&sidecar) {
        return Err(DecisionError::Invalid(format!(
            "not a conflict sidecar: {sidecar}"
        )));
    }
    if crate::sync::oss::conflict::original_from_conflict(&sidecar).as_deref() != Some(path) {
        return Err(DecisionError::Invalid(format!(
            "sidecar {sidecar} does not belong to {path}"
        )));
    }

    let sidecar_abs = root.join(&sidecar);
    let original_abs = root.join(path);
    for abs in [&sidecar_abs, &original_abs] {
        crate::sync::oss::path_validator::validate_no_symlink_escape(&root, abs)
            .map_err(|e| DecisionError::Invalid(format!("invalid path: {e}")))?;
    }

    // The named sidecar may have gone between the scan and this request —
    // another window resolved it, or the user deleted it by hand. That is
    // "already done", and saying so beats the alternative: KeepLocal used to
    // fall through with nothing restored, mark the document dirty anyway, and
    // report success — which pushed the REMOTE content back up while telling
    // the user their own copy had been restored.
    if !sidecar_abs.is_file() {
        return Ok(None);
    }

    let mut st = crate::sync::oss::state::LocalSyncState::load_at(team_id)
        .map_err(|e| DecisionError::Failed(format!("load sync state: {e}")))?;

    match choice {
        crate::sync::oss::ConflictChoice::KeepLocal => {
            let bytes = std::fs::read(&sidecar_abs)
                .map_err(|e| DecisionError::Failed(format!("read sidecar: {e}")))?;
            // Restore first, delete second: a failure in between leaves the
            // user's bytes recoverable from the sidecar rather than gone.
            write_atomic(team_id, &original_abs, &bytes)
                .map_err(|e| DecisionError::Failed(format!("restore local copy: {e}")))?;
            let _ = std::fs::remove_file(&sidecar_abs);
            if let Some(fs) = st.files.get_mut(path) {
                // mtime/size are deliberately left at the last-synced baseline:
                // the scanner compares them against disk to decide what to
                // re-hash, and the file it must re-hash is exactly this one.
                fs.dirty = true;
                fs.deleted_local = false;
            }
        }
        crate::sync::oss::ConflictChoice::KeepRemote => {
            let _ = std::fs::remove_file(&sidecar_abs);
            if let Some(fs) = st.files.get_mut(path) {
                fs.local_plain_hash = fs.synced_plain_hash.clone();
                fs.dirty = false;
            }
        }
    }

    // The sidecar is gone; the mirrored directories it lived in are not. Without
    // this, `knowledge/.conflicts/a/b/c/` survives every resolution and a vault
    // that has seen many conflicts keeps a full shadow tree that
    // `scan_conflict_files` walks on every poll.
    prune_empty_conflict_dirs(&root, &sidecar);

    st.save_at(team_id)
        .map_err(|e| DecisionError::Failed(format!("save sync state: {e}")))?;
    Ok(Some(sidecar))
}

/// Remove the now-empty directories a resolved sidecar leaves behind.
///
/// `remove_dir` only succeeds on an empty directory, so this can never take one
/// that still holds another conflict — or, for a legacy sidecar that sat beside
/// its note, the note's own directory. Stops at the sync prefix root, so
/// `knowledge/` itself always stays.
fn prune_empty_conflict_dirs(root: &std::path::Path, sidecar_rel: &str) {
    let mut parts: Vec<&str> = sidecar_rel.split('/').filter(|s| !s.is_empty()).collect();
    parts.pop(); // the filename
    while parts.len() > 1 {
        if std::fs::remove_dir(root.join(parts.join("/"))).is_err() {
            return;
        }
        parts.pop();
    }
}

/// Whether a sync path belongs to a prefix the product still carries.
///
/// Narrower than `path_validator::validate` on purpose — see the call sites.
fn is_live_sync_prefix(path: &str) -> bool {
    crate::sync::oss::path_validator::ALLOWED_PREFIXES
        .iter()
        .any(|p| path.starts_with(p))
}

/// The newest sidecar on disk for one document, by the timestamp in its name.
fn newest_sidecar_for(root: &std::path::Path, path: &str) -> Option<String> {
    crate::sync::oss::scanner::scan_conflict_files(&root.to_string_lossy())
        .into_iter()
        .filter(|s| crate::sync::oss::conflict::original_from_conflict(s).as_deref() == Some(path))
        .max_by_key(|s| crate::sync::oss::conflict::conflict_timestamp(s).unwrap_or(0))
}

/// Write `bytes` to `path` via a temp file + rename, so a crash mid-write cannot
/// leave a half-restored document.
///
/// The temp file lives beside the team's `state.json`, OUTSIDE the synced
/// `shared/` tree: a leftover inside it would be scanned as a brand new document
/// and pushed to the whole team on the next tick.
fn write_atomic(team_id: &str, path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    // One temp file per call. A single fixed name meant two concurrent
    // decisions (two windows, or a user clicking down a list of conflicts)
    // wrote the same path: one document could be restored with the other's
    // bytes, or the second rename could fail after its sidecar was gone.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ticket = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = crate::config::global_team_store::global_sync_state_path(team_id).with_file_name(
        format!("conflict-restore.{}.{ticket}.tmp", std::process::id()),
    );
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename onto {}: {e}", path.display())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsQuery {
    pub team_id: String,
    pub path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVersionsResponse {
    pub versions: Vec<VersionEntry>,
    pub next_cursor: Option<String>,
}

/// Build an `FcClient` from the per-team secret store. The daemon is single-team
/// and the team_secret is delivered via `/v1/team/secrets`. The FC bearer is the
/// daemon's own auto-refreshing cloud token (`oss_jwt`), not a desktop-delivered
/// JWT, so headless version browsing survives a stale delivered JWT. Returns
/// `(FcClient, team_secret)`.
async fn fc_client_from_store(
    state: &HttpState,
    team_id: &str,
    fc_endpoint: Option<String>,
) -> Result<(crate::sync::oss::fc_client::FcClient, Option<String>), HttpError> {
    // Optional: content goes up as plaintext now, so the secret is only needed
    // to open blobs written before that change. Demanding it here used to make
    // version history and restore unusable on a device that never had one.
    let team_secret = state
        .sync_dispatcher
        .secrets()
        .resolve_team_secret(team_id, None)
        .ok();
    let jwt = state
        .sync_dispatcher
        .oss_jwt()
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let base = fc_endpoint
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.sync_dispatcher.fc_endpoint().ok())
        .ok_or_else(|| {
            HttpError::internal(
                "FC endpoint not configured: no cloud backend URL available".to_string(),
            )
        })?;
    Ok((
        crate::sync::oss::fc_client::FcClient::new(base, jwt),
        team_secret,
    ))
}

/// Derive the content key when this device has a team secret at all.
///
/// `None` is a normal state, not a failure: it only means legacy (encrypted)
/// blobs are unreadable here, which `decode_blob` reports per blob.
fn optional_team_key(secret: Option<&str>) -> Result<Option<[u8; 32]>, HttpError> {
    match secret {
        Some(s) => Ok(Some(
            crate::team_shared_env::derive_key(s)
                .map_err(|e| HttpError::internal(format!("derive key: {e}")))?,
        )),
        None => Ok(None),
    }
}

/// An `FcClient` for calls that only read metadata.
///
/// Separate from [`fc_client_from_store`] because that one insists on the team
/// content secret, which a manifest read has no use for: nothing is decrypted
/// here. Requiring it would make "what is waiting for me in the cloud"
/// unanswerable on exactly the devices that most need to ask.
async fn fc_client_metadata_only(
    state: &HttpState,
    fc_endpoint: Option<String>,
) -> Result<crate::sync::oss::fc_client::FcClient, HttpError> {
    let jwt = state
        .sync_dispatcher
        .oss_jwt()
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let base = fc_endpoint
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.sync_dispatcher.fc_endpoint().ok())
        .ok_or_else(|| {
            HttpError::internal(
                "FC endpoint not configured: no cloud backend URL available".to_string(),
            )
        })?;
    Ok(crate::sync::oss::fc_client::FcClient::new(base, jwt))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePendingQuery {
    pub team_id: String,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePendingItem {
    pub path: String,
    pub version: i32,
    pub deleted: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePendingResponse {
    pub items: Vec<RemotePendingItem>,
    /// Where the server's log stood when this was read.
    pub snapshot_seq: i64,
    /// The local cursor it was measured against.
    pub since_seq: i64,
}

/// `GET /v1/team/remote-pending?teamId=&fcEndpoint=` — what the cloud has that
/// this device has not applied yet.
///
/// A READ-ONLY probe: it walks the manifest exactly as a tick would, then throws
/// the answer away — no blob is fetched, nothing is written, and the sync cursor
/// does not move. It costs one FC round-trip per call, which is why the client
/// asks on a schedule (panel opened, window focused, manual refresh) rather than
/// on a timer.
pub async fn remote_pending(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<RemotePendingQuery>,
) -> Result<Json<RemotePendingResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let local = crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;
    let since_seq = local.last_server_seq;
    let fc = fc_client_metadata_only(&state, q.fc_endpoint).await?;

    let mut cursor: Option<String> = None;
    let mut snapshot_seq: Option<i64> = None;
    let mut items: Vec<RemotePendingItem> = Vec::new();
    loop {
        let page = fc
            .manifest(&q.team_id, since_seq, cursor.clone(), snapshot_seq)
            .await
            .map_err(|e| HttpError::internal(e.to_string()))?;
        snapshot_seq.get_or_insert(page.snapshot_seq);
        for item in page.items {
            if !manifest_item_is_pending(&item, &local) {
                continue;
            }
            items.push(RemotePendingItem {
                path: item.path,
                version: item.version,
                deleted: item.deleted,
                updated_at: item.updated_at,
            });
        }
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(Json(RemotePendingResponse {
        items,
        snapshot_seq: snapshot_seq.unwrap_or(since_seq),
        since_seq,
    }))
}

/// Whether a manifest entry is still work for THIS device.
///
/// Three ways it is not, and each of them would otherwise put a number in front
/// of the user that never goes down:
///
/// - a prefix the sync no longer carries (`skills/`, `.mcp/`, …)
/// - a version this device already has — including the push it just made, which
///   the manifest keeps listing until the next tick moves the cursor
/// - a tombstone for a path this device never had. Deletions stay in the
///   manifest forever, so a team that has ever deleted anything would show a
///   permanent backlog of files to "fetch" that do not exist on either side.
fn manifest_item_is_pending(
    item: &crate::sync::oss::fc_client::ManifestItem,
    local: &crate::sync::oss::state::LocalSyncState,
) -> bool {
    if crate::sync::oss::path_validator::is_retired(&item.path)
        || crate::sync::oss::path_validator::validate(&item.path).is_err()
    {
        return false;
    }
    let entry = local.files.get(&item.path);
    if entry.is_some_and(|f| item.version <= f.synced_version) {
        return false;
    }
    if item.deleted {
        return entry.is_some_and(|f| !f.deleted_local && f.synced_version > 0);
    }
    true
}

/// `GET /v1/team/versions?teamId=&path=&cursor=&fcEndpoint=` — one page of a
/// file's version history. Ported from desktop `oss_sync_list_versions`.
pub async fn list_versions(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<ListVersionsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (fc, _secret) = fc_client_from_store(&state, &q.team_id, q.fc_endpoint).await?;
    let (infos, next_cursor) = match fc.list_versions(&q.team_id, &q.path, q.cursor).await {
        Ok(page) => page,
        // A document the cloud has never seen has no versions. Reporting that
        // as a server error made every "what does the cloud have" surface show
        // a failure for the most ordinary case there is: a note written here
        // and not pushed yet.
        Err(crate::sync::oss::error::SyncError::NotFound(_)) => (Vec::new(), None),
        Err(e) => return Err(HttpError::internal(e.to_string())),
    };
    let entries = infos
        .into_iter()
        .map(|v| VersionEntry {
            reference: v
                .content_hash
                .clone()
                .unwrap_or_else(|| v.version.to_string()),
            author: v.created_by,
            timestamp: v.created_at,
            deleted: v.deleted,
            message: v.message,
        })
        .collect();
    Ok(Json(ListVersionsResponse {
        versions: entries,
        next_cursor,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub team_id: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

/// `POST /v1/team/versions/restore` — restore a file to a specific version by
/// downloading + decrypting its blob into the GLOBAL content root, then updating
/// the per-team sync state. Ported from desktop `oss_sync_restore_version`,
/// writing to `<sync_content_root>/<path>` instead of the in-workspace team dir.
pub async fn restore_version(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RestoreRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // body.path is untrusted (off the wire); reject traversal/absolute paths
    // before joining it onto the global team dir.
    crate::sync::oss::path_validator::validate(&body.path)
        .map_err(|e| HttpError::validation(format!("invalid path: {e}")))?;
    let (fc, team_secret) = fc_client_from_store(&state, &body.team_id, body.fc_endpoint).await?;
    let key = optional_team_key(team_secret.as_deref())?;

    let mut st = crate::sync::oss::state::LocalSyncState::load_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;

    let dl = fc
        .download(&body.team_id, &body.content_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let blob = fc
        .get_blob(&dl.download_url, &body.content_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let plaintext =
        crate::sync::oss::crypto::decode_blob(blob, key.as_ref()).map_err(HttpError::internal)?;
    let plain_hash = crate::sync::oss::crypto::sha256_hex(&plaintext);

    // Write into the GLOBAL content root, not a workspace path.
    let abs_path =
        crate::config::global_team_store::sync_content_root(&body.team_id).join(&body.path);
    // Defense-in-depth: ensure the resolved path does not escape the team dir
    // via an existing symlink before writing.
    crate::sync::oss::path_validator::validate_no_symlink_escape(
        &crate::config::global_team_store::sync_content_root(&body.team_id),
        &abs_path,
    )
    .map_err(|e| HttpError::validation(format!("path escapes team dir: {e}")))?;
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| HttpError::internal(format!("mkdir: {e}")))?;
    }
    std::fs::write(&abs_path, &plaintext)
        .map_err(|e| HttpError::internal(format!("write file: {e}")))?;

    let meta =
        std::fs::metadata(&abs_path).map_err(|e| HttpError::internal(format!("stat file: {e}")))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    let synced_version = st
        .files
        .get(&body.path)
        .map(|f| f.synced_version)
        .unwrap_or(0);

    st.upsert(
        &body.path,
        synced_version,
        body.content_hash.clone(),
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );
    st.save_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("save sync state: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    pub team_id: String,
    pub path: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResponse {
    pub content: Option<String>,
}

/// `GET /v1/team/file?teamId=&path=&ref=&fcEndpoint=` — resolve one file's
/// content at a given version. `ref` is either a content hash or the reserved
/// "baseline" token (resolves to the last-synced cipher hash from local sync
/// state); the blob is downloaded + decrypted. Missing file/version yields
/// `{ content: null }`.
pub async fn get_file(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<FileQuery>,
) -> Result<Json<FileContentResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let cipher_hash = if q.reference == "baseline" {
        crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
            .ok()
            .and_then(|st| st.files.get(&q.path).map(|f| f.synced_cipher_hash.clone()))
            .filter(|h| !h.is_empty())
    } else {
        Some(q.reference.clone())
    };
    let Some(cipher_hash) = cipher_hash else {
        return Ok(Json(FileContentResponse { content: None }));
    };

    let (fc, secret) = fc_client_from_store(&state, &q.team_id, q.fc_endpoint).await?;
    let key = optional_team_key(secret.as_deref())?;
    let dl = fc
        .download(&q.team_id, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let blob = fc
        .get_blob(&dl.download_url, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let plaintext =
        crate::sync::oss::crypto::decode_blob(blob, key.as_ref()).map_err(HttpError::internal)?;
    let content =
        String::from_utf8(plaintext).map_err(|e| HttpError::internal(format!("utf8: {e}")))?;
    Ok(Json(FileContentResponse {
        content: Some(content),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedQuery {
    pub team_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedResponse {
    pub files: Vec<ChangedFile>,
    /// What the pull cannot apply, by path. Same call because the panel needs
    /// both to answer one question — "what is not in sync here" — and this one
    /// is already read on every write to the knowledge tree.
    pub stuck: Vec<StuckFile>,
    /// Paths the ignore rules exclude, as the shallowest path that explains
    /// each exclusion — `knowledge/node_modules`, never the files inside it.
    /// The UI dims these and everything beneath them; see
    /// `scanner::scan_ignored` for why the list is shaped this way.
    #[serde(default)]
    pub ignored: Vec<String>,
}

/// `GET /v1/team/changed?teamId=` — list files with local changes: dirty
/// entries from the per-team `LocalSyncState`.
pub async fn list_changed(
    principal: Principal,
    State(_state): State<HttpState>,
    Query(q): Query<ChangedQuery>,
) -> Result<Json<ChangedResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let root = crate::config::global_team_store::sync_content_root(&q.team_id);
    let state = crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;
    let mut stuck: Vec<StuckFile> = state
        .quarantined
        .iter()
        .map(|(path, q)| StuckFile {
            path: path.clone(),
            reason: q.reason.clone(),
            attempts: q.attempts,
        })
        .collect();
    stuck.sort_by(|a, b| a.path.cmp(&b.path));
    let root = root.to_string_lossy().to_string();
    let rules = crate::sync::oss::ignore_rules::IgnoreRules::load(std::path::Path::new(&root));
    Ok(Json(ChangedResponse {
        files: local_changes_with(&root, &state, &rules),
        stuck,
        ignored: crate::sync::oss::scanner::scan_ignored(&root, &rules),
    }))
}

/// What is on this disk that the cloud does not have yet.
///
/// Scans the tree rather than reading the `dirty` flags out of sync state, and
/// that is the whole point: those flags are refreshed at the START of a tick and
/// cleared again by the push at the end of it, so between ticks they describe a
/// tree that no longer exists. Reading them made this endpoint answer "nothing
/// changed" for a file the user had just typed into — and a file created since
/// the last tick has no state entry at all, so it was invisible either way.
///
/// The scan is the same cheap one the engine runs: mtime+size decides, and only
/// a file that fails that check gets re-hashed.
#[cfg(test)]
fn local_changes(
    content_root: &str,
    state: &crate::sync::oss::state::LocalSyncState,
) -> Vec<ChangedFile> {
    let rules =
        crate::sync::oss::ignore_rules::IgnoreRules::load(std::path::Path::new(content_root));
    local_changes_with(content_root, state, &rules)
}

/// Same rules the engine scans with, so this endpoint cannot report pending
/// work for a file the engine will never touch.
fn local_changes_with(
    content_root: &str,
    state: &crate::sync::oss::state::LocalSyncState,
    rules: &crate::sync::oss::ignore_rules::IgnoreRules,
) -> Vec<ChangedFile> {
    let scan = crate::sync::oss::scanner::scan_workspace_with(content_root, state, rules);
    let mut out: Vec<ChangedFile> = Vec::new();

    for file in &scan {
        let status = match state.files.get(&file.rel_path) {
            // Never synced from here: new, whatever the cheap check thinks.
            None => "new",
            // A tombstoned entry means the team no longer has this path, so a
            // file sitting there again is a NEW document that happens to reuse
            // the name — not an edit of something the team still has. Checked
            // before `dirty` on purpose: re-creating the exact old content
            // leaves the hash unchanged, and the push phase resurrects such a
            // path regardless (`readd_paths` in the engine), so skipping it
            // here would hide a push that is definitely going to happen.
            Some(f) if f.deleted_local => "new",
            Some(_) if file.dirty => "modified",
            Some(_) => continue,
        };
        out.push(ChangedFile {
            path: file.rel_path.clone(),
            status: status.to_string(),
        });
    }

    // Synced once, gone from the tree now: a deletion this device still owes
    // the team. Mirrors `engine::locally_deleted_paths` — including its ignore
    // exclusion, which is not optional here either: a file that became ignored
    // is also absent from the scan, and reporting it as a pending deletion
    // would show the user a deletion the engine is never going to perform.
    let present: std::collections::HashSet<&str> =
        scan.iter().map(|s| s.rel_path.as_str()).collect();
    for (path, f) in &state.files {
        if !f.deleted_local
            && f.synced_version > 0
            && !present.contains(path.as_str())
            && !rules.is_ignored_with_ancestors(path)
        {
            out.push(ChangedFile {
                path: path.clone(),
                status: "deleted".to_string(),
            });
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Resolve the team_id for a workspace from the daemon's onboarded team
/// (teamclu.json carries no team_id; daemon.toml does — same as /v1/team/link).
/// The team this daemon is onboarded to. Named for what it reads: `daemon.toml`,
/// never the workspace.
fn active_team_id() -> Result<String, HttpError> {
    let config = crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
        .map_err(|e| HttpError::internal(format!("load daemon config: {e}")))?;
    config
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| HttpError::validation("daemon is not onboarded to a team"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── conflict listing + resolution ────────────────────────────────────────
    //
    // These drive `apply_conflict_decision` / `conflict_entries` directly rather
    // than the axum handlers: the handlers add only scope checks and the
    // validation→HTTP-status mapping, while everything that can corrupt a user's
    // document lives here.

    /// A team tree with one synced document that has been overwritten by the
    /// remote version, and the user's own bytes parked in a sidecar — exactly
    /// the state `engine.rs` leaves behind after a conflict.
    struct ConflictFixture {
        _home: tempfile::TempDir,
        _guard: crate::test_brand_env::BrandEnvGuard,
        team_id: String,
        root: std::path::PathBuf,
    }

    impl ConflictFixture {
        fn new() -> Self {
            let home = tempfile::tempdir().unwrap();
            let guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
            let team_id = "team-conflict".to_string();
            let root = crate::config::global_team_store::sync_content_root(&team_id);
            std::fs::create_dir_all(root.join("knowledge")).unwrap();
            Self {
                _home: home,
                _guard: guard,
                team_id,
                root,
            }
        }

        fn write(&self, rel: &str, body: &str) {
            let abs = self.root.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, body).unwrap();
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.root.join(rel)).unwrap()
        }

        fn exists(&self, rel: &str) -> bool {
            self.root.join(rel).exists()
        }

        /// Seed the sync-state entry the engine would have written when the
        /// remote version landed: synced to the remote hash, not dirty.
        fn seed_state(&self, rel: &str, synced_plain_hash: &str) {
            let mut st = crate::sync::oss::state::LocalSyncState::load_at(&self.team_id).unwrap();
            st.upsert(
                rel,
                7,
                "remote-cipher".into(),
                synced_plain_hash.into(),
                synced_plain_hash.into(),
                1_748_332_800,
                11,
            );
            st.save_at(&self.team_id).unwrap();
        }

        fn state_for(&self, rel: &str) -> crate::sync::oss::state::FileState {
            crate::sync::oss::state::LocalSyncState::load_at(&self.team_id)
                .unwrap()
                .files
                .get(rel)
                .cloned()
                .unwrap()
        }
    }

    // ── remote pending probe ─────────────────────────────────────────────────

    fn manifest_item(
        path: &str,
        version: i32,
        deleted: bool,
    ) -> crate::sync::oss::fc_client::ManifestItem {
        crate::sync::oss::fc_client::ManifestItem {
            path: path.to_string(),
            version,
            content_hash: Some("hash".into()),
            size: Some(10),
            deleted,
            change_seq: 1,
            updated_at: None,
        }
    }

    fn state_with(
        path: &str,
        synced_version: i32,
        deleted_local: bool,
    ) -> crate::sync::oss::state::LocalSyncState {
        let mut st = crate::sync::oss::state::LocalSyncState::new_for_test("t");
        st.upsert(
            path,
            synced_version,
            "c".into(),
            "p".into(),
            "p".into(),
            0,
            1,
        );
        if deleted_local {
            st.mark_tombstoned(path, synced_version);
        }
        st
    }

    #[test]
    fn a_newer_remote_version_is_pending() {
        let st = state_with("knowledge/a.md", 1, false);
        assert!(manifest_item_is_pending(
            &manifest_item("knowledge/a.md", 2, false),
            &st
        ));
        // Never seen here at all — that is the teammate's new document.
        assert!(manifest_item_is_pending(
            &manifest_item("knowledge/new.md", 1, false),
            &st
        ));
    }

    #[test]
    fn our_own_push_is_not_something_waiting_for_us() {
        // The manifest keeps listing it until the next tick moves the cursor;
        // counting it would put a "pull me" marker on every file the user saves.
        let st = state_with("knowledge/a.md", 2, false);
        assert!(!manifest_item_is_pending(
            &manifest_item("knowledge/a.md", 2, false),
            &st
        ));
    }

    #[test]
    fn a_tombstone_for_a_file_we_never_had_is_not_work() {
        // Deletions live in the manifest forever. A team that has deleted
        // anything would otherwise show a backlog that can never reach zero.
        let st = state_with("knowledge/a.md", 1, false);
        assert!(!manifest_item_is_pending(
            &manifest_item("knowledge/long-gone.md", 4, true),
            &st
        ));
        // But a deletion of something we DO have is a real pull: the file has
        // to come off this disk.
        assert!(manifest_item_is_pending(
            &manifest_item("knowledge/a.md", 2, true),
            &st
        ));
    }

    #[test]
    fn retired_prefixes_are_not_pending() {
        let st = crate::sync::oss::state::LocalSyncState::new_for_test("t");
        assert!(!manifest_item_is_pending(
            &manifest_item("skills/pack/SKILL.md", 3, false),
            &st
        ));
        assert!(!manifest_item_is_pending(
            &manifest_item("_secrets/env", 1, false),
            &st
        ));
    }

    // ── local change detection ───────────────────────────────────────────────

    /// The badges in the file tree are drawn from this, so "nothing changed"
    /// has to mean it.
    #[test]
    fn local_changes_sees_what_the_tree_sees() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/synced.md", "unchanged");
        fx.write("knowledge/edited.md", "edited since the last sync");
        fx.write("knowledge/brand-new.md", "never synced from here");
        // Two files were synced once; one of them has since been edited, and a
        // third was deleted off the disk.
        let mut st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();
        let synced_body = "unchanged".as_bytes();
        st.upsert(
            "knowledge/synced.md",
            1,
            "c1".into(),
            crate::sync::oss::crypto::sha256_hex(synced_body),
            crate::sync::oss::crypto::sha256_hex(synced_body),
            0,
            synced_body.len() as u64,
        );
        st.upsert(
            "knowledge/edited.md",
            1,
            "c2".into(),
            crate::sync::oss::crypto::sha256_hex(b"the old text"),
            crate::sync::oss::crypto::sha256_hex(b"the old text"),
            0,
            12,
        );
        st.upsert(
            "knowledge/deleted.md",
            1,
            "c3".into(),
            "p3".into(),
            "p3".into(),
            0,
            5,
        );
        st.save_at(&fx.team_id).unwrap();
        let st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();

        let changes = local_changes(&fx.root.to_string_lossy(), &st);
        let by_path: std::collections::HashMap<&str, &str> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.status.as_str()))
            .collect();

        assert_eq!(by_path.get("knowledge/brand-new.md"), Some(&"new"));
        assert_eq!(by_path.get("knowledge/edited.md"), Some(&"modified"));
        assert_eq!(by_path.get("knowledge/deleted.md"), Some(&"deleted"));
        assert_eq!(
            by_path.get("knowledge/synced.md"),
            None,
            "a file that matches what was synced is not a change"
        );
    }

    #[test]
    fn a_recreated_document_reads_as_new_not_as_an_edit() {
        let fx = ConflictFixture::new();
        let body = b"exactly what was there before";
        fx.write("knowledge/reborn.md", std::str::from_utf8(body).unwrap());

        let mut st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();
        st.upsert(
            "knowledge/reborn.md",
            1,
            "c".into(),
            crate::sync::oss::crypto::sha256_hex(body),
            crate::sync::oss::crypto::sha256_hex(body),
            0,
            body.len() as u64,
        );
        // The team deleted it; this device recorded the tombstone.
        st.mark_tombstoned("knowledge/reborn.md", 2);
        st.save_at(&fx.team_id).unwrap();
        let st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();

        let changes = local_changes(&fx.root.to_string_lossy(), &st);

        // Identical content, so the cheap dirty check says "unchanged" — but
        // the push WILL resurrect this path, and to the user it is a new note.
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].path, "knowledge/reborn.md");
        assert_eq!(changes[0].status, "new");
    }

    /// The old implementation read the `dirty` flags out of sync state, which
    /// the push clears at the end of every tick — so between ticks it reported
    /// a clean tree no matter what the user had typed.
    #[test]
    fn local_changes_does_not_trust_the_stale_dirty_flag() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "what the user just typed");
        let mut st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();
        st.upsert(
            "knowledge/note.md",
            1,
            "c".into(),
            crate::sync::oss::crypto::sha256_hex(b"what was synced"),
            crate::sync::oss::crypto::sha256_hex(b"what was synced"),
            0,
            15,
        );
        // Exactly the state a finished push leaves behind.
        assert!(!st.files["knowledge/note.md"].dirty);
        st.save_at(&fx.team_id).unwrap();
        let st = crate::sync::oss::state::LocalSyncState::load_at(&fx.team_id).unwrap();

        let changes = local_changes(&fx.root.to_string_lossy(), &st);
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].status, "modified");
    }

    #[test]
    fn keep_local_restores_the_users_bytes_and_queues_them_for_push() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write(
            "knowledge/.conflicts/note.conflict.1000.aabbccdd.md",
            "my draft",
        );
        fx.seed_state("knowledge/note.md", "hash-of-remote");

        let acted = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            Some("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"),
            crate::sync::oss::ConflictChoice::KeepLocal,
        )
        .unwrap();

        assert_eq!(
            acted.as_deref(),
            Some("knowledge/.conflicts/note.conflict.1000.aabbccdd.md")
        );
        // The document now holds what the user wrote, not what the remote sent.
        assert_eq!(fx.read("knowledge/note.md"), "my draft");
        assert!(!fx.exists("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"));
        let entry = fx.state_for("knowledge/note.md");
        assert!(entry.dirty, "the restored copy has to be pushed");
        assert!(!entry.deleted_local);
        // The CAS parent stays the remote version the engine recorded, which is
        // what makes the next push win instead of conflicting again.
        assert_eq!(entry.synced_version, 7);
    }

    #[test]
    fn keep_remote_clears_the_losing_copy_and_leaves_the_document_alone() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write(
            "knowledge/.conflicts/note.conflict.1000.aabbccdd.md",
            "my draft",
        );
        fx.seed_state("knowledge/note.md", "hash-of-remote");

        apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            Some("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"),
            crate::sync::oss::ConflictChoice::KeepRemote,
        )
        .unwrap();

        assert_eq!(fx.read("knowledge/note.md"), "remote wins");
        assert!(!fx.exists("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"));
        let entry = fx.state_for("knowledge/note.md");
        assert!(!entry.dirty);
        assert_eq!(entry.local_plain_hash, entry.synced_plain_hash);
    }

    #[test]
    fn resolving_the_same_conflict_twice_is_idempotent() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write(
            "knowledge/.conflicts/note.conflict.1000.aabbccdd.md",
            "my draft",
        );

        for _ in 0..2 {
            // A double click, or two windows racing, must not 500 the second one.
            apply_conflict_decision(
                &fx.team_id,
                "knowledge/note.md",
                Some("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"),
                crate::sync::oss::ConflictChoice::KeepRemote,
            )
            .unwrap();
        }
        // Nothing named, nothing left on disk → "already done", not an error.
        let acted = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            None,
            crate::sync::oss::ConflictChoice::KeepRemote,
        )
        .unwrap();
        assert_eq!(acted, None);
    }

    #[test]
    fn a_sidecar_that_is_already_gone_changes_nothing() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.seed_state("knowledge/note.md", "hash-of-remote");

        // The UI names a sidecar that another window has already resolved.
        let acted = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            Some("knowledge/.conflicts/note.conflict.1000.aabbccdd.md"),
            crate::sync::oss::ConflictChoice::KeepLocal,
        )
        .unwrap();

        assert_eq!(acted, None, "nothing was there to act on");
        // The document must NOT be queued for push: it holds the remote copy,
        // and pushing it would send that back up as if the user had chosen it.
        assert!(!fx.state_for("knowledge/note.md").dirty);
        assert_eq!(fx.read("knowledge/note.md"), "remote wins");
    }

    #[test]
    fn the_newest_sidecar_is_taken_when_the_caller_names_none() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write(
            "knowledge/.conflicts/note.conflict.1000.aaaaaaaa.md",
            "older draft",
        );
        fx.write(
            "knowledge/.conflicts/note.conflict.2000.bbbbbbbb.md",
            "newer draft",
        );

        let acted = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            None,
            crate::sync::oss::ConflictChoice::KeepLocal,
        )
        .unwrap();

        assert_eq!(
            acted.as_deref(),
            Some("knowledge/.conflicts/note.conflict.2000.bbbbbbbb.md")
        );
        assert_eq!(fx.read("knowledge/note.md"), "newer draft");
        // The older one survives as its own pending decision.
        assert!(fx.exists("knowledge/.conflicts/note.conflict.1000.aaaaaaaa.md"));
    }

    #[test]
    fn a_sidecar_belonging_to_another_document_is_refused() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write("knowledge/secret.md", "someone else's document");
        fx.write(
            "knowledge/.conflicts/secret.conflict.1000.aabbccdd.md",
            "draft",
        );

        // This endpoint deletes (and overwrites) what it is handed, so a
        // mismatched pair is the one thing it must never carry out.
        let err = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            Some("knowledge/.conflicts/secret.conflict.1000.aabbccdd.md"),
            crate::sync::oss::ConflictChoice::KeepLocal,
        )
        .unwrap_err();
        assert!(matches!(err, DecisionError::Invalid(_)), "{err:?}");
        assert_eq!(fx.read("knowledge/secret.md"), "someone else's document");
        assert!(fx.exists("knowledge/.conflicts/secret.conflict.1000.aabbccdd.md"));
    }

    #[test]
    fn a_document_named_after_the_word_conflict_is_not_a_decision() {
        // `merge.conflict.md` is a note somebody wrote. Treating it as a
        // sidecar put a badge on the panel that could never be cleared: the
        // name does not reverse into a document, so `resolve` rejects it.
        let fx = ConflictFixture::new();
        fx.write("knowledge/merge.conflict.md", "a note about merging");
        fx.write(
            "knowledge/.conflicts/real.conflict.1000.aabbccdd.md",
            "the losing copy",
        );

        let entries = conflict_entries(&fx.root);

        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].path, "knowledge/real.md");
        assert_eq!(
            entries[0].sidecar,
            "knowledge/.conflicts/real.conflict.1000.aabbccdd.md"
        );
    }

    #[test]
    fn resolve_refuses_paths_outside_the_content_the_product_syncs() {
        // `path_validator::validate` still accepts retired prefixes so a legacy
        // manifest row cannot abort a pull. This endpoint writes and deletes
        // what it is handed, so it takes the narrower rule.
        let fx = ConflictFixture::new();
        for path in [
            "_secrets/key.txt",
            "skills/pack/SKILL.md",
            ".mcp/memory.json",
        ] {
            let sidecar = format!("{path}.conflict.1000.aabbccdd");
            let err = apply_conflict_decision(
                &fx.team_id,
                path,
                Some(&sidecar),
                crate::sync::oss::ConflictChoice::KeepLocal,
            )
            .unwrap_err();
            assert!(matches!(err, DecisionError::Invalid(_)), "{path}: {err:?}");
        }
    }

    #[test]
    fn a_plain_document_cannot_be_passed_off_as_a_sidecar() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write("knowledge/keepme.md", "not a sidecar");

        let err = apply_conflict_decision(
            &fx.team_id,
            "knowledge/note.md",
            Some("knowledge/keepme.md"),
            crate::sync::oss::ConflictChoice::KeepRemote,
        )
        .unwrap_err();
        assert!(matches!(err, DecisionError::Invalid(_)), "{err:?}");
        assert!(fx.exists("knowledge/keepme.md"));
    }

    #[test]
    fn traversal_out_of_the_team_tree_is_refused() {
        let fx = ConflictFixture::new();
        let err = apply_conflict_decision(
            &fx.team_id,
            "knowledge/../../../etc/passwd",
            None,
            crate::sync::oss::ConflictChoice::KeepRemote,
        )
        .unwrap_err();
        assert!(matches!(err, DecisionError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn conflict_entries_name_the_document_not_the_sidecar() {
        let fx = ConflictFixture::new();
        fx.write("knowledge/note.md", "remote wins");
        fx.write(
            "knowledge/.conflicts/note.conflict.1000.aaaaaaaa.md",
            "older",
        );
        fx.write(
            "knowledge/.conflicts/note.conflict.2000.bbbbbbbb.md",
            "newer",
        );
        fx.write("knowledge/plain.md", "no conflict here");

        let entries = conflict_entries(&fx.root);

        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries.iter().all(|e| e.path == "knowledge/note.md"));
        // Newest first, so the decision the user most likely wants leads.
        assert_eq!(entries[0].conflicted_at, Some(2000));
        assert_eq!(entries[1].conflicted_at, Some(1000));
        assert_eq!(
            entries[0].sidecar,
            "knowledge/.conflicts/note.conflict.2000.bbbbbbbb.md"
        );
    }

    /// The desktop can trigger a sync with no folder open. `workspacePath` used
    /// to be required and rejected as a validation error when empty, which made
    /// "no workspace" look like "cannot sync" for a tree that belongs to the
    /// team, not to any workspace.
    #[test]
    fn sync_request_accepts_a_body_without_a_workspace() {
        let body: SyncRequest = serde_json::from_str(r#"{"forceSync":true}"#).unwrap();
        assert_eq!(body.workspace_path, None);
        assert!(body.force_sync);

        // An older client still sends one, and it still comes through — that is
        // what asks for the workspace's team links to be repaired.
        let with_ws: SyncRequest =
            serde_json::from_str(r#"{"workspacePath":"/tmp/ws","forceSync":false}"#).unwrap();
        assert_eq!(with_ws.workspace_path.as_deref(), Some("/tmp/ws"));
        assert!(!with_ws.force_sync);
    }

    #[test]
    fn mcp_workspace_paths_include_the_daemon_default_workspace() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let default = crate::config::global_team_store::default_workspace_dir("team-a");
        std::fs::create_dir_all(&default).unwrap();
        let regular_home = tempfile::tempdir().unwrap();
        let regular = regular_home.path().join("regular-workspace");
        std::fs::create_dir(&regular).unwrap();
        let rows = vec![crate::backend::WorkspaceRow {
            id: "ws-1".into(),
            team_id: "team-a".into(),
            path: Some(regular.to_string_lossy().into_owned()),
            archived: false,
            agent_id: None,
        }];

        let paths = team_mcp_workspace_paths("team-a", &rows);

        assert!(paths.contains(&default));
        assert!(paths.contains(&regular));
    }

    #[test]
    fn mcp_pruning_uses_the_pre_replacement_team_snapshot() {
        let daemon_home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(daemon_home.path());
        let workspace = tempfile::tempdir().unwrap();
        let legacy_dir = workspace
            .path()
            .join(crate::config::global_team_store::TEAM_LINK_NAME)
            .join(".mcp");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("memory.json"),
            r#"{"mcpServers":{"memory":{"command":"npx","args":["old-memory"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            workspace.path().join("opencode.json"),
            r#"{"mcp":{"memory":{"type":"local","enabled":true,"command":["npx","old-memory"]}}}"#,
        )
        .unwrap();

        let snapshots = snapshot_team_mcp(&[workspace.path().to_path_buf()]);
        std::fs::remove_file(legacy_dir.join("memory.json")).unwrap();
        prune_team_mcp_snapshots("team-a", &snapshots);

        let persisted = crate::config::team_mcp::read_persisted_mcp(workspace.path()).unwrap();
        assert!(
            !persisted.contains_key("memory"),
            "the old materialised copy is removed even after the team entry disappeared"
        );
    }
}
