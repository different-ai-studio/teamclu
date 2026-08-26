//! Loopback HTTP for ESP32 pairing (plan §8.1).
//!
//! Desktop (or a CLI) asks the daemon to mint a pairing code; the daemon holds
//! the Cloud API token and knows team/actor. Device roster updates after the
//! user confirms the pair are also local — FC has no callback into amuxd.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MintPairingCodeRequest {
    /// Optional TTL override (seconds). FC clamps to 60–3600; default 600.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintPairingCodeResponse {
    pub code: String,
    pub team_id: String,
    pub actor_id: String,
    pub ttl_seconds: u64,
    pub expires_at: String,
}

/// `POST /voice/pairing-code` — mint + register a single-use code with FC.
pub async fn mint_pairing_code(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<MintPairingCodeRequest>,
) -> Result<Json<MintPairingCodeResponse>, HttpError> {
    require_scope(&principal, "admin")?;
    let backend = state.backend.as_ref().ok_or_else(|| {
        HttpError::runtime_unavailable("cloud backend is not configured; cannot mint pairing codes")
    })?;

    let minted = crate::voice::pairing::mint_pairing_code(backend, body.ttl_seconds)
        .await
        .map_err(HttpError::internal)?;

    Ok(Json(MintPairingCodeResponse {
        code: minted.code,
        team_id: minted.team_id,
        actor_id: minted.actor_id,
        ttl_seconds: minted.ttl_seconds,
        expires_at: minted.expires_at.to_rfc3339(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceRequest {
    pub device_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceResponse {
    pub device_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<String>,
}

/// `POST /voice/devices` — append a roster entry in team.toml (no secrets).
pub async fn register_device(
    principal: Principal,
    Json(body): Json<RegisterDeviceRequest>,
) -> Result<Json<RegisterDeviceResponse>, HttpError> {
    require_scope(&principal, "admin")?;
    let name = body.name.unwrap_or_default();
    let entry = crate::voice::pairing::register_device(&body.device_id, &name)
        .map_err(HttpError::validation)?;
    Ok(Json(RegisterDeviceResponse {
        device_id: entry.device_id,
        name: entry.name,
        paired_at: entry.paired_at,
    }))
}
