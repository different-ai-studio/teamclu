//! HTTP loopback endpoints for daemon-owned team sync (desktop triggers these).
//!
//! The desktop app drives team sync over the daemon's loopback HTTP API rather
//! than running OSS sync itself. `POST /v1/team/sync` kicks a sync for the
//! workspace's onboarded team; `GET /v1/team/sync/status` reads the cached last
//! status. The daemon is single-team, so the team_id is resolved from
//! `daemon.toml` (teamclu.json carries no team_id) — same lookup as
//! `/v1/team/link`.
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::sync::versions::{ChangedFile, VersionEntry};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub workspace_path: String,
    /// When `true`, run sync even if `team_share.auto_sync` is `false`.
    #[serde(default)]
    pub force_sync: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    #[serde(flatten)]
    pub status: crate::sync::dispatch::SyncStatus,
}

/// `POST /v1/team/sync` — body `{ "workspacePath": "<abs path>" }`.
pub async fn sync_now(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = body.workspace_path.trim();
    if workspace_path.is_empty() {
        return Err(HttpError::validation("workspacePath must not be empty"));
    }
    let team_id = team_id_for_workspace(workspace_path)?;
    crate::team_link::ensure_team_link(&team_id, workspace_path);
    let status = state
        .sync_dispatcher
        .sync_team(
            &team_id,
            workspace_path,
            crate::sync::dispatch::SyncOptions {
                force: body.force_sync,
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
    if status
        .mode
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .is_none()
    {
        return Err(HttpError::team_share_not_enabled_for_daemon(format!(
            "team share is not enabled for daemon team {team_id} (share_mode is unset). \
             If you switched teams in the app, re-bind the local daemon (amuxd init) to the current team, then enable team share again."
        )));
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
        .unwrap_or_else(|| team_id_for_workspace(""))?;

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
    let team_id = team_id_for_workspace("")?;
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
    let team_id = team_id_for_workspace("")?;
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
    )
    .await;
    Ok(Json(TeamSkillReconcileResponse { team_id, outcome }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareModeResponse {
    pub team_id: String,
    pub mode: Option<String>,
}

/// `GET /v1/team/share-mode` — authoritative cloud share mode through the
/// daemon-owned backend/token state.
pub async fn get_share_mode(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<TeamShareModeResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, team_id) = daemon_backend_and_team(&state)?;
    let config = backend
        .team_share_config(&team_id)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    Ok(Json(TeamShareModeResponse {
        team_id,
        mode: config.mode,
    }))
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    pub kind: String,
}

/// `GET /v1/team/conflicts?teamId=...` — list OSS sidecar conflicts on disk
/// under the global team dir.
pub async fn list_conflicts(
    principal: Principal,
    State(_state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Vec<ConflictEntry>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let root = crate::config::global_team_store::global_team_dir(&q.team_id);
    let out = crate::sync::oss::scanner::scan_conflict_files(&root.to_string_lossy())
        .into_iter()
        .map(|path| ConflictEntry {
            path,
            kind: "oss-sidecar".into(),
        })
        .collect::<Vec<_>>();
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub team_id: String,
    pub path: String,
    pub choice: crate::sync::oss::ConflictChoice,
}

/// `POST /v1/team/conflicts/resolve` — resolve an OSS sidecar conflict by
/// recording the user's KeepRemote/KeepLocal choice in the per-team sync state.
/// Ported from desktop `oss_sync_resolve_conflict`, operating on the global
/// per-team `LocalSyncState` rather than a workspace path.
pub async fn resolve_conflict(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // Validate the wire path for consistency (used only to index state here).
    crate::sync::oss::path_validator::validate(&body.path)
        .map_err(|e| HttpError::validation(format!("invalid path: {e}")))?;
    let mut st = crate::sync::oss::state::LocalSyncState::load_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;
    match body.choice {
        crate::sync::oss::ConflictChoice::KeepRemote => {
            // Mark local as matching synced (non-dirty); next tick won't re-upload.
            if let Some(fs) = st.files.get_mut(&body.path) {
                fs.local_plain_hash = fs.synced_plain_hash.clone();
                fs.dirty = false;
            }
        }
        crate::sync::oss::ConflictChoice::KeepLocal => {
            // Mark dirty=true so the next push uploads the local version.
            if let Some(fs) = st.files.get_mut(&body.path) {
                fs.dirty = true;
            }
        }
    }
    st.save_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("save sync state: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
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
) -> Result<(crate::sync::oss::fc_client::FcClient, String), HttpError> {
    let team_secret = state
        .sync_dispatcher
        .secrets()
        .resolve_team_secret(team_id, None)
        .map_err(|e| HttpError::validation(format!("no OSS team secret: {e}")))?;
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

/// `GET /v1/team/versions?teamId=&path=&cursor=&fcEndpoint=` — one page of a
/// file's version history. Ported from desktop `oss_sync_list_versions`.
pub async fn list_versions(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<ListVersionsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (fc, _secret) = fc_client_from_store(&state, &q.team_id, q.fc_endpoint).await?;
    let (infos, next_cursor) = fc
        .list_versions(&q.team_id, &q.path, q.cursor)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
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
/// writing to `<global_team_dir>/<path>` instead of the in-workspace team dir.
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
    let key = crate::team_shared_env::derive_key(&team_secret)
        .map_err(|e| HttpError::internal(format!("derive key: {e}")))?;

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
    let plaintext = crate::sync::oss::crypto::decrypt_blob(&blob, &key)
        .map_err(|e| HttpError::internal(format!("decrypt: {e}")))?;
    let plain_hash = crate::sync::oss::crypto::sha256_hex(&plaintext);

    // Write into the GLOBAL content root, not a workspace path.
    let abs_path =
        crate::config::global_team_store::global_team_dir(&body.team_id).join(&body.path);
    // Defense-in-depth: ensure the resolved path does not escape the team dir
    // via an existing symlink before writing.
    crate::sync::oss::path_validator::validate_no_symlink_escape(
        &crate::config::global_team_store::global_team_dir(&body.team_id),
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
    let key = crate::team_shared_env::derive_key(&secret)
        .map_err(|e| HttpError::internal(format!("derive key: {e}")))?;
    let dl = fc
        .download(&q.team_id, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let blob = fc
        .get_blob(&dl.download_url, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let plaintext = crate::sync::oss::crypto::decrypt_blob(&blob, &key)
        .map_err(|e| HttpError::internal(format!("decrypt: {e}")))?;
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
}

/// `GET /v1/team/changed?teamId=` — list files with local changes: dirty
/// entries from the per-team `LocalSyncState`.
pub async fn list_changed(
    principal: Principal,
    State(_state): State<HttpState>,
    Query(q): Query<ChangedQuery>,
) -> Result<Json<ChangedResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let files = crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
        .map(|st| {
            st.files
                .into_iter()
                .filter(|(_, f)| f.dirty)
                .map(|(path, f)| ChangedFile {
                    path,
                    status: if f.deleted_local {
                        "deleted"
                    } else {
                        "modified"
                    }
                    .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(ChangedResponse { files }))
}

/// Resolve the team_id for a workspace from the daemon's onboarded team
/// (teamclu.json carries no team_id; daemon.toml does — same as /v1/team/link).
fn team_id_for_workspace(_workspace_path: &str) -> Result<String, HttpError> {
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
