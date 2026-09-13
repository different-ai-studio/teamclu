//! Daemon-level config over HTTP (`/v1/config/*`).
//!
//! Backs the setup UI's settings screen. Every route requires the `admin`
//! scope — these keys (MQTT broker, channel bot tokens, agent binaries) are
//! daemon-wide, unlike the per-workspace settings under `/v1/workspaces/*`.
//!
//! Reads and writes go through [`crate::config::edit`], the same module behind
//! `amuxd config …`, so the CLI and this API share validation. In particular
//! `edit::write_config` round-trips through `DaemonConfig` before writing, so a
//! malformed PUT is rejected with the on-disk config untouched.
//!
//! **Secrets are redacted on read.** Unlike the CLI — whose caller already has
//! filesystem access to `daemon.toml` — a scoped bearer token is not
//! filesystem access, so credential values are never echoed back. They remain
//! writable: the UI shows a blank field and PUTs a replacement.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::config::edit;

/// Scope gating every route in this module.
const CONFIG_SCOPE: &str = "admin";

/// Placeholder returned in place of a credential's value.
const REDACTED: &str = "••••••••";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    /// The value, or `null` when `secret` is true — see the module docs.
    pub value: Option<serde_json::Value>,
    /// True when this key holds a credential. The UI renders a write-only
    /// field; `display` carries a mask so it can show "set" vs "unset".
    pub secret: bool,
    /// Human-facing rendering. For secrets this is [`REDACTED`], never the
    /// value itself.
    pub display: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConfigResponse {
    pub path: String,
    pub entries: Vec<ConfigEntry>,
}

