//! `/v1/workspaces/:id/*` route handlers for workspace control-plane APIs.
//!
//! These handlers own the HTTP surface for all workspace-scoped settings:
//! providers, permissions, allowlist, and runtime status. They delegate
//! all reads/writes to `HttpState::workspace_control` so they never touch
//! `opencode.json` or the allowlist file directly.
//!
//! When `workspace_control` is `None` (no store configured) every handler
//! returns 404 with code `not_found`. This lets focused session/runtime
//! tests run without a workspace store.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::provider_auth::{builtin_provider_auth_methods, ProviderAuthMethodsResponse};
use crate::config::workspace_control::{
    decode_workspace_path, AllowlistRule, ApplyOutcome, EnvActivationDiagnostics, ManagedSkillDto,
    McpServerConfig, PermissionConfig, ProviderAuthRequest, ProviderInfo, RoleRecordDto,
    RolesSkillsStateDto, RuntimeStatus, UpsertRoleRequest, UpsertSkillRequest,
    WorkspaceControlError, WorkspaceControlStore,
};
use crate::proto::amux;
use crate::runtime::refresh::{RefreshChangeKind, RefreshSource};
use crate::runtime::supervisor::SkillsRefreshApplyStatus;
use std::collections::HashMap;
use std::path::Path as StdPath;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::state::HttpState;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn resolve_store(state: &HttpState) -> Result<&Arc<dyn WorkspaceControlStore>, HttpError> {
    state
        .workspace_control
        .as_ref()
        .ok_or_else(|| HttpError::not_found("workspace control not configured"))
}

fn map_control_err(e: WorkspaceControlError) -> HttpError {
    match e {
        WorkspaceControlError::WorkspaceNotFound(id) => {
            HttpError::not_found(format!("workspace {id} not found"))
        }
        WorkspaceControlError::NotFound(msg) => HttpError::not_found(msg),
        WorkspaceControlError::Io(e) => HttpError::internal(format!("io error: {e}")),
        WorkspaceControlError::Parse(e) => HttpError::internal(format!("parse error: {e}")),
        WorkspaceControlError::InvalidInput(msg) => HttpError::validation(msg),
        WorkspaceControlError::ActiveTurn(id) => HttpError::new(
            ErrorCode::SessionBusy,
            format!("workspace {id} has an active agent turn"),
        ),
    }
}

async fn workspace_path_or_404(workspace_id: &str) -> Result<std::path::PathBuf, HttpError> {
    let wpath = decode_workspace_path(workspace_id).map_err(map_control_err)?;
    if !wpath.is_dir() {
        return Err(HttpError::not_found(format!(
            "workspace {workspace_id} not found"
        )));
    }
    Ok(wpath)
}

fn paths_refer_to_same_workspace(left: &StdPath, right: &StdPath) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Convert the path-encoded id used by workspace-control HTTP routes into the
/// cloud UUID used by runtime isolation and the OpenCode host pool.
async fn resolve_runtime_workspace_id(
    state: &HttpState,
    route_workspace_id: &str,
    workspace_path: &StdPath,
) -> String {
    // A watcher may already have recorded a pending change under the canonical
    // UUID. Prefer that local mapping and avoid a cloud round trip on Apply.
    if let Some(refresh) = state.runtime_refresh.as_ref() {
        if let Some(workspace_id) = refresh.workspace_id_for_path(workspace_path).await {
            return workspace_id;
        }
    }

    let Some(backend) = state.backend.as_ref() else {
        return route_workspace_id.to_owned();
    };
    let team_id = backend.team_id();
    if team_id.trim().is_empty() {
        return route_workspace_id.to_owned();
    }
    match backend
        .get_workspaces_by_agent(team_id, backend.actor_id())
        .await
    {
        Ok(rows) => rows
            .into_iter()
            .find(|row| {
                !row.archived
                    && row.path.as_deref().is_some_and(|path| {
                        paths_refer_to_same_workspace(StdPath::new(path), workspace_path)
                    })
            })
            .map(|row| row.id)
            .unwrap_or_else(|| route_workspace_id.to_owned()),
        Err(error) => {
            tracing::warn!(
                route_workspace_id,
                workspace_path = %workspace_path.display(),
                error = %error,
                "failed to resolve runtime workspace UUID; using route identity"
            );
            route_workspace_id.to_owned()
        }
    }
}

async fn record_skills_refresh_change(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &StdPath,
) {
    let Some(refresh) = state.runtime_refresh.as_ref() else {
        return;
    };
    let runtime_workspace_id =
        resolve_runtime_workspace_id(state, workspace_id, workspace_path).await;
    if let Err(error) = refresh
        .record_change(
            &runtime_workspace_id,
            workspace_path,
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
    {
        tracing::warn!(
            workspace_id = %runtime_workspace_id,
            workspace_path = %workspace_path.display(),
            error = %error,
            "failed to record skills refresh change after workspace mutation"
        );
        return;
    }
}

/// Reload workspace runtimes so ACP picks up provider credential changes (OAuth / apiKey).
async fn reload_runtime_after_provider_auth(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &std::path::Path,
) -> ApplyOutcome {
    let runtime_workspace_id =
        resolve_runtime_workspace_id(state, workspace_id, workspace_path).await;
    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        match supervisor
            // Explicit provider-auth reload path: always refresh the hosts.
            .reload_workspace(&runtime_workspace_id, workspace_path, true)
            .await
        {
            Ok(outcome) => return outcome,
            Err(e) => {
                tracing::warn!(
                    workspace_id = %runtime_workspace_id,
                    error = %e,
                    "runtime reload after provider auth failed"
                );
            }
        }
    }
    ApplyOutcome::ReloadRequired
}

