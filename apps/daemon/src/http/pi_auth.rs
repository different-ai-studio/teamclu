//! `/v1/pi/*` — pi provider auth, the HTTP face of `pi /login`.
//!
//! pi keeps its credentials in one device-wide `auth.json` and its custom
//! providers in one device-wide `models.json`, both reachable only through the
//! pi SDK. These routes forward to a pi host (`runtime/pi_rpc/auth.rs`), which
//! drives `ModelRuntime.login/logout/refresh` — pi's own implementation of
//! every provider flow, so no OAuth is reimplemented here.
//!
//! # Why login is three routes and not one
//!
//! `POST /v1/pi/logins` starts a flow and returns immediately with a
//! `loginId`. It cannot block until the login finishes: a browser round trip
//! outlives any sane request timeout, and pi asks questions mid-flow (which
//! login method? paste this code) that only the user can answer. So the flow
//! is polled through `GET /v1/pi/logins/:id` — which returns pi's `AuthEvent`s
//! since a cursor plus whatever prompt it is parked on — and answered through
//! `POST /v1/pi/logins/:id/respond`.
//!
//! `workspaceId` is optional everywhere and never identifies the thing being
//! configured — auth is device-wide. It only says which directory to bring a pi
//! host up in when none is live.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::runtime::pi_rpc::auth::{self, LoginSnapshot};
use crate::runtime::supervisor::PiAuthError;

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

// ── Helpers ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WorkspaceQuery {
    /// Path-encoded workspace id, only used to pick a cwd for a cold host.
    #[serde(default, rename = "workspaceId")]
    workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PollQuery {
    /// Index of the first event the caller has not seen; from the previous
    /// poll's `cursor`.
    #[serde(default)]
    cursor: usize,
}

/// Where to start a pi host when the device has none running.
///
/// Any real directory does: pi resolves `auth.json` and `models.json` from its
/// agent dir, not from the cwd. The ladder exists so the host starts somewhere
/// meaningful — the workspace the settings pane is showing, else this agent's
/// default workspace — and the home fallback is what keeps provider settings
/// reachable on a daemon that has no workspaces at all.
async fn host_cwd(state: &HttpState, workspace_id: Option<&str>) -> std::path::PathBuf {
    if let Some(id) = workspace_id.filter(|id| !id.trim().is_empty()) {
        if let Ok(path) = crate::config::workspace_control::decode_workspace_path(id) {
            if path.is_dir() {
                return path;
            }
        }
    }
    if let Some(backend) = state.backend.as_ref() {
        let resolver = crate::config::WorkspaceResolver::new(backend.clone());
        let actor_id = backend.actor_id().to_string();
        let team_id = backend.team_id().to_string();
        let team_id = (!team_id.trim().is_empty()).then_some(team_id.as_str());
        if let Some(path) =
            crate::config::resolve_default_workspace_path(backend, &resolver, team_id, &actor_id)
                .await
        {
            let path = std::path::PathBuf::from(path);
            if path.is_dir() {
                return path;
            }
        }
    }
    // `~/.amuxd` — always present (the daemon is running out of it), so the
    // host always has a real directory to start in.
    crate::config::layout::root()
}

/// Send one `auth_*` command through the supervisor.
async fn forward(
    state: &HttpState,
    workspace_id: Option<&str>,
    request: serde_json::Value,
) -> Result<serde_json::Value, HttpError> {
    let supervisor = state
        .runtime_supervisor
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("runtime supervisor not configured"))?;
    let cwd = host_cwd(state, workspace_id).await;
    supervisor
        .pi_auth_request(&cwd, request)
        .await
        .map_err(|e| {
            match e {
                // The host answered and refused: bad provider id, an auth type the
                // provider does not offer. That is the request, not the machine, so
                // it must not come back as a 503 a client would retry.
                PiAuthError::Rejected(message) => HttpError::validation(message),
                // Never `internal`: this is "this daemon is not running pi", "the
                // pi binary is missing", or a host that died — things the user acts
                // on, not server faults.
                PiAuthError::Unavailable(message) => HttpError::runtime_unavailable(message),
            }
        })
}