#[derive(Debug, Deserialize)]
pub struct SetConfigRequest {
    /// The new value, as JSON. Typed: `8883` sets an integer, `"x"` a string,
    /// `["a"]` an array. `null` is rejected — use DELETE to unset, so that
    /// "clear this key" is never ambiguous with "set it to nothing".
    pub value: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateConfigResponse {
    pub key: String,
    /// Whether the change needs a follow-up to take effect. Editing
    /// `[channels.*]` requires `POST /v1/config/reload`; broker/agent changes
    /// need a daemon restart.
    pub requires_reload: bool,
    pub requires_restart: bool,
}

fn config_path(state: &HttpState) -> Result<&std::path::Path, HttpError> {
    state.config_path.as_deref().ok_or_else(|| {
        HttpError::new(
            super::errors::ErrorCode::RuntimeUnavailable,
            "this daemon was started without a config file bound to the HTTP layer",
        )
    })
}

/// Map an `edit` error onto a status. A missing key is a 404; anything else is
/// the caller's malformed input (422) rather than a daemon fault — the module
/// only fails on unparseable/invalid edits.
fn edit_error(err: anyhow::Error) -> HttpError {
    let msg = err.to_string();
    if msg.starts_with("missing key:") {
        return HttpError::not_found(msg);
    }
    HttpError::validation(msg)
}

fn toml_to_json(value: &toml::Value) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

pub async fn list_config(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<ListConfigResponse>, HttpError> {
    require_scope(&principal, CONFIG_SCOPE)?;
    let path = config_path(&state)?;

    let entries = edit::flatten_config(path)
        .map_err(edit_error)?
        .into_iter()
        .map(|(key, value)| {
            let secret = edit::is_secret_key(&key);
            ConfigEntry {
                display: if secret {
                    REDACTED.to_string()
                } else {
                    edit::format_inline_value(&value)
                },
                value: if secret {
                    None
                } else {
                    Some(toml_to_json(&value))
                },
                secret,
                key,
            }
        })
        .collect();

    Ok(Json(ListConfigResponse {
        path: path.display().to_string(),
        entries,
    }))
}

pub async fn get_config(
    principal: Principal,
    State(state): State<HttpState>,
    Path(key): Path<String>,
) -> Result<Json<ConfigEntry>, HttpError> {
    require_scope(&principal, CONFIG_SCOPE)?;
    let path = config_path(&state)?;

    let value = edit::get_config_toml_value(path, &key).map_err(edit_error)?;
    let secret = edit::is_secret_key(&key);

    Ok(Json(ConfigEntry {
        display: if secret {
            REDACTED.to_string()
        } else {
            edit::format_inline_value(&value)
        },
        value: if secret {
            None
        } else {
            Some(toml_to_json(&value))
        },
        secret,
        key,
    }))
}

pub async fn set_config(
    principal: Principal,
    State(state): State<HttpState>,
    Path(key): Path<String>,
    Json(req): Json<SetConfigRequest>,
) -> Result<Json<MutateConfigResponse>, HttpError> {
    require_scope(&principal, CONFIG_SCOPE)?;
    let path = config_path(&state)?;

    if req.value.is_null() {
        return Err(HttpError::validation(
            "value must not be null; use DELETE to unset a key",
        ));
    }

    // TOML has no null and no untagged numbers-as-strings; a value that cannot
    // round-trip is the caller's error, not a daemon fault.
    let toml_value = toml::Value::try_from(&req.value)
        .map_err(|e| HttpError::validation(format!("value is not representable in TOML: {e}")))?;

    edit::set_config_toml_value(path, &key, toml_value).map_err(edit_error)?;

    Ok(Json(MutateConfigResponse {
        requires_reload: key_requires_reload(&key),
        requires_restart: key_requires_restart(&key),
        key,
    }))
}

pub async fn unset_config(
    principal: Principal,
    State(state): State<HttpState>,
    Path(key): Path<String>,
) -> Result<Json<MutateConfigResponse>, HttpError> {
    require_scope(&principal, CONFIG_SCOPE)?;
    let path = config_path(&state)?;

    edit::unset_config_value(path, &key).map_err(edit_error)?;

    Ok(Json(MutateConfigResponse {
        requires_reload: key_requires_reload(&key),
        requires_restart: key_requires_restart(&key),
        key,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadResponse {
    pub reloaded: bool,
}

/// Re-read `daemon.toml` and restart the channel manager, applying
/// `[channels.*]` edits without a daemon restart.
///
/// Equivalent to `amuxd channel reload`, and dispatched the same way: the
/// handler cannot touch the channel manager directly (the daemon actor loop
/// owns it), so it forwards a request over the same bridge that backs the Unix
/// control socket.
pub async fn reload_config(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<ReloadResponse>, HttpError> {
    require_scope(&principal, CONFIG_SCOPE)?;

    let tx = state.channel_reload_tx.as_ref().ok_or_else(|| {
        HttpError::new(
            super::errors::ErrorCode::RuntimeUnavailable,
            "no daemon actor loop behind this HTTP server",
        )
    })?;

    tx.send(())
        .await
        .map_err(|_| HttpError::new(super::errors::ErrorCode::Internal, "daemon loop is gone"))?;

    Ok(Json(ReloadResponse { reloaded: true }))
}

/// `[channels.*]` is re-read by the channel manager on reload.
fn key_requires_reload(key: &str) -> bool {
    key.starts_with("channels.")
}

/// Keys read once at startup. Listed explicitly rather than inferred as
/// "everything else", so a new key defaults to the honest "no claim" rather
/// than a wrong one.
fn key_requires_restart(key: &str) -> bool {
    key.starts_with("mqtt.")
        || key.starts_with("transport.")
        || key.starts_with("http.")
        || key.starts_with("actor.")
        || key.starts_with("agents.")
        || key.starts_with("update.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_and_restart_classification() {
        assert!(key_requires_reload("channels.discord.bot_token"));
        assert!(!key_requires_reload("mqtt.broker_url"));

        assert!(key_requires_restart("mqtt.broker_url"));
        assert!(key_requires_restart("agents.claude_code.binary"));
        assert!(key_requires_restart("http.bind"));
        assert!(key_requires_restart("update.auto"));
        assert!(!key_requires_restart("channels.discord.bot_token"));

        // A key we make no claim about must not assert either.
        assert!(!key_requires_reload("team_id"));
        assert!(!key_requires_restart("team_id"));
    }

    #[test]
    fn json_values_round_trip_into_toml() {
        // The types the settings UI actually submits.
        assert!(toml::Value::try_from(&serde_json::json!("mqtts://x:8883")).is_ok());
        assert!(toml::Value::try_from(&serde_json::json!(8883)).is_ok());
        assert!(toml::Value::try_from(&serde_json::json!(true)).is_ok());
        assert!(toml::Value::try_from(&serde_json::json!(["--a", "--b"])).is_ok());

        // TOML has no null; set_config rejects it before reaching here.
        assert!(toml::Value::try_from(&serde_json::json!(null)).is_err());
    }

    #[test]
    fn edit_error_maps_missing_key_to_404() {
        let err = edit_error(anyhow::anyhow!("missing key: mqtt.nope"));
        assert_eq!(err.code, super::super::errors::ErrorCode::NotFound);

        let err = edit_error(anyhow::anyhow!("validate /x/daemon.toml: bad"));
        assert_eq!(err.code, super::super::errors::ErrorCode::ValidationFailed);
    }
}