// ── Shared response wrapper ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ApplyResponse {
    pub outcome: ApplyOutcome,
}

fn apply_ok(outcome: ApplyOutcome) -> Json<ApplyResponse> {
    Json(ApplyResponse { outcome })
}

// ── Agent default-workspace handler ───────────────────────────────────────────

/// Response for `GET /v1/agent/default-workspace`.
#[derive(Serialize)]
pub struct DefaultWorkspaceResponse {
    /// The resolved filesystem path, or `None` when the daemon has no cloud
    /// backend attached, no agent default configured (and the team has no
    /// on-disk workspace to fall back to), or the daemon isn't onboarded.
    pub path: Option<String>,
}

/// `GET /v1/agent/default-workspace` — resolve the daemon's own agent's
/// default working directory via the cloud `agents.default_workspace_id` +
/// `amux.workspaces` tables, falling back to the team's first workspace whose
/// local path exists on this machine.
///
/// This is the same resolution `DaemonServer::resolve_cron_default_workspace`
/// (`daemon/server/cron.rs`) performs for daemon-local cron turns, exposed as
/// a stateless HTTP lookup for callers with no cloud JWT of their own — e.g.
/// the desktop's background cron scheduler, which only holds a loopback root
/// token, not an interactive Supabase session.
pub async fn get_default_workspace(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<DefaultWorkspaceResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let Some(backend) = state.backend.as_ref() else {
        return Ok(Json(DefaultWorkspaceResponse { path: None }));
    };

    // Build a fresh resolver over the same backend so this stateless HTTP
    // lookup applies the exact same resolution + fallback algorithm as
    // `DaemonServer::resolve_cron_default_workspace` (`daemon/server/cron.rs`),
    // just for the authenticated principal's own actor id rather than the
    // daemon's primary agent.
    let resolver = crate::config::WorkspaceResolver::new(backend.clone());
    let actor_id = backend.actor_id().to_string();
    let team_id = backend.team_id().to_string();
    let team_id = if team_id.trim().is_empty() {
        None
    } else {
        Some(team_id.as_str())
    };

    let path =
        crate::config::resolve_default_workspace_path(backend, &resolver, team_id, &actor_id).await;
    Ok(Json(DefaultWorkspaceResponse { path }))
}

// ── Provider handlers ─────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/providers`
pub async fn get_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ProviderInfo>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    // The active team's `provider.team` is synced from the team's cloud LLM
    // config before this handler reads the merged workspace/global provider view.
    // Without that step, an admin's model-list change would only reach this member
    // at their next runtime spawn — app restarts included.
    reconcile_team_provider(&state).await;
    let providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(providers))
}

/// Re-materialize the active team's `provider.team`, best-effort.
///
/// Silently no-ops when the daemon has no managed-LLM resolver (focused tests),
/// no cloud backend, no team, or an unresolvable workspace path — in each case
/// there is nothing authoritative to reconcile against, and the caller should
/// still serve whatever is on disk rather than fail the read.
async fn reconcile_team_provider(state: &HttpState) {
    let Some(managed_llm) = state.managed_llm.as_ref() else {
        return;
    };
    let Some(backend) = state.backend.as_ref() else {
        return;
    };
    let team_id = backend.team_id().to_string();
    if team_id.trim().is_empty() {
        return;
    }
    let config_path = teamclu_runtime_env::opencode_config::global_opencode_config_path();
    let before = std::fs::read(&config_path).ok();
    managed_llm.reconcile_global(team_id.trim()).await;
    let after = std::fs::read(config_path).ok();
    if before != after {
        if let Some(supervisor) = state.runtime_supervisor.as_ref() {
            supervisor.request_all_workspace_host_refreshes().await;
        }
    }
}

/// `GET /v1/providers`
///
/// Device-level provider list (#742). No workspace, and no daemon-managed
/// `provider.team` entry — just what this user configured on this machine.
pub async fn get_device_providers(
    principal: Principal,
    State(_state): State<HttpState>,
) -> Result<Json<Vec<ProviderInfo>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    crate::config::workspace_control::device_providers()
        .map(Json)
        .map_err(map_control_err)
}

