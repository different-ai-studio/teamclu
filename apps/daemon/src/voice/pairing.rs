//! ESP32 pairing-code mint and device roster helpers (plan §8.1 / M2-7).
//!
//! amuxd generates a short random code, registers it with the Cloud API using
//! its own backend token, and (optionally) ensures `[channels.esp32]` is
//! enabled so the voice path is ready when the device comes online.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::backend::Backend;
use crate::config::{team_config, DaemonConfig, Esp32Channel, Esp32DeviceEntry};

/// Alphabet for user-typed pairing codes — no ambiguous `0/O` / `1/I/L`.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
const DEFAULT_TTL_SECS: u64 = 600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub team_id: String,
    pub actor_id: String,
    pub ttl_seconds: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingCodeBody {
    code: String,
    team_id: String,
    actor_id: String,
    ttl_seconds: u64,
    expires_at: String,
}

/// Generate an 8-char Crockford-ish code suitable for typing on a phone.
pub fn generate_pairing_code() -> String {
    let mut rng = rand::thread_rng();
    (0..CODE_LEN)
        .map(|_| {
            let i = rng.gen_range(0..CODE_ALPHABET.len());
            CODE_ALPHABET[i] as char
        })
        .collect()
}

/// Mint a pairing code and register it with FC.
pub async fn mint_pairing_code(
    backend: &Arc<dyn Backend>,
    ttl_seconds: Option<u64>,
) -> Result<PairingCode, String> {
    let base = backend
        .cloud_base_url()
        .ok_or_else(|| "no cloud base url; pairing needs the Cloud API".to_string())?;
    let team_id = backend.team_id().to_string();
    let actor_id = backend.actor_id().to_string();
    if team_id.is_empty() || actor_id.is_empty() {
        return Err("daemon is not onboarded (missing team/actor)".into());
    }
    let auth = backend
        .auth_token()
        .await
        .map_err(|e| format!("pairing: no auth token: {e}"))?;

    let code = generate_pairing_code();
    let ttl = ttl_seconds.unwrap_or(DEFAULT_TTL_SECS).clamp(60, 3600);

    let url = format!("{}/v1/devices/pairing-codes", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(auth)
        .json(&serde_json::json!({
            "code": code,
            "teamId": team_id,
            "actorId": actor_id,
            "ttlSeconds": ttl,
        }))
        .send()
        .await
        .map_err(|e| format!("pairing: {url}: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("pairing: HTTP {status}: {snippet}"));
    }

    let parsed: PairingCodeBody = serde_json::from_str(&body)
        .map_err(|e| format!("pairing: malformed response: {e}"))?;
    let expires_at = DateTime::parse_from_rfc3339(&parsed.expires_at)
        .map_err(|e| format!("pairing: bad expiresAt: {e}"))?
        .with_timezone(&Utc);

    // Ensure the channel is on so a successful pair has somewhere to land.
    // Roster entries are still added separately via [`register_device`].
    if let Err(e) = ensure_esp32_enabled() {
        tracing::warn!(error = %e, "pairing: could not enable channels.esp32");
    }

    info!(
        code = %parsed.code,
        team_id = %parsed.team_id,
        expires_at = %expires_at,
        "esp32 pairing code minted"
    );

    Ok(PairingCode {
        code: parsed.code,
        team_id: parsed.team_id,
        actor_id: parsed.actor_id,
        ttl_seconds: parsed.ttl_seconds,
        expires_at,
    })
}

/// Flip `[channels.esp32] enabled = true` in team.toml if needed.
pub fn ensure_esp32_enabled() -> Result<(), String> {
    let path = DaemonConfig::default_path();
    let mut cfg = DaemonConfig::load_hydrated(&path).map_err(|e| e.to_string())?;
    let mut esp32 = cfg.channels.esp32.take().unwrap_or_default();
    if esp32.enabled {
        cfg.channels.esp32 = Some(esp32);
        return Ok(());
    }
    esp32.enabled = true;
    cfg.channels.esp32 = Some(esp32);
    team_config::persist_from(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append (or refresh) a `[[channels.esp32.devices]]` roster entry.
///
/// No secrets — just `device_id` + display name for the inbound fork.
pub fn register_device(device_id: &str, name: &str) -> Result<Esp32DeviceEntry, String> {
    let device_id = device_id.trim().to_ascii_lowercase();
    if device_id.is_empty() || !device_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("deviceId must be lowercase hex".into());
    }
    let name = {
        let t = name.trim();
        if t.is_empty() {
            format!("ESP32-{device_id}")
        } else {
            t.to_string()
        }
    };

    let path = DaemonConfig::default_path();
    let mut cfg = DaemonConfig::load_hydrated(&path).map_err(|e| e.to_string())?;
    let mut esp32 = cfg.channels.esp32.take().unwrap_or(Esp32Channel {
        enabled: true,
        use_core: false,
        devices: vec![],
    });
    esp32.enabled = true;

    let paired_at = Some(Utc::now().to_rfc3339());
    if let Some(existing) = esp32.devices.iter_mut().find(|d| d.device_id == device_id) {
        existing.name = name.clone();
        existing.paired_at = paired_at.clone();
    } else {
        esp32.devices.push(Esp32DeviceEntry {
            device_id: device_id.clone(),
            name: name.clone(),
            paired_at: paired_at.clone(),
        });
    }

    let entry = esp32
        .devices
        .iter()
        .find(|d| d.device_id == device_id)
        .cloned()
        .expect("just inserted");
    cfg.channels.esp32 = Some(esp32);
    team_config::persist_from(&cfg).map_err(|e| e.to_string())?;
    info!(device_id = %entry.device_id, name = %entry.name, "esp32 device roster updated");
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_are_alphabet_and_length() {
        for _ in 0..20 {
            let c = generate_pairing_code();
            assert_eq!(c.len(), CODE_LEN);
            assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        }
    }
}