// ── Providers ────────────────────────────────────────────────────────────────

/// `GET /v1/pi/providers` — every provider pi knows, with its auth methods and
/// current status.
pub async fn list_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let data = forward(
        &state,
        query.workspace_id.as_deref(),
        serde_json::json!({"type": "auth_list"}),
    )
    .await?;
    Ok(Json(data))
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    #[serde(default, rename = "providerId")]
    provider_id: Option<String>,
    #[serde(default, rename = "workspaceId")]
    workspace_id: Option<String>,
}

/// `POST /v1/pi/providers/refresh` — reload `models.json` and re-fetch provider
/// catalogs. Without a `providerId` every provider is refreshed.
pub async fn refresh_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let mut request = serde_json::json!({"type": "auth_refresh"});
    if let Some(provider_id) = body.provider_id.filter(|p| !p.trim().is_empty()) {
        request["providerId"] = serde_json::json!(provider_id);
    }
    let data = forward(&state, body.workspace_id.as_deref(), request).await?;
    Ok(Json(data))
}

/// `DELETE /v1/pi/providers/:provider_id/auth` — pi's `/logout`.
///
/// Removes only the credential `auth.json` holds. An API key coming from the
/// environment or from a `models.json` `apiKey` is untouched and the provider
/// stays configured — which is why the provider list reports `source`.
pub async fn logout_provider(
    principal: Principal,
    State(state): State<HttpState>,
    Path(provider_id): Path<String>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    forward(
        &state,
        query.workspace_id.as_deref(),
        serde_json::json!({"type": "auth_logout", "providerId": provider_id}),
    )
    .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

// ── Login flow ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StartLoginRequest {
    #[serde(rename = "providerId")]
    provider_id: String,
    /// `"oauth"` or `"api_key"`; validated by the host against what the
    /// provider actually offers.
    #[serde(rename = "authType")]
    auth_type: String,
    #[serde(default, rename = "workspaceId")]
    workspace_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartLoginResponse {
    #[serde(rename = "loginId")]
    login_id: String,
}

/// `POST /v1/pi/logins` — begin a provider login.
///
/// The id is minted here rather than accepted from the caller so two settings
/// panes cannot collide on one, and so a caller cannot address a flow it did
/// not start.
pub async fn start_login(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<StartLoginRequest>,
) -> Result<Json<StartLoginResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.provider_id.trim().is_empty() {
        return Err(HttpError::validation("providerId is required"));
    }
    if body.auth_type != "oauth" && body.auth_type != "api_key" {
        return Err(HttpError::validation(
            "authType must be \"oauth\" or \"api_key\"",
        ));
    }
    let login_id = Uuid::new_v4().to_string();
    forward(
        &state,
        body.workspace_id.as_deref(),
        serde_json::json!({
            "type": "auth_login_start",
            "loginId": login_id,
            "providerId": body.provider_id,
            "authType": body.auth_type,
        }),
    )
    .await?;
    Ok(Json(StartLoginResponse { login_id }))
}

/// `GET /v1/pi/logins/:login_id` — events since `cursor`, plus the prompt the
/// flow is waiting on and its terminal status.
pub async fn poll_login(
    principal: Principal,
    _state: State<HttpState>,
    Path(login_id): Path<String>,
    Query(query): Query<PollQuery>,
) -> Result<Json<LoginSnapshot>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    // Read straight from the registry: no supervisor, no backend mutex. A poll
    // must not be able to queue behind the very login it is polling.
    auth::poll(&login_id, query.cursor)
        .map(Json)
        .ok_or_else(|| HttpError::not_found(format!("pi login {login_id} not found")))
}