/// `POST /v1/providers/:provider_id/auth`
///
/// Save provider credentials without a workspace — what first-run onboarding
/// uses to configure a model before any project directory exists. No runtime
/// reload: there is no workspace whose runtime we could reload, and a runtime
/// started later reads the config at spawn time anyway.
pub async fn put_device_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path(provider_id): Path<String>,
    Json(body): Json<ProviderAuthRequest>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let outcome = crate::config::workspace_control::put_device_provider_auth(&provider_id, body)
        .map_err(map_control_err)?;
    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        supervisor.request_all_workspace_host_refreshes().await;
    }
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `DELETE /v1/providers/:provider_id/auth`
pub async fn delete_device_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path(provider_id): Path<String>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let outcome = crate::config::workspace_control::delete_device_provider_auth(&provider_id)
        .map_err(map_control_err)?;
    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        supervisor.request_all_workspace_host_refreshes().await;
    }
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `POST /v1/workspaces/:id/providers/:provider_id/auth`
///
/// Creates or replaces the authentication credentials for a provider entry.
pub async fn put_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderAuthRequest>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let _file_outcome = store
        .put_provider_auth(&workspace_id, &provider_id, body)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `GET /v1/workspaces/:id/provider-auth-methods`
pub async fn get_provider_auth_methods(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ProviderAuthMethodsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let _store = resolve_store(&state)?;
    let _wpath = workspace_path_or_404(&workspace_id).await?;
    Ok(Json(builtin_provider_auth_methods()))
}

/// `GET /v1/providers/auth-methods`
pub async fn get_device_provider_auth_methods(
    principal: Principal,
    State(_state): State<HttpState>,
) -> Result<Json<ProviderAuthMethodsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    Ok(Json(builtin_provider_auth_methods()))
}

/// `DELETE /v1/workspaces/:id/providers/:provider_id/auth`
pub async fn delete_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let _file_outcome = store
        .delete_provider_auth(&workspace_id, &provider_id)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

// ── Model catalog ─────────────────────────────────────────────────────────────
//
// `GET /v1/workspaces/:id/model-catalog` returns the workspace's available
// models grouped by the agent backend that would actually run them. This is the
// single source of truth for the cron job dialog (and future automation
// settings), replacing the old behavior of showing only OpenCode providers
// regardless of which backend the daemon runs.
//
// Per-backend model sources (each probed live; empty probe falls back to the
// device-persisted catalog where one exists):
//   - opencode:    `/config/providers`, else `opencode.json` providers
//   - pi:          `get_available_models` on a live session
//   - cursor:      `Cursor.models.list({ apiKey })`
//   - claude-code: `Query.supportedModels()` (starts a headless session if needed)

/// A single selectable model within a backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogModel {
    /// Stable reference stored as the cron payload model string. Always
    /// `"<providerSegment>/<modelId>"` so the existing `provider/model` wire
    /// format (parsed by `parse_model_preference`) keeps working. Single-agent
    /// mode: always the opencode form `"<provider>/<modelId>"`.
    #[serde(rename = "ref")]
    pub model_ref: String,
    pub model_id: String,
    pub display_name: String,
}

/// Models available under one agent backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendCatalog {
    /// Backend id as reported by the daemon (single-agent mode: `"opencode"`).
    pub backend: String,
    /// Human-readable label for the backend group header.
    pub label: String,
    pub models: Vec<CatalogModel>,
}

/// Full per-backend model catalog for a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelCatalog {
    /// Backend a cron job runs on when it doesn't specify one — always
    /// `"opencode"` in single-agent mode; `None` when no backend is configured.
    pub automation_default_backend: Option<String>,
    pub backends: Vec<BackendCatalog>,
    /// Why the live probe could not answer, when it could not.
    ///
    /// An empty `backends[].models` has two very different causes: the backend
    /// answered and has nothing configured, or it could not be asked at all — a
    /// cursor daemon with a rejected API key, a binary that will not start. Both
    /// used to arrive at the client as the same empty list, which renders as
    /// "No model configured": a setup hint that sends the user looking for a
    /// missing provider when the real answer is in a daemon log line.
    ///
    /// Set whenever the probe errored, even if a cached catalog then filled the
    /// list — callers are expected to surface it only when they end up with no
    /// models to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_error: Option<String>,
}

fn backend_label(backend: &str) -> &'static str {
    match backend {
        "opencode" => "OpenCode",
        "pi" => "Pi",
        "cursor" => "Cursor",
        // Wire name and launch-config `backend_type` spell this differently.
        "claude-code" | "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "Agent",
    }
}

fn catalog_models_from_acp(acp_models: &[amux::ModelInfo]) -> Vec<CatalogModel> {
    acp_models
        .iter()
        .map(|m| CatalogModel {
            model_ref: m.id.clone(),
            model_id: m.id.clone(),
            display_name: m.display_name.clone(),
        })
        .collect()
}

fn catalog_models_from_opencode_json(opencode_providers: &[ProviderInfo]) -> Vec<CatalogModel> {
    opencode_providers
        .iter()
        .flat_map(|p| {
            p.models.iter().map(move |model_id| CatalogModel {
                model_ref: format!("{}/{}", p.id, model_id),
                model_id: model_id.clone(),
                display_name: model_id.clone(),
            })
        })
        .collect()
}

