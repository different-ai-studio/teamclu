//! Resolving the MQTT broker from the Cloud API's `/v1/config/bootstrap`.
//!
//! Lives under `mqtt` rather than `daemon::server` because the supervisor also
//! calls it, and the integration-test harness compiles `mqtt` without `daemon`.

use std::sync::Arc;

use tracing::{info, warn};

use crate::backend::Backend;
use crate::config::DaemonConfig;

/// Persist a bootstrap-resolved broker to `daemon.toml` so it survives a
/// restart. Without this the address lives only in memory, and a Cloud API that
/// answers 200 *without* an `mqtt` block after the restart leaves the daemon
/// with no broker at all — the 2026-07-28 outage (issue #634).
///
/// Best-effort: a read-only or malformed `daemon.toml` must not take MQTT down,
/// since the in-memory value already works for this process.
fn persist_broker_url(config_path: &std::path::Path, broker_url: &str) {
    match crate::config::edit::set_config_toml_value(
        config_path,
        "mqtt.broker_url",
        toml::Value::String(broker_url.to_string()),
    ) {
        Ok(()) => info!(
            broker = %broker_url,
            path = %config_path.display(),
            "persisted bootstrap broker to daemon.toml as last-known"
        ),
        Err(e) => warn!(
            error = %e,
            path = %config_path.display(),
            "could not persist bootstrap broker; it stays in-memory only and \
             will be lost on restart"
        ),
    }
}

/// Resolve the MQTT broker from `/v1/config/bootstrap`. The Cloud API is the
/// authoritative source: a fetched value wins (so operators can rotate the
/// broker without redeploying daemons), and falls back to whatever
/// `daemon.toml` already holds — an invite `?broker=` override, or the
/// last-known address persisted by an earlier successful bootstrap.
///
/// Never fails: if neither yields a broker URL the daemon warns and continues
/// with an empty `broker_url`, which puts MQTT on a placeholder client while
/// the HTTP/local control plane stays up. That degraded mode is what lets an
/// un-onboarded daemon serve its own setup UI.
///
/// Also called by the MQTT supervisor when generations keep failing, so a
/// running daemon follows a broker that moved without waiting for a restart.
pub(crate) async fn apply_bootstrap_overrides(
    backend: &Arc<dyn Backend>,
    config: &mut DaemonConfig,
    config_path: &std::path::Path,
) -> crate::error::Result<()> {
    match backend.fetch_bootstrap_mqtt().await {
        Ok(Some(mqtt)) if !mqtt.url.trim().is_empty() => {
            let previous = std::mem::replace(&mut config.mqtt.broker_url, mqtt.url);
            if mqtt.username.is_some() {
                config.mqtt.username = mqtt.username;
            }
            if mqtt.password.is_some() {
                config.mqtt.password = mqtt.password;
            }
            info!(
                previous_broker = %previous,
                broker = %config.mqtt.broker_url,
                "applied bootstrap mqtt override from cloud api"
            );
            // Only rewrite when the address actually moved — a steady-state
            // daemon re-fetching bootstrap should not touch the file.
            if previous != config.mqtt.broker_url {
                persist_broker_url(config_path, &config.mqtt.broker_url);
            }
        }
        // A 200 with no `mqtt` block (or an empty url) is the failure mode that
        // reads as success. Keep whatever daemon.toml holds and say so loudly —
        // silently continuing here is what made the outage invisible.
        Ok(_) => {
            if config.mqtt.broker_url.trim().is_empty() {
                warn!(
                    "cloud api bootstrap returned no MQTT broker and no last-known \
                     address is on disk; MQTT stays down until the cloud config is fixed"
                );
            } else {
                warn!(
                    broker = %config.mqtt.broker_url,
                    "cloud api bootstrap returned no MQTT broker; continuing with the \
                     last-known address from daemon.toml (cloud config may be misconfigured)"
                );
            }
        }
        Err(e) => {
            // Keep the on-disk address (if any); the empty-check below decides.
            tracing::warn!(error = %e, "bootstrap mqtt fetch failed; relying on last-known broker in daemon.toml if present");
        }
    }

    if config.mqtt.broker_url.trim().is_empty() {
        warn!(
            "no MQTT broker configured (bootstrap fetch failed or invite had no `?broker=`); \
             HTTP/local control plane will start and MQTT/collab will retry once a broker is known"
        );
    }
    Ok(())
}