#[derive(Debug, Deserialize)]
pub struct RespondRequest {
    #[serde(rename = "promptId")]
    prompt_id: String,
    #[serde(default)]
    value: Option<String>,
    /// Refuse this prompt, which pi treats as cancelling the login.
    #[serde(default)]
    cancelled: bool,
}

/// `POST /v1/pi/logins/:login_id/respond` — answer the outstanding prompt.
pub async fn respond_login(
    principal: Principal,
    _state: State<HttpState>,
    Path(login_id): Path<String>,
    Json(body): Json<RespondRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    auth::respond(&login_id, &body.prompt_id, body.value, body.cancelled)
        .await
        .map_err(HttpError::validation)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

/// `POST /v1/pi/logins/:login_id/cancel` — abort a running flow.
pub async fn cancel_login(
    principal: Principal,
    _state: State<HttpState>,
    Path(login_id): Path<String>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    auth::cancel(&login_id)
        .await
        .map_err(HttpError::validation)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

// ── Custom providers (`models.json`) ─────────────────────────────────────────

/// `GET /v1/pi/custom-providers` — the `providers` map from `models.json`.
pub async fn list_custom_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let data = forward(
        &state,
        query.workspace_id.as_deref(),
        serde_json::json!({"type": "auth_models_get"}),
    )
    .await?;
    Ok(Json(data))
}

#[derive(Debug, Deserialize)]
pub struct PutCustomProviderRequest {
    /// The provider object exactly as it should appear in `models.json`.
    /// Round-tripped through the UI, so keys the UI has no field for survive.
    provider: serde_json::Value,
    #[serde(default, rename = "workspaceId")]
    workspace_id: Option<String>,
}

/// `PUT /v1/pi/custom-providers/:provider_id` — add or replace one provider.
///
/// Only this provider's entry is written; the rest of `models.json` is
/// preserved by the host's read-modify-write.
pub async fn put_custom_provider(
    principal: Principal,
    State(state): State<HttpState>,
    Path(provider_id): Path<String>,
    Json(body): Json<PutCustomProviderRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    validate_custom_provider_id(&provider_id)?;
    if !body.provider.is_object() {
        return Err(HttpError::validation("provider must be a JSON object"));
    }
    let data = forward(
        &state,
        body.workspace_id.as_deref(),
        serde_json::json!({
            "type": "auth_models_put",
            "providerId": provider_id,
            "provider": body.provider,
        }),
    )
    .await?;
    Ok(Json(data))
}

/// `DELETE /v1/pi/custom-providers/:provider_id`
pub async fn delete_custom_provider(
    principal: Principal,
    State(state): State<HttpState>,
    Path(provider_id): Path<String>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    validate_custom_provider_id(&provider_id)?;
    let data = forward(
        &state,
        query.workspace_id.as_deref(),
        serde_json::json!({"type": "auth_models_delete", "providerId": provider_id}),
    )
    .await?;
    Ok(Json(data))
}

/// A provider id becomes a JSON object key and a `provider/model` prefix in
/// every model reference, so it is held to the same shape pi's own ids use.
fn validate_custom_provider_id(provider_id: &str) -> Result<(), HttpError> {
    if provider_id.is_empty() || provider_id.len() > 64 {
        return Err(HttpError::validation("provider id must be 1-64 characters"));
    }
    if !provider_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(HttpError::validation(
            "provider id may contain only letters, digits, '-', '_' and '.'",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_constrained_to_id_shaped_strings() {
        assert!(validate_custom_provider_id("ollama").is_ok());
        assert!(validate_custom_provider_id("my-vllm_2.0").is_ok());
        assert!(validate_custom_provider_id("").is_err());
        // A `/` would split the `provider/model` reference pi builds from it.
        assert!(validate_custom_provider_id("a/b").is_err());
        assert!(validate_custom_provider_id("a b").is_err());
        assert!(validate_custom_provider_id(&"x".repeat(65)).is_err());
    }
}