/// Every backend amuxd can actually run. `codex` is absent on purpose: there is
/// no codex backend module and `create_backend` has no arm for it, so a
/// codex-configured daemon runs opencode. Serving a "Codex" group would name a
/// runtime that never starts.
/// Note these are the *wire* names produced by
/// `runtime_resolution::agent_type_name` (what `configured_agent_types` holds),
/// which is not the same vocabulary as `AgentLaunchConfig.backend_type`: claude
/// is `"claude-code"` here and `"claude"` there. Both spellings are accepted so
/// a caller using either one still gets its group.
const SUPPORTED_CATALOG_BACKENDS: [&str; 5] = ["opencode", "pi", "cursor", "claude-code", "claude"];

/// Build the catalog from the configured backend list. The single configured
/// local backend (per `supported_agent_type_names`) is served using
/// `probed_models` — the live catalog the daemon probed from that backend —
/// falling back to `cached_models` (this device's last-known catalog for that
/// backend) and then, for opencode only, to the workspace's `opencode.json`
/// providers.
pub fn build_model_catalog(
    configured_agent_types: &[String],
    probed_models: Option<&[amux::ModelInfo]>,
    cached_models: &[amux::ModelInfo],
    opencode_providers: &[ProviderInfo],
) -> ModelCatalog {
    let mut backends = Vec::new();

    // Single-agent mode: `configured_agent_types` carries exactly the one
    // configured local backend; unimplemented names are skipped defensively.
    for backend in configured_agent_types {
        if !SUPPORTED_CATALOG_BACKENDS.contains(&backend.as_str()) {
            continue;
        }
        // Live probe first, then this device's persisted catalog for the same
        // backend. Only opencode has a provider-file fallback beyond that; pi,
        // cursor and claude-code have nothing else, which is exactly why the
        // persisted tier matters for them. If nothing resolves, the group is
        // served with no models — clients show the "no models" hint rather than
        // a phantom default.
        let mut models: Vec<CatalogModel> = probed_models
            .filter(|m| !m.is_empty())
            .map(catalog_models_from_acp)
            .unwrap_or_default();
        if models.is_empty() && !cached_models.is_empty() {
            models = catalog_models_from_acp(cached_models);
        }
        if models.is_empty() && backend == "opencode" {
            models = catalog_models_from_opencode_json(opencode_providers);
        }
        backends.push(BackendCatalog {
            backend: backend.clone(),
            label: backend_label(backend).to_string(),
            models,
        });
    }

    // The configured local backend is the automation default (the one cron runs
    // on when a job specifies none).
    let automation_default_backend = backends.first().map(|b| b.backend.clone());

    ModelCatalog {
        automation_default_backend,
        backends,
        // Set by the caller, which is the only layer that saw the probe fail.
        probe_error: None,
    }
}

/// `GET /v1/workspaces/:id/model-catalog`
pub async fn get_model_catalog(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ModelCatalog>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;

    // Probe the configured local backend for its live model catalog. Every
    // backend brings a process up on demand — opencode via `serve.ensure()`, pi /
    // cursor / claude-code by spawning a child — so this works with zero
    // sessions created, which is what makes this endpoint usable as the
    // new-session fast path instead of waiting on an MQTT retain.
    //
    // Deliberately not gated on the backend name: it used to run only for
    // `opencode` or `pi`, so a cursor daemon always fell through with `None`
    // and, having no provider-file fallback, served an empty catalog.
    // `probe_error` is carried separately from `probed`: both a failed probe and
    // an empty one fall back to the persisted catalog, but only the first one
    // means "could not ask". Collapsing them is what let a rejected cursor API
    // key reach the user as "No model configured".
    let mut probe_error: Option<String> = None;
    let (probed_models, cached_models) = match workspace_path_or_404(&workspace_id).await {
        Ok(wpath) => match state.runtime_supervisor.as_ref() {
            Some(supervisor) => {
                let probed = match supervisor.probe_catalog_models(&wpath).await {
                    Ok(models) if !models.is_empty() => Some(models),
                    Ok(_) => {
                        tracing::debug!(
                            workspace_id,
                            "catalog probe returned no models; falling back to the persisted catalog"
                        );
                        None
                    }
                    Err(e) => {
                        tracing::warn!(
                            workspace_id,
                            error = %e,
                            "catalog probe failed; falling back to the persisted catalog"
                        );
                        probe_error = Some(e.to_string());
                        None
                    }
                };
                // Only pay for the cached read when the probe came back empty.
                let cached = if probed.is_some() {
                    Vec::new()
                } else {
                    supervisor.cached_catalog_models(&wpath).await
                };
                (probed, cached)
            }
            None => (None, Vec::new()),
        },
        Err(_) => (None, Vec::new()),
    };

    let mut catalog = build_model_catalog(
        &state.meta.configured_agent_types,
        probed_models.as_deref(),
        &cached_models,
        &providers,
    );

    // Only meaningful when nothing filled the list: a probe that failed while the
    // persisted catalog still had models is a log line, not something to put in
    // front of the user.
    if catalog.backends.iter().all(|b| b.models.is_empty()) {
        catalog.probe_error = probe_error;
    }

    Ok(Json(catalog))
}

// ── Permission handlers ───────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permissions`
pub async fn get_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<PermissionConfig>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let config = store
        .get_permissions(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(config))
}

/// `PUT /v1/workspaces/:id/permissions`
pub async fn put_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<PermissionConfig>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_permissions(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Allowlist handlers ────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permission-allowlist`
pub async fn get_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<AllowlistRule>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let rules = store
        .get_allowlist(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(rules))
}

/// `PUT /v1/workspaces/:id/permission-allowlist`
pub async fn put_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<Vec<AllowlistRule>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_allowlist(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── MCP handlers ─────────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/mcp`
pub async fn get_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<HashMap<String, McpServerConfig>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    crate::config::team_mcp::prune_materialised_team_mcp(&wpath).map_err(map_control_err)?;
    let store = resolve_store(&state)?;
    let servers = store.get_mcp(&workspace_id).map_err(map_control_err)?;
    Ok(Json(servers))
}

/// `PUT /v1/workspaces/:id/mcp`
///
/// Replaces the entire MCP server map for a workspace. Callers should
/// fetch the current map with GET, apply their change, and PUT the full map.
pub async fn put_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<HashMap<String, McpServerConfig>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_mcp(&workspace_id, body)
        .map_err(map_control_err)?;
    // PUT replaces the full map; re-seed built-in entries the UI always shows.
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

#[derive(Deserialize)]
pub struct McpToolsQuery {
    #[serde(default)]
    pub refresh: bool,
}

/// `GET /v1/workspaces/:id/mcp/tools`
pub async fn get_mcp_tools(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<McpToolsQuery>,
) -> Result<Json<crate::mcp_probe::McpToolsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    crate::config::team_mcp::prune_materialised_team_mcp(&wpath).map_err(map_control_err)?;
    let store = resolve_store(&state)?;
    let servers = store.get_mcp(&workspace_id).map_err(map_control_err)?;
    let response =
        crate::mcp_probe::probe_all_servers(&wpath, servers, query.refresh, &workspace_id).await;
    Ok(Json(response))
}

#[derive(Serialize)]
pub struct MaterializeTeamMcpResponse {
    pub changed: bool,
    pub added_count: usize,
}

/// `POST /v1/workspaces/:id/mcp/materialize-team`
///
/// No longer materialises anything: every runtime reads team MCP from
/// `~/.amuxd/teams/<id>/cloud/mcp.json` directly. The route stays, and now does
/// the inverse — clearing team copies an older build wrote into this
/// workspace's `opencode.json`, where they would outrank the team's own file
/// and freeze those servers at the version that was copied.
///
/// Kept rather than removed so a desktop that still calls it keeps working; it
/// reports what it removed under the old field name.
pub async fn materialize_team_mcp(
    principal: Principal,
    Path(workspace_id): Path<String>,
) -> Result<Json<MaterializeTeamMcpResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    let outcome =
        crate::config::team_mcp::prune_materialised_team_mcp(&wpath).map_err(map_control_err)?;
    Ok(Json(MaterializeTeamMcpResponse {
        changed: outcome.changed,
        added_count: outcome.removed_count,
    }))
}

// ── Roles & skills handlers ───────────────────────────────────────────────────
pub async fn get_roles_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RolesSkillsStateDto>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let payload = store
        .get_roles_skills_state(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(payload))
}

/// `GET /v1/workspaces/:id/skills`
pub async fn get_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ManagedSkillDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let skills = store.get_skills(&workspace_id).map_err(map_control_err)?;
    Ok(Json(skills))
}

/// `GET /v1/workspaces/:id/roles`
pub async fn get_roles(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<RoleRecordDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let roles = store.get_roles(&workspace_id).map_err(map_control_err)?;
    Ok(Json(roles))
}

#[derive(serde::Deserialize)]
pub struct DeleteSkillQuery {
    #[serde(default, rename = "dirPath")]
    dir_path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct DeleteRoleQuery {
    #[serde(default, rename = "filePath")]
    file_path: Option<String>,
}

/// `PUT /v1/workspaces/:id/skills/:slug`
pub async fn put_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertSkillRequest>,
) -> Result<Json<ManagedSkillDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.content.trim().is_empty() {
        return Err(HttpError::validation("content must not be empty"));
    }
    let store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let skill = store
        .put_skill(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    record_skills_refresh_change(&state, &workspace_id, &wpath).await;
    Ok(Json(skill))
}

/// `DELETE /v1/workspaces/:id/skills/:slug`
pub async fn delete_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteSkillQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = store
        .delete_skill(&workspace_id, &slug, query.dir_path.as_deref())
        .map_err(map_control_err)?;
    record_skills_refresh_change(&state, &workspace_id, &wpath).await;
    Ok(apply_ok(outcome))
}

#[derive(Debug, Serialize)]
pub struct SkillsRefreshResponse {
    pub ok: bool,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ApplyOutcome>,
}

/// `POST /v1/workspaces/:id/skills/refresh`
///
/// Does not rewrite files. Registers a Skills refresh and, when the workspace
/// is idle, applies it before returning so the next session cannot reuse the
/// cached OpenCode instance. An active turn is not interrupted.
pub async fn refresh_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<SkillsRefreshResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let Some(refresh) = state.runtime_refresh.as_ref() else {
        return Err(HttpError::runtime_unavailable(
            "runtime refresh coordinator unavailable",
        ));
    };
    let runtime_workspace_id = resolve_runtime_workspace_id(&state, &workspace_id, &wpath).await;
    refresh
        .record_change(
            &runtime_workspace_id,
            &wpath,
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let Some(supervisor) = state.runtime_supervisor.as_ref() else {
        return Ok(Json(SkillsRefreshResponse {
            ok: true,
            status: "applied",
            outcome: Some(ApplyOutcome::ReloadRequired),
        }));
    };
    match supervisor
        .apply_pending_skills_refresh(&runtime_workspace_id, &wpath)
        .await
    {
        Ok(SkillsRefreshApplyStatus::Applied(outcome)) => Ok(Json(SkillsRefreshResponse {
            ok: true,
            status: "applied",
            outcome: Some(outcome),
        })),
        Ok(SkillsRefreshApplyStatus::PendingActiveTurn) => Ok(Json(SkillsRefreshResponse {
            ok: true,
            status: "pending_active_turn",
            outcome: None,
        })),
        Err(WorkspaceControlError::ActiveTurn(_)) => Ok(Json(SkillsRefreshResponse {
            ok: true,
            status: "pending_active_turn",
            outcome: None,
        })),
        Err(e) => Err(map_control_err(e)),
    }
}

/// `PUT /v1/workspaces/:id/roles/:slug`
pub async fn put_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertRoleRequest>,
) -> Result<Json<RoleRecordDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.raw_markdown.trim().is_empty() {
        return Err(HttpError::validation("raw_markdown must not be empty"));
    }
    let store = resolve_store(&state)?;
    let role = store
        .put_role(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    Ok(Json(role))
}

/// `DELETE /v1/workspaces/:id/roles/:slug`
pub async fn delete_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteRoleQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .delete_role(&workspace_id, &slug, query.file_path.as_deref())
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Runtime status handlers ───────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/runtime`
pub async fn get_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RuntimeStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let status = supervisor
            .runtime_status(&workspace_id, &workspace_path)
            .await
            .map_err(map_control_err)?;
        return Ok(Json(status));
    }

    let store = resolve_store(&state)?;
    let mut status = store
        .get_runtime_status(&workspace_id)
        .map_err(map_control_err)?;
    if let Some(refresh) = state.runtime_refresh.as_ref() {
        status.refresh = refresh.runtime_refresh_dto(&workspace_id).await;
    }
    Ok(Json(status))
}

/// `GET /v1/workspaces/:id/runtime/env-diagnostics`
pub async fn get_runtime_env_diagnostics(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<RuntimeEnvDiagnosticsQuery>,
) -> Result<Json<EnvActivationDiagnostics>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let team_id = query
            .team_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let diag = supervisor
            .env_activation_diagnostics(&workspace_id, &workspace_path, team_id)
            .await;
        return Ok(Json(diag));
    }

    Err(HttpError::not_found("runtime supervisor unavailable"))
}

#[derive(Debug, Deserialize)]
pub struct RuntimeEnvDiagnosticsQuery {
    pub team_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PendingRuntimeChangesBody {
    pub change_kinds: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PendingRuntimeChangesResponse {
    pub ok: bool,
    pub recorded: Vec<String>,
}

/// `POST /v1/workspaces/:id/runtime/pending-changes`
///
/// Queue refresh kinds for idle auto-apply without immediately reloading.
pub async fn record_pending_runtime_changes(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<PendingRuntimeChangesBody>,
) -> Result<Json<PendingRuntimeChangesResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;
    let runtime_workspace_id =
        resolve_runtime_workspace_id(&state, &workspace_id, &workspace_path).await;
    let kinds = crate::runtime::refresh::parse_refresh_change_kinds(&body.change_kinds);
    if kinds.is_empty() {
        return Err(HttpError::validation(
            "change_kinds must include at least one known kind",
        ));
    }

    let Some(refresh) = state.runtime_refresh.as_ref() else {
        return Err(HttpError::runtime_unavailable(
            "runtime refresh coordinator unavailable",
        ));
    };

    let mut recorded = Vec::new();
    for kind in kinds {
        refresh
            .record_change(
                &runtime_workspace_id,
                &workspace_path,
                kind,
                RefreshSource::UiMutation,
            )
            .await
            .map_err(|e| HttpError::internal(e.to_string()))?;
        recorded.push(kind.as_str().to_string());
    }

    Ok(Json(PendingRuntimeChangesResponse { ok: true, recorded }))
}

/// `POST /v1/workspaces/:id/runtime/reload`
pub async fn reload_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;
    let runtime_workspace_id =
        resolve_runtime_workspace_id(&state, &workspace_id, &workspace_path).await;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let outcome = supervisor
            // Explicit user-triggered apply: refresh provider hosts too.
            .apply_refresh(&runtime_workspace_id, &workspace_path, true)
            .await
            .map_err(map_control_err)?;
        return Ok(apply_ok(outcome));
    }

    let store = resolve_store(&state)?;
    let attempt = if let Some(refresh) = state.runtime_refresh.as_ref() {
        Some(
            refresh
                .mark_applying(&runtime_workspace_id, &workspace_path)
                .await,
        )
    } else {
        None
    };
    let outcome = match store.reload_runtime(&workspace_id) {
        Ok(outcome) => outcome,
        Err(err) => {
            if let (Some(refresh), Some(attempt)) = (state.runtime_refresh.as_ref(), attempt) {
                refresh
                    .mark_apply_failed(
                        &runtime_workspace_id,
                        &workspace_path,
                        attempt,
                        err.to_string(),
                    )
                    .await;
            }
            return Err(map_control_err(err));
        }
    };
    if let (Some(refresh), Some(attempt)) = (state.runtime_refresh.as_ref(), attempt) {
        refresh.clear_applied(&runtime_workspace_id, attempt).await;
    }
    Ok(apply_ok(outcome))
}

// ── GET /v1/workspaces — list this daemon's team's on-disk workspaces ──────────

#[derive(Debug, Serialize)]
pub struct ListedWorkspace {
    /// Cloud `amux.workspaces` row id.
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
pub struct ListWorkspacesResponse {
    pub workspaces: Vec<ListedWorkspace>,
}

/// `GET /v1/workspaces` — list workspaces belonging to this daemon's team
/// from the cloud `amux.workspaces` table (the sole source of truth),
/// filtered to rows whose path exists as a directory on *this* machine. The
/// desktop uses this for the cron workspace picker instead of reading the
/// now-deleted `~/.amuxd/workspaces.toml`.
///
/// Requires `workspace:read`. Returns an empty list when the daemon has no
/// cloud backend attached or isn't onboarded to a team yet.
pub async fn list_workspaces(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<ListWorkspacesResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let Some(backend) = state.backend.as_ref() else {
        return Ok(Json(ListWorkspacesResponse { workspaces: vec![] }));
    };
    let team_id = backend.team_id().to_string();
    if team_id.trim().is_empty() {
        return Ok(Json(ListWorkspacesResponse { workspaces: vec![] }));
    }

    // Per-agent, not team-wide: the same path is registered once per device,
    // so the team list carries a dozen duplicates of this machine's dirs.
    let rows = backend
        .get_workspaces_by_agent(&team_id, backend.actor_id())
        .await
        .map_err(|e| HttpError::internal(format!("get_workspaces_by_agent: {e}")))?;

    let default_id = backend
        .get_agent_defaults(backend.actor_id())
        .await
        .ok()
        .and_then(|d| d.default_workspace_id);

    let workspaces = rows
        .into_iter()
        .filter_map(|row| {
            let (path, display_name) =
                crate::config::workspace_path::listable_local_workspace(&row)?;
            Some(ListedWorkspace {
                is_default: default_id.as_deref() == Some(row.id.as_str()),
                workspace_id: row.id,
                path,
                display_name,
            })
        })
        .collect();

    Ok(Json(ListWorkspacesResponse { workspaces }))
}

// ── POST /v1/workspaces — register a workspace (cloud) ────────

#[derive(Debug, Deserialize)]
pub struct RegisterWorkspaceBody {
    /// Absolute workspace path to register. The caller is responsible for
    /// expanding `~` (the desktop passes a fully-resolved path).
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterWorkspaceResponseBody {
    /// Cloud `amux.workspaces` row id.
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
}

/// `POST /v1/workspaces` — register `path` into the cloud `amux.workspaces`
/// table (the sole source of truth).
///
/// Idempotent: re-registering an existing path returns its current record
/// without creating a duplicate (the actor's `apply_add_workspace` still tops
/// up the cloud row + default if either is missing). The desktop calls this for
/// the user's project workspace after onboarding — not for `~/.amuxd` paths.
///
/// Requires `workspace:write`. Returns 503 when no daemon actor is wired behind
/// the HTTP server (focused tests).
pub async fn register_workspace(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RegisterWorkspaceBody>,
) -> Result<Json<RegisterWorkspaceResponseBody>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let path = body.path.trim().to_string();
    if path.is_empty() {
        return Err(HttpError::validation("path must not be empty"));
    }

    let tx = state
        .register_workspace_tx
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("workspace registration not available"))?;

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<String>();
    tx.send(crate::http::state::RegisterWorkspaceRequest { path, reply_tx })
        .await
        .map_err(|_| HttpError::runtime_unavailable("daemon actor unavailable"))?;

    let reply = reply_rx
        .await
        .map_err(|_| HttpError::internal("daemon actor dropped the request"))?;

    let value: serde_json::Value = serde_json::from_str(&reply)
        .map_err(|e| HttpError::internal(format!("malformed actor reply: {e}")))?;

    if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let result = value
            .get("result")
            .ok_or_else(|| HttpError::internal("actor reply missing result"))?;
        Ok(Json(RegisterWorkspaceResponseBody {
            workspace_id: result
                .get("workspace_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            path: result
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            display_name: result
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }))
    } else {
        let error = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("workspace registration failed")
            .to_string();
        Err(HttpError::internal(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, models: &[&str]) -> ProviderInfo {
        ProviderInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            authenticated: true,
            base_url: None,
            models: models.iter().map(|m| m.to_string()).collect(),
        }
    }

    fn acp(id: &str) -> amux::ModelInfo {
        amux::ModelInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            provider_name: "test".to_string(),
        }
    }

    #[test]
    fn opencode_json_fallback_uses_provider_prefixed_ref() {
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog = build_model_catalog(&["opencode".to_string()], None, &[], &providers);

        assert_eq!(
            catalog.automation_default_backend.as_deref(),
            Some("opencode")
        );
        let oc = &catalog.backends[0];
        assert_eq!(oc.models[0].model_ref, "scnet/MiniMax-M2.5");
        assert_eq!(oc.models[0].model_id, "MiniMax-M2.5");
    }

    #[test]
    fn opencode_prefers_acp_probe_models_when_present() {
        let probed = vec![amux::ModelInfo {
            id: "opencode/big-pickle".into(),
            display_name: "Big Pickle".into(),
            provider_name: "opencode".into(),
        }];
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog =
            build_model_catalog(&["opencode".to_string()], Some(&probed), &[], &providers);

        let oc = &catalog.backends[0];
        assert_eq!(oc.models.len(), 1);
        assert_eq!(oc.models[0].model_ref, "opencode/big-pickle");
        assert_eq!(oc.models[0].display_name, "Big Pickle");
    }

    #[test]
    fn every_implemented_backend_gets_a_group() {
        // The four backends `create_backend` can actually build. cursor and
        // claude used to be skipped here, so their groups came back missing
        // (cursor) or absent entirely (claude) no matter what was probed.
        for backend in ["opencode", "pi", "cursor", "claude"] {
            let probed = vec![acp("prov/model-a")];
            let catalog = build_model_catalog(&[backend.to_string()], Some(&probed), &[], &[]);
            assert_eq!(
                catalog.automation_default_backend.as_deref(),
                Some(backend),
                "{backend} should be the automation default"
            );
            assert_eq!(catalog.backends.len(), 1, "{backend} should get one group");
            assert_eq!(catalog.backends[0].backend, backend);
            assert_eq!(
                catalog.backends[0].models.len(),
                1,
                "{backend} should serve its probed model"
            );
        }
    }

    #[test]
    fn codex_yields_no_catalog_group() {
        // There is no codex backend to run — `create_backend` falls through to
        // opencode — so naming a Codex group would advertise a phantom runtime.
        let catalog = build_model_catalog(
            &["codex".to_string(), "opencode".to_string()],
            None,
            &[],
            &[],
        );
        assert_eq!(catalog.backends.len(), 1);
        assert_eq!(catalog.backends[0].backend, "opencode");
    }

    #[test]
    fn persisted_catalog_covers_an_empty_probe_for_every_backend() {
        // pi, cursor and claude have no provider-file fallback, so without this
        // tier a cold or failed probe left their picker permanently empty.
        for backend in ["opencode", "pi", "cursor", "claude"] {
            let cached = vec![acp("prov/from-cache")];
            let catalog = build_model_catalog(&[backend.to_string()], None, &cached, &[]);
            assert_eq!(
                catalog.backends[0].models.len(),
                1,
                "{backend} should fall back to the persisted catalog"
            );
            assert_eq!(catalog.backends[0].models[0].model_ref, "prov/from-cache");
        }
    }

    #[test]
    fn a_live_probe_wins_over_the_persisted_catalog() {
        let probed = vec![acp("prov/live")];
        let cached = vec![acp("prov/stale")];
        let catalog = build_model_catalog(&["pi".to_string()], Some(&probed), &cached, &[]);
        assert_eq!(catalog.backends[0].models[0].model_ref, "prov/live");
    }

    #[test]
    fn opencode_json_is_the_last_resort_after_the_persisted_catalog() {
        let cached = vec![acp("prov/from-cache")];
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog = build_model_catalog(&["opencode".to_string()], None, &cached, &providers);
        assert_eq!(catalog.backends[0].models[0].model_ref, "prov/from-cache");
    }

    #[test]
    fn non_opencode_backends_ignore_opencode_json_providers() {
        for backend in ["pi", "cursor", "claude"] {
            let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
            let catalog = build_model_catalog(&[backend.to_string()], None, &[], &providers);
            assert!(
                catalog.backends[0].models.is_empty(),
                "{backend} must not borrow opencode.json providers"
            );
        }
    }

    #[test]
    fn backend_without_live_persisted_or_provider_models_yields_empty_backend() {
        // No static fallback: nothing resolves → the group is served with zero
        // models (clients show the empty hint), never a phantom default.
        let catalog = build_model_catalog(&["opencode".to_string()], None, &[], &[]);
        assert_eq!(
            catalog.automation_default_backend.as_deref(),
            Some("opencode")
        );
        assert!(catalog.backends[0].models.is_empty());
    }

    #[test]
    fn empty_config_yields_no_default_and_no_backends() {
        let catalog = build_model_catalog(&[], None, &[], &[]);
        assert!(catalog.automation_default_backend.is_none());
        assert!(catalog.backends.is_empty());
    }
}
